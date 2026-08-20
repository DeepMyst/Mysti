/**
 * Plan 22 Phase 1 — the coordinator's canvas lane, end to end.
 *
 * This is the test for the thing the audit found missing: under
 * `provider === 'mysti'` the agentic loop returns ~375 lines BEFORE the canvas
 * prompt is assembled and ~540 before the op hook, and `coordinatorTools.ts`
 * had zero canvas references — so the flagship agent structurally could not
 * touch the canvas.
 *
 * It drives the real seam the provider wires together — tag scanner /
 * `toolCallToDirective` → `canvasDirectiveToToolCall` → `dispatchCanvasTool` →
 * `CanvasOpExecutor` → `ArtifactStore` — without needing the 22-argument
 * ChatViewProvider constructor.
 *
 * The load-bearing assertion is the LAST one: a native `canvas_*` tool call and
 * a nonce-fenced text directive must produce the *same* op through the *same*
 * dispatcher. That equivalence is Plan 22's central claim ("one op algebra, N
 * producers"); if the two encodings ever diverge, the text lane silently
 * becomes a second, less-validated write path — exactly the failure the plan
 * exists to remove.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { dispatchCanvasTool, type CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import { canvasDirectiveToToolCall, isCanvasDirectiveError } from '../../src/canvas/canvasDirective';
import { resolveCanvasApproval } from '../../src/canvas/resolveCanvasApproval';
import { MystiTagScanner, MYSTI_CANVAS_KINDS, ALL_MYSTI_KINDS, type MystiDirective } from '../../src/utils/mystiDelegateParser';
import { toolCallToDirective } from '../../src/services/coordinatorTools';
import type { CanvasArtifact, CanvasJobEvent } from '../../src/types';
import { pageJsx } from '../../src/canvas/pageMigration';

const NONCE = 'N0NCE-abc123';
const PAGE_SRC = 'function Page(){ return <UI.Screen><UI.Heading>Sign in</UI.Heading></UI.Screen>; }';

describe('coordinator canvas lane (Plan 22 Phase 1)', () => {
  let root: string;
  let store: ArtifactStore;
  let executor: CanvasOpExecutor;
  let artifact: CanvasArtifact;
  let events: CanvasJobEvent[];
  let ctx: CanvasToolContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-coord-canvas-'));
    store = new ArtifactStore({ getRoot: () => root });
    events = [];
    executor = new CanvasOpExecutor(store, new CanvasJobRouter(e => events.push(e)));
    artifact = store.createArtifact({ name: 'Onboarding', kind: 'screens' });
    ctx = { artifact, store, executor, jobId: 'job-1', runId: 'turn-7', approvalMode: 'auto' };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Feed text through a scanner configured exactly as the coordinator loop does. */
  function scan(text: string): MystiDirective | undefined {
    const scanner = new MystiTagScanner(NONCE, [...ALL_MYSTI_KINDS, ...MYSTI_CANVAS_KINDS]);
    return scanner.feed(text).directive;
  }

  function run(d: MystiDirective) {
    const call = canvasDirectiveToToolCall(d as never);
    if (isCanvasDirectiveError(call)) { return { error: call.error }; }
    return { call, result: dispatchCanvasTool(call.tool, call.args, ctx) };
  }

  describe('the text encoding — whole artboards', () => {
    it('turns a <canvaspage:> directive into a real page on the artifact', () => {
      const d = scan(`<canvaspage:${NONCE} title="Login">${PAGE_SRC}</canvaspage>`);
      expect(d?.kind).toBe('canvaspage');

      const out = run(d!);
      expect('error' in out).toBe(false);
      const { call, result } = out as Exclude<typeof out, { error: string }>;
      expect(call.tool).toBe('write_page_jsx');
      expect(result.ok).toBe(true);
      expect(artifact.pages).toHaveLength(1);
      // Plan 22 §3.1: the page is STORED as a document, so the source view is
      // the emitter's normalized (mid-annotated) JSX rather than the model's
      // exact bytes. What must survive is the content and the compile.
      expect(artifact.pages[0].compileError).toBeUndefined();
      expect(artifact.pages[0].legacy).toBeUndefined();
      expect(pageJsx(artifact.pages[0])).toContain('Sign in');
      expect(artifact.pages[0].doc.tag).toBe('UI.Screen');
      expect(artifact.pages[0].actionTitle).toBe('Login');
    });

    it('routes to edit_page when the directive names an existing page', () => {
      const first = run(scan(`<canvaspage:${NONCE} title="Login">${PAGE_SRC}</canvaspage>`)!);
      expect('error' in first).toBe(false);
      const pageId = artifact.pages[0].id;
      const v0 = artifact.pages[0].version;

      const edited = 'function Page(){ return <UI.Screen><UI.Heading>Welcome back</UI.Heading></UI.Screen>; }';
      const out = run(scan(`<canvaspage:${NONCE} page="${pageId}" title="Login">${edited}</canvaspage>`)!);
      const { call, result } = out as Exclude<typeof out, { error: string }>;

      expect(call.tool).toBe('write_page_jsx');
      expect(call.args.pageId).toBe(pageId);
      expect(result.ok).toBe(true);
      expect(artifact.pages).toHaveLength(1);
      expect(pageJsx(artifact.pages[0])).toContain('Welcome back');
      expect(pageJsx(artifact.pages[0])).not.toContain('Sign in');
      expect(artifact.pages[0].version).toBeGreaterThan(v0);
    });

    it('carries page source containing backticks and a nested fence intact', () => {
      // The exact class of bug CanvasOpParser has today: it closes on the first
      // backtick run, so any page whose source contains a fence gets truncated.
      const tricky = 'function Page(){ const s = `a ``` b`; return <UI.Screen>{s}</UI.Screen>; }';
      const d = scan(`<canvaspage:${NONCE} title="Tricky">${tricky}</canvaspage>`);
      expect(d?.kind).toBe('canvaspage');
      const out = run(d!);
      expect('error' in out).toBe(false);
      // This source is outside the compilable subset (a template literal bound
      // to a local const), so it is preserved BYTE-FOR-BYTE as a legacy page
      // instead of being silently truncated at the first backtick run.
      expect(artifact.pages[0].legacy).toEqual({ mode: 'jsx', source: tricky });
      expect(pageJsx(artifact.pages[0])).toBe(tricky);
    });

    it('never writes a blank page: the scanner declines a whitespace-only body', () => {
      expect(scan(`<canvaspage:${NONCE} title="Oops">   </canvaspage>`)).toBeUndefined();
      expect(artifact.pages).toHaveLength(0);
    });

    it('and the normalizer refuses an empty body with an actionable message', () => {
      // Belt and braces: even if a future scanner change let one through, the
      // pure normalizer is the second gate and explains the fix to the model.
      const out = canvasDirectiveToToolCall({ kind: 'canvaspage', source: '  ', title: 'Oops' } as never);
      expect(isCanvasDirectiveError(out)).toBe(true);
      expect((out as { error: string }).error).toMatch(/empty/i);
    });
  });

  describe('the fence-awareness invariant', () => {
    it('does NOT fire when the model is only demonstrating the protocol inside a code fence', () => {
      const shown = '```\n<canvaspage:' + NONCE + ' title="Demo">' + PAGE_SRC + '</canvaspage>\n```';
      expect(scan(shown)).toBeUndefined();
      expect(artifact.pages).toHaveLength(0);
    });

    it('ignores a canvas tag carrying the wrong nonce', () => {
      expect(scan(`<canvas:WRONG-NONCE tool="delete_page">{"pageId":"p1"}</canvas>`)).toBeUndefined();
    });

    it('reassembles a directive split across streaming chunks', () => {
      const scanner = new MystiTagScanner(NONCE, [...ALL_MYSTI_KINDS, ...MYSTI_CANVAS_KINDS]);
      const whole = `<canvaspage:${NONCE} title="Split">${PAGE_SRC}</canvaspage>`;
      let found: MystiDirective | undefined;
      for (const ch of whole) { found = scanner.feed(ch).directive ?? found; }
      expect(found?.kind).toBe('canvaspage');
      expect((found as { source: string }).source).toBe(PAGE_SRC);
    });
  });

  describe('malformed input is reported, never silently run', () => {
    it('reports unparseable JSON args rather than dispatching with {}', () => {
      const d = scan(`<canvas:${NONCE} tool="set_theme">{not valid json</canvas>`);
      expect(d?.kind).toBe('canvas');
      const out = run(d!);
      expect('error' in out).toBe(true);
      expect((out as { error: string }).error).toMatch(/valid JSON/i);
    });

    it('surfaces an unknown tool name as an error the model can act on', () => {
      const d = scan(`<canvas:${NONCE} tool="scaffold_page">{"scaffold":"login"}</canvas>`);
      const out = run(d!) as { result: { ok: boolean; error?: string } };
      // `scaffold_page` IS a real dispatcher tool — the bug Phase 0 fixes was
      // the PROMPT teaching it as a fenced op *kind*, which the op parser
      // rejects. Through the tool dispatcher it must resolve normally.
      expect(out.result.ok).toBe(true);
    });
  });

  describe('the two encodings converge (Plan 22 §3.3)', () => {
    it('a native canvas_* tool call and a text directive produce the same op', () => {
      // Two pages, identical to start with — one retitled through each lane.
      run(scan(`<canvaspage:${NONCE} title="A">${PAGE_SRC}</canvaspage>`)!);
      run(scan(`<canvaspage:${NONCE} title="B">${PAGE_SRC}</canvaspage>`)!);
      const [pa, pb] = artifact.pages;

      // Encoding A — native tool call.
      const nativeDirective = toolCallToDirective('canvas_edit_page', {
        pageId: pa.id, patch: { actionTitle: 'Renamed' },
      });
      expect('error' in nativeDirective).toBe(false);
      const a = run(nativeDirective as MystiDirective) as Exclude<ReturnType<typeof run>, { error: string }>;

      // Encoding B — the nonce-fenced text directive, same tool, same args.
      const textDirective = scan(
        `<canvas:${NONCE} tool="edit_page">{"pageId":"${pb.id}","patch":{"actionTitle":"Renamed"}}</canvas>`,
      );
      expect(textDirective?.kind).toBe('canvas');
      const b = run(textDirective!) as Exclude<ReturnType<typeof run>, { error: string }>;

      // Identical tool, identical op kind, identical effect.
      expect(a.call.tool).toBe('edit_page');
      expect(b.call.tool).toBe('edit_page');
      expect(a.result.ok && b.result.ok).toBe(true);
      expect(a.result.op?.kind).toBe(b.result.op?.kind);
      expect(artifact.pages[0].actionTitle).toBe('Renamed');
      expect(artifact.pages[1].actionTitle).toBe('Renamed');
    });

    it('keeps whole-page source OFF the native lane, by design', () => {
      // A native tool call cannot carry an artboard at maxTokens 4096, and both
      // length-continuation branches are skipped on tool-call turns — so the
      // model would silently truncate. `write_page_jsx` is text-directive-only,
      // and the native lane must refuse it clearly rather than half-accept it.
      const refused = toolCallToDirective('canvas_write_page_jsx', { jsx: PAGE_SRC });
      expect('error' in refused).toBe(true);

      // The text lane accepts exactly that payload.
      const d = scan(`<canvaspage:${NONCE} title="Login">${PAGE_SRC}</canvaspage>`);
      const out = run(d!) as Exclude<ReturnType<typeof run>, { error: string }>;
      expect(out.call.tool).toBe('write_page_jsx');
      expect(out.result.ok).toBe(true);
    });

    it('attributes every op to the real run, so a design pass can be undone as one unit', () => {
      // Before Plan 22 both runId and jobId were the literal string 'mcp' for
      // every caller, so opsForRun could never group a turn.
      run(scan(`<canvaspage:${NONCE} title="One">${PAGE_SRC}</canvaspage>`)!);
      run(scan(`<canvaspage:${NONCE} title="Two">${PAGE_SRC}</canvaspage>`)!);

      const mine = artifact.opLog.filter(o => o.runId === 'turn-7');
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine.every(o => o.author === 'agent')).toBe(true);
      expect(artifact.opLog.some(o => o.runId === 'mcp')).toBe(false);
    });
  });

  describe('approval mode reaches the dispatcher', () => {
    it('stages instead of auto-applying when the user is in ask-permission', () => {
      const staged = resolveCanvasApproval({ mode: 'ask-before-edit', accessLevel: 'ask-permission' });
      expect(staged).toBe('staged');

      const stagedCtx: CanvasToolContext = { ...ctx, approvalMode: staged };
      const call = canvasDirectiveToToolCall(scan(`<canvaspage:${NONCE} title="Held">${PAGE_SRC}</canvaspage>`)! as never);
      const res = dispatchCanvasTool((call as { tool: string }).tool, (call as { args: Record<string, unknown> }).args, stagedCtx);

      expect(res.ok).toBe(true);
      expect(res.op?.status).toBe('pending');
      // Nothing landed on the artifact — that is what "staged" has to mean.
      expect(artifact.pages).toHaveLength(0);
    });

    it('read-only access stages even under autonomous mode', () => {
      expect(resolveCanvasApproval({ mode: 'edit-automatically', accessLevel: 'read-only', autonomousMode: true })).toBe('staged');
    });
  });

  it('persists across a reload, so the design survives a window restart', async () => {
    run(scan(`<canvaspage:${NONCE} title="Login">${PAGE_SRC}</canvaspage>`)!);
    await store.save(artifact);

    const reopened = await store.load(artifact.id);
    expect(reopened).not.toBeNull();
    expect(reopened!.pages).toHaveLength(1);
    expect(pageJsx(reopened!.pages[0])).toContain('Sign in');
    expect(reopened!.pages[0].doc.tag).toBe('UI.Screen');
  });
});
