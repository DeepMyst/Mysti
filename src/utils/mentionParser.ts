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

/**
 * Extract every `@name[:role]` token from a string. Pure and dependency-free;
 * resolving `name` to a provider id or file path is the caller's job.
 */
export function parseAgentRoleMentions(content: string): ParsedAgentMention[] {
  const out: ParsedAgentMention[] = [];
  const re = new RegExp(AGENT_ROLE_MENTION_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
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
