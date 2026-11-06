import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';

const ROOT = path.resolve(__dirname, '../..');
const diagram = 'flowchart LR\n  Retry --> Delay\n  Delay --> Success';
const mermaidSource = fs.readFileSync(path.join(ROOT, 'resources/mermaid.min.js'), 'utf8');

describe('PC-05 rendering and copy fidelity in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as any[]);
  const message = (id: string, content: string, extra: Record<string, unknown> = {}) =>
    ({ id, role: 'assistant', content, provider: 'openai-codex', model: 'test-model', ...extra });
  const complete = async (id: string, content: string, extra: Record<string, unknown> = {}) => {
    await receive('responseStarted', { provider: 'openai-codex', model: 'test-model' });
    await receive('responseComplete', { message: message(id, content, extra) });
  };
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://mysti.test/mermaid.js', route => route.fulfill({ contentType: 'application/javascript',
      body: mermaidSource + `\n;(() => {
        const original = window.mermaid.render.bind(window.mermaid);
        window.__pc05DiagramCalls = 0; window.__pc05ReleaseDiagrams = [];
        window.mermaid.render = async (...args) => {
          window.__pc05DiagramCalls++;
          const result = await original(...args);
          if (window.__pc05DelayDiagrams) await new Promise(resolve => window.__pc05ReleaseDiagrams.push(resolve));
          return result;
        };
      })();` }));
    await page.setContent(composeChatHtml().replace('"mermaidUri":""', '"mermaidUri":"https://mysti.test/mermaid.js"'));
    await receive('initialState', { ...INITIAL_STATE, panelId: 'render-owner', conversation: { id: 'original', messages: [] } });
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves literal user HTML through composer send, live rendering and history restoration without double escaping Markdown', async () => {
    // Composer preflight needs the same provider capability manifest as the
    // established composer suite; rendering-only fixtures do not send turns.
    const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
    try {
      await receive('initialState', { ...INITIAL_STATE, panelId: 'render-owner',
        providerManifest: buildProviderManifestPayload(registry), conversation: { id: 'original', messages: [] } });
    } finally { registry.dispose(); }
    const prompt = 'PB13_CONTEXT_READ. Use the attached Context file. Report its fixture_nonce and value. Reply with exactly one line: PB13_CONTEXT_DONE:<fixture_nonce>:<value>. Do not use tools or modify files.';
    const inlineCode = 'Map<string, <value>> & literal &lt;value&gt;';
    const fencedCode = '<value>&<fixture_nonce>\n<div>literal &lt;entity&gt;</div>';
    const content = [prompt,
      '**Markdown survives** and [docs](https://example.com/docs) plus <https://example.com/reference>.',
      '`' + inlineCode + '`', '```html\n' + fencedCode + '\n```',
      'Literal HTML: <b>bold tag</b> and <value>.',
      'Literal script: <script>window.__literalUserHtmlExecuted = true</script>.',
    ].join('\n\n');
    await page.locator('#message-input').fill(content);
    await page.locator('#send-btn').click();
    const sends = (await posted()).filter(event => event.type === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0].payload.content).toBe(content);
    const user = { id: 'literal-user', role: 'user', content: sends[0].payload.content };
    await receive('messageAdded', user);

    const assertUser = async () => {
      const rendered = page.locator('[data-id="literal-user"] .message-content');
      expect(await rendered.locator('p').first().textContent()).toBe(prompt);
      expect(await rendered.locator('strong').textContent()).toBe('Markdown survives');
      expect(await rendered.locator('p > code').textContent()).toBe(inlineCode);
      expect(await rendered.locator('pre > code').textContent()).toBe(fencedCode);
      expect(await rendered.locator('a').evaluateAll(links => links.map(link => ({
        text: link.textContent, href: link.getAttribute('href'),
      })))).toEqual([
        { text: 'docs', href: 'https://example.com/docs' },
        { text: 'https://example.com/reference', href: 'https://example.com/reference' },
      ]);
      expect(await rendered.textContent()).toContain('Literal HTML: <b>bold tag</b> and <value>.');
      expect(await rendered.textContent()).toContain('Literal script: <script>window.__literalUserHtmlExecuted = true</script>.');
      expect(await rendered.locator('value, b, script').count()).toBe(0);
      expect(await page.evaluate(() => (window as any).__literalUserHtmlExecuted)).toBeUndefined();
      expect(await page.locator('.message.user').count()).toBe(1);
    };
    await assertUser();
    await complete('literal-assistant-control', '<strong>Assistant HTML remains formatted</strong>');
    expect(await page.locator('[data-id="literal-assistant-control"] strong').textContent()).toBe('Assistant HTML remains formatted');
    await page.locator('[data-id="literal-user"] .message-code-copy').click();
    expect((await posted()).filter(event => event.type === 'copyToClipboard').at(-1)?.payload.text).toBe(fencedCode);
    await receive('conversationChanged', { id: 'restored', messages: [user] });
    await assertUser();
    await receive('initialState', { ...INITIAL_STATE, panelId: 'render-owner', conversation: { id: 'reopened', messages: [user] } });
    await assertUser();
    expect((await posted()).filter(event => event.type === 'sendMessage')).toHaveLength(1);
  }, 20_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves split UTF-16, Markdown tokens, tables and fenced code through terminal rendering', async () => {
    const code = 'const label = "مرحبا 👩🏽‍💻 e\u0301 <retry> & ready";\n\treturn label;';
    const content = '## Retry 👩🏽‍💻\n\n**Unicode e\u0301 and العربية**\n\n| Attempt | Delay |\n| --- | --- |\n| 1 | 73 |\n\n```javascript\n' + code + '\n```';
    // The outer test deadline alone does not identify a stalled browser call.
    // Record synthetic phase names without changing calls, assertions or waits.
    const startedAt = performance.now();
    const phases: Array<{ operation: string; startedMs: number; completedMs?: number }> = [];
    let pending: typeof phases[number] | undefined;
    const markPhase = (operation: string | null) => {
      const elapsedMs = performance.now() - startedAt;
      if (pending) pending.completedMs = elapsedMs;
      pending = operation === null ? undefined : { operation, startedMs: elapsedMs };
      if (pending) phases.push(pending);
    };
    onTestFailed(() => {
      const elapsedMs = performance.now() - startedAt;
      console.error('[PC-05 UTF-16 failure phases]', JSON.stringify({
        pendingOperation: pending?.operation ?? null,
        elapsedAtFailureHookMs: elapsedMs,
        phases: phases.map(phase => ({ ...phase,
          durationAtFailureHookMs: (phase.completedMs ?? elapsedMs) - phase.startedMs,
        })),
      }));
    });
    markPhase('dispatch responseStarted');
    await receive('responseStarted', { provider: 'openai-codex', model: 'test-model' });
    // Intentionally split surrogate pairs and fence delimiters at every code
    // unit boundary. These are controlled host chunks, not live CLI evidence.
    markPhase('dispatch every UTF-16 code-unit chunk');
    await page.evaluate(value => {
      for (let index = 0; index < value.length; index++) window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'responseChunk', payload: { type: 'text', content: value.slice(index, index + 1) } },
      }));
    }, content);
    markPhase('dispatch responseComplete');
    await receive('responseComplete', { message: message('unicode', content) });
    markPhase('read and assert heading');
    expect(await page.locator('[data-id="unicode"] h2').innerText()).toBe('Retry 👩🏽‍💻');
    markPhase('read and assert table cells');
    expect(await page.locator('[data-id="unicode"] table tbody td').allTextContents()).toEqual(['1', '73']);
    markPhase('read and assert fenced code');
    expect(await page.locator('[data-id="unicode"] pre code').textContent()).toBe(code);
    markPhase('click public Copy code button');
    await page.locator('[data-id="unicode"] .message-code-copy').click();
    markPhase('read and assert clipboard request');
    expect((await posted()).filter(event => event.type === 'copyToClipboard').at(-1)?.payload).toEqual({ text: code, conversationId: 'original', requestId: expect.any(String) });
    markPhase('read and assert no replacement characters');
    expect(await page.locator('#messages').textContent()).not.toContain('\ufffd');
    markPhase('read and assert assistant count');
    expect(await page.locator('.message.assistant').count()).toBe(1);
    markPhase('read and assert Stop visibility');
    expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    markPhase(null);
  });

  for (const [language, code] of [
    ['javascript', 'const values = [\n-1,\n-2,\n-3,\n];'],
    ['bash', 'my-tool \\\n--verbose \\\n-limit=2 \\\n-limit=3'],
  ]) it.skipIf(CHROMIUM_UNAVAILABLE)(`${language}: explicitly fenced code is never guessed to be a diff and copies byte-for-byte`, async () => {
    await complete('code-source', '```' + language + '\n' + code + '\n```');
    expect(await page.locator('[data-id="code-source"] pre code').count()).toBe(1);
    expect(await page.locator('[data-id="code-source"] pre code').textContent()).toBe(code);
    expect(await page.locator('[data-id="code-source"] .file-edit-card').count()).toBe(0);
    await page.locator('[data-id="code-source"] .message-code-copy').click();
    expect((await posted()).filter(event => event.type === 'copyToClipboard').at(-1))
      .toEqual({ type: 'copyToClipboard', payload: { text: code, conversationId: 'original', requestId: expect.any(String) }, panelId: 'render-owner' });
  });

  for (const prefix of ['none', 'text', 'thinking']) it.skipIf(CHROMIUM_UNAVAILABLE)(`${prefix} prefix: the final answer and Markdown copy action appear once without a permanent spinner`, async () => {
    const content = '**Verified** — retry delay is `73ms`.\n\n```js\nreturn 73;\n```';
    await receive('responseStarted', { provider: 'openai-codex', model: 'test-model' });
    if (prefix !== 'none') await receive('responseChunk', { type: prefix, content: prefix === 'text' ? 'Partial answer' : 'Checking the delay.' });
    await receive('responseComplete', { message: message(`final-${prefix}`, content) });
    const answer = page.locator(`[data-id="final-${prefix}"]`);
    expect(await answer.count()).toBe(1);
    expect(await answer.locator('.message-content').innerText()).toContain('Verified');
    expect(await page.locator('.message.streaming, .loading').count()).toBe(0);
    expect(await answer.locator('.message-copy-btn').count()).toBe(1);
    await answer.locator('.message-copy-btn').click();
    expect((await posted()).filter(event => event.type === 'copyMessageMarkdown').at(-1))
      .toEqual({ type: 'copyMessageMarkdown', payload: { messageId: `final-${prefix}`, conversationId: 'original', requestId: expect.any(String) }, panelId: 'render-owner' });
    expect(await answer.locator('.thinking-zone').count()).toBe(prefix === 'thinking' ? 1 : 0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('final authoritative segments preserve interleaved tools and an unstreamed final suffix, identically after restore', async () => {
    const tool = { id: 'read-retry', name: 'read_file', kind: 'read', input: { path: 'retry.ts' }, status: 'running' };
    await receive('responseStarted', { provider: 'openai-codex', model: 'test-model' });
    await receive('responseChunk', { type: 'text', content: 'Before the read.' });
    await receive('toolUse', tool);
    await receive('responseChunk', { type: 'text', content: 'After the read.' });
    const final = message('ordered', 'Before the read.After the read. Final-only finding.', {
      toolCalls: [{ ...tool, status: 'completed', output: 'return 73;' }],
      segments: [{ type: 'text', content: 'Before the read.' }, { type: 'tool', toolCallId: tool.id },
        { type: 'text', content: 'After the read. Final-only finding.' }],
    });
    await receive('responseComplete', { message: final });
    const order = () => page.locator('[data-id="ordered"] .message-body').evaluate(element => Array.from(element.children).map(child =>
      child.classList.contains('tool-call') ? `tool:${(child as HTMLElement).dataset.id}:${child.classList.contains('completed')}` : child.textContent?.trim()));
    expect(await order()).toEqual(['Before the read.', 'tool:read-retry:true', 'After the read. Final-only finding.']);
    await receive('conversationChanged', { id: 'restored', messages: [final] });
    expect(await order()).toEqual(['Before the read.', 'tool:read-retry:true', 'After the read. Final-only finding.']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a long fenced diff can reveal all proposed lines without advertising an applied-edit Revert', async () => {
    const lines = Array.from({ length: 24 }, (_, index) => `+const line${index} = ${index};`);
    await complete('proposal', '```diff\n--- a/retry.ts\n+++ b/retry.ts\n@@ -0,0 +1,24 @@\n' + lines.join('\n') + '\n```');
    const card = page.locator('[data-id="proposal"] .file-edit-card');
    expect(await card.count()).toBe(1);
    expect(await card.locator('.file-edit-revert').count()).toBe(0);
    expect(await card.locator('summary').count()).toBe(1);
    await card.locator('summary').click();
    expect(await card.locator('.file-edit-line-content:visible').last().textContent()).toBe('const line23 = 23;');
    expect((await posted()).some(event => event.type === 'revertFileEdit')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an interrupted partial remains copyable with a failed tool, readable error and unsent queued work', async () => {
    const tool = { id: 'interrupted-read', name: 'read_file', kind: 'read', input: { path: 'retry.ts' }, status: 'running' };
    await receive('responseStarted', { provider: 'openai-codex', model: 'test-model' });
    await receive('responseChunk', { type: 'text', content: 'The retry appears safe.' });
    await receive('toolUse', tool);
    await page.locator('#message-input').fill('Review the cap after this answer');
    await page.locator('#message-input').press('Tab');
    await page.locator('#message-input').fill('Unsent independent note');
    await receive('error', { error: 'Connection closed before a final answer.', message: message('partial', 'The retry appears safe.', {
      toolCalls: [{ ...tool, status: 'failed', output: 'Interrupted before a tool result.' }],
      segments: [{ type: 'text', content: 'The retry appears safe.' }, { type: 'tool', toolCallId: tool.id }],
    }) });
    expect(await page.locator('[data-id="partial"] .message-content').innerText()).toBe('The retry appears safe.');
    expect(await page.locator('[data-id="partial"] .tool-call.failed').count()).toBe(1);
    expect(await page.locator('.message.streaming, .tool-call.running, .loading').count()).toBe(0);
    expect(await page.locator('.message.error').innerText()).toContain('Connection closed before a final answer.');
    expect(await page.locator('#messages').innerText()).not.toContain('[object Object]');
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Review the cap after this answer']);
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent independent note');
    expect((await posted()).filter(event => event.type === 'sendMessage')).toHaveLength(0);
    await page.locator('[data-id="partial"] .message-copy-btn').click();
    expect((await posted()).filter(event => event.type === 'copyMessageMarkdown').at(-1)?.payload).toEqual({ messageId: 'partial', conversationId: 'original', requestId: expect.any(String) });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('rejects raw script URLs and model-supplied form controls while keeping code copy text literal', async () => {
    const hostile = '<img src=x onerror="window.__pc05Injected=1"><script>window.__pc05Injected=2</script>' +
      '<a href="javascript:window.__pc05Injected=3">Bad link</a><a href="data:text/html,evil">Data link</a>' +
      '<button>Approve</button><form><input value="secret"></form>\n\n```html\n<script>literal code only</script>\n```';
    await complete('untrusted', hostile);
    const content = page.locator('[data-id="untrusted"] .message-content');
    expect(await content.locator('script, form, input, button:not(.message-code-copy)').count()).toBe(0);
    expect(await content.evaluate(element => Array.from(element.querySelectorAll('*')).flatMap(child => Array.from(child.attributes)
      .filter(attribute => /^on/i.test(attribute.name) || /^(?:href|xlink:href)$/i.test(attribute.name) && /^\s*(?:javascript|data):/i.test(attribute.value))
      .map(attribute => attribute.name)))).toEqual([]);
    expect(await page.evaluate(() => (window as any).__pc05Injected)).toBeUndefined();
    await content.locator('.message-code-copy').click();
    expect((await posted()).filter(event => event.type === 'copyToClipboard').at(-1)?.payload).toEqual({ text: '<script>literal code only</script>', conversationId: 'original', requestId: expect.any(String) });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('model-supplied HTML cannot impersonate delegated message or file actions with non-button tags', async () => {
    await complete('spoof', '<div class="file-edit-card" data-file-path="retry.ts">' +
      '<span class="file-edit-revert" role="button">Read the proposed explanation</span></div>' +
      '<span class="message-copy-btn" data-message-id="another-chat-answer">Read the notes</span>' +
      '<span id="message-input" style="position:fixed;inset:0" data-second-opinion="1">Untrusted identity</span>');
    const before = (await posted()).length;
    await page.getByText('Read the proposed explanation', { exact: true }).click();
    await page.getByText('Read the notes', { exact: true }).click();
    expect((await posted()).slice(before).filter(event => ['revertFileEdit', 'copyMessageMarkdown', 'copyToClipboard'].includes(event.type))).toEqual([]);
    expect(await page.locator('[data-id="spoof"] .message-content [id], [data-id="spoof"] .message-content [style], [data-id="spoof"] .message-content [data-second-opinion]').count()).toBe(0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a malformed Mermaid diagram leaves readable source and no orphan error SVG, then a valid diagram still renders', async () => {
    const bad = 'flowchart LR\n  A[unterminated';
    await complete('bad-diagram', '```mermaid\n' + bad + '\n```');
    await page.locator('[data-id="bad-diagram"] .mermaid-error').waitFor();
    expect(await page.locator('[data-id="bad-diagram"] .mermaid-error').textContent()).toBe(bad);
    expect(await page.locator('body > div[id^="dmermaid-"]').count()).toBe(0);
    await complete('good-diagram', '```mermaid\n' + diagram + '\n```');
    await page.locator('[data-id="good-diagram"] .mermaid-rendered svg').waitFor();
    expect(await page.evaluate(() => (window as any).__pc05DiagramCalls)).toBe(2);
    expect(await page.locator('body > div[id^="dmermaid-"]').count()).toBe(0);
    expect(await page.locator('[data-id="bad-diagram"] .mermaid-error').textContent()).toBe(bad);
  }, 20_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('late real Mermaid rendering cannot alter the next conversation or its detached predecessor', async () => {
    await page.evaluate(() => { (window as any).__pc05DelayDiagrams = true; });
    await complete('old-diagram', '```mermaid\n' + diagram + '\n```');
    await page.waitForFunction(() => (window as any).__pc05ReleaseDiagrams?.length === 1);
    await page.evaluate(() => { (window as any).__pc05OldBlock = document.querySelector('.mermaid-pending'); });
    await receive('conversationChanged', { id: 'next', messages: [message('new-answer', 'Independent conversation.')] });
    await page.evaluate(async () => { (window as any).__pc05ReleaseDiagrams.splice(0).forEach((release: () => void) => release()); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(await page.locator('#messages .message').count()).toBe(1);
    expect(await page.locator('[data-id="new-answer"] .message-content').textContent()).toContain('Independent conversation.');
    expect(await page.evaluate(() => (window as any).__pc05OldBlock.querySelector('svg'))).toBeNull();
    expect(await page.locator('#messages .mermaid-rendered').count()).toBe(0);
  }, 20_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('disposing a real child document while Mermaid is pending prevents late insertion after frame detachment', async () => {
    await page.evaluate(() => {
      const win = window as any;
      const iframe = document.createElement('iframe'); document.body.appendChild(iframe);
      const child = iframe.contentWindow as any, doc = iframe.contentDocument!;
      child.__pc05DelayDiagrams = true;
      const block = doc.createElement('div'); block.className = 'mermaid-pending'; block.textContent = 'flowchart LR\nOld-->Detached'; doc.body.appendChild(block);
      const renderer = win.MystiMarkdownRenderer.create({ document: doc, mermaidUri: 'https://mysti.test/mermaid.js', getMermaid: () => child.mermaid });
      win.__pc05Child = { iframe, child, block, renderer, task: renderer.renderDiagrams() };
    });
    await page.waitForFunction(() => (window as any).__pc05Child.child.__pc05ReleaseDiagrams?.length === 1);
    expect(await page.evaluate(async () => {
      const pending = (window as any).__pc05Child;
      const releases = pending.child.__pc05ReleaseDiagrams.splice(0);
      pending.renderer.dispose(); pending.iframe.remove(); releases.forEach((release: () => void) => release());
      await pending.task;
      return { connected: pending.iframe.isConnected, lateSvg: !!pending.block.querySelector('svg'),
        temporaryNodes: pending.block.ownerDocument.querySelectorAll('[data-mysti-diagram-work]').length };
    })).toEqual({ connected: false, lateSvg: false, temporaryNodes: 0 });
  }, 20_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('renders 250 controlled replies with 100 code blocks and 25 real diagrams, then survives 500 conversation replacements', async () => {
    const started = Date.now();
    await page.evaluate(() => {
      for (let index = 0; index < 250; index++) {
        const code = index < 100 ? '\n\n```javascript\nconst index = ' + index + ';\n```' : '';
        const chart = index % 10 === 0 ? '\n\n```mermaid\nflowchart LR\nInput' + index + '-->Output' + index + '\n```' : '';
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'responseComplete', payload: { message: {
          id: 'bulk-' + index, role: 'assistant', provider: 'openai-codex', model: 'test-model', content: 'Controlled reply ' + index + code + chart,
        } } } }));
      }
    });
    await page.waitForFunction(() => document.querySelectorAll('#messages .mermaid-rendered').length === 25, undefined, { timeout: 30_000 });
    expect(await page.locator('#messages .message.assistant').count()).toBe(250);
    expect(await page.locator('#messages pre > code').count()).toBe(100);
    expect(await page.locator('#messages .message-code-copy').count()).toBe(100);
    expect(await page.evaluate(() => (window as any).__pc05DiagramCalls)).toBe(25);
    await page.evaluate(() => {
      for (let index = 0; index < 500; index++) window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'conversationChanged', payload: { id: 'switch-' + index, messages: [{ id: 'final-' + index, role: 'assistant',
          provider: 'openai-codex', content: '```javascript\nreturn ' + index + ';\n```' }] },
      } }));
    });
    expect(await page.locator('#messages .message.assistant').count()).toBe(1);
    expect(await page.locator('#messages pre > code').textContent()).toBe('return 499;');
    expect(await page.locator('#messages .mermaid-diagram, [data-mysti-diagram-work]').count()).toBe(0);
    await page.locator('#messages .message-code-copy').click();
    expect((await posted()).filter(event => event.type === 'copyToClipboard')).toEqual([
      { type: 'copyToClipboard', payload: { text: 'return 499;', conversationId: 'switch-499', requestId: expect.any(String) }, panelId: 'render-owner' },
    ]);
    const evidence = { messages: 250, codeBlocks: 100, realDiagrams: 25,
      conversationReplacements: 500, elapsedMs: Date.now() - started, scope: 'Controlled browser payloads; not live model responses, an 8h soak, or a heap-leak proof.' };
    console.log('[PC-05 bounded browser load]', JSON.stringify(evidence));
    if (process.env.MYSTI_PC05_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.MYSTI_PC05_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MYSTI_PC05_ARTIFACT_DIR, 'rendering-load.json'), JSON.stringify(evidence, null, 2));
    }
  }, 45_000);
});
