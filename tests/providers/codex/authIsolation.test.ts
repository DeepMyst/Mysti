import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async () => ({ ...await vi.importActual<any>('os'), homedir: () => fixture.home }));
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners } from '../../helpers/mockVscode';

let directory = '';
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-auth-profile-'));
  fixture.home = directory; vi.stubEnv('OPENAI_API_KEY', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs(); clearConfigurationListeners();
  fs.rmSync(directory, { recursive: true, force: true });
});
function writeLogin(home: string) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-fixture-token' } }));
}

describe('PC-03 Codex authentication follows the selected CLI home', () => {
  it('does not borrow the default-profile login for an explicitly signed-out profile', async () => {
    writeLogin(path.join(directory, '.codex'));
    vi.stubEnv('CODEX_HOME', path.join(directory, 'signed-out profile'));
    const provider = new TestableCodexProvider();
    expect((await provider.getAuthConfig()).isAuthenticated).toBe(false);
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
    provider.dispose();
  });

  it('recognizes the selected profile login when the default profile is signed out', async () => {
    const selected = path.join(directory, 'signed-in profile'); writeLogin(selected);
    vi.stubEnv('CODEX_HOME', selected);
    const provider = new TestableCodexProvider();
    expect(await provider.getAuthConfig()).toMatchObject({ isAuthenticated: true, configPath: path.join(selected, 'auth.json') });
    expect((await provider.checkAuthentication()).authenticated).toBe(true);
    provider.dispose();
  });
});
