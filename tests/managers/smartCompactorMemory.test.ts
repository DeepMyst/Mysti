/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit + integration tests for delta-patch memory (Plan 13 L2 / Plan 09):
 * deterministic section parse/serialize/apply, tolerant patch extraction with
 * graceful full-rewrite fallback, and byte-stability of unchanged sections.
 */
import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  SmartCompactor,
  parseMemorySections,
  serializeMemory,
  applyMemoryPatches,
  tryApplyMemoryPatches,
} from '../../src/managers/SmartCompactor';
import type { DeepMystAuthManager } from '../../src/managers/DeepMystAuthManager';
import type { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';
import type { SavingsLedger } from '../../src/managers/SavingsLedger';
import type { Conversation, Message } from '../../src/types';

// Long enough (> ~600 chars) to clear the 150-token degenerate floor in the
// summarize() integration test below, while keeping the exact strings the unit
// tests assert (Goal body, the "cheap gateway model" decision line, and the
// four-section set Goal/Decisions/Files/Open Threads with no Code section).
const MEMORY = `## Goal
Ship smart compaction.

## Decisions
- Use a cheap gateway model for summaries so compaction stays far cheaper than the main model.
- Reseed the Claude session after compaction because the CLI owns history via --resume.
- Keep the compacted prefix above the minimum cacheable size so the cache still applies.
- Decide to compact only when the projected savings beat the value of the warm cache (N >= N*).

## Files
src/managers/SmartCompactor.ts → the decision engine and incremental summarizer
src/managers/CompactionManager.ts → per-panel usage tracking and the smart/legacy switch
src/services/ModelPricing.ts → the compact-vs-cache price table and token estimate

## Open Threads
- Wire delta-patch memory so unchanged sections stay byte-identical across epochs.
- Fold the Claude cold-reseed cost into the break-even so N* is not optimistic.
- Surface realized savings in the always-on chip so users see the value continuously.`;

describe('parseMemorySections', () => {
  it('parses headings into ordered sections and trims blank lines', () => {
    const { order, bodies } = parseMemorySections(MEMORY);
    expect(order).toEqual(['Goal', 'Decisions', 'Files', 'Open Threads']);
    expect(bodies.get('Goal')).toBe('Ship smart compaction.');
    expect(bodies.get('Decisions')).toContain('- Use a cheap gateway model');
  });

  it('preserves internal code indentation (only blank lines trimmed)', () => {
    const md = '## Code\n\n    const x = 1;\n      nested();\n\n';
    const { bodies } = parseMemorySections(md);
    expect(bodies.get('Code')).toBe('    const x = 1;\n      nested();');
  });

  it('ignores content before the first heading', () => {
    const { order } = parseMemorySections('junk preamble\nmore\n## Goal\nx');
    expect(order).toEqual(['Goal']);
  });
});

describe('serializeMemory', () => {
  it('emits canonical order first, then novel sections, omitting empty bodies', () => {
    const bodies = new Map<string, string>([
      ['Notes', 'novel'],
      ['Goal', 'g'],
      ['Files', ''], // empty → omitted
      ['Decisions', 'd'],
    ]);
    const out = serializeMemory(['Notes', 'Goal', 'Files', 'Decisions'], bodies);
    expect(out).toBe('## Goal\ng\n\n## Decisions\nd\n\n## Notes\nnovel\n');
  });
});

describe('applyMemoryPatches', () => {
  it('append adds to the end of a section; unchanged sections are byte-identical', () => {
    const before = parseMemorySections(MEMORY);
    const out = applyMemoryPatches(MEMORY, [
      { section: 'Decisions', op: 'append', content: '- Add EWMA remaining-turns.' },
    ]);
    const after = parseMemorySections(out);
    // Goal + Files + Open Threads untouched, byte-for-byte.
    expect(after.bodies.get('Goal')).toBe(before.bodies.get('Goal'));
    expect(after.bodies.get('Files')).toBe(before.bodies.get('Files'));
    expect(after.bodies.get('Open Threads')).toBe(before.bodies.get('Open Threads'));
    // Decisions grew by exactly the appended line.
    expect(after.bodies.get('Decisions')).toBe(before.bodies.get('Decisions') + '\n- Add EWMA remaining-turns.');
  });

  it('replace overwrites a section body', () => {
    const out = applyMemoryPatches(MEMORY, [
      { section: 'Open Threads', op: 'replace', content: '- (all done)' },
    ]);
    expect(parseMemorySections(out).bodies.get('Open Threads')).toBe('- (all done)');
  });

  it('remove drops a section entirely', () => {
    const out = applyMemoryPatches(MEMORY, [{ section: 'Files', op: 'remove' }]);
    expect(parseMemorySections(out).order).not.toContain('Files');
  });

  it('creates a novel section when patched section does not exist', () => {
    const out = applyMemoryPatches(MEMORY, [{ section: 'Code', op: 'append', content: 'fn()' }]);
    expect(parseMemorySections(out).bodies.get('Code')).toBe('fn()');
  });

  it('an empty patch list round-trips memory (normalized, stable)', () => {
    const once = applyMemoryPatches(MEMORY, []);
    const twice = applyMemoryPatches(once, []);
    expect(twice).toBe(once); // idempotent after the first normalization
  });
});

describe('tryApplyMemoryPatches', () => {
  it('applies a bare JSON array', () => {
    const out = tryApplyMemoryPatches(MEMORY, '[{"section":"Goal","op":"replace","content":"New goal."}]');
    expect(out).not.toBeNull();
    expect(parseMemorySections(out!).bodies.get('Goal')).toBe('New goal.');
  });

  it('tolerates ```json fences and surrounding prose', () => {
    const text = 'Here are the patches:\n```json\n[{"section":"Goal","op":"replace","content":"X"}]\n```\nDone.';
    const out = tryApplyMemoryPatches(MEMORY, text);
    expect(parseMemorySections(out!).bodies.get('Goal')).toBe('X');
  });

  it('treats an explicit [] as "no change" (keeps existing memory), not a fallback', () => {
    const out = tryApplyMemoryPatches(MEMORY, '[]');
    expect(out).not.toBeNull();
    // Same sections survive.
    expect(parseMemorySections(out!).order).toEqual(['Goal', 'Decisions', 'Files', 'Open Threads']);
  });

  it('returns null when the text is a full-memory rewrite (not a patch array)', () => {
    expect(tryApplyMemoryPatches(MEMORY, '## Goal\nSomething entirely rewritten')).toBeNull();
  });

  it('returns null when all patch items are malformed (→ caller falls back)', () => {
    expect(tryApplyMemoryPatches(MEMORY, '[{"foo":"bar"},{"op":"nope"}]')).toBeNull();
  });

  it('returns null on non-JSON garbage', () => {
    expect(tryApplyMemoryPatches(MEMORY, 'not json at all')).toBeNull();
  });
});

// ── Regression tests for adversarial-review findings ─────────────────────────

describe('delta-patch review regressions', () => {
  it('#1 fence-aware: a `## ` line inside a fenced Code block is body, not a heading', () => {
    const md = [
      '## Goal',
      'Do the thing.',
      '',
      '## Code',
      '```python',
      '## config section',
      'X = 1',
      '```',
      '',
      '## Open Threads',
      '- keep going',
    ].join('\n');
    const { order, bodies } = parseMemorySections(md);
    // The `## config section` line must NOT become its own section.
    expect(order).toEqual(['Goal', 'Code', 'Open Threads']);
    expect(bodies.get('Code')).toContain('## config section');
    expect(bodies.get('Open Threads')).toBe('- keep going');
    // And it round-trips losslessly through an empty patch application.
    const out = applyMemoryPatches(md, []);
    const reparsed = parseMemorySections(out);
    expect(reparsed.order).toEqual(['Goal', 'Code', 'Open Threads']);
    expect(reparsed.bodies.get('Open Threads')).toBe('- keep going');
  });

  it('#2 a content-less replace/append never deletes a durable section', () => {
    const before = parseMemorySections(MEMORY).bodies.get('Goal');
    const outReplace = applyMemoryPatches(MEMORY, [{ section: 'Goal', op: 'replace' }]);
    const outEmpty = applyMemoryPatches(MEMORY, [{ section: 'Goal', op: 'replace', content: '' }]);
    expect(parseMemorySections(outReplace).bodies.get('Goal')).toBe(before);
    expect(parseMemorySections(outEmpty).bodies.get('Goal')).toBe(before);
  });

  it('#3 duplicate headings merge (later block does not clobber the earlier)', () => {
    const md = '## Files\nfile-a.ts → a\n\n## Decisions\n- x\n\n## Files\nfile-b.ts → b';
    const body = parseMemorySections(md).bodies.get('Files');
    expect(body).toContain('file-a.ts → a');
    expect(body).toContain('file-b.ts → b');
  });

  it('#6 an explicit [] returns the prior memory VERBATIM (byte-identical)', () => {
    expect(tryApplyMemoryPatches(MEMORY, '[]')).toBe(MEMORY);
  });

  it('#8 a fenced snippet inside a patch content value does not break extraction', () => {
    const text = '[{"section":"Code","op":"append","content":"```ts\\nfoo()\\n```"}]';
    const out = tryApplyMemoryPatches(MEMORY, text);
    expect(out).not.toBeNull();
    expect(parseMemorySections(out!).bodies.get('Code')).toContain('foo()');
  });

  it('#9 a valid patch array wrapped in bracket-containing prose is still extracted', () => {
    const text = 'Here is my update [see the array below]:\n[{"section":"Goal","op":"replace","content":"Updated."}]';
    const out = tryApplyMemoryPatches(MEMORY, text);
    expect(out).not.toBeNull();
    expect(parseMemorySections(out!).bodies.get('Goal')).toBe('Updated.');
  });

  it('#10 wrong-case ops are normalized; non-string content is rejected per-item', () => {
    const out = tryApplyMemoryPatches(MEMORY, '[{"section":"Goal","op":"REPLACE","content":"Cased."}]');
    expect(parseMemorySections(out!).bodies.get('Goal')).toBe('Cased.');
    // A non-string content item is dropped, not String()-coerced into the body.
    const before = parseMemorySections(MEMORY).bodies.get('Decisions');
    const out2 = tryApplyMemoryPatches(MEMORY, '[{"section":"Decisions","op":"append","content":123}]');
    expect(out2).toBeNull(); // only invalid item → no usable patches → fallback
    expect(parseMemorySections(MEMORY).bodies.get('Decisions')).toBe(before);
  });
});

// ── Integration: summarize()'s bootstrap→patch progression through real fs ──────

function makeCompactor(summaryText: string) {
  const ledger = { record: vi.fn() } as unknown as SavingsLedger;
  const auth = {
    isSignedIn: () => true, hasEntitlement: () => true, getEntitlement: () => undefined,
  } as unknown as DeepMystAuthManager;
  const gateway = {
    chatCompletion: vi.fn(async () => ({ text: summaryText, failed: false })),
  } as unknown as DeepMystGatewayClient;
  return { sc: new SmartCompactor(auth, gateway, ledger), gateway };
}

const conv = (): Conversation => ({
  id: 'c', title: 't', createdAt: 0, updatedAt: 0,
  messages: [
    { id: 'm0', role: 'user', content: 'first request', timestamp: 0 } as Message,
    { id: 'm1', role: 'assistant', content: 'first reply', timestamp: 1 } as Message,
    { id: 'm2', role: 'user', content: 'second request', timestamp: 2 } as Message,
    { id: 'm3', role: 'assistant', content: 'second reply', timestamp: 3 } as Message,
    { id: 'm4', role: 'user', content: 'third request', timestamp: 4 } as Message,
    { id: 'm5', role: 'assistant', content: 'third reply', timestamp: 5 } as Message,
  ],
} as unknown as Conversation);

describe('SmartCompactor.summarize — bootstrap then delta-patch (real fs)', () => {
  it('bootstraps full memory, then applies a patch keeping unchanged sections byte-identical', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysti-mem-'));
    const folders = (vscode.workspace as any).workspaceFolders;
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
    const memPath = path.join(tmp, '.mysti', 'compaction', 'panelA', 'memory.md');
    try {
      // 1) Bootstrap: no prior memory → the model's full text becomes memory.md.
      const bootstrapMemory = MEMORY;
      const { sc } = makeCompactor(bootstrapMemory);
      const r1 = await sc.summarize({
        panelId: 'panelA', conversation: conv(),
        providerModel: 'claude-opus-4-8', cheapModel: 'claude-haiku-4-5', minSummaryTokens: 5000,
      });
      expect(r1?.success).toBe(true);
      const afterBootstrap = await fsp.readFile(memPath, 'utf8');
      expect(afterBootstrap).toContain('## Goal');

      // 2) Second compaction: model returns a PATCH → append a decision.
      const { sc: sc2 } = makeCompactor('[{"section":"Decisions","op":"append","content":"- Delta-patch landed."}]');
      // Reuse the same panel/workspace so it reads the memory we just wrote.
      const goalBefore = parseMemorySections(afterBootstrap).bodies.get('Goal');
      const r2 = await sc2.summarize({
        panelId: 'panelA', conversation: conv(),
        providerModel: 'claude-opus-4-8', cheapModel: 'claude-haiku-4-5', minSummaryTokens: 5000,
      });
      expect(r2?.success).toBe(true);
      const afterPatch = await fsp.readFile(memPath, 'utf8');
      const parsed = parseMemorySections(afterPatch);
      // Unchanged section identical, patched section grew.
      expect(parsed.bodies.get('Goal')).toBe(goalBefore);
      expect(parsed.bodies.get('Decisions')).toContain('- Delta-patch landed.');

      // 3) #7 regression: a malformed patch response (valid JSON array, no usable
      // items) must NOT overwrite the good memory — summarize returns null (→ the
      // caller client-summarizes) and memory.md on disk is untouched.
      const memoryBeforeBad = afterPatch;
      const { sc: sc3 } = makeCompactor('[{"not":"a patch"},{"op":"bogus"}]');
      const r3 = await sc3.summarize({
        panelId: 'panelA', conversation: conv(),
        providerModel: 'claude-opus-4-8', cheapModel: 'claude-haiku-4-5', minSummaryTokens: 5000,
      });
      expect(r3).toBeNull();
      expect(await fsp.readFile(memPath, 'utf8')).toBe(memoryBeforeBad);
    } finally {
      (vscode.workspace as any).workspaceFolders = folders;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
