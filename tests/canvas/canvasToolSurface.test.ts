/**
 * Plan 22 Phase 4 — THE CONFORMANCE TEST.
 *
 * "One op algebra, N producers" (§2.3) is only true if it is checked. For every
 * `CanvasOp` variant this asserts:
 *
 *   (a) some TOOL produces it — declared in `CanvasToolSurface` AND executed
 *       here against a real store/executor, so a declaration that lies fails;
 *   (b) some UI GESTURE produces it — by importing the webview's own
 *       op-construction helpers and by scanning `src/webview/canvas` for the op
 *       literal, so the agent's surface cannot outgrow the human's;
 *   (c) every EXAMPLE the system prompt shows round-trips to a valid op —
 *       through the same directive parser and the same dispatcher the model's
 *       output actually travels.
 *
 * (c) is the one that matters most. The bug it replaces shipped: the single
 * worked example taught `scaffold_page` as a fenced op kind `CanvasOpParser`
 * rejected, and the rejection died in a `console.warn` invisible to both the
 * model and the user.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import {
  CANVAS_TOOLS,
  dispatchCanvasTool,
  getCanvasTool,
  canvasToolPayload,
  type CanvasToolContext,
} from '../../src/managers/CanvasToolDispatch';
import {
  CANVAS_OP_PRODUCERS,
  CANVAS_PROMPT_EXAMPLES,
  CANVAS_TOOL_SURFACE,
  CANVAS_PIN_RULE,
  CANVAS_UI_GESTURES,
  LEGACY_KIND_FOR_OP,
  offeredCanvasTools,
} from '../../src/canvas/CanvasToolSurface';
import type { CanvasOp as CanvasOpV2, CanvasOpKindV2 } from '../../src/canvas/CanvasOps';
import {
  CANVAS_NATIVE_EXCLUDED,
  CANVAS_TOOL_PREFIX,
  CANVAS_SESSION_TOOL_NAMES,
  isKnownCanvasTool,
  normalizeCanvasToolName,
  toolCallToDirective,
} from '../../src/services/coordinatorTools';
import { canvasDirectiveToToolCall, isCanvasDirectiveError } from '../../src/canvas/canvasDirective';
import { buildCanvasContextBlock, buildCanvasToolGuide } from '../../src/managers/CanvasPromptBuilder';
import { findNode, isMid, walk, type DocNode, type Mid } from '../../src/canvas/doc/DocNode';
import { emit } from '../../src/canvas/doc/DocEmitter';
import type { CanvasArtifact, CanvasOp as LegacyCanvasOp } from '../../src/types';

// The webview's OWN op constructors — imported, not re-implemented, so "the
// human gesture and the agent tool emit the same record" is a real assertion.
import { addPageOps, duplicatePageOps, removePageOps, railReorderOps } from '../../src/webview/canvas/rail';
import { nudgeOps } from '../../src/webview/canvas/selection';
import { changeDevice, changeTheme } from '../../src/webview/canvas/state';
import { buildControlModel, controlOps, TEXT_CONTROL } from '../../src/webview/canvas/controls';

const ALL_OP_KINDS = Object.keys(CANVAS_UI_GESTURES) as CanvasOpKindV2[];

const PAGE_SRC = [
  'function Page() {',
  '  return (',
  '    <UI.Screen>',
  '      <UI.Heading>Sign in</UI.Heading>',
  '      <UI.Text>Welcome back</UI.Text>',
  '      <UI.Card><UI.Badge label="beta"/></UI.Card>',
  '    </UI.Screen>',
  '  );',
  '}',
].join('\n');

interface Harness {
  store: ArtifactStore;
  executor: CanvasOpExecutor;
  artifact: CanvasArtifact;
  ctx: CanvasToolContext;
  events: Array<{ type: string; op?: LegacyCanvasOp }>;
}

function harness(): Harness {
  const store = new ArtifactStore({ getRoot: () => null });
  const events: Array<{ type: string; op?: LegacyCanvasOp }> = [];
  const router = new CanvasJobRouter(e => events.push(e as { type: string; op?: LegacyCanvasOp }));
  const executor = new CanvasOpExecutor(store, router);
  const artifact = store.createArtifact({ name: 'Surface', kind: 'screens' });
  const ctx: CanvasToolContext = { artifact, store, executor, jobId: 'job-1', runId: 'run-1', approvalMode: 'auto' };
  return { store, executor, artifact, ctx, events };
}

/** A real JSX artboard with addressable elements. */
function seedPage(h: Harness, jsx = PAGE_SRC, title = 'Sign in'): { pageId: string; doc: DocNode } {
  const page = h.store.insertPage(h.artifact, h.store.makePage({ mode: 'jsx', jsxSource: jsx, actionTitle: title }));
  return { pageId: page.id, doc: page.doc };
}

function firstTextMid(h: Harness, pageId: string): Mid {
  const doc = h.store.getPage(h.artifact, pageId)!.doc;
  for (const n of walk(doc)) { if (n.text !== undefined) { return n.mid; } }
  throw new Error('no text leaf');
}

function midByTag(h: Harness, pageId: string, tag: string): Mid {
  const doc = h.store.getPage(h.artifact, pageId)!.doc;
  for (const n of walk(doc)) { if (n.tag === tag) { return n.mid; } }
  throw new Error(`no ${tag} in the page`);
}

/* ══════════════════════════ (a) tools produce every op ═════════════════════ */

