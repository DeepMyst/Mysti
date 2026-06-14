/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the DeepMyst API client (Plan 04). Covers MCP endpoint URL
 * building, the dm_ Bearer auth header, key validation (valid / unauthorized /
 * unreachable), and built-in MCP list coercion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DeepMystClient,
  isPlausibleDeepMystKey,
  DEEPMYST_KEY_PREFIX,
} from '../../src/services/DeepMystClient';

const API = 'https://api.deepmyst.test';
const GOOD_KEY = 'dm_live_abcdef 1234567890'.replace(' ', ''); // dm_live_abcdef1234567890

function client(key: string | undefined, api = API) {
  return new DeepMystClient(() => key, () => api);
}

describe('isPlausibleDeepMystKey', () => {
  it('accepts a dm_-prefixed key of reasonable length', () => {
    expect(isPlausibleDeepMystKey('dm_live_abcdef12345')).toBe(true);
  });
  it('rejects empty, wrong-prefix, and too-short keys', () => {
    expect(isPlausibleDeepMystKey('')).toBe(false);
    expect(isPlausibleDeepMystKey('sk-abcdef123456')).toBe(false);
    expect(isPlausibleDeepMystKey('dm_')).toBe(false);
    expect(isPlausibleDeepMystKey(undefined)).toBe(false);
  });
});

describe('DeepMystClient URL building', () => {
  it('builds the agent MCP endpoint URL', () => {
    expect(client(GOOD_KEY).getMcpEndpointUrl('my-agent')).toBe(`${API}/api/v1/mcp/my-agent`);
  });
  it('builds the built-in MCP endpoint URL and encodes the name', () => {
    expect(client(GOOD_KEY).getBuiltinMcpEndpointUrl('corp knowledge')).toBe(`${API}/api/v1/mcp/builtin/corp%20knowledge`);
  });
  it('trims a trailing slash from the configured API URL', () => {
    expect(client(GOOD_KEY, `${API}/`).getMcpEndpointUrl('a')).toBe(`${API}/api/v1/mcp/a`);
  });
});

describe('DeepMystClient.validateKey', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns valid=false without a network call for a non-dm_ key', async () => {
    const res = await client('nope').validateKey();
    expect(res.valid).toBe(false);
    expect(res.error).toContain(DEEPMYST_KEY_PREFIX);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Bearer auth to /api/v1/mcp/builtin and returns valid on 200', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const res = await client(GOOD_KEY).validateKey();
    expect(res.valid).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/api/v1/mcp/builtin`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${GOOD_KEY}`);
  });

  it('validates a candidate key passed explicitly (before storing)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const res = await client(undefined).validateKey('dm_candidate_key_123');
    expect(res.valid).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer dm_candidate_key_123');
  });

  it('returns valid=false with an unauthorized reason on 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const res = await client(GOOD_KEY).validateKey();
    expect(res.valid).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error?.toLowerCase()).toContain('unauthorized');
  });

  it('returns valid=false with a reachability reason on network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await client(GOOD_KEY).validateKey();
    expect(res.valid).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toContain('Could not reach DeepMyst');
  });
});

describe('DeepMystClient.listBuiltinMcps', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns [] when signed out (no auth header)', async () => {
    expect(await client(undefined).listBuiltinMcps()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('coerces an array payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'corp', title: 'Corporate Knowledge' }, { name: 'org' }],
    });
    const list = await client(GOOD_KEY).listBuiltinMcps();
    expect(list).toEqual([
      { name: 'corp', title: 'Corporate Knowledge', description: undefined },
      { name: 'org', title: undefined, description: undefined },
    ]);
  });

  it('coerces an object-map payload (key becomes name)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ corp: { title: 'Corporate Knowledge' }, org: { description: 'Org data' } }),
    });
    const list = await client(GOOD_KEY).listBuiltinMcps();
    expect(list.map(m => m.name).sort()).toEqual(['corp', 'org']);
  });

  it('returns [] on a non-ok response or parse failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    expect(await client(GOOD_KEY).listBuiltinMcps()).toEqual([]);
  });
});

