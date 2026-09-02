/**
 * DeskServingGate tests (Plan 21 Phase 4, invariant I7).
 *
 * The properties under test are the ones an attacker attacks, not the ones a
 * happy path exercises:
 *
 *   - EXTENSION-COMPUTED. The byte count and the digest are measured from the
 *     real payload. A caller cannot assert them, and a hand-built block that
 *     describes a different payload cannot be used to approve this one — that
 *     is the whole consent-laundering kill (review finding P1-6/P2-6).
 *   - NEVER TRUNCATED. Every over-cap path must REFUSE, and must refuse
 *     BEFORE raising a card, so there is no state in which a human approved a
 *     prefix. Several tests assert `confirm` was never called at all, because
 *     "we showed them something" is the failure mode.
 *   - CLOSED SHAPES. Verb, retention class, alias, fingerprint, path and scan
 *     verdict are each checked against a closed set at BOTH the build and the
 *     render boundary, because `EffectBlock` is a plain interface that
 *     anything can construct.
 *   - TWO DECISIONS. Approving spend never approves disclosure. There is no
 *     cached decision, and the spend card never carries a draft.
 *   - FAIL CLOSED. A non-`true` answer, a throwing `confirm`, a throwing audit
 *     sink and a NaN limit each resolve to "denied", never to "approved".
 *
 * Every security-relevant branch here goes red if its branch is deleted; the
 * report for this module records which deletions were actually run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import {
  DeskServingGate,
  EffectBlockError,
  GATE_LIMIT_CEILINGS,
  GATE_LIMIT_DEFAULTS,
  MAX_EFFECT_PATHS,
  MAX_RENDER_CHARS,
  NOT_APPLICABLE,
  SPEND_VERB,
  buildEffectBlock,
  renderEffectBlock,
} from '../../src/managers/DeskServingGate';
import type {
  EffectBlock,
  EffectBlockInput,
  GateDeps,
  GateRefusalReason,
} from '../../src/managers/DeskServingGate';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE: EffectBlockInput = Object.freeze({
  verb: 'consult',
  peerAlias: 'alice',
  fingerprint: 'p_3x8v.1m5c',
  transport: 'https://alice.ts.net:18790',
  payload: 'The webhook dedupes on the Stripe event id before it writes.',
  citedPaths: ['src/billing/webhook.ts', 'src/billing/retry.ts'],
  modelId: 'anthropic/claude-sonnet-4.6',
  retentionClass: 'zero-retention',
});

/** A live-looking GitHub token, used to prove the scanner is wired in. */
const FAKE_GH_TOKEN = 'ghp_' + 'aB3xQ7'.repeat(6);
/** A live-looking Stripe key, distinct shape from the one above. */
const FAKE_STRIPE_KEY = 'sk_live_' + 'Kd82nQx7Zp13Mv04Rt6y';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Exactly `GATE_LIMIT_CEILINGS.maxDraftBytes` ASCII bytes. */
function draftOfCeilingSize(): string {
  const unit = 'abcdefghi ';
  const whole = Math.floor(GATE_LIMIT_CEILINGS.maxDraftBytes / unit.length);
  const s = unit.repeat(whole) + 'z'.repeat(GATE_LIMIT_CEILINGS.maxDraftBytes - whole * unit.length);
  expect(Buffer.byteLength(s, 'utf8')).toBe(GATE_LIMIT_CEILINGS.maxDraftBytes);
  return s;
}

interface Harness {
  gate: DeskServingGate;
  calls: Array<{ title: string; body: string; effect: EffectBlock }>;
  refusals: Array<{ reason: GateRefusalReason; detail: string }>;
  answer: (a: unknown) => void;
  throwOnConfirm: (e: Error) => void;
}

function harness(opts?: Partial<{ maxDraftBytes: number; maxQuestionChars: number }>): Harness {
  const calls: Harness['calls'] = [];
  const refusals: Harness['refusals'] = [];
  let answer: unknown = true;
  let thrown: Error | null = null;
  const deps: GateDeps = {
    confirmIsForcedInteractive: true,
    confirm: async (title, body, effect) => {
      calls.push({ title, body, effect });
      if (thrown) { throw thrown; }
      return answer as boolean;
    },
    onRefusal: (reason, detail) => { refusals.push({ reason, detail }); },
  };
  return {
    gate: new DeskServingGate(deps, opts),
    calls,
    refusals,
    answer: (a: unknown) => { answer = a; },
    throwOnConfirm: (e: Error) => { thrown = e; },
  };
}

/** Assert a call throws EffectBlockError with a specific reason. */
function expectRefusal(fn: () => unknown, reason: GateRefusalReason): EffectBlockError {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(EffectBlockError);
  const err = caught as EffectBlockError;
  expect(err.reason).toBe(reason);
  return err;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ });
});

// ---------------------------------------------------------------------------
// buildEffectBlock — extension-computed
// ---------------------------------------------------------------------------

describe('buildEffectBlock — the numbers are measured, never asserted', () => {
  it('derives totalBytes and sha256 from the real payload, including multi-byte text', () => {
    const payload = 'caf\u00e9 \u00fcber \u65e5\u672c\u8a9e';
    const block = buildEffectBlock({ ...BASE, payload });
    expect(block.totalBytes).toBe(Buffer.byteLength(payload, 'utf8'));
    expect(block.totalBytes).toBeGreaterThan(payload.length); // multi-byte, so bytes > chars
    expect(block.sha256).toBe(sha256(payload));
  });

  it('ignores a caller-supplied totalBytes/sha256 — there is no channel for a claim', () => {
    const lie = { ...BASE, totalBytes: 7, sha256: '0'.repeat(64) } as unknown as EffectBlockInput;
    const block = buildEffectBlock(lie);
    expect(block.totalBytes).toBe(Buffer.byteLength(BASE.payload, 'utf8'));
    expect(block.sha256).toBe(sha256(BASE.payload));
  });

  it('reports cited paths as zero CONTENT bytes, so the card cannot imply file content crossed', () => {
    const block = buildEffectBlock(BASE);
    expect(block.paths.map(p => p.bytes)).toEqual([0, 0]);
    expect(renderEffectBlock(block)).toContain('(0 content bytes)');
  });

  it('renders a 4 MB payload IN FULL — the block scales with path count, never with payload size', () => {
    const payload = draftOfCeilingSize();
    const block = buildEffectBlock({ ...BASE, payload });
    const rendered = renderEffectBlock(block);
    expect(block.totalBytes).toBe(GATE_LIMIT_CEILINGS.maxDraftBytes);
    expect(rendered).toContain(String(GATE_LIMIT_CEILINGS.maxDraftBytes));
    expect(rendered).toContain(sha256(payload));
    // Nothing about the block was elided to make it fit.
    expect(rendered.length).toBeLessThan(MAX_RENDER_CHARS);
  });
});

