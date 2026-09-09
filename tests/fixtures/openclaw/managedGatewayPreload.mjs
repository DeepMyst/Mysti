/** Mysti — SPDX-License-Identifier: Apache-2.0 */
// Fixture-only filesystem and loopback network boundary; never packaged as runtime policy.
// Missing ancestor packages and optional skills/binaries are recorded discovery probes.
// This observes the isolated fixture; it does not make the production runtime a filesystem sandbox.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const fixture = process.env.MYSTI_PROBE_ROOT;
const worktree = fileURLToPath(new URL("../../../", import.meta.url));
const installed = process.env.MYSTI_TEST_OPENCLAW_ROOT;
const append = fs.appendFileSync.bind(fs);
function evidence(entry) {
  append(path.join(fixture, "guard.jsonl"), JSON.stringify(entry) + "\n");
}
evidence({ runtimeProcess: { pid: process.pid, argv: process.argv.slice(1),
  snapshot: process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT, serviceMarker: process.env.OPENCLAW_SERVICE_MARKER ?? null } });
const readRoots = [fixture, worktree, installed, path.dirname(fs.realpathSync(process.execPath)),
  "/usr/local/Cellar/node", "/opt/homebrew/Cellar/node"].map((root) => path.resolve(root));
function checkFile(value, write = false) {
  if (typeof value === "number" || value == null) return;
  const file = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  if (!(write ? [fixture] : readRoots).some((root) => file === root || file.startsWith(root + path.sep))) {
    evidence({ blockedFile: file, write });
    const error = new Error("Isolated probe blocked external filesystem path");
    error.code = write ? "EACCES" : "ENOENT";
    throw error;
  }
}
for (const name of ["readFileSync", "readdirSync", "statSync", "lstatSync", "realpathSync", "accessSync", "existsSync", "openSync"]) {
  const original = fs[name];
  const wrapper = function(file, ...args) {
    try {
      checkFile(file, name === "openSync" && /[wa+]/.test(String(args[0])));
    } catch (error) {
      if (name === "existsSync") return false;
      throw error;
    }
    return original.call(this, file, ...args);
  };
  if (original.native) wrapper.native = function(file, ...args) {
    checkFile(file);
    return original.native.call(this, file, ...args);
  };
  fs[name] = wrapper;
}
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync"]) {
  const original = fs[name];
  fs[name] = function(file, ...args) {
    checkFile(file, true);
    return original.call(this, file, ...args);
  };
}
for (const name of ["readFile", "readdir", "stat", "lstat", "realpath", "access", "open"]) {
  const original = fs.promises[name];
  fs.promises[name] = async function(file, ...args) {
    checkFile(file, name === "open" && /[wa+]/.test(String(args[0])));
    return original.call(this, file, ...args);
  };
}
for (const name of ["writeFile", "appendFile", "mkdir", "rm", "unlink"]) {
  const original = fs.promises[name];
  fs.promises[name] = async function(file, ...args) {
    checkFile(file, true);
    return original.call(this, file, ...args);
  };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  let value = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof value === "object" ? value.host : typeof args[1] === "string" ? args[1] : "localhost";
  if (typeof value === "object" && value.path) {
    checkFile(value.path, true);
  } else if (host && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    evidence({ blockedNetwork: host });
    throw new Error("External network forbidden in managed runtime proof");
  }
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function(host, ...args) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    evidence({ blockedDns: host });
    throw new Error("External DNS forbidden");
  }
  return lookup.call(this, host, ...args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, ...args) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    evidence({ blockedFetch: url.hostname });
    throw new Error("External fetch forbidden");
  }
  return originalFetch.call(this, input, ...args);
};
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write;
  stream.write = function(chunk, ...args) {
    evidence({ output: String(chunk) });
    return write.call(this, chunk, ...args);
  };
}
syncBuiltinESMExports();
await import("../../../resources/openclaw-policy/runtime-preload.mjs");
