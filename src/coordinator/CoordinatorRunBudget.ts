/** Per-run accounting only; consuming budget never grants tool permission. */
export interface CoordinatorRunLimits {
  maxDelegations: number;
  maxTurns: number;
  maxLocalTools: number;
  maxLocalExec: number;
  maxMcpCalls: number;
  maxVisualLooks: number;
  maxCanvasCalls: number;
}

export const READ_ONLY_BATCH_CONCURRENCY = 3;

/** Snapshot settings once, before any asynchronous work in the run. */
export function resolveCoordinatorRunLimits(
  effort: string | undefined,
  getSetting: (key: string) => unknown,
): Readonly<CoordinatorRunLimits> {
  const clamp = (key: string, fallback: number, min: number, max: number): number => {
    const value = getSetting(key);
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const scale = effort === 'high' ? 2 : 1;
  return Object.freeze({
    maxDelegations: clamp('mysti.maxDelegations', 4, 1, 16) * scale,
    maxTurns: clamp('mysti.maxTurns', 24, 2, 64) * scale,
    maxLocalTools: 20 * scale,
    maxLocalExec: 12 * scale,
    // External side effects and the separate Canvas loop cap are not scaled.
    maxMcpCalls: clamp('mysti.maxMcpCalls', 6, 1, 32),
    maxVisualLooks: clamp('mysti.maxVisualLooks', 6, 1, 24) * scale,
    maxCanvasCalls: 60,
  });
}

export type CoordinatorBudgetKind = 'delegations' | 'localTools' | 'localExec' | 'mcpCalls' | 'visualLooks' | 'canvasCalls';

/** One owner per run. Reserve synchronous batches before starting their work. */
export class CoordinatorRunBudget {
  readonly limits: Readonly<CoordinatorRunLimits>;
  private readonly _used: Record<CoordinatorBudgetKind, number> = {
    delegations: 0, localTools: 0, localExec: 0, mcpCalls: 0, visualLooks: 0, canvasCalls: 0,
  };
  private readonly _caps: Record<CoordinatorBudgetKind, number>;

  constructor(limits: CoordinatorRunLimits) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error('Run limits must be non-negative safe integers');
    }
    this.limits = Object.freeze({ ...limits });
    this._caps = {
      delegations: limits.maxDelegations, localTools: limits.maxLocalTools,
      localExec: limits.maxLocalExec, mcpCalls: limits.maxMcpCalls,
      visualLooks: limits.maxVisualLooks, canvasCalls: limits.maxCanvasCalls,
    };
  }

  used(kind: CoordinatorBudgetKind): number { return this._used[kind]; }
  remaining(kind: CoordinatorBudgetKind): number { return this._caps[kind] - this._used[kind]; }

  /** A rejected reservation changes no counters. Failed/denied tools retain their charge. */
  consume(kind: CoordinatorBudgetKind, amount = 1): boolean {
    if (!Number.isSafeInteger(amount) || amount < 0) { throw new Error('Invalid budget reservation'); }
    if (amount > this.remaining(kind)) { return false; }
    this._used[kind] += amount;
    return true;
  }
}
