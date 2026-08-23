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
  it('no directive kind can promote', () => {
    const every = [...ALL_MYSTI_KINDS, ...MYSTI_SKILL_KINDS, ...MYSTI_EXEC_KINDS, ...MYSTI_MCP_KINDS];
    for (const kind of every) {
      expect(kind).not.toMatch(/promot|install|publish/i);
    }
  });

  it('no native tool schema can promote, in any capability combination', () => {
    const names = new Set<string>();
    for (const exec of [false, true]) {
      for (const skills of [false, true]) {
        for (const connect of [false, true]) {
          for (const t of coordinatorToolSchemas(exec, [], connect, { look: true, act: true }, true, skills)) {
            names.add(t.function.name);
          }
        }
      }
    }
    for (const name of names) {
      expect(name, `tool "${name}" looks like a promotion path`).not.toMatch(/promot|install|publish/i);
    }
    // Sanity: the sweep really did enumerate the catalog tools.
    expect(names.has('skill_find')).toBe(true);
  });

  it('SkillStaging.promote is called only from the user command, never from the agentic loop', () => {
    const chat = read('providers/ChatViewProvider.ts');
    const callSites = chat.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(l => /\.promote\(/.test(l.line));
    expect(callSites.length).toBe(1);

    // …and that one call site sits inside the review command, not the loop.
    const idx = chat.indexOf('.promote(');
    const before = chat.slice(0, idx);
    const enclosing = before.lastIndexOf('public async reviewSkillProposals');
    const loopStart = before.lastIndexOf('_runMystiAgentic');
    expect(enclosing).toBeGreaterThan(loopStart);
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
