/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { CanvasApprovalMode } from '../managers/CanvasOpExecutor';
import { canvasToolPayload, dispatchCanvasTool, type CanvasToolContext } from '../managers/CanvasToolDispatch';
import { canvasToolRefusal, normalizeCanvasToolName } from '../services/coordinatorTools';
import { canvasDirectiveToToolCall, isCanvasDirectiveError, type CanvasDirective } from './canvasDirective';
import type { CanvasArtifactSession, CanvasArtifactSnapshot } from './CanvasArtifactSession';
import type { CanvasLiveness, LivenessJobHandle } from './CanvasLiveness';

export interface CoordinatorCanvasAuthority {
  kind: 'coordinator';
  panelId: string;
  runId: string;
  jobId: string;
  isCancelled(): boolean;
  signal: AbortSignal;
  /** Captured run policy may restrict, but never relax, the live view policy. */
  approvalFloor: CanvasApprovalMode;
}

/** MCP and human callers must already have crossed their authenticated boundary. */
export type CanvasContextAuthority = CoordinatorCanvasAuthority | { kind: 'mcp' } | { kind: 'human' };

export interface CanvasToolView {
  readonly panelId: string;
  readonly originPanelId: string | null;
  readonly artifacts: CanvasArtifactSession;
  readonly liveness?: Pick<CanvasLiveness, 'openJob' | 'noteReceipt'>;
  /** Object identity of the live owner, not just reusable panel/artifact IDs. */
  isCurrent(): boolean;
  publish(snapshot: CanvasArtifactSnapshot): void;
}

export interface CanvasToolSessionPorts {
  currentView(): CanvasToolView | null;
  /** Open/focus and capture synchronously, before any readiness wait. */
  openView(originPanelId: string): CanvasToolView | null;
  approvalFor(originPanelId: string | null): CanvasApprovalMode;
  toolLabel(canonicalName: string): string;
  openMcpTurn(view: CanvasToolView): void;
}

const CANCELLED = 'Canvas tool cancelled.';
const CHANGED = 'The canvas closed or changed while this tool was running. Call canvas_open again.';
const MISSING = 'No canvas is open for this chat. Call canvas_open first — every other canvas tool needs a canvas bound to this panel.';
const OTHER_CHAT = 'A canvas is already open and bound to a different chat. Ask the user to switch to that chat, or to close the canvas first — this chat cannot edit it.';
const NOT_READY = 'The canvas did not finish opening. Try canvas_open once more.';
type ToolResult = { ok: boolean; output: string };

/** Coordinator tool lifetime, with one captured view and no mutable artifact mirror. */
export class CanvasToolSession {
  public constructor(private readonly _ports: CanvasToolSessionPorts) {}

  public boundTo(panelId: string): boolean {
    const view = this._ports.currentView();
    return !!view?.artifacts.snapshot && this._owns(view) && this._bound(view, panelId);
  }

  public context(authority: CanvasContextAuthority): CanvasToolContext | null {
    if (!authority || !['coordinator', 'mcp', 'human'].includes(authority.kind)) { return null; }
    const view = this._ports.currentView();
    const snapshot = view?.artifacts.snapshot;
    if (!view || !snapshot || !this._owns(view, snapshot)) { return null; }
    if (authority.kind === 'coordinator') {
      if (this._cancelled(authority) || !this._bound(view, authority.panelId)) { return null; }
    } else if (authority.kind === 'mcp') {
      this._ports.openMcpTurn(view);
    } else if (authority.kind !== 'human') { return null; }
    if (!this._owns(view, snapshot)) { return null; }
    return this._context(view, snapshot, authority);
  }

