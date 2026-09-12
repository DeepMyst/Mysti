import { describe, expect, it } from 'vitest';
import { CoordinatorRunBudget, resolveCoordinatorRunLimits, type CoordinatorBudgetKind } from '../../src/coordinator/CoordinatorRunBudget';

const defaults = () => resolveCoordinatorRunLimits('medium', () => undefined);

describe('coordinator run budgets', () => {
  it('scales local work while retaining external and Canvas limits', () => {
    const normal = defaults();
    const high = resolveCoordinatorRunLimits('high', () => undefined);
    expect(normal).toEqual({ maxDelegations: 4, maxTurns: 24, maxLocalTools: 20, maxLocalExec: 12, maxMcpCalls: 6, maxVisualLooks: 6, maxCanvasCalls: 60 });
    expect(high).toEqual({ maxDelegations: 8, maxTurns: 48, maxLocalTools: 40, maxLocalExec: 24, maxMcpCalls: 6, maxVisualLooks: 12, maxCanvasCalls: 60 });
  });

  it('clamps configuration before effort scaling and rejects non-numeric settings', () => {
    const values: Record<string, unknown> = { 'mysti.maxDelegations': -1, 'mysti.maxTurns': 999, 'mysti.maxMcpCalls': 2.9, 'mysti.maxVisualLooks': '8' };
    expect(resolveCoordinatorRunLimits('high', key => values[key])).toMatchObject({ maxDelegations: 2, maxTurns: 128, maxMcpCalls: 2, maxVisualLooks: 12 });
    for (const value of [NaN, Infinity, null]) {
      expect(resolveCoordinatorRunLimits(undefined, () => value)).toEqual(defaults());
    }
  });

  it.each<CoordinatorBudgetKind>(['delegations', 'localTools', 'localExec', 'mcpCalls', 'visualLooks', 'canvasCalls'])('enforces the %s cap without charging other work', kind => {
    const budget = new CoordinatorRunBudget(defaults());
    const cap = budget.remaining(kind);
    expect(budget.consume(kind, cap - 1)).toBe(true);
    expect(budget.consume(kind, 2)).toBe(false);
    expect(budget.used(kind)).toBe(cap - 1);
    expect(budget.consume(kind)).toBe(true);
    expect(budget.consume(kind)).toBe(false);
    expect(budget.remaining(kind)).toBe(0);
    expect(budget.used(kind === 'delegations' ? 'localTools' : 'delegations')).toBe(0);
  });

  it('reserves a batch before asynchronous workers start', async () => {
    const budget = new CoordinatorRunBudget({ ...defaults(), maxLocalTools: 3 });
    expect(budget.consume('localTools', 2)).toBe(true);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    expect(budget.remaining('localTools')).toBe(1);
    expect(budget.consume('localTools', 2)).toBe(false);
    expect(budget.consume('localTools')).toBe(true);
    finish();
    await pending;
    // Completing or failing an attempted operation does not refund its slot.
    expect(budget.remaining('localTools')).toBe(0);
  });

  it('isolates simultaneous runs and snapshots their limits', () => {
    const limits = { ...defaults() };
    const first = new CoordinatorRunBudget(limits);
    const second = new CoordinatorRunBudget(limits);
    limits.maxDelegations = 100;
    first.consume('delegations');
    expect(first.remaining('delegations')).toBe(3);
    expect(second.remaining('delegations')).toBe(4);
    expect(Object.isFrozen(first.limits)).toBe(true);
  });

  it('rejects malformed reservations without reducing or corrupting usage', () => {
    const budget = new CoordinatorRunBudget(defaults());
    budget.consume('localExec');
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => budget.consume('localExec', value)).toThrow('Invalid budget reservation');
      expect(() => new CoordinatorRunBudget({ ...defaults(), maxLocalExec: value })).toThrow('Run limits');
    }
    expect(budget.used('localExec')).toBe(1);
  });
});
