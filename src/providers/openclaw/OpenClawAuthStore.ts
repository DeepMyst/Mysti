/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs';
import * as path from 'path';
import { getOpenClawStoredProfiles, hasOpenClawStoredCredentials } from './OpenClawAuth';
import type { OpenClawStoreFormat } from './OpenClawStoreFormat';

export interface OpenClawAuthStore {
  profiles: Record<string, unknown>;
  order: Record<string, string[]>;
}

function orderFrom(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
  const order = (value as Record<string, unknown>).order;
  if (!order || typeof order !== 'object' || Array.isArray(order)) { return {}; }
  return Object.fromEntries(Object.entries(order).flatMap(([provider, ids]) => {
    const names = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(Boolean))] : [];
    return provider.trim() && names.length ? [[provider.trim().toLowerCase(), names]] : [];
  }));
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return undefined; }
}

async function readSqliteStore(file: string): Promise<unknown> {
  let database: import('node:sqlite').DatabaseSync | undefined;
  try {
    // Optional on older extension hosts. Never create/migrate a native store or
    // import OpenClaw's runtime (which can refresh credentials and run plugins).
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(file, { readOnly: true });
    const row = database.prepare('SELECT store_json FROM auth_profile_store WHERE store_key = ?').get('primary');
    const value = typeof row?.store_json === 'string' ? JSON.parse(row.store_json) : undefined;
    let state: unknown;
    try {
      const row = database.prepare('SELECT state_json FROM auth_profile_state WHERE state_key = ?').get('primary');
      state = typeof row?.state_json === 'string' ? JSON.parse(row.state_json) : undefined;
    } catch { /* Older databases may not have a separate runtime-state table. */ }
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, order: { ...orderFrom(value), ...orderFrom(state) } } : value;
  } catch {
    return undefined;
  } finally { database?.close(); }
}

async function readStore(agentDir: string, format: OpenClawStoreFormat): Promise<OpenClawAuthStore> {
  const databasePath = path.join(agentDir, 'openclaw-agent.sqlite');
  if (format === 'sqlite' || (format === 'unknown' && fs.existsSync(databasePath))) {
    // A SQLite CLI never falls back to retired JSON, even before migration.
    // Unknown builds prefer an existing database; older JSON CLIs ignore it.
    const value = await readSqliteStore(databasePath);
    return { profiles: getOpenClawStoredProfiles(value), order: orderFrom(value) };
  }
  const modern = readJson(path.join(agentDir, 'auth-profiles.json'));
  const profiles = modern && typeof modern === 'object' && !Array.isArray(modern)
    ? (modern as Record<string, unknown>).profiles : undefined;
  if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
    // Even an empty/schema-valid modern store supersedes auth.json. Merging
    // retired credentials here could resurrect a removed or unselected profile.
    return {
      profiles: getOpenClawStoredProfiles(modern),
      order: { ...orderFrom(modern), ...orderFrom(readJson(path.join(agentDir, 'auth-state.json'))) },
    };
  }
  // Native falls back only when the modern envelope is absent or malformed.
  // A detached modern runtime-state file does not belong to the legacy map.
  return {
    profiles: getOpenClawStoredProfiles(readJson(path.join(agentDir, 'auth.json')), true),
    order: {},
  };
}

/** Offline eligibility only; native OpenClaw owns secret resolution and refresh. */
export async function hasOpenClawAgentCredentials(agentDir: string, mainAgentDir: string): Promise<boolean> {
  return hasOpenClawStoredCredentials({ profiles: await readOpenClawAgentProfiles(agentDir, mainAgentDir) });
}

/** Read-only merged profiles, retaining invalid material that shadows inherited ids. */
export async function readOpenClawAgentProfiles(agentDir: string, mainAgentDir: string): Promise<Record<string, unknown>> {
  return (await readOpenClawAgentAuthStore(agentDir, mainAgentDir)).profiles;
}

/** Privacy snapshots include inactive/retired credentials, not just eligible auth. */
export async function readOpenClawDiagnosticProfiles(agentDir: string, mainAgentDir: string): Promise<unknown[]> {
  const profiles: unknown[] = [];
  for (const directory of new Set([agentDir, mainAgentDir])) {
    profiles.push(...Object.values(getOpenClawStoredProfiles(readJson(path.join(directory, 'auth-profiles.json')))));
    profiles.push(...Object.values(getOpenClawStoredProfiles(readJson(path.join(directory, 'auth.json')), true)));
    const database = path.join(directory, 'openclaw-agent.sqlite');
    if (fs.existsSync(database)) {
      profiles.push(...Object.values(getOpenClawStoredProfiles(await readSqliteStore(database))));
    }
  }
  return profiles;
}

/** Read-only persisted profiles and selection order; native owns refresh/cooldowns. */
export async function readOpenClawAgentAuthStore(agentDir: string, mainAgentDir: string, format: OpenClawStoreFormat = 'unknown'): Promise<OpenClawAuthStore> {
  const local = await readStore(agentDir, format);
  if (agentDir === mainAgentDir) { return local; }
  const inherited = await readStore(mainAgentDir, format);
  const order = { ...inherited.order, ...local.order };
  // Native prepends local profiles to an inherited order unless the local
  // store supplies its own order for that provider.
  const localProviders = new Set(Object.values(local.profiles).map(value => (value as { provider: string }).provider));
  for (const provider of localProviders) {
    if (!order[provider] || local.order[provider]) { continue; }
    const ids = Object.entries(local.profiles).filter(([, value]) => (value as { provider: string }).provider === provider).map(([id]) => id);
    order[provider] = [...new Set([...ids, ...order[provider]])];
  }
  return { profiles: { ...inherited.profiles, ...local.profiles }, order };
}
