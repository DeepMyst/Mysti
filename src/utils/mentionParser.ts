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
 */

/**
 * Canonical @-mention grammar (Plan 14). Matches `@name` and the collaboration
 * form `@name:role` — e.g. `@gemini`, `@google-gemini:critic`, `@src/auth.ts`.
 * Group 1 is the name (agent shortname or file path); group 2 is the optional
 * role id. The webview's `parseMentionsFromContent` (media/chat/chat.js) mirrors
 * this source; keep the two in sync (tests/webview/mentionParsing.test.ts and
 * tests/utils/mentionParser.test.ts both guard it).
 */
export const AGENT_ROLE_MENTION_REGEX = /@([\w\-./]+)(?::([\w-]+))?/g;

export interface ParsedAgentMention {
  /** The token after `@` and before any `:` (lowercased). */
  name: string;
  /** The role id after `:`, if present (lowercased). */
  role?: string;
  /** Start offset of the whole match (including `@`). */
  startIndex: number;
  /** End offset (exclusive) of the whole match. */
  endIndex: number;
  /** The full matched text, e.g. `@gemini:critic`. */
  raw: string;
}

export interface ParsedQuotedFileMention {
  /** Exact decoded path; never lowercased or normalized. */
  path: string;
  startIndex: number;
  endIndex: number;
  /** Visible token, encoded as `@` followed by a JSON string. */
  raw: string;
}

interface QuotedFileSpan {
  startIndex: number;
  endIndex: number;
  closed: boolean;
}

/** Quote syntax is active outside code; code syntax is inactive inside a path. */
function scanMentionSpans(content: string): { quoted: QuotedFileSpan[]; code: Array<[number, number]> } {
  const quoted: QuotedFileSpan[] = [];
  const code: Array<[number, number]> = [];
  let cursor = 0;
  while (cursor < content.length) {
    if (content.startsWith('@"', cursor)) {
      const startIndex = cursor;
      let endIndex = cursor + 2;
      let closed = false;
      while (endIndex < content.length) {
        const char = content[endIndex];
        if (char === '\n' || char === '\r') { break; }
        if (char === '\\') {
          if (content[endIndex + 1] === '\n' || content[endIndex + 1] === '\r') { break; }
          endIndex = Math.min(content.length, endIndex + 2);
          continue;
        }
        endIndex++;
        if (char === '"') { closed = true; break; }
      }
      quoted.push({ startIndex, endIndex, closed });
      cursor = endIndex;
      continue;
    }
    const delimiter = content.startsWith('```', cursor) ? '```'
      : content.startsWith('~~~', cursor) ? '~~~'
        : content[cursor] === '`' ? '`' : undefined;
    if (delimiter) {
      const close = content.indexOf(delimiter, cursor + delimiter.length);
      // Preserve the existing single-line inline-code and fenced-code grammar.
      if (delimiter === '`' && (close < 0 || /[\r\n]/.test(content.slice(cursor + 1, close)))) {
        cursor++;
        continue;
      }
      const end = close < 0 ? content.length : close + delimiter.length;
      code.push([cursor, end]);
      cursor = end;
      continue;
    }
    cursor++;
  }
  return { quoted, code };
}

/** Shared code boundaries prevent filename backticks from hiding later agents. */
export function getMentionCodeSpans(content: string): Array<[number, number]> {
  return scanMentionSpans(content).code;
}

/** An escaped marker or one embedded in an email/path is ordinary text. */
export function isMentionBoundary(content: string, index: number): boolean {
  // Match a complete code point, including astral letters and numbers.
  const previous = Array.from(content.slice(Math.max(0, index - 2), index)).pop() ?? '';
  if (/^[\p{L}\p{N}_/@]$/u.test(previous)) { return false; }
  let escapes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor--) { escapes++; }
  return escapes % 2 === 0;
}

/**
 * Decode visible quoted file tokens, independently of workspace resolution.
 * Suggestions use `@` + JSON.stringify(fullPath). Code, email/path embedding
 * and escaped markers are not references. Invalid tokens remain the UI's job
 * to report; this function neither resolves nor authorizes any path.
 */
export function parseQuotedFileMentions(content: string): ParsedQuotedFileMention[] {
  const out: ParsedQuotedFileMention[] = [];
  for (const span of scanMentionSpans(content).quoted) {
    if (!span.closed || !isMentionBoundary(content, span.startIndex)) { continue; }
    const raw = content.slice(span.startIndex, span.endIndex);
    try {
      const path: unknown = JSON.parse(raw.slice(1));
      if (typeof path === 'string' && path.length > 0 && !path.includes('\0')) {
        out.push({ path, raw, startIndex: span.startIndex, endIndex: span.endIndex });
      }
    } catch { /* The visible malformed token must not become a partial path. */ }
  }
  return out;
}

/**
 * Extract every `@name[:role]` token from a string. Pure and dependency-free;
 * resolving `name` to a provider id or file path is the caller's job.
 */
export function parseAgentRoleMentions(content: string): ParsedAgentMention[] {
  const out: ParsedAgentMention[] = [];
  const quoted = scanMentionSpans(content).quoted;
  let quotedIndex = 0;
  const re = new RegExp(AGENT_ROLE_MENTION_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    while (quotedIndex < quoted.length && quoted[quotedIndex].endIndex <= match.index) { quotedIndex++; }
    if (quotedIndex < quoted.length && match.index >= quoted[quotedIndex].startIndex) { continue; }
    out.push({
      name: match[1].toLowerCase(),
      role: match[2] ? match[2].toLowerCase() : undefined,
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      raw: match[0],
    });
  }
  return out;
}
