/* PB-02 bounded public lifecycle campaign. New evidence only; launch is an explicit command. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const fixtureContract = require('./codex-helper-quality-contract.cjs');
const { readStoredConversations, messageProjection } = require('./audit-vscode-claude.cjs');
const { joinNativeAssistantMessages } = require('./audit-vscode-codex-helper-quality.cjs');
const auxiliaryAudit = require('./codex-full-followup-auxiliary.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const STAGE = 'LIFECYCLE_CAMPAIGN_30', PREFIX = 'MYSTI_PB02_LIFECYCLE_CAMPAIGN', MAIN_CAP = 32, AUX_CAP = 32;
const PROFILE_ERROR = "This Codex CLI cannot use named profiles with Mysti's app-server connection. Clear mysti.codexProfile in Settings and retry to use your base Codex configuration. No model request was submitted.";
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const hash = file => sha(fs.readFileSync(file));
const identity = file => ({ path: fs.realpathSync(file), sha256: hash(file) });
const clean = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const one = (rows, why) => { assert.equal(rows.length, 1, why); return rows[0]; };
function contained(parent, file) { const rel = path.relative(parent, file); assert(rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'Owned child path required'); }
function ownedFile(parent, file) { contained(parent, file); assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()); contained(fs.realpathSync(parent), fs.realpathSync(file)); return file; }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); }
function replaceSnapshot(file, value) { const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
function receipts(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []; }
function freshDirectory(directory) {
  contained(root, directory); assert(!fs.existsSync(directory));
  for (let current = path.dirname(directory); current !== root; current = path.dirname(current)) {
    contained(root, current); assert(!fs.existsSync(path.join(current, 'prepared.json')), 'Never extend an existing prepared evidence tree');
  }
  const parent = fs.realpathSync(path.dirname(directory)); assert.equal(path.join(parent, path.basename(directory)), directory);
  fs.mkdirSync(directory); return directory;
}
function checkedModels(readiness) {
  assert.equal(readiness.status, 'PASS_READINESS_QUERIES'); assert.equal(readiness.inferenceRequests, 0);
  for (const model of ['gpt-5.6-sol', 'gpt-6.1-sol']) {
    const observed = one(readiness.models.filter(value => value.id === model && value.model === model), 'Alternate model must be present in observed readiness');
    assert(observed.supportedReasoningEfforts.some(value => value.reasoningEffort === 'low'));
  }
  return { primary: 'gpt-5.6-sol', alternate: 'gpt-6.1-sol' };
}
function buildCycles(token, models) {
  assert(/^PB02_SERVICE_[a-f0-9]+$/.test(token));
  return Array.from({ length: 31 }, (_, index) => {
    const marker = `CYCLE_${String(index).padStart(2, '0')}`, nonce = sha(`${token}:${index}`).slice(0, 24);
    return { index, marker, nonce, model: index === 27 ? models.alternate : models.primary,
      expectedReply: `${marker}:${nonce}`, prompt: `PB02_REQUEST:${marker}\nOwned fixture ${token}. Reply exactly ${marker}:${nonce}. No tools, files, network, commentary, or additional text.` };
  });
}
function profilePrompt(token) { return `PB02_REQUEST:PROFILE_REJECT_29\nOwned fixture ${token}. Reply PROFILE_REJECT_29 only. Do not use tools.`; }
function crashPrompt(token) { return `PB02_REQUEST:CRASH_30\nOwned fixture ${token}. List the integers 1 through 200, one per line. Do not use tools, files or network.`; }
function historyMetadata(outside) {
  const header = 'The following is the conversation history for context only. Do not repeat or echo these messages in your response:\n\n';
  const footer = '\n--- End of conversation history ---\n\n';
  const markers = text => [...new Set([...text.matchAll(/PB02_REQUEST:([A-Z0-9_]+)/g)].map(match => match[1]))];
  const headers = outside.split(header).length - 1, footers = outside.split(footer).length - 1;
  const start = outside.indexOf(header), end = outside.indexOf(footer);
  const exact = headers === 1 && footers === 1 && end > start + header.length;
  return { historyBoundaryStatus: !headers && !footers ? 'ABSENT' : exact ? 'EXACT' : 'INVALID', historyHeaderCount: headers, historyFooterCount: footers,
    historyMarkers: exact ? markers(outside.slice(start + header.length, end)) : [],
    currentRequestMarkers: markers(exact ? outside.slice(end + footer.length) : outside),
    preambleMarkers: exact ? markers(outside.slice(0, start)) : [] };
}
function assertRequestHistory(input, currentMarker, historyMarkers = []) {
  assert.equal(input.historyBoundaryStatus, historyMarkers.length ? 'EXACT' : 'ABSENT');
  assert.equal(input.historyHeaderCount, historyMarkers.length ? 1 : 0); assert.equal(input.historyFooterCount, historyMarkers.length ? 1 : 0);
  assert.deepEqual(input.preambleMarkers, []); assert.deepEqual(input.historyMarkers, historyMarkers); assert.deepEqual(input.currentRequestMarkers, [currentMarker]);
  assert.deepEqual(input.memoryMarkers, []); assert.deepEqual(input.outsideMemoryMarkers, [...historyMarkers, currentMarker]); assert.deepEqual(input.markers, [...historyMarkers, currentMarker]);
}
function instrumentMainRuntime(source) {
  const anchor = '      items.set(item.id, item);'; assert.equal(source.split(anchor).length, 2);
  const spawnAnchor = "  child.on('spawn', () => record({ event: persistent ? 'start' : auxiliary ? 'auxiliary-start' : 'probe-start', childPid: child.pid }));";
  assert.equal(source.split(spawnAnchor).length, 2);
  const importAnchor = "const { spawn } = require('node:child_process');"; assert.equal(source.split(importAnchor).length, 2);
  const argvAnchor = '  const markers = value =>'; assert.equal(source.split(argvAnchor).length, 2);
  source = source.replace(argvAnchor, `  const allowedArgs = args.length === 1 && (args[0] === 'app-server' || args[0] === '--version')
    || args.length === 3 && args[0] === '--profile' && args[1] === profileValidation.missing.name && args[2] === 'app-server';
  if (!allowedArgs) { record({ event: 'invocation-refusal', args }); process.exitCode = 1; process.stdin.destroy(); return; }
  const historyMetadata = ${historyMetadata.toString()};
` + argvAnchor);
  const historyAnchor = '        memoryMarkers: markers(blocks.map(block => block[2]).join(\'\\n\')), containsFixtureToken: prompt.includes(token),';
  assert.equal(source.split(historyAnchor).length, 2);
  source = source.replace(historyAnchor, '        ...historyMetadata(outside),\n' + historyAnchor);
  source = source.replace(importAnchor, "const { spawn, execFileSync } = require('node:child_process');");
  source = source.replace(spawnAnchor, `  child.on('spawn', () => {
    const processBirths = execFileSync('/bin/ps', ['-p', String(process.pid) + ',' + String(child.pid), '-o', 'pid=,lstart='], { encoding: 'utf8', timeout: 2000 })
      .trim().split('\\n').filter(Boolean).map(line => { const m = line.trim().match(/^(\\d+)\\s+(.+)$/); if (!m) throw Error('Unparseable launch birth'); return { pid: +m[1], startedAt: m[2] }; });
    record({ event: persistent ? 'start' : auxiliary ? 'auxiliary-start' : 'probe-start', childPid: child.pid, processBirths });
  });`);
  return source.replace(anchor, anchor + `\n      if (value.method === 'item/completed' && ['agentMessage', 'plan'].includes(item.type)) {
        record({ event: 'assistant-message', inputIndex, sessionHash: hash(params.threadId), turnHash: hash(params.turnId),
          itemIdHash: hash(item.id), itemType: item.type, phase: safe(item.phase), textBytes: typeof item.text === 'string' ? Buffer.byteLength(item.text) : null,
          textSha256: typeof item.text === 'string' ? hash(item.text) : null });
      }`);
}
function createMainWrapper(config) {
  const base = require.resolve('./pb02-profile-compatibility-cli-runtime.cjs');
  const runtime = path.join(config.directory, 'lifecycle-observed-main.cjs'), launcher = path.join(config.directory, 'codex-lifecycle-campaign');
  const receiptFile = path.join(config.directory, 'openai-codex-receipts.jsonl');
  fs.writeFileSync(runtime, instrumentMainRuntime(fs.readFileSync(base, 'utf8')), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(receiptFile, '', { flag: 'wx', mode: 0o600 });
  assert(path.isAbsolute(config.node) && !/\s/.test(config.node));
  fs.writeFileSync(launcher, `#!${config.node}\nrequire(${JSON.stringify(runtime)})(${JSON.stringify({ ...config, receiptFile })});\n`, { flag: 'wx', mode: 0o700 });
  return { launcher, runtime, receipts: receiptFile, baseIdentity: identity(base) };
}
function processRows() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/); assert(m);
    return { pid: +m[1], parentPid: +m[2], groupPid: +m[3], startedAt: m[4], executable: m[5] };
  });
}
const birthKey = value => `${value.pid}|${value.startedAt}`;
async function withOwnedObserver(directory, body, options = {}) {
  const parent = one(processRows().filter(row => row.pid === process.pid), 'Observer owner has a real process birth');
  const token = sha(`${directory}:${birthKey(parent)}:${Date.now()}`), started = Date.now();
  write(path.join(directory, 'external-observer-owner.json'), { parent, token, started });
  const log = fs.openSync(path.join(directory, 'external-observer.log'), 'wx', 0o600);
  let child;
  try { child = spawn(process.execPath, options.args || [__filename, 'observe', directory], { detached: true, stdio: ['ignore', log, log] }); }
  finally { fs.closeSync(log); }
  let terminal, observerIdentity, originalError, result, forced = false;
  child.once('error', error => { terminal = { at: Date.now(), code: null, signal: null, error: error.message }; });
  child.once('exit', (code, signal) => { terminal = { at: Date.now(), code, signal }; });
  const waitUntil = async (predicate, timeout) => { const until = Date.now() + timeout; while (!predicate() && Date.now() < until) await sleep(25); return predicate(); };
  try {
    await waitUntil(() => {
      if (terminal) return true;
      const actual = processRows().find(row => row.pid === child.pid);
      if (actual) { assert.equal(actual.parentPid, parent.pid); assert(Date.parse(actual.startedAt) >= started - 1000); observerIdentity = actual; return true; }
      return false;
    }, options.readyTimeoutMs ?? 5000);
    assert(observerIdentity, 'Observer must be bound to its initial PID and birth before use');
    const readyFile = path.join(directory, 'external-observer-ready.json');
    await waitUntil(() => !!terminal || fs.existsSync(readyFile), options.readyTimeoutMs ?? 5000);
    assert(fs.existsSync(readyFile), 'Independent process observer must be ready before editor launch');
    const ready = read(ownedFile(directory, readyFile)); assert.equal(birthKey(ready), birthKey(observerIdentity));
    assert(!terminal, 'Observer must remain alive until the runner starts');
    result = await body({ ready, terminal: () => terminal });
  } catch (error) { originalError = error; }
  finally {
    write(path.join(directory, 'external-observer-stop.json'), { at: Date.now(), token, parent, observerIdentity: observerIdentity || null,
      reason: originalError ? 'RUNNER_FAILED' : 'RUNNER_TERMINAL', error: originalError?.message });
    await waitUntil(() => !!terminal, options.drainTimeoutMs ?? 3000);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (terminal) break;
      // The captured ChildProcess and its original birth must both still identify this exact owned observer.
      const actual = observerIdentity && processRows().find(row => birthKey(row) === birthKey(observerIdentity));
      if (!actual || actual.parentPid !== parent.pid || child.pid !== actual.pid) break;
      forced = true; child.kill(signal); await waitUntil(() => !!terminal, 1000);
    }
    const remaining = observerIdentity ? processRows().filter(row => birthKey(row) === birthKey(observerIdentity)) : [];
    const report = { status: terminal?.code === 0 && terminal.signal === null && !forced && observerIdentity && !remaining.length ? 'PASS_OBSERVER_DRAIN' : 'FAIL_OBSERVER_DRAIN',
      started, ended: Date.now(), parent, observerIdentity: observerIdentity || null, terminal: terminal || null, forced, remaining, runnerError: originalError?.message };
    write(path.join(directory, 'external-observer-drain.json'), report);
    if (!terminal) child.unref();
    if (!originalError && report.status !== 'PASS_OBSERVER_DRAIN') originalError = Error('Owned external observer did not drain normally');
  }
  if (originalError) throw originalError; return result;
}
function bindLaunch(start, rows) {
  assert(Array.isArray(start.processBirths)); assert.equal(new Set(start.processBirths.map(row => row.pid)).size, start.processBirths.length);
  assert(start.processBirths.some(row => row.pid === start.wrapperPid), 'Wrapper launch birth must be captured');
  return [start.wrapperPid, start.childPid].map(pid => {
    const birth = start.processBirths.find(row => row.pid === pid), actual = birth && rows.find(row => birthKey(row) === birthKey(birth));
    if (birth) assert(Number.isFinite(Date.parse(birth.startedAt)) && Date.parse(birth.startedAt) <= start.at);
    return actual ? { ...actual, wrapperPid: start.wrapperPid } : { pid, wrapperPid: start.wrapperPid, status: 'UNVERIFIED_AT_FIRST_OBSERVATION', capturedBirth: birth || null };
  });
}
function selectFaultTarget({ request, rows, priorRows, wire, nativeBinary, boundIdentities }) {
  assert.equal(request.marker, 'CRASH_30'); assert.equal(request.inputIndex, 31); assert.equal(request.signal, 'SIGKILL');
  const input = one(wire.filter(row => row.event === 'request' && row.inputIndex === 31), 'One actual crash input');
  assert.equal(input.wrapperPid, request.wrapperPid); assertRequestHistory(input, 'CRASH_30');
  const turn = one(wire.filter(row => row.event === 'turn-started' && row.wrapperPid === input.wrapperPid && row.inputIndex === 31), 'Fault requires acknowledged active native turn');
  assert.equal(turn.sessionHash, input.sessionHash);
  assert(!wire.some(row => row.event === 'turn-completed' && row.wrapperPid === input.wrapperPid && row.inputIndex === 31), 'Never crash an already completed turn');
  const start = one(wire.filter(row => row.event === 'start' && row.wrapperPid === input.wrapperPid), 'Crash wrapper child ownership');
  const boundWrapper = one(boundIdentities.filter(row => row.pid === input.wrapperPid && row.wrapperPid === input.wrapperPid), 'Fault wrapper must be bound to its original observed launch birth');
  assert(start.processBirths.some(row => birthKey(row) === birthKey(boundWrapper)));
  assert(rows.some(row => birthKey(row) === birthKey(boundWrapper)), 'Original wrapper is still alive');
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const candidates = rows.filter(row => row.executable === nativeBinary && (() => {
    let current = row; const visited = new Set();
    while (current && !visited.has(current.pid)) { if (current.pid === start.childPid) return true; visited.add(current.pid); current = byPid.get(current.parentPid); }
    return false;
  })());
  const target = one(candidates, 'One currently owned native app-server binary below the captured wrapper child');
  assert(boundIdentities.some(row => birthKey(row) === birthKey(target) && row.wrapperPid === input.wrapperPid && row.executable === nativeBinary), 'Native target must be bound to the original owned ancestry');
  assert(priorRows.some(row => birthKey(row) === birthKey(target) && row.executable === target.executable && row.parentPid === target.parentPid), 'Fault PID birth must have an independent prior observation');
  assert.notEqual(target.pid, input.wrapperPid); return Object.fromEntries(['pid', 'parentPid', 'groupPid', 'startedAt', 'executable'].map(key => [key, target[key]]));
}
async function observe(directory) {
  const manifest = read(path.join(directory, 'prepared.json')), owner = manifest.windows.A;
  const ownership = read(ownedFile(directory, path.join(directory, 'external-observer-owner.json')));
  assert.equal(manifest.stage, STAGE); const output = path.join(directory, 'external-process-observations.jsonl');
  fs.writeFileSync(output, '', { flag: 'wx', mode: 0o600 });
  const append = value => fs.appendFileSync(output, JSON.stringify(value) + '\n');
  const self = one(processRows().filter(row => row.pid === process.pid), 'Observer has a real birth identity');
  write(path.join(directory, 'external-observer-ready.json'), { at: Date.now(), ...self, scope: 'External process observer; not in any product wrapper process group' });
  const known = new Map(), boundStarts = new Set(), unverifiedRoots = []; let previous = [], faultHandled = false;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const all = processRows(), byPid = new Map(all.map(row => [row.pid, row])), wire = receipts(owner.receiptPaths[0]);
    const stopFile = path.join(directory, 'external-observer-stop.json');
    const stop = fs.existsSync(stopFile) ? read(ownedFile(directory, stopFile)) : null;
    if (stop) { assert.equal(stop.token, ownership.token); assert.equal(birthKey(stop.parent), birthKey(ownership.parent)); }
    if (stop || !all.some(row => birthKey(row) === birthKey(ownership.parent))) {
      write(path.join(directory, 'external-observer-complete.json'), { at: Date.now(), status: fs.existsSync(path.join(directory, 'native-result.json')) ? 'OBSERVATION_COMPLETE' : stop ? 'STOP_REQUESTED_UNFINISHED' : 'FAIL_OBSERVER_OWNER_EXITED',
        observedIdentities: [...known.values()], unverifiedRoots, remaining: all.filter(row => known.has(birthKey(row))), faultHandled }); return;
    }
    for (const row of wire.filter(row => ['start', 'probe-start'].includes(row.event))) {
      const startKey = `${row.wrapperPid}:${row.at}:${row.event}`; if (boundStarts.has(startKey)) continue; boundStarts.add(startKey);
      for (const actual of bindLaunch(row, all)) {
        if (actual.status) unverifiedRoots.push(actual);
        else { assert.notEqual(actual.groupPid, self.groupPid); known.set(birthKey(actual), actual); }
      }
    }
    let changed = true;
    while (changed) { changed = false; for (const row of all) {
      const parent = byPid.get(row.parentPid), ownerRow = parent && known.get(birthKey(parent));
      if (ownerRow && !known.has(birthKey(row))) { known.set(birthKey(row), { ...row, wrapperPid: ownerRow.wrapperPid }); changed = true; }
    } }
    const live = all.filter(row => known.has(birthKey(row))).map(row => ({ ...row, wrapperPid: known.get(birthKey(row)).wrapperPid }));
    const snapshot = { event: 'snapshot', at: Date.now(), rows: live }; append(snapshot); replaceSnapshot(path.join(directory, 'external-live.json'), snapshot);
    const faultFile = path.join(directory, 'fault-request.json');
    if (!faultHandled && fs.existsSync(faultFile)) {
      const request = read(ownedFile(directory, faultFile)); faultHandled = true;
      try {
        const target = selectFaultTarget({ request, rows: all, priorRows: previous, wire, nativeBinary: manifest.executableIdentities['codex-native'].path, boundIdentities: [...known.values()] });
        const immediatelyBefore = processRows(), verified = one(immediatelyBefore.filter(row => birthKey(row) === birthKey(target) && row.executable === target.executable && row.parentPid === target.parentPid), 'Fault identity is still exact immediately before signal');
        const latestWire = receipts(owner.receiptPaths[0]); selectFaultTarget({ request, rows: immediatelyBefore, priorRows: all, wire: latestWire, nativeBinary: manifest.executableIdentities['codex-native'].path, boundIdentities: [...known.values()] });
        const signalIssuedAt = Date.now(); process.kill(verified.pid, 'SIGKILL');
        const result = { status: 'SIGNAL_ISSUED', signal: 'SIGKILL', signalIssuedAt, target, request, turnStarted: one(latestWire.filter(row => row.event === 'turn-started' && row.inputIndex === 31), 'Actual fault turn') };
        write(path.join(directory, 'fault-result.json'), result); append({ event: 'fault-signal-issued', ...result });
      } catch (error) { const result = { status: 'FAULT_NOT_INJECTED', at: Date.now(), error: error.message, request }; write(path.join(directory, 'fault-result.json'), result); append({ event: 'fault-not-injected', ...result }); }
    }
    previous = all;
    if (fs.existsSync(path.join(directory, 'native-result.json'))) { write(path.join(directory, 'external-observer-complete.json'), { at: Date.now(), status: 'OBSERVATION_COMPLETE', observedIdentities: [...known.values()], unverifiedRoots, remaining: live, faultHandled }); return; }
    const observations = fs.existsSync(path.join(owner.directory, 'observations.json')) ? read(path.join(owner.directory, 'observations.json')) : [];
    const latestCycle = observations.filter(row => row.event === 'reset-start').at(-1)?.cycle ?? 0;
    await sleep(latestCycle >= 27 ? 50 : 250);
  }
  write(path.join(directory, 'external-observer-complete.json'), { at: Date.now(), status: 'FAIL_OBSERVER_DEADLINE', observedIdentities: [...known.values()], faultHandled });
}

function auditJourneyEvidence({ manifest, acceptance, events, observations, wire, snapshots, fault, stored }) {
  assert.equal(acceptance.stage, STAGE); assert.equal(acceptance.status, 'CAPTURED_LIFECYCLE_CAMPAIGN_30');
  const cycles = buildCycles(manifest.token, checkedModels(manifest.modelReadiness)); assert.deepEqual(manifest.cycles, cycles);
  assert.equal(acceptance.cycles.length, 31); assert.equal(new Set(acceptance.cycles.map(row => row.conversationId)).size, 31);
  assert.equal(new Set(acceptance.cycles.map(row => row.sessionHash)).size, 31);
  assert(!events.some(row => ['permissionRequest', 'toolUse', 'toolResult', 'autonomousDecision', 'semiAutonomousPlanTimer', 'semiAutonomousQuestionTimer'].includes(row.type)));
  assert(!wire.some(row => /refusal|instrumentation-error|launch-error|tool-start|tool-result|approval-|auxiliary-input|unexpected-tool-item/.test(row.event)));
  const inputs = wire.filter(row => row.event === 'request'); assert.equal(inputs.length, MAIN_CAP); assert.deepEqual(inputs.map(row => row.inputIndex), Array.from({ length: MAIN_CAP }, (_, i) => i + 1));
  for (const input of inputs) {
    assert.equal(input.effort, 'low'); assert.equal(input.policy.effort, 'low'); assert.equal(input.containsFixtureToken, true);
    assert.equal(input.policy.approvalPolicy, 'untrusted'); assert.equal(input.policy.sandbox, 'read-only');
    for (const field of ['ownedCwd', 'mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) assert.equal(input.policy[field], true);
    const configuration = wire.filter(row => row.event === 'effective-tool-config' && row.wrapperPid === input.wrapperPid && row.at <= input.at).at(-1);
    assert(configuration); assert.deepEqual(input.policy.mcpNames, configuration.mcpNames); assert.deepEqual(input.policy.appNames, configuration.appNames);
    const session = wire.filter(row => row.event === 'session' && row.wrapperPid === input.wrapperPid && row.at <= input.at).at(-1); assert(session);
    assert.equal(session.sessionHash, input.sessionHash); assert.equal(session.actualModel, input.model); assert.equal(session.requestedModel, input.model);
    assert.equal(typeof session.modelProvider, 'string'); assert(session.modelProvider);
    assert.equal(session.returnedPolicy.approvalPolicy, 'untrusted'); assert.equal(session.returnedPolicy.sandbox, 'readOnly'); assert.equal(session.returnedPolicy.ownedCwd, true); assert.notEqual(session.returnedPolicy.networkAccess, true);
  }
  const publicUsers = events.filter(row => row.type === 'messageAdded' && row.payload?.role === 'user'); assert.equal(publicUsers.length, 33);
  assert.equal(events.filter(row => row.type === 'responseComplete').length, 31);
  assert(!events.some(row => ['authError', 'requestCancelled'].includes(row.type)));
  const issues = [], proofs = [], knownMessageIds = new Set();
  for (const [index, actual] of acceptance.cycles.entries()) {
    const definition = cycles[index]; assert.equal(actual.index, index); assert.equal(actual.marker, definition.marker);
    const expectedInput = index === 30 ? 32 : index + 1, input = one(inputs.filter(row => row.inputIndex === expectedInput), 'Exact bounded cycle input');
    assert.equal(input.wrapperPid, actual.wrapperPid); assert.equal(input.sessionHash, actual.sessionHash);
    assertRequestHistory(input, definition.marker, index === 29 ? ['PROFILE_REJECT_29'] : index === 30 ? ['CRASH_30'] : []);
    assert.equal(input.model, definition.model); assert.equal(input.effort, 'low');
    for (const field of ['ownedCwd', 'mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) assert.equal(input.policy[field], true);
    assert.equal(input.policy.approvalPolicy, 'untrusted'); assert.equal(input.policy.sandbox, 'read-only'); assert.equal(input.policy.effort, 'low');
    const own = wire.filter(row => row.wrapperPid === input.wrapperPid && row.inputIndex === expectedInput);
    const complete = one(own.filter(row => row.event === 'turn-completed'), 'One successful actual turn'); assert.equal(complete.status, 'completed'); assert.equal(complete.sessionHash, input.sessionHash);
    const begun = one(own.filter(row => row.event === 'turn-started'), 'One acknowledged actual turn'); assert.equal(begun.turnHash, complete.turnHash); assert.equal(begun.sessionHash, input.sessionHash);
    assert(actual.started <= input.at && input.at <= begun.at && begun.at <= complete.at && complete.at <= actual.completedAt);
    const session = wire.filter(row => row.event === 'session' && row.wrapperPid === input.wrapperPid && row.at <= input.at).at(-1); assert(session);
    assert.equal(session.method, index === 30 ? 'thread/resume' : 'thread/start'); assert.equal(session.sessionHash, actual.sessionHash); assert.equal(session.actualModel, definition.model); assert.equal(session.requestedModel, definition.model);
    const publicReply = one(events.filter(row => row.type === 'responseComplete' && row.payload?.message?.id === actual.messageId), 'Actual public completed cycle reply');
    assert.equal(publicReply.at, actual.completedAt); assert.equal(publicReply.payload.message.content, definition.expectedReply); assert.equal(publicReply.payload.message.model, definition.model); assert.equal(publicReply.payload.message.provider, 'openai-codex');
    const conversation = one(stored.conversations.filter(row => row.id === actual.conversationId), 'Each cycle has durable owned conversation');
    const message = one(conversation.messages.filter(row => row.id === actual.messageId), 'Completed message persists exactly'); assert.deepEqual(messageProjection(message), messageProjection(publicReply.payload.message));
    assert(!knownMessageIds.has(message.id)); knownMessageIds.add(message.id);
    const user = one(publicUsers.filter(row => row.payload.content === definition.prompt), 'One literal cycle user send'); assert(conversation.messages.some(row => row.id === user.payload.id && row.content === definition.prompt));
    const nativeText = joinNativeAssistantMessages(own.filter(row => row.event === 'assistant-message'), definition.expectedReply);
    if ([0, 27, 28].includes(index)) assert(events.some(row => row.type === 'modelChanged' && row.at <= actual.started
      && (index === 0 || row.at >= observations.find(value => value.event === 'reset-start' && value.cycle === index)?.at)
      && row.payload?.provider === 'openai-codex' && (row.payload.customModel || row.payload.model) === definition.model), 'Actual model-picker acknowledgement must precede the selected-model request');
    if (index) {
      const reset = one(observations.filter(row => row.event === 'reset-complete' && row.cycle === index), 'Exactly one observed public reset per cycle');
      const start = one(observations.filter(row => row.event === 'reset-start' && row.cycle === index), 'Reset has an actual start');
      assert.equal(reset.oldConversationId, acceptance.cycles[index - 1].conversationId); assert.equal(reset.newConversationId, actual.conversationId);
      assert(start.at <= reset.at && reset.at <= actual.started);
      assert(events.some(row => row.type === 'conversationChanged' && row.payload?.id === actual.conversationId && row.at >= start.at && row.at <= reset.at));
      assert(events.some(row => row.type === 'sessionCleared' && row.at >= start.at && row.at <= reset.at));
      const gone = one(observations.filter(row => row.event === 'old-process-exited' && row.cycle === index), 'Every reset has a bounded external process disappearance observation');
      assert.equal(gone.oldWrapperPid, acceptance.cycles[index - 1].wrapperPid); assert(gone.started >= actual.completedAt && gone.at >= gone.started && gone.at - gone.started <= 10_000);
      const snapshot = one(snapshots.filter(row => row.event === 'snapshot' && row.at === gone.snapshotAt), 'Disappearance joins the actual retained external snapshot');
      assert(snapshot.at >= actual.completedAt && snapshot.at <= gone.at); assert(!snapshot.rows.some(row => row.wrapperPid === gone.oldWrapperPid));
      assert(snapshots.some(row => row.event === 'snapshot' && row.at < snapshot.at && row.rows.some(value => value.wrapperPid === gone.oldWrapperPid && value.executable === manifest.executableIdentities['codex-native'].path)), 'An empty snapshot alone cannot establish prior native process ownership');
    }
    proofs.push({ cycle: index, conversationId: actual.conversationId, sessionHash: actual.sessionHash, wrapperPid: actual.wrapperPid, model: definition.model, nativeText });
  }
  assert.equal(observations.filter(row => row.event === 'reset-start').length, 30); assert.equal(observations.filter(row => row.event === 'reset-complete').length, 30);
  assert.equal(observations.filter(row => row.event === 'old-process-exited').length, 30);
  const finalClose = one(observations.filter(row => row.event === 'final-tab-closed'), 'Owned final chat tab closes through the public API');
  assert.equal(finalClose.accepted, true); assert.equal(finalClose.absent, true); assert.equal(finalClose.frameDetached, true);
  assert(finalClose.started >= acceptance.cycles[30].completedAt && finalClose.at >= finalClose.started);
  assert(!wire.some(row => row.at >= finalClose.started && (row.event === 'request' || row.event === 'invocation' && row.kind !== 'probe')), 'Final tab close cannot initiate replacement main work');
  const rejection = acceptance.profileRejection; assert.equal(rejection.configRaw, manifest.profileValidation.missing.name);
  assert.equal(rejection.visibleError, `Error: ${PROFILE_ERROR}`); assert.equal(rejection.inputCountBefore, 29); assert.equal(rejection.inputCountAfter, 29);
  assert(!wire.some(row => row.event === 'invocation' && row.kind === 'app-server' && row.selectedProfile === undefined && row.at >= rejection.selectedAt && row.at <= rejection.ended), 'Rejected profile cannot silently start a base-configuration process');
  const rejectedUser = one(publicUsers.filter(row => row.payload.content === profilePrompt(manifest.token)), 'One rejected public profile attempt');
  const rejected = wire.filter(row => row.event === 'invocation' && row.selectedProfile === manifest.profileValidation.missing.name); assert(rejected.length > 0);
  for (const invocation of rejected) {
    assert.deepEqual(invocation.args, ['--profile', manifest.profileValidation.missing.name, 'app-server']);
    assert(invocation.at >= rejection.selectedAt && invocation.at <= rejection.ended); assert.equal(invocation.profileFileSha256, null);
    const own = wire.filter(row => row.wrapperPid === invocation.wrapperPid);
    assert(!own.some(row => ['request', 'session', 'profile-config', 'effective-tool-config', 'turn-started', 'turn-completed'].includes(row.event)));
    assert(!own.some(row => row.event === 'rpc-request' && row.method !== 'initialize'));
    assert(!own.some(row => row.event === 'rpc-result' && row.method === 'initialize' && row.success));
    assert.equal(one(own.filter(row => row.event === 'stderr-summary'), 'Native rejected-profile signature').runtimeOnlyProfileArgument, true);
    one(own.filter(row => row.event === 'exit'), 'Rejected native process must actually exit');
  }
  const rejectedError = one(events.filter(row => row.type === 'error' && row.at >= rejection.started && row.at <= rejection.ended), 'One visible rejected profile error');
  assert.equal(typeof rejectedError.payload === 'string' ? rejectedError.payload : rejectedError.payload.error, PROFILE_ERROR);
  const crash = one(inputs.filter(row => row.inputIndex === 31), 'One interrupted input'); assertRequestHistory(crash, 'CRASH_30');
  assert.equal(crash.sessionHash, acceptance.cycles[30].sessionHash); assert.notEqual(crash.wrapperPid, acceptance.cycles[30].wrapperPid);
  assert.equal(fault.status, 'SIGNAL_ISSUED'); assert.equal(fault.request.wrapperPid, crash.wrapperPid); assert.equal(fault.signal, 'SIGKILL');
  assert(fault.signalIssuedAt >= fault.turnStarted.at); assert.equal(fault.turnStarted.inputIndex, 31);
  assert(!wire.some(row => row.event === 'turn-completed' && row.inputIndex === 31 && row.status === 'completed'));
  assert.equal(acceptance.crashRecovery.visibleError, true); assert.equal(acceptance.crashRecovery.busyStopped, true);
  const crashError = one(events.filter(row => row.type === 'error' && row.at >= fault.signalIssuedAt && row.at <= acceptance.crashRecovery.ended), 'One visible incomplete crash error');
  assert.match(typeof crashError.payload === 'string' ? crashError.payload : crashError.payload.error, /incomplete/i);
  assert.equal(events.filter(row => row.type === 'error').length, 2);
  const crashUser = one(publicUsers.filter(row => row.payload.content === crashPrompt(manifest.token)), 'One bounded crash attempt');
  for (const [index, user] of [[29, rejectedUser], [30, crashUser]]) {
    const conversation = one(stored.conversations.filter(row => row.id === acceptance.cycles[index].conversationId), 'Error user keeps owned conversation');
    assert(conversation.messages.some(row => row.id === user.payload.id && row.content === user.payload.content));
  }
  const errorMessages = [rejectedError, crashError].filter(row => row.payload?.message).map(row => row.payload.message);
  for (const [index, error] of [[29, rejectedError], [30, crashError]]) if (error.payload?.message) {
    const conversation = one(stored.conversations.filter(row => row.id === acceptance.cycles[index].conversationId), 'Error partial belongs to the actual failed conversation');
    const partial = one(conversation.messages.filter(row => row.id === error.payload.message.id), 'Every public error partial must persist');
    assert.deepEqual(messageProjection(partial), messageProjection(error.payload.message));
  }
  for (const conversation of stored.conversations) for (const message of conversation.messages) {
    if (message.role === 'user') assert(publicUsers.some(row => row.payload.id === message.id && row.payload.content === message.content), 'No unaccounted durable user work');
    if (message.role === 'assistant' && !knownMessageIds.has(message.id)) {
      const partial = one(errorMessages.filter(row => row.id === message.id), 'Only an actual error-delivered partial assistant can accompany completed replies');
      assert.deepEqual(messageProjection(message), messageProjection(partial));
    }
  }
  const races = [27, 28, 29].map(cycle => {
    const start = one(observations.filter(row => row.event === 'reset-start' && row.cycle === cycle), 'Race starts at public reset');
    const oldPid = acceptance.cycles[cycle - 1].wrapperPid, newPids = cycle === 29 ? rejected.map(row => row.wrapperPid) : [acceptance.cycles[cycle].wrapperPid];
    const native = row => row.executable === manifest.executableIdentities['codex-native'].path && Number.isFinite(Date.parse(row.startedAt));
    const overlap = snapshots.find(row => row.event === 'snapshot' && row.at >= start.at && row.at <= acceptance.cycles[cycle].completedAt
      && row.rows.some(p => p.wrapperPid === oldPid && native(p)) && row.rows.some(p => newPids.includes(p.wrapperPid) && native(p)));
    const replacementPid = acceptance.cycles[cycle].wrapperPid;
    const survived = overlap && snapshots.find(row => row.event === 'snapshot' && row.at > overlap.at && row.at <= acceptance.cycles[cycle].completedAt
      && !row.rows.some(p => p.wrapperPid === oldPid) && row.rows.some(p => p.wrapperPid === replacementPid && native(p)));
    if (!overlap) issues.push({ cycle, code: 'RACE_NOT_OBSERVED' });
    else if (!survived) issues.push({ cycle, code: 'CLEANUP_SURVIVAL_NOT_OBSERVED' });
    return { cycle, oldWrapperPid: oldPid, newWrapperPids: newPids, replacementWrapperPid: replacementPid,
      status: survived ? 'OBSERVED_CLEANUP_SURVIVAL' : 'PARTIAL_RACE_NOT_OBSERVED', overlapAt: overlap?.at, survivedAt: survived?.at };
  });
  return { status: issues.length ? 'PARTIAL_RACE_NOT_OBSERVED' : 'PASS_BOUNDED_LIFECYCLE', resetCycles: { expected: 30, completed: 30, uniqueThreads: 31 }, completedReplies: 31,
    mainInputs: 32, publicAttempts: 33, races, proofs, issues, limits: ['No elapsed S/W/E/P credit.', 'Named-profile startup rejection is not successful named-profile loading.', 'One panel does not establish cross-panel isolation; no reused-native-ID claim.'] };
}

module.exports = { STAGE, PREFIX, MAIN_CAP, AUX_CAP, PROFILE_ERROR, checkedModels, buildCycles, profilePrompt, crashPrompt,
  historyMetadata, assertRequestHistory, instrumentMainRuntime, createMainWrapper, processRows, birthKey, bindLaunch, selectFaultTarget, auditJourneyEvidence, observe, withOwnedObserver };

function build() {
  const directory = fs.mkdtempSync(path.join(root, 'codex-lifecycle-campaign-build-'));
  const config = path.join(directory, 'tsconfig.json');
  write(config, { extends: path.join(repo, 'tsconfig.vscode-test.json'), compilerOptions: { outDir: directory, rootDir: path.join(repo, 'tests-vscode') },
    files: ['codex-lifecycle-campaign.test.ts', 'codex-helper-quality-observer.ts', 'codex-profile-compatibility-explicit-effort.ts'].map(file => path.join(repo, 'tests-vscode', file)), include: [] });
  execFileSync(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', config], { stdio: 'inherit' });
  // Shared runner expects a suite-named observer. The pinned immutable observer is reused verbatim.
  for (const ext of ['.js', '.js.map']) fs.copyFileSync(path.join(directory, 'codex-helper-quality-observer' + ext), path.join(directory, 'codex-lifecycle-campaign-observer' + ext), fs.constants.COPYFILE_EXCL);
  console.log(JSON.stringify({ compiledDirectory: directory, editorLaunches: 0, inferenceInputs: 0 })); return directory;
}
function prepare() {
  const artifactDir = path.resolve(process.env[PREFIX + '_ARTIFACT_DIR']);
  const compiledDirectory = fs.realpathSync(process.env[PREFIX + '_COMPILED_DIR']); contained(root, compiledDirectory);
  for (let current = compiledDirectory; current !== root; current = path.dirname(current)) { contained(root, current); assert(!fs.existsSync(path.join(current, 'prepared.json'))); }
  const readinessPath = path.join(root, 'readiness.json'), modelReadinessPath = path.join(root, 'app-server-readiness.json');
  const readiness = read(readinessPath), modelReadiness = read(modelReadinessPath), models = checkedModels(modelReadiness);
  assert.equal(hash(readiness.entry), readiness.entrySha256); assert.equal(hash(readiness.node), readiness.nodeSha256); assert.equal(hash(readiness.binary.path), readiness.binary.sha256);
  assert.equal(readiness.probes.version.version, 'codex-cli 0.162.0');
  const packageIdentityPath = fs.realpathSync(process.env[PREFIX + '_PACKAGE_IDENTITY']), sourceIdentityPath = fs.realpathSync(process.env[PREFIX + '_SOURCE_IDENTITY']);
  contained(root, packageIdentityPath); contained(root, sourceIdentityPath);
  const artifact = read(packageIdentityPath), sourceIdentity = read(sourceIdentityPath), sourcePackage = fs.realpathSync(artifact.extension);
  assert.equal(artifact.sourceSnapshotUnchanged, true); assert.equal(hash(artifact.archive), artifact.sha256);
  assert.equal(hash(path.join(sourcePackage, 'dist/extension.js')), artifact.bundleSha256); assert.equal(hash(path.join(sourcePackage, 'media/chat/chat.js')), artifact.chatSha256);
  for (const [relative, expected] of Object.entries(sourceIdentity.files)) { const file = path.resolve(repo, relative); contained(repo, file); assert.equal(hash(file), expected); }
  const auxiliaryEvidencePath = path.join(root, 'auxiliary-isolation/claude-flag-evidence.json');
  const auxiliaryExecutable = one(read(auxiliaryEvidencePath).executables.filter(value => value.path.includes('anthropic.claude-code-2.1.296-')), 'Pinned isolated auxiliary CLI');
  assert.equal(hash(auxiliaryExecutable.path), auxiliaryExecutable.sha256);
  freshDirectory(artifactDir);
  const directory = path.join(artifactDir, 'window-A'); fs.mkdirSync(directory);
  const extensionsDir = path.join(directory, 'installed-extensions'); fs.mkdirSync(extensionsDir);
  const product = read(path.join(sourcePackage, 'package.json')); assert.equal(product.name, 'mysti'); assert.equal(product.publisher.toLowerCase(), 'deepmyst');
  const installedExtension = path.join(extensionsDir, `deepmyst.mysti-${product.version}`); fs.cpSync(sourcePackage, installedExtension, { recursive: true, force: false, errorOnExist: true });
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(repo, '.vscode-test/profiles/pb02-lc-A-')));
  if (process.platform === 'darwin') assert(Buffer.byteLength(path.join(profile, '1.14-main.sock')) <= 103);
  write(path.join(profile, '.mysti-test-owned.json'), { case: 'PB-02', profile, window: 'A' });
  const sharedDataDir = fs.mkdtempSync(path.join(repo, '.vscode-test/pb02-lc-shared-'));
  const fixture = fixtureContract.copyPreservedFixture(path.join(directory, 'workspace')), token = fixture.token;
  const codeHome = fs.realpathSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const missingName = 'pb02-lifecycle-' + sha(artifactDir).slice(0, 20);
  const profileValidation = { codeHome, profiles: {}, missing: { name: missingName, path: path.join(codeHome, missingName + '.config.toml') } };
  assert(!fs.existsSync(profileValidation.missing.path), 'No actual external profile is created or overwritten');
  const cliDirectory = path.join(directory, 'cli'); fs.mkdirSync(cliDirectory);
  const counterFile = path.join(directory, 'forwarded-input-count.json');
  const cli = createMainWrapper({ directory: cliDirectory, executable: readiness.node, prefixArgs: [readiness.entry], node: readiness.node,
    workspace: fixture.workspace, counterFile, token, maxInputs: MAIN_CAP, profileValidation });
  const auxiliaryCounterFile = path.join(directory, 'forwarded-auxiliary-input-count.json');
  const auxiliary = require('./pb02-auxiliary-cli-fixture.cjs').createPB02AuxiliaryCli({ directory: cliDirectory, executable: auxiliaryExecutable.path,
    node: readiness.node, counterFile: auxiliaryCounterFile, maxInputs: AUX_CAP, probeDirectories: [repo, fixture.workspace] });
  fs.mkdirSync(path.join(profile, 'User'));
  write(path.join(profile, 'User/settings.json'), { 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'git.enabled': false,
    'mysti.codexPath': cli.launcher, 'mysti.claudeCodePath': auxiliary.launcher, 'mysti.defaultAgent': 'openai-codex', 'mysti.defaultProvider': 'openai-codex',
    'mysti.defaultModel': models.primary, 'mysti.codexModel': models.primary, 'mysti.codexProfile': '', 'mysti.defaultEffortLevel': 'low', 'mysti.defaultThinkingLevel': 'none',
    'mysti.defaultMode': 'ask-before-edit', 'mysti.accessLevel': 'ask-permission', 'mysti.autoContext': false,
    'mysti.showSuggestions': false, 'mysti.planDetection.enabled': false, 'mysti.agents.autoSuggest': false });
  const helper = path.join(artifactDir, 'lifecycle-campaign-runner-extension'); fs.mkdirSync(helper);
  write(path.join(helper, 'package.json'), { name: 'pb02-lifecycle-campaign-runner', publisher: 'MystiValidation', version: '1.0.0', engines: { vscode: '^1.100.0' },
    activationEvents: ['onStartupFinished'], main: './extension.cjs', capabilities: { untrustedWorkspaces: { supported: true } } });
  const owner = { id: 'A', directory, workspace: fixture.workspace, profile, sharedDataDir, extensionsDir, installedExtension, cliDirectory,
    wrappers: { 'openai-codex': cli.launcher, 'claude-code': auxiliary.launcher }, receiptPaths: [cli.receipts], auxiliaryReceiptPaths: [auxiliary.receipts] };
  const manifest = { case: 'PB-02', stage: STAGE, artifactDir, preparedBeforeActivation: true, compiledDirectory, sourcePackage, helper, windows: { A: owner }, fixture,
    token, cycles: buildCycles(token, models), models, modelReadiness, modelReadinessIdentity: identity(modelReadinessPath), profileValidation,
    model: models.primary, maxForwardedInputs: MAIN_CAP, plannedSuccessfulTurns: 31, counterFile,
    bundleSha256: artifact.bundleSha256, chatSha256: artifact.chatSha256, packageIdentity: identity(packageIdentityPath), sourceIdentity: identity(sourceIdentityPath), readiness: identity(readinessPath), nodeIdentity: identity(readiness.node),
    executableIdentities: { 'openai-codex': identity(readiness.entry), 'codex-native': identity(readiness.binary.path), 'claude-auxiliary-native': identity(auxiliaryExecutable.path) },
    wrapperIdentities: [cli.launcher, cli.runtime, auxiliary.launcher, auxiliary.runtime].map(identity),
    harnessDependencyIdentities: [__filename, require.resolve('./ordinary-profile-runner.cjs'), require.resolve('./codex-helper-quality-contract.cjs'), require.resolve('./codex-semantic-followup-contract.cjs'),
      require.resolve('./audit-vscode-claude.cjs'), require.resolve('./audit-vscode-codex-helper-quality.cjs'), require.resolve('./codex-helper-quality-auxiliary.cjs'), require.resolve('./codex-stage-oracle.cjs'), require.resolve('./codex-full-followup-auxiliary.cjs'),
      require.resolve('./pb02-profile-compatibility-cli-runtime.cjs'), require.resolve('./pb02-auxiliary-cli-fixture.cjs'), require.resolve('./pb02-auxiliary-cli-runtime.cjs')].map(identity),
    auxiliary: { provider: 'claude-code', maxInputs: AUX_CAP, counterFile: auxiliaryCounterFile, expectedArgs: auxiliaryAudit.EXPECTED_ARGS,
      executableIdentity: identity(auxiliaryExecutable.path), flagEvidenceIdentity: identity(auxiliaryEvidencePath), routingSetting: 'mysti.claudeCodePath', launcher: auxiliary.launcher, runtime: auxiliary.runtime },
    scope: '30 real public new-conversation/native-thread resets, two selected-model transitions, one unsupported-profile rejection/default recovery and one owned native-child crash/explicit recovery. 32 main/32 helper hardcaps. Optional suggestions/classification deliberately off for lifecycle-only scope; titles remain counted. No elapsed S/W/E/P, cross-panel, successful named-profile or reused-native-ID claim.' };
  const manifestFile = path.join(artifactDir, 'prepared.json');
  fs.writeFileSync(path.join(helper, 'extension.cjs'), `'use strict';
const vscode=require('vscode'),fs=require('fs'),path=require('path');
const manifestPath=${JSON.stringify(manifestFile)},repo=${JSON.stringify(repo)};
exports.activate=()=>setTimeout(run,500); exports.deactivate=()=>{};
async function run(){ const m=JSON.parse(fs.readFileSync(manifestPath)),o=m.windows.A;let failures=0,error;const testFailures=[];
try{ if(vscode.workspace.workspaceFolders?.length!==1||fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)!==fs.realpathSync(o.workspace))throw Error('Owned workspace required');
if(!vscode.workspace.isTrusted)await vscode.commands.executeCommand('workbench.trust.manage');const deadline=Date.now()+60000;while(!vscode.workspace.isTrusted&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));if(!vscode.workspace.isTrusted)throw Error('Trust incomplete');
const registryDeadline=Date.now()+15000;let product;while(!(product=vscode.extensions.getExtension('DeepMyst.mysti'))&&Date.now()<registryDeadline)await new Promise(r=>setTimeout(r,100));if(!product||product.isUnderDevelopment||fs.realpathSync(product.extensionPath)!==fs.realpathSync(o.installedExtension))throw Error('Ordinary installed product required');
fs.writeFileSync(path.join(o.directory,'helper-ready.json'),JSON.stringify({profile:o.profile,extensionTestsPathUsed:false,productUnderDevelopment:product.isUnderDevelopment??'NOT_EXPOSED_BY_PUBLIC_API'}));
const Mocha=require(path.join(repo,'node_modules/mocha'));const mocha=new Mocha({ui:'bdd',timeout:1500000,color:false});mocha.addFile(path.join(m.compiledDirectory,'codex-lifecycle-campaign.test.js'));
failures=await new Promise(resolve=>mocha.run(resolve).on('fail',(t,e)=>testFailures.push({title:t.fullTitle(),name:e?.name,message:e?.message})));}
catch(e){failures=1;error={name:e.name,message:e.message};}fs.writeFileSync(path.join(o.directory,'runner-result.json'),JSON.stringify({failures,error,testFailures,extensionHostPid:process.pid,normalQuitRequested:true}));await vscode.commands.executeCommand('workbench.action.quit');}
`, { flag: 'wx' });
  manifest.harnessDependencyIdentities.push(...[path.join(helper, 'extension.cjs'), path.join(helper, 'package.json'), modelReadinessPath, auxiliaryEvidencePath,
    ...['codex-lifecycle-campaign.test.ts', 'codex-helper-quality-observer.ts', 'codex-profile-compatibility-explicit-effort.ts'].map(file => path.join(repo, 'tests-vscode', file)),
    ...['codex-lifecycle-campaign.test', 'codex-lifecycle-campaign-observer', 'codex-helper-quality-observer', 'codex-profile-compatibility-explicit-effort'].flatMap(stem => ['.js', '.js.map'].map(ext => path.join(compiledDirectory, stem + ext)))].map(identity));
  fixtureContract.verifyPreservedBase(fixture); write(manifestFile, manifest);
  console.log(JSON.stringify({ prepared: manifestFile, profile, editorLaunches: 0, inferenceInputs: 0 })); return manifest;
}
async function run(directory) {
  const manifest = read(path.join(directory, 'prepared.json')); assert.equal(manifest.stage, STAGE); assert.equal(manifest.artifactDir, directory);
  for (const value of [identity(__filename), ...manifest.harnessDependencyIdentities, ...manifest.wrapperIdentities, ...Object.values(manifest.executableIdentities)]) assert.equal(hash(value.path), value.sha256);
  fixtureContract.verifyPreservedBase(manifest.fixture); assert(!fs.existsSync(manifest.profileValidation.missing.path));
  return withOwnedObserver(directory, async ({ terminal }) => {
    process.env[PREFIX + '_ARTIFACT_DIR'] = directory; process.env[PREFIX + '_REPO'] = repo;
    require('./ordinary-profile-runner.cjs').runOwnedEditor({ caseId: 'PB-02', envPrefix: PREFIX,
      suiteStem: path.join(path.relative(path.join(repo, 'out-vscode-test'), manifest.compiledDirectory), 'codex-lifecycle-campaign'),
      label: '[PB-02 lifecycle campaign]', plannedInputs: MAIN_CAP, timeoutMs: 1500000 });
    const deadline = Date.now() + 27 * 60_000;
    while (!fs.existsSync(path.join(directory, 'native-result.json'))) {
      if (fs.existsSync(path.join(directory, 'driver-fatal.json'))) throw Error('Ordinary editor runner failed; original driver-fatal.json is preserved');
      assert(!terminal(), 'External observer exited before the ordinary runner reached its terminal result');
      assert(Date.now() < deadline, 'Ordinary runner terminal observation deadline exceeded'); await sleep(100);
    }
  });
}
Object.assign(module.exports, { build, prepare, run, replaceSnapshot });

function auditMainProcesses(wire, manifest) {
  const invocations = wire.filter(row => row.event === 'invocation'), processes = [];
  assert.equal(new Set(invocations.map(row => row.wrapperPid)).size, invocations.length);
  for (const invocation of invocations) {
    const rows = wire.filter(row => row.wrapperPid === invocation.wrapperPid), probe = invocation.kind === 'probe';
    assert(['probe', 'app-server'].includes(invocation.kind)); assert.equal(invocation.codeHomeMatches, true); assert.equal(invocation.profileFileSha256, null);
    const selected = invocation.selectedProfile; assert(selected === undefined || selected === manifest.profileValidation.missing.name);
    assert.deepEqual(invocation.args, probe ? ['--version'] : selected ? ['--profile', selected, 'app-server'] : ['app-server']);
    assert.equal(invocation.profileOwnedPath, selected ? manifest.profileValidation.missing.path : undefined);
    if (probe) assert(rows.every(row => ['invocation', 'probe-start', 'stderr-summary', 'probe-exit'].includes(row.event)));
    const start = one(rows.filter(row => row.event === (probe ? 'probe-start' : 'start')), 'Every invocation has exact native start');
    assert(start.at >= invocation.at); assert(Array.isArray(start.processBirths)); assert(start.processBirths.some(row => row.pid === start.wrapperPid));
    const summaries = rows.filter(row => row.event === 'stderr-summary'), exits = rows.filter(row => row.event === (probe ? 'probe-exit' : 'exit'));
    assert(summaries.length <= 1 && exits.length <= 1); if (probe || selected) { assert.equal(summaries.length, 1); assert.equal(exits.length, 1); }
    const summary = summaries[0] || null, exit = exits[0] || null;
    if (summary) { assert(Number.isSafeInteger(summary.bytes) && summary.bytes >= 0); assert(/^[a-f0-9]{64}$/.test(summary.sha256)); if (!summary.bytes) assert.equal(summary.sha256, sha('')); assert.equal(summary.runtimeOnlyProfileArgument, !!selected); assert(summary.at >= start.at); }
    if (exit) { assert.equal(exit.childPid, start.childPid); assert(exit.at >= start.at); assert(exit.exitCode === null || Number.isInteger(exit.exitCode)); assert(exit.signal === null || /^SIG[A-Z0-9]+$/.test(exit.signal)); assert(exit.exitCode !== null || exit.signal !== null); }
    if (summary && exit) { assert(summary.at <= exit.at); assert(rows.indexOf(summary) < rows.indexOf(exit)); }
    processes.push({ wrapperPid: invocation.wrapperPid, childPid: start.childPid, kind: invocation.kind, selectedProfile: selected, summary, exit, terminalStatus: summary && exit ? 'complete' : 'UNOBSERVED' });
  }
  for (const row of wire) assert(invocations.some(value => value.wrapperPid === row.wrapperPid), 'No orphan native receipts');
  return { status: processes.some(row => row.terminalStatus === 'UNOBSERVED') ? 'PARTIAL_MAIN_SHUTDOWN' : 'PASS_MAIN_TRANSPORT', processes };
}
function audit(directory) {
  const manifest = read(ownedFile(directory, path.join(directory, 'prepared.json'))), owner = manifest.windows.A;
  assert.equal(manifest.stage, STAGE); assert.equal(manifest.artifactDir, directory); assert.equal(manifest.maxForwardedInputs, MAIN_CAP); assert.equal(manifest.plannedSuccessfulTurns, 31);
  assert.deepEqual(Object.keys(manifest.windows), ['A']); assert.equal(manifest.preparedBeforeActivation, true); contained(directory, owner.directory); contained(owner.directory, owner.workspace);
  const pins = [...manifest.harnessDependencyIdentities, ...manifest.wrapperIdentities, ...Object.values(manifest.executableIdentities), manifest.nodeIdentity, manifest.readiness,
    manifest.modelReadinessIdentity, manifest.sourceIdentity, manifest.packageIdentity];
  for (const value of pins) assert.equal(hash(value.path), value.sha256, `Pinned source or executable changed: ${value.path}`);
  assert(pins.some(value => value.path === __filename));
  assert.deepEqual(manifest.modelReadiness, read(manifest.modelReadinessIdentity.path)); checkedModels(manifest.modelReadiness);
  const release = read(manifest.packageIdentity.path); assert.equal(hash(release.archive), release.sha256); assert.equal(release.sourceSnapshotUnchanged, true);
  for (const [relative, expected] of Object.entries(read(manifest.sourceIdentity.path).files)) { const file = path.resolve(repo, relative); contained(repo, file); assert.equal(hash(file), expected); }
  for (const extension of [manifest.sourcePackage, owner.installedExtension]) { assert.equal(hash(path.join(extension, 'dist/extension.js')), manifest.bundleSha256); assert.equal(hash(path.join(extension, 'media/chat/chat.js')), manifest.chatSha256); }
  assert(!fs.existsSync(manifest.profileValidation.missing.path)); fixtureContract.verifyPreservedBase(manifest.fixture);
  const acceptance = read(ownedFile(owner.directory, path.join(owner.directory, 'acceptance.json'))), workspace = fixtureContract.verifyCopiedFixture(manifest.fixture, [acceptance.panelId]); assert.deepEqual(acceptance.files, workspace);
  const wire = receipts(ownedFile(owner.directory, owner.receiptPaths[0])), events = read(ownedFile(owner.directory, path.join(owner.directory, 'events-main.json'))), observations = read(ownedFile(owner.directory, path.join(owner.directory, 'observations.json')));
  for (const row of wire) { assert.equal(row.provider, 'openai-codex'); assert.equal(row.window, 'A'); assert(Number.isSafeInteger(row.wrapperPid) && row.wrapperPid > 0 && Number.isFinite(row.at)); }
  const snapshots = receipts(ownedFile(directory, path.join(directory, 'external-process-observations.jsonl'))), observer = read(ownedFile(directory, path.join(directory, 'external-observer-complete.json')));
  assert.equal(observer.status, 'OBSERVATION_COMPLETE'); assert.deepEqual(observer.remaining, []); assert.equal(observer.faultHandled, true);
  const observerReady = read(ownedFile(directory, path.join(directory, 'external-observer-ready.json'))), observerDrain = read(ownedFile(directory, path.join(directory, 'external-observer-drain.json')));
  assert.equal(observerDrain.status, 'PASS_OBSERVER_DRAIN'); assert.equal(observerDrain.forced, false); assert.deepEqual(observerDrain.remaining, []);
  assert.equal(observerDrain.terminal.code, 0); assert.equal(observerDrain.terminal.signal, null); assert.equal(birthKey(observerReady), birthKey(observerDrain.observerIdentity));
  const fault = read(ownedFile(directory, path.join(directory, 'fault-result.json'))), stored = readStoredConversations(owner);
  const journey = auditJourneyEvidence({ manifest, acceptance, events, observations, wire, snapshots, fault, stored });
  assert.equal(read(path.join(directory, 'native-result.json')).status, 'PASS');
  const exit = read(path.join(owner.directory, 'editor-exit.json')), cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json')), ancestry = read(path.join(owner.directory, 'process-ancestry.json'));
  assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.timedOut, false); assert.equal(exit.helper.failures, 0); assert.equal(exit.helper.normalQuitRequested, true);
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []); assert.equal(cleanup.conversationalInputs, 32);
  assert.equal(ancestry.sampleIntervalMs, 250); assert.equal(cleanup.observedIdentityCount, ancestry.processIdentities.length);
  const liveRows = processRows(), live = new Map(liveRows.map(row => [birthKey(row), row]));
  for (const row of [...ancestry.processIdentities, ...observer.observedIdentities, observerDrain.observerIdentity]) assert(!live.has(birthKey(row)), 'An observed owned process identity remains alive');
  for (const file of [path.join(directory, 'driver-fatal.json'), path.join(owner.directory, 'forced-cleanup.json')]) assert(!fs.existsSync(file), 'Failed or forced runner cleanup cannot pass');
  const beforeFault = snapshots.filter(row => row.event === 'snapshot' && row.at <= fault.signalIssuedAt).slice(-2); assert.equal(beforeFault.length, 2);
  const replayTarget = selectFaultTarget({ request: fault.request, rows: beforeFault[1].rows, priorRows: beforeFault[0].rows,
    wire: wire.filter(row => row.at <= fault.signalIssuedAt), nativeBinary: manifest.executableIdentities['codex-native'].path, boundIdentities: observer.observedIdentities });
  assert.deepEqual(replayTarget, fault.target);
  const launch = read(path.join(owner.directory, 'launch.json')); assert.equal(launch.extensionTestsPathUsed, false); assert.equal(launch.profile, owner.profile); assert.equal(launch.installedExtension, owner.installedExtension);
  assert(launch.args.includes(owner.workspace) && launch.args.includes(`--user-data-dir=${owner.profile}`) && launch.args.includes(`--extensions-dir=${owner.extensionsDir}`));
  const reservation = read(path.join(directory, 'launch-reservation.json')); assert.equal(reservation.plannedConversationRequests, 32);
  assert.equal(reservation.harnessSha256, hash(path.join(manifest.compiledDirectory, 'codex-lifecycle-campaign.test.js'))); assert.equal(reservation.observerSha256, hash(path.join(manifest.compiledDirectory, 'codex-lifecycle-campaign-observer.js')));
  assert.deepEqual(read(manifest.counterFile), { forwardedInputs: 32, maxInputs: 32 }); assert(!fs.existsSync(manifest.counterFile + '.lock'));
  const settings = read(path.join(owner.profile, 'User/settings.json')); assert.equal(settings['mysti.showSuggestions'], false); assert.equal(settings['mysti.planDetection.enabled'], false); assert.equal(settings['mysti.codexProfile'], '');
  assert.equal(settings['mysti.codexPath'], owner.wrappers['openai-codex']); assert.equal(settings['mysti.claudeCodePath'], manifest.auxiliary.launcher);
  const auxRows = receipts(ownedFile(owner.directory, owner.auxiliaryReceiptPaths[0])); assert(auxRows.filter(row => row.event === 'auxiliary-input').length <= AUX_CAP);
  const auxiliary = auxiliaryAudit.auditEvidence({ auxiliary: manifest.auxiliary, receipts: auxRows, ancestry, cleanup,
    counter: read(manifest.auxiliary.counterFile), live: liveRows.map(row => ({ pid: row.pid, startedAt: row.startedAt })), primaryAuxiliaryInputs: 0, temporaryRoot: fs.realpathSync(os.tmpdir()) });
  const mainTransport = auditMainProcesses(wire, manifest);
  const status = mainTransport.status === 'PARTIAL_MAIN_SHUTDOWN' || journey.issues.length ? 'PARTIAL_BOUNDED_LIFECYCLE' : 'PASS_BOUNDED_LIFECYCLE';
  fixtureContract.verifyPreservedBase(manifest.fixture);
  return { status, stage: STAGE, checkedAt: new Date().toISOString(), auditor: identity(__filename), journey, mainTransport, auxiliary, workspace,
    counts: { resets: 30, completedReplies: 31, publicAttempts: 33, mainInputs: 32, mainCap: 32, helperInputs: auxiliary.counts.submitted, helperCap: 32 },
    fault, observerDrain, observedProcessIdentityCount: observer.observedIdentities.length, observerUnverifiedRoots: observer.unverifiedRoots, pins,
    evidence: [path.join(owner.directory, 'acceptance.json'), path.join(owner.directory, 'events-main.json'), path.join(owner.directory, 'observations.json'), path.join(directory, 'external-process-observations.jsonl'), path.join(directory, 'fault-result.json')].map(identity),
    elapsedProfiles: { S: 'NOT_RUN', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' } };
}
Object.assign(module.exports, { auditMainProcesses, audit });

function syntheticEvidence() {
  const modelReadiness = read(path.join(root, 'app-server-readiness.json')), models = checkedModels(modelReadiness), token = 'PB02_SERVICE_abcdef';
  const manifest = { stage: STAGE, token, models, modelReadiness, cycles: buildCycles(token, models),
    profileValidation: { missing: { name: 'pb02-lifecycle-control', path: '/owned/code-home/pb02-lifecycle-control.config.toml' } }, executableIdentities: { 'codex-native': { path: '/owned/native/codex' } } };
  const acceptance = { stage: STAGE, status: 'CAPTURED_LIFECYCLE_CAMPAIGN_30', cycles: [] }, events = [], observations = [], wire = [], snapshots = [], stored = { conversations: [] }, processMap = new Map();
  const epoch = Date.parse('2026-10-11T00:00:00Z');
  function rows(pid, at) { const startedAt = new Date(at - 1000).toISOString(); return [
    { pid, parentPid: 42, groupPid: pid, startedAt, executable: '/owned/node', wrapperPid: pid },
    { pid: pid + 1, parentPid: pid, groupPid: pid, startedAt, executable: '/owned/node', wrapperPid: pid },
    { pid: pid + 2, parentPid: pid + 1, groupPid: pid, startedAt, executable: '/owned/native/codex', wrapperPid: pid }]; }
  function add(pid, event, at, fields = {}) { const row = { provider: 'openai-codex', window: 'A', wrapperPid: pid, event, at, ...fields }; wire.push(row); return row; }
  function start(pid, at, selectedProfile) {
    const ownRows = rows(pid, at); processMap.set(pid, ownRows);
    add(pid, 'invocation', at, { kind: 'app-server', args: selectedProfile ? ['--profile', selectedProfile, 'app-server'] : ['app-server'], selectedProfile,
      profileOwnedPath: selectedProfile ? manifest.profileValidation.missing.path : undefined, profileFileSha256: null, codeHomeMatches: true });
    add(pid, 'start', at + 1, { childPid: pid + 1, processBirths: ownRows.slice(0, 2).map(row => ({ pid: row.pid, startedAt: row.startedAt })) });
  }
  function end(pid, at, selectedProfile = false, signal = null) {
    add(pid, 'stderr-summary', at, { bytes: selectedProfile ? 4 : 0, sha256: sha(selectedProfile ? 'diag' : ''), runtimeOnlyProfileArgument: selectedProfile });
    add(pid, 'exit', at + 1, { childPid: pid + 1, exitCode: signal ? null : 0, signal });
  }
  function send(pid, at, inputIndex, marker, sessionHash, model, text, method = 'thread/start') {
    start(pid, at); const policy = { ownedCwd: true, mcpAllDisabled: true, appsAllDisabled: true, appsDefaultDisabled: true, approvalPolicy: 'untrusted', sandbox: 'read-only', effort: 'low', mcpNames: [], appNames: [] };
    add(pid, 'effective-tool-config', at + 2, { mcpNames: [], appNames: [] });
    add(pid, 'session', at + 2, { method, sessionHash, actualModel: model, requestedModel: model, modelProvider: 'openai', returnedPolicy: { approvalPolicy: 'untrusted', sandbox: 'readOnly', ownedCwd: true, networkAccess: false } });
    const history = marker === 'CYCLE_29' ? ['PROFILE_REJECT_29'] : marker === 'CYCLE_30' ? ['CRASH_30'] : [];
    const request = add(pid, 'request', at + 3, { inputIndex, outsideMemoryMarkers: [...history, marker], markers: [...history, marker], memoryMarkers: [],
      historyMarkers: history, currentRequestMarkers: [marker], preambleMarkers: [], historyBoundaryStatus: history.length ? 'EXACT' : 'ABSENT', historyHeaderCount: history.length ? 1 : 0, historyFooterCount: history.length ? 1 : 0,
      sessionHash, model, effort: 'low', policy, containsFixtureToken: true });
    const turnHash = sha('turn-' + inputIndex), begun = add(pid, 'turn-started', at + 4, { inputIndex, sessionHash, turnHash });
    if (text !== null) { add(pid, 'assistant-message', at + 5, { inputIndex, sessionHash, turnHash, itemIdHash: sha('item-' + inputIndex), itemType: 'agentMessage', phase: 'final_answer', textBytes: Buffer.byteLength(text), textSha256: sha(text) }); add(pid, 'turn-completed', at + 6, { inputIndex, sessionHash, turnHash, status: 'completed' }); }
    return { request, begun };
  }
  let fault;
  for (const definition of manifest.cycles) {
    const index = definition.index, base = epoch + index * 100000, at = base + (index === 29 ? 20 : index === 30 ? 30 : 0), pid = 5000 + index * 10;
    const conversationId = 'conversation-' + index, sessionHash = sha('thread-' + index), conversation = { id: conversationId, title: definition.marker, messages: [] }; stored.conversations.push(conversation);
    if (index) { observations.push({ event: 'reset-start', at: base - 10, cycle: index }, { event: 'reset-complete', at: base - 9, cycle: index, oldConversationId: 'conversation-' + (index - 1), newConversationId: conversationId });
      events.push({ type: 'conversationChanged', at: base - 9, payload: { id: conversationId } }, { type: 'sessionCleared', at: base - 9 }); end(5000 + (index - 1) * 10, base + 5); }
    if ([0, 27, 28].includes(index)) events.push({ type: 'modelChanged', at: at - 2, payload: { provider: 'openai-codex', model: definition.model } });
    if (index === 29) {
      const user = { id: 'profile-user', role: 'user', content: profilePrompt(token) }; conversation.messages.push(user); events.push({ type: 'messageAdded', at: base - 3, payload: user });
      start(9000, base - 6, manifest.profileValidation.missing.name); end(9000, base + 2, true);
      events.push({ type: 'error', at: base + 4, payload: PROFILE_ERROR });
      acceptance.profileRejection = { selectedAt: base - 7, started: base - 3, ended: base + 5, configRaw: manifest.profileValidation.missing.name,
        visibleError: 'Error: ' + PROFILE_ERROR, inputCountBefore: 29, inputCountAfter: 29 };
    }
    if (index === 30) {
      const user = { id: 'crash-user', role: 'user', content: crashPrompt(token) }; conversation.messages.push(user); events.push({ type: 'messageAdded', at: base + 2, payload: user });
      const crashed = send(8800, base, 31, 'CRASH_30', sessionHash, definition.model, null); end(8800, base + 6, false, 'SIGKILL');
      const target = Object.fromEntries(['pid', 'parentPid', 'groupPid', 'startedAt', 'executable'].map(key => [key, processMap.get(8800)[2][key]]));
      fault = { status: 'SIGNAL_ISSUED', signal: 'SIGKILL', signalIssuedAt: base + 5, target, request: { marker: 'CRASH_30', inputIndex: 31, wrapperPid: 8800, signal: 'SIGKILL' }, turnStarted: crashed.begun };
      events.push({ type: 'error', at: base + 10, payload: 'Codex was terminated while streaming; the answer is incomplete. A fresh process will spawn on the next message.' });
      acceptance.crashRecovery = { ended: base + 12, visibleError: true, busyStopped: true };
      snapshots.push({ event: 'snapshot', at: base + 1, rows: processMap.get(8800) }, { event: 'snapshot', at: base + 4, rows: processMap.get(8800) });
    }
    const inputIndex = index === 30 ? 32 : index + 1;
    const native = send(pid, at, inputIndex, definition.marker, sessionHash, definition.model, definition.expectedReply, index === 30 ? 'thread/resume' : 'thread/start');
    const user = { id: 'user-' + index, role: 'user', content: definition.prompt }, assistant = { id: 'reply-' + index, role: 'assistant', content: definition.expectedReply, model: definition.model, provider: 'openai-codex' };
    conversation.messages.push(user, assistant); events.push({ type: 'messageAdded', at: at + 2, payload: user }, { type: 'responseComplete', at: at + 8, payload: { message: assistant } });
    acceptance.cycles.push({ index, marker: definition.marker, conversationId, sessionHash, wrapperPid: pid, messageId: assistant.id, started: at, completedAt: at + 8 });
    snapshots.push({ event: 'snapshot', at: at + 7, rows: processMap.get(pid) });
    if (index) { observations.push({ event: 'old-process-exited', cycle: index, oldWrapperPid: 5000 + (index - 1) * 10, started: at + 9, snapshotAt: at + 10, at: at + 11 }); snapshots.push({ event: 'snapshot', at: at + 10, rows: processMap.get(pid) }); }
    if ([27, 28, 29].includes(index)) snapshots.push({ event: 'snapshot', at: base + 1,
      rows: [processMap.get(5000 + (index - 1) * 10)[2], processMap.get(index === 29 ? 9000 : pid)[2]] });
    if (index === 30) { end(pid, at + 100); observations.push({ event: 'final-tab-closed', at: at + 110, started: at + 90, accepted: true, absent: true, frameDetached: true }); }
  }
  wire.sort((a, b) => a.at - b.at); events.sort((a, b) => a.at - b.at); snapshots.sort((a, b) => a.at - b.at);
  return { manifest, acceptance, events, observations, wire, snapshots, fault, stored, processMap };
}
async function controls() {
  const directory = fs.mkdtempSync(path.join(root, 'codex-lifecycle-campaign-controls-')), checks = [];
  const check = (name, run) => { try { run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.message }); } };
  const reject = (name, mutate) => check(name, () => { const value = syntheticEvidence(); mutate(value); assert.throws(() => auditJourneyEvidence(value)); });
  check('Positive public DOM-shaped 30-reset, two-model, profile-rejection and crash recovery evidence', () => { const value = syntheticEvidence(); assert.equal(auditJourneyEvidence(value).status, 'PASS_BOUNDED_LIFECYCLE'); assert.equal(auditMainProcesses(value.wire, value.manifest).status, 'PASS_MAIN_TRANSPORT'); });
  for (const [name, change] of [
    ['Missing actual readiness model is rejected', v => { v.manifest.modelReadiness.models = v.manifest.modelReadiness.models.filter(row => row.id !== 'gpt-6.1-sol'); }],
    ['Alternate low effort must be observed in readiness', v => { v.manifest.modelReadiness.models.find(row => row.id === 'gpt-6.1-sol').supportedReasoningEfforts = []; }],
    ['29 resets cannot pass as30', v => { v.observations = v.observations.filter(row => !(row.event === 'reset-complete' && row.cycle === 30)); }],
    ['Reused durable conversation identity is rejected', v => { v.acceptance.cycles[2].conversationId = v.acceptance.cycles[1].conversationId; }],
    ['Reused native thread after public reset is rejected', v => { v.acceptance.cycles[2].sessionHash = v.acceptance.cycles[1].sessionHash; }],
    ['Old nonce marker replay across a new conversation is rejected', v => { v.wire.find(row => row.event === 'request' && row.inputIndex === 2).markers.push('CYCLE_00'); }],
    ['New conversation cannot resume the old native thread', v => { v.wire.find(row => row.event === 'session').method = 'thread/resume'; }],
    ['Crash recovery must resume its initialized thread', v => { v.wire.find(row => row.event === 'session' && row.wrapperPid === 5300).method = 'thread/start'; }],
    ['Requested alternate model cannot silently default', v => { v.wire.find(row => row.event === 'request' && row.inputIndex === 28).model = 'gpt-5.6-sol'; }],
    ['Model picker acknowledgement is required', v => { v.events = v.events.filter(row => !(row.type === 'modelChanged' && row.payload.model === 'gpt-6.1-sol')); }],
    ['Low effort cannot silently change', v => { v.wire.find(row => row.event === 'request').effort = 'high'; }],
    ['Read-only policy must remain exact', v => { v.wire.find(row => row.event === 'request').policy.sandbox = 'workspace-write'; }],
    ['Crash attempt uses the same bounded read-only policy', v => { v.wire.find(row => row.event === 'request' && row.inputIndex === 31).policy.sandbox = 'workspace-write'; }],
    ['All inherited effective external tools must be disabled by the actual request', v => { v.wire.find(row => row.event === 'effective-tool-config').mcpNames = [sha('extra')]; }],
    ['Returned native policy cannot grant network access', v => { v.wire.find(row => row.event === 'session').returnedPolicy.networkAccess = true; }],
    ['Native completed text must join public bytes', v => { v.wire.find(row => row.event === 'assistant-message').textSha256 = sha('changed'); }],
    ['Durable response bytes cannot diverge', v => { v.stored.conversations[0].messages[1] = { ...v.stored.conversations[0].messages[1], content: 'changed' }; }],
    ['Public profile error must retain the actual DOM Error prefix', v => { v.acceptance.profileRejection.visibleError = PROFILE_ERROR; }],
    ['Profile rejection cannot forward a hidden model turn', v => { v.wire.push({ event: 'request', wrapperPid: 9000, inputIndex: 33 }); }],
    ['Profile rejection requires the actual native signature', v => { v.wire.find(row => row.wrapperPid === 9000 && row.event === 'stderr-summary').runtimeOnlyProfileArgument = false; }],
    ['A successfully initialized named process is outside the pinned rejection contract', v => { v.wire.push({ event: 'rpc-result', wrapperPid: 9000, method: 'initialize', success: true }); }],
    ['Crash must be actually injected before coverage is credited', v => { v.fault.status = 'FAULT_NOT_INJECTED'; }],
    ['Interrupted work cannot acquire successful completion', v => { v.wire.push({ event: 'turn-completed', inputIndex: 31, status: 'completed' }); }],
    ['An automatic resend exceeds the exact32 bounded inputs', v => { v.wire.push({ ...v.wire.find(row => row.event === 'request'), inputIndex: 33 }); }],
    ['A foreign stored user cannot be hidden', v => { v.stored.conversations.push({ id: 'foreign', messages: [{ id: 'foreign-user', role: 'user', content: 'foreign' }] }); }],
    ['A public reset acknowledgement is required', v => { v.events = v.events.filter(row => !(row.type === 'sessionCleared' && row.at === v.observations.find(value => value.event === 'reset-complete').at)); }],
    ['Every prior process disappearance must join a real retained snapshot', v => { v.observations.find(row => row.event === 'old-process-exited').snapshotAt = 0; }],
    ['Prior process disappearance cannot exceed its bounded deadline', v => { v.observations.find(row => row.event === 'old-process-exited').at += 20_000; }],
    ['Final owned tab closure is required', v => { v.observations.find(row => row.event === 'final-tab-closed').accepted = false; }],
  ]) reject(name, change);
  for (const [inputIndex, marker] of [[30, 'PROFILE_REJECT_29'], [32, 'CRASH_30']]) {
    reject(`${marker}: failed same-conversation user must be retained as history`, v => { v.wire.find(row => row.event === 'request' && row.inputIndex === inputIndex).historyMarkers = []; });
    reject(`${marker}: failed request cannot become a current instruction`, v => { v.wire.find(row => row.event === 'request' && row.inputIndex === inputIndex).currentRequestMarkers.unshift(marker); });
    reject(`${marker}: earlier conversation cannot enter recovery history`, v => { v.wire.find(row => row.event === 'request' && row.inputIndex === inputIndex).historyMarkers.push('CYCLE_01'); });
    reject(`${marker}: duplicate history boundaries cannot pass metadata audit`, v => { v.wire.find(row => row.event === 'request' && row.inputIndex === inputIndex).historyHeaderCount = 2; });
  }
  check('Absent native overlap is honestly partial', () => { const v = syntheticEvidence(); v.snapshots = v.snapshots.filter(row => row.rows.length !== 2); const result = auditJourneyEvidence(v); assert.equal(result.status, 'PARTIAL_RACE_NOT_OBSERVED'); assert.equal(result.issues.length, 3); });
  check('Lingering wrappers alone cannot establish native cleanup overlap', () => { const v = syntheticEvidence(); for (const snapshot of v.snapshots.filter(row => row.rows.length === 2)) snapshot.rows = snapshot.rows.map(row => ({ ...row, executable: '/owned/node' })); assert.equal(auditJourneyEvidence(v).status, 'PARTIAL_RACE_NOT_OBSERVED'); });
  check('Overlap without cleanup before replacement success earns no race-survival credit', () => {
    const v = syntheticEvidence();
    for (const index of [27, 28, 29]) {
      const actual = v.acceptance.cycles[index], oldPid = v.acceptance.cycles[index - 1].wrapperPid;
      const start = v.observations.find(row => row.event === 'reset-start' && row.cycle === index);
      for (const snapshot of v.snapshots.filter(row => row.at >= start.at && row.at <= actual.completedAt)) {
        if (!snapshot.rows.some(row => row.wrapperPid === oldPid)) snapshot.rows = [...snapshot.rows, v.processMap.get(oldPid)[2]];
      }
      const own = v.wire.filter(row => row.wrapperPid === oldPid); own.find(row => row.event === 'stderr-summary').at = actual.completedAt + 1; own.find(row => row.event === 'exit').at = actual.completedAt + 2;
    }
    const result = auditJourneyEvidence(v); assert.equal(result.status, 'PARTIAL_RACE_NOT_OBSERVED'); assert.equal(result.resetCycles.completed, 30);
    assert.deepEqual(result.issues.map(row => row.code), Array(3).fill('CLEANUP_SURVIVAL_NOT_OBSERVED'));
  });
  check('A replacement wrapper without its native process cannot establish cleanup survival', () => {
    const v = syntheticEvidence();
    for (const index of [27, 28, 29]) { const actual = v.acceptance.cycles[index]; for (const snapshot of v.snapshots.filter(row => row.at === actual.completedAt - 1)) snapshot.rows = [v.processMap.get(actual.wrapperPid)[0]]; }
    const result = auditJourneyEvidence(v); assert.equal(result.status, 'PARTIAL_RACE_NOT_OBSERVED'); assert(result.races.every(row => row.survivedAt === undefined));
  });
  check('Actual incomplete error partial joins durable assistant content', () => {
    const v = syntheticEvidence(), error = v.events.find(row => row.type === 'error' && row.at >= v.fault.signalIssuedAt);
    const partial = { id: 'partial-crash', role: 'assistant', content: '1\n2', provider: 'openai-codex', model: 'gpt-5.6-sol' };
    error.payload = { error: error.payload, message: partial }; v.stored.conversations[30].messages.splice(1, 0, clean(partial)); assert.equal(auditJourneyEvidence(v).status, 'PASS_BOUNDED_LIFECYCLE');
    v.stored.conversations[30].messages[1].content = 'changed'; assert.throws(() => auditJourneyEvidence(v));
  });
  reject('A public crash partial cannot be omitted from durable storage', v => { const error = v.events.find(row => row.type === 'error' && row.at >= v.fault.signalIssuedAt); error.payload = { error: error.payload, message: { id: 'missing-partial', role: 'assistant', content: '1' } }; });
  check('Missing base process terminal metadata remains partial after separate process verification', () => { const v = syntheticEvidence(); v.wire = v.wire.filter(row => !(row.wrapperPid === 5300 && ['stderr-summary', 'exit'].includes(row.event))); assert.equal(auditMainProcesses(v.wire, v.manifest).status, 'PARTIAL_MAIN_SHUTDOWN'); });
  check('Missing named rejection terminal metadata remains a failure', () => { const v = syntheticEvidence(); v.wire = v.wire.filter(row => !(row.wrapperPid === 9000 && row.event === 'exit')); assert.throws(() => auditMainProcesses(v.wire, v.manifest)); });
  check('Launch binding never adopts a reused PID with a different birth', () => { const v = syntheticEvidence(), start = v.wire.find(row => row.event === 'start'); const rows = v.processMap.get(start.wrapperPid).map(row => ({ ...row, startedAt: '2026-10-12T00:00:00Z' })); assert(bindLaunch(start, rows).every(row => row.status === 'UNVERIFIED_AT_FIRST_OBSERVATION')); });
  check('Launch binding retains exact recorded births', () => { const v = syntheticEvidence(), start = v.wire.find(row => row.event === 'start'); assert(bindLaunch(start, v.processMap.get(start.wrapperPid)).every(row => !row.status)); });
  const faultArgs = () => { const v = syntheticEvidence(), ownRows = v.processMap.get(8800); return { request: v.fault.request, rows: ownRows, priorRows: ownRows,
    wire: v.wire.filter(row => row.at <= v.fault.signalIssuedAt), nativeBinary: '/owned/native/codex', boundIdentities: ownRows }; };
  check('Fault targets only the twice-observed bound native child', () => assert.equal(selectFaultTarget(faultArgs()).pid, 8802));
  for (const [name, change] of [
    ['Bare unbound PID cannot authorize a crash', v => { v.boundIdentities = []; }],
    ['Reused native PID cannot authorize a crash', v => { v.rows = v.rows.map(row => row.pid === 8802 ? { ...row, startedAt: '2026-10-12T00:00:00Z' } : row); }],
    ['A completed turn cannot be crashed', v => { v.wire.push({ event: 'turn-completed', wrapperPid: 8800, inputIndex: 31 }); }],
    ['A foreign native binary cannot authorize a crash', v => { v.rows = v.rows.map(row => row.pid === 8802 ? { ...row, executable: '/foreign/codex' } : row); }],
    ['A native process outside original child ancestry cannot be crashed', v => { v.rows = v.rows.map(row => row.pid === 8802 ? { ...row, parentPid: 9999 } : row); }],
    ['A process without its prior birth observation cannot be crashed', v => { v.priorRows = []; }],
  ]) check(name, () => { const v = faultArgs(); change(v); assert.throws(() => selectFaultTarget(v)); });
  check('New wrapper instrumentation fails closed if frozen source anchors change', () => assert.throws(() => instrumentMainRuntime('changed source')));
  check('New wrapper adds native text, launch-birth observations and pre-spawn argument guard', () => {
    const source = fs.readFileSync(require.resolve('./pb02-profile-compatibility-cli-runtime.cjs'), 'utf8'), generated = instrumentMainRuntime(source);
    const file = path.join(directory, 'instrumented-runtime.cjs'); fs.writeFileSync(file, generated, { flag: 'wx' }); execFileSync(process.execPath, ['--check', file]);
    assert(generated.includes('processBirths')); assert(generated.includes("event: 'assistant-message'")); assert(generated.includes('child.stdin.write(bytes)')); assert(generated.includes('child.stdout.pipe(process.stdout)'));
  });
  const asyncCheck = async (name, run) => { try { await run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.stack || error.message }); } };
  const backend = path.join(directory, 'synthetic-backend.cjs');
  fs.writeFileSync(backend, `const fs=require('node:fs');const [capture,output]=process.argv.slice(2);fs.writeFileSync(capture+'.spawn',JSON.stringify(process.argv.slice(4)),{flag:'wx'});process.on('SIGTERM',()=>process.exit(0));process.stdin.on('data',bytes=>fs.appendFileSync(capture,bytes));process.stdin.on('end',()=>{const bytes=fs.readFileSync(output);let i=0;function next(){if(i<bytes.length){process.stdout.write(bytes.subarray(i,++i));setImmediate(next);}}next();});`, { flag: 'wx' });
  const syntheticWrapper = label => {
    const owned = fs.mkdtempSync(path.join(directory, label + '-')), capture = path.join(owned, 'received'), output = path.join(owned, 'output'), counterFile = path.join(owned, 'counter.json');
    fs.writeFileSync(output, '', { flag: 'wx' });
    return { owned, capture, output, counterFile, ...createMainWrapper({ directory: owned, executable: process.execPath, node: process.execPath, prefixArgs: [backend, capture, output],
      workspace: owned, counterFile, token: 'CONTROL_OWNED', maxInputs: MAIN_CAP, profileValidation: { codeHome: owned, profiles: {}, missing: { name: 'unused', path: path.join(owned, 'unused.config.toml') } } }) };
  };
  const runSyntheticWrapper = (fixture, args = ['app-server']) => {
    const child = spawn(fixture.launcher, args, { stdio: ['pipe', 'pipe', 'pipe'] }), chunks = []; child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.resume(); child.stdin.on('error', () => {});
    const done = new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Owned synthetic wrapper deadline')); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(chunks), wire: receipts(fixture.receipts) }); }); });
    return { child, done };
  };
  await asyncCheck('Generated wrapper preserves real byte streams and records both launch births', async () => {
    const f = syntheticWrapper('wrapper-bytes'), text = 'Café مرحبا € 😀';
    const output = Buffer.from(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', phase: 'final_answer', text } } }) + '\n'); fs.writeFileSync(f.output, output);
    const input = Buffer.from(JSON.stringify({ id: 1, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'PB02_REQUEST:CYCLE_00 CONTROL_OWNED' }] } }) + '\n');
    const run = runSyntheticWrapper(f); for (const byte of input) run.child.stdin.write(Buffer.from([byte])); run.child.stdin.end(); const result = await run.done;
    assert.equal(result.code, 0); assert.deepEqual(result.stdout, output); assert.deepEqual(fs.readFileSync(f.capture), input);
    const start = one(result.wire.filter(row => row.event === 'start'), 'Actual generated wrapper start'); assert.deepEqual(start.processBirths.map(row => row.pid).sort((a, b) => a - b), [start.wrapperPid, start.childPid].sort((a, b) => a - b));
    const item = one(result.wire.filter(row => row.event === 'assistant-message'), 'Completed native text hash'); assert.equal(item.textSha256, sha(text)); assert.equal(item.textBytes, Buffer.byteLength(text)); assert.equal(item.inputIndex, 1);
    assert(!fs.readFileSync(f.receipts, 'utf8').includes(text));
  });
  for (const [marker, current] of [['PROFILE_REJECT_29', 'CYCLE_29'], ['CRASH_30', 'CYCLE_30']]) {
    await asyncCheck(`${marker}: actual controlled wrapper separates exact history from current request`, async () => {
      const header = 'The following is the conversation history for context only. Do not repeat or echo these messages in your response:\n\n', footer = '\n--- End of conversation history ---\n\n';
      const history = `${header}User: PB02_REQUEST:${marker}\nPrevious failed owned request\n${footer}`;
      for (const [index, prompt] of [history + `\n\nPB02_REQUEST:${current} CONTROL_OWNED`,
        history + header + `PB02_REQUEST:${current} CONTROL_OWNED`, history + footer + `PB02_REQUEST:${current} CONTROL_OWNED`,
        history + `PB02_REQUEST:${marker}\nPB02_REQUEST:${current} CONTROL_OWNED`].entries()) {
        const f = syntheticWrapper(`history-${marker}-${index}`), run = runSyntheticWrapper(f);
        const input = JSON.stringify({ id: 1, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: prompt }] } }) + '\n';
        run.child.stdin.end(input); const result = await run.done; assert.equal(result.code, 0); assert.equal(fs.readFileSync(f.capture, 'utf8'), input);
        const request = one(result.wire.filter(row => row.event === 'request'), 'One actual inspected recovery prompt');
        if (index === 0) assertRequestHistory(request, current, [marker]);
        else assert.throws(() => assertRequestHistory(request, current, [marker]));
        if (index === 1 || index === 2) assert.equal(request.historyBoundaryStatus, 'INVALID');
      }
    });
  }
  await asyncCheck('Generated wrapper forwards exactly32 inputs and refuses33 before child forwarding', async () => {
    const f = syntheticWrapper('wrapper-cap'), run = runSyntheticWrapper(f);
    const turn = index => JSON.stringify({ id: index, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: `PB02_REQUEST:CYCLE_${index} CONTROL_OWNED` }] } }) + '\n';
    const allowed = Array.from({ length: 32 }, (_, i) => turn(i + 1)).join(''); run.child.stdin.write(allowed);
    const until = Date.now() + 3000; while ((!fs.existsSync(f.capture) || fs.readFileSync(f.capture, 'utf8') !== allowed) && Date.now() < until) await sleep(10);
    assert.equal(fs.readFileSync(f.capture, 'utf8'), allowed); run.child.stdin.write(turn(33)); const result = await run.done;
    assert.equal(result.code, 1); assert.equal(fs.readFileSync(f.capture, 'utf8'), allowed); assert.deepEqual(read(f.counterFile), { forwardedInputs: 32, maxInputs: 32 }); assert.equal(result.wire.filter(row => row.event === 'request').length, 32);
    assert.equal(one(result.wire.filter(row => row.event === 'input-cap-refusal'), 'Actual pre-forward cap refusal').maxInputs, 32);
  });
  await asyncCheck('Exec and extra or foreign profile arguments refuse before any native child spawn', async () => {
    for (const [index, args] of [['exec'], ['app-server', '--dangerously-bypass-approvals-and-sandbox'], ['--profile', 'foreign', 'app-server'], ['--version', 'extra'], ['--profile', 'unused', 'app-server', 'extra']].entries()) {
      const f = syntheticWrapper('argv-refusal-' + index), run = runSyntheticWrapper(f, args); run.child.stdin.end('UNFORWARDED'); const result = await run.done;
      assert.equal(result.code, 1); assert(!fs.existsSync(f.capture + '.spawn')); assert(!fs.existsSync(f.capture)); assert(!fs.existsSync(f.counterFile)); assert.deepEqual(result.wire.map(row => row.event), ['invocation-refusal']);
      assert.deepEqual(result.wire[0].args, args);
    }
  });
  await asyncCheck('Exact owned missing profile and version probe preserve the authorized arguments', async () => {
    for (const [index, args] of [['--profile', 'unused', 'app-server'], ['--version']].entries()) {
      const f = syntheticWrapper('argv-allowed-' + index), run = runSyntheticWrapper(f, args); run.child.stdin.end(); const result = await run.done;
      assert.equal(result.code, 0); assert.deepEqual(read(f.capture + '.spawn'), args); assert.deepEqual(one(result.wire.filter(row => row.event === 'invocation'), 'Allowed invocation').args, args);
      assert(result.wire.some(row => row.event === (index ? 'probe-start' : 'start'))); assert(!fs.existsSync(f.counterFile));
    }
  });
  const observerControl = label => {
    const owned = fs.mkdtempSync(path.join(directory, label + '-')), ownerDirectory = path.join(owned, 'A'); fs.mkdirSync(ownerDirectory);
    const receipt = path.join(ownerDirectory, 'receipts.jsonl'); fs.writeFileSync(receipt, '', { flag: 'wx' });
    write(path.join(owned, 'prepared.json'), { stage: STAGE, windows: { A: { directory: ownerDirectory, receiptPaths: [receipt] } } }); return owned;
  };
  await asyncCheck('Real detached observer drains normally after an owned runner terminal', async () => {
    const owned = observerControl('normal'); await withOwnedObserver(owned, async () => write(path.join(owned, 'native-result.json'), { status: 'PASS' }));
    const drain = read(path.join(owned, 'external-observer-drain.json')); assert.equal(drain.status, 'PASS_OBSERVER_DRAIN'); assert.equal(read(path.join(owned, 'external-observer-complete.json')).status, 'OBSERVATION_COMPLETE');
    assert(!processRows().some(row => birthKey(row) === birthKey(drain.observerIdentity)));
  });
  await asyncCheck('Synchronous runner failure preserves the error and drains the real observer', async () => {
    const owned = observerControl('runner-throw'); await assert.rejects(withOwnedObserver(owned, async () => { throw Error('CONTROL_RUNNER_FAILURE'); }), /CONTROL_RUNNER_FAILURE/);
    const drain = read(path.join(owned, 'external-observer-drain.json')); assert.equal(drain.status, 'PASS_OBSERVER_DRAIN'); assert.equal(drain.runnerError, 'CONTROL_RUNNER_FAILURE');
    assert.equal(read(path.join(owned, 'external-observer-complete.json')).status, 'STOP_REQUESTED_UNFINISHED');
  });
  await asyncCheck('Fatal terminal before native-result drains the observer without inventing a result', async () => {
    const owned = observerControl('driver-fatal'); await assert.rejects(withOwnedObserver(owned, async () => { write(path.join(owned, 'driver-fatal.json'), { status: 'FAIL' }); throw Error('CONTROL_DRIVER_FATAL'); }), /CONTROL_DRIVER_FATAL/);
    assert.equal(read(path.join(owned, 'external-observer-drain.json')).status, 'PASS_OBSERVER_DRAIN'); assert(!fs.existsSync(path.join(owned, 'native-result.json')));
  });
  await asyncCheck('Ready timeout requests owned shutdown and leaves no polling observer', async () => {
    const owned = observerControl('ready-timeout'), file = path.join(owned, 'never-ready.cjs');
    fs.writeFileSync(file, `const fs=require('node:fs'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(owned, 'external-observer-stop.json'))})){clearInterval(timer);}},10);`, { flag: 'wx' });
    await assert.rejects(withOwnedObserver(owned, async () => { throw Error('MUST_NOT_RUN'); }, { args: [file], readyTimeoutMs: 200 }), /must be ready/);
    const drain = read(path.join(owned, 'external-observer-drain.json')); assert.equal(drain.status, 'PASS_OBSERVER_DRAIN'); assert(!processRows().some(row => birthKey(row) === birthKey(drain.observerIdentity)));
  });
  await asyncCheck('Hung owned observer is identity-checked and reclaimed while its failure remains FAIL', async () => {
    const owned = observerControl('hung'), file = path.join(owned, 'ignore-stop.cjs');
    fs.writeFileSync(file, `const fs=require('node:fs'),c=require(${JSON.stringify(__filename)}); fs.writeFileSync(${JSON.stringify(path.join(owned, 'external-observer-ready.json'))},JSON.stringify(c.processRows().find(r=>r.pid===process.pid)),{flag:'wx'});setInterval(()=>{},1000);`, { flag: 'wx' });
    await assert.rejects(withOwnedObserver(owned, async () => {}, { args: [file], drainTimeoutMs: 100 }), /did not drain normally/);
    const drain = read(path.join(owned, 'external-observer-drain.json')); assert.equal(drain.status, 'FAIL_OBSERVER_DRAIN'); assert.equal(drain.forced, true); assert.equal(drain.terminal.signal, 'SIGTERM'); assert.deepEqual(drain.remaining, []);
  });
  const report = { status: checks.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL', passed: checks.filter(row => row.status === 'PASS').length,
    failed: checks.filter(row => row.status === 'FAIL').length, checks, campaignIdentity: identity(__filename), editorLaunches: 0, inferenceInputs: 0,
    scope: 'Synthetic journey, native text, ownership, actual-event/disk projections, honest partial statuses and fault-target authorization; isolated real Node children test observer drain on success, failure, timeout and forced shutdown. Does not establish actual reset/race/crash coverage.' };
  write(path.join(directory, 'checks.json'), report); console.log(JSON.stringify({ directory, status: report.status, passed: report.passed, failed: report.failed, failures: checks.filter(row => row.status === 'FAIL') }));
  if (report.failed) process.exitCode = 1; return report;
}
Object.assign(module.exports, { syntheticEvidence, controls });
if (require.main === module) {
  const command = process.argv[2];
  (async () => {
    if (command === 'build') return build();
    if (command === 'controls') return controls();
    if (command === 'prepare') return prepare();
    const directory = fs.realpathSync(process.argv[3] || process.env[PREFIX + '_ARTIFACT_DIR']); contained(root, directory);
    if (command === 'run') return run(directory);
    if (command === 'observe') return observe(directory);
    if (command === 'audit') {
      const file = path.join(directory, `lifecycle-campaign-audit-${Date.now()}.json`);
      try { const result = audit(directory); write(file, result); console.log(JSON.stringify({ file, status: result.status, counts: result.counts })); return; }
      catch (error) { write(file, { status: 'FAIL', at: Date.now(), auditor: identity(__filename), error: error.message }); throw error; }
    }
    throw Error('Commands: build | controls | prepare | run <fresh-prepared-dir> | audit <dir>. Native run requires root review.');
  })().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
