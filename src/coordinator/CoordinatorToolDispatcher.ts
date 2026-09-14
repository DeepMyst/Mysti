/** One coordinator run's tool scheduling, budgets and replay. No VS Code state. */
import type { CoordinatorRunOutput } from '../chat/CoordinatorRunOutput';
import type { GatewayChatMessage } from '../services/DeepMystGatewayClient';
import { searchMcpTools, toolCallToDirective, type McpToolInfo } from '../services/coordinatorTools';
import { parseToolArgs } from '../utils/toolCallAccumulator';
import type { MystiDirective, MystiDirectiveKind } from '../utils/mystiDelegateParser';
import { runBounded } from '../utils/boundedConcurrency';
import { selectToolBatch } from '../utils/toolBatching';
import { CoordinatorRunBudget, READ_ONLY_BATCH_CONCURRENCY } from './CoordinatorRunBudget';
import type { CoordinatorTurnResult } from './CoordinatorTurnRunner';

type Directive<K extends MystiDirectiveKind> = Extract<MystiDirective, { kind: K }>;
export interface CoordinatorToolResult { ok: boolean; output: string }
export interface CoordinatorVisualResult extends CoordinatorToolResult { observation?: { url: string } }

/**
 * Concrete effects only. Mutating ports retain their permission/checkpoint
 * enforcement; dispatch never treats parsing, batching or a budget as approval.
 * A host must bind these closures to this run's owner/cancellation identity.
 */
export interface CoordinatorToolPorts {
  isCancelled(): boolean;
  nextToolId(prefix: string): string;
  output: Pick<CoordinatorRunOutput, 'postToolUse' | 'postToolResult' | 'recordTool'>;
  fenceResult(kind: string, result: string): string;
  batchReadOnlyPrefix(): boolean;
  readLocal(directive: Directive<'read' | 'ls' | 'grep' | 'diag'>): Promise<CoordinatorToolResult>;
  executeLocal(directive: Directive<'write' | 'edit' | 'bash' | 'patch'>, toolId: string): Promise<CoordinatorToolResult>;
  remember(fact: string): void;
  connect(service: string): void;
  publish(id: string, toolId: string): Promise<CoordinatorToolResult>;
  runSkill(directive: Directive<'skillrun'>, toolId: string): Promise<CoordinatorToolResult>;
  lookupSkill(directive: Directive<'skill'>): Promise<CoordinatorToolResult>;
  executeMcp(directive: Directive<'mcptool'>, toolId: string, description?: string): Promise<CoordinatorToolResult>;
  noteMcpUsage(tool: string): void;
  executeVisual(directive: Directive<'look' | 'act'>, toolId: string): Promise<CoordinatorVisualResult>;
  noteVisualResult(result: CoordinatorVisualResult): void;
  canvasToolLabel(tool: string): string;
  executeCanvas(directive: Directive<'canvas' | 'canvaspage'>, toolId: string): Promise<CoordinatorToolResult>;
}

export type CoordinatorToolDispatch =
  | { kind: 'handled' }
  | { kind: 'cancelled' }
  | { kind: 'unhandled'; directive?: MystiDirective };

/**
 * Owns native/text convergence, the read-only prefix, reservations made before
 * parallel work, serial gated calls, ordered result recording, connect dedupe,
 * memory limits and tool telemetry. A single instance belongs to one run.
 */
export class CoordinatorToolDispatcher {
  private readonly _connectSeen = new Set<string>();
  private readonly _seenToolSigs = new Set<string>();
  private _rememberCount = 0;
  private _skillSearches = 0;
  private readonly _skillViewed: string[] = [];
  private _redundantToolCalls = 0;
  private _mergeableRoundTrips = 0;
  private _prevTurnWasLoneRead = false;
  private _prevWasLoneRead = false;
  private _dispatching = false;

  constructor(
    private readonly _budget: CoordinatorRunBudget,
    private readonly _ports: CoordinatorToolPorts,
    private readonly _mcpTools?: McpToolInfo[],
  ) {}

  get skillSearches(): number { return this._skillSearches; }
  get skillViewed(): string[] { return [...this._skillViewed]; }
  get redundantToolCalls(): number { return this._redundantToolCalls; }
  get mergeableRoundTrips(): number { return this._mergeableRoundTrips; }

  /** Includes continuation turns, which interrupt the consecutive-read shape. */
  beginTurn(): void {
    this._prevWasLoneRead = this._prevTurnWasLoneRead;
    this._prevTurnWasLoneRead = false;
  }

