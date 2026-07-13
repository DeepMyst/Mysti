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
 * Pure parsing helpers for agent markdown files (personas and skills).
 * No vscode/fs imports so both the extension host (AgentLoader,
 * SkillDiscoveryService) and tests can share the exact same parsing
 * behavior — what the conformance tests validate is what ships.
 */

/**
 * Canonical per-directory agent file names (lowercase). Supports the
 * Anthropic Agent Skills / gstack convention (`<skill>/SKILL.md`) plus
 * common variants seen in the wild.
 */
export const AGENT_FILE_BASENAMES = ['skill.md', 'skills.md', 'persona.md', 'agent.md', 'index.md', 'role.md'];

/**
 * Parse markdown with YAML frontmatter.
 * Handles: `key: value`, quoted values, block arrays (`- item`) and
 * inline arrays (`[a, b]`). Nested objects are intentionally ignored —
 * agent files only need flat metadata.
 */
export function parseAgentMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!frontmatterMatch) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterStr = frontmatterMatch[1];
  const body = frontmatterMatch[2];

  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of frontmatterStr.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Array item under the current key
    if (trimmed.startsWith('- ') && currentKey) {
      if (!currentArray) {
        currentArray = [];
      }
      currentArray.push(unquote(trimmed.slice(2).trim()));
      frontmatter[currentKey] = currentArray;
    }
    // Key-value pair (top-level only; skip indented nested keys)
    else if (trimmed.includes(':') && !line.startsWith('  ')) {
      // Save previous array if any
      if (currentKey && currentArray) {
        frontmatter[currentKey] = currentArray;
      }

      const colonIndex = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      currentKey = key;
      currentArray = null;

      if (value && !/^[>|][+-]?$/.test(value)) {
        // (block-scalar indicators `>` / `|` are skipped — this flat
        // parser can't fold them, and a literal '>' as the value is
        // worse than letting callers fall back)
        // Inline array: [a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
          frontmatter[key] = value
            .slice(1, -1)
            .split(',')
            .map(v => unquote(v.trim()))
            .filter(v => v.length > 0);
        } else {
          frontmatter[key] = unquote(value);
        }
      }
    }
  }

  return { frontmatter, body };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extract a named section from a markdown body. Accepts heading levels
 * 1–4 (`#` through `####`) — core files historically used `#` while the
 * documented format uses `##`; both must work.
 *
 * Fence-aware: `#` lines inside ``` / ~~~ code blocks are code comments,
 * not headings, and must never terminate a section (a bash `# comment`
 * would otherwise truncate the section mid-fence). A section ends at the
 * next heading of level ≤ max(2, its own level) outside a fence, so
 * H3/H4 subsections stay inside H1/H2 sections while adjacent
 * H3-headed sections still terminate each other.
 */
export function extractAgentSection(body: string, sectionName: string): string | undefined {
  const target = sectionName.trim().toLowerCase();
  const lines = body.split('\n');

  let inFence = false;
  let fenceChar = '';
  let startLevel = 0;
  let collecting = false;
  const collected: string[] = [];

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceChar) {
        inFence = false;
      }
      if (collecting) {
        collected.push(line);
      }
      continue;
    }

    const headingMatch = inFence ? null : line.match(/^(#{1,4})\s+(.*?)\s*$/);

    if (!collecting) {
      if (headingMatch && headingMatch[2].toLowerCase() === target) {
        collecting = true;
        startLevel = headingMatch[1].length;
      }
      continue;
    }

    if (headingMatch && headingMatch[1].length <= Math.max(2, startLevel)) {
      break;
    }
    collected.push(line);
  }

  if (!collecting) {
    return undefined;
  }
  return collected.join('\n').trim();
}

/**
 * Extract a bullet/numbered list from a named section.
 */
export function extractAgentList(body: string, sectionName: string): string[] | undefined {
  const section = extractAgentSection(body, sectionName);
  if (!section) {
    return undefined;
  }

  const items: string[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
      items.push(trimmed.replace(/^[-*]\s|^\d+\.\s/, '').trim());
    }
  }

  return items.length > 0 ? items : undefined;
}

/**
 * Extract the main instructions from a markdown body.
 * Personas use "Key Characteristics", skills use "Instructions"; third
 * party SKILL.md files often have neither, so fall back to the first
 * non-heading prose paragraph.
 */
export function extractAgentInstructions(body: string): string {
  const instructions =
    extractAgentSection(body, 'Key Characteristics') ||
    extractAgentSection(body, 'Instructions');

  if (instructions) {
    return instructions;
  }

  // Fallback: first paragraph that isn't a heading line
  for (const paragraph of body.split(/\n\s*\n/)) {
    const withoutHeadings = paragraph
      .split('\n')
      .filter(line => !line.trim().startsWith('#'))
      .join('\n')
      .trim();
    if (withoutHeadings.length > 0) {
      return withoutHeadings;
    }
  }

  return body.trim();
}

/**
 * Derive a stable kebab-case agent id from a display name or file name.
 * Returns null when nothing usable remains after sanitization.
 */
export function slugifyAgentId(raw: string): string | null {
  const slug = raw
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : null;
}

/**
 * Validate an agent id for use as a directory/file name. Rejects
 * anything that could escape the target directory (path traversal) or
 * that isn't a plain kebab-case slug.
 */
export function isSafeAgentId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}
