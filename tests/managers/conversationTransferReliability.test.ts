import * as zlib from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConversationManager, PERSISTED_TOOL_STRING_CAP } from '../../src/managers/ConversationManager';
import { clearMockConfig } from '../helpers/mockVscode';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function create() {
  const storage: Record<string, any> = {};
  const context = { globalState: { get: (key: string, fallback?: unknown) => storage[key] === undefined ? fallback : clone(storage[key]),
    update: async (key: string, value: unknown) => { storage[key] = clone(value); } } } as any;
  return { manager: new ConversationManager(context), context, storage };
}
function richConversation() {
  return { id: 'exported-source', title: 'Retry code — مراجعة 🧪', createdAt: 1700000000000, updatedAt: 1700000000500,
    provider: 'openai-codex', model: 'custom-model', mode: 'detailed-plan', agentConfig: { personaId: 'reviewer', enabledSkills: ['retry'], roleId: 'analyst' },
    messages: [
      { id: 'original-user', role: 'user', content: 'Check retry  \n\n```ts\n### Assistant\nconst x = "</script>";\n```\n', timestamp: 1700000000000,
        context: [{ path: '/owned/retry.ts', name: 'retry.ts', type: 'file', content: 'const base = 73;' }],
        attachments: [{ id: 'image', fileName: 'diagram.png', type: 'image', mimeType: 'image/png', size: 4, base64Data: 'AAAA' }],
        checkpoint: { commit: 'a'.repeat(40), createdAt: 1700000000000 } },
      { id: 'original-assistant', role: 'assistant', content: 'First paragraph.\n\nFinal paragraph.  \n', timestamp: 1700000000500,
        provider: 'claude-code', model: 'actual-claude-model', participants: ['claude-code', 'openai-codex'],
        thinking: { style: 'streamed', content: 'Checked the exact retry behavior.' },
        toolCalls: [{ id: 'read-1', name: 'Read', input: { file_path: '/owned/retry.ts', options: { lines: [1, 2] } }, output: 'const base = 73;', status: 'completed', kind: 'read' }],
        segments: [{ type: 'text', content: 'First paragraph.\n\n' }, { type: 'tool', toolCallId: 'read-1' }, { type: 'text', content: 'Final paragraph.  \n' }],
        usage: { input: 321, output: 42 } },
      { id: 'original-system', role: 'system', content: 'Imported transcript note, not a workspace permission.', timestamp: 1700000000600 },
    ] };
}
const envelope = (conversation = richConversation(), version: unknown = 1) => JSON.stringify({ format: 'mysti', version, conversation });
function semantic(message: any) { const value = clone(message); delete value.id; delete value.checkpoint; if (value.attachments) for (const a of value.attachments) delete a.base64Data; if (value.toolCalls) for (const tool of value.toolCalls) delete tool.historicalOnly; return value; }
beforeEach(clearMockConfig);

