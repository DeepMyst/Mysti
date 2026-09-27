/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, '../../media/chat/agentMap.js'), 'utf8');
const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) { dom.window.close(); } });

type Node = {
  id: string; parentId: string | null; kind: string; title: string; status: string; backend?: string; model?: string;
  access?: string; tools: Array<{ id: string; name: string; status: string }>; needs: string[]; dependsOn: string[];
  failure?: string; error?: string; result?: string; note?: string; usage?: unknown; costUsd?: number; jobId?: string;
  lastEventAt: number;
};
type Model = {
  ingest(message: unknown): boolean; get(id: string): Node | null; children(id: string): Node[]; nodes(): Node[];
  counts(t?: number): Record<string, number>; resolveNeed(id: string): boolean; reset(o?: { keepJobs?: boolean }): void;
  isStalled(node: Node, t: number): boolean; statusOf(node: Node, t: number): string;
};
type MapApi = {
  observe(message: unknown): void; open(): void; close(): void; toggle(): void; isOpen(): boolean; reset(): void;
  permissionResolved(id: string): void; questionAnswered(id: string): void; counts(): Record<string, number>; dispose(): void;
};
type Factory = { create(ports: unknown): MapApi; createModel(options: { now: () => number }): Model };

function harness(width = 1200, extra = '') {
  const dom = new JSDOM(
    `<body>${extra}<div id="agent-map" class="agent-map hidden" role="dialog" aria-modal="true"></div>` +
    '<button id="agent-map-pill" class="agent-map-pill hidden"></button><textarea id="composer"></textarea></body>',
    { runScripts: 'outside-only', url: 'https://mysti.test/' });
  windows.push(dom);
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  dom.window.eval(source);
  const { document } = dom.window;
  const clock = { t: 1000 };
  const intervals = new Map<number, () => void>();
  let sequence = 0;
  const postMessage = vi.fn();
  const prefillComposer = vi.fn();
  const factory = (dom.window as unknown as { MystiAgentMap: Factory }).MystiAgentMap;
  const map = factory.create({
    document, postMessage, prefillComposer, now: () => clock.t,
    getAgentDisplay: (id: string) => ({ name: 'Agent ' + id }),
    listAgents: () => [{ id: 'claude-code', name: 'Claude' }, { id: 'openai-codex', name: 'Codex' }],
    setInterval: (callback: () => void) => { intervals.set(++sequence, callback); return sequence; },
    clearInterval: (id: number) => { intervals.delete(id); },
  });
  const model = factory.createModel({ now: () => clock.t });
  const send = (type: string, payload?: unknown) => map.observe({ type, payload });
  const ingest = (type: string, payload?: unknown) => model.ingest({ type, payload });
  const shell = () => document.getElementById('agent-map')!;
  const nodeButton = (text: string) => [...shell().querySelectorAll<HTMLButtonElement>('.agent-map-node')]
    .find(button => button.textContent!.includes(text))!;
  const action = (text: string) => [...shell().querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === text);
  const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  return { dom, document, clock, intervals, postMessage, prefillComposer, map, model, send, ingest, shell, nodeButton, action, key,
    pill: () => document.getElementById('agent-map-pill')! };
}

