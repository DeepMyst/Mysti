/**
 * Plan 14 security: a user/workspace-authored role must NOT be able to escalate
 * a collaborator to gated-write. Everything but an integrity-verified bundled
 * role clamps to read-only.
 *
 * Plan 20 Phase 0 tightened the predicate from `source === 'core' || 'plugin'`
 * to `trusted === true`. Location was never sufficient: the core directory is
 * writable by any local process, so "found under resources/agents/core" was an
 * escalation primitive. Synced `plugin` roles are demoted too — they come from
 * a third-party repo and are not in the compiled-in manifest.
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
    // Default mirrors reality: a core file that matches the shipped manifest is
    // verified, anything else is not. Tests override it explicitly to model a
    // tampered bundle.
    trusted: meta.trusted ?? (meta.source ?? 'core') === 'core',
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

  it('clamps a TAMPERED core role (hash mismatch) down to read-only', async () => {
    // The exact B6 attack: overwrite a bundled role on disk, declare
    // gated-write, get write-capable collaboration. `trusted` is what stops it.
    const mgr = makeManager(stubLoader({ id: 'coworker', source: 'core', trusted: false, roleAccess: 'gated-write' }));
    const ctx = await mgr.buildRoleContext('coworker');
    expect(ctx!.access).toBe('read-only');
  });

  it('clamps a synced PLUGIN role that declares gated-write down to read-only', async () => {
    const mgr = makeManager(stubLoader({ id: 'coworker', source: 'plugin', roleAccess: 'gated-write' }));
    const ctx = await mgr.buildRoleContext('coworker');
    expect(ctx!.access).toBe('read-only');
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