describe('conformance (a) — every CanvasOp variant has a tool that produces it', () => {
  it('declares at least one producing tool for every variant', () => {
    for (const kind of ALL_OP_KINDS) {
      expect(CANVAS_OP_PRODUCERS[kind].length, kind).toBeGreaterThan(0);
    }
  });

  it('names only real tools as producers', () => {
    for (const [kind, tools] of Object.entries(CANVAS_OP_PRODUCERS)) {
      for (const tool of tools) {
        expect(getCanvasTool(tool), `${kind} ← ${tool}`).toBeDefined();
      }
    }
  });

  /**
   * Each variant, EXECUTED. A declaration is a comment until the call runs, so
   * every case below dispatches a real tool against a real store and asserts
   * the document actually moved.
   */
  describe('and the tool actually commits it', () => {
    let h: Harness;
    beforeEach(() => { h = harness(); });

    /** Ops the dispatcher submits through the Plan 22 algebra report them back. */
    const expectV2 = (res: ReturnType<typeof dispatchCanvasTool>, kind: CanvasOpKindV2) => {
      expect(res.ok, res.error).toBe(true);
      expect(res.ops?.map(o => o.op)).toContain(kind);
      expect(res.receipt?.status).toBe('applied');
    };

    it('page.add ← add_page', () => {
      const res = dispatchCanvasTool('add_page', { scaffold: 'login', actionTitle: 'Login' }, h.ctx);
      expectV2(res, 'page.add');
      expect(h.artifact.pages).toHaveLength(1);
      expect(h.artifact.pages[0].legacy).toBeUndefined();
    });

    it('page.remove ← remove_page', () => {
      const { pageId } = seedPage(h);
      expectV2(dispatchCanvasTool('remove_page', { pageId }, h.ctx), 'page.remove');
      expect(h.artifact.pages).toHaveLength(0);
    });

    it('page.duplicate ← duplicate_page', () => {
      const { pageId } = seedPage(h);
      expectV2(dispatchCanvasTool('duplicate_page', { pageId }, h.ctx), 'page.duplicate');
      expect(h.artifact.pages).toHaveLength(2);
    });

    it('page.setMeta ← set_page_meta', () => {
      const { pageId } = seedPage(h);
      expectV2(dispatchCanvasTool('set_page_meta', { pageId, actionTitle: 'Renamed', formatId: 'mobile' }, h.ctx), 'page.setMeta');
      const page = h.store.getPage(h.artifact, pageId)!;
      expect(page.actionTitle).toBe('Renamed');
      expect(page.format?.formatId).toBe('mobile');
      // An id the catalog does not know is refused, not silently defaulted.
      expect(dispatchCanvasTool('set_page_meta', { pageId, formatId: 'phone' }, h.ctx).error).toContain('unknown format');
    });

    it('page.move ← move_page', () => {
      const { pageId } = seedPage(h);
      expectV2(dispatchCanvasTool('move_page', { pageId, x: 320, y: -80 }, h.ctx), 'page.move');
      expect(h.store.getPage(h.artifact, pageId)!.boardPos).toEqual({ x: 320, y: -80 });
    });

    it('page.reorder ← reorder_pages', () => {
      const a = seedPage(h, PAGE_SRC, 'A');
      const b = seedPage(h, PAGE_SRC, 'B');
      const res = dispatchCanvasTool('reorder_pages', { orderedIds: [b.pageId, a.pageId] }, h.ctx);
      expect(res.ok).toBe(true);
      expect(h.artifact.pages.map(p => p.id)).toEqual([b.pageId, a.pageId]);
    });

    it('page.setDoc ← write_page on a code page (which also promotes it out of legacy)', () => {
      const page = h.store.insertPage(h.artifact, h.store.makePage({ mode: 'html', htmlSource: '<h1>old</h1>' }));
      expect(page.legacy).toBeDefined();
      const res = dispatchCanvasTool('write_page', { pageId: page.id, jsx: PAGE_SRC }, h.ctx);
      expectV2(res, 'page.setDoc');
      expect(h.store.getPage(h.artifact, page.id)!.legacy).toBeUndefined();
    });

    it('el.setText ← set_text', () => {
      const { pageId } = seedPage(h);
      const mid = firstTextMid(h, pageId);
      expectV2(dispatchCanvasTool('set_text', { pageId, mid, text: 'Get started' }, h.ctx), 'el.setText');
      expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.text).toBe('Get started');
    });

    it('el.setStyle ← set_style (and null clears)', () => {
      const { pageId } = seedPage(h);
      const mid = firstTextMid(h, pageId);
      expectV2(dispatchCanvasTool('set_style', { pageId, mid, style: { color: 'var(--color-primary)' } }, h.ctx), 'el.setStyle');
      expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.style?.color).toBe('var(--color-primary)');
      dispatchCanvasTool('set_style', { pageId, mid, style: { color: null } }, h.ctx);
      expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.style?.color).toBeUndefined();
    });

    it('el.setProp ← set_prop', () => {
      const { pageId } = seedPage(h);
      const mid = firstTextMid(h, pageId);
      expectV2(dispatchCanvasTool('set_prop', { pageId, mid, name: 'variant', value: 'secondary' }, h.ctx), 'el.setProp');
      expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.props?.variant).toBe('secondary');
    });

    it('el.insert ← insert_element (from jsx, with a host-minted id reported back)', () => {
      const { pageId } = seedPage(h);
      const root = h.store.getPage(h.artifact, pageId)!.doc.mid;
      const res = dispatchCanvasTool('insert_element', { pageId, parentMid: root, jsx: '<UI.Button label="Sign in"/>' }, h.ctx);
      expectV2(res, 'el.insert');
      expect(Object.keys(res.receipt?.newMids ?? {}).length).toBeGreaterThan(0);
      const doc = h.store.getPage(h.artifact, pageId)!.doc;
      expect([...walk(doc)].some(n => n.tag === 'UI.Button')).toBe(true);
    });

    it('el.remove ← remove_element', () => {
      const { pageId } = seedPage(h);
      const mid = firstTextMid(h, pageId);
      expectV2(dispatchCanvasTool('remove_element', { pageId, mid }, h.ctx), 'el.remove');
      expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)).toBeNull();
    });

    it('el.move ← move_element (reparenting keeps the element identity)', () => {
      const { pageId } = seedPage(h);
      const heading = midByTag(h, pageId, 'UI.Heading');
      const card = midByTag(h, pageId, 'UI.Card');
      expectV2(dispatchCanvasTool('move_element', { pageId, mid: heading, newParentMid: card }, h.ctx), 'el.move');
      const after = h.store.getPage(h.artifact, pageId)!.doc;
      expect(findNode(after, card)!.children?.some(c => c.mid === heading)).toBe(true);
      expect(after.children?.some(c => c.mid === heading)).toBe(false);
    });

    it('el.replace ← replace_element', () => {
      const { pageId } = seedPage(h);
      const mid = firstTextMid(h, pageId);
      expectV2(dispatchCanvasTool('replace_element', { pageId, mid, node: { tag: 'UI.Badge', props: { label: 'New' } } }, h.ctx), 'el.replace');
      expect([...walk(h.store.getPage(h.artifact, pageId)!.doc)].some(n => n.tag === 'UI.Badge')).toBe(true);
    });

    it('theme.set ← set_theme (object or preset)', () => {
      const res = dispatchCanvasTool('set_theme', { preset: 'midnight' }, h.ctx);
      expect(res.ok, res.error).toBe(true);
      const theme = JSON.parse(JSON.stringify(h.artifact.theme));
      theme.colors.primary = '#123456';
      expect(dispatchCanvasTool('set_theme', { theme }, h.ctx).ok).toBe(true);
      expect(h.artifact.theme.colors.primary).toBe('#123456');
    });

    it('theme.setToken ← set_theme_token', () => {
      expectV2(dispatchCanvasTool('set_theme_token', { path: 'colors.primary', value: '#0B5FFF' }, h.ctx), 'theme.setToken');
      expect(h.artifact.theme.colors.primary).toBe('#0B5FFF');
    });

    it('artifact.setFormat ← set_format', () => {
      const res = dispatchCanvasTool('set_format', { formatId: 'story-9x16' }, h.ctx);
      expect(res.ok).toBe(true);
      expect(h.artifact.format.formatId).toBe('story-9x16');
    });

    it('asset.add ← add_asset', () => {
      const res = dispatchCanvasTool('add_asset', { asset: { id: 'a1', role: 'image', ref: 'asset://abc.png', ts: Date.now() } }, h.ctx);
      expect(res.ok).toBe(true);
      expect(h.artifact.assets.map(a => a.id)).toContain('a1');
    });
  });

  it('the legacy kind a V2 op reports matches what the executor itself emits', () => {
    // The dispatcher must label a V2 op the same way the executor's own event
    // does, or the canvas renders one card and the chat renders another.
    const h = harness();
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);
    const cases: Array<[CanvasOpKindV2, CanvasOpV2]> = [
      ['el.setText', { op: 'el.setText', pageId, mid, text: 'x' }],
      ['el.setStyle', { op: 'el.setStyle', pageId, mid, style: { color: 'red' } }],
      ['page.setMeta', { op: 'page.setMeta', pageId, patch: { actionTitle: 't' } }],
      ['page.move', { op: 'page.move', pageId, boardPos: { x: 1, y: 2 } }],
      ['theme.setToken', { op: 'theme.setToken', path: 'colors.primary', value: '#111111' }],
      ['artifact.setFormat', { op: 'artifact.setFormat', format: h.artifact.format }],
      ['page.duplicate', { op: 'page.duplicate', pageId }],
    ];
    for (const [kind, op] of cases) {
      h.events.length = 0;
      h.executor.submitOp(h.artifact, { op, runId: 'r', author: 'agent' }, 'job-1', 'auto');
      const emitted = h.events.find(e => e.type === 'op_applied')?.op;
      expect(emitted?.kind, kind).toBe(LEGACY_KIND_FOR_OP[kind]);
    }
  });
});

