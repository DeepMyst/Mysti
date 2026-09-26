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
 * Provider-native slash commands.
 *
 * Every backend has its own `/command` vocabulary, and until now Mysti
 * surfaced almost none of it: three providers declared four entries between
 * them, and only one of those was an actual CLI command (it was also dead —
 * it posted a webview message nothing received).
 *
 * The hard part is not the list, it is that **a CLI's interactive commands and
 * its headless commands are two different sets**. Mysti never runs a CLI's TUI;
 * it pipes a prompt into a non-interactive process. So a menu built from a
 * CLI's `/help` output would be mostly entries that break the turn. Verified
 * against the installed binaries:
 *
 *   Claude Code   REPORTS its own list in the `system`/`init` stream-json event
 *                 (`slash_commands` + `skills`), so the catalog below is only a
 *                 pre-first-turn fallback. The `supportsNonInteractive` flag in
 *                 the binary is necessary but NOT sufficient: `/effort` and
 *                 `/rename` carry it and still answer "isn't available in this
 *                 environment", because the reported list also honours
 *                 isEnabled/isHidden. Verified by running them.
 *   Gemini/Qwen   `handleSlashCommand` in non-interactive mode keeps ONLY
 *                 results of type `submit_prompt` and throws `FatalInputError`
 *                 on anything else. Of the builtins that is `/init` alone;
 *                 everything else is `.gemini|.qwen/commands/*.toml`.
 *   OpenCode      `opencode run` takes a message, not a slash command; its
 *                 command files are sent as their own template instead.
 *   Codex         slash handling lives in `tui/`; `codex exec` has none, so a
 *                 passed-through `/compact` would be sent as literal prose.
 *   Copilot/Cursor/Cline/OpenClaw
 *                 TUI-only command tables; their capabilities are reached
 *                 through CLI FLAGS, which is what Mysti settings already set.
 *   Ollama/LocalAI/OpenRouter
 *                 HTTP APIs. No CLI, therefore no native commands at all.
 *
 * So each entry declares HOW it can be run, and nothing is listed that cannot
 * be run at all. A command that is genuinely TUI-only and has no Mysti
 * equivalent is deliberately ABSENT — see the per-provider notes below before
 * adding one back.
 */

import type { ProviderType } from '../../types';

/**
 * How Mysti actually executes a native command.
 *
 * `passthrough` — write `/name args` to the backend as the turn's prompt and
 *   let the CLI expand it. Only for commands verified to survive that CLI's
 *   headless entry point.
 * `expand` — Mysti reads the command's own file off disk and sends its body as
 *   the prompt. For file-backed commands on CLIs whose headless mode does not
 *   expand slash commands; the text sent is the user's own template, nothing
 *   invented.
 * `mysti` — the CLI's command has a Mysti equivalent that already works across
 *   panels and providers (model picker, compaction, session clear). Runs that
 *   instead of shelling the concept out to one backend.
 */
export type NativeCommandExecution =
  | { kind: 'passthrough' }
  | { kind: 'expand' }
  | { kind: 'mysti'; commandId: string };

export interface NativeCommandSpec {
  /** Bare command name as the CLI knows it, no leading slash. */
  name: string;
  /** Shown as the menu subtitle. Taken from the CLI's own help text. */
  description: string;
  /** codicon name for the menu row. */
  icon?: string;
  /** Present when the command takes arguments — the menu then prefills. */
  argumentHint?: string;
  execution: NativeCommandExecution;
  keywords?: string[];
  /**
   * Metadata, not a menu entry: supplies a real description for a command the
   * backend REPORTS, but is never shown on its own.
   *
   * For commands whose availability varies by CLI version. Claude Code 2.1.263
   * offers `/effort` and `/rename`; 2.1.154 reports neither and answers "isn't
   * available in this environment". Listing them unconditionally would offer a
   * broken row on the older CLI, and omitting them entirely would render them
   * in the menu as a bare "Claude Code command".
   */
  metadataOnly?: boolean;
  /**
   * Set on a REPORTED command that the backend called a skill. A skill's real
   * description lives outside anything Mysti can read (Claude Code compresses
   * them into the binary), so the report's own labelling stands rather than
   * being overwritten by a same-named catalog entry — `design` is both a
   * bundled skill and a local Claude Design command, and they are not the same.
   */
  isSkill?: boolean;
}

