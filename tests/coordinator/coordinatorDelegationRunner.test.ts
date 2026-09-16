import { describe, expect, it, vi } from 'vitest';
import { CoordinatorDelegationRunner, type CoordinatorDelegationConfig, type CoordinatorDelegationPorts, type CoordinatorDelegationResult, type DelegationDirective } from '../../src/coordinator/CoordinatorDelegationRunner';
import { CoordinatorRunBudget, resolveCoordinatorRunLimits } from '../../src/coordinator/CoordinatorRunBudget';
import type { GatewayChatMessage } from '../../src/services/DeepMystGatewayClient';
import type { CollaboratorFailure } from '../../src/types';

const success = (overrides: Partial<CoordinatorDelegationResult> = {}): CoordinatorDelegationResult => ({ text: 'Done', hasError: false, wrote: false, ...overrides });
const failure = (kind: CollaboratorFailure, overrides: Partial<CoordinatorDelegationResult> = {}) => success({ hasError: true, failure: kind, ...overrides });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(cap = 4, config: Partial<CoordinatorDelegationConfig> = {}) {
  let cancelled = false;
  let next = 0;
  const messages: GatewayChatMessage[] = [];
  const budget = new CoordinatorRunBudget({ ...resolveCoordinatorRunLimits('medium', () => undefined), maxDelegations: cap });
  const ports = {
    isCancelled: () => cancelled,
    nextToolId: (prefix: string) => `${prefix}-${next++}`,
    output: { postToolUse: vi.fn(), postToolResult: vi.fn(), recordDelegation: vi.fn(), recordReview: vi.fn() },
    execute: vi.fn<CoordinatorDelegationPorts['execute']>(async () => success()),
    onCharged: vi.fn(),
    suggestTier: vi.fn<CoordinatorDelegationPorts['suggestTier']>(),
    resolveTierModel: vi.fn<CoordinatorDelegationPorts['resolveTierModel']>(() => 'test-model'),
    canSelectModel: vi.fn(() => true),
    delegationEffort: vi.fn<CoordinatorDelegationPorts['delegationEffort']>(() => 'high'),
    diagnostics: vi.fn<CoordinatorDelegationPorts['diagnostics']>(async () => ({ ok: true, output: 'diag: no diagnostics — the workspace is clean.' })),
    scanWorkspace: vi.fn<CoordinatorDelegationPorts['scanWorkspace']>(async () => ({ testCommands: ['npm test'] })),
    fenceResult: vi.fn<CoordinatorDelegationPorts['fenceResult']>((agent, result) => `FENCED[${agent}]${result.text}[/FENCED]`),
    fenceLocalResult: vi.fn((kind: string, text: string) => `FENCED[${kind}]${text}[/FENCED]`),
  } satisfies CoordinatorDelegationPorts;
  const runner = new CoordinatorDelegationRunner(budget, { backends: ['claude-code', 'openai-codex', 'google-gemini'], verify: true, crossReview: false, ...config }, ports);
  const dispatch = (overrides: Partial<DelegationDirective> = {}) => runner.dispatch({ kind: 'delegate', agent: 'claude-code', task: 'Implement change', ...overrides }, 'coordinator text', messages);
  return { runner, ports, budget, messages, dispatch, stop: () => { cancelled = true; } };
}

