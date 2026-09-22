import { randomUUID } from 'crypto';
import type { Settings } from '../types';
import { MystiTagScanner, MYSTI_VISUAL_KINDS, type MystiDirective } from '../utils/mystiDelegateParser';

/** One ordinary response's visual protocol and permission to create a successor. */
export class BackendVisualTurn {
  public readonly nonce = randomUUID().replace(/-/g, '').slice(0, 16);
  public readonly settings: Settings;
  private readonly _abort = new AbortController();
  private _scanner?: MystiTagScanner;
  private _triggered = false;
  private _claimed = false;
  private _outcome: 'pending' | 'succeeded' | 'failed' = 'pending';
  private readonly _completion: Promise<boolean>;
  private _resolveCompletion!: (succeeded: boolean) => void;

  public constructor(
    public readonly requestId: string,
    public readonly panelId: string,
    settings: Settings,
    private readonly _owns: () => boolean,
  ) {
    this.settings = Object.freeze(JSON.parse(JSON.stringify(settings)) as Settings);
    this._completion = new Promise(resolve => { this._resolveCompletion = resolve; });
  }

  public get signal(): AbortSignal { return this._abort.signal; }
  public get pendingLook(): boolean { return this._triggered && !this._claimed; }
  public get continuationClaimed(): boolean { return this._claimed; }
  public readonly isCurrent = (): boolean => {
    if (this._abort.signal.aborted) { return false; }
    if (!this._owns()) { this.retire(); return false; }
    return true;
  };

  /** Called only after this owner's capability preparation succeeds. */
  public enable(): void {
    if (this.isCurrent() && !this._scanner) { this._scanner = new MystiTagScanner(this.nonce, MYSTI_VISUAL_KINDS); }
  }

  public feed(text: string): Extract<MystiDirective, { kind: 'look' }> | undefined {
    if (!this.isCurrent() || this._outcome !== 'pending' || this._triggered) { return; }
    const directive = this._scanner?.feed(text).directive;
    if (directive?.kind !== 'look') { return; }
    this._triggered = true;
    return directive;
  }

  /** History and responseComplete must already have committed synchronously. */
  public succeeded(): void {
    if (!this.isCurrent() || this._outcome !== 'pending') { return; }
    this._outcome = 'succeeded';
    this._resolveCompletion(true);
  }

  /** Also used for Stop, replacement and an incomplete provider EOF. */
  public retire(): void {
    this._outcome = 'failed';
    this._resolveCompletion(false);
    this._abort.abort();
    this._scanner = undefined;
  }

  /** Stages a fast observation until the parent answer has safely landed. */
  public async waitForSuccess(): Promise<boolean> {
    return this.isCurrent() && await this._completion && this.isCurrent() && this._outcome === 'succeeded';
  }

  /** No await is permitted between this check and admitting the child send. */
  public claimContinuation(): boolean {
    if (!this.isCurrent() || this._outcome !== 'succeeded' || this._claimed || !this._triggered) { return false; }
    this._claimed = true;
    return true;
  }
}
