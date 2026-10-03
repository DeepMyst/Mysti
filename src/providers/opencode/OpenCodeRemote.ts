/** OpenCode HTTP transport. Sessions belong to one Mysti turn and are never shared. */
import { createHash, randomUUID } from 'crypto';
import type { SecretStorage } from 'vscode';
import type { ModelInfo, Settings, StreamChunk } from '../../types';
import type { NativeApprovalHost } from '../base/IProvider';
import { normalizeToolName } from '../../utils/toolNames';

export interface RemoteConnection { endpoint: string; directory: string; username: string }
export function remoteConnection(endpoint: string, directory = '', username = 'opencode'): RemoteConnection {
  const url = new URL(endpoint);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Use HTTPS, or HTTP on localhost, without credentials, query or fragment in the endpoint.');
  }
  return { endpoint: url.href.replace(/\/$/, ''), directory, username };
}
export function remoteSecretKey(c: RemoteConnection): string {
  return 'mysti.opencode.remote.' + createHash('sha256').update(c.endpoint).digest('hex');
}
interface Part { id: string; type: string; text?: string; messageID?: string; sessionID?: string; tool?: string; callID?: string; state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string } }
interface Reply { info?: { error?: unknown; tokens?: { input?: number; output?: number } }; parts?: Part[] }
export class OpenCodeRemote {
  private readonly turns = new Map<string, AbortController>();
  constructor(private readonly secrets: SecretStorage) {}
  cancel(panelId?: string): void {
    if (panelId) { this.turns.get(panelId)?.abort(); }
    else { for (const c of this.turns.values()) { c.abort(); } }
  }
  private async request(c: RemoteConnection, route: string, signal: AbortSignal, body?: unknown, method?: string): Promise<Response> {
    const url = new URL(c.endpoint + route);
    if (c.directory) { url.searchParams.set('directory', c.directory); }
    const password = await this.secrets.get(remoteSecretKey(c));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (password) { headers.Authorization = 'Basic ' + Buffer.from(`${c.username}:${password}`).toString('base64'); }
    const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenCode server returned HTTP ${response.status}. Check the endpoint and server password.`); }
    return response;
  }
  async probe(c: RemoteConnection): Promise<{ version: string; models: ModelInfo[]; connected: string[] }> {
    const signal = AbortSignal.timeout(7000);
    const health = await (await this.request(c, '/global/health', signal)).json() as { healthy?: boolean; version?: string };
    if (!health.healthy) { throw new Error('OpenCode server is not healthy.'); }
    const catalog = await (await this.request(c, '/provider', signal)).json() as {
      connected: string[]; all: Array<{ id: string; models: Record<string, { name: string; limit?: { context?: number } }> }>;
    };
    const connected = catalog.connected ?? [];
    const models: ModelInfo[] = [];
    for (const provider of catalog.all ?? []) {
      if (!connected.includes(provider.id)) { continue; }
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        models.push({ id: `${provider.id}/${id}`, name: model.name || id,
          ...(Number.isFinite(model.limit?.context) && model.limit!.context! > 0 ? { contextWindow: model.limit!.context } : {}) });
      }
    }
    return { version: health.version ?? 'unknown', connected, models };
  }
  async *send(c: RemoteConnection, panelId: string, settings: Settings, prompt: () => Promise<string>, model?: string, host?: NativeApprovalHost): AsyncGenerator<StreamChunk> {
    this.cancel(panelId);
    const controller = new AbortController();
    this.turns.set(panelId, controller);
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(new Error('OpenCode request exceeded one hour.')), 3600000);
    const handler = host?.handlerForPanel(panelId, signal);
    const readonly = settings.accessLevel === 'read-only' || settings.mode === 'quick-plan' || settings.mode === 'detailed-plan';
    const permission = [{ permission: '*', pattern: '*', action: readonly ? 'deny' : 'ask' },
      ...['read', 'glob', 'grep', 'list'].map(p => ({ permission: p, pattern: '*', action: 'ask' }))];
    let sessionID: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responsePromise: Promise<Reply> | undefined;
    const seen = new Map<string, string>();
    const textParts = (part: Part): StreamChunk[] => {
      if (!['text', 'reasoning'].includes(part.type) || typeof part.text !== 'string') { return []; }
      const previous = seen.get(part.id) ?? '';
      seen.set(part.id, part.text);
      const content = part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text;
      return content ? [{ type: part.type === 'reasoning' ? 'thinking' : 'text', content }] : [];
    };
    try {
      const content = await prompt();
      signal.throwIfAborted();
      let selected: { providerID: string; modelID: string } | undefined;
      if (model && model !== 'default') {
        const slash = model.indexOf('/');
        if (slash < 1 || slash === model.length - 1) { throw new Error('OpenCode remote models use provider/model identifiers.'); }
        selected = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
      }
      const session = await (await this.request(c, '/session', signal, { title: 'Mysti', permission })).json() as { id?: string; permission?: unknown };
      sessionID = session.id;
      if (!sessionID || JSON.stringify(session.permission) !== JSON.stringify(permission)) {
        throw new Error('OpenCode server did not acknowledge session permissions. Upgrade OpenCode before using remote mode.');
      }
      const route = '/session/' + encodeURIComponent(sessionID);
      const events = await this.request(c, '/event', signal);
      reader = events.body?.getReader();
      if (!reader) { throw new Error('OpenCode event stream is unavailable.'); }
      const messageID = 'msg_' + randomUUID().replace(/-/g, '');
      responsePromise = this.request(c, route + '/message', signal, {
        messageID, model: selected, agent: readonly ? 'plan' : 'build', parts: [{ type: 'text', text: content }],
      }).then(r => r.json() as Promise<Reply>);
      // Attach both handlers immediately; a network error cannot become an unhandled rejection.
      const result = responsePromise.then(reply => ({ kind: 'reply' as const, reply }), error => ({ kind: 'error' as const, error }));
      let pending = reader.read();
      let buffer = '';
      const decoder = new TextDecoder();
      const kinds = new Map<string, string>();
      let reply: Reply;
      for (;;) {
        const next = await Promise.race([result, pending.then(value => ({ kind: 'event' as const, value }))]);
        if (next.kind === 'error') { throw next.error; }
        if (next.kind === 'reply') { reply = next.reply; break; }
        if (next.value.done) { throw new Error('OpenCode event stream disconnected before completion.'); }
        buffer += decoder.decode(next.value.value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 8 * 1024 * 1024) { throw new Error('OpenCode event exceeded the supported size.'); }
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) { continue; }
          const event = JSON.parse(data) as { type: string; properties: { sessionID?: string; part?: Part; id?: string; permission?: string; metadata?: Record<string, unknown>; patterns?: string[]; messageID?: string; partID?: string; field?: string; delta?: string } };
          const p = event.properties;
          if (!p || (p.sessionID ?? p.part?.sessionID) !== sessionID) { continue; }
          if (event.type === 'permission.asked' && p.id) {
            const name = String(p.permission);
            const read = ['read', 'glob', 'grep', 'list'].includes(name);
            let allowed = false;
            if (!(readonly && !read) && handler) {
              const decision = handler({ id: randomUUID(), nativeRequestId: p.id, providerId: 'opencode', panelId,
                toolCall: { status: 'pending', id: p.id, name: normalizeToolName(name), input: { ...p.metadata, patterns: p.patterns, remoteEndpoint: c.endpoint, remoteDirectory: c.directory } },
                defaultDecision: read || settings.accessLevel === 'full-access' ? 'allow' : 'ask', signal });
              let onAbort!: () => void;
              try {
                allowed = await Promise.race([decision, new Promise<false>(resolve => {
                  onAbort = () => resolve(false); signal.addEventListener('abort', onAbort, { once: true });
                  if (signal.aborted) { resolve(false); }
                })]) === true;
              } finally { signal.removeEventListener('abort', onAbort); }
            }
            signal.throwIfAborted();
            await (await this.request(c, '/permission/' + encodeURIComponent(p.id) + '/reply', signal, { reply: allowed ? 'once' : 'reject' })).body?.cancel();
          } else if (event.type === 'question.asked' || event.type === 'permission.v2.asked') {
            throw new Error('This OpenCode interaction is not supported in Mysti remote mode. Continue the task in OpenCode.');
          } else if (event.type === 'message.part.updated' && p.part && p.part.messageID !== messageID) {
            const part = p.part as Part; kinds.set(part.id, part.type);
            for (const chunk of textParts(part)) { yield chunk; }
            if (part.type === 'tool' && part.state) {
              const toolCall = { status: 'running' as const, id: part.callID ?? part.id, name: normalizeToolName(part.tool ?? 'tool'), input: part.state.input ?? {} };
              if (part.state.status === 'running') { yield { type: 'tool_use', toolCall }; }
              if (part.state.status === 'completed' || part.state.status === 'error') {
                yield { type: 'tool_result', toolCall: { ...toolCall, status: part.state.status === 'error' ? 'failed' : 'completed' }, content: part.state.output ?? part.state.error ?? '' };
              }
            }
          } else if (event.type === 'message.part.delta' && p.partID && p.messageID !== messageID && p.field === 'text') {
            const type = kinds.get(p.partID) ?? 'text';
            for (const chunk of textParts({ id: p.partID, type, text: (seen.get(p.partID) ?? '') + String(p.delta ?? '') })) { yield chunk; }
          } else if (event.type === 'session.error') { throw new Error('OpenCode session failed. Check server model authentication and logs.'); }
        }
        pending = reader.read();
      }
      if (reply.info?.error) { throw new Error('OpenCode model request failed. Check the server provider credentials and model.'); }
      for (const part of reply.parts ?? []) { for (const chunk of textParts(part)) { yield chunk; } }
      if (!seen.size) { throw new Error('OpenCode returned no response.'); }
      yield { type: 'done' };
    } catch (error) {
      if (!signal.aborted) { yield { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
      else if (signal.reason instanceof Error && signal.reason.message.includes('one hour')) { yield { type: 'error', content: signal.reason.message }; }
    } finally {
      clearTimeout(timer); controller.abort();
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
      await responsePromise?.catch(() => {});
      if (sessionID) {
        const cleanup = AbortSignal.timeout(5000);
        const route = '/session/' + encodeURIComponent(sessionID);
        await this.request(c, route + '/abort', cleanup, {}).then(r => r.body?.cancel()).catch(() => {});
        await this.request(c, route, cleanup, undefined, 'DELETE').then(r => r.body?.cancel()).catch(() => {});
      }
      if (this.turns.get(panelId) === controller) { this.turns.delete(panelId); }
    }
  }
}
