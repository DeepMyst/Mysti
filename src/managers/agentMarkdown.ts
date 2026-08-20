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

// ============================================================================
// Plan 20 Phase 0 — content integrity scanning
//
// Agent markdown is prompt-injected content. Two properties have to hold
// before any of it reaches a model or a human reviewer:
//
//   1. What the reviewer SEES is what the model READS. ASCII smuggling maps
//      printable characters into the Unicode Tag Block (U+E0000–U+E007F);
//      the file then "looks like a normal file to any editor, reviewer, or
//      diff tool" while the model reads hidden instructions. Bidi overrides
//      and zero-width spaces do the same job more crudely.
//   2. A stored artifact must never pre-position a coordinator directive.
//      It cannot know a future run's nonce, so a nonce-bearing directive in
//      a file on disk has no legitimate explanation.
//
// Deliberately NOT rejected: emoji, ZWJ/ZWNJ (load-bearing in emoji
// sequences and in Arabic/Indic shaping — rejecting them would break
// legitimate non-Latin content), sample UUIDs, and XML-namespaced markup.
// Over-broad hard-fails turn a security control into an availability bug.
// ============================================================================

/** Severity of a content finding. `reject` blocks the load; `warn` is surfaced. */
export type AgentContentSeverity = 'reject' | 'warn';

export interface AgentContentFinding {
  code:
    | 'invisible-control'
    | 'bidi-override'
    | 'unicode-tag-block'
    | 'forged-directive'
    | 'zero-width-joiner'
    | 'directive-shape'
    | 'remote-resource'
    | 'long-opaque-blob';
  severity: AgentContentSeverity;
  /** Human-readable, safe to render in a review UI. */
  message: string;
  /** Codepoint names / matched shape — never the raw invisible bytes. */
  detail?: string;
}

/**
 * EVERY coordinator directive kind, as a plain literal so this module stays free
 * of extension-host imports.
 *
 * Note this is the whole universe, not `ALL_MYSTI_KINDS` — that constant holds
 * only the always-on read set, while exec/connect/mcp/visual kinds live in
 * sibling constants and are added to the scanner conditionally at runtime. A
 * forged `<look:NONCE>` on disk is exactly as dangerous as a forged `<bash:>`,
 * so storage-time scanning covers all of them unconditionally.
 * `agentContentScan.test.ts` asserts this list equals the union of those
 * constants, so adding a directive kind without updating this one fails the
 * suite rather than silently narrowing the scanner.
 */
export const SCANNED_DIRECTIVE_KINDS = [
  'delegate', 'read', 'ls', 'grep', 'diag', 'remember',
  'write', 'edit', 'bash', 'patch', 'connect', 'mcptool',
  'look', 'act', 'findtool', 'skill', 'canvas', 'canvaspage',
] as const;

const KIND_ALT = SCANNED_DIRECTIVE_KINDS.join('|');
/** `<bash:1a2b3c4d` — a directive carrying something nonce-shaped. Hard reject. */
const FORGED_DIRECTIVE_RE = new RegExp(`<(?:${KIND_ALT}):[0-9a-fA-F]{6,}`);
/** `<bash:` with no nonce — inert today, but a clear statement of intent. Warn. */
const DIRECTIVE_SHAPE_RE = new RegExp(`<(?:${KIND_ALT}):`);

