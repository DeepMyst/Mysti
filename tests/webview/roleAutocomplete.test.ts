/**
 * Plan 14: role autocomplete detection (@agent:role). Mirrors the webview
 * logic in media/chat/chat.js (the input-handler role-match + resolveAgentShortName)
 * — keep the two in sync.
 */
import { describe, it, expect } from 'vitest';

const AGENT_DISPLAY: Record<string, { shortId: string }> = {
  'claude-code': { shortId: 'claude' },
  'openai-codex': { shortId: 'codex' },
  'google-gemini': { shortId: 'gemini' },
};
const MENTION_SHORT_MAP: Record<string, string> = {};
const PROVIDER_IDS: string[] = [];
for (const [id, info] of Object.entries(AGENT_DISPLAY)) {
  MENTION_SHORT_MAP[info.shortId] = id;
  PROVIDER_IDS.push(id);
}

// Mirror of chat.js resolveAgentShortName
function resolveAgentShortName(word: string): string | null {
  if (!word) return null;
  const lower = word.toLowerCase();
  if (MENTION_SHORT_MAP[lower]) return lower;
  const hit = PROVIDER_IDS.find(id => id === lower);
  if (hit) return AGENT_DISPLAY[hit].shortId || lower;
  return null;
}

// Mirror of chat.js input-handler role detection
function detectMention(textBeforeCursor: string): { mode: 'role' | 'agent' | 'none'; agent?: string; query?: string } {
  const roleMatch = textBeforeCursor.match(/@([\w\-./]+):([\w-]*)$/);
  const roleAgentShort = roleMatch ? resolveAgentShortName(roleMatch[1]) : null;
  const mentionMatch = textBeforeCursor.match(/@(\S*)$/);
  if (roleMatch && roleAgentShort) {
    return { mode: 'role', agent: roleAgentShort, query: roleMatch[2].toLowerCase() };
  }
  if (mentionMatch) {
    return { mode: 'agent', query: mentionMatch[1].toLowerCase() };
  }
  return { mode: 'none' };
}

describe('role autocomplete detection (webview)', () => {
  it('enters role mode on @agent: with an empty query (shows all roles)', () => {
    expect(detectMention('@gemini:')).toEqual({ mode: 'role', agent: 'gemini', query: '' });
  });

  it('filters roles by the partial after the colon', () => {
    expect(detectMention('review this @gemini:cri')).toEqual({ mode: 'role', agent: 'gemini', query: 'cri' });
  });

  it('resolves a full provider id to its shortId for role mode', () => {
    expect(detectMention('@google-gemini:critic')).toEqual({ mode: 'role', agent: 'gemini', query: 'critic' });
  });

  it('supports hyphenated role partials', () => {
    expect(detectMention('@claude:second-')).toEqual({ mode: 'role', agent: 'claude', query: 'second-' });
  });

  it('does NOT enter role mode for an unknown agent before the colon', () => {
    const r = detectMention('@notanagent:foo');
    expect(r.mode).not.toBe('role');
  });

  it('stays in agent mode for a plain @agent with no colon', () => {
    expect(detectMention('@gem')).toEqual({ mode: 'agent', query: 'gem' });
  });

  it('does not trigger role mode from an earlier mention on the line', () => {
    // Cursor is after "world" — the token under cursor is not a mention.
    expect(detectMention('@gemini:critic hello world')).toEqual({ mode: 'none' });
  });

  it('leaves file paths in agent/file mode, not role mode', () => {
    expect(detectMention('@src/auth.ts')).toEqual({ mode: 'agent', query: 'src/auth.ts' });
  });
});
