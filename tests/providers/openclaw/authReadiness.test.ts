import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async original => {
  const actual = await original<typeof import('os')>();
  const homedir = () => fixture.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});
import { TestableOpenClawProvider } from '../../helpers/providerFactory';

const environmentKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME',
  'OPENCLAW_AGENT_DIR', 'OPENCLAW_TEST_FAST', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR',
  'PI_CODING_AGENT_DIR', 'OPENCLAW_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
const providers: TestableOpenClawProvider[] = [];
let root: string;
const agentDir = () => path.join(fixture.home, '.openclaw/agents/main/agent');
function write(name: string, data: unknown) {
  fs.mkdirSync(agentDir(), { recursive: true });
  fs.writeFileSync(path.join(agentDir(), name), JSON.stringify(data));
}
function provider() { const p = new TestableOpenClawProvider(); providers.push(p); return p; }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-auth-'));
  fixture.home = root;
  for (const key of environmentKeys) vi.stubEnv(key, '');
});
afterEach(() => {
  providers.splice(0).forEach(p => p.dispose());
  vi.unstubAllEnvs(); fixture.home = '';
  fs.rmSync(root, { recursive: true, force: true });
});

const key = { type: 'api_key', provider: 'anthropic', key: 'synthetic-key' };
const reference = { source: 'env', provider: 'default', id: 'OWNED_TEST_SECRET' };
// These are configured-credential checks. No references are resolved, no login
// is refreshed and no service entitlement is inferred from a passing fixture.
const credentials: Array<[string, unknown, boolean]> = [
  ['API key', key, true],
  ['legacy API key aliases', { mode: 'apiKey', provider: 'anthropic', apiKey: 'synthetic-key' }, true],
  ['API key reference', { type: 'api_key', provider: 'anthropic', keyRef: reference }, true],
  ['inline key reference', { type: 'api_key', provider: 'anthropic', key: reference }, true],
  ['legacy key reference', { type: 'api_key', provider: 'anthropic', keyRef: { source: 'file', id: '/owned/key' } }, true],
  ['exec key reference', { type: 'api_key', provider: 'anthropic', keyRef: { source: 'exec', provider: 'owned', id: 'key' } }, true],
  ...['$OWNED_TEST_SECRET', '${OWNED_TEST_SECRET}', 'secretref-env:OWNED_TEST_SECRET', '__env__:OWNED_TEST_SECRET']
    .map(ref => [`reference ${ref}`, { type: 'api_key', provider: 'anthropic', keyRef: ref }, true] as [string, unknown, boolean]),
  ['static token', { type: 'token', provider: 'anthropic', token: 'synthetic-token' }, true],
  ['token reference', { type: 'token', provider: 'anthropic', tokenRef: reference }, true],
  ['inline token reference', { type: 'token', provider: 'anthropic', token: reference }, true],
  ['future token expiry', { type: 'token', provider: 'anthropic', token: 'synthetic-token', expires: 8e15 }, true],
  ['OAuth access', { type: 'oauth', provider: 'anthropic', access: 'synthetic-access' }, true],
  ['refreshable OAuth', { type: 'oauth', provider: 'anthropic', access: 'old-access', refresh: 'synthetic-refresh', expires: 1 }, true],
  ['OAuth refresh only', { type: 'oauth', provider: 'anthropic', refresh: 'synthetic-refresh' }, true],
  ['empty entry', {}, false],
  ['array entry', [key], false],
  ['null entry', null, false],
  ['string entry', 'synthetic-key', false],
  ['missing provider', { type: 'api_key', key: 'synthetic-key' }, false],
  ['blank provider', { ...key, provider: '  ' }, false],
  ['unknown type', { ...key, type: 'unknown' }, false],
  ['type does not fall back when present', { ...key, type: null, mode: 'api_key' }, false],
  ['missing key', { type: 'api_key', provider: 'anthropic' }, false],
  ['blank key', { ...key, key: ' \n\t' }, false],
  ['object key', { ...key, key: { value: 'synthetic-key' } }, false],
  ['explicit empty key overrides alias', { ...key, key: '', apiKey: 'synthetic-alias' }, false],
  ['onboarding command pasted as key', { ...key, key: 'openclaw onboard --auth-choice apiKey' }, false],
  ['missing token', { type: 'token', provider: 'anthropic' }, false],
  ['blank token', { type: 'token', provider: 'anthropic', token: '   ' }, false],
  ...[1, 0, -1, null, '8000000000000000', 9e15].map(expires => [
    `invalid/expired token ${expires}`, { type: 'token', provider: 'anthropic', token: 'synthetic-token', expires }, false,
  ] as [string, unknown, boolean]),
  ['missing OAuth material', { type: 'oauth', provider: 'anthropic' }, false],
  ['blank OAuth material', { type: 'oauth', provider: 'anthropic', access: ' ', refresh: '\t' }, false],
  ['OAuth metadata only', { type: 'oauth', provider: 'anthropic', email: 'owned@example.invalid', accountId: 'owned' }, false],
  ['unresolved legacy OAuth reference', { type: 'oauth', provider: 'openai-codex', oauthRef: {
    source: 'openclaw-credentials', provider: 'openai-codex', id: 'a'.repeat(32),
  } }, false],
  ['arbitrary reference string', { type: 'api_key', provider: 'anthropic', keyRef: 'not-a-reference' }, false],
  ['invalid reference source', { type: 'token', provider: 'anthropic', tokenRef: { ...reference, source: 'https' } }, false],
  ['array reference source', { type: 'token', provider: 'anthropic', tokenRef: { ...reference, source: ['env'] } }, false],
  ['empty reference id', { type: 'api_key', provider: 'anthropic', keyRef: { ...reference, id: ' ' } }, false],
  ['empty reference provider', { type: 'api_key', provider: 'anthropic', keyRef: { ...reference, provider: '' } }, false],
  ['extra canonical reference property', { type: 'api_key', provider: 'anthropic', keyRef: { ...reference, extra: true } }, false],
];

