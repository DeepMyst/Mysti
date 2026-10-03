/**
 * Plan 20 Phase 2 — structural invariants for agent-authored definitions.
 *
 * These assert things about the SHAPE of the code rather than its behaviour,
 * because the properties that matter here are "no such path exists". A
 * behavioural test can only show that the paths you thought of are closed;
 * these show that the dangerous one was never built.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { ALL_MYSTI_KINDS, MYSTI_SKILL_KINDS, MYSTI_EXEC_KINDS, MYSTI_MCP_KINDS } from '../../src/utils/mystiDelegateParser';
import { coordinatorToolSchemas } from '../../src/services/coordinatorTools';
import { protectedWriteReason, SKILL_STAGING_DIR } from '../../src/services/MystiLocalTools';

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('promotion is unreachable from the model', () => {
  it('the RETRIEVAL tier exposes no way to promote', () => {
    // Phase 1/2 kinds are read-only plus staging writes; nothing installs.
    const retrieval = [...ALL_MYSTI_KINDS, ...MYSTI_SKILL_KINDS, ...MYSTI_EXEC_KINDS, ...MYSTI_MCP_KINDS];
    for (const kind of retrieval) {
      expect(kind).not.toMatch(/promot|install|publish/i);
    }
  });

  it('promotion happens in exactly two places, and both are accounted for', () => {
    // Phase 3 CHANGED this invariant, so it is restated rather than relaxed.
    // Previously nothing model-reachable could promote. Now `publish` can — but
    // only through the ladder, behind two forced cards. The two call sites are
    // the user's review command and that ladder; a third would be a regression.
    const chat = read('providers/ChatViewProvider.ts');
    const callSites = chat.split('\n').filter(l => /\.promote\(/.test(l));
    expect(callSites.length).toBe(2);

    // Both call sites live in named methods, not inline in the loop.
    expect(chat).toContain('public async reviewSkillProposals');
    expect(chat).toContain('private async _runMystiPublish');
  });

  it('every model path to promotion passes TWO forced interactive cards', () => {
    const chat = read('providers/ChatViewProvider.ts');
    const start = chat.indexOf('private async _runMystiPublish');
    const body = chat.slice(start, chat.indexOf('\n  /**', start + 100));
    // Both cards force interaction, so a permissive mode cannot wave a
    // capability through, and a timeout denies rather than accepts.
    const forced = body.match(/forceInteractive \*\/ true/g) || [];
    expect(forced.length).toBeGreaterThanOrEqual(2);
    // The code-review card must come before anything executes.
    expect(body.indexOf('Review capability code')).toBeLessThan(body.indexOf('Register this capability'));
  });

  it('only the ladder may promote an executable; the review queue never can', () => {
    const chat = read('providers/ChatViewProvider.ts');
    const staging = read('services/SkillStaging.ts');
    // `allowScripts` is the switch, and it is set in exactly one place.
    expect((chat.match(/allowScripts/g) || []).length).toBe(1);
    expect(chat.slice(chat.indexOf('private async _runMystiPublish'))).toContain('allowScripts: true');
    expect(staging).toContain('scripts are not promotable');
  });
});

describe('staging is inert', () => {
  it('the staging directory is not an AgentLoader source', () => {
    const loader = read('managers/AgentLoader.ts');
    expect(loader).not.toContain('skills.staged');
    // The loader's only workspace source is `.mysti/agents`.
    expect(loader).toContain("'.mysti', 'agents'");
  });

  it('the staging path is writable while the live tree is not', () => {
    expect(protectedWriteReason(`${SKILL_STAGING_DIR}/x/SKILL.md`)).toBeNull();
    expect(protectedWriteReason('.mysti/agents/skills/x/SKILL.md')).toBeTruthy();
  });

  it('staging is checkpointed, so a bad proposal is rewindable', () => {
    const ckpt = read('managers/CheckpointManager.ts');
    expect(ckpt).toContain(SKILL_STAGING_DIR);
    expect(ckpt).toContain('.mysti/agents');
  });
});

describe('the coordinator keeps exactly one write chokepoint', () => {
  it('the protection lives INSIDE resolveWriteTarget, so every caller inherits it', () => {
    // This is the property that matters: not "each write site remembered to
    // check", which drifts, but "there is one resolver and the check is in it".
    const tools = read('services/MystiLocalTools.ts');
    const resolver = tools.slice(tools.indexOf('async resolveWriteTarget'));
    const body = resolver.slice(0, resolver.indexOf('\n  /** read —'));
    expect(body).toContain('protectedWriteReason');
    expect(body).toContain('looksLikeSecret');
  });

  it('the exec path routes write, edit and patch through that resolver', () => {
    const exec = read('services/MystiLocalExec.ts');
    // write(), edit() and applyPatch()'s inner resolver — three call sites.
    expect((exec.match(/resolveWriteTarget/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});
