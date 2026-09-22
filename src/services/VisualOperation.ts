/** Captured visual authority shared by host adapters and owned runtime operations. */
export interface VisualOperationControl {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface VisualOperationContext extends VisualOperationControl {
  readonly id: string;
  readonly panelId: string;
  readonly ownerKey: string;
  readonly workspaceRoot: string;
  readonly workspaceIdentity: string;
}

export interface VisualSessionTarget {
  readonly cacheKey: string;
  readonly panelId: string;
  readonly ownerKey: string;
}

export class VisualOperationCancelled extends Error {
  public constructor(public readonly cleanupIncomplete = false) {
    super(cleanupIncomplete ? 'Visual operation cancelled; resource cleanup could not be confirmed.' : 'Visual operation cancelled.');
    this.name = 'VisualOperationCancelled';
  }
}

export function assertVisualOperation(control?: VisualOperationControl): void {
  if (control && (control.signal.aborted || !control.isCurrent())) { throw new VisualOperationCancelled(); }
}

/** Abort this waiter promptly, while observing and disposing a late returned resource. */
export function awaitVisualOperation<T>(
  control: VisualOperationControl | undefined,
  work: () => Promise<T>,
  discard?: (value: T) => void | Promise<void>,
): Promise<T> {
  assertVisualOperation(control);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => control?.signal.removeEventListener('abort', aborted);
    const aborted = () => {
      if (settled) { return; }
      settled = true; cleanup(); reject(new VisualOperationCancelled());
    };
    const drop = (value: T) => {
      if (discard) {
        void Promise.resolve().then(() => discard(value)).catch(error => {
          console.warn('[Mysti] Late visual resource cleanup failed:', error instanceof Error ? error.message : String(error));
        });
      }
    };
    control?.signal.addEventListener('abort', aborted, { once: true });
    if (control?.signal.aborted) { aborted(); return; }
    Promise.resolve().then(() => { assertVisualOperation(control); return work(); }).then(value => {
      if (settled) { drop(value); return; }
      try { assertVisualOperation(control); }
      catch (error) { settled = true; cleanup(); drop(value); reject(error); return; }
      settled = true; cleanup(); resolve(value);
    }, error => {
      if (settled) { return; }
      settled = true; cleanup();
      if (error instanceof VisualOperationCancelled && error.cleanupIncomplete) { reject(error); return; }
      try { assertVisualOperation(control); } catch (cancelled) { reject(cancelled); return; }
      reject(error);
    });
  });
}

/** Never leave Stop waiting forever on a runtime's close promise. Late rejection is observed. */
export function awaitVisualCleanup(work: Promise<unknown>, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} cleanup was not confirmed within ${timeoutMs}ms.`)), timeoutMs);
    work.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
}