/* ══════════════════════ (b) UI gestures produce every op ═══════════════════ */

describe('conformance (b) — every CanvasOp variant has a human gesture', () => {
  const WEBVIEW_DIR = path.resolve(__dirname, '../../src/webview/canvas');

  const webviewSource = (): string =>
    fs.readdirSync(WEBVIEW_DIR)
      .filter(f => f.endsWith('.ts'))
      .map(f => fs.readFileSync(path.join(WEBVIEW_DIR, f), 'utf8'))
      .join('\n');

  it('declares a gesture for every variant', () => {
    for (const kind of ALL_OP_KINDS) {
      const g = CANVAS_UI_GESTURES[kind];
      expect(g?.gesture, kind).toBeTruthy();
      expect(g.module, kind).toMatch(/^src\/webview\/canvas\/[a-zA-Z]+\.ts$/);
    }
  });

  it('every gesture declared SHIPPED is actually constructed in the webview', () => {
    const src = webviewSource();
    for (const kind of ALL_OP_KINDS) {
      if (CANVAS_UI_GESTURES[kind].status !== 'shipped') { continue; }
      expect(src.includes(`op: '${kind}'`), `${kind} (${CANVAS_UI_GESTURES[kind].module})`).toBe(true);
    }
  });

  /**
   * Review F5 — the `module` field was decorative: the check above searched the
   * CONCATENATION of every webview file, so a gesture could claim to live in
   * `rail.ts` while being built in `state.ts` and still pass. It names the
   * module a reader is sent to; it has to be the module.
   */
  it('…in the module it says it is, and that module exists', () => {
    for (const kind of ALL_OP_KINDS) {
      const g = CANVAS_UI_GESTURES[kind];
      const abs = path.resolve(__dirname, '../..', g.module);
      expect(fs.existsSync(abs), `${kind} → ${g.module}`).toBe(true);
      if (g.status !== 'shipped') { continue; }
      expect(fs.readFileSync(abs, 'utf8').includes(`op: '${kind}'`), `${kind} is not built in ${g.module}`).toBe(true);
    }
  });

  /**
   * Review F5 — THE GUARD.
   *
   * Nine of the eighteen variants have no human producer, and the leg-(b)
   * structural check skips exactly those (`status !== 'shipped'` → `continue`),
   * so the suite reported green on "every variant has a gesture" while it had
   * only established "every variant has a gesture *declared*". Asserting the
   * absence of the pending gestures would break the moment one lands, so the
   * honest guard is to pin the SET: shipping a gesture, or adding a tenth
   * agent-only op, must both be a red test and a deliberate edit here.
   *
   * When you ship one, delete its line. When you add an op the human cannot
   * perform, you have to add one — and explain why in review.
   */
  const AGENT_ONLY_TODAY: readonly CanvasOpKindV2[] = [
    'page.move',          // no artboard drag on the board
    'page.setDoc',        // no paste-replace
    'el.insert',          // no primitive palette
    'el.remove',          // no Delete/Backspace binding anywhere in the shell
    'el.move',            // no drag-to-reparent
    'el.replace',         // no "swap primitive" in the inspector
    'theme.setToken',     // no per-token swatch editor
    'artifact.setFormat', // the device picker is per-artboard only
    'asset.add',          // no image drop
  ];

  it('the set of ops the AGENT can do and the human cannot is exactly this, and no wider', () => {
    const pending = ALL_OP_KINDS.filter(k => CANVAS_UI_GESTURES[k].status !== 'shipped').sort();
    expect(pending).toEqual([...AGENT_ONLY_TODAY].sort());
  });

  it('and none of them is quietly constructed somewhere — the gap is real, not a stale label', () => {
    const src = webviewSource();
    for (const kind of AGENT_ONLY_TODAY) {
      expect(src.includes(`op: '${kind}'`), `${kind} IS built in the webview — flip it to shipped`).toBe(false);
    }
  });

  it('the webview op constructors emit records the SAME executor accepts', () => {
    const h = harness();
    const { pageId } = seedPage(h);
    const doc = h.store.getPage(h.artifact, pageId)!.doc;
    const mid = firstTextMid(h, pageId);

    // One gesture per family, taken from the webview's own helpers.
    const gestures: CanvasOpV2[] = [
      ...addPageOps({ title: 'From the rail' }),
      ...duplicatePageOps(pageId),
      ...controlOps(pageId, [mid], TEXT_CONTROL, 'typed by a human'),
      ...nudgeOps(pageId, doc, [doc.children![0].mid], 4, 0),
      ...changeTheme(JSON.parse(JSON.stringify(h.artifact.theme))),
      ...changeDevice({ zoom: 1, pan: { x: 0, y: 0 }, previewFormat: null }, 'artboard', h.artifact.format, pageId).ops,
    ];
    expect(gestures.length).toBeGreaterThanOrEqual(6);

    for (const op of gestures) {
      const receipt = h.executor.submitOp(h.artifact, { op, runId: 'human', author: 'user' }, 'job-1', 'auto');
      expect(receipt.status, op.op).toBe('applied');
    }

    // Review F5: `el.setProp` was the one SHIPPED gesture this round-trip never
    // executed — its claim rested entirely on a substring match. Take the
    // descriptor out of the inspector's own generated model so the control the
    // human actually sees is the thing under test.
    const propControl = buildControlModel([findNode(doc, midByTag(h, pageId, 'UI.Badge'))!])
      .sections.flatMap(s => s.controls)
      .find(c => c.target.kind === 'prop');
    expect(propControl, 'the inspector generates no prop control for UI.Badge').toBeDefined();
    const [propOp] = controlOps(pageId, [midByTag(h, pageId, 'UI.Badge')], propControl!, 'renamed by a human');
    expect(propOp.op).toBe('el.setProp');
    expect(h.executor.submitOp(h.artifact, { op: propOp, runId: 'human', author: 'user' }, 'job-1', 'auto').status).toBe('applied');

    // …and the rail reorder / delete, which need the ids that now exist.
    const ids = h.artifact.pages.map(p => p.id);
    const reorder = railReorderOps(ids, [...ids].reverse());
    expect(reorder).toHaveLength(1);
    expect(h.executor.submitOp(h.artifact, { op: reorder[0], runId: 'human', author: 'user' }, 'job-1', 'auto').status).toBe('applied');

    const [remove] = removePageOps(ids[ids.length - 1]);
    expect(h.executor.submitOp(h.artifact, { op: remove, runId: 'human', author: 'user' }, 'job-1', 'auto').status).toBe('applied');
    expect(h.artifact.pages.map(p => p.id)).not.toContain(ids[ids.length - 1]);
  });

  it('a human write pins the cell, and the agent tool is then refused (§3.5)', () => {
    const h = harness();
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);

    // The human types into the element through the inspector's own control.
    const [humanOp] = controlOps(pageId, [mid], TEXT_CONTROL, 'Human wrote this');
    expect(h.executor.submitOp(h.artifact, { op: humanOp, runId: 'human', author: 'user' }, 'job-1', 'auto').status).toBe('applied');

    // The agent's identical op is refused, and the refusal REACHES it.
    const refused = dispatchCanvasTool('set_text', { pageId, mid, text: 'Agent wrote this' }, h.ctx);
    expect(refused.ok).toBe(false);
    expect(refused.receipt?.pinned).toEqual(['text']);
    expect(refused.dropped?.[0]).toMatchObject({ mid, cell: 'text', reason: 'pinned-by-human' });
    expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.text).toBe('Human wrote this');
    expect(JSON.stringify(canvasToolPayload(refused, 'auto'))).toContain('pinned');

    // Naming the cell in `force` is how the agent overrides it — and only then.
    const forced = dispatchCanvasTool('set_text', { pageId, mid, text: 'Agent wrote this', force: ['text'] }, h.ctx);
    expect(forced.ok, forced.error).toBe(true);
    expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.text).toBe('Agent wrote this');
  });
});