  async dispatch(turn: Extract<CoordinatorTurnResult, { kind: 'turn' }>, messages: GatewayChatMessage[]): Promise<CoordinatorToolDispatch> {
    // Failing a concurrent caller keeps interactive approvals in model order.
    if (this._dispatching) { throw new Error('Coordinator tools must be dispatched serially'); }
    if (this._ports.isCancelled()) { return { kind: 'cancelled' }; }
    this._dispatching = true;
    try { return await this._dispatch(turn, messages); }
    finally { this._dispatching = false; }
  }

  private async _dispatch(turn: Extract<CoordinatorTurnResult, { kind: 'turn' }>, messages: GatewayChatMessage[]): Promise<CoordinatorToolDispatch> {
    const { text: turnText, toolCalls: turnToolCalls } = turn;
    let { directive } = turn;
    const budget = this._budget;
    const gov = budget.limits;
    const { output: runOutput, isCancelled, fenceResult } = this._ports;
    const mcpTools = this._mcpTools;
    if (!directive && turnToolCalls && turnToolCalls.length) {
      const convs = turnToolCalls.map(c => ({ name: c.name, conv: toolCallToDirective(c.name, parseToolArgs(c.arguments)) }));

      const batchDecision = selectToolBatch(
        convs.map(c => ('error' in c.conv ? null : (c.conv as MystiDirective).kind)),
        (k) => isReadOnlyLocalKind(k),
        this._ports.batchReadOnlyPrefix(),
      );
      if (batchDecision.batchSize > 0) {
        const batchConvs = convs.slice(0, batchDecision.batchSize);
        if (budget.remaining('localTools') === 0) {
          messages.push({ role: 'assistant', content: turnText });
          messages.push({ role: 'user', content: `Local tool budget exhausted (${gov.maxLocalTools} calls). Answer with what you have, or delegate the remaining investigation to an agent.` });
          return { kind: 'handled' };
        }
        const remaining = budget.remaining('localTools');
        const runList = batchConvs.slice(0, remaining).map(c => c.conv as Extract<MystiDirective, { kind: 'read' | 'ls' | 'grep' | 'diag' }>);
        budget.consume('localTools', runList.length);
        const jobs = runList.map(d => {
          const toolId = this._ports.nextToolId('local');
          const input = localToolCardInput(d);
          runOutput.postToolUse({ id: toolId, name: d.kind, input });
          return { d, toolId, input };
        });
        const outcomes = await runBounded(jobs, READ_ONLY_BATCH_CONCURRENCY, async (j) =>
          isCancelled()
            ? { j, res: { ok: false, output: '(cancelled by user)' } }
            : { j, res: await this._ports.readLocal(j.d) });
        const fenced: string[] = [];
        for (const { j, res } of outcomes) {
          runOutput.postToolResult({ id: j.toolId, name: j.d.kind, output: res.output, status: res.ok ? 'completed' : 'failed' });
          runOutput.recordTool(j.toolId, j.d.kind, j.input, res.output, !res.ok);
          this._noteToolSig(j.d.kind, j.input);
          fenced.push(fenceResult(j.d.kind, res.output));
        }
        if (isCancelled()) { return { kind: 'cancelled' }; }
        const budgetTrimmed = batchConvs.length - runList.length;
        const deferred = convs.length - batchConvs.length;
        const notes: string[] = [];
        if (budgetTrimmed > 0) {
          notes.push(`${budgetTrimmed} further tool call(s) were not run — the local tool budget was reached. Ask again if still needed.`);
        }
        if (deferred > 0) {
          notes.push(`${deferred} further tool call(s) were not run because they are not read-only; reissue them now and they will be run one at a time.`);
        }
        const trimNote = notes.length ? `\n\n(${notes.join(' ')})` : '';
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: fenced.join('\n\n') + trimNote });
        return { kind: 'handled' };
      }