describe('agent map model: every family', () => {
  it('coordinator delegate, native, advisor and review cards with trace, meta and failure fallback', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Fix the parser' } });
    h.ingest('toolUse', { id: 'n1', name: 'delegate', input: { agent: 'mysti', task: 'Scout files', access: 'read-only' } });
    h.ingest('toolUse', { id: 'a1', name: 'delegate', input: { agent: 'advisor', task: 'Second opinion' },
      meta: { kind: 'advisor', backend: 'claude-code', access: 'read-only', model: 'opus' } });
    h.ingest('toolUse', { id: 'r1', name: 'review', input: { reviewer: 'google-gemini', of: 'openai-codex' } });
    h.ingest('toolUse', { id: 'read1', name: 'read', input: { path: 'src/a.ts' } });
    const d1 = h.model.get('card:d1')!;
    expect([d1.kind, d1.backend, d1.title, d1.status, d1.parentId]).toEqual(['delegate', 'openai-codex', 'Fix the parser', 'working', 'root']);
    expect([h.model.get('card:n1')!.kind, h.model.get('card:n1')!.backend, h.model.get('card:n1')!.access]).toEqual(['native', 'mysti', 'read-only']);
    const a1 = h.model.get('card:a1')!;
    expect([a1.kind, a1.backend, a1.model, a1.access]).toEqual(['advisor', 'claude-code', 'opus', 'read-only']);
    expect([h.model.get('card:r1')!.kind, h.model.get('card:r1')!.backend]).toEqual(['review', 'google-gemini']);
    expect(h.model.get('root')!.tools.map(tool => tool.name)).toEqual(['read']);

    h.ingest('mystiDelegateTrace', { parentId: 'd1', chunk: { type: 'tool_use', toolCall: { id: 't1', name: 'Edit', input: { file_path: 'a.ts' } } } });
    h.ingest('mystiDelegateTrace', { parentId: 'd1', chunk: { type: 'tool_result', toolCall: { id: 't1', status: 'completed' } } });
    h.ingest('mystiDelegateTrace', { parentId: 'd1', chunk: { type: 'retry', content: 'attempt 2' } });
    expect(d1.tools).toEqual([expect.objectContaining({ id: 't1', name: 'Edit', status: 'done' })]);
    expect(d1.note).toContain('attempt 2');

    h.ingest('toolResult', { id: 'd1', name: 'delegate', status: 'completed', output: 'patched',
      meta: { model: 'gpt-6', via: 'cli', usage: { input_tokens: 1200, output_tokens: 300 }, costUsd: 0.01, costApprox: true } });
    expect([d1.status, d1.result, d1.model, d1.via, d1.costUsd]).toEqual(['done', 'patched', 'gpt-6', 'cli', 0.01]);
    h.ingest('toolResult', { id: 'n1', name: 'delegate', status: 'failed', output: '(failed: timeout — took too long)' });
    expect([h.model.get('card:n1')!.status, h.model.get('card:n1')!.failure, h.model.get('card:n1')!.error]).toEqual(['failed', 'timeout', 'took too long']);
    h.ingest('toolResult', { id: 'a1', name: 'delegate', status: 'failed', output: 'Stopped by user' });
    expect(a1.status).toBe('interrupted');
    h.ingest('toolResult', { id: 'read1', status: 'completed', output: 'x' });
    expect(h.model.get('root')!.tools[0].status).toBe('done');
    h.ingest('responseComplete', { usage: { input_tokens: 0, output_tokens: 0 } });
    expect(h.model.get('root')!.status).toBe('done');
    expect(h.model.get('root')!.usage).toBeUndefined();
  });

  it('orchestration: dependency lanes, non-terminal collab_error, terminal collab_skipped, verify and synthesis', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('mystiStarted', { brief: 'Build it' });
    const ev = (payload: Record<string, unknown>) => h.ingest('mystiEvent', { runId: 'r1', ...payload });
    ev({ type: 'orch_status', phase: 'decompose', content: 'Planning…' });
    const wf = h.model.nodes().find(node => node.kind === 'workflow')!;
    expect(h.model.get(wf.id + ':plan')!.status).toBe('working');
    ev({ type: 'orch_plan', plan: { nodes: [
      { id: 'a', task: 'Schema', dependsOn: [] },
      { id: 'b', task: 'API', backend: 'openai-codex', dependsOn: ['a'] },
      { id: 'c', task: 'Docs', dependsOn: ['a', 'b'] },
      { id: 'd', task: 'Tests', dependsOn: [] },
    ] } });
    expect(h.model.get(wf.id + ':plan')!.status).toBe('done');
    const lane = (id: string) => h.model.get(wf.id + ':n:' + id)!;
    expect(['a', 'b', 'c', 'd'].map(id => lane(id).status)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    expect(lane('c').dependsOn).toEqual(['a', 'b']);
    ev({ type: 'orch_status', phase: 'execute', content: 'Running 4 step(s)…' });
    ev({ type: 'orch_node_start', nodeId: 'a', nodeBackend: 'claude-code', content: 'Schema' });
    const collab = (nodeId: string, chunk: Record<string, unknown>) =>
      ev({ type: 'orch_collab', nodeId, collab: { collaboratorId: nodeId, agentId: 'claude-code', ...chunk } });
    collab('a', { type: 'collab_started' });
    collab('a', { type: 'collab_error', failure: 'empty-response', content: 'no output', hasError: true });
    expect([lane('a').status, lane('a').failure]).toEqual(['working', 'empty-response']);
    collab('a', { type: 'collab_retry', retryCount: 1 });
    collab('a', { type: 'collab_complete', responseText: 'schema ok', hasError: false, usage: { input_tokens: 10, output_tokens: 5 } });
    ev({ type: 'orch_node_done', nodeId: 'a', hasError: false });
    expect([lane('a').status, lane('a').result, lane('a').usage]).toEqual(['done', 'schema ok', { input_tokens: 10, output_tokens: 5 }]);
    collab('b', { type: 'collab_started' });
    collab('b', { type: 'collab_skipped', failure: 'not-installed', hint: 'Install with: npm i', hasError: true });
    expect([lane('b').status, lane('b').failure, lane('b').note]).toEqual(['failed', 'not-installed', 'Install with: npm i']);
    collab('d', { type: 'collab_started' });
    collab('d', { type: 'collab_complete', responseText: 'tests', hasError: false });
    ev({ type: 'orch_status', phase: 'verify', content: 'Checking…' });
    expect(h.model.get(wf.id + ':verify')!.status).toBe('working');
    expect(wf.phase).toBe('verify');
    ev({ type: 'orch_node_done', nodeId: 'verify', hasError: false });
    expect(h.model.get(wf.id + ':verify')!.status).toBe('done');
    ev({ type: 'orch_status', phase: 'synthesize' });
    ev({ type: 'orch_synthesis', content: 'final answer' });
    ev({ type: 'orch_done' });
    expect(h.model.get(wf.id + ':synth')!.status).toBe('done');
    h.ingest('mystiComplete', { cancelled: false });
    expect(wf.status).toBe('done');
    // Undispatched work is not a done agent: no ✓, no Done count, no Ask another agent.
    expect([lane('c').status, lane('c').note]).toEqual(['interrupted', 'Not dispatched']);

    // The same events rendered: plan | level 0 | level 1 | level 2 | verify | synthesize.
    h.send('responseStarted', { provider: 'mysti' });
    h.send('mystiStarted', { brief: 'Build it' });
    h.send('mystiEvent', { runId: 'r2', type: 'orch_status', phase: 'decompose' });
    h.send('mystiEvent', { runId: 'r2', type: 'orch_plan', plan: { nodes: [
      { id: 'a', task: 'Schema', dependsOn: [] }, { id: 'b', task: 'API', dependsOn: ['a'] },
      { id: 'c', task: 'Docs', dependsOn: ['a', 'b'] }] } });
    h.send('mystiEvent', { runId: 'r2', type: 'orch_node_start', nodeId: 'a', nodeBackend: 'claude-code' });
    h.clock.t += 4000;
    h.send('mystiEvent', { runId: 'r2', type: 'orch_status', phase: 'verify' });
    h.send('mystiEvent', { runId: 'r2', type: 'orch_status', phase: 'synthesize' });
    h.map.open();
    const labels = [...h.shell().querySelectorAll('.agent-map-wf-col-label')].map(label => label.textContent);
    expect(labels).toEqual(['Plan', 'Run', 'Then', 'Then', 'Verify', 'Synthesize']);
    const columns = [...h.shell().querySelectorAll('.agent-map-wf-col')];
    expect(columns[3].textContent).toContain('Docs');
    expect(columns[3].querySelector('.agent-map-after')!.textContent).toBe('after Schema, API');
    expect([...h.shell().querySelectorAll('.agent-map-wf-phase')].map(phase => phase.textContent))
      .toEqual(['✓ Plan', '✓ Run', '✓ Verify', 'Synthesize']);
    h.nodeButton('Build it').click();
    const inspector = h.shell().querySelector('.agent-map-inspector')!;
    expect(inspector.querySelectorAll('.agent-map-wf-phase.is-current')).toHaveLength(1);
    const bars = inspector.querySelectorAll<HTMLElement>('.agent-map-bar');
    expect([bars.length, bars[0].style.left, bars[0].style.width]).toEqual([1, '0%', '100%']);
    expect([...inspector.querySelectorAll('.agent-map-handoffs li')].map(li => li.textContent)).toEqual(['Schema → API', 'Schema → Docs', 'API → Docs']);
  });

  it('settles a refused single-lane plan instead of leaving lanes waiting forever', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('mystiStarted', { brief: 'Tiny' });
    h.ingest('mystiEvent', { runId: 'r', type: 'orch_status', phase: 'decompose' });
    h.ingest('mystiEvent', { runId: 'r', type: 'orch_plan', plan: { nodes: [{ id: 'task', task: 'Tiny', dependsOn: [] }] } });
    h.ingest('mystiEvent', { runId: 'r', type: 'orch_status', phase: 'execute', content: 'One step only — answering directly instead of delegating.' });
    h.ingest('mystiComplete', { cancelled: false });
    const lanes = h.model.nodes().filter(node => node.kind === 'lane');
    expect(lanes.map(node => node.status)).toEqual(['interrupted']);
    expect(h.model.counts().waiting).toBe(0);
    h.ingest('mystiStarted', { brief: 'Broken' });
    h.ingest('mystiEvent', { type: 'orch_plan', plan: { nodes: [{ id: 'x', task: 'x', dependsOn: [] }] } });
    h.ingest('mystiError', { message: 'decompose failed' });
    h.ingest('mystiComplete', { cancelled: false });
    const broken = h.model.nodes().filter(node => node.kind === 'workflow')[1];
    expect([broken.status, broken.error]).toEqual(['failed', 'decompose failed']);
    expect(h.model.children(broken.id).every(node => node.status === 'failed')).toBe(true);
  });

  it('mention sub-agents carry tools, questions as needs, retries and failure', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'claude-code', model: 'sonnet' });
    expect([h.model.get('root')!.backend, h.model.get('root')!.model]).toEqual(['claude-code', 'sonnet']);
    // The host's order: MentionRouter names the task before the agent starts.
    h.ingest('mentionTaskStarted', { taskIndex: 0, agentId: 'openai-codex', task: 'Write tests' });
    h.ingest('subAgentStarted', { agentId: 'openai-codex' });
    h.ingest('subAgentToolUse', { agentId: 'openai-codex', toolCall: { id: 'st1', name: 'Bash', input: { command: 'npm test' } } });
    h.ingest('subAgentAskUserQuestion', { agentId: 'openai-codex', questionData: { toolCallId: 'q1', questions: [{ question: 'Which suite?' }] } });
    const node = h.model.nodes().find(n => n.kind === 'mention')!;
    expect([node.title, node.backend, node.tools[0].name, node.needs]).toEqual(['Write tests', 'openai-codex', 'Bash', ['q1']]);
    expect(h.model.statusOf(node, h.clock.t)).toBe('needs');
    expect(h.model.resolveNeed('q1')).toBe(true);
    expect(h.model.statusOf(node, h.clock.t)).toBe('working');
    h.ingest('subAgentRetry', { agentId: 'openai-codex', retryCount: 1 });
    h.ingest('subAgentError', { agentId: 'openai-codex', error: 'timed out' });
    expect([node.status, node.error]).toEqual(['failed', 'timed out']);
    h.ingest('subAgentStarted', { agentId: 'openai-codex' });
    h.ingest('subAgentComplete', { agentId: 'openai-codex', hasError: false });
    expect(node.status).toBe('done');
  });

  it('role collaborators, session lanes, brainstorm debaters and CLI-reported subagents', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('collaborationStarted', { collaborators: [{ agentId: 'openai-codex', roleId: 'critic' }] });
    h.ingest('collaborator', { type: 'collab_started', collaboratorId: 'c1', agentId: 'openai-codex', role: 'critic', label: 'Codex critic' });
    h.ingest('collaborator', { type: 'collab_error', collaboratorId: 'c1', agentId: 'openai-codex', failure: 'crashed', hasError: true });
    const role = h.model.nodes().find(n => n.kind === 'role')!;
    expect([role.title, role.role, role.status, role.failure]).toEqual(['Codex critic', 'critic', 'working', 'crashed']);
    h.ingest('collaborator', { type: 'collab_complete', collaboratorId: 'c1', agentId: 'openai-codex', hasError: false, responseText: 'lgtm' });
    h.ingest('collaborationComplete');
    expect([role.status, h.model.get(role.parentId!)!.status, h.model.get(role.parentId!)!.kind]).toEqual(['done', 'done', 'collab']);

    h.ingest('sessionEvent', { runId: 's1', type: 'session_started', shape: 'review', lanes: [
      { collaboratorId: 'l1', agentId: 'claude-code', label: 'Claude', status: 'pending', text: '' },
      { collaboratorId: 'l2', agentId: 'openai-codex', label: 'Codex', status: 'running', text: '' },
      { collaboratorId: 'l3', agentId: 'cursor', label: 'Cursor', status: 'pending', text: '' }] });
    const sessionLane = (id: string) => h.model.get('session:s1:' + id)!;
    expect([sessionLane('l1').status, sessionLane('l2').status]).toEqual(['waiting', 'working']);
    h.ingest('sessionEvent', { runId: 's1', type: 'lane_update', lane: { collaboratorId: 'l1', agentId: 'claude-code', label: 'Claude', status: 'running', text: '' } });
    h.ingest('sessionEvent', { runId: 's1', type: 'lane_update', lane: { collaboratorId: 'l2', agentId: 'openai-codex', label: 'Codex', status: 'error', text: '', error: 'boom' } });
    h.ingest('sessionEvent', { runId: 's1', type: 'lane_update', lane: { collaboratorId: 'l3', agentId: 'cursor', label: 'Cursor', status: 'skipped', text: '', hint: 'install' } });
    expect([sessionLane('l1').status, sessionLane('l2').status, sessionLane('l2').error, sessionLane('l3').status])
      .toEqual(['working', 'failed', 'boom', 'failed']);
    h.ingest('sessionEvent', { runId: 's1', type: 'session_complete', markdown: '', lanes: [
      { collaboratorId: 'l1', agentId: 'claude-code', label: 'Claude', status: 'done', text: 'found 2' }] });
    expect([sessionLane('l1').status, sessionLane('l1').result, h.model.get('session:s1')!.status]).toEqual(['done', 'found 2', 'done']);

    h.ingest('toolUse', { id: 'toolu_1', name: 'Task', input: {} });
    h.ingest('toolUse', { id: 'toolu_1', name: 'Task', input: { description: 'Explore repo' } });
    h.ingest('toolUse', { id: 'mysti-read-1', name: 'Agent', input: {} });
    const reported = h.model.get('card:toolu_1')!;
    expect([reported.kind, reported.backend, reported.title]).toEqual(['reported', 'claude-code', 'Explore repo']);
    expect(h.model.get('card:mysti-read-1')).toBeNull();
    h.ingest('toolResult', { id: 'toolu_1', name: '', status: 'completed', output: 'done exploring' });
    expect(reported.status).toBe('done');

    h.ingest('brainstormStarted', { sessionId: 'panel', query: 'Pick a DB', agents: [{ id: 'stale' }], strategy: 'debate' });
    h.ingest('brainstormAgentChunk', { agentId: 'claude-code', content: 'x', type: 'text' });
    h.ingest('brainstormAgentChunk', { agentId: 'openai-codex', content: 'y', type: 'text' });
    h.ingest('brainstormAgentComplete', { agentId: 'claude-code' });
    h.ingest('brainstormConvergenceUpdate', { convergence: { overallConvergence: 0.62 }, roundNumber: 1 });
    const debate = h.model.nodes().find(n => n.kind === 'debate')!;
    expect(h.model.children(debate.id).map(n => [n.kind, n.backend, n.status]))
      .toEqual([['debater', 'claude-code', 'done'], ['debater', 'openai-codex', 'working']]);
    expect((debate as unknown as { convergence: number }).convergence).toBe(62);
    h.ingest('brainstormPhaseChange', { phase: 'synthesis' });
    h.ingest('brainstormSynthesisChunk', { content: 'use postgres' });
    expect(h.model.get(debate.id + ':synth')!.status).toBe('working');
    h.ingest('brainstormComplete', { unifiedSolution: 'postgres' });
    expect(h.model.children(debate.id).every(n => n.status === 'done')).toBe(true);
    expect(debate.status).toBe('done');
  });

  it('background jobs: child cards, jobsList interrupted records, and the handed-off root', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('jobStarted', { jobId: 'j1', title: 'Refactor auth' });
    expect(h.model.get('root')!.status).toBe('done');
    const job = h.model.get('job:j1')!;
    expect([job.kind, job.status, job.parentId, job.title]).toEqual(['job', 'working', null, 'Refactor auth']);
    h.ingest('jobToolUse', { jobId: 'j1', toolCall: { id: 'jd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Split module' } } });
    h.ingest('jobToolUse', { jobId: 'j1', toolCall: { id: 'jr1', name: 'read', input: { path: 'a' } } });
    const child = h.model.get('job:j1:card:jd1')!;
    expect([child.kind, child.parentId, child.jobId]).toEqual(['delegate', 'job:j1', 'j1']);
    expect(job.tools.map(tool => tool.id)).toEqual(['jr1']);
    h.ingest('jobToolResult', { jobId: 'j1', toolCall: { id: 'jd1', name: 'delegate', output: 'ok', status: 'completed' } });
    expect(child.status).toBe('done');
    h.ingest('jobsList', { source: 'agentMap', jobs: [
      { id: 'j1', title: 'Refactor auth', status: 'running', startedAt: 500 },
      { id: 'j0', title: 'Old job', status: 'interrupted', startedAt: 100, finishedAt: 200 },
      { id: 'j2', title: 'Done job', status: 'done', startedAt: 100, finishedAt: 300, resultText: 'result' }] });
    expect([h.model.get('job:j0')!.status, h.model.get('job:j2')!.status, h.model.get('job:j2')!.result])
      .toEqual(['interrupted', 'done', 'result']);
    h.ingest('jobComplete', { jobId: 'j1', message: { content: 'refactored' }, delegations: 1 });
    expect([job.status, job.result]).toEqual(['done', 'refactored']);
    h.ingest('jobError', { jobId: 'j0', error: 'late' });
    expect(h.model.get('job:j0')!.status).toBe('failed');
  });

  it('requestCancelled interrupts foreground working and waiting nodes but never jobs', () => {
    const h = harness();
    h.ingest('jobStarted', { jobId: 'j1', title: 'bg' });
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 't' } });
    h.ingest('mystiStarted', { brief: 'b' });
    h.ingest('mystiEvent', { runId: 'r', type: 'orch_plan', plan: { nodes: [{ id: 'a', task: 'a', dependsOn: [] }] } });
    h.ingest('requestCancelled');
    expect(h.model.get('root')!.status).toBe('interrupted');
    expect(h.model.get('card:d1')!.status).toBe('interrupted');
    expect(h.model.nodes().find(n => n.kind === 'lane')!.status).toBe('interrupted');
    expect(h.model.get('job:j1')!.status).toBe('working');
  });
});

