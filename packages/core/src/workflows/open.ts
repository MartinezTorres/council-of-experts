import {
  createAgentFinishedEvent,
  createAgentMessage,
  createAgentStartedEvent,
  createErrorEvent,
  createMessageEmittedEvent,
  createMessageRecord,
  ExecuteWorkflowInput,
  StreamWorkflowInput,
  WorkflowDependencies,
} from './shared.js';

export async function executeOpenWorkflow(
  input: ExecuteWorkflowInput,
  deps: WorkflowDependencies
): Promise<void> {
  await Promise.allSettled(
    input.activeAgents.map(async (agent) => {
      try {
        const history = input.stateMessages.filter((m) => m.visibility === 'public');
        const output = await deps.generateWithTools(
          input.turnId,
          agent,
          'open',
          input.event,
          history,
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
            message: `Agent ${agent.id} failed in open mode: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          agent.id
        );
      }
    })
  );
}

export async function* streamOpenWorkflow(
  input: StreamWorkflowInput,
  deps: WorkflowDependencies
) {
  for (const agent of input.activeAgents) {
    yield createAgentStartedEvent(input.councilId, input.turnId, agent.id);

    try {
      const history = input.stateMessages.filter((m) => m.visibility === 'public');
      const output = yield* deps.generateWithToolsStream(
        input.turnId,
        agent,
        'open',
        input.event,
        history,
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
