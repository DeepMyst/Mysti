import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TestableCopilotProvider } from '../../helpers/providerFactory';

describe('Copilot persisted login formats', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-copilot-login-'));
    vi.stubEnv('COPILOT_HOME', home);
    vi.stubEnv('GH_TOKEN', ''); vi.stubEnv('GITHUB_TOKEN', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });
  const write = (name: string, data: string) => fs.writeFileSync(path.join(home, name), data);
  async function authenticatedAs(login: string): Promise<void> {
    const provider = new TestableCopilotProvider();
    expect((await provider.getAuthConfig()).isAuthenticated).toBe(true);
    expect(await provider.checkAuthentication()).toEqual({ authenticated: true, user: `GitHub (${login})` });
  }
  async function unauthenticated(): Promise<void> {
    const provider = new TestableCopilotProvider();
    expect((await provider.getAuthConfig()).isAuthenticated).toBe(false);
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
  }
  it('recognizes current camelCase identities in strict JSON', async () => {
    write('config.json', JSON.stringify({ loggedInUsers: [{ host: 'https://github.com', login: 'current-user' }] }));
    await authenticatedAs('current-user');
  });
  it('reads current commented config and prefers the last selected identity', async () => {
    write('config.json', '// Copilot configuration\n{\n"loggedInUsers":[{"login":"first-user"}],\n/* selected */ "lastLoggedInUser":{"host":"https://github.com","login":"selected-user"},\n}');
    await authenticatedAs('selected-user');
  });
  it('keeps legacy snake_case identities compatible', async () => {
    write('config.json', JSON.stringify({ logged_in_users: [{ login: 'older-user' }], last_logged_in_user: { login: 'older-selected' } }));
    await authenticatedAs('older-selected');
  });
  it('does not treat comments or setup fields as authentication', async () => {
    write('config.json', '// pre-login scaffold\n{"askedSetupTerminals":true,"trustedFolders":[]}');
    await unauthenticated();
  });
  it.each(['null', '[]', '"text"', '{"loggedInUsers":[{},null,{"login":42},{"login":" "}]}', '{"logged_in_users":[{}]}'])
    ('requires an actual non-empty identity in %s', async data => { write('config.json', data); await unauthenticated(); });
  it('does not claim authentication for malformed JSON or leak the parse input', async () => {
    write('config.json', '{"privateFixtureValue":"DO_NOT_ECHO",');
    await unauthenticated();
    const status = await new TestableCopilotProvider().checkAuthentication();
    expect(status.error).toContain('Could not read Copilot login state');
    expect(status.error).not.toContain('DO_NOT_ECHO');
  });
  it('continues to a valid settings identity when config is unreadable', async () => {
    fs.mkdirSync(path.join(home, 'config.json'));
    write('settings.json', JSON.stringify({ lastLoggedInUser: { login: 'settings-user' } }));
    await authenticatedAs('settings-user');
  });
  it('does not report an unreadable config directory as logged in', async () => {
    fs.mkdirSync(path.join(home, 'config.json')); await unauthenticated();
  });
  it('continues past invalid markers to a valid login', async () => {
    write('config.json', JSON.stringify({ lastLoggedInUser: { login: 42 }, loggedInUsers: [null, {}, { login: 'valid-user' }] }));
    await authenticatedAs('valid-user');
  });
  it.each(['GH_TOKEN', 'GITHUB_TOKEN'])('retains %s authentication when local config is malformed', async name => {
    vi.stubEnv(name, 'owned-test-token'); write('config.json', '{');
    const provider = new TestableCopilotProvider();
    expect(await provider.getAuthConfig()).toMatchObject({ type: 'api-key', isAuthenticated: true });
    expect(await provider.checkAuthentication()).toEqual({ authenticated: true, user: `GitHub Token (${name})` });
  });
  it('reports absent login state without creating config files', async () => {
    await unauthenticated(); expect(fs.readdirSync(home)).toEqual([]);
  });
});