/* ═══════════════════ (c) every prompt example round-trips ══════════════════ */

describe('conformance (c) — every example in the system prompt round-trips to a valid op', () => {
  const NONCE = 'abc123nonce';

  function renderedBlock(): string {
    const h = harness();
    seedPage(h);
    return buildCanvasContextBlock({ artifact: h.artifact, approvalMode: 'auto', nonce: NONCE });
  }

  /** Pull the examples back OUT of the rendered prompt — what the model reads. */
  function parseExamples(block: string): Array<{ tool: string; args: Record<string, unknown> }> {
    const out: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const canvasRe = new RegExp(`<canvas:${NONCE} tool="([^"]+)">([\\s\\S]*?)</canvas>`, 'g');
    for (const m of block.matchAll(canvasRe)) {
      out.push({ tool: m[1], args: JSON.parse(m[2]) as Record<string, unknown> });
    }
    const pageRe = new RegExp(`<canvaspage:${NONCE}([^>]*)>([\\s\\S]*?)</canvaspage>`, 'g');
    for (const m of block.matchAll(pageRe)) {
      const attrs = m[1];
      const args: Record<string, unknown> = { jsx: m[2] };
      const page = /\bpage="([^"]*)"/.exec(attrs);
      const title = /\btitle="([^"]*)"/.exec(attrs);
      if (page) { args.pageId = page[1]; }
      if (title) { args.actionTitle = title[1]; }
      out.push({ tool: 'write_page', args });
    }
    return out;
  }

  it('renders every declared example into the block', () => {
    const parsed = parseExamples(renderedBlock());
    expect(parsed).toHaveLength(CANVAS_PROMPT_EXAMPLES.length);
  });

  it('every example names a tool the dispatcher serves', () => {
    for (const ex of parseExamples(renderedBlock())) {
      const isSession = (CANVAS_SESSION_TOOL_NAMES as readonly string[]).includes(ex.tool);
      expect(Boolean(getCanvasTool(ex.tool)) || isSession, ex.tool).toBe(true);
      expect(isKnownCanvasTool(ex.tool), ex.tool).toBe(true);
      expect(normalizeCanvasToolName(ex.tool), ex.tool).toBe(ex.tool);
    }
  });

  it('every example satisfies its own schema on whichever lane can carry it', () => {
    for (const ex of parseExamples(renderedBlock())) {
      if (CANVAS_NATIVE_EXCLUDED.has(ex.tool)) {
        // Whole artboards ride the TEXT directive; the native lane must refuse
        // them with a pointer rather than half-accept a truncated page.
        const refused = toolCallToDirective(`${CANVAS_TOOL_PREFIX}${ex.tool}`, ex.args);
        expect('error' in refused, ex.tool).toBe(true);
        continue;
      }
      const directive = toolCallToDirective(`${CANVAS_TOOL_PREFIX}${ex.tool}`, ex.args);
      expect(directive, ex.tool).not.toHaveProperty('error');
      expect(directive).toMatchObject({ kind: 'canvas', tool: ex.tool });
    }
  });

  it('every example survives the TEXT directive path too — the two lanes converge', () => {
    for (const ex of parseExamples(renderedBlock())) {
      const call = canvasDirectiveToToolCall({ kind: 'canvas', tool: ex.tool, args: ex.args });
      expect(isCanvasDirectiveError(call), ex.tool).toBe(false);
      if (isCanvasDirectiveError(call)) { continue; }
      expect(call.tool).toBe(ex.tool);
      expect(call.args).toEqual(ex.args);
    }
  });

  it('every example EXECUTES against a live artifact (ids substituted, shape verbatim)', () => {
    for (const ex of parseExamples(renderedBlock())) {
      const h = harness();
      const { pageId } = seedPage(h);
      const doc = h.store.getPage(h.artifact, pageId)!.doc;
      const mid = firstTextMid(h, pageId);

      // Only the placeholder IDs are rewritten — every other key, and the whole
      // argument shape, is exactly what the model is shown.
      const args: Record<string, unknown> = { ...ex.args };
      if (typeof args.pageId === 'string') { args.pageId = pageId; }
      if (typeof args.mid === 'string') { args.mid = mid; }
      if (typeof args.parentMid === 'string') { args.parentMid = doc.mid; }

      const res = dispatchCanvasTool(ex.tool, args, h.ctx);
      expect(res.ok, `${ex.tool}: ${res.error}`).toBe(true);
      expect(res.error).toBeUndefined();
    }
  });

  it('the example mids are syntactically valid ids, not prose', () => {
    // A worked example carrying an unparseable mid teaches a call that can only
    // ever fail — the exact failure mode this suite exists to prevent.
    for (const ex of CANVAS_PROMPT_EXAMPLES) {
      for (const key of ['mid', 'parentMid'] as const) {
        const v = ex.args[key];
        if (typeof v === 'string' && v !== 'end') { expect(isMid(v), `${ex.tool}.${key}`).toBe(true); }
      }
    }
  });

  it('the block quotes the pin rule and the ⟂user-set marker the reads actually emit', () => {
    const h = harness();
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);
    const [humanOp] = controlOps(pageId, [mid], TEXT_CONTROL, 'mine');
    h.executor.submitOp(h.artifact, { op: humanOp, runId: 'human', author: 'user' }, 'job-1', 'auto');

    const read = dispatchCanvasTool('get_page_jsx', { pageId }, h.ctx);
    const jsx = (read.data as { jsx: string }).jsx;
    expect(jsx).toContain('⟂user-set:');
    expect(jsx).toContain('mid="');

    const block = buildCanvasContextBlock({ artifact: h.artifact, approvalMode: 'auto' });
    expect(block).toContain('⟂user-set');
    expect(block).toContain('force');
  });

  /**
   * Review F2 — leg (c) applied to the pin rule's PROSE.
   *
   * The rule is the only place `force` is taught, and it is taught as a worked
   * spelling rather than as a machine-readable example, so the round-trip above
   * never touched it. Its `force: […]` literals go through the real dispatcher
   * here for the same reason every other example does: prose that teaches a
   * call the dispatcher refuses burns a run and reports nothing useful.
   */
  it('every force spelling the pin rule teaches is accepted by the tool it is taught for', () => {
    const spellings = [...CANVAS_PIN_RULE.matchAll(/force:\s*\["([^"]+)"\]/g)].map(m => m[1]);
    expect(spellings.length, 'the pin rule teaches no force spelling at all').toBeGreaterThanOrEqual(2);

    for (const spelling of spellings) {
      const h = harness();
      const { pageId } = seedPage(h);
      const mid = firstTextMid(h, pageId);
      // The human owns the cell the spelling names.
      const cell = spelling.includes(':') ? spelling.slice(spelling.indexOf(':') + 1) : spelling;
      const prop = cell.startsWith('style.') ? cell.slice('style.'.length) : null;
      const [humanOp] = prop
        ? controlOps(pageId, [mid], { ...TEXT_CONTROL, id: `style:${prop}`, cell, target: { kind: 'style', prop } }, '#ff0000')
        : controlOps(pageId, [mid], TEXT_CONTROL, 'Human copy');
      expect(h.executor.submitOp(h.artifact, { op: humanOp, runId: 'human', author: 'user' }, 'job-1', 'auto').status).toBe('applied');

      if (spelling.includes(':')) {
        // The write_page spelling — substituting only the placeholder mid.
        const src = emit(h.store.getPage(h.artifact, pageId)!.doc, { mids: true })
          .replace(/Human copy/, 'Agent copy')
          .replace(/#ff0000/g, '#00ff00');
        const res = dispatchCanvasTool('write_page', { pageId, jsx: src, force: [`${mid}:${cell}`] }, h.ctx);
        expect(res.ok, `write_page force "${spelling}": ${res.error}`).toBe(true);
      } else {
        const res = prop
          ? dispatchCanvasTool('set_style', { pageId, mid, style: { [prop]: '#00ff00' }, force: [spelling] }, h.ctx)
          : dispatchCanvasTool('set_text', { pageId, mid, text: 'Agent copy', force: [spelling] }, h.ctx);
        expect(res.ok, `element-op force "${spelling}": ${res.error}`).toBe(true);
      }
    }
  });
});