/** `native:<provider>:<name>` — Mysti-scoped so two CLIs can both own `/compact`. */
export const NATIVE_COMMAND_PREFIX = 'native:';

export function nativeCommandId(provider: ProviderType | string, name: string): string {
  return `${NATIVE_COMMAND_PREFIX}${provider}:${name}`;
}

/**
 * Split a `native:<provider>:<name>` id. Command names may themselves contain
 * `:` (Claude and Gemini both namespace directory-nested commands as
 * `dir:name`), so only the FIRST separator after the provider is significant.
 */
export function parseNativeCommandId(
  id: string
): { provider: string; name: string } | null {
  if (!id.startsWith(NATIVE_COMMAND_PREFIX)) { return null; }
  const rest = id.slice(NATIVE_COMMAND_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) { return null; }
  return { provider: rest.slice(0, sep), name: rest.slice(sep + 1) };
}

/**
 * Read an ACP `available_commands_update` into command specs.
 *
 * The payload comes from the agent process, so nothing in it is trusted for
 * anything but display and for building a `/name` the user explicitly picks:
 * names are restricted to the characters a slash command can contain, both
 * name and description are length-capped, and the list is bounded. A name that
 * does not survive that is dropped rather than sanitized into a DIFFERENT
 * command than the agent meant.
 */
export function parseAcpAvailableCommands(update: Record<string, unknown>): NativeCommandSpec[] {
  const raw = update['availableCommands'] ?? update['available_commands'];
  if (!Array.isArray(raw)) { return []; }

  const out: NativeCommandSpec[] = [];
  for (const item of raw.slice(0, MAX_ACP_COMMANDS)) {
    if (!item || typeof item !== 'object') { continue; }
    const entry = item as Record<string, unknown>;
    const name = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
    if (!ACP_COMMAND_NAME.test(name)) { continue; }

    const description = typeof entry['description'] === 'string'
      ? entry['description'].replace(/\s+/g, ' ').trim().slice(0, 160)
      : '';

    // `input: { hint }` is how ACP says "this command takes arguments".
    const input = entry['input'];
    const hint = input && typeof input === 'object'
      ? (input as Record<string, unknown>)['hint']
      : undefined;

    out.push({
      name,
      description: description || `${name} (agent command)`,
      icon: 'symbol-event',
      argumentHint: typeof hint === 'string' && hint.trim()
        ? hint.replace(/\s+/g, ' ').trim().slice(0, 60)
        : undefined,
      execution: { kind: 'passthrough' },
    });
  }
  return out;
}

/**
 * A backend's OWN report of what commands it has, or `null` for a backend that
 * does not report (or has not yet).
 *
 * The distinction matters: an empty ARRAY means "this session has no commands",
 * which is authoritative and should empty the menu section; `null` means "we do
 * not know yet", which should fall back to the curated catalog. Collapsing the
 * two would either blank the menu before the first turn or keep showing
 * commands a backend has told us it does not have.
 */
export type ReportedNativeCommands = NativeCommandSpec[] | null;

/** Bounded so a misbehaving agent cannot flood the slash menu. */
const MAX_ACP_COMMANDS = 100;

/**
 * What a slash command name may contain.
 *
 * Applies to BOTH sources of untrusted names — an ACP agent's report and a
 * filename on disk. A name becomes menu text and, for a pass-through, part of
 * the prompt sent to the backend, and POSIX filenames may contain whitespace
 * and newlines: `\n` in a name would put a second line into that prompt. A
 * name that does not match is dropped, never repaired — cleaning one up would
 * address a DIFFERENT command than the file or the agent named.
 */
const ACP_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/;

/** True when `name` is safe to render as `/name` and send to a backend. */
export function isValidNativeCommandName(name: string): boolean {
  return ACP_COMMAND_NAME.test(name);
}

