import { AgentDefinition } from '../types.js';
import {
  createAgentFinishedEvent,
  createAgentMessage,
  createAgentStartedEvent,
  createDerivedEvent,
  createErrorEvent,
  createMessageEmittedEvent,
  createMessageRecord,
  createOracleMessage,
  ExecuteWorkflowInput,
  StreamWorkflowInput,
  WorkflowDependencies,
} from './shared.js';

function buildOraclePrompt(
  privateThoughts: Array<{ agent: AgentDefinition; content: string }>
): string {
  return `You are the Oracle, speaking with one unified voice for the council.

Private deliberation from council members:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Synthesize a single, unified response that represents the council's collective wisdom:`;
}

export async function executeOracleWorkflow(
  input: ExecuteWorkflowInput,
  deps: WorkflowDependencies
): Promise<void> {
  const emitPublicOracle = input.options?.emitPublicOracle !== false;
  const privateThoughts: Array<{ agent: AgentDefinition; content: string }> = [];

  await Promise.allSettled(
    input.activeAgents.map(async (agent) => {
      try {
        const output = await deps.generateWithTools(
          input.turnId,
          agent,
          'oracle',
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
            message: `Agent ${agent.id} failed in oracle deliberation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          agent.id
        );
      }
    })
  );

  if (
    privateThoughts.length === 0 ||
    input.activeAgents.length === 0 ||
    !emitPublicOracle
  ) {
    return;
  }

  const synthesisAgent = input.activeAgents[0];

  try {
    const output = await deps.generateWithTools(
      input.turnId,
      synthesisAgent,
      'oracle',
      createDerivedEvent(input.event, buildOraclePrompt(privateThoughts)),
      [...input.stateMessages, ...input.privateMessages],
      input.options,
      input.records,
      input.errors
    );

    if (output && output.content.trim()) {
      const message = createOracleMessage({
        turnId: input.turnId,
        output,
      });

      input.publicMessages.push(message);
      input.records.push(createMessageRecord(input.councilId, input.turnId, message));
    }
  } catch (error) {
    deps.recordTurnError(
      input.turnId,
      input.records,
      input.errors,
      {
        code: 'oracle_synthesis_failed',
        message: `Oracle synthesis failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      synthesisAgent.id
    );
  }
}

export async function* streamOracleWorkflow(
  input: StreamWorkflowInput,
  deps: WorkflowDependencies
) {
  const emitPublicOracle = input.options?.emitPublicOracle !== false;
  const privateThoughts: Array<{ agent: AgentDefinition; content: string }> = [];

  for (const agent of input.activeAgents) {
    yield createAgentStartedEvent(input.councilId, input.turnId, agent.id);

    try {
      const output = yield* deps.generateWithToolsStream(
        input.turnId,
        agent,
        'oracle',
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
        code: 'agent_execution_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    yield createAgentFinishedEvent(input.councilId, input.turnId, agent.id);
  }

  if (
    privateThoughts.length === 0 ||
    input.activeAgents.length === 0 ||
    !emitPublicOracle
  ) {
    return;
  }

  const synthesisAgent = input.activeAgents[0];
  yield createAgentStartedEvent(input.councilId, input.turnId, 'oracle');

  try {
    const output = yield* deps.generateWithToolsStream(
      input.turnId,
      synthesisAgent,
      'oracle',
      createDerivedEvent(input.event, buildOraclePrompt(privateThoughts)),
      [...input.stateMessages, ...input.pendingMessages],
      input.options
    );

    if (output && output.content.trim()) {
      const message = createOracleMessage({
        turnId: input.turnId,
        output,
      });

      input.pendingMessages.push(message);
      yield createMessageEmittedEvent(input.councilId, input.turnId, message);
    }
  } catch (error) {
    yield createErrorEvent(input.councilId, input.turnId, 'oracle', {
      code: 'oracle_synthesis_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  yield createAgentFinishedEvent(input.councilId, input.turnId, 'oracle');
}
