/**
 * Plan 14 security: a user/workspace-authored role must NOT be able to escalate
 * a collaborator to gated-write. Only bundled (core/plugin) roles may declare
 * `access: gated-write`; everything else clamps to read-only.
 */
import { describe, it, expect } from 'vitest';
import { AgentContextManager } from '../../src/managers/AgentContextManager';
import type { AgentMetadata, AgentInstructions } from '../../src/managers/AgentLoader';

function stubLoader(meta: Partial<AgentMetadata> & { id: string }): any {
  const full: AgentMetadata = {
    id: meta.id,
    name: meta.name ?? meta.id,
    description: meta.description ?? 'x',
    category: 'collaboration',
    source: meta.source ?? 'core',
    filePath: '/x',
    roleAccess: meta.roleAccess,
    rolePattern: meta.rolePattern,
  };
  const instructions: AgentInstructions = {
    ...full,
    instructions: 'Do the thing.',
  };
  return {
    loadInstructions: async (id: string) => (id === meta.id ? instructions : null),
    getRoles: () => [full],
  };
}

function makeManager(loader: any): AgentContextManager {
  return new AgentContextManager({} as any, loader);
}

describe('role access clamping (Plan 14 security)', () => {
  it('honors gated-write for a bundled (core) role', async () => {
    const mgr = makeManager(stubLoader({ id: 'coworker', source: 'core', roleAccess: 'gated-write' }));
    const ctx = await mgr.buildRoleContext('coworker');
    expect(ctx!.access).toBe('gated-write');
  });

  it('clamps a WORKSPACE role that declares gated-write down to read-only', async () => {
    const mgr = makeManager(stubLoader({ id: 'coworker', source: 'workspace', roleAccess: 'gated-write' }));
    const ctx = await mgr.buildRoleContext('coworker');
    expect(ctx!.access).toBe('read-only');
  });

  it('clamps a USER role that declares gated-write down to read-only', async () => {
    const mgr = makeManager(stubLoader({ id: 'helper', source: 'user', roleAccess: 'gated-write' }));
    const ctx = await mgr.buildRoleContext('helper');
    expect(ctx!.access).toBe('read-only');
  });

  it('defaults to read-only when a role omits access', async () => {
    const mgr = makeManager(stubLoader({ id: 'advisor', source: 'core' }));
    const ctx = await mgr.buildRoleContext('advisor');
    expect(ctx!.access).toBe('read-only');
  });

  it('returns null for an unknown role', async () => {
    const mgr = makeManager(stubLoader({ id: 'advisor', source: 'core' }));
    const ctx = await mgr.buildRoleContext('nonexistent');
    expect(ctx).toBeNull();
  });
});
