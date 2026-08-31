/**
 * DeskRedactor + DeskMcpBridge tests (Plan 21, invariants I5/I21).
 *
 * The redactor REFUSES rather than strips. A partially-redacted answer is the
 * "truncation as a flag" failure I21 forbids — the recipient cannot tell what
 * is missing, and a model on the other side reasons over the mutilated
 * document anyway. Refusal is loud, recoverable, and fixes the actual problem
 * (a credential sitting in a shared file).
 */
import { describe, it, expect } from 'vitest';
import {
  refusalResult,
  screen,
  screenCitations,
  screenOutbound,
} from '../../../src/services/desk/DeskRedactor';
import { resolveScope } from '../../../src/services/desk/DeskScope';
import {
  TOOL_PREFIX,
  callTool,
  listTools,
  toMcp,
  verbFromToolName,
} from '../../../src/services/desk/DeskMcpBridge';
import { DeskIndex } from '../../../src/services/desk/DeskIndex';
import type { DeskCallResult, DeskVerb, PeerGrant } from '../../../src/types';

const j = (...p: string[]) => p.join('');
const NOW = 1_800_000_000_000;
const scope = resolveScope({ ceiling: ['*'], share: { allow: ['src'], version: 'v1' } });

describe('screenOutbound — refuses rather than strips', () => {
  it('passes a clean payload through unchanged', () => {
    const result: DeskCallResult = { ok: true, payload: { answer: 'Retries use exponential backoff.' } };
    const out = screenOutbound(result);
    expect(out.ok).toBe(true);
    expect(out.ok && out.result).toBe(result);
  });

  it('refuses a payload carrying a credential', () => {
    const out = screenOutbound({ ok: true, payload: { answer: `the key is ${j('AKIA', 'IOSFODNN7EXAMPLE')}` } });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('secret-detected');
  });

  it('finds a credential nested deep in the payload', () => {
    const out = screenOutbound({
      ok: true,
      payload: { findings: [{ notes: { detail: [`token ${j('ghp_', 'z'.repeat(36))}`] } }] },
    });
    expect(out.ok).toBe(false);
  });

  it('screens object KEYS too, not only values', () => {
    const out = screenOutbound({ ok: true, payload: { [j('AKIA', 'IOSFODNN7EXAMPLE')]: 'value' } });
    expect(out.ok).toBe(false);
  });

  it('does not report the secret it found', () => {
    const secret = j('AKIA', 'IOSFODNN7EXAMPLE');
    const out = screenOutbound({ ok: true, payload: { answer: secret } });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('leaves an already-failed result alone', () => {
    const failed: DeskCallResult = { ok: false, error: 'unknown verb' };
    expect(screenOutbound(failed)).toEqual({ ok: true, result: failed });
  });

  it('tolerates a cyclic-free deep structure without blowing the stack', () => {
    let nested: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 50; i++) { nested = { nested }; }
    expect(screenOutbound({ ok: true, payload: nested }).ok).toBe(true);
  });
});

describe('screenCitations', () => {
  it('accepts citations inside the scope', () => {
    expect(screenCitations([{ path: 'src/billing/retry.ts', startLine: 1, endLine: 9 }], scope)).toBeNull();
  });

  it('refuses a citation pointing outside the scope', () => {
    const out = screenCitations([{ path: 'secrets/keys.ts', startLine: 1, endLine: 2 }], scope);
    expect(out?.ok).toBe(false);
    expect(out && out.ok === false && out.reason).toBe('citation-out-of-scope');
  });

  it('does NOT echo the offending path — that would disclose it', () => {
    const out = screenCitations([{ path: 'secrets/prod-keys.ts', startLine: 1, endLine: 2 }], scope);
    expect(JSON.stringify(out)).not.toContain('prod-keys');
    expect(JSON.stringify(out)).not.toContain('secrets/');
  });

  it('refuses a traversal dressed as a citation', () => {
    expect(screenCitations([{ path: 'src/../.env', startLine: 1, endLine: 1 }], scope)?.ok).toBe(false);
  });

  it('refuses nonsensical line ranges', () => {
    expect(screenCitations([{ path: 'src/a.ts', startLine: 0, endLine: 5 }], scope)?.ok).toBe(false);
    expect(screenCitations([{ path: 'src/a.ts', startLine: 9, endLine: 2 }], scope)?.ok).toBe(false);
    expect(screenCitations([{ path: 'src/a.ts', startLine: 1.5, endLine: 2 }], scope)?.ok).toBe(false);
  });

  it('accepts an empty citation list', () => {
    expect(screenCitations([], scope)).toBeNull();
  });
});

describe('screen + refusalResult', () => {
  it('checks citations before scanning bytes', () => {
    const out = screen(
      { ok: true, payload: { answer: 'clean' } },
      scope,
      [{ path: 'secrets/x.ts', startLine: 1, endLine: 1 }],
    );
    expect(out.ok === false && out.reason).toBe('citation-out-of-scope');
  });

  it('collapses every failure to ONE wire error', () => {
    // An attacker who can tell which detector fired learns the filter's shape
    // and iterates until a payload passes.
    const secret = refusalResult({ ok: false, reason: 'secret-detected', detail: 'x' });
    const citation = refusalResult({ ok: false, reason: 'citation-out-of-scope', detail: 'y' });
    expect(secret).toEqual(citation);
    expect(secret).toEqual({ ok: false, error: 'withheld' });
  });

  it('carries no detail onto the wire', () => {
    const out = refusalResult({ ok: false, reason: 'secret-detected', detail: 'AWS access key id' });
    expect(JSON.stringify(out)).not.toContain('AWS');
  });
});

// ---------------------------------------------------------------------------

const index = DeskIndex.build(scope, {
  paths: ['src/billing/retry.ts'],
  readText: () => 'export const backoffSchedule = [1, 2, 4];\n',
});

function grantOf(verbs: DeskVerb[]): PeerGrant {
  return {
    peerId: 'p_abc', verbs, scope: ['src'], expiresAt: NOW + 60_000,
    budgetUsd: 1, maxCalls: 10, minRetentionClass: 'zero-retention',
  };
}

const ctx = { scope, index, grant: grantOf(['status', 'locate']), status: null, now: NOW };

describe('DeskMcpBridge — discovery is authorization-scoped', () => {
  it('lists only granted, implemented verbs', () => {
    const names = listTools(grantOf(['status', 'locate', 'consult']), NOW).map(t => t.name);
    expect(names.sort()).toEqual([`${TOOL_PREFIX}locate`, `${TOOL_PREFIX}status`]);
  });

  it('lists nothing for an empty grant — ungranted verbs are ABSENT, not refused', () => {
    expect(listTools(grantOf([]), NOW)).toEqual([]);
  });

  it('lists nothing once the grant expires', () => {
    const expired = { ...grantOf(['status']), expiresAt: NOW - 1 };
    expect(listTools(expired, NOW)).toEqual([]);
  });

  it('describes what LEAVES the machine, since that is the reader’s decision', () => {
    const locate = listTools(grantOf(['locate']), NOW)[0];
    expect(locate.description.toLowerCase()).toContain('coordinates');
  });

  it('schemas forbid additional properties', () => {
    for (const tool of listTools(grantOf(['status', 'locate']), NOW)) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('the locate schema says token is a literal, not a pattern', () => {
    const locate = listTools(grantOf(['locate']), NOW)[0];
    const token = locate.inputSchema.properties.token as { description: string };
    expect(token.description.toLowerCase()).toContain('not a pattern');
  });
});

describe('DeskMcpBridge — calling', () => {
  it('serves a granted verb', () => {
    const res = callTool(`${TOOL_PREFIX}locate`, { token: 'backoffSchedule' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('src/billing/retry.ts');
  });

  it('an unknown tool name and an ungranted verb are indistinguishable', () => {
    const unknown = callTool('desk.exec', {}, ctx);
    const ungranted = callTool(`${TOOL_PREFIX}consult`, { question: 'hi' }, ctx);
    expect(unknown).toEqual(ungranted);
    expect(unknown.content[0].text).toBe('unknown verb');
  });

  it('refuses a name outside our namespace', () => {
    expect(callTool('some.other.tool', {}, ctx).isError).toBe(true);
    expect(callTool(42, {}, ctx).isError).toBe(true);
    expect(callTool(null, {}, ctx).isError).toBe(true);
  });

  it('verbFromToolName strips only our prefix', () => {
    expect(verbFromToolName('desk.locate')).toBe('locate');
    expect(verbFromToolName('locate')).toBeNull();
    expect(verbFromToolName('other.locate')).toBeNull();
  });

  it('serializes deterministically, so a response can be cache-keyed', () => {
    const a = toMcp({ ok: true, payload: { b: 1, a: [2, { d: 3, c: 4 }] } });
    const b = toMcp({ ok: true, payload: { a: [2, { c: 4, d: 3 }], b: 1 } });
    expect(a.content[0].text).toBe(b.content[0].text);
  });

  it('marks a failed result as an error', () => {
    const res = toMcp({ ok: false, error: 'withheld' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('withheld');
  });
});
