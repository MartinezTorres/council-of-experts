import { AgentDefinition } from '../types.js';
import {
  createAgentFinishedEvent,
  createAgentMessage,
  createAgentStartedEvent,
  createDerivedEvent,
  createErrorEvent,
  createMessageEmittedEvent,
  createMessageRecord,
  ExecuteWorkflowInput,
  StreamWorkflowInput,
  WorkflowDependencies,
} from './shared.js';

function buildCouncilSynthesisPrompt(
  privateThoughts: Array<{ agent: AgentDefinition; content: string }>
): string {
  return `Based on the council's private deliberation, formulate your public response.

Private thoughts from council:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Your public response (or say nothing if you have nothing to add):`;
}

export async function executeCouncilWorkflow(
  input: ExecuteWorkflowInput,
  deps: WorkflowDependencies
): Promise<void> {
  const privateThoughts: Array<{ agent: AgentDefinition; content: string }> = [];

  await Promise.allSettled(
    input.activeAgents.map(async (agent) => {
      try {
        const output = await deps.generateWithTools(
          input.turnId,
          agent,
          'council',
          input.event,
          input.stateMessages,
          input.options,
          input.records,
          input.errors
        );

        if (output && output.content.trim()) {
          privateThoughts.push({ agent, content: output.content });

          const message = createAgentMessage({
            turnId: input.turnId,
            agent,
            visibility: 'private',
            output,
          });

          input.privateMessages.push(message);
          input.records.push(
            createMessageRecord(input.councilId, input.turnId, message)
          );
        }
      } catch (error) {
        deps.recordTurnError(
          input.turnId,
          input.records,
          input.errors,
          {
            code: 'agent_execution_failed',
            message: `Agent ${agent.id} failed in council deliberation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          agent.id
        );
      }
    })
  );

  if (privateThoughts.length === 0) {
    return;
  }

  await Promise.allSettled(
    input.activeAgents.map(async (agent) => {
      try {
        const output = await deps.generateWithTools(
          input.turnId,
          agent,
          'council',
          createDerivedEvent(input.event, buildCouncilSynthesisPrompt(privateThoughts)),
          [...input.stateMessages, ...input.privateMessages],
          input.options,
          input.records,
          input.errors
        );

        if (output && output.content.trim()) {
          const message = createAgentMessage({
            turnId: input.turnId,
            agent,
            visibility: 'public',
            output,
          });

          input.publicMessages.push(message);
          input.records.push(
            createMessageRecord(input.councilId, input.turnId, message)
          );
        }
      } catch (error) {
        deps.recordTurnError(
          input.turnId,
          input.records,
          input.errors,
          {
            code: 'agent_execution_failed',
            message: `Agent ${agent.id} failed in council synthesis: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          agent.id
        );
      }
    })
  );
}

export async function* streamCouncilWorkflow(
  input: StreamWorkflowInput,
  deps: WorkflowDependencies
) {
  const privateThoughts: Array<{ agent: AgentDefinition; content: string }> = [];

  for (const agent of input.activeAgents) {
    yield createAgentStartedEvent(input.councilId, input.turnId, agent.id);

    try {
      const output = yield* deps.generateWithToolsStream(
        input.turnId,
        agent,
        'council',
        input.event,
        [...input.stateMessages, ...input.pendingMessages],
        input.options
      );

      if (output && output.content.trim()) {
        privateThoughts.push({ agent, content: output.content });

        const message = createAgentMessage({
          turnId: input.turnId,
          agent,
          visibility: 'private',
          output,
        });

        input.pendingMessages.push(message);
        yield createMessageEmittedEvent(input.councilId, input.turnId, message);
      }
    } catch (error) {
      yield createErrorEvent(input.councilId, input.turnId, agent.id, {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    yield createAgentFinishedEvent(input.councilId, input.turnId, agent.id);
  }

  if (privateThoughts.length === 0) {
    return;
  }

  const synthesisPrompt = buildCouncilSynthesisPrompt(privateThoughts);

  for (const agent of input.activeAgents) {
    yield createAgentStartedEvent(input.councilId, input.turnId, agent.id);

    try {
      const output = yield* deps.generateWithToolsStream(
        input.turnId,
        agent,
        'council',
        createDerivedEvent(input.event, synthesisPrompt),
        [...input.stateMessages, ...input.pendingMessages],
        input.options
      );

      if (output && output.content.trim()) {
        const message = createAgentMessage({
          turnId: input.turnId,
          agent,
          visibility: 'public',
          output,
        });

        input.pendingMessages.push(message);
        yield createMessageEmittedEvent(input.councilId, input.turnId, message);
      }
    } catch (error) {
      yield createErrorEvent(input.councilId, input.turnId, agent.id, {
        code: 'agent_execution_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    yield createAgentFinishedEvent(input.councilId, input.turnId, agent.id);
  }
}
