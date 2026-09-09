/** Mysti — SPDX-License-Identifier: Apache-2.0 */
// Actual installed gateway + native model/tool runner; model responses come only from this local fixture.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const require2 = createRequire(import.meta.url);
const { OpenClawManagedRuntime } = require2(path.join(process.env.MYSTI_TEST_BUNDLE_DIR, "OpenClawManagedRuntime.js"));
const { OpenClawPolicyBroker } = require2(path.join(process.env.MYSTI_TEST_BUNDLE_DIR, "OpenClawPolicyBroker.js"));
const { OpenClawGateway } = require2(path.join(process.env.MYSTI_TEST_BUNDLE_DIR, "OpenClawGateway.js"));
const worktree = fileURLToPath(new URL("../../../", import.meta.url));
const installedRoot = process.env.MYSTI_TEST_OPENCLAW_ROOT;
const fixture = process.env.MYSTI_PROBE_ROOT;
const workspace = path.join(fixture, "workspace");
await fs.mkdir(workspace, { recursive: true, mode: 448 });
let pluginPath = path.join(worktree, "resources/openclaw-policy");
const mode = process.argv[2] ?? "normal";
if (mode === "missing-admission") {
  const original = pluginPath;
  pluginPath = path.join(fixture, "missing-admission-plugin");
  await fs.mkdir(pluginPath);
  for (const filename of ["package.json", "openclaw.plugin.json"]) await fs.copyFile(path.join(original, filename), path.join(pluginPath, filename));
  const source = await fs.readFile(path.join(original, "index.mjs"), "utf8");
  assert(source.includes("api.on('before_agent_run', owner.admitRun);"));
  const altered = source.replace("api.on('before_agent_run', owner.admitRun);", "/* Fixture: missing admission hook */").replace(/from '\.\/([^']+)'/g, (_match, filename) => "from " + JSON.stringify(path.join(original, filename)));
  await fs.writeFile(path.join(pluginPath, "index.mjs"), altered);
}
const result = { startedAt: (/* @__PURE__ */ new Date()).toISOString(), fixture, nativeReady: false, policyReady: false, modelRequests: [], authorityRequests: [], cards: [], decisions: [], cases: [], pendingChecks: [] };
let scenario = "pipeline", step = 0;
const marker = (name) => path.join(workspace, name);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
if (mode === "gateway-crash") {
  await fs.writeFile(marker("crash-tool.mjs"), `import fs from 'node:fs';
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(marker("crash-started.json"))}, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker("crash-effect.txt"))}, 'escaped'); process.exit(0); }, 2000);
`);
}
const plans = {
  crash: [{ name: "exec", arguments: { command: `${quote(process.execPath)} ${quote(marker("crash-tool.mjs"))}`, yieldMs: 1e4 } }],
  pipeline: [
    { name: "write", arguments: { path: marker("approved.txt"), content: "before\n" } },
    { name: "edit", arguments: { path: marker("approved.txt"), edits: [{ oldText: "before", newText: "after" }] } },
    { name: "exec", arguments: { command: `printf inert-exec >> '${marker("exec.txt")}'`, yieldMs: 1e4 } },
    { name: "read", arguments: { path: marker("approved.txt") } }
  ],
  deny: [{ name: "write", arguments: { path: marker("denied.txt"), content: "should never exist" } }],
  readonly: [{ name: "write", arguments: { path: marker("readonly.txt"), content: "should never exist" } }],
  cancel: [{ name: "write", arguments: { path: marker("cancelled.txt"), content: "should never exist" } }],
  disconnect: [{ name: "write", arguments: { path: marker("disconnected.txt"), content: "should never exist" } }]
};
const model = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const tool = plans[scenario]?.[step++];
  result.modelRequests.push({ scenario, url: req.url, step, stream: body.stream, tools: body.tools?.map((t) => t.function?.name), toolResults: body.messages?.filter((message2) => message2.role === "tool").map((message2) => ({ id: message2.tool_call_id, content: message2.content })) });
  const message = tool ? { role: "assistant", content: null, tool_calls: [{ id: `call_${scenario}_${step}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: "assistant", content: "Inert fixture complete." };
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const delta = tool ? { role: "assistant", tool_calls: message.tool_calls.map((t, index) => ({ ...t, index })) } : message;
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }]) res.write("data: " + JSON.stringify({ id: "chatcmpl-inert", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1e3), model: "fixture", choices: [choice] }) + "\n\n");
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "chatcmpl-inert", object: "chat.completion", created: Math.floor(Date.now() / 1e3), model: "fixture", choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const broker = new OpenClawPolicyBroker({ version: "2026.6.34", targetHash: "2f8ba157e5660c32b85826eb3269a59b8add55062e31ed3d6d1528dd1017ad4b" });
const lifetime = new AbortController();
let runtime, gateway;
async function send(message, options) {
  const chunks = [];
  for await (const chunk of gateway.sendAgentMessage(message, options)) {
    chunks.push(chunk);
  }
  return chunks;
}
async function exists(name) {
  try {
    await fs.access(marker(name));
    return true;
  } catch {
    return false;
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await pause(10);
  }
  throw new Error("Native fixture did not settle before deadline");
}
async function waitForCard(promise) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(new Error("No pending native approval card")), 15e3))]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const credentials = await broker.listen();
  runtime = await OpenClawManagedRuntime.start({
    cliPath: path.join(installedRoot, "openclaw.mjs"),
    installedRoot,
    storageDir: path.join(fixture, "storage"),
    workspaceDir: workspace,
    pluginPath,
    preloadPath: path.join(worktree, "tests/fixtures/openclaw/managedGatewayPreload.mjs"),
    broker: credentials,
    signal: lifetime.signal,
    startupTimeoutMs: 45e3,
    baseConfig: { agents: { defaults: { model: "mysti-inert/fixture" } }, models: { providers: { "mysti-inert": {
      api: "openai-completions",
      apiKey: "inert-no-credential",
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      request: { allowPrivateNetwork: true },
      models: [{ id: "fixture", name: "Inert fixture", reasoning: false, input: ["text"], contextWindow: 128e3, maxTokens: 4096 }]
    } } } }
  });
  result.nativeReady = true;
  if (mode === "missing-admission") {
    await assert.rejects(broker.waitUntilReady(lifetime.signal, 1e3), /did not become ready/);
    assert.equal(result.modelRequests.length, 0);
    result.cases.push({ name: "missing admission prevents broker readiness" });
    result.passed = true;
  } else {
    await broker.waitUntilReady(lifetime.signal, 15e3);
    result.policyReady = true;
    gateway = new OpenClawGateway(runtime.gatewayUrl, runtime.token, { ownedRuntime: true });
    assert.equal(await gateway.connect(), true);
    if (mode === "gateway-crash") {
      scenario = "crash";
      step = 0;
      const runId = "mysti-" + randomUUID(), sessionKey = "agent:main:mysti-crash";
      const handler = async (request) => {
        result.authorityRequests.push({ scenario, id: request.id, toolCall: request.toolCall, defaultDecision: request.defaultDecision });
        if (request.defaultDecision === "ask") result.cards.push({ scenario, id: request.id, toolCall: request.toolCall });
        return true;
      };
      handler.onDecision = (request, decision) => result.decisions.push({ scenario, tool: request.toolCall.name, decision });
      const lease = await broker.openRun({ runId, sessionKey, panelId: "inert-panel",
        settings: { mode: "ask-before-edit", accessLevel: "ask-permission" }, signal: lifetime.signal,
        handler, isCurrent: () => !lifetime.signal.aborted });
      const final = send("Perform inert foreground exec crash fixture.", { sessionKey, runId, signal: lease.signal, timeoutMs: 15000 });
      try {
        await eventually(() => exists("crash-started.json"));
        const child = JSON.parse(await fs.readFile(marker("crash-started.json"), "utf8"));
        const io = (await fs.readFile(path.join(fixture, "guard.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        const gateways = io.filter((entry) => entry.runtimeProcess?.argv?.[1] === "gateway" && entry.runtimeProcess.argv[2] === "run");
        assert.equal(gateways.length, 1);
        const gatewayPid = gateways[0].runtimeProcess.pid;
        assert.equal(gateways[0].runtimeProcess.snapshot, "0");
        assert.equal(gateways[0].runtimeProcess.serviceMarker, null, "Service marker must be activated after the CLI stale-process scan");
        const group = (pid) => Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
        assert.equal(group(gatewayPid), gatewayPid);
        assert.equal(group(child.pid), gatewayPid, "Actual native foreground exec must remain in the owned gateway group");
        assert.deepEqual(result.decisions, [{ scenario: "crash", tool: "exec", decision: "allow" }]);
        process.kill(gatewayPid, 0);
        process.kill(gatewayPid, "SIGKILL");
        const response = await final;
        await eventually(async () => (await fs.readdir(path.join(fixture, "storage"))).length === 0, 5000);
        await pause(Math.max(0, child.startedAt + 2400 - Date.now()));
        assert.equal(await exists("crash-effect.txt"), false);
        result.cases.push({ name: "gateway crash kills approved foreground exec", gatewayPid, toolPid: child.pid,
          gatewayGroup: gatewayPid, toolGroup: gatewayPid, delayedEffectAbsent: true, privateStateRemoved: true, result: response });
      } finally {
        lease.dispose();
        await final;
      }
    } else {
    const noLease = await send("Inert no-lease check", { sessionKey: "agent:main:mysti-no-lease", runId: "mysti-" + randomUUID(), timeoutMs: 15e3 });
    assert.equal(result.modelRequests.length, 0);
    assert(!JSON.stringify(noLease).includes("missing scope"));
    result.cases.push({ name: "missing lease blocks before model", result: noLease });
    for (const name of ["pipeline", "deny", "readonly", "cancel", "disconnect"]) {
      scenario = name;
      step = 0;
      const runId = "mysti-" + randomUUID(), sessionKey = "agent:main:mysti-" + name;
      const controller = new AbortController();
      let cardResolve, enteredResolve;
      const entered = new Promise((resolve) => enteredResolve = resolve);
      const handler = async (request) => {
        result.authorityRequests.push({ scenario: name, id: request.id, toolCall: request.toolCall, defaultDecision: request.defaultDecision });
        if (request.defaultDecision === "ask") {
          result.cards.push({ scenario: name, id: request.id, toolCall: request.toolCall, defaultDecision: request.defaultDecision });
          enteredResolve();
        }
        if (name === "readonly") throw new Error("Read-only policy must not open a card");
        if (name === "pipeline" && request.toolCall.name === "write") {
          assert.equal(await exists("approved.txt"), false);
          await pause(50);
          assert.equal(await exists("approved.txt"), false);
          result.pendingChecks.push("write absent while card pending");
        }
        if (name === "pipeline" && request.toolCall.name === "exec") {
          assert.equal(await exists("exec.txt"), false);
          await pause(50);
          assert.equal(await exists("exec.txt"), false);
          result.pendingChecks.push("exec absent while card pending");
        }
        if (name === "cancel" || name === "disconnect") return new Promise((resolve) => cardResolve = resolve);
        return name !== "deny";
      };
      handler.onDecision = (request, decision) => result.decisions.push({ scenario: name, tool: request.toolCall.name, decision });
      const lease = await broker.openRun({ runId, sessionKey, panelId: "inert-panel", settings: { mode: "ask-before-edit", accessLevel: name === "readonly" ? "read-only" : "ask-permission" }, signal: controller.signal, handler, isCurrent: () => !controller.signal.aborted });
      const final = send(`Perform inert fixture ${name}.`, { sessionKey, runId, signal: lease.signal, timeoutMs: 35e3, hasPending: () => lease.hasPending, onPendingChanged: (listener) => lease.onPendingChanged(listener) });
      if (name === "cancel" || name === "disconnect") {
        await waitForCard(entered);
        if (name === "cancel") controller.abort();
        else broker.dispose();
        gateway.cancelSession(sessionKey);
        cardResolve(true);
      }
      const response = await final;
      lease.dispose();
      result.cases.push({ name, result: response });
      if (name === "pipeline") {
        assert.equal(await fs.readFile(marker("approved.txt"), "utf8"), "after\n");
        assert.equal(await fs.readFile(marker("exec.txt"), "utf8"), "inert-exec");
        assert.deepEqual(result.cards.filter((card) => card.scenario === name).map((card) => card.toolCall.name), ["write", "edit", "exec"]);
        assert(result.modelRequests.some((request) => request.scenario === name && request.toolResults?.some((tool) => tool.content === "after\n")));
      } else {
        await pause(50);
        assert.equal(await exists(name === "deny" ? "denied.txt" : name === "readonly" ? "readonly.txt" : name === "cancel" ? "cancelled.txt" : "disconnected.txt"), false);
      }
    }
    }
    result.passed = true;
  }
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  lifetime.abort();
  gateway?.disconnect();
  await runtime?.dispose();
  broker.dispose();
  await new Promise((resolve) => model.close(resolve));
  result.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
  await fs.writeFile(path.join(fixture, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, error: result.error, modelRequests: result.modelRequests.length, cards: result.cards.length, cases: result.cases.map((x) => x.name) }));
}
