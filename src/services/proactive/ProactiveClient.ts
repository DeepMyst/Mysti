export interface CloudResponsibility {
  id: string; title: string; source: string; resource: string; keywords: string[];
  state: 'active' | 'paused'; revision: number; health: string; last_checked_at: string | null; next_check_at: string;
}
export interface CloudInsight {
  id: string; responsibility_id: string; title: string; summary: string; state: 'unread' | 'read'; created_at: string;
  evidence: { url: string; excerpt: string; matched_terms: string[]; source: string; resource: string; version: string; author?: string; status?: string };
}
export interface CloudState {
  available: boolean; read_only: boolean;
  connections: { id: string; name: string; source: string; supported: boolean }[];
  responsibilities: CloudResponsibility[]; insights: CloudInsight[];
}

export class ProactiveClient {
  constructor(private readonly _base: string, private readonly _key: string) {}
  async request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
    const base = new URL(this._base);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.username || base.password || (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) ||
        (!loopback && base.hostname !== 'deepmyst.com' && !base.hostname.endsWith('.deepmyst.com'))) {
      throw new Error('Use a trusted HTTPS DeepMyst API endpoint.');
    }
    const response = await fetch(new URL(`/api/v1/me/proactive${path}`, base), {
      method, headers: { Authorization: `Bearer ${this._key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      if (response.status === 404) { throw new Error(path ? 'This watch or insight no longer exists. Refresh the inbox.' : 'Proactive cloud monitoring is not deployed on this DeepMyst server. Local monitoring is available.'); }
      if (response.status === 409) { throw new Error('This watch changed in another session. Refresh before trying again.'); }
      if (response.status === 422) { throw new Error('Check the watch name, repository or channel ID, and use 1–8 terms of 3–80 characters.'); }
      if ([401, 403].includes(response.status)) { throw new Error('DeepMyst denied access. Sign in with a personal account that can manage responsibilities.'); }
      throw new Error(`DeepMyst could not complete this request (${response.status}). Refresh and try again.`);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
}