  public async run(directive: CanvasDirective, authority: CoordinatorCanvasAuthority): Promise<ToolResult> {
    let job: LivenessJobHandle | undefined;
    const fail = (output: string): ToolResult => { job?.fail(output); return { ok: false, output }; };
    try {
      if (this._cancelled(authority)) { return fail(CANCELLED); }
      const tool = directive.kind === 'canvas' ? normalizeCanvasToolName(directive.tool) : 'write_page_jsx';
      const refusal = directive.kind === 'canvas' ? canvasToolRefusal(tool) : undefined;
      if (refusal) { return fail(refusal); }

      let view = this._ports.currentView();
      if (directive.kind === 'canvas' && tool === 'open') {
        if (!view || !this._owns(view) || !view.artifacts.snapshot || !this._bound(view, authority.panelId)) {
          view = this._ports.openView(authority.panelId);
        }
        if (this._cancelled(authority)) { return fail(CANCELLED); }
        if (!view) { return fail(NOT_READY); }
        if (!this._bound(view, authority.panelId)) { return fail(OTHER_CHAT); }
        for (let i = 0; i < 40 && !view.artifacts.snapshot; i++) {
          if (this._cancelled(authority)) { return fail(CANCELLED); }
          if (!this._owns(view)) { return fail(CHANGED); }
          await waitForCanvas(authority.signal);
        }
        if (this._cancelled(authority)) { return fail(CANCELLED); }
        if (!this._owns(view)) { return fail(CHANGED); }
        const artifact = view.artifacts.snapshot?.artifact;
        if (!artifact) { return fail(NOT_READY); }
        return { ok: true, output: JSON.stringify({ ok: true, artifact: artifact.name, kind: artifact.kind,
          format: artifact.format?.formatId, pages: artifact.pages.length }) };
      }

      const snapshot = view?.artifacts.snapshot;
      if (!view || !snapshot || !this._owns(view, snapshot) || !this._bound(view, authority.panelId)) { return fail(MISSING); }
      const ctx = this._context(view, snapshot, authority);
      const invalid = () => this._cancelled(authority) || job?.signal.aborted ? CANCELLED
        : !this._owns(view, snapshot) ? CHANGED : undefined;
      let reason = invalid();
      if (reason) { return fail(reason); }
      const targetPage = 'pageId' in directive && typeof directive.pageId === 'string' ? directive.pageId
        : directive.kind === 'canvas' && typeof directive.args?.pageId === 'string' ? directive.args.pageId : undefined;
      job = view.liveness?.openJob({ runId: authority.runId, jobId: authority.jobId,
        label: directive.kind === 'canvas' ? `Canvas · ${this._ports.toolLabel(tool).slice('canvas:'.length)}` : 'Canvas · writing an artboard',
        ...(targetPage ? { pageId: targetPage } : {}) });
      reason = invalid();
      if (reason) { return fail(reason); }
      const call = canvasDirectiveToToolCall(directive);
      if (isCanvasDirectiveError(call)) { return fail(call.error); }
      if (typeof call.args.pageId === 'string' && call.args.pageId) {
        job?.cursor(call.args.pageId, typeof call.args.mid === 'string' ? call.args.mid : undefined);
      }
      reason = invalid();
      if (reason) { return fail(reason); }
      // Dispatch stays synchronous: no tool can borrow a successor after an await.
      const result = dispatchCanvasTool(call.tool, call.args, ctx);
      if (!result.ok) { return fail(result.error ?? `canvas tool "${call.tool}" failed`); }
      reason = invalid();
      if (reason) { return fail(reason); }
      if (result.op !== undefined) {
        view.publish(snapshot);
        reason = invalid();
        if (reason) { return fail(reason); }
        view.artifacts.scheduleSave();
      }
      reason = invalid();
      if (reason) { return fail(reason); }
      if (result.receipt) { view.liveness?.noteReceipt(authority.runId, result.receipt); }
      reason = invalid();
      if (reason) { return fail(reason); }
      const output = JSON.stringify(canvasToolPayload(result, ctx.approvalMode));
      job?.done();
      return { ok: true, output };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private _context(view: CanvasToolView, snapshot: CanvasArtifactSnapshot, authority: CanvasContextAuthority): CanvasToolContext {
    const current = authority.kind === 'human' ? 'auto' : this._ports.approvalFor(view.originPanelId);
    const approvalMode = authority.kind === 'coordinator' && authority.approvalFloor !== 'auto' ? 'staged' : current;
    return { artifact: snapshot.artifact, history: snapshot.history, store: view.artifacts.store, executor: view.artifacts.executor,
      jobId: authority.kind === 'coordinator' ? authority.jobId : 'mcp',
      runId: authority.kind === 'coordinator' ? authority.runId : 'mcp', approvalMode };
  }

  private _owns(view: CanvasToolView, snapshot?: CanvasArtifactSnapshot): boolean {
    return view.isCurrent() && !view.artifacts.closed && (!snapshot || view.artifacts.snapshot === snapshot);
  }

  private _bound(view: CanvasToolView, panelId: string): boolean {
    return view.originPanelId === null || view.originPanelId === panelId;
  }

  private _cancelled(authority: CoordinatorCanvasAuthority): boolean {
    return authority.signal.aborted || authority.isCancelled();
  }
}

/** Abort only this waiter; the shared view's initialization continues normally. */
function waitForCanvas(signal: AbortSignal): Promise<void> {
  if (signal.aborted) { return Promise.resolve(); }
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 50);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) { finish(); }
  });
}