/* ═══════════════════════════ surface ⇄ prompt ⇄ lanes ══════════════════════ */

describe('the catalog, the guide and the native lane cannot drift', () => {
  it('the tool guide names every offered tool and no superseded one', () => {
    const guide = buildCanvasToolGuide();
    for (const t of offeredCanvasTools()) {
      expect(guide, t.name).toContain(t.name);
    }
    for (const t of CANVAS_TOOL_SURFACE.filter(t => t.tier === 'compat')) {
      // `write_page_jsx` contains `write_page`, so match on a word boundary.
      expect(new RegExp(`\\b${t.name}\\b`).test(guide), t.name).toBe(false);
    }
  });

  it('every catalog tool is dispatchable — no descriptor without an implementation', () => {
    const h = harness();
    seedPage(h);
    for (const t of CANVAS_TOOLS) {
      const res = dispatchCanvasTool(t.name, {}, h.ctx);
      // Called with no arguments almost everything fails — but never with the
      // two errors that mean "this tool does not exist".
      expect(res.error ?? '', t.name).not.toContain('unknown canvas tool');
      expect(res.error ?? '', t.name).not.toContain('unhandled canvas tool');
    }
  });

  it('descriptions carry the access prefix every transport contract promises', () => {
    for (const t of CANVAS_TOOLS) {
      expect(t.description.startsWith(t.access === 'read-only' ? 'READ-ONLY' : 'WRITE'), t.name).toBe(true);
    }
  });

  it('every required argument of every tool is a declared property', () => {
    for (const t of CANVAS_TOOLS) {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      for (const req of schema.required ?? []) {
        expect(schema.properties, `${t.name}.${req}`).toHaveProperty(req);
      }
    }
  });

  it('tool names are unique and lane-safe', () => {
    const seen = new Set<string>();
    for (const t of CANVAS_TOOLS) {
      expect(seen.has(t.name), t.name).toBe(false);
      seen.add(t.name);
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(`${CANVAS_TOOL_PREFIX}${t.name}`).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  /* ── R4-4: the schema a transport publishes must be a call that can land ── */

  it('every tool that can commit a whole-artboard write publishes the SCOPED force spelling', () => {
    // `write_page` and its alias share one dispatcher, which runs
    // `parseScopedForce` — a bare cell name there is guaranteed to fail. A
    // schema is published to MCP-connected CLI agents verbatim (`listMcpTools`
    // publishes the whole catalog, compat tier included), so teaching the bare
    // form is teaching a call the executor rejects.
    const wholeArtboard = CANVAS_TOOL_SURFACE.filter(t => t.produces.includes('page.setDoc'));
    expect(wholeArtboard.length).toBeGreaterThanOrEqual(2);
    for (const t of wholeArtboard) {
      const force = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties?.force;
      expect(force, `${t.name} takes force`).toBeTruthy();
      expect(force?.description ?? '', `${t.name}.force`).toContain('<mid>:<cell>');
    }
  });

  it('the force spelling each schema TEACHES is the one its dispatcher accepts', () => {
    for (const t of CANVAS_TOOL_SURFACE) {
      const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      if (!props.force) { continue; }
      const scoped = /<mid>:<cell>/.test(props.force.description ?? '');

      const h = harness();
      const { pageId } = seedPage(h);
      const mid = firstTextMid(h, pageId);
      // The human owns the very cell this call will write, so the pin gate is
      // live and `force` is the ONLY thing that can carry the write through.
      const cell = t.name === 'set_style' ? 'style.color' : (t.name === 'set_prop' ? 'props.label' : 'text');
      const humanOp: CanvasOpV2 = cell === 'text'
        ? { op: 'el.setText', pageId, mid, text: 'Human copy' }
        : (cell === 'style.color'
          ? { op: 'el.setStyle', pageId, mid, style: { color: '#ff0000' } }
          : { op: 'el.setProp', pageId, mid, name: 'label', value: 'Human label' });
      expect(h.executor.submitOp(h.artifact, { op: humanOp, runId: 'human', author: 'user' }, 'job-1', 'auto').status)
        .toBe('applied');

      const force = [scoped ? `${mid}:${cell}` : cell];
      let args: Record<string, unknown>;
      switch (t.name) {
        case 'write_page':
        case 'write_page_jsx':
          args = {
            pageId,
            force,
            jsx: emit(h.store.getPage(h.artifact, pageId)!.doc, { mids: true }).replace('Human copy', 'Agent copy'),
          };
          break;
        case 'set_text': args = { pageId, mid, text: 'Agent copy', force }; break;
        case 'set_style': args = { pageId, mid, style: { color: '#00ff00' }, force }; break;
        case 'set_prop': args = { pageId, mid, name: 'label', value: 'Agent label', force }; break;
        case 'replace_element': args = { pageId, mid, node: { tag: 'UI.Heading', text: 'Agent copy' }, force }; break;
        // A new force-taking tool must declare how it is called here, or this
        // conformance is silently narrower than the catalog.
        default: throw new Error(`add a call shape for ${t.name} — it publishes a force argument`);
      }

      const res = dispatchCanvasTool(t.name, args, h.ctx);
      expect(res.ok, `${t.name} published a force spelling its own dispatcher refuses: ${res.error}`).toBe(true);
    }
  });
});

/* ═════════════════════════ write_page: the diff path ══════════════════════ */

describe('write_page — compile → reconcile → diff → element ops', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('creates an artboard when no pageId is given', () => {
    const res = dispatchCanvasTool('write_page', { jsx: PAGE_SRC, actionTitle: 'Sign in' }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(h.artifact.pages).toHaveLength(1);
    expect((res.data as { created: boolean }).created).toBe(true);
  });

  it('turns a whole-page rewrite into ELEMENT ops, preserving untouched mids', () => {
    const { pageId } = seedPage(h);
    const before = h.store.getPage(h.artifact, pageId)!.doc;
    const src = emit(before, { mids: true }).replace('Welcome back', 'Welcome to Acme');

    const res = dispatchCanvasTool('write_page', { pageId, jsx: src }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    const data = res.data as { applied: number; opKinds: string[] };
    // ONE cell changed → one element op, not a page replacement.
    expect(data.applied).toBe(1);
    expect(data.opKinds).toEqual(['el.setText']);

    const after = h.store.getPage(h.artifact, pageId)!.doc;
    expect([...walk(after)].map(n => n.mid)).toEqual([...walk(before)].map(n => n.mid));
  });

  it('reports {applied, dropped} instead of silently reverting a human cell', () => {
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);
    const [humanOp] = controlOps(pageId, [mid], TEXT_CONTROL, 'Human copy');
    h.executor.submitOp(h.artifact, { op: humanOp, runId: 'human', author: 'user' }, 'job-1', 'auto');

    const current = h.store.getPage(h.artifact, pageId)!.doc;
    const src = emit(current, { mids: true }).replace('Human copy', 'Agent copy');
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src }, h.ctx);

    const data = res.data as { applied: number; dropped: Array<{ cell?: string; reason: string }> };
    expect(data.applied).toBe(0);
    expect(data.dropped.some(d => d.cell === 'text' && d.reason === 'pinned-by-human')).toBe(true);
    expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.text).toBe('Human copy');
    // …and the report reaches the model rather than a console.
    expect(JSON.stringify(canvasToolPayload(res, 'auto'))).toContain('pinned-by-human');
  });

  it('applies a pinned cell when the user asked for it and the agent names it in force', () => {
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);
    const [humanOp] = controlOps(pageId, [mid], TEXT_CONTROL, 'Human copy');
    h.executor.submitOp(h.artifact, { op: humanOp, runId: 'human', author: 'user' }, 'job-1', 'auto');

    const current = h.store.getPage(h.artifact, pageId)!.doc;
    const src = emit(current, { mids: true }).replace('Human copy', 'Agent copy');
    // Review F2: on a WHOLE-artboard rewrite the override names the element as
    // well as the cell. A bare `['text']` here would have meant "every element
    // on this artboard", which is how one legitimate override reverted the
    // human's other edits.
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, force: [`${mid}:text`] }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.text).toBe('Agent copy');
  });

  it('refuses a stale write with the version the writer needs, rather than clobbering', () => {
    const { pageId } = seedPage(h);
    dispatchCanvasTool('set_text', { pageId, mid: firstTextMid(h, pageId), text: 'moved on' }, h.ctx);
    const res = dispatchCanvasTool('write_page', { pageId, jsx: PAGE_SRC, baseVersion: 1 }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('v1');
    expect(res.error).toMatch(/get_page_jsx/);
  });

  it('says so — without an op — when the source already matches', () => {
    const { pageId } = seedPage(h);
    const src = emit(h.store.getPage(h.artifact, pageId)!.doc, { mids: true });
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src }, h.ctx);
    expect(res.ok).toBe(true);
    expect((res.data as { applied: number }).applied).toBe(0);
    expect(res.op).toBeUndefined();
  });

  it('rejects imports and non-Page sources on both names', () => {
    for (const tool of ['write_page', 'write_page_jsx']) {
      expect(dispatchCanvasTool(tool, { jsx: "import React from 'react';\nfunction Page(){return null;}" }, h.ctx).error)
        .toContain('import');
      expect(dispatchCanvasTool(tool, { jsx: 'const x = 1;' }, h.ctx).error).toContain('function Page()');
    }
  });
});