/** Zero-width and format controls with no legitimate role in agent prose. */
const INVISIBLE_RE = /[\u00AD\u180E\u200B\u2060-\u2064]/;
/** Explicit bidi overrides/isolates and directional marks. */
const BIDI_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/** Unicode Tag Block — the ASCII-smuggling carrier. */
const TAG_BLOCK_RE = /[\u{E0000}-\u{E007F}]/u;
/** ZWJ / ZWNJ — legitimate in emoji and Arabic/Indic shaping, so warn only. */
const ZW_JOINER_RE = /[\u200C\u200D]/;
/** Remote sub-resource pulled into a rendered review surface. */
const REMOTE_RESOURCE_RE = /!\[[^\]]{0,200}\]\(\s*https?:\/\/|<(?:img|script|iframe)\b[^>]{0,300}\bsrc\s*=\s*["']?https?:\/\//i;
/** A long unbroken base64-ish run — opaque to a reviewer. */
const LONG_BLOB_RE = /[A-Za-z0-9+/=]{512,}/;

/** Format a codepoint as U+XXXX for a finding's `detail` (never the raw byte). */
function codePointLabel(match: string): string {
  const cp = match.codePointAt(0);
  return cp === undefined ? '?' : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Scan agent markdown for content that defeats human review or forges a
 * coordinator directive. Pure and allocation-light: called on every file at
 * load, so it must stay linear in `content` length (no nested quantifiers).
 */
export function scanAgentContent(content: string): {
  findings: AgentContentFinding[];
  rejected: boolean;
} {
  const findings: AgentContentFinding[] = [];

  const invisible = INVISIBLE_RE.exec(content);
  if (invisible) {
    findings.push({
      code: 'invisible-control',
      severity: 'reject',
      message: 'Contains an invisible formatting character that a human reviewer cannot see.',
      detail: codePointLabel(invisible[0]),
    });
  }

  // A BOM is legitimate at offset 0 only; anywhere else it is a hidden control.
  const strayBom = content.indexOf('\uFEFF', 1);
  if (strayBom > 0) {
    findings.push({
      code: 'invisible-control',
      severity: 'reject',
      message: 'Contains a zero-width no-break space away from the start of the file.',
      detail: `U+FEFF at offset ${strayBom}`,
    });
  }

  const bidi = BIDI_RE.exec(content);
  if (bidi) {
    findings.push({
      code: 'bidi-override',
      severity: 'reject',
      message: 'Contains a bidirectional override, which can make displayed text differ from what is read.',
      detail: codePointLabel(bidi[0]),
    });
  }

  const tagged = TAG_BLOCK_RE.exec(content);
  if (tagged) {
    findings.push({
      code: 'unicode-tag-block',
      severity: 'reject',
      message: 'Contains Unicode Tag Block characters — the carrier for hidden instructions invisible to every editor and diff tool.',
      detail: codePointLabel(tagged[0]),
    });
  }

  const forged = FORGED_DIRECTIVE_RE.exec(content);
  if (forged) {
    findings.push({
      code: 'forged-directive',
      severity: 'reject',
      message: 'Contains a coordinator directive carrying a nonce-shaped token. A stored file cannot know a future run\'s nonce, so this has no legitimate use.',
      detail: forged[0],
    });
  } else {
    const shape = DIRECTIVE_SHAPE_RE.exec(content);
    if (shape) {
      findings.push({
        code: 'directive-shape',
        severity: 'warn',
        message: 'Contains text shaped like a coordinator directive. It is inert without a valid nonce, but review it before trusting this file.',
        detail: shape[0],
      });
    }
  }

  if (ZW_JOINER_RE.test(content)) {
    findings.push({
      code: 'zero-width-joiner',
      severity: 'warn',
      message: 'Contains zero-width joiners. Usually legitimate (emoji sequences, Arabic/Indic shaping) but they can also hide text.',
    });
  }

  if (REMOTE_RESOURCE_RE.test(content)) {
    findings.push({
      code: 'remote-resource',
      severity: 'warn',
      message: 'References a remote image or script. Rendering it would leak a request to a third party.',
    });
  }

  if (LONG_BLOB_RE.test(content)) {
    findings.push({
      code: 'long-opaque-blob',
      severity: 'warn',
      message: 'Contains a long unbroken encoded blob that a reviewer cannot meaningfully read.',
    });
  }

  return { findings, rejected: findings.some(f => f.severity === 'reject') };
}

/**
 * Frontmatter keys that grant AUTHORITY rather than describe content.
 *
 * These are real Claude Code / Agent Skills extension fields. Mysti must never
 * honor them: Claude Code's own documentation concedes that a project skill's
 * `allowed-tools` applies even in an untrusted folder and that "a skill can
 * grant itself broad tool access". Under Mysti's invariant that a workspace may
 * only LOWER authority, a file that tries to raise it is refused outright
 * rather than silently ignored — silent ignoring leaves the author believing
 * the grant took effect, and leaves a reviewer believing it is enforced.
 */
export const AUTHORITY_FRONTMATTER_KEYS = [
  'allowed-tools', 'allowed_tools', 'allowedTools',
  'disallowed-tools', 'disallowed_tools',
  'disable-model-invocation', 'user-invocable',
  'hooks', 'shell', 'background', 'context',
] as const;

/**
 * Reject frontmatter that attempts to grant tool authority. Returns the
 * offending keys (empty when clean). Purely a denylist: unknown descriptive
 * keys stay allowed, so third-party SKILL.md files keep loading.
 */
export function findAuthorityFrontmatterKeys(frontmatter: Record<string, unknown>): string[] {
  const denied = new Set<string>(AUTHORITY_FRONTMATTER_KEYS.map(k => k.toLowerCase()));
  return Object.keys(frontmatter)
    .filter(k => denied.has(k.trim().toLowerCase()))
    .sort();
}