describe('PC-11 exact import/export semantic boundaries', () => {
  it('full Mysti JSON retains supported attribution, structured timeline, tool input and custom metadata', () => {
    const { manager, context } = create(), source = richConversation();
    const imported = manager.importFromContent(envelope(source), 'task.mysti.json')!;
    expect(imported).not.toBeNull();
    expect(imported.messages.map(semantic)).toEqual(source.messages.map(semantic));
    expect(imported).toMatchObject({ title: source.title, provider: source.provider, model: source.model, mode: source.mode, agentConfig: source.agentConfig });
    const exported = JSON.parse(manager.exportToJson(imported.id));
    expect(exported.conversation.messages.map(semantic)).toEqual(source.messages.map(semantic));
    expect(new ConversationManager(context).getConversation(imported.id)!.messages.map(semantic)).toEqual(source.messages.map(semantic));
  });

  it('each import regenerates all message and conversation IDs even if the file repeats identifiers', () => {
    const { manager } = create(), source = richConversation();
    source.messages[1].id = source.messages[0].id;
    const first = manager.importFromContent(envelope(source), 'one.json')!;
    const second = manager.importFromContent(envelope(source), 'two.json')!;
    const ids = [...first.messages, ...second.messages].map(message => message.id);
    expect(new Set(ids).size).toBe(ids.length); expect(ids).not.toContain(source.messages[0].id);
    expect(first.id).not.toBe(source.id); expect(second.id).not.toBe(first.id);
  });

  it('a legacy direct conversation object retains its own metadata instead of entering generic text import', () => {
    const { manager } = create(), source = richConversation();
    const imported = manager.importFromContent(JSON.stringify(source), 'legacy.json')!;
    expect(imported).toMatchObject({ title: source.title, provider: source.provider, model: source.model, mode: source.mode });
    expect(imported.messages.map(semantic)).toEqual(source.messages.map(semantic));
  });

  it.each([2, -1, 'future'])('refuses unsupported Mysti export version %j atomically', version => {
    const { manager, storage } = create(), before = clone(storage), current = manager.getCurrentConversation()!.id;
    expect(manager.importFromContent(envelope(richConversation(), version), 'future.mysti.json')).toBeNull();
    expect(storage).toEqual(before); expect(manager.getCurrentConversation()!.id).toBe(current);
  });

  it.each([
    { messages: [{ role: 'assistant', content: { unsafe: 'not renderer text' } }] },
    { messages: [{ role: 'user', content: 'valid prefix' }, { role: 'invented', content: 'bad role' }] },
    { format: 'mysti', version: 1, conversation: { messages: [{ role: 'assistant', content: 42 }] } },
  ])('rejects malformed live-render fields before replacing the current conversation: %j', data => {
    const { manager, storage } = create(), before = clone(storage);
    expect(manager.importFromContent(JSON.stringify(data), 'malformed.json')).toBeNull(); expect(storage).toEqual(before);
  });

  it('checkpoint restore authority is stripped while attachment cards survive without base64 data', () => {
    const { manager } = create(), imported = manager.importFromContent(envelope(), 'task.mysti.json')!;
    expect(imported.messages[0].checkpoint).toBeUndefined();
    expect(imported.messages[0].attachments![0]).toMatchObject({ fileName: 'diagram.png', mimeType: 'image/png' });
    expect(imported.messages[0].attachments![0].base64Data).toBeUndefined();
  });

  it('imports its own Markdown text and roles without splitting fenced or literal message headings', () => {
    const { manager } = create(); const source = manager.getCurrentConversation()!;
    manager.updateConversationTitle(source.id, 'Readable retry transcript');
    const contents = ['Leading and trailing  \n\n```md\n### Assistant\nnot a message\n```\n', 'Literal outside fence:\n### User\nStill assistant text.\n', 'System note.'];
    manager.addMessageToConversation(source.id, 'user', contents[0]); manager.addMessageToConversation(source.id, 'assistant', contents[1]); manager.addMessageToConversation(source.id, 'system', contents[2]);
    const markdown = manager.exportToMarkdown(source.id, true);
    const imported = manager.importFromContent(markdown, 'task.md')!;
    expect(imported).not.toBeNull(); expect(imported.messages.map(message => message.content)).toEqual(contents);
    expect(imported.messages.map(message => message.role)).toEqual(['user', 'assistant', 'system']);
  });

  it('supports an old Mysti Markdown export with fenced-code role headings as text', () => {
    const { manager } = create();
    const markdown = '# Old transcript\n\n> Provider: openai-codex | Model: old-model\n\n### User\n\nQuestion\n\n### Assistant\n\n```md\n### User\n```\n\n---\n\n*I was Mysting — built with [Mysti](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti), the multi-agent AI coding assistant*\n';
    const imported = manager.importFromContent(markdown, 'legacy.MD')!;
    expect(imported).not.toBeNull(); expect(imported.messages.map(message => message.content)).toEqual(['Question', '```md\n### User\n```']);
  });

  it('a truncated JSONL line rejects the complete import without silently accepting its valid prefix', () => {
    const { manager, storage } = create(), before = clone(storage);
    const jsonl = '{"role":"user","content":"first"}\n{"role":"assistant","content":"truncated';
    expect(manager.importFromContent(jsonl, 'session.jsonl')).toBeNull(); expect(storage).toEqual(before);
  });

  it('recognizes nested JSONL text messages and harmless session metadata without stringifying protocol objects', () => {
    const { manager } = create();
    const jsonl = [JSON.stringify({ type: 'session', id: 'foreign-session' }), JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Hello\n' }, { type: 'text', text: 'retry' }] } }), JSON.stringify({ role: 'assistant', content: 'Reply' })].join('\n');
    const imported = manager.importFromContent(jsonl, 'SESSION.JSONL')!;
    expect(imported).not.toBeNull(); expect(imported.messages.map(message => message.content)).toEqual(['Hello\nretry', 'Reply']);
    expect(imported.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  it('preserves malicious-looking HTML as inert transcript data and bounds oversized tool payloads', () => {
    const { manager } = create(), source = richConversation();
    source.messages[0].content = '</script><img src=x onerror="alert(1)">\n### Assistant';
    (source.messages[1] as any).toolCalls[0].input = { content: 'x'.repeat(PERSISTED_TOOL_STRING_CAP * 2) };
    const imported = manager.importFromContent(envelope(source), 'untrusted.json')!;
    expect(imported.messages[0].content).toBe(source.messages[0].content);
    expect(imported.messages[1].toolCalls![0].truncated).toBe(true);
    expect((imported.messages[1].toolCalls![0].input.content as string).length).toBe(PERSISTED_TOOL_STRING_CAP);
  });

  it('short text share preserves a system message role instead of attributing it to an assistant', () => {
    const { manager } = create(), source = manager.getCurrentConversation()!;
    manager.addMessage('system', 'Transcript-only system note.'); manager.addMessage('user', 'Hello');
    const imported = manager.importFromShareable(manager.exportToShareable(source.id))!;
    expect(imported.messages.map(message => message.role)).toEqual(['system', 'user']);
  });

  it('inflated payload above the cap is rejected with the original store unchanged', () => {
    const { manager, storage } = create(), before = clone(storage);
    const data = zlib.deflateSync(Buffer.from(JSON.stringify({ t: 'too big', m: [{ r: 'u', c: 'x'.repeat(1024 * 1024 + 1) }] }))).toString('base64url');
    expect(manager.importFromShareable(data)).toBeNull(); expect(storage).toEqual(before);
  });

  it('reports exact share losses even when repetitive long text compresses to a short URI', () => {
    const { manager } = create(), source = manager.getCurrentConversation()!;
    manager.updateConversationTitle(source.id, 'T'.repeat(201));
    for (let n = 0; n < 13; n++) manager.addMessage(n % 2 ? 'assistant' : 'user', n >= 10 ? 'x'.repeat(2001 + n) : `turn ${n}`);
    const info = manager.exportToShareableWithInfo(source.id);
    expect(info).toMatchObject({ totalMessages: 13, includedMessages: 10, omittedMessages: 3, truncatedMessages: 3, titleTruncated: true, metadataOmitted: true });
    expect(info.data.length).toBeLessThan(1900);
    expect(manager.exportToShareable(source.id)).toBe(info.data);
    const short = manager.createNewConversation(); manager.addMessage('user', 'Short complete text');
    expect(manager.exportToShareableWithInfo(short.id)).toMatchObject({ totalMessages: 1, includedMessages: 1, omittedMessages: 0, truncatedMessages: 0, titleTruncated: false });
  });

  it('every imported tool is historical even when the input forges false, while later live tools remain normal', () => {
    const { manager } = create(), source = richConversation();
    (source.messages[1] as any).toolCalls[0].historicalOnly = false;
    const imported = manager.importFromContent(envelope(source), 'task.json')!;
    expect(imported.messages[1].toolCalls![0].historicalOnly).toBe(true);
    expect(manager.getLastImportDiagnostic()).toMatch(/historical.*cannot undo/);
    const live = manager.addMessageToConversation(imported.id, 'assistant', 'New live edit', undefined, undefined, undefined, {
      toolCalls: [{ id: 'live-edit', name: 'Edit', input: { old_string: 'a', new_string: 'b' }, status: 'completed' }],
    });
    expect(live.toolCalls![0].historicalOnly).toBeUndefined();
  });

  it('import diagnostics describe restrictions and reset for each independent import', () => {
    const { manager } = create();
    expect(manager.importFromContent(envelope(), 'full.json')).not.toBeNull();
    expect(manager.getLastImportDiagnostic()).toMatch(/checkpoint/);
    expect(manager.getLastImportDiagnostic()).toMatch(/without embedded file data/);
    expect(manager.importFromContent('{"messages":[{"role":"user","content":"plain"}]}', 'simple.json')).not.toBeNull();
    expect(manager.getLastImportDiagnostic()).toBeNull();
    expect(manager.importFromContent('{"role":"user","content":"valid"}\n{', 'broken.jsonl')).toBeNull();
    expect(manager.getLastImportDiagnostic()).toMatch(/line 2.*no messages/i);
    expect(manager.importFromContent('\n{"role":"user","content":"valid"}\n{', 'blank-line.jsonl')).toBeNull();
    expect(manager.getLastImportDiagnostic()).toMatch(/line 3.*no messages/i);
  });

  it('accepts BOM, Unicode and case-insensitive JSON/JSONL filenames with CRLF framing', () => {
    const { manager } = create();
    const json = '\uFEFF' + JSON.stringify({ messages: [{ role: 'user', content: 'مرحبا 🧪\r\nLine two  ' }] }, null, 2).replace(/\n/g, '\r\n');
    expect(manager.importFromContent(json, 'TASK.JSON')!.messages[0].content).toBe('مرحبا 🧪\r\nLine two  ');
    const jsonl = '\uFEFF{"role":"human","message":"مرحبا"}\r\n{"role":"assistant","content":"Hi 🧪"}\r\n';
    expect(manager.importFromContent(jsonl, 'TASK.JSONL')!.messages.map(message => [message.role, message.content])).toEqual([['user', 'مرحبا'], ['assistant', 'Hi 🧪']]);
  });

  it('framed Markdown retains exact CRLF content and accepts a complete file converted to CRLF', () => {
    const { manager } = create(), source = manager.getCurrentConversation()!;
    manager.addMessage('user', 'Exact CRLF\r\nTrailing  \r\n');
    const exported = manager.exportToMarkdown(source.id, true);
    expect(manager.importFromContent('\uFEFF' + exported, 'TASK.MD')!.messages[0].content).toBe('Exact CRLF\r\nTrailing  \r\n');
    const second = manager.createNewConversation(); manager.addMessage('assistant', 'Line one\nLine two');
    const windowsFile = manager.exportToMarkdown(second.id, true).replace(/\n/g, '\r\n');
    expect(manager.importFromContent(windowsFile, 'WINDOWS.MD')!.messages[0].content).toBe('Line one\r\nLine two');
    expect(manager.exportToMarkdown(second.id)).not.toContain('mysti-transcript-v1');
  });

  it('a truncated framed Markdown file is rejected without accepting its prefix', () => {
    const { manager, storage } = create(), source = manager.getCurrentConversation()!;
    manager.addMessage('user', 'first'); manager.addMessage('assistant', 'second');
    const exported = manager.exportToMarkdown(source.id, true), before = clone(storage);
    expect(manager.importFromContent(exported.slice(0, exported.lastIndexOf('<!-- mysti-message-end:')), 'cut.md')).toBeNull();
    expect(storage).toEqual(before);
  });

  it('framed Markdown preserves terminal bare carriage returns rather than consuming them as framing', () => {
    const { manager } = create(), source = manager.getCurrentConversation()!;
    const contents = ['User ends with CR\r', 'Assistant ends with two CRs\r\r', 'Embedded\rbare CR\r'];
    for (const content of contents) manager.addMessage('user', content);
    const imported = manager.importFromContent(manager.exportToMarkdown(source.id, true), 'carriage.md')!;
    expect(imported.messages.map(message => message.content)).toEqual(contents);
  });

  it.each(['first start', 'first end', 'unexpected prefix'] as const)('rejects damaged Markdown %s atomically instead of dropping or merging a message', damage => {
    const { manager, storage } = create(), source = manager.getCurrentConversation()!;
    manager.addMessage('user', 'FIRST MESSAGE MUST SURVIVE'); manager.addMessage('assistant', 'SECOND MESSAGE MUST SURVIVE');
    const exported = manager.exportToMarkdown(source.id, true), before = clone(storage);
    const damaged = damage === 'first start' ? exported.replace(/<!-- mysti-message:[^\n]+ -->\n/, '')
      : damage === 'first end' ? exported.replace(/<!-- mysti-message-end:[^\n]+ -->\n/, '')
      : exported.replace(/<!-- mysti-message:/, 'UNFRAMED TEXT MUST NOT DISAPPEAR\n<!-- mysti-message:');
    expect(manager.importFromContent(damaged, 'damaged.md')).toBeNull();
    expect(storage).toEqual(before); expect(manager.getLastImportDiagnostic()).toMatch(/boundary|framing|truncated/i);
  });

  it.each(['completed\"><img src=x onerror=alert(1)>', {}, null, 12])('invalid imported tool status %j becomes a failed historical record with a diagnostic', status => {
    const { manager, context } = create(), source = richConversation();
    (source.messages[1] as any).toolCalls[0].status = status;
    const imported = manager.importFromContent(envelope(source), 'untrusted-status.json')!;
    expect(imported.messages[1].toolCalls![0]).toMatchObject({ status: 'failed', historicalOnly: true,
      input: source.messages[1].toolCalls![0].input, output: source.messages[1].toolCalls![0].output });
    expect(manager.getLastImportDiagnostic()).toMatch(/invalid tool status.*failed/i);
    expect(new ConversationManager(context).getConversation(imported.id)!.messages[1].toolCalls![0].status).toBe('failed');
  });

  it('valid imported tool statuses remain unchanged', () => {
    const { manager } = create(), source = richConversation();
    const original = source.messages[1].toolCalls![0];
    source.messages[1].toolCalls = ['pending', 'running', 'completed', 'failed'].map((status, index) => ({ ...original, id: `tool-${index}`, status }));
    const imported = manager.importFromContent(envelope(source), 'statuses.json')!;
    expect(imported.messages[1].toolCalls!.map(tool => tool.status)).toEqual(['pending', 'running', 'completed', 'failed']);
    expect(manager.getLastImportDiagnostic()).not.toMatch(/invalid tool status/i);
  });

  it.each(['LF', 'CRLF'] as const)('an empty framed Markdown conversation roundtrips with %s framing', ending => {
    const { manager, context } = create(), source = manager.getCurrentConversation()!;
    manager.updateConversationTitle(source.id, 'Empty developer notebook 🧪');
    const exported = manager.exportToMarkdown(source.id, true);
    const imported = manager.importFromContent(ending === 'CRLF' ? exported.replace(/\n/g, '\r\n') : exported, 'empty.md');
    expect(imported).not.toBeNull();
    expect(imported).toMatchObject({ title: source.title, provider: source.provider, model: source.model, messages: [] });
    expect(imported!.id).not.toBe(source.id);
    expect(new ConversationManager(context).getConversation(imported!.id)).toEqual(imported);
  });

  it.each(['missing', 'damaged'] as const)('an empty framed Markdown conversation with a %s footer is rejected atomically', damage => {
    const { manager, storage } = create(), source = manager.getCurrentConversation()!;
    const exported = manager.exportToMarkdown(source.id, true), before = clone(storage);
    const damaged = damage === 'missing' ? exported.slice(0, exported.lastIndexOf('---\n')) : exported.replace('*I was Mysting', '*Corrupted footer');
    expect(manager.importFromContent(damaged, 'empty-broken.md')).toBeNull();
    expect(storage).toEqual(before); expect(manager.getCurrentConversation()!.id).toBe(source.id);
    expect(manager.getLastImportDiagnostic()).toMatch(/invalid|truncated/i);
  });

  it('100 exact JSON transfers and 25 share opens retain independent IDs and supported semantics across reload', () => {
    const fixture = richConversation(), sourceJson = envelope(fixture), { manager, context } = create();
    const conversationIds = new Set<string>(), messageIds = new Set<string>();
    for (let n = 0; n < 100; n++) {
      const imported = manager.importFromContent(sourceJson, `task-${n}.json`)!;
      expect(imported.messages.map(semantic)).toEqual(fixture.messages.map(semantic));
      expect(conversationIds.has(imported.id)).toBe(false); conversationIds.add(imported.id);
      for (const message of imported.messages) { expect(messageIds.has(message.id)).toBe(false); messageIds.add(message.id); }
      const exported = JSON.parse(manager.exportToJson(imported.id));
      expect(exported.conversation.messages.map(semantic)).toEqual(fixture.messages.map(semantic));
      if (n % 4 === 0) {
        const info = manager.exportToShareableWithInfo(imported.id), opened = manager.importFromShareable(info.data)!;
        expect(opened.messages.map(message => [message.role, message.content])).toEqual(imported.messages.map(message => [message.role, message.content]));
        expect(conversationIds.has(opened.id)).toBe(false); conversationIds.add(opened.id);
        for (const message of opened.messages) { expect(messageIds.has(message.id)).toBe(false); messageIds.add(message.id); }
      }
    }
    const expected = clone(manager.getAllConversations());
    expect(clone(new ConversationManager(context).getAllConversations())).toEqual(expected);
    expect(conversationIds.size).toBe(125); expect(messageIds.size).toBe(375);
  });
});

describe('PC-12 persisted tool evidence', () => {
  it('retains proposed and unconfirmed states through storage, restart and JSON export/import', () => {
    const { manager, context } = create(), source = manager.getCurrentConversation()!;
    manager.addMessageToConversation(source.id, 'assistant', 'A suggestion and an unreported execution.', undefined, undefined, undefined, {
      provider: 'ollama', toolCalls: [
        { id: 'proposal', name: 'Edit', input: { old_string: 'old', new_string: 'new' }, status: 'proposed', proposalOnly: true },
        { id: 'unreported', name: 'Read', input: { file_path: '/owned/source.ts' }, status: 'unconfirmed' },
      ],
    });
    const restarted = new ConversationManager(context);
    const tools = restarted.getConversation(source.id)!.messages.at(-1)!.toolCalls!;
    expect(tools.map(tool => tool.status)).toEqual(['proposed', 'unconfirmed']);
    expect(tools[0].proposalOnly).toBe(true);
    const imported = restarted.importFromContent(restarted.exportToJson(source.id), 'evidence.json')!;
    expect(imported.messages.at(-1)!.toolCalls).toEqual(tools.map(tool => ({ ...tool, historicalOnly: true })));
  });

  it('normalizes a proposal-only completed import to proposed while retaining its recorded input', () => {
    const { manager } = create(), source = richConversation();
    Object.assign(source.messages[1].toolCalls![0], { proposalOnly: true, status: 'completed' });
    const imported = manager.importFromContent(envelope(source), 'proposal.json')!;
    expect(imported.messages[1].toolCalls![0]).toMatchObject({ status: 'proposed', proposalOnly: true, historicalOnly: true, input: source.messages[1].toolCalls![0].input });
  });
});
