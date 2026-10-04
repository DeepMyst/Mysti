import type { AgentType, Mention } from '../types';
import { PROVIDER_DISPLAY_META } from '../providers/base/ProviderManifest';
import { parseAgentRoleMentions } from '../utils/mentionParser';

/** Resolve tags in the host, including when the webview catalog is still loading. */
export function resolveExplicitMentions(content: string, supplied: Mention[] = []): Mention[] {
  const aliases = new Map<string, string>([['mysti', 'mysti']]);
  for (const [id, meta] of Object.entries(PROVIDER_DISPLAY_META)) {
    aliases.set(id, id); aliases.set(meta.shortId, id);
  }
  const codeSpans = [...content.matchAll(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g)]
    .map(m => [m.index, m.index + m[0].length]);
  const agents: Mention[] = [];
  for (const token of parseAgentRoleMentions(content)) {
    if (token.startIndex > 0 && /[\w/@]/.test(content[token.startIndex - 1])) { continue; }
    if (codeSpans.some(([start, end]) => token.startIndex >= start && token.startIndex < end)) { continue; }
    const value = aliases.get(token.name);
    if (value) { agents.push({ type: 'agent', value, role: token.role, displayName: token.raw,
      startIndex: token.startIndex, endIndex: token.endIndex }); }
  }
  return [...supplied.filter(m => m.type !== 'agent' && !agents.some(a => a.startIndex === m.startIndex)), ...agents]
    .sort((a, b) => a.startIndex - b.startIndex);
}

export interface MentionAssignment {
  agentId: AgentType;
  roleId?: string;
  brief: string;
  advisory: boolean;
}

export interface MentionPhase {
  assignments: MentionAssignment[];
  dependsOnPrevious: boolean;
}

// This is scheduling, not an authority boundary. The pool enforces each role's
// access and the user's policy. Unknown requests stay serial and gated.
const ADVISORY = /\b(opinions?|thoughts?|review|critique|assess|analy[sz]e|explain|compare|recommend|suggest|evaluate|feedback|trade.?offs|what|why|how)\b/i;
const WRITING = /\b(implement|write|edit|fix|refactor|create|delete|remove|install|deploy|commit|push|run|execute|test)\b/i;
const LINK = /^(?:\s|[,;&]|and\b|both\b|also\b|with\b|to\b)*$/i;
const SEQUENCE = /(?:[,;]\s*)?\b(?:then|afterwards|after that|next)\s*[:,]?\s*$/i;

/** Explicit tags are assignments. No model may drop or reassign a participant. */
export function planExplicitMentions(content: string, mentions: Mention[]): MentionPhase[] {
  const agents = mentions.filter(m => m.type === 'agent' && m.value !== 'mysti')
    .sort((a, b) => a.startIndex - b.startIndex);
  if (!agents.length) { return []; }
  const strip = (start: number, end: number) => {
    let text = content.slice(start, end);
    for (const m of [...mentions].sort((a, b) => b.startIndex - a.startIndex)) {
      if (m.startIndex >= start && m.endIndex <= end) {
        text = text.slice(0, m.startIndex - start) + text.slice(m.endIndex - start);
      }
    }
    return text.trim();
  };
  const prefix = strip(0, agents[0].startIndex).replace(/^[@/]mysti\b\s*/i, '').trim();
  const phases: MentionPhase[] = [];
  let group: Mention[] = [];
  let dependent = false;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    group.push(agent);
    const next = agents[i + 1];
    const between = strip(agent.endIndex, next?.startIndex ?? content.length);
    // Adjacent names share the same request: @claude and @codex <question>.
    if (next && LINK.test(between)) { continue; }
    const sequential = !!next && SEQUENCE.test(between);
    const body = between.replace(SEQUENCE, '').replace(/[,;]\s*$/, '').trim();
    const brief = [prefix, body].filter(Boolean).join('\n\n') || strip(0, content.length);
    const assignments = group.map(m => ({
      agentId: m.value as AgentType,
      roleId: m.role,
      brief,
      advisory: !!m.role || (ADVISORY.test(brief) && !WRITING.test(brief)),
    }));
    // Only independent advisory work shares a frontier. Any potentially
    // mutating task is serialized; a role's real access is checked at dispatch.
    const previous = phases[phases.length - 1];
    if (!dependent && previous && !previous.dependsOnPrevious &&
        assignments.every(a => a.advisory) && previous.assignments.every(a => a.advisory)) {
      previous.assignments.push(...assignments);
    } else {
      phases.push({ assignments, dependsOnPrevious: dependent });
    }
    group = [];
    dependent = sequential;
  }
  // Repeated aliases in a shared request are one assignment; explicit chains
  // can still revisit the same provider under a separate run/card identity.
  for (const phase of phases) {
    phase.assignments = phase.assignments.filter((a, i, list) =>
      list.findIndex(b => b.agentId === a.agentId && b.roleId === a.roleId && b.brief === a.brief) === i);
  }
  return phases;
}
