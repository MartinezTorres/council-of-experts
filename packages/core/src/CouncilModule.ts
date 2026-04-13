import {
  CouncilModule,
  CouncilModuleConfig,
  CouncilModuleResolvedConfig,
  OpenCouncilInput,
  Council,
  AgentDefinition,
  EngineAdapter,
  ToolHost,
} from './types.js';
import {
  createModuleConfigSnapshot,
  resolveCouncilRuntimeConfig,
} from './config.js';
import { resolveCouncilPromptConfig } from './prompts.js';
import { CouncilImpl } from './CouncilImpl.js';

class CouncilModuleImpl implements CouncilModule {
  private agents: AgentDefinition[];
  private engines: Record<string, EngineAdapter>;
  private toolHost?: ToolHost;
  private config: CouncilModuleResolvedConfig;

  constructor(config: CouncilModuleConfig) {
    this.agents = config.agents;
    this.engines = config.engines;
    this.toolHost = config.toolHost;
    this.config = createModuleConfigSnapshot(
      resolveCouncilRuntimeConfig(config.runtime),
      resolveCouncilPromptConfig(config.prompts)
    );
  }

  async openCouncil(input: OpenCouncilInput): Promise<Council> {
    const initialMode = input.initialMode ?? this.config.runtime.initialMode;

    return new CouncilImpl(
      input.councilId,
      initialMode,
      this.config.runtime,
      this.config.prompts,
      this.agents,
      this.engines,
      this.toolHost,
      input.metadata
    );
  }

  listAgents(): AgentDefinition[] {
    return [...this.agents];
  }

  getConfig(): CouncilModuleResolvedConfig {
    return createModuleConfigSnapshot(this.config.runtime, this.config.prompts);
  }
}

export function createCouncilModule(
  config: CouncilModuleConfig
): CouncilModule {
  return new CouncilModuleImpl(config);
}