/**
 * Read Claude Code's `system`/`init` report into command specs.
 *
 * `slash_commands` is the authoritative set for THIS session — it already
 * accounts for the installed version, enabled plugins, bundled skills and MCP
 * prompts, and it honours isEnabled/isHidden, which the binary's
 * `supportsNonInteractive` flag does not. `skills` is the subset that are
 * skills, used only to label the row.
 *
 * Names are validated the same way an ACP agent's are. They come from a local
 * CLI rather than a remote agent, but they still end up in a `/name` sent back
 * to that CLI, and a name that cannot be addressed is dropped rather than
 * repaired.
 */
export function parseClaudeInitCommands(
  slashCommands: unknown,
  skills: unknown
): ReportedNativeCommands {
  if (!Array.isArray(slashCommands)) { return null; }

  const skillNames = new Set(
    Array.isArray(skills) ? skills.filter((s): s is string => typeof s === 'string') : []
  );

  const out: NativeCommandSpec[] = [];
  const seen = new Set<string>();
  for (const raw of slashCommands.slice(0, MAX_REPORTED_COMMANDS)) {
    if (typeof raw !== 'string') { continue; }
    const name = raw.trim().replace(/^\//, '');
    if (!isValidNativeCommandName(name) || seen.has(name)) { continue; }
    seen.add(name);
    const isSkill = skillNames.has(name);
    out.push({
      name,
      // The report carries names only. A catalog entry for the same name
      // supplies the real description and execution; this is what an
      // uncatalogued one falls back to.
      description: isSkill ? 'Skill provided by Claude Code' : 'Claude Code command',
      icon: isSkill ? 'sparkle' : 'terminal',
      execution: { kind: 'passthrough' },
      isSkill,
    });
  }
  return out;
}

/** Bounded so a pathological report cannot flood the slash menu. */
const MAX_REPORTED_COMMANDS = 200;

/**
 * Curated built-in commands per provider.
 *
 * TOTAL Record on purpose (same rule as PROVIDER_NPM_PACKAGES): a new provider
 * fails `tsc` until its author consciously declares a list — even an empty one
 * — so "does this backend have native commands?" can never be answered by
 * silent omission.
 */
export const NATIVE_COMMANDS: Record<ProviderType, NativeCommandSpec[]> = {
  // ---------------------------------------------------------------------------
  // Claude Code — a FALLBACK only, shown until the CLI reports its real list in
  // the init event (see ClaudeCodeProvider.getDynamicNativeCommands). Every
  // pass-through entry here was run against the CLI and confirmed to work.
  //
  // Deliberately absent, each verified: /effort and /rename ("isn't available
  // in this environment" — they carry supportsNonInteractive but are not in the
  // reported list); /review (gone from 2.1.263, it now comes from the
  // code-review plugin and arrives via the live report when installed);
  // /config /theme /vim /login /doctor /status /resume /diff (no flag at all).
  //
  // Skills — /design and the rest — are compiled INTO the binary as
  // `SKILL-<hash>.md.zst` and extracted at runtime, so no directory scan can
  // find them. They reach the menu through the live report, which is the whole
  // reason that path exists.
  // ---------------------------------------------------------------------------
  'claude-code': [
    {
      name: 'compact',
      description: 'Free up context by summarizing the conversation so far',
      icon: 'fold',
      argumentHint: '[instructions]',
      execution: { kind: 'passthrough' },
      keywords: ['compact', 'summarize', 'context', 'tokens'],
    },
    {
      name: 'context',
      description: 'Visualize current context usage as a colored grid',
      icon: 'graph',
      execution: { kind: 'passthrough' },
      keywords: ['context', 'usage', 'tokens', 'window'],
    },
    {
      name: 'usage',
      description: 'Show session cost, plan usage, and activity stats',
      icon: 'dashboard',
      execution: { kind: 'passthrough' },
      keywords: ['usage', 'cost', 'stats', 'limits'],
    },
    {
      name: 'goal',
      description: 'Set a goal — keep working until the condition is met',
      icon: 'target',
      argumentHint: '<condition>',
      execution: { kind: 'passthrough' },
      keywords: ['goal', 'until', 'loop'],
    },
    {
      name: 'init',
      description: 'Initialize a new CLAUDE.md file with codebase documentation',
      icon: 'file-add',
      execution: { kind: 'passthrough' },
      keywords: ['init', 'claude.md', 'memory', 'docs'],
    },
    {
      name: 'security-review',
      description: 'Complete a security review of the pending changes on the current branch',
      icon: 'shield',
      execution: { kind: 'passthrough' },
      keywords: ['security', 'review', 'audit', 'vulnerability'],
    },
    {
      name: 'reload-skills',
      description: 'Pick up skills added or changed on disk during this session',
      icon: 'refresh',
      execution: { kind: 'passthrough' },
      keywords: ['skills', 'reload', 'refresh'],
    },
    // Mysti already owns these across every provider and panel; routing them to
    // the backend would clear one CLI's session while Mysti's own transcript,
    // token ledger and model dropdown carried on unchanged.
    {
      name: 'clear',
      description: 'Start a new session with empty context',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['clear', 'new', 'reset'],
    },
    {
      name: 'model',
      description: 'Set the AI model for Claude Code',
      icon: 'chip',
      execution: { kind: 'mysti', commandId: 'model:switch' },
      keywords: ['model', 'opus', 'sonnet', 'haiku'],
    },
    // ---------------------------------------------------------------------
    // Metadata only — never shown until the CLI reports the name. Descriptions
    // are the CLI's own, read out of the 2.1.263 binary. Availability varies by
    // release (2.1.154 reports none of these), which is precisely why they are
    // not offered on their own.
    // ---------------------------------------------------------------------
    { name: 'effort', description: 'Set effort level for model usage', icon: 'rocket', argumentHint: '<low|medium|high|xhigh|max>', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['effort', 'reasoning'] },
    { name: 'rename', description: 'Rename the current conversation', icon: 'edit', argumentHint: '<name>', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['rename', 'title'] },
    { name: 'autocompact', description: 'Set how full the context gets before auto-summarizing', icon: 'settings', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['autocompact', 'context'] },
    { name: 'insights', description: 'Generate a report analyzing your Claude Code sessions', icon: 'graph', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['insights', 'report'] },
    { name: 'recap', description: 'Generate a one-line session recap now', icon: 'note', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['recap', 'summary'] },
    { name: 'advisor', description: 'Let Claude consult a stronger model at key moments', icon: 'lightbulb', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['advisor', 'consult'] },
    { name: 'reload-plugins', description: 'Activate pending plugin changes in the current session', icon: 'refresh', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['plugins', 'reload'] },
    { name: 'skill-doctor', description: 'Show which loaded skills are unused and costing context', icon: 'pulse', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['skills', 'context', 'doctor'] },
    { name: 'team-onboarding', description: 'Help teammates ramp on Claude Code with a guide from your usage', icon: 'organization', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['team', 'onboarding'] },
    { name: 'usage-credits', description: 'Configure usage credits or request them from your admin when you hit a limit', icon: 'credit-card', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['credits', 'usage', 'limit'] },
    { name: 'color', description: 'Set the prompt bar color for this session', icon: 'paintcan', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['color', 'theme'] },
    { name: 'import', description: 'Import config from another AI coding agent', icon: 'cloud-download', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['import', 'config', 'migrate'] },
    { name: 'debug', description: 'Enable debug logging for this session and help diagnose issues', icon: 'bug', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['debug', 'logging'] },
    { name: 'mcp', description: 'Manage MCP servers', icon: 'plug', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['mcp', 'servers'] },
    { name: 'config', description: 'Open settings', icon: 'settings-gear', execution: { kind: 'passthrough' }, metadataOnly: true, keywords: ['config', 'settings'] },
  ],

  // ---------------------------------------------------------------------------
  // Codex — `codex exec` (what Mysti spawns) has no slash parser at all; every
  // `/command` lives in the TUI crate. So NOTHING is passthrough here. What is
  // listed maps onto the same capability in Mysti. Custom prompts from
  // ~/.codex/prompts are picked up by discovery and sent by `expand`.
  // ---------------------------------------------------------------------------
  'openai-codex': [
    {
      name: 'new',
      description: 'Start a new Codex session',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['new', 'clear', 'reset'],
    },
    {
      name: 'compact',
      description: 'Summarize the conversation to free up context',
      icon: 'fold',
      execution: { kind: 'mysti', commandId: 'cmd:compact' },
      keywords: ['compact', 'summarize', 'context'],
    },
    {
      name: 'model',
      description: 'Choose the model and reasoning effort',
      icon: 'chip',
      execution: { kind: 'mysti', commandId: 'model:switch' },
      keywords: ['model', 'reasoning', 'effort'],
    },
    {
      name: 'approvals',
      description: 'Choose what Codex can do without asking',
      icon: 'shield',
      execution: { kind: 'mysti', commandId: 'settings:access' },
      keywords: ['approvals', 'permission', 'sandbox', 'access'],
    },
  ],

  // ---------------------------------------------------------------------------
  // Gemini — non-interactive mode keeps only `submit_prompt` results and throws
  // FatalInputError on everything else, which kills the whole turn. Of the ~38
  // builtins exactly one qualifies. /stats /tools /memory /chat /restore etc.
  // are absent for that reason; do not "restore" them.
  // ---------------------------------------------------------------------------
  'google-gemini': [
    {
      name: 'init',
      description: 'Analyzes the project and creates a tailored GEMINI.md file',
      icon: 'file-add',
      execution: { kind: 'passthrough' },
      keywords: ['init', 'gemini.md', 'docs'],
    },
    {
      name: 'clear',
      description: 'Clear conversation history and free up context',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['clear', 'new', 'reset'],
    },
    {
      name: 'compress',
      description: 'Compresses the context by replacing it with a summary',
      icon: 'fold',
      execution: { kind: 'mysti', commandId: 'cmd:compact' },
      keywords: ['compress', 'compact', 'summarize', 'context'],
    },
    {
      name: 'model',
      description: 'Configure the model used for this session',
      icon: 'chip',
      execution: { kind: 'mysti', commandId: 'model:switch' },
      keywords: ['model', 'flash', 'pro'],
    },
    {
      // Added in Gemini CLI 0.58. Mapped rather than passed through: Mysti
      // already drives Gemini's plan mode with `--approval-mode`, and letting
      // the CLI flip it behind Mysti's back would desync the two.
      name: 'plan',
      description: 'Switch to Plan Mode and view current plan',
      icon: 'map',
      execution: { kind: 'mysti', commandId: 'settings:mode' },
      keywords: ['plan', 'mode', 'planning'],
    },
  ],

  // ---------------------------------------------------------------------------
  // Qwen Code — a Gemini CLI fork; same non-interactive filter, same conclusion.
  // ---------------------------------------------------------------------------
  'qwen-code': [
    {
      name: 'init',
      description: 'Analyzes the project and creates a tailored QWEN.md file',
      icon: 'file-add',
      execution: { kind: 'passthrough' },
      keywords: ['init', 'qwen.md', 'docs'],
    },
    {
      name: 'clear',
      description: 'Clear conversation history and free up context',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['clear', 'new', 'reset'],
    },
    {
      name: 'compress',
      description: 'Compresses the context by replacing it with a summary',
      icon: 'fold',
      execution: { kind: 'mysti', commandId: 'cmd:compact' },
      keywords: ['compress', 'compact', 'summarize'],
    },
    {
      name: 'approval-mode',
      description: 'View or change the approval mode for tool usage',
      icon: 'shield',
      execution: { kind: 'mysti', commandId: 'settings:access' },
      keywords: ['approval', 'permission', 'access', 'yolo'],
    },
    {
      // Qwen 0.23 declares `/plan` as interactive-only, so it is mapped to
      // Mysti's mode setting rather than sent to a CLI that would refuse it.
      name: 'plan',
      description: 'Switch to plan mode or exit plan mode',
      icon: 'map',
      execution: { kind: 'mysti', commandId: 'settings:mode' },
      keywords: ['plan', 'mode'],
    },
  ],

  // ---------------------------------------------------------------------------
  // OpenCode — builtin TUI commands (/new /share /undo /themes …) have no
  // headless entry point; the file-backed ones under .opencode/command are
  // picked up by discovery and sent as templates.
  // ---------------------------------------------------------------------------
  'opencode': [
    {
      name: 'new',
      description: 'Start a new OpenCode session',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['new', 'clear', 'session'],
    },
    {
      name: 'compact',
      description: 'Summarize the session to free up context',
      icon: 'fold',
      execution: { kind: 'mysti', commandId: 'cmd:compact' },
      keywords: ['compact', 'summarize', 'context'],
    },
    {
      name: 'models',
      description: 'Switch the model for this session',
      icon: 'chip',
      execution: { kind: 'mysti', commandId: 'model:switch' },
      keywords: ['model', 'models', 'provider'],
    },
  ],

  // ---------------------------------------------------------------------------
  // GitHub Copilot — its interactive commands return UI intents
  // (`add-timeline-entry`, `show-dialog`) rather than prompts, and `copilot -p`
  // passes almost all of them to the MODEL as prose. Verified against 1.0.83:
  // `-p "/context"` and `-p "/model"` made the model go read files and
  // documentation, while `-p "/compact"` WAS intercepted (it answered "Nothing
  // to compact"). Even so `/compact` stays mapped to Mysti's own compaction,
  // which is provider-neutral and works on every backend; the entries below are
  // reached as flags Mysti already sets (--model, --add-dir).
  // ---------------------------------------------------------------------------
  'github-copilot': [
    {
      name: 'clear',
      description: 'Clear the conversation history',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['clear', 'reset', 'history'],
    },
    {
      name: 'model',
      description: 'Select AI model to use',
      icon: 'chip',
      execution: { kind: 'mysti', commandId: 'model:switch' },
      keywords: ['model', 'select'],
    },
    {
      name: 'context',
      description: 'Show context window token usage',
      icon: 'graph',
      execution: { kind: 'mysti', commandId: 'context:show' },
      keywords: ['context', 'tokens', 'usage'],
    },
    {
      name: 'add-dir',
      description: 'Add a directory to the allowed list for file access',
      icon: 'new-folder',
      execution: { kind: 'mysti', commandId: 'context:attach' },
      keywords: ['directory', 'folder', 'allow', 'access'],
    },
    {
      // Present since Copilot CLI 1.0 (the 0.0.x line had no /compact).
      name: 'compact',
      description: 'Summarize the conversation to free up context',
      icon: 'fold',
      execution: { kind: 'mysti', commandId: 'cmd:compact' },
      keywords: ['compact', 'summarize', 'context'],
    },
  ],

  // ---------------------------------------------------------------------------
  // Cursor — `cursor-agent -p` takes a prompt only. Project commands live in
  // .cursor/commands and are picked up by discovery (`expand`).
  // ---------------------------------------------------------------------------
  'cursor': [
    {
      name: 'new-chat',
      description: 'Start a new Cursor session',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['new', 'clear', 'chat'],
    },
    {
      name: 'model',
      description: 'Switch the model for this session',
      icon: 'chip',
      execution: { kind: 'mysti', commandId: 'model:switch' },
      keywords: ['model', 'switch'],
    },
  ],

  // ---------------------------------------------------------------------------
  // Cline — the CLI takes a prompt or a `task` subcommand; plan/act is a flag
  // (--mode), which is why /plan-act maps onto Mysti's mode setting. Workflows
  // under .clinerules/workflows are discovered and sent by `expand`.
  // ---------------------------------------------------------------------------
  'cline': [
    {
      name: 'newtask',
      description: 'Start a new Cline task with a clean context',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['new', 'task', 'clear'],
    },
    {
      name: 'plan-act',
      description: 'Switch between plan and act modes',
      icon: 'map',
      execution: { kind: 'mysti', commandId: 'cline:plan-act' },
      keywords: ['plan', 'act', 'mode'],
    },
    {
      name: 'smol',
      description: 'Condense the conversation to free up context',
      icon: 'fold',
      execution: { kind: 'mysti', commandId: 'cmd:compact' },
      keywords: ['smol', 'compact', 'condense', 'context'],
    },
  ],

  // ---------------------------------------------------------------------------
  // OpenClaw — `openclaw agent --json` runs one turn; its `/`-commands belong to
  // the interactive shell and the chat channels, not to this entry point.
  // ---------------------------------------------------------------------------
  'openclaw': [
    {
      name: 'new',
      description: 'Start a new OpenClaw session',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['new', 'clear', 'session'],
    },
    {
      name: 'model',
      description: 'Switch the model for this session',
      icon: 'chip',
      execution: { kind: 'mysti', commandId: 'model:switch' },
      keywords: ['model', 'switch'],
    },
  ],

  // ---------------------------------------------------------------------------
  // Hermes / Kimi Code — ACP backends. Their real command list arrives at
  // runtime in `session/update -> available_commands_update`, so the static
  // catalog stays minimal and the provider merges the live list on top.
  // ---------------------------------------------------------------------------
  'hermes': [
    {
      name: 'new',
      description: 'Start a new Hermes session',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['new', 'clear', 'session'],
    },
  ],
  'kimi-code': [
    {
      name: 'new',
      description: 'Start a new Kimi Code session',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['new', 'clear', 'session'],
    },
  ],

  // ---------------------------------------------------------------------------
  // Continue — `cn -p` headless print mode; slash commands are a TUI feature.
  // ---------------------------------------------------------------------------
  'continue': [
    {
      name: 'clear',
      description: 'Clear the conversation and start fresh',
      icon: 'clear-all',
      execution: { kind: 'mysti', commandId: 'cmd:clear' },
      keywords: ['clear', 'new', 'reset'],
    },
    {
      name: 'model',
      description: 'Switch the configured model',
      icon: 'chip',
      execution: { kind: 'mysti', commandId: 'model:switch' },
      keywords: ['model', 'config'],
    },
  ],

  // ---------------------------------------------------------------------------
  // Pure HTTP-API providers. No CLI is spawned, so there is no native command
  // vocabulary to mirror — the model picker and Mysti's own commands are the
  // whole surface. Empty is the correct answer here, not an oversight.
  // ---------------------------------------------------------------------------
  'ollama': [],
  'localai': [],
  'openrouter': [],
};

/**
 * Where each backend keeps its user-authored commands.
 *
 * `dir` is resolved against the workspace root for `project` scope and the
 * home directory for `user` scope. `ext` filters the files considered.
 * `nested` marks the CLIs that turn a subdirectory into a namespace
 * (`commands/frontend/audit.md` -> `/frontend:audit`).
 */
export interface NativeCommandSource {
  scope: 'user' | 'project';
  /** Path relative to the workspace root (project) or home dir (user). */
  dir: string;
  /** File extension, including the dot. */
  ext: '.md' | '.toml';
  /** Subdirectories become `dir:name` namespaces. */
  nested?: boolean;
  /**
   * A skill directory: each child folder holds a SKILL.md whose *folder* name
   * is the command. This is how Claude Code's `/design` is reached.
   */
  skillDirs?: boolean;
  /** How a discovered command from this source is run. */
  execution: NativeCommandExecution;
}

/**
 * TOTAL Record, same reasoning as NATIVE_COMMANDS: a provider with no
 * file-backed commands must say so with `[]`.
 */
export const NATIVE_COMMAND_SOURCES: Record<ProviderType, NativeCommandSource[]> = {
  // Only what the user actually authored. Deliberately NOT scanned:
  // `~/.claude/plugins/marketplaces/*/plugins/*/commands`, which holds every
  // plugin the marketplace has ever offered rather than the ones installed
  // (`installed_plugins.json` is `{plugins:{}}` on a machine that has browsed
  // one). Listing those would advertise dozens of commands the CLI does not
  // have — the same defect as a stale catalog. Installed plugin commands arrive
  // accurately in the init report instead.
  'claude-code': [
    { scope: 'project', dir: '.claude/commands', ext: '.md', nested: true, execution: { kind: 'passthrough' } },
    { scope: 'user', dir: '.claude/commands', ext: '.md', nested: true, execution: { kind: 'passthrough' } },
    { scope: 'project', dir: '.claude/skills', ext: '.md', skillDirs: true, execution: { kind: 'passthrough' } },
    { scope: 'user', dir: '.claude/skills', ext: '.md', skillDirs: true, execution: { kind: 'passthrough' } },
  ],
  // Gemini/Qwen custom commands are TOML and DO expand in non-interactive mode
  // (they resolve to `submit_prompt`), so they pass through natively.
  // Skills arrived in both after the versions this catalog was first built
  // against (Gemini 0.58, Qwen 0.23). Qwen's registry makes the contract
  // explicit: a command of kind `file`, `skill` or `mcp-prompt` defaults to
  // `["interactive","non_interactive","acp"]`, while a BUILT_IN defaults to
  // interactive-only — which is exactly why so few builtins are listed above
  // and why these pass through.
  'google-gemini': [
    { scope: 'project', dir: '.gemini/commands', ext: '.toml', nested: true, execution: { kind: 'passthrough' } },
    { scope: 'user', dir: '.gemini/commands', ext: '.toml', nested: true, execution: { kind: 'passthrough' } },
    { scope: 'project', dir: '.gemini/skills', ext: '.md', skillDirs: true, execution: { kind: 'passthrough' } },
    { scope: 'user', dir: '.gemini/skills', ext: '.md', skillDirs: true, execution: { kind: 'passthrough' } },
  ],
  'qwen-code': [
    { scope: 'project', dir: '.qwen/commands', ext: '.toml', nested: true, execution: { kind: 'passthrough' } },
    { scope: 'user', dir: '.qwen/commands', ext: '.toml', nested: true, execution: { kind: 'passthrough' } },
    { scope: 'project', dir: '.qwen/skills', ext: '.md', skillDirs: true, execution: { kind: 'passthrough' } },
    { scope: 'user', dir: '.qwen/skills', ext: '.md', skillDirs: true, execution: { kind: 'passthrough' } },
  ],
  // `codex exec` cannot expand a slash command, so Mysti sends the prompt file
  // the user wrote. Same for Cursor and Cline.
  'openai-codex': [
    { scope: 'user', dir: '.codex/prompts', ext: '.md', execution: { kind: 'expand' } },
  ],
  'cursor': [
    { scope: 'project', dir: '.cursor/commands', ext: '.md', execution: { kind: 'expand' } },
    { scope: 'user', dir: '.cursor/commands', ext: '.md', execution: { kind: 'expand' } },
  ],
  'cline': [
    { scope: 'project', dir: '.clinerules/workflows', ext: '.md', execution: { kind: 'expand' } },
    { scope: 'user', dir: 'Documents/Cline/Workflows', ext: '.md', execution: { kind: 'expand' } },
  ],
  // `opencode run` does not expand a slash command in the message, so these are
  // sent as their own template like Codex's and Cursor's.
  //
  // OpenCode does have a higher-fidelity route — `opencode run --command <name>`
  // with the arguments as the message — which would also honour the `!`shell``
  // interpolation its command files allow. Taking it means carrying a pending
  // command name across the send path into buildCliArgs, and a pending value
  // that outlived a cancelled turn would run a command the user never asked
  // for. Not worth that hazard for shell interpolation; revisit only with a
  // consume-once path that is cleared on cancel.
  'opencode': [
    { scope: 'project', dir: '.opencode/command', ext: '.md', nested: true, execution: { kind: 'expand' } },
    { scope: 'user', dir: '.config/opencode/command', ext: '.md', nested: true, execution: { kind: 'expand' } },
  ],
  // Copilot CLI 1.0 has no custom-command or prompt directory of its own.
  'github-copilot': [],
  // `openclaw agent --json` runs one turn and does not parse a slash command,
  // so a skill is sent as its own text rather than as `/name`.
  'openclaw': [
    { scope: 'project', dir: '.openclaw/skills', ext: '.md', skillDirs: true, execution: { kind: 'expand' } },
    { scope: 'user', dir: '.openclaw/skills', ext: '.md', skillDirs: true, execution: { kind: 'expand' } },
  ],
  // Hermes and Kimi report their commands live over ACP instead of from disk.
  'hermes': [],
  'kimi-code': [],
  // `cn -p` is headless print mode with no slash parser — same treatment.
  'continue': [
    { scope: 'project', dir: '.continue/skills', ext: '.md', skillDirs: true, execution: { kind: 'expand' } },
    { scope: 'user', dir: '.continue/skills', ext: '.md', skillDirs: true, execution: { kind: 'expand' } },
  ],
  'ollama': [],
  'localai': [],
  'openrouter': [],
};
