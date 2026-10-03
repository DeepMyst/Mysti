/**
 * Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0
 *
 * Agent map (Plan 32). One view of every agent working in this chat, built
 * only from the messages the host already posts to this panel. It is a view:
 * it never answers an approval or a question, and the only messages it posts
 * are cancelRequest, requestJobs and cancelJob for a job this panel reported.
 * Transport, clock and chat lookups enter through create(); ids are opaque
 * data, never selectors.
 */
/* global module */
(function(global) {
  'use strict';
  const STALL_MS = 90000;
  const TICK_MS = 5000;
  const TOOL_ROWS = 20;
  const CONTAINERS = new Set(['workflow', 'session', 'debate', 'collab']);
  const TERMINAL = new Set(['done', 'failed', 'interrupted']);
  const CARD_KINDS = new Set(['delegate', 'native', 'advisor', 'review']);
  const REPORTED_TOOLS = new Set(['task', 'agent', 'dispatch_agent']);
  const ASK_KINDS = new Set(['delegate', 'lane', 'mention', 'role', 'session-lane']);
  const PHASES = [['plan', 'Plan'], ['run', 'Run'], ['verify', 'Verify'], ['synthesize', 'Synthesize']];
  const KIND_LABEL = {
    root: 'Main agent', workflow: 'Workflow', step: 'Step', lane: 'Lane', delegate: 'Delegate',
    native: 'Mysti scout', advisor: 'Advisor', review: 'Review', mention: 'Mention', collab: 'Role group',
    role: 'Role', session: 'Session', 'session-lane': 'Session lane', debate: 'Debate', debater: 'Debater',
    reported: 'Subagent', job: 'Background job',
  };
  // Shape differs per status so the state never rests on colour alone.
  const GLYPH = { waiting: '○', working: '◔', needs: '◆', stalled: '▲', done: '✓', failed: '✕', interrupted: '■' };
  const STATUS_LABEL = {
    waiting: 'Waiting', working: 'Working', needs: 'Needs you', stalled: 'Stalled',
    done: 'Done', failed: 'Failed', interrupted: 'Interrupted',
  };
  const FILTERS = [
    ['all', 'All', () => true],
    ['needs', 'Needs you', status => status === 'needs'],
    ['working', 'Working', status => status === 'working' || status === 'stalled'],
    ['done', 'Done', status => status === 'done'],
    ['failed', 'Failed', status => status === 'failed'],
    // Shown only once something was stopped; a user's Stop is not a failure.
    ['stopped', 'Stopped', status => status === 'interrupted'],
  ];
  const JOB_STATUS = { running: 'working', done: 'done', failed: 'failed', cancelled: 'interrupted', interrupted: 'interrupted' };
  const LANE_STATUS = { running: 'working', done: 'done', error: 'failed', skipped: 'failed' };

  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isId = value => typeof value === 'string' && value.length > 0;
  const str = value => (typeof value === 'string' ? value : '');
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const clip = (value, max) => { const text = str(value); return text.length > max ? text.slice(0, max) + '…' : text; };

  /** Tokens actually measured, or null. An all-zero record is unmeasured, not free. */
  function usageTokens(usage) {
    if (!isRecord(usage)) { return null; }
    let total = 0;
    let signal = false;
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      const value = num(usage[key]);
      if (value !== null && value > 0) { total += value; signal = true; }
    }
    return signal ? total : null;
  }
  function summarize(input) {
    if (!isRecord(input)) { return ''; }
    for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'task', 'description']) {
      if (isId(input[key])) { return clip(input[key], 80); }
    }
    return '';
  }

  function createModel(options) {
    const now = options && typeof options.now === 'function' ? options.now : () => Date.now();
    const nodes = new Map();
    const needs = new Map();
    const toolOwner = new Map();   // tool row id -> node id
    const cards = new Map();       // coordinator card id -> node id
    const runs = new Map();        // orchestrator runId -> workflow node id
    const jobs = new Set();        // job ids this panel reported
    const mentions = new Map();    // agent id -> its latest mention node, as the chat keys its cards
    let turn = 0;
    let sequence = 0;
    let workflow = null;
    let session = null;
    let debate = null;

    const get = id => (isId(id) && nodes.get(id)) || null;
    const children = id => [...nodes.values()].filter(node => node.parentId === id);
    const turnParent = () => (nodes.has('root') ? 'root' : null);

    function touch(node) {
      const t = now();
      for (let current = node, hops = 0; current && hops < 64; current = get(current.parentId), hops++) {
        current.lastEventAt = t;
      }
    }
    function upsert(id, kind, parentId, fields) {
      let node = nodes.get(id);
      if (!node) {
        node = {
          id, parentId: parentId || null, kind, title: '', status: 'waiting', startedAt: null, endedAt: null,
          lastEventAt: now(), tools: [], needs: [], dependsOn: [], turn, bg: false,
          // The shared root changes backend with each turn; keep the one that spawned this node.
          spawnedBy: parentId === 'root' ? ((nodes.get('root') || {}).backend || '') : undefined,
        };
        nodes.set(id, node);
      }
      if (fields) { Object.assign(node, fields); }
      touch(node);
      return node;
    }
    function start(node) {
      if (node.status === 'working') { return; }
      node.status = 'working';
      node.endedAt = null;
      if (node.startedAt === null) { node.startedAt = now(); }
    }
    function finish(node, status, force) {
      if (!node || (TERMINAL.has(node.status) && !force)) { return; }
      node.status = status;
      node.endedAt = now();
      node.retry = false;
      for (const tool of node.tools) {
        if (tool.status === 'running') { tool.status = status === 'done' || status === 'interrupted' ? status : 'failed'; }
      }
      // The chat drops a sub-agent's question card when that agent ends, and the
      // host stops waiting; permissions are dismissed by the host itself. The main
      // agent's question outlives its turn: the answer arrives as the next send.
      if (node.kind !== 'root') { resolveQuestions(node); }
    }
    function resolveQuestions(node) {
      for (const id of node.needs.slice()) { if ((needs.get(id) || {}).kind === 'question') { resolveNeed(id); } }
    }
    function isUnder(node, ancestorId) {
      for (let current = get(node.parentId), hops = 0; current && hops < 64; current = get(current.parentId), hops++) {
        if (current.id === ancestorId) { return true; }
      }
      return false;
    }
    function settleUnder(ancestorId, status, waitingStatus) {
      for (const node of nodes.values()) {
        // A Retry started from its card runs on after the turn lands, as its card does.
        if (!TERMINAL.has(node.status) && !node.retry && isUnder(node, ancestorId)) {
          if (node.status === 'waiting' && waitingStatus) { node.note = 'Not dispatched'; }
          finish(node, node.status === 'waiting' ? waitingStatus || status : status);
        }
      }
    }
    function ensureRoot() {
      return get('root') || upsert('root', 'root', null, { title: 'Main agent', status: 'working', startedAt: now() });
    }

    function addTool(node, call) {
      if (!node || !isRecord(call) || !isId(call.id)) { return false; }
      let row = node.tools.find(tool => tool.id === call.id);
      if (!row) {
        row = { id: call.id, name: '', summary: '', status: 'running' };
        node.tools.push(row);
        if (node.tools.length > TOOL_ROWS) { node.tools.shift(); }
      }
      row.name = str(call.name) || row.name || 'tool';
      row.summary = summarize(call.input) || row.summary;
      toolOwner.set(call.id, node.id);
      touch(node);
      return true;
    }
    // Tool ids are only unique per process (Codex numbers item_0, item_1, …),
    // so a caller that knows the owner passes it rather than trust the index.
    function settleTool(call, forced, owner) {
      if (!isRecord(call) || !isId(call.id)) { return false; }
      const node = owner || get(toolOwner.get(call.id));
      const row = node && node.tools.find(tool => tool.id === call.id);
      if (!row) { return false; }
      row.status = forced || (call.status === 'failed' ? 'failed' : 'done');
      touch(node);
      return true;
    }

    function addNeed(id, kind, node, title, detail) {
      if (!isId(id) || needs.has(id)) { return false; }
      needs.set(id, { id, kind, nodeId: node.id, title: clip(title, 200), detail: clip(detail, 400) });
      node.needs.push(id);
      touch(node);
      return true;
    }
    function resolveNeed(id) {
      const need = isId(id) && needs.get(id);
      if (!need) { return false; }
      needs.delete(id);
      const node = get(need.nodeId);
      if (node) { node.needs = node.needs.filter(other => other !== id); touch(node); }
      return true;
    }
    function hasNeedsBelow(node) {
      for (const need of needs.values()) {
        const owner = get(need.nodeId);
        if (owner && (owner.id === node.id || isUnder(owner, node.id))) { return true; }
      }
      return false;
    }
    function isStalled(node, t) {
      return !!node && node.status === 'working' && !hasNeedsBelow(node) &&
        (num(t) === null ? now() : t) - node.lastEventAt >= STALL_MS;
    }
    function statusOf(node, t) {
      if (node.needs.length) { return 'needs'; }
      return isStalled(node, t) ? 'stalled' : node.status;
    }

    // ---- attribution ----
    function byCollaborator(collaboratorId) {
      let found = null;
      for (const node of nodes.values()) { if (node.collaboratorId === collaboratorId) { found = node; } }
      return found;
    }
    function byBackend(agentId) {
      if (!isId(agentId)) { return null; }
      const hits = [...nodes.values()].filter(node => node.backend === agentId && node.status === 'working' &&
        !node.bg && node.kind !== 'root' && !CONTAINERS.has(node.kind));
      return hits.length === 1 ? hits[0] : null;
    }
    function byCardPrefix(toolCallId) {
      for (const [cardId, nodeId] of cards) {
        if (toolCallId.startsWith(cardId + '-t')) { return get(nodeId); }
      }
      return null;
    }
    function ownerOf(p) {
      const origin = isRecord(p.origin) ? p.origin : {};
      const toolCallId = isId(p.toolCallId) ? p.toolCallId : '';
      const root = get('root');
      // The host's origin names the requester; a tool id may be a reused one from another agent.
      return (isId(p.ownerKey) && get('job:' + p.ownerKey)) ||
        (isId(origin.parentToolId) && get(cards.get(origin.parentToolId))) ||
        (isId(origin.collaboratorId) && byCollaborator(origin.collaboratorId)) ||
        (origin.kind === 'mention' && mentionOf(origin.agentId)) ||
        (origin.kind === 'native-approval' && root && root.status === 'working' && isId(origin.agentId) &&
          root.backend === origin.agentId && root) ||
        (toolCallId && (get(cards.get(toolCallId)) || byCardPrefix(toolCallId) || get(toolOwner.get(toolCallId)))) ||
        byBackend(origin.agentId) ||
        ensureRoot();
    }

    // ---- coordinator cards (foreground and job-routed) ----
    function card(call, meta, parentId, prefix, jobId) {
      if (!isRecord(call) || !isId(call.id)) { return null; }
      const input = isRecord(call.input) ? call.input : {};
      const name = str(call.name).toLowerCase();
      let kind = null;
      let backend = '';
      let title = '';
      if (name === 'delegate') {
        const agent = str(input.agent);
        kind = agent === 'mysti' ? 'native' : agent === 'advisor' ? 'advisor' : 'delegate';
        backend = kind === 'native' ? 'mysti' : kind === 'advisor' ? '' : agent;
        title = str(input.task);
      } else if (name === 'review') {
        kind = 'review';
        backend = str(input.reviewer);
        title = 'Review of ' + (str(input.of) || 'the change');
      } else if (REPORTED_TOOLS.has(name) && !call.id.startsWith('mysti-') && !jobId) {
        kind = 'reported';
        backend = (get('root') || {}).backend || '';
        title = str(input.description) || str(input.prompt) || str(call.name);
      }
      if (!kind) { return null; }
      const m = isRecord(meta) ? meta : {};
      if (CARD_KINDS.has(m.kind)) { kind = m.kind; }
      const node = upsert(prefix + 'card:' + call.id, kind, parentId, { cardId: call.id, bg: !!jobId });
      if (jobId) { node.jobId = jobId; }
      if (isId(m.backend) || backend) { node.backend = str(m.backend) || backend; }
      if (title) { node.title = clip(title, 300); node.task = title; }
      if (isId(input.access) || isId(m.access)) { node.access = str(m.access) || str(input.access); }
      if (isId(input.model) || isId(m.model)) { node.model = str(m.model) || str(input.model); }
      start(node);
      cards.set(call.id, node.id);
      return node;
    }
    function cardResult(node, call, meta) {
      const output = str(call.output);
      const m = isRecord(meta) ? meta : {};
      node.result = clip(output, 2000);
      if (isId(m.failure)) { node.failure = m.failure; }
      else {
        const parsed = /^\((?:review )?failed: ([\w-]+)(?: — (.*?))?\)/.exec(output);
        if (parsed) { node.failure = parsed[1]; if (parsed[2]) { node.error = clip(parsed[2], 400); } }
      }
      if (isId(m.model)) { node.model = m.model; }
      if (isId(m.via)) { node.via = m.via; }
      if (usageTokens(m.usage) !== null) { node.usage = m.usage; }
      if (num(m.costUsd) !== null) { node.costUsd = m.costUsd; node.costApprox = m.costApprox === true; }
      // The result is the truth even when a Stop already marked the card interrupted.
      finish(node, output === 'Stopped by user' ? 'interrupted' : call.status === 'failed' ? 'failed' : 'done', true);
      touch(node);
    }

    // ---- collaborator chunks: orchestration lanes and @agent:role members ----
    function applyCollab(node, chunk) {
      if (isId(chunk.agentId)) { node.backend = chunk.agentId; }
      if (isId(chunk.role)) { node.role = chunk.role; }
      touch(node);
      switch (chunk.type) {
        case 'collab_started': start(node); return true;
        case 'collab_tool_use': start(node); return addTool(node, chunk.toolCall);
        case 'collab_tool_result': return settleTool(chunk.toolCall, undefined, node);
        case 'collab_tool_denied':
          settleTool(chunk.toolCall, 'failed', node);
          node.note = clip(chunk.content, 300) || 'A tool was denied.';
          return true;
        case 'collab_retry':
          start(node);
          node.failure = node.error = undefined;
          node.note = 'Retry ' + (num(chunk.retryCount) || 1);
          return true;
        case 'collab_error':
          // Not terminal: the pool retries, and collab_complete always closes the attempt.
          if (isId(chunk.failure)) { node.failure = chunk.failure; }
          node.error = clip(chunk.content, 400);
          return true;
        case 'collab_complete':
          if (usageTokens(chunk.usage) !== null) { node.usage = chunk.usage; }
          if (isId(chunk.responseText)) { node.result = clip(chunk.responseText, 2000); }
          if (isId(chunk.failure)) { node.failure = chunk.failure; }
          finish(node, chunk.hasError ? 'failed' : 'done');
          return true;
        case 'collab_skipped':
          if (isId(chunk.failure)) { node.failure = chunk.failure; }
          if (isId(chunk.hint)) { node.note = clip(chunk.hint, 300); }
          finish(node, 'failed');
          return true;
      }
      return false;
    }

    // ---- orchestration ----
    function workflowFor(p) {
      const runId = str(p.runId);
      let node = get(runs.get(runId));
      if (!node) {
        const current = get(workflow);
        node = current && !TERMINAL.has(current.status) && (!current.runId || current.runId === runId) ? current : null;
      }
      if (!node) {
        node = upsert('wf:' + (runId || ++sequence), 'workflow', turnParent(), { title: 'Workflow' });
        start(node);
        workflow = node.id;
      }
      if (runId && !node.runId) { node.runId = runId; runs.set(runId, node.id); }
      return node;
    }
    function step(wf, key, title) {
      return upsert(wf.id + ':' + key, 'step', wf.id, { title, phase: key, backend: 'mysti' });
    }
    function lane(wf, nodeId) {
      return upsert(wf.id + ':n:' + nodeId, 'lane', wf.id, { lane: nodeId, collaboratorId: nodeId });
    }
    function mystiEvent(p) {
      const wf = workflowFor(p);
      touch(wf);
      switch (p.type) {
        case 'orch_status': {
          if (isId(p.content)) { wf.note = clip(p.content, 300); }
          if (p.phase === 'decompose') { start(step(wf, 'plan', 'Plan')); wf.phase = 'plan'; }
          else if (p.phase === 'execute') { finish(get(wf.id + ':plan'), 'done'); wf.phase = 'run'; }
          else if (p.phase === 'verify') { start(step(wf, 'verify', 'Verify')); wf.phase = 'verify'; }
          else if (p.phase === 'synthesize') {
            // Only orch_node_done 'verify' means the check ran; a throw skips straight here.
            const verify = get(wf.id + ':verify');
            if (verify && !TERMINAL.has(verify.status)) { verify.note = 'Verify did not report'; finish(verify, 'interrupted'); }
            start(step(wf, 'synth', 'Synthesize'));
            wf.phase = 'synthesize';
          }
          return true;
        }
        case 'orch_plan': {
          finish(get(wf.id + ':plan'), 'done');
          const planned = isRecord(p.plan) && Array.isArray(p.plan.nodes) ? p.plan.nodes : [];
          for (const item of planned) {
            if (!isRecord(item) || !isId(item.id)) { continue; }
            const node = lane(wf, item.id);
            node.title = clip(item.task, 300) || item.id;
            node.task = str(item.task);
            if (isId(item.backend) && !node.backend) { node.backend = item.backend; }
            node.dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn.filter(isId) : [];
          }
          return true;
        }
        case 'orch_node_start': {
          if (!isId(p.nodeId)) { return false; }
          const node = lane(wf, p.nodeId);
          if (isId(p.nodeBackend)) { node.backend = p.nodeBackend; }
          if (!node.title) { node.title = clip(p.content, 300) || p.nodeId; node.task = str(p.content); }
          start(node);
          return true;
        }
        case 'orch_collab': {
          const chunk = isRecord(p.collab) ? p.collab : null;
          const nodeId = str(p.nodeId) || (chunk && str(chunk.collaboratorId));
          if (!chunk || !nodeId) { return false; }
          const node = lane(wf, nodeId);
          if (!node.title) { node.title = str(chunk.label) || nodeId; }
          return applyCollab(node, chunk);
        }
        case 'orch_node_done': {
          if (!isId(p.nodeId)) { return false; }
          if (p.nodeId === 'verify' && wf.phase === 'verify') { finish(get(wf.id + ':verify'), 'done'); return true; }
          finish(lane(wf, p.nodeId), p.hasError ? 'failed' : 'done');
          return true;
        }
        case 'orch_synthesis': {
          const synth = step(wf, 'synth', 'Synthesize');
          synth.result = clip(p.content, 2000);
          finish(synth, 'done');
          return true;
        }
        case 'orch_error':
          wf.error = clip(p.error, 400) || 'Orchestration failed';
          settleUnder(wf.id, 'failed');
          finish(wf, 'failed');
          return true;
        case 'orch_done':
          wf.phase = 'done';
          wf.note = undefined;
          return true;
      }
      return false;
    }
    function settleWorkflow(status, error) {
      const wf = get(workflow);
      workflow = null;
      if (!wf) { return false; }
      if (error) { wf.error = error; }
      // A refused single-lane plan never dispatches and never sends orch_done;
      // its lanes must not wait forever once the run itself is over.
      settleUnder(wf.id, status, status === 'done' ? 'interrupted' : undefined);
      finish(wf, status);
      return true;
    }

    // ---- sub-agents, roles, sessions, brainstorm ----
    function mention(agentId) {
      const node = upsert('mention:' + turn + ':' + agentId, 'mention', turnParent(), { backend: agentId });
      mentions.set(agentId, node.id);
      return node;
    }
    const mentionOf = agentId => (isId(agentId) && get(mentions.get(agentId))) || null;
    function subAgent(type, p) {
      if (!isId(p.agentId)) { return false; }
      let node = mentionOf(p.agentId);
      if (type !== 'subAgentStarted' && !node) { return false; }
      if (type === 'subAgentStarted') {
        // A Retry on a finished turn restarts the same agent; there is no new turn for it.
        const root = get('root');
        const retry = node && !(root && root.status === 'working');
        node = get('mention:' + turn + ':' + p.agentId) || (retry && node) || mention(p.agentId);
      }
      touch(node);
      switch (type) {
        case 'subAgentStarted': {
          if (!node.title) { node.title = '@' + p.agentId; }
          const restarted = TERMINAL.has(node.status);
          node.failure = node.error = undefined;
          start(node);
          node.retry = restarted;
          return true;
        }
        case 'subAgentToolUse': return addTool(node, p.toolCall);
        case 'subAgentToolResult': return settleTool(p.toolCall, undefined, node);
        case 'subAgentStatus': node.note = clip(p.status, 200); return true;
        case 'subAgentRetry':
          node.note = 'Retry ' + (num(p.retryCount) || 1);
          node.failure = node.error = undefined;
          start(node);
          return true;
        case 'subAgentComplete': finish(node, p.hasError ? 'failed' : 'done'); return true;
        case 'subAgentError': node.error = clip(p.error, 400) || 'Unknown error'; finish(node, 'failed'); return true;
      }
      return false;
    }
    // A new send does not stop an @agent:role run, so its late chunks carry the run's id.
    const collabKey = p => 'collab:' + (isId(p.runId) ? p.runId : turn);
    function collaborator(chunk) {
      if (!isRecord(chunk) || !isId(chunk.collaboratorId)) { return false; }
      if (isId(chunk.runId)) {
        const known = get(collabKey(chunk));
        if (!known || TERMINAL.has(known.status)) { return false; }
      }
      const group = upsert(collabKey(chunk), 'collab', turnParent(), {});
      if (!group.title) { group.title = 'Collaborators'; start(group); }
      const node = upsert(group.id + ':' + chunk.collaboratorId, 'role', group.id, { collaboratorId: chunk.collaboratorId });
      if (!node.title) { node.title = str(chunk.label) || str(chunk.role) || str(chunk.agentId) || 'Collaborator'; }
      return applyCollab(node, chunk);
    }
    function sessionLane(sessionId, item) {
      if (!isRecord(item) || !isId(item.collaboratorId)) { return; }
      const node = upsert(sessionId + ':' + item.collaboratorId, 'session-lane', sessionId, {
        collaboratorId: item.collaboratorId, title: str(item.label) || item.collaboratorId,
      });
      if (isId(item.agentId)) { node.backend = item.agentId; }
      if (isId(item.error)) { node.error = clip(item.error, 400); }
      if (isId(item.hint)) { node.note = clip(item.hint, 300); }
      if (isId(item.text)) { node.result = clip(item.text, 2000); }
      const status = LANE_STATUS[item.status];
      if (status === 'working') { start(node); }
      else if (status) { finish(node, status); }
    }
    function sessionEvent(p) {
      const runId = str(p.runId);
      if (p.type === 'session_started') {
        session = 'session:' + (runId || ++sequence);
        const node = upsert(session, 'session', turnParent(), { title: '/' + (str(p.shape) || 'session') });
        start(node);
        (Array.isArray(p.lanes) ? p.lanes : []).forEach(item => sessionLane(session, item));
        return true;
      }
      const node = get(runId ? 'session:' + runId : session);
      if (!node) { return false; }
      touch(node);
      switch (p.type) {
        case 'lane_update': sessionLane(node.id, p.lane); return true;
        case 'lane_text': {
          const member = get(node.id + ':' + str(p.collaboratorId));
          if (member) { touch(member); }
          return false;
        }
        case 'session_round': node.note = 'Round ' + (num(p.round) || 1) + ' of ' + (num(p.of) || 1); return true;
        case 'session_complete':
          (Array.isArray(p.lanes) ? p.lanes : []).forEach(item => sessionLane(node.id, item));
          settleUnder(node.id, 'done', 'interrupted');
          finish(node, 'done');
          session = null;
          return true;
        case 'session_error':
          // A refusal before any session started carries no run and belongs to none.
          if (TERMINAL.has(node.status)) { return false; }
          node.error = clip(p.message, 400) || 'The session failed.';
          settleUnder(node.id, 'failed');
          finish(node, 'failed');
          session = null;
          return true;
      }
      return false;
    }
    function debater(agentId) {
      const group = get(debate);
      if (!group || !isId(agentId)) { return null; }
      return upsert(group.id + ':' + agentId, 'debater', group.id, { backend: agentId, title: agentId });
    }
    function brainstorm(type, p) {
      if (type === 'brainstormStarted') {
        // Brainstorm is its own turn and posts no responseStarted.
        turn++;
        debate = 'debate:' + turn;
        const node = upsert(debate, 'debate', null, { title: clip(p.query, 300) || 'Brainstorm', note: str(p.strategy) });
        start(node);
        return true;
      }
      const group = get(debate);
      if (!group) { return false; }
      touch(group);
      switch (type) {
        case 'brainstormAgentChunk':
        case 'brainstormDiscussionChunk': {
          const node = debater(p.agentId);
          if (!node || node.status === 'working') { return false; }
          start(node);
          return true;
        }
        case 'brainstormDiscussionRoundStart':
          group.note = clip(p.label, 200) || 'Round ' + (num(p.roundNumber) || 1);
          if (isId(p.agentId)) { start(debater(p.agentId)); }
          return true;
        case 'brainstormAgentComplete': finish(debater(p.agentId), 'done'); return true;
        case 'brainstormAgentError':
        case 'brainstormDiscussionError': {
          const node = isId(p.agentId) ? debater(p.agentId) : group;
          node.error = clip(p.error, 400) || 'Unknown error';
          if (node !== group) { finish(node, 'failed', true); }
          return true;
        }
        case 'brainstormConvergenceUpdate': {
          const value = isRecord(p.convergence) ? num(p.convergence.overallConvergence) : null;
          if (value === null) { return false; }
          group.convergence = Math.round(Math.max(0, Math.min(1, value)) * 100);
          return true;
        }
        case 'brainstormPhaseChange':
          if (p.phase !== 'synthesis') { return false; }
          for (const node of children(group.id)) { if (node.kind === 'debater') { finish(node, 'done'); } }
          start(step(group, 'synth', 'Synthesize'));
          return true;
        case 'brainstormSynthesisChunk': {
          const synth = step(group, 'synth', 'Synthesize');
          if (synth.status === 'working') { return false; }
          start(synth);
          return true;
        }
        case 'brainstormComplete':
          settleUnder(group.id, 'done');
          finish(group, 'done');
          debate = null;
          return true;
        case 'brainstormError':
          group.error = clip(p.error, 400) || 'Brainstorm failed';
          settleUnder(group.id, 'failed');
          finish(group, 'failed');
          debate = null;
          return true;
      }
      return false;
    }

    // ---- background jobs ----
    function job(jobId, fields) {
      jobs.add(jobId);
      return upsert('job:' + jobId, 'job', null, Object.assign({ bg: true, jobId }, fields));
    }
    function jobEvent(type, p) {
      if (type === 'jobsList') {
        for (const record of Array.isArray(p.jobs) ? p.jobs : []) {
          if (!isRecord(record) || !isId(record.id)) { continue; }
          const node = job(record.id, {});
          if (isId(record.title)) { node.title = clip(record.title, 300); }
          if (num(record.startedAt) !== null) { node.startedAt = record.startedAt; }
          if (num(record.finishedAt) !== null) { node.endedAt = record.finishedAt; }
          if (isId(record.resultText)) { node.result = clip(record.resultText, 2000); }
          if (isId(record.error)) { node.error = clip(record.error, 400); }
          const status = JOB_STATUS[record.status];
          if (status === 'working') { start(node); }
          else if (status) { node.status = status; if (node.endedAt === null) { node.endedAt = now(); } }
        }
        return true;
      }
      if (!isId(p.jobId)) { return false; }
      const existing = get('job:' + p.jobId);
      if (type !== 'jobStarted' && !existing) { return false; }
      const node = existing || job(p.jobId, {});
      touch(node);
      const call = isRecord(p.toolCall) ? p.toolCall : null;
      switch (type) {
        case 'jobStarted': {
          node.title = clip(p.title, 300) || 'Background job';
          start(node);
          // The foreground turn handed itself to the job; no responseComplete follows.
          const root = get('root');
          if (root && root.status === 'working') { root.note = 'Moved to the background'; finish(root, 'done'); }
          return true;
        }
        case 'jobProgress': return false;
        case 'jobToolUse':
          return !!call && (!!card(call, p.meta || call.meta, node.id, node.id + ':', p.jobId) || addTool(node, call));
        case 'jobToolResult': {
          if (!call || !isId(call.id)) { return false; }
          const owner = get(cards.get(call.id));
          if (owner) { cardResult(owner, call, p.meta || call.meta); return true; }
          return settleTool(call);
        }
        case 'jobComplete':
          if (isRecord(p.message) && isId(p.message.content)) { node.result = clip(p.message.content, 2000); }
          finish(node, 'done', true);
          return true;
        case 'jobError': node.error = clip(p.error, 400) || 'Background job failed'; finish(node, 'failed', true); return true;
        case 'jobCancelled': finish(node, 'interrupted', true); return true;
      }
      return false;
    }

    // ---- the turn ----
    function interruptForeground() {
      for (const node of nodes.values()) {
        if (!node.bg && (node.status === 'working' || node.status === 'waiting')) { finish(node, 'interrupted'); }
      }
    }
    function ingest(message) {
      if (!isRecord(message) || typeof message.type !== 'string') { return false; }
      const type = message.type;
      const p = isRecord(message.payload) ? message.payload : {};
      switch (type) {
        case 'responseStarted': {
          // Leftovers from the previous turn can no longer be running.
          interruptForeground();
          turn++;
          const root = ensureRoot();
          // The host forgets an unanswered question once the user sends again.
          resolveQuestions(root);
          Object.assign(root, {
            status: 'working', startedAt: now(), endedAt: null, tools: [], result: undefined,
            error: undefined, failure: undefined, usage: undefined, estimated: undefined, note: undefined, turn,
            backend: str(p.provider), model: str(p.model),
          });
          touch(root);
          return true;
        }
        case 'responseComplete': {
          const root = get('root');
          if (!root) { return false; }
          if (usageTokens(p.usage) !== null) { root.usage = p.usage; root.estimated = p.usage.tokensPartial === true; }
          if (num(p.usage && p.usage.costUsd) !== null) { root.costUsd = p.usage.costUsd; }
          if (isRecord(p.message) && isId(p.message.content)) { root.result = clip(p.message.content, 2000); }
          finish(root, 'done');
          // Nothing of this turn is still running once it lands.
          settleUnder('root', 'interrupted');
          touch(root);
          return true;
        }
        case 'responseChunk': {
          // Streamed text and thinking are activity, not a stall.
          const root = get('root');
          if (root && root.status === 'working') { touch(root); }
          return false;
        }
        case 'mystiActionRequired': {
          // A spawn that never started (CLI missing, signed out) ends the turn with only
          // this card. The capability notice is advice about a turn that still lands.
          const root = get('root');
          if (!root || TERMINAL.has(root.status) || isId(p.jobId) || p.reason === 'capability-off') { return false; }
          root.error = clip(p.message, 400) || 'Action required';
          finish(root, 'failed');
          settleUnder('root', 'failed');
          return true;
        }
        case 'error': {
          const root = get('root');
          if (!root || TERMINAL.has(root.status)) { return false; }
          root.error = clip(typeof message.payload === 'string' ? message.payload : p.message, 400) || 'Error';
          finish(root, 'failed');
          settleUnder('root', 'failed');
          return true;
        }
        case 'requestCancelled': interruptForeground(); return true;

        case 'toolUse': {
          if (!isId(p.id)) { return false; }
          if (card(p, p.meta, turnParent(), '', null)) { return true; }
          return addTool(ensureRoot(), p);
        }
        case 'toolResult': {
          if (!isId(p.id)) { return false; }
          const owner = get(cards.get(p.id));
          if (owner) { cardResult(owner, p, p.meta); return true; }
          return settleTool(p);
        }
        case 'mystiDelegateTrace': {
          const node = get(cards.get(p.parentId));
          const chunk = isRecord(p.chunk) ? p.chunk : null;
          if (!node || !chunk) { return false; }
          touch(node);
          if (chunk.type === 'tool_use') { return addTool(node, chunk.toolCall); }
          if (chunk.type === 'tool_result') { return settleTool(chunk.toolCall, undefined, node); }
          if (chunk.type === 'retry') { node.note = '↻ ' + (clip(chunk.content, 200) || 'retrying'); return true; }
          return false;
        }

        case 'mystiStarted': {
          const wf = upsert('wf:' + (++sequence), 'workflow', turnParent(), { title: clip(p.brief, 300) || 'Workflow', phase: 'plan' });
          start(wf);
          workflow = wf.id;
          return true;
        }
        case 'mystiEvent': return mystiEvent(p);
        case 'mystiComplete': return settleWorkflow(p.cancelled ? 'interrupted' : 'done');
        case 'mystiError': return settleWorkflow('failed', clip(p.message, 400) || 'Orchestration failed');

        case 'mentionTaskStarted': {
          // The host names the task before subAgentStarted starts the agent.
          if (!isId(p.agentId) || !isId(p.task)) { return false; }
          const node = get('mention:' + turn + ':' + p.agentId) || mention(p.agentId);
          node.title = clip(p.task, 300);
          node.task = p.task;
          return true;
        }
        case 'subAgentStarted': case 'subAgentToolUse': case 'subAgentToolResult': case 'subAgentStatus':
        case 'subAgentRetry': case 'subAgentComplete': case 'subAgentError':
          return subAgent(type, p);
        case 'subAgentChunk': {
          const node = mentionOf(p.agentId);
          if (node) { touch(node); }
          return false;
        }

        case 'collaborationStarted': {
          const count = Array.isArray(p.collaborators) ? p.collaborators.length : 0;
          const group = upsert(collabKey(p), 'collab', turnParent(), { title: count + (count === 1 ? ' collaborator' : ' collaborators') });
          start(group);
          return true;
        }
        case 'collaborator': return collaborator(message.payload);
        case 'collaborationError':
        case 'collaborationComplete': {
          const group = get(collabKey(p));
          if (!group || TERMINAL.has(group.status)) { return false; }
          const failed = type === 'collaborationError';
          if (failed) { group.error = clip(p.message, 400) || 'Collaboration failed'; }
          settleUnder(group.id, failed ? 'failed' : 'done');
          finish(group, failed ? 'failed' : 'done');
          return true;
        }

        case 'sessionEvent': return sessionEvent(p);
        case 'sessionError': return sessionEvent({ type: 'session_error', message: p.message, runId: p.runId });

        case 'jobStarted': case 'jobProgress': case 'jobToolUse': case 'jobToolResult':
        case 'jobComplete': case 'jobError': case 'jobCancelled': case 'jobsList':
          return jobEvent(type, p);

        case 'permissionRequest':
          if (!isId(p.id)) { return false; }
          return addNeed(p.id, 'permission', ownerOf(p), str(p.title) || 'Permission needed', str(p.description));
        case 'askUserQuestion': {
          if (!isId(p.toolCallId)) { return false; }
          const first = Array.isArray(p.questions) && isRecord(p.questions[0]) ? str(p.questions[0].question) : '';
          return addNeed(p.toolCallId, 'question', ensureRoot(), first || 'A question for you', '');
        }
        case 'subAgentAskUserQuestion': {
          const data = isRecord(p.questionData) ? p.questionData : {};
          if (!isId(data.toolCallId)) { return false; }
          const first = Array.isArray(data.questions) && isRecord(data.questions[0]) ? str(data.questions[0].question) : '';
          // Only a working mention gets a question card in the chat; anything else
          // has nothing to review and no event that would ever clear it.
          const owner = mentionOf(p.agentId);
          if (!owner || owner.status !== 'working') { return false; }
          return addNeed(data.toolCallId, 'question', owner, first || 'A question for you', '');
        }
        case 'permissionDismissed':
          return (Array.isArray(p.requestIds) ? p.requestIds : []).map(resolveNeed).some(Boolean);
        case 'permissionExpired': return resolveNeed(p.requestId || p.id);
        case 'semiAutonomousDecision': return resolveNeed(p.requestId);
        default:
          if (type.startsWith('brainstorm')) { return brainstorm(type, p); }
      }
      return false;
    }

    function counts(t) {
      const at = num(t) === null ? now() : t;
      const result = { agents: 0, waiting: 0, working: 0, stalled: 0, needs: 0, done: 0, failed: 0, interrupted: 0, pending: needs.size };
      for (const node of nodes.values()) {
        if (CONTAINERS.has(node.kind)) { continue; }
        result.agents++;
        result[statusOf(node, at)]++;
      }
      return result;
    }
    function reset(resetOptions) {
      const keep = resetOptions && resetOptions.keepJobs ? [...nodes.values()].filter(node => node.bg) : [];
      nodes.clear();
      keep.forEach(node => nodes.set(node.id, node));
      for (const [id, need] of needs) { if (!nodes.has(need.nodeId)) { needs.delete(id); } }
      for (const [id, nodeId] of toolOwner) { if (!nodes.has(nodeId)) { toolOwner.delete(id); } }
      for (const [id, nodeId] of cards) { if (!nodes.has(nodeId)) { cards.delete(id); } }
      for (const id of [...jobs]) { if (!nodes.has('job:' + id)) { jobs.delete(id); } }
      mentions.clear();
      runs.clear();
      workflow = session = debate = null;
    }

    return {
      ingest, get, children, counts, resolveNeed, reset, isStalled, statusOf,
      nodes: () => [...nodes.values()],
      need: id => (isId(id) && needs.get(id)) || null,
      knowsJob: id => isId(id) && jobs.has(id),
    };
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) { return seconds + 's'; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return minutes + 'm ' + (seconds % 60) + 's'; }
    return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }
  function formatTokens(tokens) {
    if (tokens >= 1e6) { return (tokens / 1e6).toFixed(1) + 'M tok'; }
    return tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k tok' : tokens + ' tok';
  }
  /** Lanes grouped by dependency depth; unknown dependencies and cycles collapse to the earliest column. */
  function laneColumns(lanes) {
    const byId = new Map(lanes.map(node => [node.lane, node]));
    const depth = new Map();
    const level = (node, seen) => {
      if (depth.has(node.lane)) { return depth.get(node.lane); }
      if (seen.has(node.lane)) { return 0; }
      seen.add(node.lane);
      let value = 0;
      for (const dep of node.dependsOn) {
        const other = byId.get(dep);
        if (other) { value = Math.max(value, level(other, seen) + 1); }
      }
      depth.set(node.lane, value);
      return value;
    };
    const columns = [];
    for (const node of lanes) {
      const index = level(node, new Set());
      (columns[index] = columns[index] || []).push(node);
    }
    return columns.filter(Boolean);
  }

  function create(ports) {
    const document = ports.document;
    const view = document.defaultView || global;
    const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
    const every = ports.setInterval || view.setInterval.bind(view);
    const stopEvery = ports.clearInterval || view.clearInterval.bind(view);
    const model = createModel({ now });
    let shell = document.getElementById('agent-map');
    if (!shell) {
      shell = document.createElement('div');
      shell.id = 'agent-map';
      shell.className = 'agent-map hidden';
      shell.setAttribute('role', 'dialog');
      shell.setAttribute('aria-modal', 'true');
      shell.setAttribute('aria-labelledby', 'agent-map-title');
      document.body.appendChild(shell);
    }
    const pill = document.getElementById('agent-map-pill');
    let open = false;
    let disposed = false;
    let layout = 'graph';
    let selected = null;
    let filter = 'all';
    let detail = false;
    let asking = false;
    let timer = null;
    let returnFocus = null;
    let buttons = new Map();
    let groupSequence = 0;
    let stale = false;
    let shown = null;

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) { node.className = className; }
      if (text !== undefined) { node.textContent = text; }
      return node;
    }
    function button(className, text, focusKey, onClick) {
      const node = element('button', className, text);
      node.type = 'button';
      node.dataset.focusKey = focusKey;
      node.addEventListener('click', onClick);
      return node;
    }
    function agentName(id) {
      if (!isId(id)) { return ''; }
      try {
        const info = ports.getAgentDisplay && ports.getAgentDisplay(id);
        return (info && isId(info.name) && info.name) || id;
      } catch (_error) { return id; }
    }
    /** The main agent is titled by its backend once a turn names one; its kind stays 'Main agent'. */
    function titleOf(node) {
      return (node.kind === 'root' && agentName(node.backend)) || node.title || KIND_LABEL[node.kind] || node.kind;
    }
    /** A lane's dependency by its task: the planner's ids (n1, n2) are shown nowhere else. */
    function laneName(lane, id) {
      const sibling = model.get(lane.parentId + ':n:' + id);
      return sibling ? laneTitle(sibling) : id;
    }
    // A lane seen before the plan (orch_node_start first) has only its id.
    const laneTitle = lane => clip(lane.title || lane.lane || titleOf(lane), 40);
    function find(selector, test) {
      let hit = null;
      document.querySelectorAll(selector).forEach(candidate => {
        if (!shell.contains(candidate) && test(candidate)) { hit = candidate; }
      });
      return hit;
    }
    // Agent names, card ids and lane ids recur across turns and runs, so a node's
    // place among its namesakes picks its element. Counted from the newest: a
    // reset map can sit on a transcript that still shows older cards.
    function nth(node, alike, selector, test, within) {
      const hits = [...(within || document).querySelectorAll(selector)].filter(candidate => !shell.contains(candidate) && test(candidate));
      const peers = model.nodes().filter(alike);
      return hits[hits.length - peers.length + peers.indexOf(node)] || null;
    }
    function anchorFor(node) {
      const jobCard = jobId => find('.mysti-job', candidate => candidate.id === 'mysti-job-' + jobId);
      const container = group => group && nth(group, other => other.kind === group.kind, '.brainstorm-container',
        candidate => candidate.classList.contains('mysti-container') === (group.kind === 'workflow'));
      const parent = model.get(node.parentId);
      switch (node.kind) {
        case 'delegate': case 'native': case 'advisor': case 'review': case 'reported':
          return node.bg ? jobCard(node.jobId)
            : nth(node, other => !other.bg && other.cardId === node.cardId, '.tool-call', candidate => candidate.dataset.id === node.cardId);
        case 'job': return jobCard(node.jobId);
        case 'mention':
          return nth(node, other => other.kind === 'mention' && other.backend === node.backend,
            '.subagent-card', candidate => candidate.dataset.agentId === node.backend);
        case 'lane': {
          const scope = container(parent);
          return scope && nth(node, other => other === node, '.mysti-node', candidate => candidate.dataset.node === node.lane, scope);
        }
        case 'session': case 'session-lane': {
          // The chat keeps one session card, for the newest session only.
          const group = node.kind === 'session' ? node : parent;
          return group && nth(group, other => other.kind === 'session', '#session-card', () => true);
        }
        case 'debate': case 'workflow': return container(node);
        case 'debater': case 'step': return container(parent);
      }
      return null;
    }
    function reveal(target) {
      if (typeof target.scrollIntoView === 'function') { target.scrollIntoView({ block: 'center' }); }
      if (!target.hasAttribute('tabindex')) { target.setAttribute('tabindex', '-1'); }
      target.focus();
    }
    function review(need) {
      const target = need.kind === 'question'
        ? find('.ask-user-question-container', candidate => candidate.getAttribute('data-tool-call-id') === need.id)
        : find('.permission-card', candidate => candidate.dataset.id === need.id);
      close(!target);
      if (target) { reveal(target); }
    }

    function measure() {
      const width = shell.clientWidth || view.innerWidth || 0;
      layout = width >= 1000 ? 'graph' : width >= 640 ? 'outline' : 'narrow';
    }
    function select(id) {
      selected = id;
      asking = false;
      if (layout === 'narrow') { detail = true; }
      render();
      if (layout === 'narrow') { focusKey('back'); }
    }
    function focusKey(key) {
      for (const candidate of shell.querySelectorAll('button')) {
        // The rebuild restores scroll itself; focus must not scroll the pane back to the row.
        if (candidate.dataset.focusKey === key) { candidate.focus({ preventScroll: true }); return true; }
      }
      return false;
    }
    function focusInitial(quiet) {
      const target = buttons.get(selected) || buttons.values().next().value;
      if (target) { target.focus({ preventScroll: !!quiet }); } else { focusKey('close'); }
    }

    function nodeButton(node, t, level, column) {
      const status = model.statusOf(node, t);
      const title = titleOf(node);
      const row = button('agent-map-node agent-map-node--' + status + ' agent-map-kind--' + node.kind, undefined,
        'node:' + node.id, () => select(node.id));
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(level + 1));
      row.setAttribute('aria-selected', String(selected === node.id));
      row.title = title;
      const matches = FILTERS.find(entry => entry[0] === filter)[2];
      if (!CONTAINERS.has(node.kind) && !matches(status)) { row.classList.add('agent-map-node--dim'); }
      const glyph = element('span', 'agent-map-glyph', GLYPH[status] || '·');
      glyph.setAttribute('aria-hidden', 'true');
      const meta = [node.kind === 'root' && title !== KIND_LABEL.root ? KIND_LABEL.root : agentName(node.backend), node.access,
        node.startedAt !== null ? formatDuration((node.endedAt || t) - node.startedAt) : '',
        usageTokens(node.usage) !== null ? (node.estimated ? '~' : '') + formatTokens(usageTokens(node.usage)) : '',
        num(node.convergence) !== null ? node.convergence + '% converged' : ''].filter(Boolean);
      row.append(glyph, element('span', 'agent-map-sr', STATUS_LABEL[status] + (column ? ', ' + column : '') + ': '),
        element('span', 'agent-map-title', title));
      if (node.dependsOn.length) { row.appendChild(element('span', 'agent-map-after', 'after ' + node.dependsOn.map(id => laneName(node, id)).join(', '))); }
      if (meta.length) { row.appendChild(element('span', 'agent-map-meta', meta.join(' · '))); }
      buttons.set(node.id, row);
      return row;
    }
    function tree(list, t, level, label, column) {
      const group = element('ul', level ? 'agent-map-group' : 'agent-map-tree');
      group.setAttribute('role', level ? 'group' : 'tree');
      if (label) { group.setAttribute('aria-label', label); }
      if (level) { group.id = 'agent-map-group-' + (++groupSequence); }
      for (const node of list) { group.appendChild(item(node, t, level, column)); }
      return group;
    }
    function item(node, t, level, column) {
      const li = element('li', 'agent-map-item');
      li.setAttribute('role', 'none');
      const row = nodeButton(node, t, level, column);
      li.appendChild(row);
      const kids = model.children(node.id);
      if (node.kind === 'workflow') {
        li.classList.add('agent-map-workflow');
        li.appendChild(workflowBlock(node, t, level + 1));
      } else if (kids.length) {
        li.appendChild(tree(kids, t, level + 1));
      }
      // The row is the focusable treeitem, so its groups are tied to it by
      // aria-owns rather than by nesting.
      const owned = [...li.querySelectorAll('.agent-map-group')].filter(group => group.parentElement.closest('.agent-map-item') === li);
      if (owned.length) {
        row.setAttribute('aria-expanded', 'true');
        row.setAttribute('aria-owns', owned.map(group => group.id).join(' '));
      }
      return li;
    }
    function phaseTracker(wf) {
      const phases = element('ol', 'agent-map-wf-phases');
      const reached = PHASES.findIndex(entry => entry[0] === wf.phase);
      PHASES.forEach(([key, label], index) => {
        const done = key !== wf.phase && (wf.phase === 'done' || TERMINAL.has(wf.status) || index < reached);
        phases.appendChild(element('li', 'agent-map-wf-phase' + (key === wf.phase ? ' is-current' : done ? ' is-done' : ''),
          (done ? '✓ ' : '') + label));
      });
      return phases;
    }
    function workflowBlock(wf, t, level) {
      const block = element('div', 'agent-map-wf');
      const kids = model.children(wf.id);
      const lanes = kids.filter(node => node.kind === 'lane');
      const columns = element('div', 'agent-map-wf-columns');
      const column = (label, list) => {
        if (!list.length) { return; }
        const col = element('div', 'agent-map-wf-col');
        // The label is drawn for the eye; each row says its column itself.
        const heading = element('div', 'agent-map-wf-col-label', label);
        heading.setAttribute('aria-hidden', 'true');
        col.append(heading, tree(list, t, level, undefined, label));
        columns.appendChild(col);
      };
      const stepFor = key => kids.filter(node => node.kind === 'step' && node.phase === key);
      column('Plan', stepFor('plan'));
      laneColumns(lanes).forEach((list, index) => column(index ? 'Then' : 'Run', list));
      column('Verify', stepFor('verify'));
      column('Synthesize', stepFor('synth'));
      const tracker = phaseTracker(wf);
      tracker.setAttribute('aria-hidden', 'true');
      block.append(tracker, columns);
      return block;
    }

    function header(counts) {
      const head = element('header', 'agent-map-header');
      const heading = element('h2', 'agent-map-heading', 'Agent map');
      heading.id = 'agent-map-title';
      const chips = element('div', 'agent-map-filters');
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', 'Filter by status');
      const tally = {
        all: counts.agents, needs: counts.needs, working: counts.working + counts.stalled,
        done: counts.done, failed: counts.failed, stopped: counts.interrupted,
      };
      for (const [key, label] of FILTERS) {
        if (key === 'stopped' && !tally.stopped && filter !== key) { continue; }
        const chip = button('agent-map-chip', undefined, 'filter:' + key, () => { filter = key; render(); });
        chip.setAttribute('aria-pressed', String(filter === key));
        chip.append(element('span', '', label), element('span', 'agent-map-chip-count', String(tally[key])));
        chips.appendChild(chip);
      }
      const closeButton = button('agent-map-close', '×', 'close', () => close());
      closeButton.setAttribute('aria-label', 'Close agent map');
      const titles = element('div', 'agent-map-titles');
      titles.append(heading, element('p', 'agent-map-summary', summary(counts)));
      head.append(titles);
      if (counts.agents) { head.append(chips); }
      head.append(closeButton);
      return head;
    }
    function summary(counts) {
      if (!counts.agents) { return ''; }
      const parts = [counts.agents + (counts.agents === 1 ? ' agent' : ' agents')];
      if (counts.needs) { parts.push(counts.needs + ' needs you'); }
      if (counts.working + counts.stalled) { parts.push((counts.working + counts.stalled) + ' working'); }
      if (counts.stalled) { parts.push(counts.stalled + ' stalled'); }
      if (counts.failed) { parts.push(counts.failed + ' failed'); }
      if (counts.interrupted) { parts.push(counts.interrupted + ' stopped'); }
      return parts.join(' · ');
    }

    function inspector(node, t) {
      const pane = element('aside', 'agent-map-inspector');
      pane.setAttribute('aria-label', 'Agent details');
      if (layout === 'narrow') {
        pane.appendChild(button('agent-map-back', '← All agents', 'back', () => { detail = false; render(); focusInitial(); }));
      }
      if (!node) {
        pane.appendChild(element('p', 'agent-map-hint', 'Select an agent to see what it did.'));
        return pane;
      }
      const status = model.statusOf(node, t);
      pane.appendChild(element('div', 'agent-map-kind', KIND_LABEL[node.kind] || node.kind));
      pane.appendChild(element('h3', 'agent-map-inspector-title', titleOf(node)));
      const elapsed = node.startedAt !== null ? ' · ' + formatDuration((node.endedAt || t) - node.startedAt) : '';
      const line = element('p', 'agent-map-status agent-map-status--' + status);
      line.append(element('span', 'agent-map-glyph', GLYPH[status]), element('span', '', ' ' + STATUS_LABEL[status] + elapsed));
      pane.appendChild(line);

      for (const id of node.needs) {
        const need = model.need(id);
        if (!need) { continue; }
        const row = element('div', 'agent-map-need');
        const text = element('div', 'agent-map-need-text');
        text.append(element('strong', '', need.kind === 'question' ? 'Question' : 'Approval'),
          element('span', '', ' ' + need.title));
        if (need.detail) { text.appendChild(element('div', 'agent-map-need-detail', need.detail)); }
        row.append(text, button('agent-map-action agent-map-action--primary', 'Review', 'review:' + id, () => review(need)));
        pane.appendChild(row);
      }
      if (status === 'stalled') {
        pane.appendChild(element('p', 'agent-map-stall', 'No output for ' + Math.floor((t - node.lastEventAt) / 60000) + 'm'));
      }
      if (node.failure || node.error) {
        const failure = element('div', 'agent-map-failure');
        if (node.failure) { failure.appendChild(element('span', 'agent-map-chip-code', node.failure)); }
        if (node.error) { failure.appendChild(element('span', 'agent-map-failure-text', node.error)); }
        pane.appendChild(failure);
      }
      if (node.note) { pane.appendChild(element('p', 'agent-map-note', node.note)); }
      if (node.result) { pane.appendChild(element('pre', 'agent-map-result', node.result)); }
      pane.appendChild(facts(node, t));
      if (node.tools.length) {
        pane.appendChild(element('h4', 'agent-map-section', 'Activity'));
        const list = element('ul', 'agent-map-activity');
        for (const tool of node.tools) {
          const row = element('li', 'agent-map-tool agent-map-tool--' + tool.status);
          const name = element('span', 'agent-map-tool-name', tool.name);
          name.title = tool.name;
          row.append(element('span', 'agent-map-glyph', tool.status === 'running' ? GLYPH.working : GLYPH[tool.status]),
            name, element('span', 'agent-map-tool-summary', tool.summary));
          list.appendChild(row);
        }
        pane.appendChild(list);
      }
      if (node.kind === 'workflow') { pane.appendChild(workflowDetail(node, t)); }
      pane.appendChild(actions(node));
      return pane;
    }
    function facts(node, t) {
      const list = element('dl', 'agent-map-facts');
      const add = (label, value) => {
        if (!value) { return; }
        list.append(element('dt', '', label), element('dd', '', value));
      };
      const parent = model.get(node.parentId);
      add('Backend', agentName(node.backend));
      add('Model', node.model);
      add('Via', node.via);
      add('Role', node.role);
      add('Access', node.access);
      add('Spawned by', parent && parent.kind === 'root' && node.spawnedBy ? agentName(node.spawnedBy) : parent ? titleOf(parent) : '');
      add('Depends on', node.dependsOn.map(id => laneName(node, id)).join(', '));
      add('Time', node.startedAt !== null ? formatDuration((node.endedAt || t) - node.startedAt) : '');
      if (!CONTAINERS.has(node.kind)) {
        const tokens = usageTokens(node.usage);
        add('Tokens', tokens === null ? 'n/a' : node.estimated ? '~' + formatTokens(tokens) + ' (partly estimated)' : formatTokens(tokens));
        add('Cost', num(node.costUsd) === null ? 'n/a' : (node.costApprox ? '~$' : '$') + node.costUsd.toFixed(4));
      }
      return list;
    }
    function workflowDetail(wf, t) {
      const section = element('div', 'agent-map-wf-detail');
      section.append(element('h4', 'agent-map-section', 'Phases'), phaseTracker(wf));
      section.appendChild(element('h4', 'agent-map-section', 'Timeline'));
      const lanes = model.children(wf.id).filter(node => node.kind === 'lane');
      const origin = wf.startedAt !== null ? wf.startedAt : t;
      const span = Math.max(1, (wf.endedAt || t) - origin);
      for (const lane of lanes) {
        const status = model.statusOf(lane, t);
        const row = element('div', 'agent-map-bar-row');
        const track = element('div', 'agent-map-bar-track');
        if (lane.startedAt !== null) {
          const bar = element('div', 'agent-map-bar agent-map-bar--' + status);
          bar.title = STATUS_LABEL[status];
          const left = Math.max(0, Math.min(100, ((lane.startedAt - origin) / span) * 100));
          bar.style.left = left + '%';
          bar.style.width = Math.max(1, Math.min(100 - left, (((lane.endedAt || t) - lane.startedAt) / span) * 100)) + '%';
          track.appendChild(bar);
        }
        // The bar's colour is backed by the same glyph and words the tree uses.
        const label = element('span', 'agent-map-bar-label');
        const glyph = element('span', 'agent-map-glyph', GLYPH[status]);
        glyph.setAttribute('aria-hidden', 'true');
        label.append(glyph, element('span', 'agent-map-sr', STATUS_LABEL[status] + ': '), laneTitle(lane));
        label.title = lane.title || lane.lane || '';
        row.className += ' agent-map-status--' + status;
        row.append(label, track);
        section.appendChild(row);
      }
      const handoffs = lanes.flatMap(lane => lane.dependsOn.map(dep => laneName(lane, dep) + ' → ' + laneTitle(lane)));
      if (handoffs.length) {
        section.appendChild(element('h4', 'agent-map-section', 'Handoffs'));
        const list = element('ul', 'agent-map-handoffs');
        handoffs.forEach(text => list.appendChild(element('li', '', text)));
        section.appendChild(list);
      }
      return section;
    }
    function actions(node) {
      const row = element('div', 'agent-map-actions');
      const anchor = anchorFor(node);
      if (anchor) {
        row.appendChild(button('agent-map-action', 'Show in chat', 'show', () => { close(false); reveal(anchor); }));
      }
      // The prefill is `@agent <task>`; a label is not a task.
      if (ASK_KINDS.has(node.kind) && node.task && (node.status === 'done' || node.status === 'failed')) {
        row.appendChild(button('agent-map-action', 'Ask another agent…', 'ask', () => { asking = !asking; render(); }));
      }
      if (!node.bg && node.status === 'working') {
        row.appendChild(button('agent-map-action agent-map-action--danger', 'Stop turn', 'stop-turn',
          () => ports.postMessage({ type: 'cancelRequest' })));
      }
      const owner = node.jobId && model.get('job:' + node.jobId);
      if (owner && model.knowsJob(node.jobId) && !TERMINAL.has(owner.status)) {
        row.appendChild(button('agent-map-action agent-map-action--danger', 'Stop job', 'stop-job',
          () => ports.postMessage({ type: 'cancelJob', payload: { jobId: node.jobId } })));
      }
      if (!asking || !ASK_KINDS.has(node.kind)) { return row; }
      const wrap = element('div', 'agent-map-ask');
      wrap.appendChild(row);
      const menu = element('div', 'agent-map-ask-menu');
      let agents;
      try { agents = typeof ports.listAgents === 'function' ? ports.listAgents() : []; } catch (_error) { agents = []; }
      for (const agent of Array.isArray(agents) ? agents : []) {
        if (!isRecord(agent) || !isId(agent.id) || agent.id === node.backend) { continue; }
        menu.appendChild(button('agent-map-ask-item', str(agent.name) || agent.id, 'ask:' + agent.id, () => {
          close(false);
          if (typeof ports.prefillComposer === 'function') { ports.prefillComposer('@' + agent.id + ' ' + node.task); }
        }));
      }
      if (!menu.childNodes.length) { menu.appendChild(element('p', 'agent-map-hint', 'No other agents are available.')); }
      wrap.appendChild(menu);
      return wrap;
    }

    function renderPill() {
      if (!pill) { return; }
      const counts = model.counts(now());
      // The main agent alone is an ordinary chat, which keeps its three segments.
      const hide = counts.pending === 0 && model.nodes().every(node => node.id === 'root' || CONTAINERS.has(node.kind));
      pill.classList.toggle('hidden', hide);
      pill.setAttribute('aria-expanded', String(open));
      if (hide) { return; }
      const agents = counts.agents + (counts.agents === 1 ? ' agent' : ' agents');
      const working = counts.working + counts.stalled;
      pill.textContent = counts.needs ? '◆ ' + counts.needs + ' needs you · ' + agents
        : working ? agents + ' · ' + working + ' working' : agents;
    }
    const SCROLLERS = ['.agent-map-main', '.agent-map-inspector', '.agent-map-result'];
    function render() {
      renderPill();
      if (!open || disposed) { return; }
      stale = false;
      const active = document.activeElement;
      const hadFocus = !!active && shell.contains(active);
      const key = hadFocus && active.dataset ? active.dataset.focusKey : null;
      // Focus on the panel or a scroller (a click on plain text, a scrolled result) has no key.
      const pane = hadFocus && !key ? [...SCROLLERS, '.agent-map-panel'].find(selector => active.matches(selector)) : null;
      // The inspector's scroll belongs to the node it showed; the tree's survives any rebuild.
      const scrolls = SCROLLERS.map(selector => {
        const pane = shell.querySelector(selector);
        return pane && (selector === '.agent-map-main' || shown === selected) ? [pane.scrollTop, pane.scrollLeft] : null;
      });
      const t = now();
      const counts = model.counts(t);
      shell.classList.remove('agent-map--graph', 'agent-map--outline', 'agent-map--narrow');
      shell.classList.add('agent-map--' + layout);
      buttons = new Map();
      const current = model.get(selected);
      if (!current) { selected = null; detail = false; }
      const body = element('div', 'agent-map-body');
      if (layout === 'narrow' && detail && current) {
        body.appendChild(inspector(current, t));
      } else {
        const main = element('div', 'agent-map-main');
        const top = model.nodes().filter(node => node.parentId === null && node.kind !== 'job');
        const background = model.nodes().filter(node => node.kind === 'job');
        if (!top.length && !background.length) {
          main.appendChild(element('p', 'agent-map-empty', 'Agents appear here while they work in this chat.'));
        }
        if (top.length) { main.appendChild(tree(top, t, 0, 'Agents')); }
        if (background.length) {
          main.appendChild(element('h4', 'agent-map-section', 'Background'));
          main.appendChild(tree(background, t, 0, 'Background jobs'));
        }
        body.appendChild(main);
        if (layout !== 'narrow' && (top.length || background.length)) { body.appendChild(inspector(current, t)); }
      }
      const backdrop = element('div', 'agent-map-backdrop');
      backdrop.addEventListener('click', () => close());
      const panel = element('div', 'agent-map-panel');
      // A click on plain text in the dialog must leave focus in the dialog, not on <body>.
      panel.tabIndex = -1;
      panel.append(header(counts), body);
      shell.replaceChildren(backdrop, panel);
      shown = selected;
      SCROLLERS.forEach((selector, index) => {
        const pane = shell.querySelector(selector);
        if (pane && scrolls[index]) { [pane.scrollTop, pane.scrollLeft] = scrolls[index]; }
      });
      // Focus must never fall out of a modal dialog when its content is rebuilt.
      if (hadFocus && !(key && focusKey(key))) {
        const again = pane && shell.querySelector(pane);
        if (again) { again.focus({ preventScroll: true }); }
        // A scroller that is not focusable in this engine leaves focus outside; fall back.
        if (!shell.contains(document.activeElement)) { focusInitial(true); }
      }
    }

    function selecting() {
      const selection = typeof view.getSelection === 'function' ? view.getSelection() : null;
      return !!selection && !selection.isCollapsed && shell.contains(selection.anchorNode);
    }
    /** A rebuild nobody asked for; it waits while the user is selecting text to copy. */
    function refresh() {
      if (open && selecting()) { stale = true; renderPill(); return; }
      render();
    }
    function tick() {
      // Only elapsed time and stalls change on their own, and only while something works.
      if (stale || model.nodes().some(node => node.status === 'working')) { refresh(); }
    }

    function onKeydown(event) {
      // Window capture phase while open, so no page handler (permission keys,
      // AUQ, mode cycle, composer Escape → cancelRequest) sees any key, even
      // one whose target is a card that stole focus or <body>. A chord typed in
      // the map is left alone: VS Code forwards it to the workbench from a
      // bubble listener on this same window (command palette, Cmd+W …), and the
      // page's own chord handler stands down while the map is open.
      const inside = event.target instanceof view.Node && shell.contains(event.target);
      const chord = event.ctrlKey || event.metaKey || event.altKey || /^F\d{1,2}$/.test(event.key);
      if (chord && inside) { return; }
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (!inside) {
        event.preventDefault();
        focusInitial();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Elsewhere (a scrolling result, an action) arrows keep their native meaning.
        if (event.target.getAttribute('role') !== 'treeitem') { return; }
        const list = [...buttons.values()].filter(row => row.isConnected);
        event.preventDefault();
        const index = list.indexOf(event.target);
        list[Math.max(0, Math.min(list.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
      } else if (event.key === 'Tab') {
        const focusable = [...shell.querySelectorAll('button')].filter(candidate => !candidate.disabled);
        if (!focusable.length) { return; }
        // Wrap only past the last (or first) button in document order; from a
        // focused scroller or the panel the browser's own order still holds.
        const toward = event.shiftKey ? view.Node.DOCUMENT_POSITION_PRECEDING : view.Node.DOCUMENT_POSITION_FOLLOWING;
        if (focusable.some(candidate => event.target.compareDocumentPosition(candidate) & toward)) { return; }
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
      }
    }
    function onResize() {
      if (!open) { return; }
      // Only the layout depends on size, and CSS reflows the rest. A rebuild
      // per resize (a sidebar drag fires dozens) would swap out the row under
      // the pointer and drop a text selection mid-drag.
      const before = layout;
      measure();
      if (layout !== before) { render(); }
    }
    view.addEventListener('resize', onResize);

    function requestJobs() {
      ports.postMessage({ type: 'requestJobs', payload: { source: 'agentMap' } });
    }
    function openMap() {
      if (open || disposed) { return; }
      returnFocus = document.activeElement;
      open = true;
      detail = false;
      asking = false;
      shell.classList.remove('hidden');
      measure();
      render();
      focusInitial();
      requestJobs();
      timer = every(tick, TICK_MS);
      view.addEventListener('keydown', onKeydown, true);
      if (typeof ports.onOpenChange === 'function') { ports.onOpenChange(true); }
    }
    function close(restore) {
      if (!open) { return; }
      open = false;
      asking = false;
      view.removeEventListener('keydown', onKeydown, true);
      if (timer !== null) { stopEvery(timer); timer = null; }
      shell.classList.add('hidden');
      shell.replaceChildren();
      buttons = new Map();
      const back = returnFocus;
      returnFocus = null;
      if (restore !== false && back && back.isConnected && typeof back.focus === 'function') { back.focus(); }
      renderPill();
      if (typeof ports.onOpenChange === 'function') { ports.onOpenChange(false); }
    }

    return {
      observe(message) {
        if (disposed) { return; }
        let changed;
        try { changed = model.ingest(message); }
        catch (error) { console.warn('[Mysti] Agent map skipped a message:', error); return; }
        if (changed) { refresh(); }
      },
      open: openMap,
      close: () => close(),
      toggle() { if (open) { close(); } else { openMap(); } },
      isOpen: () => open,
      reset() {
        model.reset({ keepJobs: true });
        selected = null;
        detail = false;
        requestJobs();
        render();
      },
      permissionResolved(requestId) { if (model.resolveNeed(requestId)) { refresh(); } },
      questionAnswered(id) { if (model.resolveNeed(id)) { refresh(); } },
      counts: () => model.counts(now()),
      dispose() {
        close(false);
        view.removeEventListener('keydown', onKeydown, true);
        view.removeEventListener('resize', onResize);
        disposed = true;
      },
    };
  }

  global.MystiAgentMap = Object.freeze({ create, createModel });
  if (typeof module === 'object' && module.exports) { module.exports = { create, createModel }; }
})(typeof window !== 'undefined' ? window : globalThis);
