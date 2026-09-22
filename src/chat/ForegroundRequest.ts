import type { WebviewMessage } from '../types';

export type ForegroundPost = ((message: WebviewMessage) => void) & { readonly requestId?: string };

/** Correlation only: authority remains the captured host owner predicate. */
export function validForegroundRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** These controls may finish after the stream, but never after a new admission. */
const ACCESSORIES = new Set([
  'suggestionsLoading', 'suggestionsReady', 'suggestionsError', 'clearSuggestions',
  'planOptions', 'clearPlanOptions', 'askUserQuestion', 'semiAutonomousPlanTimer',
  'semiAutonomousQuestionTimer', 'semiAutonomousDecision', 'autonomousDecision',
  'connectionAlready', 'connectionRequired', 'compactionStatus', 'contextWindowInfo',
  'channelAction', 'autonomousDeactivated',
]);

function terminal(message: WebviewMessage): boolean {
  if (['responseComplete', 'requestCancelled', 'error', 'authError', 'mystiUnavailable', 'mystiSignInRequired', 'jobStarted'].includes(message.type)) { return true; }
  const payload = message.payload as { terminal?: boolean } | undefined;
  return message.type === 'mystiActionRequired' && payload?.terminal === true;
}

/** One captured foreground origin. Never resolves an ID from mutable panel state. */
export class ForegroundRequest {
  private _retired = false;
  private _terminal = false;
  private _cancelled = false;
  public constructor(
    public readonly requestId: string,
    public readonly sequence: number,
    public readonly panelId: string,
    private readonly _owns: () => boolean,
    private readonly _deliver: (message: WebviewMessage) => void,
  ) { Object.defineProperty(this.post, 'requestId', { value: requestId }); }

  public readonly isCurrent = (): boolean => !this._retired && this._owns();
  public get wasCancelled(): boolean { return this._cancelled; }

  public readonly post: ForegroundPost = (message: WebviewMessage): void => {
    const accessory = ACCESSORIES.has(message.type) || (message.type === 'toolResult' && message.scope === 'accessory');
    if (!this.isCurrent() || (this._terminal && !accessory)) { return; }
    if (terminal(message)) { this._terminal = true; }
    this._deliver({ ...message, requestId: this.requestId });
  };

  public acknowledge(): void {
    this.post({ type: 'responsePending', payload: { sequence: this.sequence } });
  }

  /** Called before invalidating the host scope, so the real Stop remains visible. */
  public cancel(): void {
    if (this.isCurrent() && !this._terminal) { this._cancelled = true; }
    this.post({ type: 'requestCancelled' });
  }

  public retire(): void { this._retired = true; }
}
