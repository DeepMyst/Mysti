/**
 * CanvasMcpBridge tests — the SDK-agnostic MCP shape over CanvasToolDispatch:
 * tools/list descriptors and tools/call result wrapping (success payloads,
 * op summaries, and isError mapping with the specific reason).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { listMcpTools, callMcpTool } from '../../src/managers/CanvasMcpBridge';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

describe('CanvasMcpBridge', () => {
  let store: ArtifactStore;
  let artifact: CanvasArtifact;
  let ctx: CanvasToolContext;
  let executor: CanvasOpExecutor;

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
    artifact = store.createArtifact({ name: 'Deck', kind: 'deck' });
    ctx = { artifact, store, executor, jobId: 'j', runId: 'r', approvalMode: 'auto' };
  });

  it('lists every dispatch tool with an MCP descriptor', () => {
    const tools = listMcpTools();
    expect(tools.length).toBeGreaterThanOrEqual(14);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(t.description).toMatch(/^(READ-ONLY|WRITE)/);
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('wraps a read tool result as text + structured data', () => {
    const r = callMcpTool('get_artifact_index', {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content[0].type).toBe('text');
    expect((r.structured as any).ok).toBe(true);
    expect(String((r.structured as any).data)).toContain('pages=0');
  });

  it('summarizes a write op (id/kind/status/page) without echoing the proposed value', () => {
    const r = callMcpTool('insert_page', { page: { mode: 'html', htmlSource: 'x' } }, ctx);
    const op = (r.structured as any).op;
    expect(op.kind).toBe('insert_page');
    expect(op.status).toBe('applied');
    expect(op.targetPageId).toBeTruthy();
    expect(JSON.parse(r.content[0].text).op.opId).toBe(op.opId);
  });

  it('maps a validation failure to isError with the specific reason', () => {
    const r = callMcpTool('edit_page', { pageId: 'ghost', patch: { htmlSource: 'x' } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('does not belong');
  });

  it('maps an unknown tool to isError', () => {
    const r = callMcpTool('frobnicate', {}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('unknown canvas tool');
  });

  // ────────────────────────────────────────────────────────────────────
  // E2E-3 — journey (c): the agent writes, a pin refuses part of it, and
  // the model has to be TOLD. This lane built its own payload whose write
  // branch discarded `data`, `dropped` and `error`, so a refusal reached
  // Claude Code as `ok:true, status:'applied'` and its model of the
  // artboard silently diverged from the document.
  // ────────────────────────────────────────────────────────────────────
  it('reports the cells a human pin refused, instead of a bare applied', () => {
    const page = store.insertPage(artifact, store.makePage({
      doc: {
        mid: 'rootaaaaaa',
        tag: 'UI.Screen',
        children: [{ mid: 'headaaaaaa', tag: 'UI.Heading', text: 'Sign in' }],
      },
      actionTitle: 'Login',
    }));
    // The human retitles the heading — `author: 'user'` is what claims the cell.
    const receipt = executor.submitOp(
      artifact,
      { op: { op: 'el.setText', pageId: page.id, mid: 'headaaaaaa', text: 'Human copy' }, runId: 'human', author: 'user', actorId: 'canvas-view' },
      'j',
      'auto',
    );
    expect(receipt.status).toBe('applied');

    // The agent rewrites the artboard: the pinned heading AND a new paragraph,
    // so at least one op lands (which is what took the discarding branch).
    const r = callMcpTool(
      'write_page',
      { pageId: page.id, jsx: 'function Page(){ return <UI.Screen><UI.Heading>Agent copy</UI.Heading><UI.Text>Added</UI.Text></UI.Screen>; }' },
      ctx,
    );
    const structured = r.structured as any;
    expect(structured.dropped, r.content[0].text).toBeDefined();
    expect(JSON.stringify(structured.dropped)).toContain('pinned-by-human');
    // The protection itself works; only the report was lost.
    expect(store.getPage(artifact, page.id)!.doc.children![0].text).toBe('Human copy');
  });

  it('still summarizes a clean write with no dropped intents', () => {
    const r = callMcpTool('insert_page', { page: { mode: 'html', htmlSource: 'x' } }, ctx);
    const structured = r.structured as any;
    expect(structured.ok).toBe(true);
    expect(structured.dropped).toBeUndefined();
  });
});
