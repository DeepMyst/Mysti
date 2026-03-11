/**
 * Tests for the webview @-mention parsing logic.
 * These test the pure parsing functions extracted from webviewContent.ts.
 *
 * Since parseMentionsFromContent lives inside a template string (webview JS),
 * we recreate the parsing logic here for testing.
 */
import { describe, it, expect } from 'vitest';

// ============================================================================
// Recreate the mention parsing logic from webviewContent.ts
// This mirrors the actual implementation so changes there should be reflected here.
// ============================================================================

const AGENT_DISPLAY: Record<string, { shortId: string }> = {
  'claude-code': { shortId: 'claude' },
  'openai-codex': { shortId: 'codex' },
  'google-gemini': { shortId: 'gemini' },
  'cline': { shortId: 'cline' },
  'github-copilot': { shortId: 'copilot' },
  'cursor': { shortId: 'cursor' },
  'openclaw': { shortId: 'openclaw' },
  'opencode': { shortId: 'opencode' },
  'ollama': { shortId: 'ollama' },
  'localai': { shortId: 'localai' },
  'qwen-code': { shortId: 'qwen' },
};

// Build reverse map
const MENTION_SHORT_MAP: Record<string, string> = {};
for (const [id, info] of Object.entries(AGENT_DISPLAY)) {
  MENTION_SHORT_MAP[info.shortId] = id;
}

interface ParsedMention {
  type: 'agent' | 'file';
  value: string;
  displayName: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Mirror of the webview's parseMentionsFromContent after M3/M4/M5 fixes.
 */
function parseMentionsFromContent(content: string, workspaceFileCache: string[] = []): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  // M3: Refined regex — allows alphanumeric, hyphens, dots, slashes, underscores
  const regex = /@([\w\-./]+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const word = match[1].toLowerCase();
    // M5: Check if it's a known agent shortname
    if (MENTION_SHORT_MAP[word]) {
      mentions.push({
        type: 'agent',
        value: MENTION_SHORT_MAP[word],
        displayName: '@' + word,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    } else {
      // M4: File matching with path boundary check — require minimum 3 chars
      if (word.length < 3) { continue; }
      let matchedFile: string | null = null;
      for (const file of workspaceFileCache) {
        const normalized = file.replace(/\\/g, '/');
        const parts = normalized.split('/');
        const fileName = (parts[parts.length - 1] || '').toLowerCase();
        // Exact full path, exact filename, OR path ending with /word
        if (normalized.toLowerCase() === word || fileName === word || normalized.toLowerCase().endsWith('/' + word)) {
          matchedFile = file;
          break;
        }
      }
      if (matchedFile) {
        mentions.push({
          type: 'file',
          value: matchedFile,
          displayName: '@' + word,
          startIndex: match.index,
          endIndex: match.index + match[0].length,
        });
      }
    }
  }
  return mentions;
}

// ============================================================================
// Tests
// ============================================================================

describe('Mention parsing (webview)', () => {
  // =========================================================================
  // 1. Basic agent parsing
  // =========================================================================
  it('should parse @claude into claude-code agent mention', () => {
    const mentions = parseMentionsFromContent('@claude rewrite this');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('agent');
    expect(mentions[0].value).toBe('claude-code');
    expect(mentions[0].displayName).toBe('@claude');
  });

  // =========================================================================
  // 2. Trailing punctuation (M3)
  // =========================================================================
  it('should not capture trailing punctuation like ! or ?', () => {
    // The regex /@([\w\-./]+)/ stops at ! and ? since they're not in the char class
    const mentions1 = parseMentionsFromContent('@claude! help');
    expect(mentions1).toHaveLength(1);
    expect(mentions1[0].value).toBe('claude-code');
    // The "!" should not be part of the match

    const mentions2 = parseMentionsFromContent('@gemini? what');
    expect(mentions2).toHaveLength(1);
    expect(mentions2[0].value).toBe('google-gemini');
  });

  // =========================================================================
  // 3. File mention boundary — short word should NOT match (M4)
  // =========================================================================
  it('should not match @ts against .ts files (too short)', () => {
    const fileCache = ['src/types.ts', 'src/constants.ts', 'src/utils.ts'];
    const mentions = parseMentionsFromContent('@ts something', fileCache);
    expect(mentions).toHaveLength(0); // "ts" is only 2 chars, below minimum 3
  });

  // =========================================================================
  // 4. Valid file mention
  // =========================================================================
  it('should match @utils.ts to src/utils.ts via exact filename', () => {
    const fileCache = ['src/utils.ts', 'src/helpers.ts'];
    const mentions = parseMentionsFromContent('@utils.ts check this', fileCache);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('file');
    expect(mentions[0].value).toBe('src/utils.ts');
  });

  // =========================================================================
  // 5. Unknown agent — not in MENTION_SHORT_MAP (M5)
  // =========================================================================
  it('should not produce any mention for @nonexistent', () => {
    const mentions = parseMentionsFromContent('@nonexistent do something');
    expect(mentions).toHaveLength(0);
  });

  // =========================================================================
  // 6. Mixed mentions — agent + file
  // =========================================================================
  it('should parse both agent and file mentions in one message', () => {
    const fileCache = ['src/utils.ts'];
    const mentions = parseMentionsFromContent('@claude @utils.ts fix the imports', fileCache);
    expect(mentions).toHaveLength(2);
    expect(mentions[0].type).toBe('agent');
    expect(mentions[0].value).toBe('claude-code');
    expect(mentions[1].type).toBe('file');
    expect(mentions[1].value).toBe('src/utils.ts');
  });

  // =========================================================================
  // 7. File path boundary match
  // =========================================================================
  it('should require path separator boundary for file endsWith match', () => {
    const fileCache = ['src/constants.ts', 'src/types.ts'];

    // "constants.ts" should match via exact filename
    const mentions1 = parseMentionsFromContent('@constants.ts help', fileCache);
    expect(mentions1).toHaveLength(1);
    expect(mentions1[0].value).toBe('src/constants.ts');

    // "ants.ts" should NOT match (no path boundary)
    const mentions2 = parseMentionsFromContent('@ants.ts help', fileCache);
    expect(mentions2).toHaveLength(0);
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================
  it('should handle multiple agents in one message', () => {
    const mentions = parseMentionsFromContent('@claude @gemini @codex compare');
    expect(mentions).toHaveLength(3);
    expect(mentions.map(m => m.value)).toEqual(['claude-code', 'google-gemini', 'openai-codex']);
  });

  it('should handle @-mention at end of line without trailing space', () => {
    const mentions = parseMentionsFromContent('help @claude');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].value).toBe('claude-code');
  });

  it('should handle path-like file mentions with slashes', () => {
    const fileCache = ['src/managers/BrainstormManager.ts'];
    const mentions = parseMentionsFromContent('@src/managers/BrainstormManager.ts check', fileCache);
    // The full path should match via endsWith
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('file');
  });
});