describe('agent map model: needs and stall', () => {
  it('attributes permissions by owner, card, native prefix, tool row, origin and root fallback, then resolves them', () => {
    const h = harness();
    h.ingest('jobStarted', { jobId: 'j1', title: 'bg' });
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('toolUse', { id: 'mysti-deleg-r-1', name: 'delegate', input: { agent: 'openai-codex', task: 't' } });
    h.ingest('toolUse', { id: 'mysti-deleg-r-2', name: 'delegate', input: { agent: 'mysti', task: 'scout' } });
    h.ingest('mystiDelegateTrace', { parentId: 'mysti-deleg-r-1', chunk: { type: 'tool_use', toolCall: { id: 'inner-1', name: 'Edit' } } });
    h.ingest('mystiStarted', { brief: 'b' });
    h.ingest('mystiEvent', { runId: 'r', type: 'orch_collab', nodeId: 'lane-x', collab: { type: 'collab_started', collaboratorId: 'lane-x', agentId: 'cursor' } });
    const perm = (id: string, extra: Record<string, unknown>) => h.ingest('permissionRequest', { id, title: 'Edit file', description: 'd', ...extra });
    perm('p-job', { ownerKey: 'j1', toolCallId: 'mysti-deleg-r-1' });
    perm('p-card', { ownerKey: 'sidebar', toolCallId: 'mysti-deleg-r-1' });
    perm('p-native', { toolCallId: 'mysti-deleg-r-2-t3' });
    perm('p-row', { toolCallId: 'inner-1' });
    perm('p-origin', { toolCallId: 'unknown', origin: { kind: 'collaborator', collaboratorId: 'lane-x', agentId: 'cursor' } });
    perm('p-backend', { origin: { kind: 'mention', agentId: 'cursor' } });
    perm('p-root', { toolCallId: 'nothing' });
    const owner = (id: string) => h.model.nodes().find(node => node.needs.includes(id))!.id;
    expect(owner('p-job')).toBe('job:j1');
    expect(owner('p-card')).toBe('card:mysti-deleg-r-1');
    expect(owner('p-native')).toBe('card:mysti-deleg-r-2');
    expect(owner('p-row')).toBe('card:mysti-deleg-r-1');
    expect(owner('p-origin')).toMatch(/:n:lane-x$/);
    expect(owner('p-backend')).toMatch(/:n:lane-x$/);
    expect(owner('p-root')).toBe('root');
    expect(h.model.counts().pending).toBe(7);
    h.ingest('permissionDismissed', { requestIds: ['p-job', 'p-card'] });
    h.ingest('permissionExpired', { requestId: 'p-native', behavior: 'deny', approved: false });
    h.ingest('semiAutonomousDecision', { requestId: 'p-row', targetType: 'permission', approved: true });
    expect(h.model.resolveNeed('p-origin')).toBe(true);
    expect(h.model.resolveNeed('p-origin')).toBe(false);
    expect(h.model.counts().pending).toBe(2);
    h.ingest('askUserQuestion', { toolCallId: 'q-main', questions: [{ question: 'Proceed?' }] });
    expect(h.model.get('root')!.needs).toContain('q-main');
    // The turn lands with the question still open: the answer arrives as the next send.
    h.ingest('responseComplete', {});
    expect(h.model.get('root')!.needs).toContain('q-main');
    h.ingest('responseStarted', { provider: 'claude-code' });
    expect(h.model.get('root')!.needs).not.toContain('q-main');
  });

  it('derives stalled from the injected clock and never while a need is pending below', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 't' } });
    const root = h.model.get('root')!;
    const card = h.model.get('card:d1')!;
    h.clock.t += 89999;
    expect(h.model.statusOf(card, h.clock.t)).toBe('working');
    h.clock.t += 1;
    expect(h.model.statusOf(card, h.clock.t)).toBe('stalled');
    expect(h.model.counts().stalled).toBe(2);
    h.ingest('permissionRequest', { id: 'p1', title: 'x', toolCallId: 'd1' });
    h.clock.t += 200000;
    expect(h.model.statusOf(card, h.clock.t)).toBe('needs');
    expect(h.model.isStalled(root, h.clock.t)).toBe(false);
    h.ingest('permissionDismissed', { requestIds: ['p1'] });
    h.clock.t += 90000;
    expect(h.model.statusOf(root, h.clock.t)).toBe('stalled');
  });

  it('survives malformed payloads without throwing or inventing nodes', () => {
    const h = harness();
    const junk: unknown[] = [null, 7, 'x', {}, { type: 5 }, { type: 'toolUse', payload: null }, { type: 'toolResult', payload: [] },
      { type: 'permissionRequest', payload: { title: 'no id' } }, { type: 'mystiEvent', payload: { type: 'orch_plan', plan: 'x' } },
      { type: 'mystiEvent', payload: { type: 'orch_collab', collab: 'bad' } }, { type: 'jobsList', payload: { jobs: 'nope' } },
      { type: 'jobsList', payload: { jobs: [null, { id: 3 }] } }, { type: 'sessionEvent', payload: { type: 'lane_update' } },
      { type: 'subAgentToolUse', payload: { agentId: 'x', toolCall: null } }, { type: 'permissionDismissed', payload: { requestIds: 'p' } },
      { type: 'brainstormAgentChunk', payload: { agentId: 1 } }, { type: 'jobToolUse', payload: { jobId: 'ghost', toolCall: {} } },
      { type: 'subAgentAskUserQuestion', payload: { agentId: 'x', questionData: null } }, { type: 'error', payload: 'no turn' }];
    for (const message of junk) { expect(() => h.model.ingest(message)).not.toThrow(); }
    expect(() => junk.forEach(message => h.map.observe(message))).not.toThrow();
    expect(h.model.nodes().filter(node => node.kind !== 'workflow')).toEqual([]);
    expect(h.model.counts().pending).toBe(0);
  });
});

