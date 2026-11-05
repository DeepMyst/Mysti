/** OpenCode HTTP transport. Sessions belong to one Mysti turn and are never shared. */
import { createHash, randomUUID } from 'crypto';
import type { SecretStorage } from 'vscode';
import type { ModelInfo, Settings, StreamChunk } from '../../types';
import type { NativeApprovalHost } from '../base/IProvider';
import { normalizeToolName } from '../../utils/toolNames';
import { createAbortScope } from '../../utils/abortScope';

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
interface OwnedSession {
  id: string; key: string; connectionKey: string; connection: RemoteConnection;
  retired: boolean; cleanup?: Promise<void>;
}
class RemoteHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const CLEANUP_TIMEOUT_MS = 5000;
const CLEANUP_RETRY_BATCH = 8;

export class OpenCodeRemote {
  private readonly turns = new Map<string, AbortController>();
  private readonly sessions = new Map<string, OwnedSession>();
  constructor(private readonly secrets: SecretStorage) {}
  cancel(panelId?: string): void {
    if (panelId) { this.turns.get(panelId)?.abort(); }
    else { for (const c of this.turns.values()) { c.abort(); } }
  }
  private async request(c: RemoteConnection, route: string, signal: AbortSignal, body?: unknown, method?: string, resolveBody?: () => unknown): Promise<Response> {
    const url = new URL(c.endpoint + route);
    if (c.directory) { url.searchParams.set('directory', c.directory); }
    signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); }
    });
    let password: string | undefined;
    try { password = await Promise.race([this.secrets.get(remoteSecretKey(c)), aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
    signal.throwIfAborted();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (password) { headers.Authorization = 'Basic ' + Buffer.from(`${c.username}:${password}`).toString('base64'); }
    if (resolveBody) { body = resolveBody(); }
    signal.throwIfAborted();
    const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new RemoteHttpError(response.status, `OpenCode server returned HTTP ${response.status}. Check the endpoint and server password.`);
      }
      if (route.startsWith('/session/') && route.endsWith('/message')) {
        throw new RemoteHttpError(response.status, `OpenCode model request failed (HTTP ${response.status}). Check that the selected model and its provider credentials are configured on the server.`);
      }
      throw new RemoteHttpError(response.status, `OpenCode server returned HTTP ${response.status}. Check the server status, endpoint, and logs.`);
    }
    return response;
  }

  private errorMessage(error: unknown): string {
    // Fetch/stream errors can originate in a different runtime realm. Inspect
    // their standard fields rather than exposing an unhelpful TypeError string.
    const detail = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : undefined;
    const message = typeof detail?.message === 'string' ? detail.message : String(error);
    if (detail?.name === 'TypeError' && (message === 'fetch failed' || message === 'terminated')) {
      return 'OpenCode connection was interrupted. Check that the server is running, then retry.';
    }
    return message;
  }

  private connectionKey(c: RemoteConnection): string {
    return JSON.stringify([c.endpoint, c.directory, c.username]);
  }

  private async cleanupSession(session: OwnedSession, signal: AbortSignal): Promise<void> {
    const owns = () => session.retired && this.sessions.get(session.key) === session;
    if (!owns() || signal.aborted) { return; }
    if (session.cleanup) { return session.cleanup; }
    const attempt = (async () => {
      const route = '/session/' + encodeURIComponent(session.id);
      await this.request(session.connection, route + '/abort', signal, {}).then(r => r.body?.cancel()).catch(() => {});
      if (!owns() || signal.aborted) { return; }
      let removed: boolean;
      try {
        await this.request(session.connection, route, signal, undefined, 'DELETE').then(r => r.body?.cancel());
        removed = true;
      } catch (error) {
        removed = error instanceof RemoteHttpError && error.status === 404;
      }
      if (removed && owns()) { this.sessions.delete(session.key); }
    })();
    session.cleanup = attempt;
    try { await attempt; }
    finally {
      if (session.cleanup === attempt) { session.cleanup = undefined; }
      // Rotate failures so a permanently failing entry cannot starve a backlog.
      if (owns()) { this.sessions.delete(session.key); this.sessions.set(session.key, session); }
    }
  }

  private async retryCleanup(c: RemoteConnection, turnSignal: AbortSignal): Promise<void> {
    const key = this.connectionKey(c);
    const retired = [...this.sessions.values()].filter(s => s.retired && s.connectionKey === key).slice(0, CLEANUP_RETRY_BATCH);
    if (!retired.length) { return; }
    // One shared deadline and a bounded batch keep recovery from delaying the
    // next turn indefinitely. Stop also prevents dispatch of a replacement prompt.
    const scope = createAbortScope([turnSignal], CLEANUP_TIMEOUT_MS);
    try { await Promise.all(retired.map(s => this.cleanupSession(s, scope.signal))); }
    finally { scope.dispose(); }
  }

  async probe(c: RemoteConnection): Promise<{ version: string; models: ModelInfo[]; connected: string[] }> {
    const health = await (await this.request(c, '/global/health', AbortSignal.timeout(7000))).json() as { healthy?: boolean; version?: string };
    if (!health.healthy) { throw new Error('OpenCode server is not healthy.'); }
    // The full /provider catalog includes thousands of unconfigured models.
    // Configured providers are sufficient here. First use also initializes the
    // workspace, so give that step a separate, longer deadline than health.
    const signal = AbortSignal.timeout(30000);
    const catalog = await this.request(c, '/config/providers', signal).then(r => r.json()).catch(error => {
      if (signal.aborted) { throw new Error('OpenCode connected, but provider initialization timed out. Retry when the server is ready.'); }
      throw error;
    }) as {
      providers: Array<{ id: string; models: Record<string, { name: string; limit?: { context?: number } }> }>;
    };
    if (!Array.isArray(catalog?.providers)) { throw new Error('OpenCode server returned invalid configured providers.'); }
    const connected: string[] = [];
    const models: ModelInfo[] = [];
    for (const provider of catalog.providers) {
      if (!provider || typeof provider.id !== 'string' || !provider.id) { throw new Error('OpenCode server returned invalid configured providers.'); }
      connected.push(provider.id);
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        models.push({ id: `${provider.id}/${id}`, name: model.name || id,
          ...(Number.isFinite(model.limit?.context) && model.limit!.context! > 0 ? { contextWindow: model.limit!.context } : {}) });
      }
    }
    return { version: health.version ?? 'unknown', connected, models };
  }
  async *send(c: RemoteConnection, panelId: string, settings: Settings, prompt: () => Promise<string | (() => string | undefined)>, model?: string, host?: NativeApprovalHost): AsyncGenerator<StreamChunk> {
    c = { ...c }; // Retain the originating connection even if caller settings change.
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
    let ownedSession: OwnedSession | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responsePromise: Promise<Reply> | undefined;
    const seen = new Map<string, string>();
    const completedTools = new Set<string>();
    const textParts = (part: Part): StreamChunk[] => {
      if (!['text', 'reasoning'].includes(part.type) || typeof part.text !== 'string') { return []; }
      const previous = seen.get(part.id) ?? '';
      seen.set(part.id, part.text);
      const content = part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text;
      return content ? [{ type: part.type === 'reasoning' ? 'thinking' : 'text', content }] : [];
    };
    const toolParts = (part: Part): StreamChunk[] => {
      if (part.type !== 'tool' || !part.state) { return []; }
      const id = part.callID ?? part.id;
      if (completedTools.has(id)) { return []; }
      const toolCall = { status: 'running' as const, id, name: normalizeToolName(part.tool ?? 'tool'), input: part.state.input ?? {} };
      if (part.state.status === 'running') { return [{ type: 'tool_use', toolCall }]; }
      if (part.state.status !== 'completed' && part.state.status !== 'error') { return []; }
      completedTools.add(id);
      const output = part.state.output ?? part.state.error ?? '';
      return [{ type: 'tool_result', toolCall: { ...toolCall, status: part.state.status === 'error' ? 'failed' : 'completed', output }, content: output }];
    };
    try {
      const preparedPrompt = await prompt();
      signal.throwIfAborted();
      let selected: { providerID: string; modelID: string } | undefined;
      if (model && model !== 'default') {
        const slash = model.indexOf('/');
        if (slash < 1 || slash === model.length - 1) { throw new Error('OpenCode remote models use provider/model identifiers.'); }
        selected = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
      }
      await this.retryCleanup(c, signal);
      signal.throwIfAborted();
      const session = await (await this.request(c, '/session', signal, { title: 'Mysti', permission })).json() as { id?: string; permission?: unknown };
      sessionID = typeof session.id === 'string' ? session.id : undefined;
      if (sessionID) {
        const connectionKey = this.connectionKey(c), key = JSON.stringify([connectionKey, sessionID]);
        if (this.sessions.has(key)) { throw new Error('OpenCode server reused an existing session. Refusing to share it with another turn.'); }
        ownedSession = { id: sessionID, key, connectionKey, connection: c, retired: false };
        this.sessions.set(key, ownedSession);
      }
      if (!sessionID || JSON.stringify(session.permission) !== JSON.stringify(permission)) {
        throw new Error('OpenCode server did not acknowledge session permissions. Upgrade OpenCode before using remote mode.');
      }
      const route = '/session/' + encodeURIComponent(sessionID);
      const events = await this.request(c, '/event', signal);
      reader = events.body?.getReader();
      if (!reader) { throw new Error('OpenCode event stream is unavailable.'); }
      const messageID = 'msg_' + randomUUID().replace(/-/g, '');
      // Credentials are asynchronous too: resolve the trusted input only after
      // request() has obtained them, immediately before serializing the body.
      responsePromise = this.request(c, route + '/message', signal, undefined, 'POST', () => {
        const content = typeof preparedPrompt === 'function' ? preparedPrompt() : preparedPrompt;
        if (content === undefined) { controller.abort(); signal.throwIfAborted(); }
        return { messageID, model: selected, agent: readonly ? 'plan' : 'build', parts: [{ type: 'text', text: content }] };
      }).then(r => r.json() as Promise<Reply>);
      // Attach both handlers immediately; a network error cannot become an unhandled rejection.
      const result = responsePromise.then(reply => ({ kind: 'reply' as const, reply }), error => ({ kind: 'error' as const, error }));
      let pending = reader.read();
      let buffer = '';
      const decoder = new TextDecoder();
      const kinds = new Map<string, string>();
      let reply: Reply;
      for (;;) {
        signal.throwIfAborted();
        const next = await Promise.race([result, pending.then(value => ({ kind: 'event' as const, value }))]);
        signal.throwIfAborted();
        if (next.kind === 'error') { throw next.error; }
        if (next.kind === 'reply') { reply = next.reply; break; }
        if (next.value.done) { throw new Error('OpenCode event stream disconnected before completion.'); }
        buffer += decoder.decode(next.value.value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 8 * 1024 * 1024) { throw new Error('OpenCode event exceeded the supported size.'); }
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          signal.throwIfAborted();
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
            for (const chunk of textParts(part)) { yield chunk; signal.throwIfAborted(); }
            for (const chunk of toolParts(part)) { yield chunk; signal.throwIfAborted(); }
          } else if (event.type === 'message.part.delta' && p.partID && p.messageID !== messageID && p.field === 'text') {
            const type = kinds.get(p.partID) ?? 'text';
            for (const chunk of textParts({ id: p.partID, type, text: (seen.get(p.partID) ?? '') + String(p.delta ?? '') })) { yield chunk; signal.throwIfAborted(); }
          } else if (event.type === 'session.error') { throw new Error('OpenCode session failed. Check server model authentication and logs.'); }
        }
        signal.throwIfAborted();
        pending = reader.read();
      }
      if (reply.info?.error) { throw new Error('OpenCode model request failed. Check the server provider credentials and model.'); }
      // The message response can win the race with its terminal SSE event.
      // Reconcile final tool state too, including turns ended by a rejected tool.
      for (const part of reply.parts ?? []) {
        for (const chunk of [...textParts(part), ...toolParts(part)]) { yield chunk; signal.throwIfAborted(); }
      }
      if (!seen.size && !completedTools.size) { throw new Error('OpenCode returned no response.'); }
      yield { type: 'done' };
    } catch (error) {
      if (!signal.aborted) { yield { type: 'error', content: this.errorMessage(error) }; }
      else if (signal.reason instanceof Error && signal.reason.message.includes('one hour')) { yield { type: 'error', content: signal.reason.message }; }
    } finally {
      clearTimeout(timer); controller.abort();
      if (ownedSession) { ownedSession.retired = true; }
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
      await responsePromise?.catch(() => {});
      if (ownedSession) {
        const scope = createAbortScope([], CLEANUP_TIMEOUT_MS);
        try { await this.cleanupSession(ownedSession, scope.signal); }
        finally { scope.dispose(); }
      }
      if (this.turns.get(panelId) === controller) { this.turns.delete(panelId); }
    }
  }
}
