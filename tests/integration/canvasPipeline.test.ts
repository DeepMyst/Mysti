/**
 * End-to-end canvas pipeline test (runnable demo).
 *
 * Drives the SAME path Plan 05 milestone M2 will wire to a live CLI — the
 * `mysti-canvas` MCP bridge → CanvasToolDispatch → CanvasOpExecutor →
 * ArtifactStore — to prove the built spine composes into a real workflow:
 * an agent builds a 3-page deck, validates it, the sub-agent prompt block
 * reflects the state, and the artifact survives a persist + reload (closes
 * F-16 at the data layer). Run with `npm test`; no webview, no MCP transport.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { listMcpTools, callMcpTool } from '../../src/managers/CanvasMcpBridge';
import { buildCanvasContextBlock } from '../../src/managers/CanvasPromptBuilder';
import { validateArtifact } from '../../src/managers/CanvasValidator';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact, CanvasJobEvent } from '../../src/types';

describe('canvas pipeline (end-to-end agent build)', () => {
  let root: string;
  let store: ArtifactStore;
  let executor: CanvasOpExecutor;
  let events: CanvasJobEvent[];
  let artifact: CanvasArtifact;
  let ctx: CanvasToolContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-canvas-e2e-'));
    store = new ArtifactStore({ getRoot: () => root });
    events = [];
    const router = new CanvasJobRouter(e => events.push(e));
    executor = new CanvasOpExecutor(store, router);
    artifact = store.createArtifact({ name: 'Fintech Pitch', kind: 'deck' });
    ctx = { artifact, store, executor, jobId: 'turn-1', runId: 'turn-1', approvalMode: 'auto' };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function call(name: string, args: Record<string, unknown> = {}) {
    return callMcpTool(name, args, ctx);
  }

  it('exposes the full mysti-canvas tool surface to MCP', () => {
    const tools = listMcpTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_page', 'insert_page', 'write_page_jsx', 'validate_page', 'set_theme']));
    // Every tool carries a READ-ONLY/WRITE-prefixed description + a schema.
    for (const t of tools) {
      expect(t.description).toMatch(/^(READ-ONLY|WRITE)/);
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it('an agent builds, validates, persists, and reloads a 3-page deck', () => {
    // 1. Orient — the artifact starts empty.
    const index0 = call('get_artifact_index');
    expect(index0.isError).toBeFalsy();
    expect(String((index0.structured as any).data)).toContain('pages=0');

    // 2. Set the brand theme once.
    const theme = JSON.parse(JSON.stringify(artifact.theme));
    theme.colors.primary = '#0B5FFF';
    expect(call('set_theme', { theme }).isError).toBeFalsy();
    expect(artifact.theme.colors.primary).toBe('#0B5FFF');

    // 3. Cover (html) + a JSX content slide + a closing page.
    const cover = call('insert_page', { page: { mode: 'html', htmlSource: '<h1>Acme</h1>', actionTitle: 'Title' } });
    expect((cover.structured as any).op.status).toBe('applied');
    expect(call('write_page_jsx', { jsx: 'function Page() { return <div>Market</div>; }', actionTitle: 'Market size' }).isError).toBeFalsy();
    call('insert_page', { page: { mode: 'html', htmlSource: '<h2>Thank you</h2>', actionTitle: 'Close' } });
    expect(artifact.pages).toHaveLength(3);

    // 4. Live updates reached the (webview) sink as the agent worked.
    expect(events.some(e => e.type === 'op_applied')).toBe(true);
    expect(events.some(e => e.type === 'page_updated')).toBe(true);

    // 5. Self-QA: validate_page is clean for titled pages.
    for (const p of artifact.pages) {
      const r = call('validate_page', { pageId: p.id });
      expect((r.structured as any).data.ok).toBe(true);
    }

    // 6. The sub-agent's prompt block reflects the live state.
    const block = buildCanvasContextBlock({ artifact, approvalMode: 'auto' });
    expect(block).toContain('pages=3');
    expect(block).toContain('Market size');
    expect(block).toContain('deck-16x9');

    // 7. Reorder via the tool, then persist + reload — reload-safe (F-16).
    const order = [artifact.pages[2].id, artifact.pages[0].id, artifact.pages[1].id];
    call('reorder_pages', { orderedIds: order });
    return store.save(artifact).then(async () => {
      const reloaded = await store.load(artifact.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.pages.map(p => p.id)).toEqual(order);
      expect(reloaded!.theme.colors.primary).toBe('#0B5FFF');
      expect(reloaded!.pages.find(p => p.actionTitle === 'Market size')!.mode).toBe('jsx');
      // The whole deck is defect-free per the static rules.
      expect(validateArtifact(reloaded!).filter(i => i.severity === 'error')).toHaveLength(0);
    });
  });

  it('surfaces a tool error as an MCP isError result (cross-artifact guard)', () => {
    const r = call('edit_page', { pageId: 'does-not-exist', patch: { htmlSource: 'x' } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('does not belong');
  });

  it('staged mode does not apply until accepted (approval gate)', () => {
    const staged: CanvasToolContext = { ...ctx, approvalMode: 'staged' };
    const r = callMcpTool('insert_page', { page: { mode: 'html', htmlSource: 'draft' } }, staged);
    expect((r.structured as any).op.status).toBe('pending');
    expect(artifact.pages).toHaveLength(0); // nothing lands until the user accepts
  });
});