/* ═════════════════════════════ reads ══════════════════════════════════════ */

describe('reads the agent orients with', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('get_page_jsx returns mid-annotated, pin-annotated source', () => {
    const { pageId } = seedPage(h);
    const res = dispatchCanvasTool('get_page_jsx', { pageId }, h.ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { jsx: string; baseVersion: number };
    expect(data.jsx).toContain('function Page()');
    expect(data.jsx).toContain('mid="');
    expect(data.baseVersion).toBe(1);
  });

  it('get_page_jsx is honest about a code page instead of pretending it is editable', () => {
    const page = h.store.insertPage(h.artifact, h.store.makePage({ mode: 'html', htmlSource: '<h1>x</h1>' }));
    const data = dispatchCanvasTool('get_page_jsx', { pageId: page.id }, h.ctx).data as { legacy: boolean; note: string };
    expect(data.legacy).toBe(true);
    expect(data.note).toContain('write_page');
  });

  it('get_node reads one subtree, and refuses an unknown mid', () => {
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);
    const data = dispatchCanvasTool('get_node', { pageId, mid }, h.ctx).data as { mid: string; jsx: string };
    expect(data.mid).toBe(mid);
    expect(data.jsx).toContain(`mid="${mid}"`);
    expect(dispatchCanvasTool('get_node', { pageId, mid: 'zzzzzzzzzz' }, h.ctx).ok).toBe(false);
  });

  it('find_nodes turns prose into a mid', () => {
    const { pageId } = seedPage(h);
    const res = dispatchCanvasTool('find_nodes', { text: 'welcome' }, h.ctx);
    const data = res.data as { matches: Array<{ mid: string; pageId: string; tag: string }> };
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].pageId).toBe(pageId);
    expect(isMid(data.matches[0].mid)).toBe(true);
    expect(dispatchCanvasTool('find_nodes', {}, h.ctx).ok).toBe(false);
  });

  it('find_nodes clamps a hostile limit instead of walking every artboard forever', () => {
    seedPage(h);
    const res = dispatchCanvasTool('find_nodes', { tag: 'UI.Text', limit: 10_000_000 }, h.ctx);
    expect(res.ok).toBe(true);
    expect((res.data as { matches: unknown[] }).matches.length).toBeLessThanOrEqual(500);
  });

  it('checkpoint says what is missing rather than failing silently', () => {
    const res = dispatchCanvasTool('checkpoint', { label: 'before dark theme' }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('history');
    expect(dispatchCanvasTool('checkpoint', {}, h.ctx).error).toContain('label');
  });
});