// ---------------------------------------------------------------------------
// buildEffectBlock — closed shapes
// ---------------------------------------------------------------------------

describe('buildEffectBlock — every field is a closed shape', () => {
  it.each([
    ['bash'],
    ['delegate'],
    ['consult (answer)'],
    ['CONSULT'],
    ['hello'],
  ])('refuses verb %j', (verb) => {
    expectRefusal(() => buildEffectBlock({ ...BASE, verb }), 'invalid-field');
  });

  it('accepts every real Desk verb plus the spend pseudo-verb', () => {
    for (const verb of ['status', 'locate', 'consult', 'review', 'handoff', 'assign', 'followup', SPEND_VERB]) {
      expect(buildEffectBlock({ ...BASE, verb }).verb).toBe(verb);
    }
  });

  it.each([
    ['Alice'],            // uppercase: not the local-alias form
    ['al ice'],           // space
    ['-alice'],           // leading dash
    [''],
    ['a'.repeat(33)],
    ['../alice'],
  ])('refuses peerAlias %j — the alias is the only rendered name (I12)', (peerAlias) => {
    expectRefusal(() => buildEffectBlock({ ...BASE, peerAlias }), 'invalid-field');
  });

  it.each([
    ['zero-retention (per our policy)'],
    ['zero retention'],
    ['unknown'],
    ['ZERO-RETENTION'],
  ])('refuses retentionClass %j — a reader must not be the parser (I9)', (retentionClass) => {
    expectRefusal(() => buildEffectBlock({ ...BASE, retentionClass }), 'invalid-field');
  });

  it.each([
    ['ab'],                         // too short
    ['p_3x8v 1m5c'],                // space is outside the fingerprint charset
    ['p_3x8v/1m5c'],                // slash
    ['p_' + 'a'.repeat(200)],       // over cap
  ])('refuses fingerprint %j', (fingerprint) => {
    expectRefusal(() => buildEffectBlock({ ...BASE, fingerprint }), 'invalid-field');
  });

  it.each([
    ['https://a.b\u00a0c'],   // NBSP
    ['https://a.b\u2028c'],   // line separator
    ['https://a.b\u3000c'],   // ideographic space
  ])('refuses non-plain whitespace in a field: %j', (transport) => {
    expectRefusal(() => buildEffectBlock({ ...BASE, transport }), 'invalid-field');
  });

  it.each([
    [' https://a.b'],
    ['https://a.b '],
    ['https://a.b  c'],
  ])('refuses leading, trailing or doubled spaces: %j', (transport) => {
    expectRefusal(() => buildEffectBlock({ ...BASE, transport }), 'invalid-field');
  });

  it('refuses a bidi override in a field — trojan-source in a roster is real', () => {
    expectRefusal(
      () => buildEffectBlock({ ...BASE, modelId: 'anthropic/\u202Etpurroc' }),
      'invalid-field');
  });

  it('refuses an interlinear annotation mark, which hasUnsafeChars alone does not catch', () => {
    expectRefusal(
      () => buildEffectBlock({ ...BASE, modelId: 'model\uFFFAspoof' }),
      'invalid-field');
  });

  it('refuses a non-string payload rather than stringifying it', () => {
    expectRefusal(
      () => buildEffectBlock({ ...BASE, payload: { toString: () => 'x' } as unknown as string }),
      'invalid-field');
  });
});

// ---------------------------------------------------------------------------
// buildEffectBlock — paths
// ---------------------------------------------------------------------------

