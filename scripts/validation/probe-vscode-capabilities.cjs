/* PC-12 read-only readiness: versions/discovery only; no inference or auth bodies. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PC-12');
fs.mkdirSync(root, { recursive: true }); const directory = fs.mkdtempSync(path.join(root, 'readiness-'));
const definitions = [
  ['claude-code', 'claude', 'claude/ClaudeCodeProvider.ts', [path.join(os.homedir(), '.local/bin/claude')]],
  ['openai-codex', 'codex', 'codex/CodexProvider.ts', [path.join(repo, 'out-test/feature-tests/PC-02/mysti installer smoke-SGUtLy/openai-codex/bin/codex'), '/Applications/Codex.app/Contents/Resources/codex']],
  ['google-gemini', 'gemini', 'gemini/GeminiProvider.ts'], ['cline', 'cline', 'cline/ClineProvider.ts'],
  ['github-copilot', 'copilot', 'copilot/CopilotProvider.ts'], ['cursor', 'agent', 'cursor/CursorProvider.ts', [path.join(os.homedir(), '.local/bin/agent'), path.join(os.homedir(), '.local/bin/cursor-agent')]],
  ['openclaw', 'openclaw', 'openclaw/OpenClawProvider.ts'], ['opencode', 'opencode', 'opencode/OpenCodeProvider.ts'],
  ['ollama', 'ollama', 'ollama/OllamaProvider.ts'], ['localai', null, 'localai/LocalAIProvider.ts'],
  ['qwen-code', 'qwen', 'qwen/QwenCodeProvider.ts'], ['hermes', 'hermes', 'hermes/HermesProvider.ts'],
  ['continue', 'cn', 'continue/ContinueProvider.ts'], ['openrouter', null, 'openrouter/OpenRouterProvider.ts'],
  ['minimax', null, 'minimax/MiniMaxProvider.ts'], ['kimi-code', 'kimi', 'kimi/KimiCodeProvider.ts'],
];
const searchDirectories = [...new Set([...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin'), '/usr/local/bin', '/opt/homebrew/bin'])].filter(Boolean);
const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
function run(file, args, timeout = 12000) {
  return new Promise(resolve => {
    const child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', ended = false, timedOut = false;
    const collect = target => chunk => { if (target === 'out') stdout = (stdout + chunk).slice(0, 131072); else stderr = (stderr + chunk).slice(0, 131072); };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    const timer = setTimeout(() => { if (!ended) { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, timeout);
    const finish = result => { if (ended) return; ended = true; clearTimeout(timer); resolve({ ...result, timedOut, stdout, stderr }); };
    child.once('error', error => finish({ code: null, errorCode: error.code || 'SPAWN_ERROR' }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}
const digest = text => createHash('sha256').update(text).digest('hex');
const versionOnly = text => [...new Set((text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/g) || []))].slice(0, 6);
async function localDiscovery(url, kind) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const result = { endpoint: url, status: response.status, reachable: true, inferenceAttempted: false };
    const data = await response.json();
    if (kind === 'version' && typeof data.version === 'string') result.versions = versionOnly(data.version);
    if (kind === 'models') {
      const models = Array.isArray(data.models) ? data.models.map(value => value?.name) : Array.isArray(data.data) ? data.data.map(value => value?.id) : [];
      result.modelIds = models.filter(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:+-]{0,159}$/.test(value)).slice(0, 100);
    }
    return result;
  } catch (error) { return { endpoint: url, reachable: false, error: error.name, code: error.cause?.code, inferenceAttempted: false }; }
}
(async () => {
  const providers = [];
  for (const [id, command, relative, preferred = []] of definitions) {
    const source = fs.readFileSync(path.join(repo, 'src/providers', relative), 'utf8');
    assert(new RegExp('readonly\\s+id\\s*=\\s*[\'\"]' + id + '[\'\"]').test(source), 'Registry identity/source mismatch');
    const candidates = command ? [...new Set([...preferred, ...searchDirectories.map(directory => path.join(directory, command))])].filter(executable) : [];
    const record = { id, source: relative, command, executableCandidates: candidates, accountAndInference: 'NOT_PROVEN_BY_VERSION_OR_LOCAL_DISCOVERY' };
    if (candidates.length) {
      record.selectedExecutable = candidates[0]; const result = await run(candidates[0], ['--version']);
      record.versionProbe = { arguments: ['--version'], code: result.code, signal: result.signal, timedOut: result.timedOut, errorCode: result.errorCode,
        versions: versionOnly(result.stdout), stdoutSha256: digest(result.stdout), stderrSha256: digest(result.stderr), stderrBytes: Buffer.byteLength(result.stderr) };
      if (id === 'github-copilot') {
        const help = await run(candidates[0], ['--help']);
        const text = help.stdout + '\n' + help.stderr;
        record.readOnlyHelp = { code: help.code, timedOut: help.timedOut, sha256: digest(text),
          flags: ['--model', '--effort', '--output-format', '--allow-tool', '--deny-tool', '--resume'].filter(flag => text.includes(flag)),
          knownModelIdsMentioned: ['auto', 'claude-haiku-4.5', 'claude-sonnet-5', 'gpt-5.1', 'gpt-4.1', 'gpt-6-astra'].filter(model => text.includes(model)) };
      }
    } else { record.discovery = command ? 'NO_EXECUTABLE_IN_READ_ONLY_SEARCH' : 'HTTP_ADAPTER_NO_CLI'; }
    providers.push(record);
  }
  const registry = fs.readFileSync(path.join(repo, 'src/providers/ProviderRegistry.ts'), 'utf8');
  assert.equal((registry.match(/this\._providers\.set\(/g) || []).length - 1, 16, 'Sixteen concrete built-ins, excluding dynamic register');
  const local = await Promise.all([
    localDiscovery('http://127.0.0.1:11434/api/version', 'version'), localDiscovery('http://127.0.0.1:11434/api/tags', 'models'),
    localDiscovery('http://127.0.0.1:8080/v1/models', 'models'),
  ]);
  const evidence = { case: 'PC-12', status: 'READ_ONLY_READINESS_RECHECK', at: new Date().toISOString(), directory, providers, localDefaultEndpoints: local,
    credentialEnvironmentPresence: Object.fromEntries(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY', 'MINIMAX_API_KEY'].map(key => [key, !!process.env[key]])),
    inferenceInputs: 0, authFileBodiesRead: 0, historicalAccountOutcomesReused: false,
    limits: ['Presence/version is not authentication or paid inference readiness.', 'Local probes cover default loopback endpoints only; custom endpoints and secret storage were not inspected.', 'Version output is reduced to numeric versions and hashes; raw stdout/stderr and credentials are not saved.'] };
  fs.writeFileSync(path.join(directory, 'readiness.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