/* ═════════════════════ adversarial argument handling ══════════════════════ */

describe('untrusted arguments', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('a prototype-polluting style map cannot reach Object.prototype', () => {
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);
    // A JSON payload can carry an OWN `__proto__` key; a naive `obj[k] = v`
    // would invoke the prototype setter instead of creating a property.
    const style = JSON.parse('{"__proto__":"red","color":"blue"}') as Record<string, unknown>;
    const res = dispatchCanvasTool('set_style', { pageId, mid, style }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    const node = findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!;
    expect(node.style?.color).toBe('blue');
    // Whatever the host did with the hostile key, it stayed an OWN property.
    expect(Object.keys(node.style ?? {}).every(k => Object.prototype.hasOwnProperty.call(node.style, k))).toBe(true);
    // A non-scalar value is refused outright rather than coerced.
    expect(dispatchCanvasTool('set_style', { pageId, mid, style: { color: { nested: 1 } } }, h.ctx).ok).toBe(false);
  });

  it('a forged mid is refused, not silently retargeted', () => {
    const { pageId } = seedPage(h);
    const res = dispatchCanvasTool('set_text', { pageId, mid: 'aaaaaaaaaa', text: 'hi' }, h.ctx);
    expect(res.ok).toBe(false);
  });

  it('a cross-artifact pageId is refused', () => {
    const res = dispatchCanvasTool('set_text', { pageId: 'not-mine', mid: 'aaaaaaaaaa', text: 'hi' }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not-mine');
  });

  it('insert_element demands a real element, not a bare string or an array', () => {
    const { pageId } = seedPage(h);
    const parentMid = h.store.getPage(h.artifact, pageId)!.doc.mid;
    expect(dispatchCanvasTool('insert_element', { pageId, parentMid }, h.ctx).error).toContain('node');
    expect(dispatchCanvasTool('insert_element', { pageId, parentMid, node: [] }, h.ctx).ok).toBe(false);
    expect(dispatchCanvasTool('insert_element', { pageId, parentMid, node: { props: {} } }, h.ctx).error).toContain('tag');
    expect(dispatchCanvasTool('insert_element', { pageId, parentMid, jsx: 'not jsx at all {' }, h.ctx).ok).toBe(false);
  });

  it('move_page refuses a non-finite board position', () => {
    const { pageId } = seedPage(h);
    expect(dispatchCanvasTool('move_page', { pageId, x: 'NaN', y: 0 }, h.ctx).ok).toBe(false);
    expect(dispatchCanvasTool('move_page', { pageId, x: Infinity, y: 0 }, h.ctx).ok).toBe(false);
  });

  it('set_theme_token cannot address a prototype path', () => {
    const res = dispatchCanvasTool('set_theme_token', { path: '__proto__.polluted', value: 'yes' }, h.ctx);
    expect(res.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('set_page_meta refuses a patch that names nothing', () => {
    const { pageId } = seedPage(h);
    expect(dispatchCanvasTool('set_page_meta', { pageId }, h.ctx).error).toContain('at least one');
  });

  it('force is only ever an explicit list of cells — `true` grants nothing', () => {
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);
    const [humanOp] = controlOps(pageId, [mid], TEXT_CONTROL, 'Human copy');
    h.executor.submitOp(h.artifact, { op: humanOp, runId: 'human', author: 'user' }, 'job-1', 'auto');
    const res = dispatchCanvasTool('set_text', { pageId, mid, text: 'Agent copy', force: true }, h.ctx);
    expect(res.ok).toBe(false);
    expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.text).toBe('Human copy');
  });
});

/* ═══════════════ the text lane reaches the same element-op path ═══════════ */

describe('the <canvaspage:NONCE> lane lands on the element-op path', () => {
  it('a whole-artboard directive rewrites an EXISTING page as element ops', () => {
    const h = harness();
    const { pageId } = seedPage(h);
    const before = h.store.getPage(h.artifact, pageId)!.doc;
    const src = emit(before, { mids: true }).replace('Welcome back', 'Welcome to Acme');

    // Exactly the normalization `_runMystiCanvasTool` performs.
    const call = canvasDirectiveToToolCall({ kind: 'canvaspage', pageId, title: 'Sign in', source: src });
    expect(isCanvasDirectiveError(call)).toBe(false);
    if (isCanvasDirectiveError(call)) { return; }

    const res = dispatchCanvasTool(call.tool, call.args, h.ctx);
    expect(res.ok, res.error).toBe(true);
    // One cell changed → one ELEMENT op, and every other mid survived.
    expect((res.data as { opKinds: string[] }).opKinds).toEqual(['el.setText']);
    const after = h.store.getPage(h.artifact, pageId)!.doc;
    expect([...walk(after)].map(n => n.mid)).toEqual([...walk(before)].map(n => n.mid));
  });

  it('the same directive with no page id creates an artboard (nothing to diff, nothing pinned)', () => {
    const h = harness();
    const call = canvasDirectiveToToolCall({ kind: 'canvaspage', title: 'Login', source: PAGE_SRC });
    expect(isCanvasDirectiveError(call)).toBe(false);
    if (isCanvasDirectiveError(call)) { return; }
    const res = dispatchCanvasTool(call.tool, call.args, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(h.artifact.pages).toHaveLength(1);
    expect(h.artifact.pages[0].actionTitle).toBe('Login');
    // …and the op is in the artifact log, so the turn is attributable and undoable.
    expect(h.artifact.opLog.some(o => o.runId === 'run-1' && o.status === 'applied')).toBe(true);
  });

  it('the model-facing payload states whether the document changed and what was dropped', () => {
    const h = harness();
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);

    const applied = canvasToolPayload(dispatchCanvasTool('set_text', { pageId, mid, text: 'x' }, h.ctx), 'auto');
    expect(applied).toMatchObject({ ok: true, approvalMode: 'auto' });
    expect((applied.receipt as { status: string }).status).toBe('applied');

    const read = canvasToolPayload(dispatchCanvasTool('list_pages', {}, h.ctx), 'auto');
    expect(read.ok).toBe(true);
    expect(read.op).toBeUndefined();

    const failed = canvasToolPayload(dispatchCanvasTool('set_text', { pageId, mid: 'zzzzzzzzzz', text: 'x' }, h.ctx), 'auto');
    expect(failed.ok).toBe(false);
    expect(String(failed.error)).toBeTruthy();
  });

  it('staged mode does not land the edit, and says so', () => {
    const h = harness();
    const { pageId } = seedPage(h);
    const mid = firstTextMid(h, pageId);
    const stagedCtx: CanvasToolContext = { ...h.ctx, approvalMode: 'staged' };
    const res = dispatchCanvasTool('set_text', { pageId, mid, text: 'later' }, stagedCtx);
    expect(res.receipt?.status).toBe('staged');
    expect(res.op?.status).toBe('pending');
    expect(canvasToolPayload(res, 'staged').ok).toBe(false);
    expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, mid)!.text).not.toBe('later');
  });
});