describe('buildEffectBlock — cited paths', () => {
  it.each([
    ['../../etc/passwd'],
    ['/etc/passwd'],
    ['src\\billing\\a.ts'],
    ['C:/src/a.ts'],
    ['src/./a.ts'],
    ['src/\u202Egnp.js'],       // bidi
    ['src/a\u200Bb.ts'],        // zero-width
    ['src/a\nb.ts'],            // newline: would forge a row in the block
    [''],
  ])('refuses citedPath %j', (p) => {
    expectRefusal(() => buildEffectBlock({ ...BASE, citedPaths: [p] }), 'invalid-path');
  });

  it.each([
    ['src/a  b.ts'],
    [' src/a.ts'],
    ['src/a.ts '],
    ['src/a\u00a0b.ts'],
  ])('refuses whitespace-ambiguous citedPath %j rather than collapsing it', (p) => {
    expectRefusal(() => buildEffectBlock({ ...BASE, citedPaths: [p] }), 'invalid-path');
  });

  it('refuses a duplicate citation instead of silently de-duplicating it', () => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, citedPaths: ['src/a.ts', 'src/a.ts'] }),
      'invalid-path');
    // The BUILD boundary's own message. The render boundary refuses duplicates
    // too and says something different, so this assertion pins this guard
    // rather than being satisfied by the render-proof behind it.
    expect(err.message).toBe('citedPaths lists "src/a.ts" twice');
  });

  it('refuses more than MAX_EFFECT_PATHS citations — refused, never clipped', () => {
    const many = Array.from({ length: MAX_EFFECT_PATHS + 1 }, (_, i) => `src/f${i}.ts`);
    const err = expectRefusal(() => buildEffectBlock({ ...BASE, citedPaths: many }), 'unrenderable');
    expect(err.message).toContain('not truncated');
    // Refused on the COUNT, before 201 paths were validated and scanned — the
    // render-proof would also catch this, but only after doing all that work.
    expect(err.message).toContain('cited paths exceeds');
  });

  it('refuses when the complete block would exceed the render cap', () => {
    // Inside the path-count cap, but the full enumeration does not fit.
    const long = Array.from({ length: MAX_EFFECT_PATHS }, (_, i) =>
      `src/${'d'.repeat(370)}/f${i}.ts`);
    const err = expectRefusal(() => buildEffectBlock({ ...BASE, citedPaths: long }), 'unrenderable');
    expect(err.message).toContain('not truncated');
  });

  it('refuses a credential-shaped citation, and does not echo the offending path', () => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, citedPaths: [`secrets/${FAKE_GH_TOKEN}.txt`] }),
      'path-scan-blocked');
    expect(err.message).not.toContain(FAKE_GH_TOKEN);
  });

  it('still RENDERS a blocked verdict assembled elsewhere — render and gate have separate jobs', () => {
    const block: EffectBlock = {
      ...buildEffectBlock(BASE),
      paths: [{ path: 'src/a.ts', bytes: 12, scan: 'blocked' }],
    };
    expect(renderEffectBlock(block)).toContain('scan blocked');
  });

  it('marks an ordinary path clean', () => {
    expect(buildEffectBlock(BASE).paths.every(p => p.scan === 'clean')).toBe(true);
  });

  // A STRING citedPaths is the case the Array.isArray guard exists for: without
  // it the string is iterated PER CHARACTER, and a fixture like 'src/a.ts'
  // refuses for an unrelated reason (validatePath rejects the '/' character as
  // an absolute path), leaving the guard's deletion invisible. 'abc' iterates
  // into three individually VALID one-character citations, so only the guard
  // itself can refuse it — and the exact message is asserted so a refusal from
  // anywhere else cannot stand in for it.
  it('refuses a string citedPaths whose characters would each validate', () => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, citedPaths: 'abc' as unknown as string[] }),
      'invalid-path');
    expect(err.message).toBe('citedPaths must be an array');
  });

  it('refuses a non-iterable citedPaths with a refusal, not a raw TypeError', () => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, citedPaths: { 0: 'a', length: 1 } as unknown as string[] }),
      'invalid-path');
    expect(err.message).toBe('citedPaths must be an array');
  });

  it('accepts an empty citation list', () => {
    expect(buildEffectBlock({ ...BASE, citedPaths: [] }).paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Secrets in the decision-bearing half itself
// ---------------------------------------------------------------------------

describe('the effect block may not itself disclose a credential', () => {
  it('refuses a transport carrying a query-string credential', () => {
    expectRefusal(
      () => buildEffectBlock({ ...BASE, transport: `https://alice.ts.net/?t=${FAKE_STRIPE_KEY}` }),
      'secret-in-effect-block');
  });

  it('refuses a model id someone pasted a key into', () => {
    expectRefusal(
      () => buildEffectBlock({ ...BASE, modelId: `openrouter/${FAKE_GH_TOKEN}` }),
      'secret-in-effect-block');
  });
});

// ---------------------------------------------------------------------------
// renderEffectBlock — the render boundary re-validates everything
// ---------------------------------------------------------------------------

describe('renderEffectBlock', () => {
  it('prints the digest in full — an abbreviated hash is not a hash', () => {
    const block = buildEffectBlock(BASE);
    const rendered = renderEffectBlock(block);
    expect(rendered).toContain(block.sha256);
    expect(block.sha256).toHaveLength(64);
    expect(rendered).not.toContain('\u2026');
    expect(rendered).not.toContain('...');
  });

  it('renders in a fixed order with every field present', () => {
    const rendered = renderEffectBlock(buildEffectBlock(BASE));
    const order = ['EFFECT', 'verb', 'to', 'key', 'over', 'model', 'retention', 'bytes', 'sha256', 'cites'];
    let at = -1;
    for (const label of order) {
      const next = rendered.indexOf(label, at + 1);
      expect(next, `missing or out-of-order: ${label}`).toBeGreaterThan(at);
      at = next;
    }
  });

  it('escapes markup characters in a path', () => {
    const block = buildEffectBlock({ ...BASE, citedPaths: ['src/a<img src=x>&"b.ts'] });
    const rendered = renderEffectBlock(block);
    expect(rendered).not.toContain('<');
    expect(rendered).toContain('&lt;img');
    expect(rendered).toContain('&amp;');
  });

  it('re-validates a hand-built block: a newline in a path cannot forge a row', () => {
    const block: EffectBlock = {
      ...buildEffectBlock(BASE),
      paths: [{ path: 'src/a.ts\n  verb        status', bytes: 0, scan: 'clean' }],
    };
    expectRefusal(() => renderEffectBlock(block), 'invalid-path');
  });

  it.each([
    [{ bytes: -1 }],
    [{ bytes: 1.5 }],
    [{ bytes: Number.NaN }],
    [{ bytes: Number.POSITIVE_INFINITY }],
  ])('re-validates a hand-built path byte count: %j', (patch) => {
    const base = buildEffectBlock(BASE);
    const block: EffectBlock = {
      ...base,
      paths: [{ path: 'src/a.ts', bytes: 0, scan: 'clean', ...patch } as EffectBlock['paths'][0]],
    };
    expectRefusal(() => renderEffectBlock(block), 'invalid-path');
  });

  it('re-validates a hand-built scan verdict', () => {
    const base = buildEffectBlock(BASE);
    const block: EffectBlock = {
      ...base,
      paths: [{ path: 'src/a.ts', bytes: 0, scan: 'ok' as unknown as 'clean' }],
    };
    expectRefusal(() => renderEffectBlock(block), 'invalid-path');
  });

  it.each([
    ['A'.repeat(64)],       // uppercase hex
    ['0'.repeat(63)],       // short
    ['0'.repeat(65)],       // long
    ['not-a-digest'],
  ])('re-validates a hand-built sha256: %j', (sha) => {
    const block: EffectBlock = { ...buildEffectBlock(BASE), sha256: sha };
    expectRefusal(() => renderEffectBlock(block), 'invalid-field');
  });

  it.each([
    [-1],
    [1.5],
    [Number.NaN],
  ])('re-validates a hand-built totalBytes: %j', (totalBytes) => {
    const block: EffectBlock = { ...buildEffectBlock(BASE), totalBytes };
    expectRefusal(() => renderEffectBlock(block), 'invalid-field');
  });

  it('refuses a hand-built block carrying more paths than the cap', () => {
    const block: EffectBlock = {
      ...buildEffectBlock(BASE),
      paths: Array.from({ length: MAX_EFFECT_PATHS + 1 }, (_, i) => ({
        path: `src/f${i}.ts`, bytes: 0, scan: 'clean' as const,
      })),
    };
    expectRefusal(() => renderEffectBlock(block), 'unrenderable');
  });

  it('refuses a hand-built block with a forged verb or retention class', () => {
    const base = buildEffectBlock(BASE);
    expectRefusal(() => renderEffectBlock({ ...base, verb: 'bash' }), 'invalid-field');
    expectRefusal(
      () => renderEffectBlock({ ...base, retentionClass: 'zero-retention*' }), 'invalid-field');
  });
});

// ---------------------------------------------------------------------------
// Gate 1 — spend
// ---------------------------------------------------------------------------

describe('askSpend — gate 1', () => {
  it('raises exactly one card and returns the human decision', async () => {
    const h = harness();
    await expect(h.gate.askSpend('alice', 'Why does the retry loop stall?', 0.004)).resolves.toBe(true);
    expect(h.calls).toHaveLength(1);
    h.answer(false);
    await expect(h.gate.askSpend('alice', 'Why does the retry loop stall?', 0.004)).resolves.toBe(false);
    expect(h.calls).toHaveLength(2);
  });

  it('carries the COMPLETE question and no draft', async () => {
    const h = harness();
    const question = 'Q'.repeat(GATE_LIMIT_DEFAULTS.maxQuestionChars);
    await h.gate.askSpend('alice', question, 0.004);
    expect(h.calls[0].body).toContain(question);
    expect(h.calls[0].body).not.toContain('CONTENT (');
  });

  it('describes the inbound question, not an outbound payload', async () => {
    const h = harness();
    await h.gate.askSpend('alice', 'hello?', 0.004);
    const effect = h.calls[0].effect;
    expect(effect.verb).toBe(SPEND_VERB);
    expect(effect.paths).toEqual([]);
    expect(effect.fingerprint).toBe(NOT_APPLICABLE);
    expect(effect.transport).toBe(NOT_APPLICABLE);
    expect(effect.sha256).toBe(sha256('hello?'));
  });

  it('names the serving model when the callee has resolved one (I9)', async () => {
    const h = harness();
    await h.gate.askSpend('alice', 'hello?', 0.004,
      { modelId: 'anthropic/claude-sonnet-4.6', retentionClass: 'zero-retention' });
    expect(h.calls[0].body).toContain('anthropic/claude-sonnet-4.6');
    expect(h.calls[0].body).toContain('zero-retention');
  });

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
    [-0.01],
    [1e9],
    ['0.004' as unknown as number],
    [undefined as unknown as number],
  ])('refuses estimate %j without raising a card', async (estimateUsd) => {
    const h = harness();
    await expect(h.gate.askSpend('alice', 'hello?', estimateUsd)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-estimate');
  });

  it('rounds the estimate UP, so the card never understates the cost', async () => {
    const h = harness();
    await h.gate.askSpend('alice', 'hello?', 0.00001);
    expect(h.calls[0].title).toContain('$0.0001');
  });

  it('refuses an over-cap question without raising a card and without a prefix', async () => {
    const h = harness();
    const question = 'Q'.repeat(GATE_LIMIT_DEFAULTS.maxQuestionChars + 1);
    await expect(h.gate.askSpend('alice', question, 0.004)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('payload-too-large');
    expect(h.refusals[0].detail).toContain('not truncated');
  });

  it.each([
    ['a bidi override \u202E'],
    ['a zero-width \u200B space'],
    ['a control \u0007 char'],
    ['   '],
  ])('refuses hostile question %j', async (question) => {
    const h = harness();
    await expect(h.gate.askSpend('alice', question, 0.004)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses an alias that is not the local-alias form', async () => {
    const h = harness();
    await expect(h.gate.askSpend('Alice', 'hello?', 0.004)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('escapes the question in the card body', async () => {
    const h = harness();
    await h.gate.askSpend('alice', 'why does <script>alert(1)</script> run?', 0.004);
    expect(h.calls[0].body).not.toContain('<script>');
    expect(h.calls[0].body).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — disclosure
// ---------------------------------------------------------------------------

describe('askDisclosure — gate 2', () => {
  it('shows the COMPLETE draft and returns the human decision', async () => {
    const h = harness();
    const draft = 'x'.repeat(50_000) + ' TAIL-MARKER';
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body).toContain('TAIL-MARKER');
    expect(h.calls[0].body.length).toBeGreaterThanOrEqual(draft.length);
    // Deep-equal, deliberately NOT identical: the sink is handed a frozen copy
    // built from the validated values, never the caller's object.
    expect(h.calls[0].effect).toEqual(block);
    expect(h.calls[0].effect).not.toBe(block);
    expect(Object.isFrozen(h.calls[0].effect)).toBe(true);
  });

  it('refuses a block that describes a DIFFERENT payload — the laundering kill', async () => {
    const h = harness();
    const block = buildEffectBlock({ ...BASE, payload: 'a short, harmless summary' });
    await expect(h.gate.askDisclosure(block, 'the actual, much larger artifact')).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('effect-block-mismatch');
  });

  it('refuses a same-length payload with a different digest', async () => {
    const h = harness();
    const block = buildEffectBlock({ ...BASE, payload: 'A'.repeat(100) });
    await expect(h.gate.askDisclosure(block, 'B'.repeat(100))).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('effect-block-mismatch');
  });

  it('refuses a block whose totalBytes was tampered with after the build', async () => {
    const h = harness();
    const draft = 'the answer';
    const block = { ...buildEffectBlock({ ...BASE, payload: draft }), totalBytes: 5 };
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('effect-block-mismatch');
  });

  it('counts BYTES, not characters, when binding the draft to the block', async () => {
    const h = harness();
    const draft = '\u65e5\u672c\u8a9e'.repeat(10); // 30 chars, 90 bytes
    const block = buildEffectBlock({ ...BASE, payload: draft });
    expect(block.totalBytes).toBe(90);
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(true);
    await expect(h.gate.askDisclosure({ ...block, totalBytes: 30 }, draft)).resolves.toBe(false);
  });

  it('refuses a draft carrying credential material WITHOUT asking a human (I5)', async () => {
    const h = harness();
    const draft = `The retry helper reads STRIPE_KEY = "${FAKE_STRIPE_KEY}" at boot.`;
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('secret-in-payload');
  });

  it('refuses a block carrying a blocked path verdict it did not build itself', async () => {
    const h = harness();
    const draft = 'see the file';
    // Defence in depth: `buildEffectBlock` refuses a credential-shaped path
    // outright, so the only way a 'blocked' entry reaches this gate is a block
    // assembled elsewhere — which is exactly the case worth testing.
    const block: EffectBlock = {
      ...buildEffectBlock({ ...BASE, payload: draft, citedPaths: ['src/a.ts'] }),
      paths: [{ path: 'src/a.ts', bytes: 0, scan: 'blocked' }],
    };
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('path-scan-blocked');
  });

  it.each([
    ['a zero-width \u200B marker'],
    ['a bidi \u202E override'],
    ['a control \u0000 byte'],
  ])('refuses a draft containing %j', async (draft) => {
    const h = harness();
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a 4 MB draft at the default cap, and never raises a clipped card', async () => {
    const h = harness();
    const draft = draftOfCeilingSize();
    const block = buildEffectBlock({ ...BASE, payload: draft });
    expect(Buffer.byteLength(draft, 'utf8')).toBeGreaterThan(GATE_LIMIT_DEFAULTS.maxDraftBytes);
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('payload-too-large');
    expect(h.refusals[0].detail).toContain('not truncated');
  });

  it('renders a 4 MB draft IN FULL when the cap allows it — the other half of "never clipped"', async () => {
    const h = harness({ maxDraftBytes: GATE_LIMIT_CEILINGS.maxDraftBytes });
    const draft = draftOfCeilingSize();
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.length).toBeGreaterThanOrEqual(draft.length);
    expect(h.calls[0].body.endsWith(draft.slice(-64))).toBe(true);
  });

  it('caps the draft in BYTES, so a multi-byte draft cannot slip under a character cap', async () => {
    const h = harness({ maxDraftBytes: 16 });
    const draft = '\u65e5'.repeat(6); // 6 characters, 18 bytes
    expect(draft.length).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(draft, 'utf8')).toBeGreaterThan(16);
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('payload-too-large');
    expect(h.refusals[0].detail).toContain('bytes, cap is');
  });

  // Pinned by MESSAGE, not by `false`. Asserting only the resolved value was
  // vacuous: delete `typeof draft !== 'string'` and Buffer.byteLength(undefined)
  // throws a TypeError that also resolves false — the test could not tell the
  // guard from the crash. A Buffer draft is included because it is the one
  // non-string that would otherwise survive as far as requireProse.
  it.each([
    [undefined],
    [null],
    [123],
    [{ toString: () => 'the answer' }],
    [Buffer.from('the answer', 'utf8')],
  ])('refuses a non-string draft (%j) at the guard, not at a later crash', async (draft) => {
    const h = harness();
    const block = buildEffectBlock({ ...BASE, payload: 'the answer' });
    await expect(h.gate.askDisclosure(block, draft as unknown as string)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-field');
    expect(h.refusals[0].detail).toBe('draft must be a string');
  });

  // The digest SHAPE guard, pinned by its message. Asserting only the reason was
  // vacuous: delete the guard and Buffer.from('nope','hex') yields a 0-byte
  // buffer, crypto.timingSafeEqual throws a RangeError, and the catch-all filed
  // it under the very reason the test asserted — a crash wearing a control's
  // name. It is now filed as 'internal-error', so the two cannot be confused.
  it.each([
    ['nope'],
    ['A'.repeat(64)],
    ['0'.repeat(63)],
    ['0'.repeat(65)],
  ])('refuses a block whose digest is malformed (%j), as a control and not a crash', async (sha256) => {
    const h = harness();
    const draft = 'the answer';
    const block = { ...buildEffectBlock({ ...BASE, payload: draft }), sha256 };
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-field');
    expect(h.refusals[0].detail).toBe('sha256 must be 64 lowercase hex chars');
  });

  it('escapes the draft in the card body', async () => {
    const h = harness();
    const draft = 'ship <img src=x onerror=alert(1)> now';
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await h.gate.askDisclosure(block, draft);
    expect(h.calls[0].body).not.toContain('<img');
    expect(h.calls[0].body).toContain('&lt;img');
  });

  it('builds its title from validated fields only, so it cannot be steered', async () => {
    const h = harness();
    const draft = 'the answer';
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await h.gate.askDisclosure(block, draft);
    expect(h.calls[0].title).toBe('Send a consult answer to "alice"?');
  });
});

// ---------------------------------------------------------------------------
// The two gates are two decisions
// ---------------------------------------------------------------------------

describe('spend and disclosure are never collapsed', () => {
  it('approving the spend does not approve the disclosure', async () => {
    const h = harness();
    await expect(h.gate.askSpend('alice', 'why does it stall?', 0.004)).resolves.toBe(true);
    expect(h.calls).toHaveLength(1);

    const draft = 'because the lock is held across the await';
    const block = buildEffectBlock({ ...BASE, payload: draft });
    h.answer(false);
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    // A second, independent card was raised for the disclosure.
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].effect.verb).toBe(SPEND_VERB);
    expect(h.calls[1].effect.verb).toBe('consult');
    expect(h.calls[0].body).not.toContain(draft);
  });

  it('a denied spend leaves no state that could satisfy a later disclosure', async () => {
    const h = harness();
    h.answer(false);
    await expect(h.gate.askSpend('alice', 'why?', 0.004)).resolves.toBe(false);
    const draft = 'the answer';
    const block = buildEffectBlock({ ...BASE, payload: draft });
    h.answer(true);
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(true);
    expect(h.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed plumbing
// ---------------------------------------------------------------------------

describe('fail closed', () => {
  it.each([
    ['yes'],
    [1],
    [{}],
    [undefined],
    [null],
  ])('treats a non-true confirm answer (%j) as denied', async (answer) => {
    const h = harness();
    h.answer(answer);
    await expect(h.gate.askSpend('alice', 'why?', 0.004)).resolves.toBe(false);
  });

  it('treats a throwing confirm as denied, and records why', async () => {
    const h = harness();
    h.throwOnConfirm(new Error('webview disposed'));
    await expect(h.gate.askSpend('alice', 'why?', 0.004)).resolves.toBe(false);
    expect(h.refusals.at(-1)?.reason).toBe('confirm-failed');
  });

  it('does not let a throwing audit sink turn a refusal into an approval', async () => {
    const gate = new DeskServingGate({
      confirm: async () => true,
      confirmIsForcedInteractive: true,
      onRefusal: () => { throw new Error('audit store is full'); },
    });
    await expect(gate.askSpend('alice', 'why?', Number.NaN)).resolves.toBe(false);
  });

  it('refuses to construct without a confirm dependency', () => {
    expect(() => new DeskServingGate({} as unknown as GateDeps)).toThrow(/confirm/);
    expect(() => new DeskServingGate(null as unknown as GateDeps)).toThrow(/confirm/);
  });

  it('distinguishes a control refusal from a human clicking Deny', async () => {
    const h = harness();
    h.answer(false);
    await h.gate.askSpend('alice', 'why?', 0.004);
    expect(h.refusals).toHaveLength(0); // a Deny is a decision, not a refusal

    await h.gate.askSpend('alice', 'why?', Number.NaN);
    expect(h.refusals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Limit resolution — the explicit-undefined / NaN hazard
// ---------------------------------------------------------------------------

describe('constructor limits are resolved individually, never spread', () => {
  it('keeps the default when an option is explicitly undefined (what cfg.get returns)', () => {
    const gate = new DeskServingGate(
      { confirm: async () => true, confirmIsForcedInteractive: true },
      { maxDraftBytes: undefined, maxQuestionChars: undefined });
    expect(gate.limits).toEqual(GATE_LIMIT_DEFAULTS);
  });

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
    ['1048576' as unknown as number],
    [null as unknown as number],
    [GATE_LIMIT_CEILINGS.maxDraftBytes + 1],
    [1e12],
  ])('falls back to the default for an unusable or above-ceiling maxDraftBytes %j', (maxDraftBytes) => {
    const gate = new DeskServingGate({ confirm: async () => true, confirmIsForcedInteractive: true }, { maxDraftBytes });
    expect(gate.limits.maxDraftBytes).toBe(GATE_LIMIT_DEFAULTS.maxDraftBytes);
  });

  // Direction matters. "A caller may lower, never raise" has to hold for the
  // confused caller too: 0 and every negative mean "allow nothing", and the
  // old fallback answered them with 1 MiB — more authority than was asked for,
  // from the branch whose comment forbids exactly that.
  it.each([
    [0],
    [-1],
    [-1e9],
  ])('clamps a below-floor maxDraftBytes %j DOWN to the floor, never up to the default', (maxDraftBytes) => {
    const gate = new DeskServingGate({ confirm: async () => true, confirmIsForcedInteractive: true }, { maxDraftBytes });
    expect(gate.limits.maxDraftBytes).toBe(1);
  });

  it('a zero draft cap allows nothing, rather than silently allowing 1 MiB', async () => {
    const h = harness({ maxDraftBytes: 0 });
    const draft = 'no';
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('payload-too-large');
  });

  it('a NaN limit still LIMITS — the cap does not silently stop capping', async () => {
    const h = harness({ maxDraftBytes: Number.NaN });
    const draft = draftOfCeilingSize();
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('payload-too-large');
  });

  it('honours a LOWERED limit', async () => {
    const h = harness({ maxDraftBytes: 16 });
    expect(h.gate.limits.maxDraftBytes).toBe(16);
    const draft = 'x'.repeat(17);
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('floors a fractional limit rather than carrying it into a comparison', () => {
    const gate = new DeskServingGate({ confirm: async () => true, confirmIsForcedInteractive: true }, { maxDraftBytes: 1234.9 });
    expect(gate.limits.maxDraftBytes).toBe(1234);
  });

  it('exposes a copy of its limits, not the live object', () => {
    const gate = new DeskServingGate({ confirm: async () => true, confirmIsForcedInteractive: true });
    const limits = gate.limits as { maxDraftBytes: number };
    limits.maxDraftBytes = 1;
    expect(gate.limits.maxDraftBytes).toBe(GATE_LIMIT_DEFAULTS.maxDraftBytes);
  });
});

// ---------------------------------------------------------------------------
// The block scan reads the PLAIN text, not the escaped text
// ---------------------------------------------------------------------------

/**
 * A secret-shaped assignment. Only the scanner's QUOTE-delimited detector sees
 * this shape — there is no vendor prefix to fall back on — so it is the exact
 * probe for whether the effect block is scanned before or after escaping.
 */
const QUOTED_SECRET = 'token="Kd82nQx7Zp13Mv04Rt6y"';

describe('the effect-block egress scan is not defeated by its own escaping', () => {
  it('sees the assignment on its own (the detector is live)', () => {
    // Establishes the premise: if this ever stops blocking, the tests below
    // would pass for the wrong reason.
    expect(() => buildEffectBlock({ ...BASE, payload: QUOTED_SECRET })).not.toThrow();
    expectRefusal(
      () => buildEffectBlock({ ...BASE, transport: `https://a.b/?${QUOTED_SECRET}` }),
      'secret-in-effect-block');
  });

  it('refuses a transport carrying a quoted secret-shaped assignment', () => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, transport: `https://alice.ts.net/?${QUOTED_SECRET}` }),
      'secret-in-effect-block');
    expect(err.message).toContain('Secret-shaped assignment');
    // The refusal names the detector, never the value.
    expect(err.message).not.toContain('Kd82nQx7Zp13Mv04Rt6y');
  });

  it('refuses a single-quoted assignment pasted into a model id', () => {
    expectRefusal(
      () => buildEffectBlock({ ...BASE, modelId: "openrouter/secret='Kd82nQx7Zp13Mv04Rt6y'" }),
      'secret-in-effect-block');
  });

  it('refuses the same shape at the render boundary on a hand-built block', () => {
    const block: EffectBlock = {
      ...buildEffectBlock(BASE),
      transport: `https://alice.ts.net/?${QUOTED_SECRET}`,
    };
    expectRefusal(() => renderEffectBlock(block), 'secret-in-effect-block');
  });

  it('refuses a hand-built block whose cited path carries a credential', () => {
    const block: EffectBlock = {
      ...buildEffectBlock(BASE),
      paths: [{ path: `secrets/${FAKE_GH_TOKEN}.txt`, bytes: 0, scan: 'clean' }],
    };
    expectRefusal(() => renderEffectBlock(block), 'secret-in-effect-block');
  });

  it('still ESCAPES markup in a field — the scan render and the returned render are separate', () => {
    const rendered = renderEffectBlock(buildEffectBlock({ ...BASE, transport: 'https://a.b/<x>&y' }));
    expect(rendered).toContain('&lt;x&gt;');
    expect(rendered).toContain('&amp;y');
    expect(rendered).not.toContain('<x>');
  });
});

// ---------------------------------------------------------------------------
// Validation by construction, not by side effect
// ---------------------------------------------------------------------------

/**
 * A block that answers one value to the first read of a field and another to
 * every read after it. `EffectBlock` is a plain interface — the module says so
 * itself — so this is a legal object, and it is the difference between "the
 * value was validated" and "a value was validated".
 */
function twoFacedBlock(
  base: EffectBlock, field: keyof EffectBlock, first: unknown, later: unknown,
): EffectBlock {
  const b: Record<string, unknown> = { ...base };
  let reads = 0;
  Object.defineProperty(b, field, {
    enumerable: true,
    configurable: true,
    get: () => (reads++ === 0 ? first : later),
  });
  return b as unknown as EffectBlock;
}

describe('the disclosure title is built from the validated snapshot', () => {
  it('cannot be steered by a second read of the caller block (peerAlias)', async () => {
    const h = harness();
    const draft = 'the answer';
    const block = twoFacedBlock(
      buildEffectBlock({ ...BASE, payload: draft }), 'peerAlias', 'alice', 'Not-Alice The Bank');
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(true);
    expect(h.calls[0].title).toBe('Send a consult answer to "alice"?');
    expect(h.calls[0].title).not.toContain('Not-Alice');
    expect(h.calls[0].effect.peerAlias).toBe('alice');
  });

  it('cannot be steered by a second read of the caller block (verb)', async () => {
    const h = harness();
    const draft = 'the answer';
    const block = twoFacedBlock(
      buildEffectBlock({ ...BASE, payload: draft }), 'verb', 'consult', 'bash <img src=x>');
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(true);
    expect(h.calls[0].title).toBe('Send a consult answer to "alice"?');
    expect(h.calls[0].title).not.toContain('img');
  });

  it('hands the sink a frozen snapshot the caller can no longer change', async () => {
    const h = harness();
    const draft = 'the answer';
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await h.gate.askDisclosure(block, draft);
    const recorded = h.calls[0].effect;
    block.peerAlias = 'mallory';
    block.paths.push({ path: 'src/z.ts', bytes: 99, scan: 'clean' });
    expect(recorded.peerAlias).toBe('alice');
    expect(recorded.paths).toHaveLength(2);
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded.paths)).toBe(true);
  });

  it('hands the spend sink a snapshot too', async () => {
    const h = harness();
    await h.gate.askSpend('alice', 'why?', 0.004);
    expect(Object.isFrozen(h.calls[0].effect)).toBe(true);
    expect(h.calls[0].effect.verb).toBe(SPEND_VERB);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 is the card that authorises sending, so it must name a destination
// ---------------------------------------------------------------------------

describe('a disclosure card must name where the bytes go', () => {
  it('refuses the spend pseudo-verb — its own header says nothing is sent', async () => {
    const h = harness();
    const draft = 'the answer';
    const block = buildEffectBlock({
      verb: SPEND_VERB,
      peerAlias: 'alice',
      fingerprint: NOT_APPLICABLE,
      transport: NOT_APPLICABLE,
      payload: draft,
      citedPaths: [],
      modelId: NOT_APPLICABLE,
      retentionClass: NOT_APPLICABLE,
    });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-field');
    expect(h.refusals[0].detail).toContain(SPEND_VERB);
  });

  it.each([
    ['fingerprint'],
    ['transport'],
    ['modelId'],
    ['retentionClass'],
  ])('refuses a disclosure whose %s is not-applicable (I9/I12)', async (field) => {
    const h = harness();
    const draft = 'the answer';
    const block = buildEffectBlock(
      { ...BASE, payload: draft, [field]: NOT_APPLICABLE } as EffectBlockInput);
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-field');
    expect(h.refusals[0].detail).toContain(field);
  });

  // The other half of the rule: gate 1 sends nothing, so its card is still
  // allowed to say "not part of this decision" in every outbound field.
  it('leaves the spend card free to carry not-applicable fields', async () => {
    const h = harness();
    await expect(h.gate.askSpend('alice', 'why?', 0.004)).resolves.toBe(true);
    expect(h.calls[0].effect.transport).toBe(NOT_APPLICABLE);
    expect(h.calls[0].effect.retentionClass).toBe(NOT_APPLICABLE);
  });
});

// ---------------------------------------------------------------------------
// Invisible characters
// ---------------------------------------------------------------------------

describe('invisible characters are refused in the decision-bearing half', () => {
  it.each([
    ['soft hyphen', 'gpt­-4o'],
    ['word joiner', 'gpt⁠-4o'],
    ['invisible separator', 'gpt⁣-4o'],
    ['variation selector', 'gpt️-4o'],
    ['Hangul filler', 'gptㅤ-4o'],
    ['TAG block', 'gpt\u{E0061}\u{E0062}-4o'],
  ])('refuses a %s in a field', (_name, modelId) => {
    const err = expectRefusal(() => buildEffectBlock({ ...BASE, modelId }), 'invalid-field');
    expect(err.message).toContain('invisible');
  });

  it.each([
    ['soft hyphen', 'src/a­b.ts'],
    ['word joiner', 'src/a⁠b.ts'],
    ['variation selector', 'src/a️b.ts'],
    ['TAG block', 'src/a\u{E0062}b.ts'],
  ])('refuses a %s in a cited path', (_name, path) => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, citedPaths: [path] }), 'invalid-path');
    expect(err.message).toContain('invisible');
  });

  it('two model ids that render identically cannot both be accepted', () => {
    const plain = 'anthropic/claude-sonnet-4.6';
    const tagged = 'anthropic/claude-sonnet-4.6\u{E0074}\u{E0061}';
    // Identical to the eye and to any renderer: the tag block is zero-width.
    expect(tagged.replace(/[\u{E0000}-\u{E0FFF}]/gu, '')).toBe(plain);
    expect(buildEffectBlock({ ...BASE, modelId: plain }).modelId).toBe(plain);
    expectRefusal(() => buildEffectBlock({ ...BASE, modelId: tagged }), 'invalid-field');
  });

  // Scoped deliberately. A draft is human-written text where U+FE0F is how half
  // the emoji in a code review are spelled; refusing an answer for containing
  // one would delete something a legitimate user needs, and prose already
  // refuses the zero-width characters that can hide a discriminator.
  it('does NOT refuse an emoji variation selector in prose', async () => {
    const h = harness();
    await expect(h.gate.askSpend('alice', 'does ⚠️ fire on retry?', 0.004)).resolves.toBe(true);
    expect(h.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The render boundary enforces the SAME set as the build boundary
// ---------------------------------------------------------------------------

describe('duplicate citations are refused at both boundaries', () => {
  it('refuses a hand-built block that lists the same path twice', () => {
    const block: EffectBlock = {
      ...buildEffectBlock(BASE),
      paths: [
        { path: 'src/a.ts', bytes: 0, scan: 'clean' },
        { path: 'src/a.ts', bytes: 0, scan: 'clean' },
      ],
    };
    const err = expectRefusal(() => renderEffectBlock(block), 'invalid-path');
    expect(err.message).toContain('is listed twice');
  });

  it('refuses it at the gate too, before any card', async () => {
    const h = harness();
    const draft = 'the answer';
    const block: EffectBlock = {
      ...buildEffectBlock({ ...BASE, payload: draft }),
      paths: [
        { path: 'src/a.ts', bytes: 0, scan: 'clean' },
        { path: 'src/a.ts', bytes: 0, scan: 'clean' },
      ],
    };
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-path');
    expect(h.refusals[0].detail).toContain('is listed twice');
  });
});

// ---------------------------------------------------------------------------
// A crash is not a control firing
// ---------------------------------------------------------------------------

describe('the audit trail distinguishes a control from a bug', () => {
  it('files a throwing accessor as internal-error, not as a validation refusal', async () => {
    const h = harness();
    const draft = 'the answer';
    const block: Record<string, unknown> = { ...buildEffectBlock({ ...BASE, payload: draft }) };
    Object.defineProperty(block, 'sha256', {
      enumerable: true,
      get: () => { throw new RangeError('boom'); },
    });
    await expect(h.gate.askDisclosure(block as unknown as EffectBlock, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('internal-error');
    expect(h.refusals[0].detail).toContain('boom');
  });

  it('still files a real control under its own reason', async () => {
    const h = harness();
    await h.gate.askSpend('alice', 'why?', Number.NaN);
    expect(h.refusals[0].reason).toBe('invalid-estimate');
  });
});

// ---------------------------------------------------------------------------
// Field guards, each pinned by its own message
// ---------------------------------------------------------------------------

describe('every field guard refuses on its own', () => {
  it.each([
    [123],
    [null],
    [undefined],
    [{}],
    [['https://a.b']],
  ])('refuses a non-string transport (%j) rather than dereferencing it', (transport) => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, transport: transport as unknown as string }), 'invalid-field');
    expect(err.message).toBe('transport must be a string');
  });

  it.each([
    ['transport'],
    ['modelId'],
    ['fingerprint'],
    ['verb'],
    ['retentionClass'],
  ])('refuses an empty %s — a blank row on the card names nothing', (field) => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, [field]: '' } as EffectBlockInput), 'invalid-field');
    expect(err.message).toBe(`${field} must not be empty`);
  });

  it.each([
    ['transport', 200],
    ['modelId', 200],
    ['fingerprint', 128],
    ['retentionClass', 64],
    ['verb', 32],
  ])('refuses a %s over its %d-char cap', (field, cap) => {
    const err = expectRefusal(
      () => buildEffectBlock({ ...BASE, [field]: 'h'.repeat(cap + 1) } as EffectBlockInput),
      'invalid-field');
    expect(err.message).toBe(`${field} exceeds ${cap} chars`);
  });

  it('accepts a field exactly at its cap — the guard is a cap, not a haircut', () => {
    expect(buildEffectBlock({ ...BASE, transport: 'h'.repeat(200) }).transport).toHaveLength(200);
  });

  it('refuses a non-string question as a control, not as a crash', async () => {
    const h = harness();
    await expect(h.gate.askSpend('alice', 123 as unknown as string, 0.004)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-field');
    expect(h.refusals[0].detail).toBe('question must be a string');
  });
});

// ---------------------------------------------------------------------------
// Object and array guards
// ---------------------------------------------------------------------------

describe('object and array guards refuse before anything dereferences', () => {
  it.each([
    [null],
    [undefined],
    ['{}'],
    [42],
  ])('buildEffectBlock refuses a non-object input (%j)', (input) => {
    const err = expectRefusal(
      () => buildEffectBlock(input as unknown as EffectBlockInput), 'invalid-field');
    expect(err.message).toBe('effect block input must be an object');
  });

  it.each([
    [null],
    [undefined],
    ['x'],
    [7],
  ])('renderEffectBlock refuses a non-object block (%j)', (block) => {
    const err = expectRefusal(
      () => renderEffectBlock(block as unknown as EffectBlock), 'invalid-field');
    expect(err.message).toBe('effect block must be an object');
  });

  it('askDisclosure refuses a non-object block without raising a card', async () => {
    const h = harness();
    await expect(h.gate.askDisclosure(null as unknown as EffectBlock, 'the answer')).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-field');
    expect(h.refusals[0].detail).toBe('effect block must be an object');
  });

  // A STRING `paths` is the case worth pinning: `.length` and `for...of` both
  // work on a string, so without the guard a hand-built block renders one
  // citation row per CHARACTER.
  it.each([
    ['src/a.ts'],
    [{}],
    [null],
    [undefined],
    [42],
  ])('renderEffectBlock refuses a non-array paths (%j)', (paths) => {
    const block = {
      ...buildEffectBlock(BASE), paths: paths as unknown as EffectBlock['paths'],
    };
    const err = expectRefusal(() => renderEffectBlock(block), 'invalid-path');
    expect(err.message).toBe('paths must be an array');
  });

  it('askDisclosure refuses a string paths — one row per character is not a citation list', async () => {
    const h = harness();
    const draft = 'the answer';
    const block = {
      ...buildEffectBlock({ ...BASE, payload: draft }),
      paths: 'src/a.ts' as unknown as EffectBlock['paths'],
    };
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('invalid-path');
    expect(h.refusals[0].detail).toBe('paths must be an array');
  });

  it.each([
    [null],
    ['src/a.ts'],
    [42],
  ])('renderEffectBlock refuses a non-object path entry (%j)', (entry) => {
    const block = {
      ...buildEffectBlock(BASE), paths: [entry] as unknown as EffectBlock['paths'],
    };
    const err = expectRefusal(() => renderEffectBlock(block), 'invalid-path');
    expect(err.message).toBe('a cited path entry is not an object');
  });
});

// ---------------------------------------------------------------------------
// The confirm dependency must be the forced-interactive one
// ---------------------------------------------------------------------------

describe('confirm must be the forced-interactive entry point', () => {
  it.each([
    [undefined],
    [false],
    ['yes'],
    [1],
    [null],
  ])('refuses to construct with confirmIsForcedInteractive %j', (flag) => {
    expect(() => new DeskServingGate({
      confirm: async () => true, confirmIsForcedInteractive: flag,
    } as unknown as GateDeps)).toThrow(/forced-interactive/);
  });

  it('constructs when the call site states it', () => {
    expect(() => new DeskServingGate({
      confirm: async () => true, confirmIsForcedInteractive: true,
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The spend card reports what it found in the inbound question
// ---------------------------------------------------------------------------

describe('the inbound question is scanned, and reported rather than refused', () => {
  it('surfaces a credential-shaped question WITHOUT refusing it', async () => {
    const h = harness();
    await expect(h.gate.askSpend('alice', `why is ${FAKE_GH_TOKEN} rejected?`, 0.004)).resolves.toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body).toContain('egress scan');
    expect(h.calls[0].body).toContain('GitHub token');
    // The question itself is still complete: gate 1 shows what arrived.
    expect(h.calls[0].body).toContain(FAKE_GH_TOKEN);
  });

  it('says nothing when the question is clean', async () => {
    const h = harness();
    await h.gate.askSpend('alice', 'why does the retry loop stall?', 0.004);
    expect(h.calls[0].body).not.toContain('egress scan');
  });

  it('and an answer that quotes it is still refused at gate 2', async () => {
    const h = harness();
    const draft = `The retry helper reads STRIPE_KEY = "${FAKE_STRIPE_KEY}" at boot.`;
    const block = buildEffectBlock({ ...BASE, payload: draft });
    await expect(h.gate.askDisclosure(block, draft)).resolves.toBe(false);
    expect(h.refusals[0].reason).toBe('secret-in-payload');
  });
});

// ---------------------------------------------------------------------------
// The question cap is the wire-contract cap — the second option, tested
// ---------------------------------------------------------------------------

describe('maxQuestionChars: a caller may lower it, never raise it', () => {
  it('ceilings the question cap at the contract bound it is meant to back up', () => {
    expect(GATE_LIMIT_CEILINGS.maxQuestionChars).toBe(GATE_LIMIT_DEFAULTS.maxQuestionChars);
  });

  it('refuses to raise it, and still caps at the contract bound', async () => {
    const h = harness({ maxQuestionChars: 20_000 });
    expect(h.gate.limits.maxQuestionChars).toBe(GATE_LIMIT_DEFAULTS.maxQuestionChars);
    const question = 'Q'.repeat(GATE_LIMIT_DEFAULTS.maxQuestionChars + 1);
    await expect(h.gate.askSpend('alice', question, 0.004)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('payload-too-large');
  });

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
    ['4000' as unknown as number],
    [null as unknown as number],
    [GATE_LIMIT_CEILINGS.maxQuestionChars + 1],
    [1e9],
  ])('falls back to the default for an unusable or above-ceiling maxQuestionChars %j', (maxQuestionChars) => {
    const gate = new DeskServingGate(
      { confirm: async () => true, confirmIsForcedInteractive: true }, { maxQuestionChars });
    expect(gate.limits.maxQuestionChars).toBe(GATE_LIMIT_DEFAULTS.maxQuestionChars);
  });

  it.each([
    [0],
    [-1],
  ])('clamps a below-floor maxQuestionChars %j down to the floor', (maxQuestionChars) => {
    const gate = new DeskServingGate(
      { confirm: async () => true, confirmIsForcedInteractive: true }, { maxQuestionChars });
    expect(gate.limits.maxQuestionChars).toBe(1);
  });

  it('honours a lowered question cap', async () => {
    const h = harness({ maxQuestionChars: 8 });
    expect(h.gate.limits.maxQuestionChars).toBe(8);
    await expect(h.gate.askSpend('alice', 'why does it stall?', 0.004)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.refusals[0].reason).toBe('payload-too-large');
    await expect(h.gate.askSpend('alice', 'why?', 0.004)).resolves.toBe(true);
  });
});
