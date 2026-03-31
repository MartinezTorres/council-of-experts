import {
  CouncilModule,
  CouncilModuleConfig,
  OpenCouncilInput,
  Council,
  AgentDefinition,
} from './types.js';
import { CouncilImpl } from './CouncilImpl.js';

class CouncilModuleImpl implements CouncilModule {
  private agents: AgentDefinition[];
  private engines: Record<string, any>;
  private toolHost: any;

  constructor(config: CouncilModuleConfig) {
    this.agents = config.agents;
    this.engines = config.engines;
    this.toolHost = config.toolHost;
  }

  async openCouncil(input: OpenCouncilInput): Promise<Council> {
    const initialMode = input.initialMode ?? 'open';

    return new CouncilImpl(
      input.councilId,
      initialMode,
      this.agents,
      this.engines,
      this.toolHost,
      input.metadata
    );
  }

  listAgents(): AgentDefinition[] {
    return [...this.agents];
  }
}

export function createCouncilModule(
  config: CouncilModuleConfig
): CouncilModule {
  return new CouncilModuleImpl(config);
}