describe('DeepMystClient.listAgents / listConnections', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists agents from a bare array (name/slug/description)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [
      { slug: 'support', name: 'Support Bot', description: 'Helps' },
      { slug: 'noname' },
      { name: 'no slug — dropped' },
    ] });
    const res = await client(GOOD_KEY).listAgents();
    expect(res.available).toBe(true);
    expect(res.items).toEqual([
      { slug: 'support', name: 'Support Bot', description: 'Helps' },
      { slug: 'noname', name: 'noname', description: undefined },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/api/v1/agents`);
  });

  it('unwraps a {data:[...]} envelope for connections', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [
      { id: 'ds1', name: 'GitHub', type: 'github', status: 'connected' },
    ] }) });
    const res = await client(GOOD_KEY).listConnections();
    expect(res.available).toBe(true);
    expect(res.items).toEqual([{ id: 'ds1', name: 'GitHub', type: 'github', status: 'connected' }]);
  });

  it('reports available=false when the endpoint 404s', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const res = await client(GOOD_KEY).listAgents();
    expect(res.available).toBe(false);
    expect(res.items).toEqual([]);
  });

  it('returns empty+available when signed out (no call)', async () => {
    const res = await client(undefined).listConnections();
    expect(res).toEqual({ items: [], available: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades to empty on network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await client(GOOD_KEY).listAgents();
    expect(res.items).toEqual([]);
    expect(res.available).toBe(true);
  });
});

describe('DeepMystClient MCP connections (My Connections hub)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists MCP connections from /me/mcp-connections, mapping snake_case fields', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [
      { id: 'c1', display_name: 'GitHub', provider: 'smithery', status: 'connected', mcp_url: 'https://smithery.ai/x', icon_url: 'https://i/g.png' },
      { id: 'c2', display_name: 'Jira', provider: 'composio', status: 'pending', mcp_url: 'composio://jira', setup_url: 'https://auth/jira' },
      { display_name: 'no id — dropped' },
    ] });
    const res = await client(GOOD_KEY).listMcpConnections();
    expect(res.available).toBe(true);
    expect(res.items).toEqual([
      { id: 'c1', displayName: 'GitHub', provider: 'smithery', status: 'connected', mcpUrl: 'https://smithery.ai/x', setupUrl: undefined, iconUrl: 'https://i/g.png', description: undefined, errorMessage: undefined, connectedAt: undefined },
      { id: 'c2', displayName: 'Jira', provider: 'composio', status: 'pending', mcpUrl: 'composio://jira', setupUrl: 'https://auth/jira', iconUrl: undefined, description: undefined, errorMessage: undefined, connectedAt: undefined },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/api/v1/me/mcp-connections`);
  });

  it('reports available=false when /me/mcp-connections 404s (instance predates feature)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const res = await client(GOOD_KEY).listMcpConnections();
    expect(res.available).toBe(false);
    expect(res.items).toEqual([]);
  });

  it('disconnectMcp DELETEs the connection and returns true on 2xx', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    const ok = await client(GOOD_KEY).disconnectMcp('c1');
    expect(ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/api/v1/me/mcp-connections/c1`);
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('disconnectMcp returns false on 403 (read-only / agent-scoped key)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    expect(await client(GOOD_KEY).disconnectMcp('c1')).toBe(false);
  });

  it('disconnectMcp returns false when signed out (no call)', async () => {
    expect(await client(undefined).disconnectMcp('c1')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshMcpConnection POSTs and maps the updated connection', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => (
      { id: 'c2', display_name: 'Jira', provider: 'composio', status: 'connected', mcp_url: 'composio://jira' }
    ) });
    const conn = await client(GOOD_KEY).refreshMcpConnection('c2');
    expect(conn?.status).toBe('connected');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/api/v1/me/mcp-connections/c2/refresh`);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });
});