describe('agent map model: lifecycle edges', () => {
  const question = (toolCallId: string) => ({ toolCallId, questions: [{ question: 'Which?' }] });

  it('question needs end with their agent: completion, error, Stop, and none without a chat card', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('subAgentStarted', { agentId: 'openai-codex' });
    h.ingest('subAgentAskUserQuestion', { agentId: 'openai-codex', questionData: question('q1') });
    expect(h.model.counts()).toMatchObject({ needs: 1, pending: 1 });
    h.ingest('subAgentComplete', { agentId: 'openai-codex', hasError: false });
    expect(h.model.counts()).toMatchObject({ needs: 0, pending: 0 });

    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('subAgentStarted', { agentId: 'openai-codex' });
    h.ingest('subAgentAskUserQuestion', { agentId: 'openai-codex', questionData: question('q2') });
    h.ingest('askUserQuestion', question('q-main'));
    expect(h.model.counts().pending).toBe(2);
    // Stop ends the sub-agent and its question; the main agent's question card stays
    // answerable (the host keeps it until an answer, a skip or the next send).
    h.ingest('requestCancelled');
    expect(h.model.counts().pending).toBe(1);
    expect(h.model.get('root')!.needs).toEqual(['q-main']);
    h.ingest('responseStarted', { provider: 'claude-code' });
    expect(h.model.counts().pending).toBe(0);

    h.ingest('askUserQuestion', question('q-err'));
    h.ingest('error', 'CLI exited');
    expect(h.model.counts().pending).toBe(1);
    h.model.resolveNeed('q-err');
    expect(h.model.counts().pending).toBe(0);

    // Orchestration, role, session and delegation questions get no chat card: nothing to review, nothing to clear them.
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('subAgentAskUserQuestion', { agentId: 'cursor', questionData: question('q3') });
    expect(h.model.counts().pending).toBe(0);
    const bg = harness();
    bg.ingest('jobStarted', { jobId: 'j1', title: 'bg' });
    bg.ingest('subAgentAskUserQuestion', { agentId: 'cursor', questionData: question('q4') });
    expect(bg.model.get('root')).toBeNull();
  });

  it('streamed text and delegate progress pings are activity, not a stall', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'claude-code' });
    const root = h.model.get('root')!;
    for (let i = 0; i < 20; i++) {
      h.clock.t += 5000;
      expect(h.ingest('responseChunk', { type: 'thinking', content: 'hmm' })).toBe(false);
    }
    expect(h.model.statusOf(root, h.clock.t)).toBe('working');
    h.ingest('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Long report' } });
    const card = h.model.get('card:d1')!;
    for (let i = 0; i < 20; i++) {
      h.clock.t += 5000;
      expect(h.ingest('mystiDelegateTrace', { parentId: 'd1', chunk: { type: 'progress' } })).toBe(false);
    }
    expect(h.model.statusOf(card, h.clock.t)).toBe('working');
    expect(card.tools).toEqual([]);
  });

  it('a turn that ends with an action card fails the root, but a capability notice or a job card does not', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'openai-codex' });
    h.ingest('mystiActionRequired', { reason: 'capability-off', message: 'off' });
    h.ingest('mystiActionRequired', { reason: 'signin', message: 'sign in', jobId: 'j1' });
    expect(h.model.get('root')!.status).toBe('working');
    h.ingest('mystiActionRequired', { reason: 'not-installed', message: 'Codex is not installed' });
    expect([h.model.get('root')!.status, h.model.get('root')!.error]).toEqual(['failed', 'Codex is not installed']);
    h.clock.t += 100000;
    expect(h.model.counts().stalled).toBe(0);
  });

  it('the host origin beats a tool id reused by another agent', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'openai-codex' });
    h.ingest('toolUse', { id: 'item_0', name: 'shell', input: { command: 'ls' } });
    h.ingest('responseComplete', {});
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('toolUse', { id: 'c1', name: 'delegate', input: { agent: 'openai-codex', task: 'A' } });
    h.ingest('toolUse', { id: 'c2', name: 'delegate', input: { agent: 'openai-codex', task: 'B' } });
    h.ingest('permissionRequest', { id: 'p1', title: 'Run', toolCallId: 'item_0',
      origin: { kind: 'collaborator', parentToolId: 'c1', agentId: 'openai-codex' } });
    expect(h.model.get('card:c1')!.needs).toEqual(['p1']);
    // Parallel children of the same backend both number their first item item_0.
    for (const parentId of ['c1', 'c2']) {
      h.ingest('mystiDelegateTrace', { parentId, chunk: { type: 'tool_use', toolCall: { id: 'item_0', name: 'read' } } });
    }
    h.ingest('mystiDelegateTrace', { parentId: 'c1', chunk: { type: 'tool_result', toolCall: { id: 'item_0' } } });
    expect([h.model.get('card:c1')!.tools[0].status, h.model.get('card:c2')!.tools[0].status]).toEqual(['done', 'running']);
  });

  it('mention and native-approval origins pick the foreground agent, never a background job of the same backend', () => {
    const h = harness();
    h.ingest('jobStarted', { jobId: 'j1', title: 'bg' });
    h.ingest('jobToolUse', { jobId: 'j1', toolCall: { id: 'jc', name: 'delegate', input: { agent: 'hermes', task: 'bg work' } } });
    h.ingest('jobToolUse', { jobId: 'j1', toolCall: { id: 'jy', name: 'delegate', input: { agent: 'cursor', task: 'bg cursor' } } });
    h.ingest('responseStarted', { provider: 'hermes' });
    h.ingest('toolUse', { id: 'fc', name: 'delegate', input: { agent: 'openai-codex', task: 'fg codex' } });
    h.ingest('toolUse', { id: 'fh', name: 'delegate', input: { agent: 'hermes', task: 'fg hermes' } });
    h.ingest('subAgentStarted', { agentId: 'openai-codex' });
    h.ingest('permissionRequest', { id: 'p-mention', title: 'Edit', origin: { kind: 'mention', agentId: 'openai-codex' } });
    h.ingest('permissionRequest', { id: 'p-native', title: 'Edit', origin: { kind: 'native-approval', agentId: 'hermes' } });
    h.ingest('permissionRequest', { id: 'p-cursor', title: 'Edit', origin: { agentId: 'cursor' } });
    const owner = (id: string) => h.model.nodes().find(node => node.needs.includes(id))!.id;
    expect(owner('p-mention')).toMatch(/^mention:/);
    expect(owner('p-native')).toBe('root');
    expect(owner('p-cursor')).toBe('root');
  });

  it('a successful retry clears the failed attempt, and a Retry on a finished turn reuses its node', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('collaborationStarted', { collaborators: [{ agentId: 'openai-codex' }] });
    const collab = (chunk: Record<string, unknown>) => h.ingest('collaborator', { collaboratorId: 'c1', agentId: 'openai-codex', ...chunk });
    collab({ type: 'collab_started' });
    collab({ type: 'collab_error', failure: 'timeout', content: 'timed out' });
    collab({ type: 'collab_retry', retryCount: 1 });
    collab({ type: 'collab_complete', hasError: false });
    const role = h.model.nodes().find(node => node.kind === 'role')!;
    expect([role.status, role.failure, role.error]).toEqual(['done', undefined, undefined]);

    h.ingest('subAgentStarted', { agentId: 'google-gemini' });
    h.ingest('subAgentError', { agentId: 'google-gemini', error: 'overloaded' });
    h.ingest('subAgentRetry', { agentId: 'google-gemini', retryCount: 1 });
    h.ingest('subAgentComplete', { agentId: 'google-gemini', hasError: false });
    const gemini = () => h.model.nodes().filter(node => node.kind === 'mention');
    expect(gemini().map(node => [node.status, node.error])).toEqual([['done', undefined]]);

    h.ingest('subAgentStarted', { agentId: 'google-gemini' });
    h.ingest('subAgentError', { agentId: 'google-gemini', error: 'boom' });
    h.ingest('responseComplete', {});
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('responseComplete', {});
    // The card's Retry posts subAgentStarted with no responseStarted of its own.
    h.ingest('subAgentStarted', { agentId: 'google-gemini' });
    h.ingest('subAgentComplete', { agentId: 'google-gemini', hasError: false });
    expect(gemini().map(node => node.status)).toEqual(['done']);
  });

  it('a Retry clicked while its turn still runs outlives the turn landing, as its card does', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('subAgentStarted', { agentId: 'openai-codex' });
    h.ingest('subAgentError', { agentId: 'openai-codex', error: 'overloaded' });
    h.ingest('subAgentStarted', { agentId: 'openai-codex' });
    h.ingest('responseComplete', {});
    const codex = h.model.nodes().find(node => node.kind === 'mention')!;
    expect(codex.status).toBe('working');
    h.ingest('subAgentAskUserQuestion', { agentId: 'openai-codex', questionData: question('q-retry') });
    expect(codex.needs).toEqual(['q-retry']);
    h.ingest('subAgentComplete', { agentId: 'openai-codex', hasError: false });
    expect([codex.status, codex.needs]).toEqual(['done', []]);
    // The next send still stops a Retry left running, as the chat stops its card.
    h.ingest('subAgentStarted', { agentId: 'openai-codex' });
    h.ingest('responseStarted', { provider: 'claude-code' });
    expect(codex.status).toBe('interrupted');
  });

  it('a /session refused before it started belongs to no earlier session', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('sessionEvent', { runId: 'S1', type: 'session_started', shape: 'review', lanes: [] });
    h.ingest('sessionEvent', { runId: 'S1', type: 'session_complete', markdown: '', lanes: [] });
    h.ingest('responseComplete', {});
    expect(h.ingest('sessionError', { message: '/review needs at least 2 installed agents' })).toBe(false);
    const s1 = h.model.get('session:S1')!;
    expect([s1.status, s1.error]).toEqual(['done', undefined]);
    // A run that fails mid-way reports its own id.
    h.ingest('sessionEvent', { runId: 'S2', type: 'session_started', shape: 'panel', lanes: [] });
    h.ingest('sessionError', { runId: 'S2', message: 'crashed' });
    expect([h.model.get('session:S2')!.status, h.model.get('session:S2')!.error]).toEqual(['failed', 'crashed']);
  });

  it('a superseded @agent:role run cannot settle or grow the next run', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('collaborationStarted', { runId: 'A', collaborators: [{ agentId: 'claude-code' }] });
    h.ingest('collaborator', { runId: 'A', type: 'collab_started', collaboratorId: '0-claude-code', agentId: 'claude-code' });
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('collaborationStarted', { runId: 'B', collaborators: [{ agentId: 'claude-code' }] });
    h.ingest('collaborator', { runId: 'B', type: 'collab_started', collaboratorId: '0-claude-code', agentId: 'claude-code' });
    h.ingest('collaborator', { runId: 'A', type: 'collab_complete', collaboratorId: '0-claude-code', hasError: false });
    h.ingest('collaborator', { runId: 'A', type: 'collab_started', collaboratorId: '1-openai-codex', agentId: 'openai-codex' });
    h.ingest('collaborationComplete', { runId: 'A' });
    expect(h.model.get('collab:B:0-claude-code')!.status).toBe('working');
    expect(h.model.get('collab:B')!.status).toBe('working');
    expect(h.model.get('collab:A:1-openai-codex')).toBeNull();
    h.ingest('collaborationComplete', { runId: 'B' });
    expect(h.model.get('collab:B:0-claude-code')!.status).toBe('done');
  });

  it('what never ran is never Done: unrun session lanes, a verify that did not report, a turn\'s leftover children', () => {
    const h = harness();
    h.ingest('responseStarted', { provider: 'mysti' });
    h.ingest('sessionEvent', { runId: 's1', type: 'session_started', shape: 'critique', lanes: [
      { collaboratorId: 'p', agentId: 'claude-code', label: 'Proposer', status: 'running' },
      { collaboratorId: 'x', agentId: 'openai-codex', label: 'Attacker', status: 'pending' }] });
    h.ingest('sessionEvent', { runId: 's1', type: 'session_complete', lanes: [
      { collaboratorId: 'p', agentId: 'claude-code', label: 'Proposer', status: 'error', error: 'Critique did not run' }] });
    const attacker = h.model.get('session:s1:x')!;
    expect([attacker.status, attacker.note]).toEqual(['interrupted', 'Not dispatched']);

    h.ingest('mystiStarted', { brief: 'b' });
    h.ingest('mystiEvent', { runId: 'r', type: 'orch_status', phase: 'verify' });
    h.ingest('mystiEvent', { runId: 'r', type: 'orch_status', phase: 'synthesize' });
    const wf = h.model.nodes().find(node => node.kind === 'workflow')!;
    const verify = h.model.get(wf.id + ':verify')!;
    expect([verify.status, verify.note]).toEqual(['interrupted', 'Verify did not report']);

    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('toolUse', { id: 'toolu_1', name: 'Task', input: { description: 'Explore' } });
    h.ingest('error', 'CLI died');
    h.ingest('responseComplete', {});
    expect(h.model.get('card:toolu_1')!.status).toBe('failed');
    h.ingest('responseStarted', { provider: 'claude-code' });
    h.ingest('toolUse', { id: 'toolu_2', name: 'Task', input: { description: 'Explore more' } });
    h.ingest('responseComplete', {});
    expect(h.model.get('card:toolu_2')!.status).toBe('interrupted');
    h.clock.t += 100000;
    expect(h.model.counts().stalled).toBe(0);
  });
});

