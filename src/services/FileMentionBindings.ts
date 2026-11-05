import type { Mention } from '../types';
import { getMentionCodeSpans, isMentionBoundary, parseAgentRoleMentions, parseQuotedFileMentions } from '../utils/mentionParser';
import { resolveExplicitMentions } from './ExplicitMentionPlan';

export type FileMentionBindingResult =
  | { ok: true; mentions: Mention[]; references: readonly FileMentionReference[] }
  | { ok: false; error: string };

/** Host-derived token facts, carried separately from serialized Mention fields. */
export interface FileMentionReference {
  readonly visiblePath: string;
  readonly suppliedPath: string;
  readonly quoted: boolean;
  readonly absolute: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
}

const INVALID_REFERENCE = 'A file reference no longer matches the message. Select the file again before sending.';

/** Match the webview's existing shorthand rules, without resolving a path. */
function matchesPath(visible: string, supplied: string, quoted: boolean): boolean {
  if (visible === supplied) { return true; }
  if (quoted && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(visible)) { return false; }
  const requested = visible.replace(/\\/g, '/').replace(/^\.\//, '');
  const candidate = supplied.replace(/\\/g, '/');
  if (candidate === requested || candidate.endsWith('/' + requested)) { return true; }
  if (quoted) { return false; }
  const lower = requested.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();
  return lowerCandidate === lower || lowerCandidate.endsWith('/' + lower);
}

/**
 * Bind supplied file metadata to complete visible tokens before any host work.
 * This proves lexical identity only: it neither reconstructs paths nor proves
 * workspace membership, shorthand uniqueness, containment, or read permission.
 * Missing metadata stays missing; non-file routing remains the caller's job.
 */
export function validateFileMentionBindings(content: string, supplied: readonly Mention[] = []): FileMentionBindingResult {
  const invalid = (): FileMentionBindingResult => ({ ok: false, error: INVALID_REFERENCE });
  // Messages arrive over a JSON boundary, where TypeScript types do not apply.
  if (typeof content !== 'string' || !Array.isArray(supplied)) { return invalid(); }
  const tokens = new Map<string, { path: string; raw: string; quoted: boolean }>();
  for (const token of parseQuotedFileMentions(content)) {
    tokens.set(`${token.startIndex}:${token.endIndex}`, { path: token.path, raw: token.raw, quoted: true });
  }
  const code = getMentionCodeSpans(content);
  const agents = new Set(resolveExplicitMentions(content).map(mention => mention.startIndex));
  for (const token of parseAgentRoleMentions(content)) {
    if (!isMentionBoundary(content, token.startIndex)
      || code.some(([start, end]) => token.startIndex >= start && token.startIndex < end)
      || agents.has(token.startIndex) || token.name === 'git' || token.name === 'problems'
      || token.name.length < 3) { continue; }
    tokens.set(`${token.startIndex}:${token.endIndex}`, {
      path: token.raw.slice(1).split(':', 1)[0], raw: token.raw, quoted: false,
    });
  }
  const seen = new Set<string>();
  const mentions: Mention[] = [];
  const references: FileMentionReference[] = [];
  for (const mention of supplied) {
    if (!mention || typeof mention !== 'object' || Array.isArray(mention)) { return invalid(); }
    if (mention.type !== 'file') { mentions.push({ ...mention }); continue; }
    const { startIndex, endIndex, value } = mention;
    if (!Number.isSafeInteger(startIndex) || !Number.isSafeInteger(endIndex)
      || startIndex < 0 || endIndex <= startIndex || endIndex > content.length
      || typeof value !== 'string' || !value || value.includes('\0')) { return invalid(); }
    const key = `${startIndex}:${endIndex}`;
    const token = tokens.get(key);
    if (!token || seen.has(key) || !matchesPath(token.path, value, token.quoted)) { return invalid(); }
    seen.add(key);
    mentions.push({ ...mention, displayName: token.raw });
    references.push(Object.freeze({ visiblePath: token.path, suppliedPath: value, quoted: token.quoted,
      absolute: /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(token.path), startIndex, endIndex }));
  }
  return { ok: true, mentions, references: Object.freeze(references) };
}
