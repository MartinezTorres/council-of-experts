import type {
  ChatEvent,
  Council,
  CouncilMode,
  CouncilModule,
  CouncilMessage,
  TurnResult,
} from 'council-of-experts';

export class CouncilSession {
  private council?: Council;
  private sessionIndex = 0;
  private mode: CouncilMode;

  constructor(
    private readonly councilModule: CouncilModule,
    initialMode: CouncilMode = 'open',
    private readonly councilIdPrefix: string = 'cli-session'
  ) {
    this.mode = initialMode;
  }

  async initialize(): Promise<void> {
    await this.reset();
  }

  getMode(): CouncilMode {
    return this.mode;
  }

  setMode(mode: CouncilMode): void {
    this.mode = mode;
  }

  async post(event: ChatEvent): Promise<TurnResult> {
    const council = await this.getCouncil();
    const result = await council.post(event, { mode: this.mode });
    this.mode = result.nextMode ?? result.mode;
    return result;
  }

  async getMessages(options?: {
    visibility?: 'public' | 'private' | 'all';
    limit?: number;
  }): Promise<CouncilMessage[]> {
    return (await this.getCouncil()).getMessages(options);
  }

  async getStatus(): Promise<unknown> {
    return (await this.getCouncil()).getStatus();
  }

  async reset(): Promise<void> {
    if (this.council) {
      await this.council.dispose();
    }

    this.sessionIndex += 1;
    this.council = await this.councilModule.openCouncil({
      councilId: `${this.councilIdPrefix}-${this.sessionIndex}`,
      initialMode: this.mode,
    });
  }

  private async getCouncil(): Promise<Council> {
    if (!this.council) {
      await this.reset();
    }

    return this.council!;
  }
}
