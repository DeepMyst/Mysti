import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { readOpenClawDiagnosticProfiles } from '../../../src/providers/openclaw/OpenClawAuthStore';
import { openClawBackendRedactor } from '../../../src/providers/openclaw/OpenClawBackendDiagnostics';

const snapshot = (root: string): Record<string, string> => Object.fromEntries(fs.readdirSync(root, { recursive: true })
  .map(p => String(p)).filter(p => fs.statSync(path.join(root, p)).isFile()).map(p => [p, fs.readFileSync(path.join(root, p)).toString('base64')]));
const writeStore = (dir: string, profile: unknown) => {
  const db = new DatabaseSync(path.join(dir, 'openclaw-agent.sqlite'));
  try { db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL)'); db.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run('primary', JSON.stringify({ profiles: { shared: profile } })); }
  finally { db.close(); }
};

it('protects main and agent credentials across both store formats, including shadowed and retired values, without writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-profile-diagnostics-'));
  try {
    const main = path.join(root, 'main'), local = path.join(root, 'local'); fs.mkdirSync(main); fs.mkdirSync(local);
    const keys: string[] = [];
    for (const [label, dir] of [['main', main], ['local', local]]) {
      const key = `owned-${label}-sqlite-key`, jsonKey = `owned-${label}-json-key`, oldKey = `owned-${label}-retired-key`; keys.push(key, jsonKey, oldKey);
      writeStore(dir, { provider: 'owned', type: 'api_key', key });
      fs.writeFileSync(path.join(dir, 'auth-profiles.json'), JSON.stringify({ profiles: { shared: { provider: 'owned', type: 'token', token: jsonKey, expires: 1 } } }));
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ owned: { provider: 'owned', type: 'apiKey', apiKey: oldKey } }));
    }
    const before = snapshot(root), profiles = await readOpenClawDiagnosticProfiles(local, main);
    expect(profiles).toHaveLength(6); const redact = openClawBackendRedactor({}, {}, profiles);
    expect(redact(keys.join(' '))).toBe(keys.map(() => '[REDACTED]').join(' '));
    expect(snapshot(root)).toEqual(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('preserves diagnostic protection for OAuth and allowed environment refs without treating account metadata as secret', async () => {
  const profiles = [
    { type: 'oauth', provider: 'owned', access: 'owned-expired-access', refresh: 'owned-refresh-value', expires: 1, email: 'public@example.invalid' },
    { type: 'api_key', provider: 'owned', keyRef: { source: 'env', id: 'OWNED_VALUE' } },
    { type: 'token', provider: 'owned', tokenRef: { source: 'file', id: '/owned/no-read' } },
  ];
  const redact = openClawBackendRedactor({}, { OWNED_VALUE: 'owned-env-reference-value' }, profiles);
  expect(redact('owned-expired-access owned-refresh-value owned-env-reference-value public@example.invalid /owned/no-read'))
    .toBe('[REDACTED] [REDACTED] [REDACTED] public@example.invalid /owned/no-read');
});

it('does not create, repair, or mutate missing and malformed stores', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-profile-diagnostics-'));
  try {
    const missing = path.join(root, 'missing');
    fs.writeFileSync(path.join(root, 'openclaw-agent.sqlite'), 'owned malformed database');
    fs.writeFileSync(path.join(root, 'auth-profiles.json'), '{invalid');
    const before = snapshot(root);
    expect(await readOpenClawDiagnosticProfiles(root, missing)).toEqual([]);
    expect(snapshot(root)).toEqual(before); expect(fs.existsSync(missing)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('reads a shared main/agent directory once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-profile-diagnostics-'));
  try {
    fs.writeFileSync(path.join(root, 'auth-profiles.json'), JSON.stringify({ profiles: { owned: { provider: 'owned', type: 'api_key', key: 'owned-key' } } }));
    expect(await readOpenClawDiagnosticProfiles(root, root)).toHaveLength(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