      const first = convs[0];
      if ('error' in first.conv) {
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `Tool call error: ${first.conv.error} Reissue with corrected arguments, or answer directly.` });
        return { kind: 'handled' };
      }
      directive = first.conv;
    }

    if (directive && directive.kind === 'remember') {
      const toolId = this._ports.nextToolId('mem');
      runOutput.postToolUse({ id: toolId, name: 'remember', input: { fact: directive.fact } });
      if (this._rememberCount >= 8) {
        runOutput.postToolResult({ id: toolId, name: 'remember', output: '(memory budget reached this run)', status: 'failed' });
        runOutput.recordTool(toolId, 'remember', { fact: directive.fact }, '(memory budget reached this run)', true);
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: 'Memory budget reached this run — continue with the request.' });
        return { kind: 'handled' };
      }
      this._rememberCount++;
      this._ports.remember(directive.fact);
      const out = `Remembered: ${directive.fact.slice(0, 140)}`;
      runOutput.postToolResult({ id: toolId, name: 'remember', output: out, status: 'completed' });
      runOutput.recordTool(toolId, 'remember', { fact: directive.fact }, out, false);
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: 'Noted for future sessions. Continue with the user\'s request.' });
      return { kind: 'handled' };
    }

    if (directive && (directive.kind === 'read' || directive.kind === 'ls' || directive.kind === 'grep' || directive.kind === 'diag')) {
      const toolId = this._ports.nextToolId('local');
      const input = localToolCardInput(directive);
      if (!budget.consume('localTools')) {
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `Local tool budget exhausted (${gov.maxLocalTools} calls). Answer with what you have, or delegate the remaining investigation to an agent.` });
        return { kind: 'handled' };
      }
      runOutput.postToolUse({ id: toolId, name: directive.kind, input });
      const res = await this._ports.readLocal(directive);
      runOutput.postToolResult({ id: toolId, name: directive.kind, output: res.output, status: res.ok ? 'completed' : 'failed' });
      runOutput.recordTool(toolId, directive.kind, input, res.output, !res.ok);
      this._noteToolSig(directive.kind, input);
      if (this._prevWasLoneRead) { this._mergeableRoundTrips++; }
      this._prevTurnWasLoneRead = true;
      if (isCancelled()) { return { kind: 'cancelled' }; }
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult(directive.kind, res.output) });
      return { kind: 'handled' };
    }

    if (directive && (directive.kind === 'write' || directive.kind === 'edit' || directive.kind === 'bash' || directive.kind === 'patch')) {
      const toolId = this._ports.nextToolId('exec');
      const input: Record<string, unknown> = directive.kind === 'write'
        ? { path: directive.path }
        : directive.kind === 'edit'
          ? { path: directive.path, replace: directive.replaceAll ? 'all' : 'first' }
          : directive.kind === 'bash'
            ? { command: directive.command }
            : { patch: directive.patchText.slice(0, 200) };
      if (!budget.consume('localExec')) {
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `Local edit budget exhausted (${gov.maxLocalExec} writes/edits this run). Finish with what you have, or delegate the remaining changes to a coding agent.` });
        return { kind: 'handled' };
      }
      runOutput.postToolUse({ id: toolId, name: directive.kind, input });
      const res = await this._ports.executeLocal(directive, toolId);
      runOutput.postToolResult({ id: toolId, name: directive.kind, output: res.output, status: res.ok ? 'completed' : 'failed' });
      runOutput.recordTool(toolId, directive.kind, input, res.output, !res.ok);
      if (isCancelled()) { return { kind: 'cancelled' }; }
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult(directive.kind, res.output) });
      return { kind: 'handled' };
    }

    if (directive && directive.kind === 'connect') {
      const service = directive.service;
      if (!this._connectSeen.has(service)) {
        this._connectSeen.add(service);
        this._ports.connect(service);
      }
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: `A "Connect ${service}" button was shown to the user. In one short sentence, tell them to click it to connect ${service}; then continue or finish. Do NOT emit another connect for ${service}.` });
      return { kind: 'handled' };
    }

    if (directive && directive.kind === 'publish') {
      const toolId = this._ports.nextToolId('publish');
      runOutput.postToolUse({ id: toolId, name: 'publish', input: { id: directive.id } });
      const res = await this._ports.publish(directive.id, toolId);
      runOutput.postToolResult({ id: toolId, name: 'publish', output: res.output, status: res.ok ? 'completed' : 'failed' });
      runOutput.recordTool(toolId, 'publish', { id: directive.id }, res.output, !res.ok);
      if (isCancelled()) { return { kind: 'cancelled' }; }
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult('publish', res.output) });
      return { kind: 'handled' };
    }

    if (directive && directive.kind === 'skillrun') {
      const toolId = this._ports.nextToolId('skillrun');
      runOutput.postToolUse({ id: toolId, name: 'skillrun', input: { tool: directive.tool, args: directive.args } });
      if (!budget.consume('localExec')) {
        const msg = `Capability budget reached (${gov.maxLocalExec} per run).`;
        runOutput.postToolResult({ id: toolId, name: 'skillrun', output: msg, status: 'failed' });
        runOutput.recordTool(toolId, 'skillrun', { tool: directive.tool }, msg, true);
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `${msg} Finish with what you have.` });
        return { kind: 'handled' };
      }
      const res = await this._ports.runSkill(directive, toolId);
      runOutput.postToolResult({ id: toolId, name: 'skillrun', output: res.output, status: res.ok ? 'completed' : 'failed' });
      runOutput.recordTool(toolId, 'skillrun', { tool: directive.tool }, res.output, !res.ok);
      if (isCancelled()) { return { kind: 'cancelled' }; }
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult(`skillrun:${directive.tool.replace(/[^A-Za-z0-9_]/g, '').slice(0, 48)}`, res.output) });
      return { kind: 'handled' };
    }

    if (directive && directive.kind === 'skill') {
      const toolId = this._ports.nextToolId('skill');
      runOutput.postToolUse({ id: toolId, name: 'skill', input: directive.id ? { id: directive.id, part: directive.part } : { query: directive.query } });
      if (!budget.consume('localTools')) {
        const msg = `Local tool budget exhausted (${gov.maxLocalTools} calls).`;
        runOutput.postToolResult({ id: toolId, name: 'skill', output: msg, status: 'failed' });
        runOutput.recordTool(toolId, 'skill', {}, msg, true);
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `${msg} Answer with what you have.` });
        return { kind: 'handled' };
      }
      if (directive.id) { this._skillViewed.push(directive.id); } else { this._skillSearches++; }
      const res = await this._ports.lookupSkill(directive);
      runOutput.postToolResult({ id: toolId, name: 'skill', output: res.output, status: res.ok ? 'completed' : 'failed' });
      runOutput.recordTool(toolId, 'skill', directive.id ? { id: directive.id } : { query: directive.query }, res.output, !res.ok);
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult('skill', res.output) });
      return { kind: 'handled' };
    }

    if (directive && directive.kind === 'findtool') {
      const toolId = this._ports.nextToolId('findtool');
      runOutput.postToolUse({ id: toolId, name: 'findtool', input: { query: directive.query } });
      const matches = mcpTools ? searchMcpTools(mcpTools, directive.query) : [];
      const output = !mcpTools
        ? 'External tools are not enabled.'
        : matches.length === 0
          ? `No connected tool matches "${directive.query}". Connected: ${mcpTools.map(t => t.name).slice(0, 40).join(', ')}`
          : matches.map(t => [
            `${t.name}${t.description ? ` — ${t.description}` : ''}`,
            t.inputSchema
              ? `arguments: ${JSON.stringify(t.inputSchema)}`
              : 'arguments: (this server published no schema — infer from the description)',
          ].join('\n')).join('\n\n');
      runOutput.postToolResult({ id: toolId, name: 'findtool', output, status: 'completed' });
      runOutput.recordTool(toolId, 'findtool', { query: directive.query }, output, false);
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult('findtool', output) });
      return { kind: 'handled' };
    }

    if (directive && directive.kind === 'mcptool') {
      const toolId = this._ports.nextToolId('mcp');
      runOutput.postToolUse({ id: toolId, name: 'mcptool', input: { tool: directive.tool, args: directive.args } });
      if (!mcpTools) {
        runOutput.postToolResult({ id: toolId, name: 'mcptool', output: 'External tools are not enabled.', status: 'failed' });
        runOutput.recordTool(toolId, 'mcptool', { tool: directive.tool }, 'External tools are not enabled.', true);
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: 'External tools are not available. Answer without them or delegate.' });
        return { kind: 'handled' };
      }
      if (budget.remaining('mcpCalls') === 0) {
        runOutput.postToolResult({ id: toolId, name: 'mcptool', output: `External tool budget reached (${gov.maxMcpCalls} calls).`, status: 'failed' });
        runOutput.recordTool(toolId, 'mcptool', { tool: directive.tool }, `External tool budget reached (${gov.maxMcpCalls} calls).`, true);
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `External tool budget reached (${gov.maxMcpCalls} calls this run). Finish with what you have.` });
        return { kind: 'handled' };
      }
      if (!mcpTools.some(t => t.name === directive.tool)) {
        runOutput.postToolResult({ id: toolId, name: 'mcptool', output: `No such tool "${directive.tool}".`, status: 'failed' });
        runOutput.recordTool(toolId, 'mcptool', { tool: directive.tool }, `No such tool "${directive.tool}".`, true);
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `No connected tool "${directive.tool}". Available: ${mcpTools.map(t => t.name).slice(0, 40).join(', ')} — or answer without it.` });
        return { kind: 'handled' };
      }
      budget.consume('mcpCalls');
      const res = await this._ports.executeMcp(directive, toolId, mcpTools.find(t => t.name === directive.tool)?.description);
      if (res.ok) { this._ports.noteMcpUsage(directive.tool); }
      runOutput.postToolResult({ id: toolId, name: 'mcptool', output: res.output, status: res.ok ? 'completed' : 'failed' });
      runOutput.recordTool(toolId, 'mcptool', { tool: directive.tool }, res.output, !res.ok);
      if (isCancelled()) { return { kind: 'cancelled' }; }
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult(`mcptool:${String(directive.tool).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48)}`, res.output) });
      return { kind: 'handled' };
    }

    if (directive && (directive.kind === 'look' || directive.kind === 'act')) {
      const toolId = this._ports.nextToolId('visual');
      const input: Record<string, unknown> = directive.kind === 'look'
        ? { path: directive.path || '(current page)', ...(directive.selector ? { selector: directive.selector } : {}) }
        : { actions: directive.actions.length };
      if (!budget.consume('visualLooks')) {
        runOutput.postToolUse({ id: toolId, name: directive.kind, input });
        const msg = `Visual budget reached (${gov.maxVisualLooks} looks this run).`;
        runOutput.postToolResult({ id: toolId, name: directive.kind, output: msg, status: 'failed' });
        runOutput.recordTool(toolId, directive.kind, input, msg, true);
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `${msg} Finish with what you have.` });
        return { kind: 'handled' };
      }
      runOutput.postToolUse({ id: toolId, name: directive.kind, input });
      const res = await this._ports.executeVisual(directive, toolId);
      runOutput.postToolResult({ id: toolId, name: directive.kind, output: res.output, status: res.ok ? 'completed' : 'failed' });
      runOutput.recordTool(toolId, directive.kind, input, res.output, !res.ok);
      this._ports.noteVisualResult(res);
      if (isCancelled()) { return { kind: 'cancelled' }; }
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult(directive.kind, res.output) });
      return { kind: 'handled' };
    }

    if (directive && (directive.kind === 'canvas' || directive.kind === 'canvaspage')) {
      const toolId = this._ports.nextToolId('canvas');
      const label = directive.kind === 'canvas' ? this._ports.canvasToolLabel(directive.tool) : 'canvas:write_page';
      const input: Record<string, unknown> = directive.kind === 'canvas'
        ? { tool: directive.tool, args: directive.args }
        : { page: directive.pageId, title: directive.title, bytes: directive.source.length };
      runOutput.postToolUse({ id: toolId, name: 'canvas', input });
      if (!budget.consume('canvasCalls')) {
        const out = `Canvas edit budget reached (${gov.maxCanvasCalls} edits this run).`;
        runOutput.postToolResult({ id: toolId, name: 'canvas', output: out, status: 'failed' });
        runOutput.recordTool(toolId, 'canvas', input, out, true);
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: `${out} Summarize what you built and stop editing.` });
        return { kind: 'handled' };
      }
      const res = await this._ports.executeCanvas(directive, toolId);
      runOutput.postToolResult({ id: toolId, name: 'canvas', output: res.output, status: res.ok ? 'completed' : 'failed' });
      runOutput.recordTool(toolId, 'canvas', input, res.output, !res.ok);
      if (isCancelled()) { return { kind: 'cancelled' }; }
      messages.push({ role: 'assistant', content: turnText });
      messages.push({ role: 'user', content: fenceResult(label, res.output) });
      return { kind: 'handled' };
    }
    return { kind: 'unhandled', directive };
  }

  private _noteToolSig(kind: string, input: unknown): void {
    let sig: string;
    try { sig = `${kind}:${JSON.stringify(input)}`; } catch { return; }
    if (this._seenToolSigs.has(sig)) { this._redundantToolCalls++; }
    else { this._seenToolSigs.add(sig); }
  }
}

function isReadOnlyLocalKind(kind: string): kind is 'read' | 'ls' | 'grep' | 'diag' {
  return kind === 'read' || kind === 'ls' || kind === 'grep' || kind === 'diag';
}

function localToolCardInput(d: Directive<'read' | 'ls' | 'grep' | 'diag'>): Record<string, unknown> {
  switch (d.kind) {
    case 'read': return { path: d.path, ...(d.startLine ? { lines: `${d.startLine}-${d.endLine ?? ''}` } : {}) };
    case 'ls': return { path: d.path };
    case 'grep': return { pattern: d.pattern, ...(d.include ? { path: d.include } : {}) };
    case 'diag': return { target: d.target };
  }
}
