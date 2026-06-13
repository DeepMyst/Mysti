/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 02 Phase 3.4 — unified message renderer (webview side).
 *
 * Like tests/webview/wizardPanelId.test.ts, these tests extract the REAL
 * functions from the generated webview script and execute them against a
 * minimal fake DOM, so they cannot drift from the shipped artifact:
 *
 *   - renderThinkingZone: ONE collapsible component for both thinking
 *     styles ('streamed' appends deltas, 'complete-blocks' appends block
 *     paragraphs — same widget).
 *   - formatToolSummary: keys off the semantic ToolCall.kind first, raw
 *     tool name second (legacy persisted calls without kind).
 *   - shouldAutoResolveToolCards / renderMessageFooter: tool cards
 *     auto-resolve to 'completed' (with a "result not reported" note) when
 *     the provider's manifest entry has emitsToolResults === false.
 *   - normalizeMessageThinking: handles both persisted thinking shapes
 *     (legacy plain string and Phase 3 { style, content }).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import vm from 'node:vm';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Extraction helpers (same pattern as wizardPanelId.test.ts)
// ---------------------------------------------------------------------------

/** Extract a top-level `function name(...) { ... }` declaration from JS source by brace matching. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`function ${name} not found in webview script`);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

// ---------------------------------------------------------------------------
// Minimal fake DOM — just enough surface for the extracted renderers.
// Selectors used by the code under test are class-only ('.a', '.a.b',
// '.a, .b'), which is all this implements.
// ---------------------------------------------------------------------------

class FakeElement {
  tag: string;
  className = '';
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  textContent = '';
  innerHTML = '';
  title = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  classList: {
    add: (c: string) => void;
    remove: (c: string) => void;
    toggle: (c: string) => void;
    contains: (c: string) => boolean;
  };

  constructor(tag: string) {
    this.tag = tag;
    this.classList = {
      add: (c: string) => {
        const classes = this.className.split(/\s+/).filter(Boolean);
        if (!classes.includes(c)) {
          classes.push(c);
        }
        this.className = classes.join(' ');
      },
      remove: (c: string) => {
        this.className = this.className.split(/\s+/).filter(Boolean)
          .filter((x) => x !== c).join(' ');
      },
      toggle: (c: string) => {
        if (this.classList.contains(c)) {
          this.classList.remove(c);
        } else {
          this.classList.add(c);
        }
      },
      contains: (c: string) => this.className.split(/\s+/).filter(Boolean).includes(c),
    };
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
    child.parentNode = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx === -1) {
      this.children.push(child);
    } else {
      this.children.splice(idx, 0, child);
    }
    return child;
  }

  remove(): void {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }

  private _matchesCompound(compound: string): boolean {
    const wanted = compound.split('.').filter(Boolean);
    const own = this.className.split(/\s+/).filter(Boolean);
    return wanted.length > 0 && wanted.every((c) => own.includes(c));
  }

  private _collectDescendants(out: FakeElement[]): void {
    for (const child of this.children) {
      out.push(child);
      child._collectDescendants(out);
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    const compounds = selector.split(',').map((s) => s.trim());
    const all: FakeElement[] = [];
    this._collectDescendants(all);
    return all.filter((el) => compounds.some((c) => el._matchesCompound(c)));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) };
const escapeHtmlStub = (s: unknown) => String(s);

let html: string;

beforeAll(() => {
  // The chat script was extracted to media/chat/chat.js (Plan 03 Phase 3c
  // Step 1); read it directly as the function-extraction source.
  html = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
});

// ---------------------------------------------------------------------------
// Whole-script syntax check — the renderer edits live inside an embedded
// template literal; a stray backtick or bad escape ships a broken webview.
// ---------------------------------------------------------------------------

describe('webview chat script', () => {
  it('should parse as valid JavaScript after the Phase 3 renderer edits', () => {
    // Post-extraction (Plan 03 Phase 3c Step 1) the script is media/chat/chat.js
    // (loaded here as `html`); parse the whole file.
    expect(html.length).toBeGreaterThan(10000);
    expect(() => new vm.Script(html)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderThinkingZone — ONE collapsible widget for both thinking styles
// ---------------------------------------------------------------------------

describe('renderThinkingZone (unified thinking zone)', () => {
  function runChunks(style: string | undefined, chunks: string[]): { container: FakeElement; zone: FakeElement | null } {
    const src = [
      extractFunction(html, 'findFirstSentenceEnd'),
      extractFunction(html, 'renderThinkingZone'),
    ].join('\n');
    const container = new FakeElement('div');
    const run = new Function(
      'document', 'containerEl', 'style', 'chunks',
      `${src}\nvar zone = null;\nchunks.forEach(function(c) { zone = renderThinkingZone(containerEl, style, c); });\nreturn zone;`
    );
    const zone = run(fakeDocument, container, style, chunks) as FakeElement | null;
    return { container, zone };
  }

  it('streamed: should accumulate deltas into ONE zone and collapse after the first sentence', () => {
    const { container, zone } = runChunks('streamed', [
      'Let me think', ' about this. Then I will look at the file and decide.',
    ]);
    expect(zone).not.toBeNull();
    expect(container.querySelectorAll('.thinking-zone')).toHaveLength(1);
    expect(zone!.classList.contains('collapsible')).toBe(true);
    expect(zone!.querySelector('.thinking-preview')!.textContent).toBe('Let me think about this.');
    expect(zone!.querySelector('.thinking-rest')!.textContent).toBe('Then I will look at the file and decide.');
  });

  it('streamed: should show the partial buffer as preview before a sentence completes', () => {
    const { zone } = runChunks('streamed', ['Still thinki', 'ng without punctuation']);
    expect(zone!.classList.contains('collapsible')).toBe(false);
    expect(zone!.querySelector('.thinking-preview')!.textContent).toBe('Still thinking without punctuation');
    expect(zone!.querySelector('.thinking-rest')!.textContent).toBe('');
  });

  it('complete-blocks: should append whole thoughts as paragraphs into the SAME single zone', () => {
    const { container, zone } = runChunks('complete-blocks', [
      'First complete thought.',
      'Second complete thought.',
    ]);
    // Old behavior was one .thinking-block per thought — unified zone is ONE
    expect(container.querySelectorAll('.thinking-zone')).toHaveLength(1);
    expect(zone!.classList.contains('collapsible')).toBe(true);
    expect(zone!.querySelector('.thinking-preview')!.textContent).toBe('First complete thought.');
    expect(zone!.querySelector('.thinking-rest')!.textContent).toBe('Second complete thought.');
  });

  it('both styles should render the same widget (identical class shape)', () => {
    const streamed = runChunks('streamed', ['Thought one. More detail here.']).zone!;
    const blocks = runChunks('complete-blocks', ['Thought one. More detail here.']).zone!;
    expect(streamed.className).toBe(blocks.className);
    expect(streamed.querySelector('.thinking-preview')!.textContent)
      .toBe(blocks.querySelector('.thinking-preview')!.textContent);
  });

  it('should return null without content or container', () => {
    const src = [
      extractFunction(html, 'findFirstSentenceEnd'),
      extractFunction(html, 'renderThinkingZone'),
    ].join('\n');
    const run = new Function(
      'document', 'containerEl', 'style', 'content',
      `${src}\nreturn renderThinkingZone(containerEl, style, content);`
    );
    expect(run(fakeDocument, new FakeElement('div'), 'streamed', '')).toBeNull();
    expect(run(fakeDocument, null, 'streamed', 'thinking')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatToolSummary — kind-first keying, raw name fallback
// ---------------------------------------------------------------------------

describe('formatToolSummary (kind-first)', () => {
  function summarize(toolCall: unknown): string {
    const src = extractFunction(html, 'formatToolSummary');
    const run = new Function(
      'cleanPathsInString', 'makeRelativePath', 'toolCall',
      `${src}\nreturn formatToolSummary(toolCall);`
    );
    return run(
      (s: string) => `clean(${s})`,
      (p: string) => `rel(${p})`,
      toolCall
    );
  }

  it('should key off kind FIRST: search kind wins over the raw-name path fallback', () => {
    // With kind 'search' the pattern is shown; the legacy raw-name default
    // for an unknown name would have returned just rel(/src) from input.path.
    expect(summarize({
      name: 'search_files', kind: 'search',
      input: { pattern: 'TODO', path: '/src' },
    })).toBe('TODO in rel(/src)');
    // Same input WITHOUT kind takes the legacy default branch
    expect(summarize({
      name: 'search_files',
      input: { pattern: 'TODO', path: '/src' },
    })).toBe('rel(/src)');
  });

  it('should summarize execute kind from description, then command — for any raw name', () => {
    expect(summarize({
      name: 'run_shell_command', kind: 'execute',
      input: { command: 'npm test', description: 'Run tests' },
    })).toBe('clean(Run tests)');
    expect(summarize({
      name: 'execute_command', kind: 'execute',
      input: { command: 'npm test' },
    })).toBe('clean(npm test)');
  });

  it('should summarize read/edit kinds from path fields regardless of raw name', () => {
    expect(summarize({ name: 'BashOutput', kind: 'read', input: { path: '/a/b.ts' } }))
      .toBe('rel(/a/b.ts)');
    expect(summarize({ name: 'write_to_file', kind: 'edit', input: { file_path: '/a/c.ts' } }))
      .toBe('rel(/a/c.ts)');
    expect(summarize({ name: 'NotebookEdit', kind: 'edit', input: { notebook_path: '/n.ipynb' } }))
      .toBe('rel(/n.ipynb)');
  });

  it('should summarize fetch kind from url or query', () => {
    expect(summarize({ name: 'google_web_search', kind: 'fetch', input: { query: 'vitest docs' } }))
      .toBe('vitest docs');
    expect(summarize({ name: 'web_fetch', kind: 'fetch', input: { url: 'https://x.test' } }))
      .toBe('https://x.test');
  });

  it('should summarize think kind todo lists with a count', () => {
    expect(summarize({ name: 'TodoWrite', kind: 'think', input: { todos: [{}, {}, {}] } }))
      .toBe('3 items');
  });

  it("should fall back to the raw-name switch for kind 'other' and for legacy calls without kind", () => {
    expect(summarize({ name: 'Task', kind: 'other', input: { description: 'Spawn agent' } }))
      .toBe('Spawn agent');
    // Legacy persisted call (no kind) still works through the name switch
    expect(summarize({ name: 'Bash', input: { command: 'ls', description: 'List files' } }))
      .toBe('clean(List files)');
  });

  it('should return empty string without input', () => {
    expect(summarize({ name: 'Bash', kind: 'execute' })).toBe('');
    expect(summarize(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Footer auto-resolve decision + renderMessageFooter
// ---------------------------------------------------------------------------

function manifestState(emitsToolResults: boolean | undefined) {
  return {
    providerManifest: {
      schemaVersion: 1,
      providers: [
        { id: 'agent-a', capabilities: emitsToolResults === undefined ? undefined : { emitsToolResults } },
      ],
    },
  };
}

describe('shouldAutoResolveToolCards (emitsToolResults decision)', () => {
  function decide(state: unknown, providerId: unknown): boolean {
    const src = [
      extractFunction(html, 'getManifestEntry'),
      extractFunction(html, 'shouldAutoResolveToolCards'),
    ].join('\n');
    const run = new Function('state', 'providerId', `${src}\nreturn shouldAutoResolveToolCards(providerId);`);
    return run(state, providerId);
  }

  it('should auto-resolve ONLY when the manifest entry says emitsToolResults === false', () => {
    expect(decide(manifestState(false), 'agent-a')).toBe(true);
    expect(decide(manifestState(true), 'agent-a')).toBe(false);
  });

  it('should never auto-resolve for unknown providers or missing manifest/capabilities', () => {
    expect(decide(manifestState(false), 'agent-unknown')).toBe(false);
    expect(decide(manifestState(undefined), 'agent-a')).toBe(false);
    expect(decide({ providerManifest: null }, 'agent-a')).toBe(false);
    expect(decide({}, undefined)).toBe(false);
  });
});

describe('renderMessageFooter', () => {
  function buildToolCard(status: string): FakeElement {
    const card = new FakeElement('div');
    card.className = `tool-call ${status}`;
    const header = new FakeElement('div');
    header.className = 'tool-call-header';
    const statusEl = new FakeElement('span');
    statusEl.className = `tool-call-status ${status}`;
    statusEl.textContent = status;
    header.appendChild(statusEl);
    card.appendChild(header);
    return card;
  }

  function runFooter(state: unknown, messageEl: FakeElement, usage: unknown, sessionInfo: unknown, pills: string[]) {
    const src = [
      extractFunction(html, 'getManifestEntry'),
      extractFunction(html, 'shouldAutoResolveToolCards'),
      extractFunction(html, 'autoResolveRunningToolCards'),
      extractFunction(html, 'renderMessageFooter'),
    ].join('\n');
    const run = new Function(
      'document', 'state', 'escapeHtml', 'messageEl', 'usage', 'sessionInfo', 'pills',
      `${src}\nreturn renderMessageFooter(messageEl, usage, sessionInfo, pills);`
    );
    return run(fakeDocument, state, escapeHtmlStub, messageEl, usage, sessionInfo, pills) as FakeElement | null;
  }

  it('should auto-resolve running/pending cards with a "not reported" note when emitsToolResults === false', () => {
    const messageEl = new FakeElement('div');
    const body = new FakeElement('div');
    body.className = 'message-body';
    const running = buildToolCard('running');
    const pending = buildToolCard('pending');
    const done = buildToolCard('completed');
    body.appendChild(running);
    body.appendChild(pending);
    body.appendChild(done);
    messageEl.appendChild(body);

    runFooter(manifestState(false), messageEl, null, { provider: 'agent-a' }, []);

    for (const card of [running, pending]) {
      expect(card.classList.contains('completed')).toBe(true);
      expect(card.classList.contains('running')).toBe(false);
      expect(card.classList.contains('pending')).toBe(false);
      expect(card.querySelector('.tool-call-status')!.textContent).toBe('completed');
      const note = card.querySelector('.tool-call-note');
      expect(note).not.toBeNull();
      expect(note!.textContent).toBe('result not reported');
    }
    // Already-resolved card untouched (no note)
    expect(done.querySelector('.tool-call-note')).toBeNull();
  });

  it('should NOT touch running cards when the provider streams tool results', () => {
    const messageEl = new FakeElement('div');
    const running = buildToolCard('running');
    messageEl.appendChild(running);

    runFooter(manifestState(true), messageEl, null, { provider: 'agent-a' }, []);

    expect(running.classList.contains('running')).toBe(true);
    expect(running.querySelector('.tool-call-note')).toBeNull();
  });

  it('should render token usage and degradation pills, and skip the footer entirely when empty', () => {
    const messageEl = new FakeElement('div');
    const footer = runFooter(
      manifestState(true), messageEl,
      { input_tokens: 120, output_tokens: 45 },
      { provider: 'agent-a' },
      ['Stateless']
    );
    expect(footer).not.toBeNull();
    expect(footer!.className).toBe('message-footer');
    expect(footer!.innerHTML).toContain('120 in');
    expect(footer!.innerHTML).toContain('45 out');
    expect(footer!.innerHTML).toContain('Stateless');
    expect(messageEl.querySelector('.message-footer')).not.toBeNull();

    // No usage, no session, no pills -> no footer node at all
    const bare = new FakeElement('div');
    expect(runFooter(manifestState(true), bare, null, { provider: 'agent-a' }, [])).toBeNull();
    expect(bare.querySelector('.message-footer')).toBeNull();
  });

  it('should replace an existing footer instead of stacking (live done after restore)', () => {
    const messageEl = new FakeElement('div');
    runFooter(manifestState(true), messageEl, { input_tokens: 1, output_tokens: 2 }, { provider: 'agent-a' }, []);
    runFooter(manifestState(true), messageEl, { input_tokens: 3, output_tokens: 4 }, { provider: 'agent-a' }, []);
    const footers = messageEl.querySelectorAll('.message-footer');
    expect(footers).toHaveLength(1);
    expect(footers[0].innerHTML).toContain('3 in');
  });
});

// ---------------------------------------------------------------------------
// normalizeMessageThinking — both persisted thinking shapes
// ---------------------------------------------------------------------------

describe('normalizeMessageThinking', () => {
  function normalize(thinking: unknown): { style: string; content: string } | null {
    const src = extractFunction(html, 'normalizeMessageThinking');
    const run = new Function('thinking', `${src}\nreturn normalizeMessageThinking(thinking);`);
    return run(thinking);
  }

  it('should replay legacy plain-string thinking as one complete block', () => {
    expect(normalize('legacy reasoning')).toEqual({ style: 'complete-blocks', content: 'legacy reasoning' });
  });

  it('should pass through the Phase 3 { style, content } shape', () => {
    expect(normalize({ style: 'streamed', content: 'deltas' }))
      .toEqual({ style: 'streamed', content: 'deltas' });
    expect(normalize({ style: 'complete-blocks', content: 'blocks' }))
      .toEqual({ style: 'complete-blocks', content: 'blocks' });
  });

  it('should normalize unknown styles to complete-blocks and drop empty thinking', () => {
    expect(normalize({ style: 'weird', content: 'x' }))
      .toEqual({ style: 'complete-blocks', content: 'x' });
    expect(normalize('')).toBeNull();
    expect(normalize('   ')).toBeNull();
    expect(normalize({ style: 'streamed', content: '' })).toBeNull();
    expect(normalize(undefined)).toBeNull();
  });
});
