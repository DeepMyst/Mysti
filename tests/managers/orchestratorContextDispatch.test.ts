import { describe, expect, it } from 'vitest';
import { MystiOrchestratorManager } from '../../src/managers/MystiOrchestratorManager';
import { CollaboratorPool } from '../../src/services/CollaboratorPool';
import { MockProviderManager, createMockStream } from '../helpers/mockProviderManager';
import { collabSettings } from '../helpers/collaboratorFactory';
import type { ContextItem } from '../../src/types';
const manual: ContextItem = { id: 'manual', type: 'file', path: '/manual.ts', content: 'MANUAL_KEEP', enabled: true };
const automatic: ContextItem = { id: 'auto', type: 'file', path: '/automatic.ts', content: 'AUTO_SNAPSHOT', enabled: true };
const plan = { nodes: [
  { id: 'first', task: 'inspect', backend: 'google-gemini', dependsOn: [] },
  { id: 'second', task: 'report', backend: 'claude-code', dependsOn: ['first'] },
] };
async function drain(gen: AsyncGenerator<any, any>) {
  const events: any[] = []; let next = await gen.next();
  while (!next.done) { events.push(next.value); next = await gen.next(); }
  return { events, result: next.value };
}
function fixture() {
  let enabled = true, cancelled = false;
  const pm = new MockProviderManager();
  pm.setProviderAvailable('google-gemini'); pm.setProviderAvailable('claude-code');
  const prompts: string[] = [], canonical: string[] = [], wire: string[] = [];
  let beforeModel: () => void | Promise<void> = () => undefined;
  let afterLeaf: () => void = () => undefined;
  for (const agent of ['google-gemini', 'claude-code']) pm.streamFactories.set(agent, (_provider, content) => {
    prompts.push(content); afterLeaf();
    return createMockStream([{ type: 'text', content: `RESULT_${agent}` }, { type: 'done' }]);
  });
  const pool = new CollaboratorPool(pm as any);
  const coordinator = { complete: async (messages: any[], options: any) => {
    canonical.push(JSON.stringify(messages));
    await beforeModel();
    if (options.isCancelled?.() || options.signal?.aborted) return { text: '', failed: true, error: 'cancelled' };
    const body = JSON.stringify(options.resolveMessages?.() ?? messages); wire.push(body);
    return { text: body.includes('Decompose the user') ? JSON.stringify(plan) : 'SYNTHESIS', failed: false };
  } };
  const manager = new MystiOrchestratorManager(pool, coordinator as any,
    { getAllProviderIds: () => ['google-gemini', 'claude-code'], getProviderDefaultModel: () => 'model' });
  const input = { brief: 'inspect and report', context: [manual], settings: collabSettings(), panelId: 'owned',
    resolveContext: () => enabled ? [manual, automatic] : [manual], isCancelled: () => cancelled };
  return { manager, pool, pm, input, prompts, canonical, wire,
    disable: () => { enabled = false; }, cancel: () => { cancelled = true; },
    beforeModel: (callback: typeof beforeModel) => { beforeModel = callback; },
    afterLeaf: (callback: typeof afterLeaf) => { afterLeaf = callback; } };
}

describe('orchestration context at dispatch', () => {
  it('uses automatic paths in planning and fenced content in leaves, never canonical inputs', async () => {
    const f = fixture();
    try {
      const { result } = await drain(f.manager.run(f.input));
      expect(result.synthesis).toBe('SYNTHESIS'); expect(f.prompts).toHaveLength(2);
      expect(f.wire[0]).toContain('/automatic.ts'); expect(f.wire[0]).not.toContain('AUTO_SNAPSHOT');
      expect(f.prompts.every(p => p.includes('AUTO_SNAPSHOT') && p.includes('UNTRUSTED'))).toBe(true);
      expect(f.prompts[1]).toContain('RESULT_google-gemini');
      expect(f.canonical.every(p => !p.includes('/automatic.ts'))).toBe(true);
      expect(f.input.context).toEqual([manual]);
    } finally { for (const id of [...(f.pool as any)._runChildProviders.keys()] as string[]) f.pool.disposeRun(id); }
  });
  it('removes automatic context after a model queue wait', async () => {
    const f = fixture(); f.beforeModel(f.disable);
    try {
      await drain(f.manager.run(f.input));
      expect(f.wire[0]).not.toContain('/automatic.ts'); expect(f.wire[0]).toContain('/manual.ts');
      expect(f.prompts.every(p => !p.includes('AUTO_SNAPSHOT') && p.includes('MANUAL_KEEP'))).toBe(true);
    } finally { for (const id of [...(f.pool as any)._runChildProviders.keys()] as string[]) f.pool.disposeRun(id); }
  });
  it('rechecks each frontier while retaining dependency results', async () => {
    const f = fixture(); f.afterLeaf(f.disable);
    try {
      await drain(f.manager.run(f.input));
      expect(f.prompts[0]).toContain('AUTO_SNAPSHOT'); expect(f.prompts[1]).not.toContain('AUTO_SNAPSHOT');
      expect(f.prompts[1]).toContain('MANUAL_KEEP'); expect(f.prompts[1]).toContain('RESULT_google-gemini');
    } finally { for (const id of [...(f.pool as any)._runChildProviders.keys()] as string[]) f.pool.disposeRun(id); }
  });
  it('does not dispatch leaves when the owner changes during decomposition', async () => {
    const f = fixture(); f.beforeModel(f.cancel);
    try {
      const { result } = await drain(f.manager.run(f.input));
      expect(f.wire).toEqual([]); expect(f.prompts).toEqual([]); expect(result.synthesis).toBe('');
      expect((f.manager as any)._runAborts.size).toBe(0);
    } finally { for (const id of [...(f.pool as any)._runChildProviders.keys()] as string[]) f.pool.disposeRun(id); }
  });
  it('does not dispatch later frontiers or synthesis after ownership is revoked', async () => {
    const f = fixture(); f.afterLeaf(f.cancel);
    try {
      await drain(f.manager.run(f.input));
      expect(f.prompts).toHaveLength(1); expect(f.wire).toHaveLength(1);
      expect((f.manager as any)._activeRunsByPanel.size).toBe(0);
    } finally { for (const id of [...(f.pool as any)._runChildProviders.keys()] as string[]) f.pool.disposeRun(id); }
  });
  it('Stop cancels a coordinator wait before the first frontier', async () => {
    const f = fixture();
    f.beforeModel(() => f.manager.cancelPanel('owned'));
    try {
      await drain(f.manager.run(f.input)); expect(f.wire).toEqual([]); expect(f.prompts).toEqual([]);
      expect((f.manager as any)._runAborts.size).toBe(0);
    } finally { for (const id of [...(f.pool as any)._runChildProviders.keys()] as string[]) f.pool.disposeRun(id); }
  });
});