describe('coordinator delegation ownership and accounting', () => {
  it('does not substitute an unknown backend or spend a delegation', async () => {
    const h = harness();
    await h.dispatch({ agent: 'not-a-backend' });
    expect(h.ports.execute).not.toHaveBeenCalled();
    expect(h.budget.used('delegations')).toBe(0);
    expect(h.messages[1].content).toContain('There is no usable agent');
    expect(h.ports.output.recordDelegation).toHaveBeenCalledWith('deleg-0', 'not-a-backend', 'Implement change', expect.any(String), true);
  });

  it('folds attached context once per writer per run and fences ordered replay', async () => {
    const h = harness();
    await h.dispatch({ agent: ' claude-code ' });
    await h.dispatch();
    expect(h.ports.execute.mock.calls.map(([request]) => request.foldFiles)).toEqual([true, false]);
    expect(h.messages.map(message => message.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
    expect(h.messages[1].content).toBe('FENCED[claude-code]Done[/FENCED]');
    expect(h.ports.onCharged).toHaveBeenCalledTimes(2);
    const independent = harness();
    await independent.dispatch();
    expect(independent.ports.execute.mock.calls[0][0].foldFiles).toBe(true);
  });

  it.each(['not-installed', 'not-authenticated'] as const)('drops an unused %s backend and reroutes without charging failed preflight', async kind => {
    const h = harness(2);
    h.ports.execute.mockResolvedValueOnce(failure(kind, { preflightSkipped: true }));
    await h.dispatch({ tier: 'strong' });
    expect(h.ports.execute.mock.calls.map(([r]) => r.agent)).toEqual(['claude-code', 'openai-codex']);
    expect(h.budget.used('delegations')).toBe(1);
    expect(h.ports.onCharged).toHaveBeenCalledOnce();
    expect(h.ports.output.recordDelegation.mock.calls.map(call => call[5])).toEqual(['strong', 'strong']);
    await h.dispatch();
    expect(h.ports.execute).toHaveBeenCalledTimes(2);
    expect(h.messages.at(-1)?.content).toContain('There is no usable agent');
  });

  it('charges a failed transport and one alternate, never a third backend', async () => {
    const h = harness();
    h.ports.execute.mockResolvedValue(failure('crashed'));
    await h.dispatch();
    expect(h.ports.execute).toHaveBeenCalledTimes(2);
    expect(h.budget.used('delegations')).toBe(2);
    expect(h.ports.onCharged).toHaveBeenCalledTimes(2);
  });

  it('charges post-dispatch authentication failure even when no effect was observed', async () => {
    const h = harness(1);
    h.ports.execute.mockResolvedValueOnce(failure('not-authenticated'));
    await h.dispatch();
    expect(h.ports.execute).toHaveBeenCalledOnce();
    expect(h.budget.used('delegations')).toBe(1);
    expect(h.ports.onCharged).toHaveBeenCalledOnce();
  });

  it.each([
    failure('crashed', { wrote: true }),
    failure('stream-error', { mayHaveSideEffects: true }),
    failure('not-authenticated', { mayHaveSideEffects: true }),
    failure('denied'),
    failure('cancelled'),
  ])('never reroutes an effect, denied operation or cancellation: %j', async result => {
    const h = harness();
    h.ports.execute.mockResolvedValue(result);
    await h.dispatch();
    expect(h.ports.execute).toHaveBeenCalledOnce();
    expect(h.budget.used('delegations')).toBe(1);
  });

  it('treats a thrown execution as uncertain effects, records failure and never retries it', async () => {
    const h = harness();
    h.ports.execute.mockRejectedValue(new Error('lost transport after native approval'));
    await h.dispatch();
    expect(h.ports.execute).toHaveBeenCalledOnce();
    expect(h.ports.output.recordDelegation.mock.calls[0][4]).toBe(true);
    expect(h.ports.fenceResult.mock.calls[0][1].mayHaveSideEffects).toBe(true);
  });

  it('does not reroute or review beyond the shared delegation cap', async () => {
    const h = harness(1, { crossReview: true });
    h.ports.execute.mockResolvedValueOnce(success({ wrote: true }));
    await h.dispatch();
    await h.dispatch();
    expect(h.ports.execute).toHaveBeenCalledOnce();
    expect(h.budget.used('delegations')).toBe(1);
    expect(h.messages.at(-1)?.content).toContain('delegation limit');
    const failed = harness(1);
    failed.ports.execute.mockResolvedValue(failure('timeout'));
    await failed.dispatch();
    expect(failed.ports.execute).toHaveBeenCalledOnce();
  });

  it('charges read-only cross-review, folds no attachments, and merges it into the result turn', async () => {
    const h = harness(4, { crossReview: true });
    h.ports.execute.mockResolvedValue(success({ wrote: true }));
    await h.dispatch({ tier: 'strong' });
    expect(h.ports.execute.mock.calls[1][0]).toMatchObject({ agent: 'openai-codex', reviewOnly: true, foldFiles: false });
    expect(h.ports.execute.mock.calls[1][0]).not.toHaveProperty('modelOverride');
    expect(h.budget.used('delegations')).toBe(2);
    expect(h.ports.onCharged).toHaveBeenCalledTimes(2);
    expect(h.messages.map(message => message.role)).toEqual(['assistant', 'user']);
    expect(h.messages[1].content).toContain('FENCED[review]Done[/FENCED]');
    await h.dispatch();
    expect(h.ports.execute.mock.calls.filter(([r]) => r.reviewOnly)).toHaveLength(1);
  });

  it('does not charge an unavailable reviewer or repeatedly select that backend', async () => {
    const h = harness(3, { crossReview: true });
    h.ports.execute.mockResolvedValueOnce(success({ wrote: true })).mockResolvedValueOnce(failure('not-installed', { preflightSkipped: true }));
    await h.dispatch();
    await h.dispatch({ agent: 'openai-codex' });
    expect(h.ports.execute).toHaveBeenCalledTimes(2);
    expect(h.budget.used('delegations')).toBe(1);
    expect(h.ports.output.recordReview.mock.calls[0][4]).toBe(true);
  });

  it('only routes and advertises tiers supported by each actual writer', async () => {
    const h = harness();
    h.ports.suggestTier.mockReturnValue('fast');
    h.ports.canSelectModel.mockImplementation(agent => agent !== 'claude-code');
    h.ports.execute.mockResolvedValueOnce(failure('not-installed'));
    await h.dispatch({ tier: 'strong' });
    expect(h.ports.suggestTier).not.toHaveBeenCalled();
    const calls = h.ports.execute.mock.calls.map(([request]) => request);
    expect(calls[0].modelOverride).toBeUndefined();
    expect(calls[1]).toMatchObject({ modelOverride: 'test-model', effortOverride: 'high' });
    expect(h.ports.output.recordDelegation.mock.calls.map(call => call[5])).toEqual([undefined, 'strong']);
  });
});

describe('verification truth and cancellation boundaries', () => {
  it.each(['reject', 'failed'] as const)('does not report %s diagnostics as clean', async kind => {
    const h = harness();
    h.ports.execute.mockResolvedValue(success({ wrote: true }));
    if (kind === 'reject') { h.ports.diagnostics.mockRejectedValue(new Error('unavailable')); }
    else { h.ports.diagnostics.mockResolvedValue({ ok: false, output: 'unavailable' }); }
    await h.dispatch();
    expect(h.messages[1].content).toContain('diagnostics: unavailable');
    expect(h.messages[1].content).not.toContain('clean');
  });

  it('fences actual diagnostics including a misleading clean phrase, and caches command discovery', async () => {
    const h = harness();
    h.ports.execute.mockResolvedValue(success({ wrote: true }));
    h.ports.diagnostics.mockResolvedValue({ ok: true, output: '1 diagnostic(s):\na.ts:1 [error] string literal "no diagnostics" is invalid' });
    await h.dispatch(); await h.dispatch(); await h.dispatch();
    expect(h.messages[1].content).toContain('FENCED[diag]1 diagnostic(s):');
    expect(h.messages[1].content).toContain('FENCED[verification-commands]npm test[/FENCED]');
    expect(h.ports.diagnostics).toHaveBeenCalledTimes(2);
    expect(h.ports.scanWorkspace).toHaveBeenCalledOnce();
  });

  it.each(['diagnostics', 'scanWorkspace'] as const)('stops at the %s await without further work or replay', async boundary => {
    const h = harness(4, { crossReview: true });
    const pending = deferred<any>();
    h.ports.execute.mockResolvedValue(success({ wrote: true }));
    h.ports[boundary].mockReturnValue(pending.promise);
    const work = h.dispatch();
    await vi.waitFor(() => expect(h.ports[boundary]).toHaveBeenCalledOnce());
    h.stop(); pending.resolve({ ok: true, output: 'diagnostics', testCommands: ['npm test'] });
    expect(await work).toBe('cancelled');
    expect(h.messages).toEqual([]);
    expect(h.ports.execute).toHaveBeenCalledOnce();
    if (boundary === 'diagnostics') { expect(h.ports.scanWorkspace).not.toHaveBeenCalled(); }
  });

  it.each([false, true])('settles the active card on Stop (review=%s) and rejects concurrent callers', async review => {
    const h = harness(4, { crossReview: review, verify: false });
    const pending = deferred<CoordinatorDelegationResult>();
    if (review) { h.ports.execute.mockResolvedValueOnce(success({ wrote: true })).mockReturnValueOnce(pending.promise); }
    else { h.ports.execute.mockReturnValueOnce(pending.promise); }
    const work = h.dispatch();
    await vi.waitFor(() => expect(h.ports.execute).toHaveBeenCalledTimes(review ? 2 : 1));
    await expect(h.dispatch()).rejects.toThrow('serially');
    h.stop(); pending.resolve(success());
    expect(await work).toBe('cancelled');
    expect(h.ports.output.postToolResult).toHaveBeenLastCalledWith(expect.objectContaining({ name: review ? 'review' : 'delegate', output: 'Stopped by user', status: 'failed' }));
    if (!review) { expect(h.messages).toEqual([]); }
  });

  it('starts no work after Stop even if a caller still holds a directive', async () => {
    const h = harness(); h.stop();
    expect(await h.dispatch()).toBe('cancelled');
    expect(h.ports.execute).not.toHaveBeenCalled();
    expect(h.ports.output.postToolUse).not.toHaveBeenCalled();
  });
});