describe('agent map view', () => {
  it('pill text follows counts and hides while the main agent works alone with no needs', () => {
    const h = harness();
    expect(h.pill().classList.contains('hidden')).toBe(true);
    h.send('responseStarted', { provider: 'mysti' });
    h.send('mystiStarted', { brief: 'An empty workflow is not an agent' });
    expect(h.pill().classList.contains('hidden')).toBe(true);
    h.send('permissionRequest', { id: 'p0', title: 'x' });
    expect(h.pill().textContent).toBe('◆ 1 needs you · 1 agent');
    h.map.permissionResolved('p0');
    expect(h.pill().classList.contains('hidden')).toBe(true);
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 't' } });
    h.send('permissionRequest', { id: 'p1', title: 'x', toolCallId: 'd1' });
    expect(h.pill().textContent).toBe('◆ 1 needs you · 2 agents');
    h.map.permissionResolved('p1');
    h.send('toolResult', { id: 'd1', status: 'completed', output: 'ok' });
    h.send('responseComplete', {});
    expect(h.pill().textContent).toBe('2 agents');
    expect(h.map.counts()).toMatchObject({ agents: 2, done: 2 });
  });

  it('renders untrusted titles and output as text', () => {
    const h = harness();
    h.send('responseStarted', { provider: '<b>x</b>' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: '<img src=x onerror=alert(1)>' } });
    h.send('toolResult', { id: 'd1', status: 'failed', output: '<script>alert(1)</script>' });
    h.map.open();
    h.nodeButton('<img').click();
    expect(h.shell().querySelector('img, script, b')).toBeNull();
    expect(h.shell().textContent).toContain('<img src=x onerror=alert(1)>');
    expect(h.shell().querySelector('.agent-map-result')!.textContent).toBe('<script>alert(1)</script>');
  });

  it('titles the main agent by its backend once known, keeping Main agent as its kind', () => {
    const h = harness();
    h.send('toolUse', { id: 'read1', name: 'Read', input: { file_path: 'a.ts' } });
    h.map.open();
    const rootTitle = () => h.shell().querySelector('.agent-map-kind--root .agent-map-title')!.textContent;
    expect(rootTitle()).toBe('Main agent');
    h.send('responseStarted', { provider: 'claude-code' });
    expect(rootTitle()).toBe('Agent claude-code');
    expect(h.shell().querySelector('.agent-map-kind--root .agent-map-meta')!.textContent).toMatch(/^Main agent/);
    h.nodeButton('Agent claude-code').click();
    expect(h.shell().querySelector('.agent-map-inspector .agent-map-kind')!.textContent).toBe('Main agent');
    expect(h.shell().querySelector('.agent-map-inspector-title')!.textContent).toBe('Agent claude-code');
  });

  it('Escape closes the map, never reaches document listeners, and focus returns', () => {
    const h = harness();
    const documentKeys = vi.fn();
    h.document.addEventListener('keydown', documentKeys);
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'task one' } });
    const composer = h.document.getElementById('composer')!;
    composer.focus();
    h.map.open();
    expect(h.shell().classList.contains('hidden')).toBe(false);
    const first = h.document.activeElement!;
    expect(first.classList.contains('agent-map-node')).toBe(true);
    h.key(first, 'ArrowDown');
    expect(h.document.activeElement!.textContent).toContain('task one');
    h.key(h.document.activeElement!, 'Enter');
    h.key(h.document.activeElement!, '1');
    h.key(h.document.activeElement!, 'Escape');
    expect(documentKeys).not.toHaveBeenCalled();
    expect(h.map.isOpen()).toBe(false);
    expect(h.shell().classList.contains('hidden')).toBe(true);
    expect(h.document.activeElement).toBe(composer);
  });

  it('while open, no key reaches the page wherever focus is, and Escape anywhere closes', () => {
    const h = harness(1200, '<div class="permission-card pending" tabindex="0"></div>');
    const pageKeys = vi.fn();
    h.document.addEventListener('keydown', pageKeys, true);
    h.document.addEventListener('keydown', pageKeys);
    h.send('responseStarted', { provider: 'mysti' });
    h.map.open();
    expect(h.shell().querySelector('.agent-map-panel')!.getAttribute('tabindex')).toBe('-1');
    // A permission card that took focus from behind the overlay, then <body> after a click on plain text.
    const card = h.document.querySelector<HTMLElement>('.permission-card')!;
    card.focus();
    expect(h.key(card, 'Enter')).toBe(false);
    expect(h.shell().contains(h.document.activeElement)).toBe(true);
    h.key(h.document.body, '1');
    h.key(h.document.body, 'Escape');
    expect(pageKeys).not.toHaveBeenCalled();
    expect(h.map.isOpen()).toBe(false);
    h.key(h.document.body, 'Enter');
    expect(pageKeys).toHaveBeenCalledTimes(2);
  });

  it('a chord typed in the map reaches VS Code\'s forwarder; a chord aimed outside it does not', () => {
    const h = harness(1200, '<div class="permission-card pending" tabindex="0"></div>');
    // VS Code's webview script forwards keybindings from a bubble listener on the window.
    const forwarded = vi.fn();
    h.dom.window.addEventListener('keydown', forwarded);
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'task one' } });
    h.map.open();
    const row = h.document.activeElement!;
    expect(h.shell().contains(row)).toBe(true);
    h.key(row, 'P', { metaKey: true, shiftKey: true });
    h.key(row, 'w', { ctrlKey: true });
    h.key(row, 'F1');
    expect(forwarded).toHaveBeenCalledTimes(3);
    expect(h.map.isOpen()).toBe(true);
    // Plain keys stay inside, and so does a chord whose target stole focus from behind.
    h.key(row, 'Enter');
    h.key(h.document.querySelector('.permission-card')!, 'Enter', { metaKey: true });
    expect(forwarded).toHaveBeenCalledTimes(3);
  });

  it('says what is true: Stop is not a failure, estimates are marked, a finished workflow shows no progress line', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Scan auth' } });
    h.send('mystiDelegateTrace', { parentId: 'd1', chunk: { type: 'tool_use', toolCall: { id: 'x1', name: 'shell', input: {} } } });
    h.send('requestCancelled');
    h.map.open();
    const chip = (name: string) => [...h.shell().querySelectorAll('.agent-map-chip')].find(c => c.textContent!.startsWith(name));
    expect(chip('Failed')!.textContent).toBe('Failed0');
    expect(chip('Stopped')!.textContent).toBe('Stopped2');
    expect(h.shell().querySelector('.agent-map-summary')!.textContent).toContain('2 stopped');
    h.nodeButton('Scan auth').click();
    const toolGlyph = h.shell().querySelector('.agent-map-tool .agent-map-glyph')!.textContent;
    expect(toolGlyph).not.toBe('✕');

    h.send('responseStarted', { provider: 'mysti' });
    h.send('responseComplete', { usage: { input_tokens: 40000, output_tokens: 10000, tokensPartial: true } });
    h.nodeButton('Main agent').click();
    const facts = [...h.shell().querySelectorAll('.agent-map-facts dd')].map(dd => dd.textContent);
    expect(facts.some(text => /^~50(\.0)?k/.test(text!) && text!.includes('partly estimated'))).toBe(true);

    h.send('mystiStarted', { brief: 'Ship it' });
    h.send('mystiEvent', { runId: 'r9', type: 'orch_status', phase: 'synthesize', content: 'Synthesizing the result…' });
    h.send('mystiEvent', { runId: 'r9', type: 'orch_done' });
    h.send('mystiComplete', { cancelled: false });
    h.nodeButton('Ship it').click();
    expect(h.shell().querySelector('.agent-map-inspector')!.textContent).not.toContain('Synthesizing the result');
  });

  it('keeps who spawned an earlier turn\'s agent when the next turn runs on another backend', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Fix the parser' } });
    h.send('responseComplete', {});
    h.send('responseStarted', { provider: 'claude-code' });
    h.map.open();
    h.nodeButton('Fix the parser').click();
    const facts = [...h.shell().querySelectorAll('.agent-map-facts > *')].map(el => el.textContent);
    expect(facts[facts.indexOf('Spawned by') + 1]).toBe('Agent mysti');
  });

  it('an empty map says so once, with no filter chips or inspector', () => {
    const h = harness();
    h.map.open();
    expect(h.shell().querySelectorAll('.agent-map-chip')).toHaveLength(0);
    expect(h.shell().querySelector('.agent-map-inspector')).toBeNull();
    expect(h.shell().textContent!.match(/Agents appear here/g)).toHaveLength(1);
  });

  it('a rebuild keeps focus on the panel or a scroller instead of jumping to a row', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'task one' } });
    h.map.open();
    const panel = () => h.shell().querySelector<HTMLElement>('.agent-map-panel')!;
    panel().focus();
    expect(h.document.activeElement).toBe(panel());
    h.send('mystiDelegateTrace', { parentId: 'd1', chunk: { type: 'tool_use', toolCall: { id: 't1', name: 'Read', input: {} } } });
    expect(h.document.activeElement).toBe(panel());
    expect(h.map.isOpen()).toBe(true);
  });

  it('Tab wraps only past the last button, and arrows move only between tree items', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Long report' } });
    h.send('toolResult', { id: 'd1', status: 'completed', output: 'line\n'.repeat(80) });
    h.map.open();
    h.nodeButton('Long report').click();
    // Chromium makes an overflowing result a keyboard-focusable scroller.
    const result = h.shell().querySelector<HTMLElement>('.agent-map-result')!;
    result.tabIndex = 0;
    result.focus();
    expect(h.key(result, 'Tab')).toBe(true);
    expect(h.key(result, 'ArrowDown')).toBe(true);
    expect(h.document.activeElement).toBe(result);
    const panel = h.shell().querySelector<HTMLElement>('.agent-map-panel')!;
    panel.focus();
    h.key(panel, 'Tab', { shiftKey: true });
    const buttons = [...h.shell().querySelectorAll('button')];
    expect(h.document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('Ask another agent is offered only where a task is known', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'claude-code' });
    h.send('collaborationStarted', { runId: 'A', collaborators: [{ agentId: 'openai-codex', roleId: 'critic' }] });
    h.send('collaborator', { runId: 'A', type: 'collab_started', collaboratorId: 'c1', agentId: 'openai-codex', label: 'Codex critic' });
    h.send('collaborator', { runId: 'A', type: 'collab_complete', collaboratorId: 'c1', agentId: 'openai-codex', hasError: false });
    h.map.open();
    h.nodeButton('Codex critic').click();
    expect(h.action('Ask another agent…')).toBeUndefined();
  });

  it('keeps Tab inside the dialog and runs the tick only while open', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.map.open();
    expect(h.intervals.size).toBe(1);
    const buttons = [...h.shell().querySelectorAll('button')];
    buttons[buttons.length - 1].focus();
    h.key(buttons[buttons.length - 1], 'Tab');
    expect(h.document.activeElement).toBe(buttons[0]);
    h.key(buttons[0], 'Tab', { shiftKey: true });
    expect(h.document.activeElement).toBe(buttons[buttons.length - 1]);
    h.clock.t += 95000;
    [...h.intervals.values()][0]();
    expect(h.shell().querySelector('.agent-map-node--stalled')).not.toBeNull();
    h.map.close();
    expect(h.intervals.size).toBe(0);
  });

  it('Review closes the map and focuses the real permission card without posting', () => {
    const h = harness(1200, '<div class="permission-card" data-id="other"></div><div class="permission-card" data-id="p&quot;]1"><button>Approve</button></div>');
    h.send('responseStarted', { provider: 'mysti' });
    h.send('permissionRequest', { id: 'p"]1', title: 'Run npm test', description: 'root wants to run' });
    h.map.open();
    h.postMessage.mockClear();
    h.nodeButton('Main agent').click();
    expect(h.shell().textContent).toContain('Run npm test');
    h.action('Review')!.click();
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(h.map.isOpen()).toBe(false);
    expect((h.document.activeElement as HTMLElement).dataset.id).toBe('p"]1');
  });

  it('posts cancelJob only for a job this panel reported and Stop turn only for a working foreground node', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'fg task' } });
    h.send('jobStarted', { jobId: 'job-1', title: 'bg task' });
    h.map.open();
    h.nodeButton('fg task').click();
    expect(h.action('Stop job')).toBeUndefined();
    h.action('Stop turn')!.click();
    expect(h.postMessage).toHaveBeenLastCalledWith({ type: 'cancelRequest' });
    h.nodeButton('bg task').click();
    expect(h.action('Stop turn')).toBeUndefined();
    h.action('Stop job')!.click();
    expect(h.postMessage).toHaveBeenLastCalledWith({ type: 'cancelJob', payload: { jobId: 'job-1' } });
    const jobIds = h.postMessage.mock.calls.filter(call => call[0].type === 'cancelJob').map(call => call[0].payload.jobId);
    expect(jobIds).toEqual(['job-1']);
    expect(h.postMessage).toHaveBeenCalledWith({ type: 'requestJobs', payload: { source: 'agentMap' } });
  });

  it('filters dim non-matching nodes and chips report aria-pressed', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'broken' } });
    h.send('toolResult', { id: 'd1', status: 'failed', output: '(failed: crashed)' });
    h.map.open();
    const chip = [...h.shell().querySelectorAll<HTMLButtonElement>('.agent-map-chip')].find(c => c.textContent!.startsWith('Failed'))!;
    expect(chip.textContent).toBe('Failed1');
    chip.click();
    const pressed = [...h.shell().querySelectorAll('.agent-map-chip')].filter(c => c.getAttribute('aria-pressed') === 'true');
    expect(pressed.map(c => c.textContent)).toEqual(['Failed1']);
    expect(h.nodeButton('broken').classList.contains('agent-map-node--dim')).toBe(false);
    expect(h.nodeButton('Main agent').classList.contains('agent-map-node--dim')).toBe(true);
  });

  it('chooses the layout by width and drills in on narrow panels', () => {
    const wide = harness(1200);
    wide.map.open();
    expect(wide.shell().classList.contains('agent-map--graph')).toBe(true);
    expect(wide.shell().textContent).toContain('Agents appear here while they work in this chat.');
    const medium = harness(800);
    medium.map.open();
    expect(medium.shell().classList.contains('agent-map--outline')).toBe(true);
    const narrow = harness(500);
    narrow.send('responseStarted', { provider: 'mysti' });
    narrow.map.open();
    expect(narrow.shell().classList.contains('agent-map--narrow')).toBe(true);
    expect(narrow.shell().querySelector('.agent-map-inspector')).toBeNull();
    narrow.nodeButton('Main agent').click();
    expect(narrow.shell().querySelector('.agent-map-tree')).toBeNull();
    expect(narrow.document.activeElement!.textContent).toBe('← All agents');
    (narrow.document.activeElement as HTMLButtonElement).click();
    expect(narrow.shell().querySelector('.agent-map-tree')).not.toBeNull();
    Object.defineProperty(narrow.dom.window, 'innerWidth', { value: 1100, configurable: true });
    narrow.dom.window.dispatchEvent(new narrow.dom.window.Event('resize'));
    expect(narrow.shell().classList.contains('agent-map--graph')).toBe(true);
    // A resize within the same layout keeps the very same rows (no rebuild mid-drag).
    const row = narrow.nodeButton('Main agent');
    Object.defineProperty(narrow.dom.window, 'innerWidth', { value: 1300, configurable: true });
    narrow.dom.window.dispatchEvent(new narrow.dom.window.Event('resize'));
    expect(narrow.nodeButton('Main agent')).toBe(row);
  });

  it('Show in chat appears only with an anchor, and Ask another agent prefills the composer', () => {
    const h = harness(1200, '<div class="tool-call" data-id="d1"></div>');
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Fix bug' } });
    h.send('toolUse', { id: 'd2', name: 'delegate', input: { agent: 'openai-codex', task: 'No card' } });
    h.send('toolResult', { id: 'd1', status: 'failed', output: '(failed: crashed)' });
    h.map.open();
    h.nodeButton('No card').click();
    expect(h.action('Show in chat')).toBeUndefined();
    h.nodeButton('Fix bug').click();
    h.action('Ask another agent…')!.click();
    const choices = [...h.shell().querySelectorAll('.agent-map-ask-item')].map(item => item.textContent);
    expect(choices).toEqual(['Claude']);
    h.action('Claude')!.click();
    expect(h.prefillComposer).toHaveBeenCalledWith('@claude-code Fix bug');
    expect(h.map.isOpen()).toBe(false);
    h.map.open();
    h.nodeButton('Fix bug').click();
    h.action('Show in chat')!.click();
    expect(h.map.isOpen()).toBe(false);
    expect((h.document.activeElement as HTMLElement).dataset.id).toBe('d1');
  });

  it('Show in chat picks the node\'s own card among namesakes, and a lane only inside its own workflow', () => {
    const h = harness(1200,
      '<div class="subagent-card" data-agent-id="openai-codex" id="before-reset"></div>' +
      '<div class="brainstorm-container mysti-container" id="wf-1"><div class="mysti-node" data-node="a"></div></div>' +
      '<div class="subagent-card" data-agent-id="openai-codex" id="turn-1"></div>' +
      '<div class="brainstorm-container" id="debate"></div>' +
      '<div class="brainstorm-container mysti-container" id="wf-2"><div class="mysti-node" data-node="a"></div></div>' +
      '<div class="subagent-card" data-agent-id="openai-codex" id="turn-2"></div>');
    const run = (brief: string, task: string) => {
      h.send('responseStarted', { provider: 'mysti' });
      h.send('mystiStarted', { brief });
      h.send('mystiEvent', { type: 'orch_plan', plan: { nodes: [{ id: 'a', task, dependsOn: [] }] } });
      h.send('mystiComplete', {});
      h.send('mentionTaskStarted', { agentId: 'openai-codex', task: 'Mention ' + brief });
      h.send('subAgentStarted', { agentId: 'openai-codex' });
      h.send('subAgentComplete', { agentId: 'openai-codex' });
      h.send('responseComplete', {});
    };
    run('Brief A', 'Lane A');
    run('Brief B', 'Lane B');
    const shownFor = (title: string) => {
      h.map.open();
      h.nodeButton(title).click();
      h.action('Show in chat')!.click();
      const active = h.document.activeElement as HTMLElement;
      return active.id || active.closest<HTMLElement>('[id]')!.id;
    };
    expect(shownFor('Mention Brief A')).toBe('turn-1');
    expect(shownFor('Mention Brief B')).toBe('turn-2');
    expect(shownFor('Lane A')).toBe('wf-1');
    expect(shownFor('Lane B')).toBe('wf-2');
    expect(shownFor(': Brief B')).toBe('wf-2');
    expect(shownFor(': Brief A')).toBe('wf-1');
    // A lane whose workflow card is gone offers nothing rather than another run's lane.
    h.document.getElementById('wf-1')!.remove();
    h.map.open();
    h.nodeButton('Lane A').click();
    expect(h.action('Show in chat')).toBeUndefined();
  });

  it('the tree is valid ARIA: rows own their groups, drawn labels are hidden, lanes name their column', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Solo' } });
    h.send('mystiStarted', { brief: 'Build it' });
    h.send('mystiEvent', { type: 'orch_plan', plan: { nodes: [
      { id: 'a', task: 'Schema', dependsOn: [] }, { id: 'b', task: 'API', dependsOn: ['a'] }] } });
    h.map.open();
    const owned = (row: HTMLElement) => (row.getAttribute('aria-owns') || '').split(' ').filter(Boolean)
      .map(id => h.document.getElementById(id));
    const root = h.nodeButton('Main agent');
    expect(root.getAttribute('aria-expanded')).toBe('true');
    expect(owned(root).map(group => group!.parentElement)).toEqual([root.parentElement]);
    const workflow = h.nodeButton('Build it');
    expect(owned(workflow).map(group => group!.getAttribute('role'))).toEqual(['group', 'group']);
    expect(h.nodeButton('Solo').hasAttribute('aria-expanded')).toBe(false);
    expect(h.nodeButton('Solo').hasAttribute('aria-owns')).toBe(false);
    for (const drawn of h.shell().querySelectorAll('.agent-map-main .agent-map-wf-phases, .agent-map-wf-col-label')) {
      expect(drawn.getAttribute('aria-hidden')).toBe('true');
    }
    expect(h.nodeButton('API').querySelector('.agent-map-sr')!.textContent).toBe('Waiting, Then: ');
    expect(h.nodeButton('Schema').querySelector('.agent-map-sr')!.textContent).toBe('Waiting, Run: ');
  });

  it('timeline bars and long tool names carry their meaning in text, not colour or width alone', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 't1', name: 'mcp__trello-composio__COMPOSIO_MULTI_EXECUTE_TOOL', input: { query: 'cards' } });
    h.send('mystiStarted', { brief: 'Build it' });
    h.send('mystiEvent', { type: 'orch_node_start', nodeId: 'a' });
    h.send('mystiEvent', { type: 'orch_node_start', nodeId: 'b' });
    h.send('mystiEvent', { type: 'orch_node_done', nodeId: 'a', hasError: true });
    h.map.open();
    h.nodeButton('Build it').click();
    const labels = [...h.shell().querySelectorAll('.agent-map-bar-label')].map(label => label.textContent);
    expect(labels).toEqual(['✕Failed: a', '◔Working: b']);
    expect(h.shell().querySelector<HTMLElement>('.agent-map-bar--failed')!.title).toBe('Failed');
    h.nodeButton('Main agent').click();
    expect(h.shell().querySelector<HTMLElement>('.agent-map-tool-name')!.title).toBe('mcp__trello-composio__COMPOSIO_MULTI_EXECUTE_TOOL');
  });

  it('a rebuild keeps scroll and a text selection, and the tick rebuilds only while something works', () => {
    const h = harness();
    h.send('responseStarted', { provider: 'mysti' });
    h.send('toolUse', { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Long report' } });
    h.send('toolResult', { id: 'd1', status: 'completed', output: 'line\n'.repeat(80) });
    h.map.open();
    h.nodeButton('Long report').click();
    const q = (selector: string) => h.shell().querySelector<HTMLElement>(selector)!;
    Object.assign(q('.agent-map-main'), { scrollTop: 40, scrollLeft: 700 });
    q('.agent-map-inspector').scrollTop = 30;
    q('.agent-map-result').scrollTop = 50;
    const before = q('.agent-map-result');
    h.send('toolUse', { id: 't1', name: 'Read', input: { file_path: 'a.ts' } });
    expect(q('.agent-map-result')).not.toBe(before);
    expect([q('.agent-map-main').scrollTop, q('.agent-map-main').scrollLeft, q('.agent-map-inspector').scrollTop,
      q('.agent-map-result').scrollTop]).toEqual([40, 700, 30, 50]);

    // Selecting text to copy: neither a message nor the tick may rebuild under it,
    // and the turn that landed meanwhile is drawn once the selection ends.
    const selection = h.dom.window.getSelection()!;
    const range = h.document.createRange();
    range.selectNodeContents(q('.agent-map-result'));
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = q('.agent-map-result');
    h.send('responseComplete', {});
    expect(h.pill().textContent).toBe('2 agents');
    [...h.intervals.values()][0]();
    expect(q('.agent-map-result')).toBe(selected);
    selection.removeAllRanges();
    [...h.intervals.values()][0]();
    expect(q('.agent-map-result')).not.toBe(selected);
    expect(h.shell().querySelector('.agent-map-node--working')).toBeNull();

    // Nothing working: the tick leaves the view alone. Another node starts its inspector at the top.
    const settled = q('.agent-map-result');
    [...h.intervals.values()][0]();
    expect(q('.agent-map-result')).toBe(settled);
    q('.agent-map-inspector').scrollTop = 30;
    h.nodeButton('Main agent').click();
    expect(q('.agent-map-inspector').scrollTop).toBe(0);
  });

  it('reset keeps jobs, re-requests them, and drops the rest', () => {
    const h = harness();
    h.send('jobStarted', { jobId: 'j1', title: 'bg' });
    h.send('responseStarted', { provider: 'mysti' });
    h.postMessage.mockClear();
    h.map.reset();
    expect(h.postMessage).toHaveBeenCalledWith({ type: 'requestJobs', payload: { source: 'agentMap' } });
    expect(h.map.counts()).toMatchObject({ agents: 1, working: 1 });
  });
});