describe.each(['auth-profiles.json', 'auth.json'])('OpenClaw %s credential readiness', file => {
  it.each(credentials)('%s', async (_name, credential, expected) => {
    const entries = { 'anthropic:owned': credential };
    write(file, file === 'auth-profiles.json' ? { version: 1, profiles: entries } : entries);
    const p = provider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(expected);
    expect((await p.checkAuthentication()).authenticated).toBe(expected);
  });
  it.each([null, [], [key], { version: 1 }, { order: { anthropic: ['owned'] }, lastGood: { anthropic: 'owned' } }])(
    'rejects metadata/malformed root %j', async data => {
      write(file, data);
      expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
    });
  it('recovers on the same provider after malformed JSON is replaced', async () => {
    write(file, {}); fs.writeFileSync(path.join(agentDir(), file), '{ invalid');
    const p = provider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    const entries = { 'anthropic:owned': key };
    write(file, file === 'auth-profiles.json' ? { profiles: entries } : entries);
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  });
});

it.each([null, [], [key], 'bad', 1])('rejects malformed profiles %j', async profiles => {
  write('auth-profiles.json', { version: 1, profiles });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it('does not treat a modern envelope in the legacy file as credential entries', async () => {
  write('auth.json', { profiles: { owned: key } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it('does not interpret a legacy map as a modern profile store', async () => {
  write('auth-profiles.json', { anthropic: key });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it('keeps a valid profile among invalid entries', async () => {
  write('auth-profiles.json', { profiles: { missing: {}, bad: null, valid: key } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});
it('uses valid legacy credentials when the modern file is malformed', async () => {
  write('auth-profiles.json', { version: 1 }); write('auth.json', { anthropic: key });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});
it('does not infer readiness from config or channel pairing files', async () => {
  const state = path.join(root, '.openclaw'); fs.mkdirSync(path.join(state, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(state, 'openclaw.json'), '{ email: "owned@example.invalid" }');
  fs.writeFileSync(path.join(state, 'credentials/channel.json'), JSON.stringify({ token: 'synthetic-channel' }));
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it.each(['OPENCLAW_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'])(
  'requires nonblank %s and rechecks after a change', async name => {
    vi.stubEnv(name, ' \n\t'); const p = provider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    vi.stubEnv(name, 'synthetic-environment-credential');
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    vi.stubEnv(name, ''); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  });
