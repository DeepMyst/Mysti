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

import {
  AutonomousConfig,
  PermissionActionType,
  PermissionDetails,
  PermissionRequest,
  SafetyClassification,
} from '../types';

/**
 * Patterns that are ALWAYS blocked regardless of configuration.
 * These represent destructive, irreversible, or dangerous operations.
 */
const BLOCKED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // File deletion
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+|--recursive|--force)/, reason: 'Recursive/forced file deletion' },
  // B14: bare `rm` (any rm invocation) — deletion is irreversible even without -rf.
  { pattern: /\brm\s+/, reason: 'File deletion' },
  { pattern: /\brmdir\b/, reason: 'Directory removal' },
  { pattern: /\bdel\s+\/[sS]/, reason: 'Windows recursive deletion' },
  // B14: `find ... -delete` / `find ... -exec` can mutate the filesystem or run
  // arbitrary commands, despite `find` reading like a read-only search.
  { pattern: /\bfind\b[^\n]*\s-delete\b/, reason: 'find -delete removes matched files' },
  { pattern: /\bfind\b[^\n]*\s-(exec|execdir)\b/, reason: 'find -exec runs arbitrary commands on matches' },
  // Destructive git operations.
  // NOTE: force push is detected in screenBashCommand() via the tokenized
  // isForcePush() — NOT a regex here. The previous two-`[^\n]*` pattern straddling
  // a literal `push` was a confirmed cubic ReDoS (a long injected `git push …`
  // hung the classifier synchronously). Tokenization is linear and unbackable.
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Hard reset discards all uncommitted changes' },
  { pattern: /\bgit\s+clean\s+(-[a-zA-Z]*f|--force)/, reason: 'Git clean removes untracked files permanently' },
  { pattern: /\bgit\s+branch\s+(-[a-zA-Z]*D|--delete\s+--force)/, reason: 'Force delete branch' },
  // Database destruction
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: 'Database object deletion' },
  { pattern: /\bDELETE\s+FROM\b/i, reason: 'Database record deletion' },
  { pattern: /\bTRUNCATE\b/i, reason: 'Table truncation' },
  // Privilege escalation
  { pattern: /\bchmod\s+777\b/, reason: 'Setting world-writable permissions' },
  { pattern: /\bchown\s+root\b/, reason: 'Changing ownership to root' },
  { pattern: /\bsudo\b/, reason: 'Sudo command execution' },
  // Data exfiltration via pipe (piping local data OUT to a network command)
  { pattern: /\|\s*(curl|wget|nc|netcat)\b/, reason: 'Piping data to external network command' },
  // B14: pipe-to-shell — download a remote payload and execute it
  // (e.g. `curl https://x | sh`, `wget -qO- url | bash`). The remote command
  // patterns above only catch piping INTO curl/wget, not OUT of them.
  { pattern: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|dash|ksh|python[0-9.]*|node|ruby|perl|pwsh|powershell)\b/, reason: 'Piping a downloaded payload directly into a shell/interpreter' },
  // System-level danger
  { pattern: /\bmkfs\b/, reason: 'Filesystem formatting' },
  { pattern: /\bdd\s+/, reason: 'Low-level disk writing' },
  { pattern: />\s*\/dev\//, reason: 'Writing to device files' },
];

/**
 * Shell metacharacters that turn a single command into a compound/chained
 * command. A "safe" prefix (e.g. `ls`) only guarantees the FIRST token is
 * benign — `ls && rm -rf x`, `cat f; sudo y`, `echo $(rm x)` all start with a
 * safe-looking command but execute something else. We refuse to safe-list any
 * command containing these so the SafetyClassifier never auto-approves a
 * compound command on the strength of its prefix (B14).
 *
 * Note: `>` / `<` are intentionally NOT treated as compound operators here —
 * redirects to sensitive targets are handled by the blocklist (e.g. `> /dev/`),
 * and a benign redirect (e.g. `ls > out.txt`) should not auto-block; it simply
 * falls through to the safety-mode default rather than being safe-listed.
 */
const COMPOUND_OPERATOR_PATTERN = /(&&|\|\||;|\||\n|\$\(|`|>>?\s*\/(?:dev|etc|sys|proc|boot)\b)/;

/**
 * Bash commands that are generally safe to execute.
 *
 * B14: removed `npx` (executes arbitrary packages), bare `echo` (used to splice
 * payloads into other commands / write files via redirect) and bare `find`
 * (can mutate via -delete / -exec — those are blocked above, the rest falls
 * through to the safety-mode default). The remaining entries are read-only or
 * non-destructive build/test commands. Compound commands are rejected before
 * this list is consulted (see classifyBashCommand).
 */
const SAFE_BASH_PATTERNS: RegExp[] = [
  // `less`/`more` dropped — pagers with exec-capable preprocessors don't belong
  // on the auto-approve list (review MED-5).
  /^\s*(ls|cat|head|tail|wc|grep|which|where|pwd|date|whoami)\b/,
  // `npm run <script>` executes arbitrary package.json code (`npm run deploy`),
  // so it is NOT auto-safe — only the fixed read/test subcommands are (review #2).
  /^\s*(npm\s+(test|list|info|ls|outdated|audit))\b/,
  // `node -v/--version` only — NOT `node -e/-p` (arbitrary JS). Review HIGH-2.
  /^\s*node\s+(-v|--version)\b/,
  // Read-only git only — NOT branch/remote/fetch: `git remote set-url`,
  // `git branch -m/-d/<new>`, `git fetch`/`remote update` WRITE .git or hit the
  // network (a `set-url origin <evil>` persists past the sandbox and redirects
  // the user's next push). Review round-3 HIGH.
  /^\s*git\s+(status|log|diff|show|stash\s+list)\b/,
  /^\s*(tsc|eslint|prettier|jest|vitest|mocha|pytest|cargo\s+test)\b/,
  /^\s*(pip\s+(list|show|freeze))\b/,
  /^\s*(cargo\s+(check|clippy|test|build))\b/,
  /^\s*(go\s+(test|vet|build))\b/,
  /^\s*(make\s+(test|check|lint|build))\b/,
];

/**
 * Extra binaries the Mysti COORDINATOR refuses outright (a possibly-weak,
 * prompt-injectable coordinator model must never reach an UNsandboxed sibling
 * or a privileged daemon). Kept separate from the shared BLOCKED_BASH_PATTERNS
 * so CLI-backend autonomous decisions are unchanged.
 *  - macOS launchers/AppleScript (`open`, `osascript`, …) hand work to a
 *    process spawned by launchd OUTSIDE the seatbelt sandbox (Plan 19 review C1).
 *  - unix-socket / daemon-control (`--unix-socket`, `docker`, `socat`, …) can
 *    reach a privileged daemon that the network/fs isolation does not cover.
 */
const COORDINATOR_BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(open|osascript|osacompile|automator|launchctl|plutil|caffeinate)\b/, reason: 'macOS launcher/AppleScript can run code outside the sandbox' },
  { pattern: /\b(unlink|shred)\b/, reason: 'File deletion/wipe' },
  { pattern: /--unix-socket\b/, reason: 'Connecting to a unix-domain socket (e.g. a privileged daemon) bypasses network isolation' },
  { pattern: /\bnc\s+-U\b/, reason: 'netcat to a unix socket' },
  { pattern: /\bsocat\b/, reason: 'socat can bridge to unix sockets / the network' },
  { pattern: /\b(docker|podman|nerdctl|containerd|ctr|kubectl)\b/, reason: 'Container/orchestration control can escape the sandbox' },
];

/**
 * Chaining/backgrounding/redirect operators — the coordinator treats a command
 * containing ANY of these as compound, so a benign prefix can never vouch for a
 * smuggled payload (`git fetch & curl …`, `cat p > ~/.ssh/authorized_keys`).
 * Stricter than the shared COMPOUND_OPERATOR_PATTERN: catches a lone `&` and
 * ALL redirects (Plan 19 review C2/H-redirect).
 */
const COORDINATOR_COMPOUND = /(&|;|\||\n|\r|\$\(|`|<|>)/;

/**
 * Truly READ-ONLY commands — safe even with NO sandbox (unlike npm test /
 * pytest / make, which execute repo-defined code). Deliberately EXCLUDES:
 *  - `env` (a program LAUNCHER: `env node x` runs x; plain `env` also dumps the
 *    host environment incl. secrets) — review HIGH-3;
 *  - `less`/`more` (pagers with exec-capable preprocessors) — review MED-5;
 *  - bare `version` (`npm version patch` REWRITES package.json + git-commits) —
 *    only `-v`/`--version` are read-only — review MED-4.
 */
const READ_ONLY_BASH_PATTERNS: RegExp[] = [
  /^\s*(ls|cat|head|tail|wc|grep|which|where|pwd|date|whoami)\b/,
  /^\s*git\s+(status|log|diff|show|stash\s+list)\b/,
  /^\s*(node|npm|pnpm|yarn|python[0-9.]*|tsc|cargo|go|rustc|deno|bun)\s+(-v|--version)\b/,
];

/**
 * Normalize a command to defeat shell quoting/backslash EVASION of the pattern
 * matchers (`r\m -rf`, `s""udo`, `f""ind … -de""lete`): drop escaping
 * backslashes and surrounding quotes. Screening runs against BOTH the raw and
 * the normalized form (Plan 19 review H-quoting).
 */
function normalizeForScreen(cmd: string): string {
  return cmd.replace(/\\(.)/g, '$1').replace(/['"]/g, '');
}

/**
 * Pure bash screening for the Mysti coordinator's local execution layer
 * (Plan 19). Fail-safe classification of an UNTRUSTED, possibly-injected model
 * command:
 *  - `blockedReason` set ⇒ hard-deny (never gate, never run),
 *  - `compound` ⇒ chained/redirecting — never auto-approved,
 *  - `safe` ⇒ matches the read-only/build allowlist (auto-run only when ALSO
 *    sandboxed),
 *  - `readOnly` ⇒ genuinely read-only (the ONLY thing allowed with no sandbox).
 * Blocked patterns are matched against both the raw and normalized command.
 */
/**
 * Commands that touch a REMOTE system or otherwise CANNOT be rewound by a
 * checkpoint (push, publish, deploy, rsync/scp/ssh, cloud/infra CLIs). Plan 19
 * Phase 3 routes these through a MODAL default-DENY confirmation — the same
 * "checkpoints don't cover remote systems" rule Claude Code uses. Deliberately
 * broad: over-confirming a remote-effect command is cheap; missing one isn't.
 */
const REMOTE_EFFECT_PATTERN = /\b(gh\s|(npm|yarn|pnpm|bun)\s+publish|(npm|yarn|pnpm|bun)\s+run\s+\S*(deploy|publish|release|ship|push|start)|netlify|vercel|(fly|flyctl)\s+(deploy|launch)|wrangler\s+(publish|deploy)|terraform\s+(apply|destroy)|(serverless|sls)\s+deploy|heroku|aws|gcloud|az|firebase\s+deploy|rsync|scp|sftp|ssh|curl|wget|nc|netcat|telnet|rclone|gsutil|s3cmd|mc|b2|doctl|railway|pulumi|cdk|sam\s+deploy|eb\s+deploy|surge|deployctl|http-server|python[0-9.]*\s+-m\s+http\.server|php\s+-S|kubectl\s+(apply|delete|rollout)|helm\s+(install|upgrade|uninstall)|ansible)\b/;

/** git global options that consume the FOLLOWING token as their argument. */
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);

/**
 * Split a command into segments on shell separators so EACH simple command's
 * leading git subcommand is classified independently. A compound like
 * `git status && git push -f` must not hide the push behind a benign first
 * subcommand (review round-5 HIGH). Linear split; over-splitting only ever
 * screens MORE segments (fail-closed), never fewer.
 */
function shellSegments(command: string): string[] {
  return (command || '').split(/[\n\r;|&]+/);
}

/**
 * The git SUBCOMMAND of ONE segment, skipping global options — TOKENIZED (not a
 * regex), so `git -C /r push` is detected without the catastrophic backtracking
 * a nested-quantifier regex would have (a hostile command must never hang the
 * classifier). Returns null when the segment isn't a git invocation.
 * NOTE: no `$` end-anchor — a trailing newline / following line must NOT hide
 * the subcommand (review round-5 HIGH); `.` already stops at `\n` and segments
 * are separator-free after the split.
 */
function gitSubcommandOf(segment: string): string | null {
  const m = /(^|[\s(])git\s+(.+)/.exec(segment);
  if (!m) { return null; }
  const tokens = m[2].trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (GIT_ARG_OPTS.has(t)) { i++; } // its value token is not the subcommand
      continue;
    }
    return t; // first non-option token = the subcommand
  }
  return null;
}

/** The git subcommand of EVERY git segment in a (possibly compound) command. */
function gitSubcommands(command: string): string[] {
  const out: string[] = [];
  for (const seg of shellSegments(command)) {
    const s = gitSubcommandOf(seg);
    if (s) { out.push(s); }
  }
  return out;
}

/** Whether a shell command affects a remote system / can't be undone (Plan 19 Phase 3). */
export function isRemoteEffectCommand(command: string): boolean {
  const c = command || '';
  // Any git segment (not just the first) that reaches a remote counts.
  if (gitSubcommands(c).some(s => s === 'push' || s === 'pull' || s === 'fetch')) { return true; }
  return REMOTE_EFFECT_PATTERN.test(c);
}

/**
 * Force-push detection — TOKENIZED + per-segment, so it can never hang the
 * classifier (the old two-`[^\n]*` regex was a cubic ReDoS) AND can't be hidden
 * behind a benign first subcommand or a trailing newline (round-5). True when
 * ANY git segment is a `push` carrying a force: `--force`, `--force-with-lease[=…]`,
 * a short cluster containing `f` (`-f`, `-fq`), OR a forced refspec (`+ref:ref`).
 */
export function isForcePush(command: string): boolean {
  return shellSegments(command).some(seg => {
    if (gitSubcommandOf(seg) !== 'push') { return false; }
    const m = /(^|[\s(])git\s+(.+)/.exec(seg);
    if (!m) { return false; }
    return m[2].trim().split(/\s+/).some(t =>
      t === '--force' ||
      t === '--force-with-lease' || t.startsWith('--force-with-lease=') ||
      /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) ||
      /^\+/.test(t)); // forced refspec: git push origin +main:main
  });
}

/**
 * Hard ceiling on the command length screened by regex. A single legitimate
 * shell command is never this long (the coordinator's bash tool is "one command,
 * no chaining"); the cap guarantees NO blocklist pattern — present or future —
 * can be weaponized into a synchronous ReDoS by a long injected command. Fail
 * closed: an over-length command is blocked, never silently un-screened.
 */
const MAX_SCREEN_COMMAND_LEN = 4096;

export function screenBashCommand(command: string): { blockedReason?: string; compound: boolean; safe: boolean; readOnly: boolean } {
  const raw = command || '';
  // Length cap BEFORE any regex runs (defense-in-depth, Plan 19 round-4).
  if (raw.length > MAX_SCREEN_COMMAND_LEN) {
    return { blockedReason: 'Command too long to screen safely', compound: false, safe: false, readOnly: false };
  }
  const norm = normalizeForScreen(raw);
  // Force push (tokenized, ReDoS-safe) — replaces the removed two-`[^\n]*` regex.
  if (isForcePush(raw) || isForcePush(norm)) {
    return { blockedReason: 'Force push can overwrite remote history', compound: false, safe: false, readOnly: false };
  }
  for (const { pattern, reason } of [...BLOCKED_BASH_PATTERNS, ...COORDINATOR_BLOCKED_PATTERNS]) {
    if (pattern.test(raw) || pattern.test(norm)) {
      return { blockedReason: reason, compound: false, safe: false, readOnly: false };
    }
  }
  const compound = COORDINATOR_COMPOUND.test(raw) || COORDINATOR_COMPOUND.test(norm);
  const safe = !compound && SAFE_BASH_PATTERNS.some(p => p.test(raw));
  const readOnly = !compound && READ_ONLY_BASH_PATTERNS.some(p => p.test(raw));
  return { compound, safe, readOnly };
}

export class SafetyClassifier {
  private _config: AutonomousConfig;
  private _compiledBlockPatterns: RegExp[] = [];

  constructor(config: AutonomousConfig) {
    this._config = config;
    this._compileBlockPatterns();
  }

  /**
   * Classify a permission request for autonomous decision-making
   */
  classifyPermission(request: PermissionRequest): SafetyClassification {
    // Check file deletion - always blocked
    if (request.actionType === 'file-delete') {
      return {
        level: 'blocked',
        reason: 'File deletion is always blocked in autonomous mode',
        category: 'file-op',
        recommendation: 'auto-deny',
      };
    }

    // Check multi-file edits containing deletions
    if (request.actionType === 'multi-file-edit' && request.details.files) {
      const hasDelete = request.details.files.some(f => f.action === 'delete');
      if (hasDelete) {
        return {
          level: 'blocked',
          reason: 'Multi-file operation contains file deletion',
          category: 'file-op',
          recommendation: 'auto-deny',
        };
      }
    }

    // Check bash commands
    if (request.actionType === 'bash-command' && request.details.command) {
      return this.classifyBashCommand(request.details.command);
    }

    // Classify by action type and safety mode
    return this._classifyByActionType(request.actionType, request.details);
  }

  /**
   * Classify a bash command for safety
   */
  classifyBashCommand(command: string): SafetyClassification {
    // Round-4 ReDoS fix: mirror screenBashCommand — a length cap before any
    // regex runs, and the tokenized force-push block (its regex was removed
    // from BLOCKED_BASH_PATTERNS because two `[^\n]*` straddling `push` was cubic).
    if ((command || '').length > MAX_SCREEN_COMMAND_LEN) {
      return { level: 'blocked', reason: 'Command too long to screen safely', category: 'bash', recommendation: 'auto-deny' };
    }
    if (isForcePush(command)) {
      return { level: 'blocked', reason: 'Force push can overwrite remote history', category: 'bash', recommendation: 'auto-deny' };
    }
    // Check hardcoded blocked patterns first
    for (const { pattern, reason } of BLOCKED_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          level: 'blocked',
          reason,
          category: 'bash',
          recommendation: 'auto-deny',
        };
      }
    }

    // Check user-configured block patterns
    for (const pattern of this._compiledBlockPatterns) {
      if (pattern.test(command)) {
        return {
          level: 'blocked',
          reason: 'Matches user-configured block pattern',
          category: 'bash',
          recommendation: 'auto-deny',
        };
      }
    }

    // Check if it's a known safe command
    if (!this._config.allowBashCommands) {
      return {
        level: 'blocked',
        reason: 'Bash commands disabled in autonomous config',
        category: 'bash',
        recommendation: 'auto-deny',
      };
    }

    // B14: Reject compound/chained commands BEFORE consulting the safe-list.
    // The safe-list matches only the leading token, so `ls && rm -rf x`,
    // `cat f; sudo y` or `echo $(rm x)` would otherwise be auto-approved on the
    // strength of a benign prefix. The blocklist above already caught any
    // compound command that *contains* a known-dangerous fragment; anything
    // still compound here must NOT be safe-listed — fall through to the
    // configured safety-mode default (caution in conservative/balanced).
    if (COMPOUND_OPERATOR_PATTERN.test(command)) {
      return this._classifyBashBySafetyMode(command);
    }

    for (const pattern of SAFE_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          level: 'safe',
          reason: 'Known safe command pattern',
          category: 'bash',
          recommendation: 'auto-approve',
        };
      }
    }

    // Bash commands not matching known patterns are caution
    return this._classifyBashBySafetyMode(command);
  }

  /**
   * Classify a file operation by action and path
   */
  classifyFileOperation(actionType: PermissionActionType, details: PermissionDetails): SafetyClassification {
    return this._classifyByActionType(actionType, details);
  }

  /**
   * Update the configuration (e.g., when user changes settings)
   */
  updateConfig(config: Partial<AutonomousConfig>): void {
    this._config = { ...this._config, ...config };
    this._compileBlockPatterns();
  }

  private _classifyByActionType(actionType: PermissionActionType, details: PermissionDetails): SafetyClassification {
    switch (actionType) {
    case 'file-read':
      return {
        level: 'safe',
        reason: 'Read-only file access',
        category: 'file-op',
        recommendation: 'auto-approve',
      };

    case 'file-create':
      if (!this._config.allowFileCreation) {
        return {
          level: 'blocked',
          reason: 'File creation disabled in autonomous config',
          category: 'file-op',
          recommendation: 'auto-deny',
        };
      }
      return {
        level: 'safe',
        reason: 'Creating a new file (non-destructive)',
        category: 'file-op',
        recommendation: 'auto-approve',
      };

    case 'file-edit':
      if (!this._config.allowFileEdit) {
        return {
          level: 'blocked',
          reason: 'File editing disabled in autonomous config',
          category: 'file-op',
          recommendation: 'auto-deny',
        };
      }
      return this._classifyFileEditBySafetyMode(details);

    case 'file-delete':
      return {
        level: 'blocked',
        reason: 'File deletion is always blocked in autonomous mode',
        category: 'file-op',
        recommendation: 'auto-deny',
      };

    case 'multi-file-edit':
      if (!this._config.allowFileEdit) {
        return {
          level: 'blocked',
          reason: 'File editing disabled in autonomous config',
          category: 'file-op',
          recommendation: 'auto-deny',
        };
      }
      return this._classifyMultiFileEdit(details);

    case 'web-request':
      return {
        level: 'caution',
        reason: 'Network requests may have external effects',
        category: 'network',
        recommendation: 'require-user',
      };

    case 'bash-command':
      if (details.command) {
        return this.classifyBashCommand(details.command);
      }
      return {
        level: 'caution',
        reason: 'Unknown bash command',
        category: 'bash',
        recommendation: 'require-user',
      };

    case 'delegate':
      // Plan 15 Phase 0: delegating to a sub-agent hands it the ability to run
      // arbitrary tools that Mysti cannot individually gate (a native CLI sub-
      // agent's inner writes never surface). Never auto-approve in autonomous
      // mode — always require the user.
      return {
        level: 'caution',
        reason: 'Delegating to a sub-agent can run arbitrary tools',
        category: 'delegation',
        recommendation: 'require-user',
      };

    default:
      return {
        level: 'caution',
        reason: `Unknown action type: ${actionType}`,
        category: 'unknown',
        recommendation: 'require-user',
      };
    }
  }

  private _classifyFileEditBySafetyMode(_details: PermissionDetails): SafetyClassification {
    switch (this._config.safetyMode) {
    case 'conservative':
      return {
        level: 'caution',
        reason: 'Conservative mode: file edits require user confirmation',
        category: 'file-op',
        recommendation: 'require-user',
      };

    case 'balanced':
      // In balanced mode, auto-approve edits to existing workspace files
      return {
        level: 'safe',
        reason: 'Balanced mode: editing existing workspace file',
        category: 'file-op',
        recommendation: 'auto-approve',
      };

    case 'aggressive':
      return {
        level: 'safe',
        reason: 'Aggressive mode: file edits auto-approved',
        category: 'file-op',
        recommendation: 'auto-approve',
      };

    default:
      return {
        level: 'caution',
        reason: 'Unknown safety mode for file edit',
        category: 'file-op',
        recommendation: 'require-user',
      };
    }
  }

  private _classifyMultiFileEdit(details: PermissionDetails): SafetyClassification {
    // Multi-file edits are always at least caution in conservative mode
    if (this._config.safetyMode === 'conservative') {
      return {
        level: 'caution',
        reason: 'Conservative mode: multi-file edits require user confirmation',
        category: 'file-op',
        recommendation: 'require-user',
      };
    }

    // Check if any files are deletions (should already be caught, but defensive)
    if (details.files?.some(f => f.action === 'delete')) {
      return {
        level: 'blocked',
        reason: 'Multi-file operation contains deletion',
        category: 'file-op',
        recommendation: 'auto-deny',
      };
    }

    if (this._config.safetyMode === 'aggressive') {
      return {
        level: 'safe',
        reason: 'Aggressive mode: multi-file edits auto-approved',
        category: 'file-op',
        recommendation: 'auto-approve',
      };
    }

    // Balanced: caution for multi-file, since scope is broader
    return {
      level: 'caution',
      reason: 'Balanced mode: multi-file edits need confirmation',
      category: 'file-op',
      recommendation: 'require-user',
    };
  }

  private _classifyBashBySafetyMode(command: string): SafetyClassification {
    switch (this._config.safetyMode) {
    case 'conservative':
      return {
        level: 'caution',
        reason: 'Conservative mode: unknown bash command requires confirmation',
        category: 'bash',
        recommendation: 'require-user',
      };

    case 'balanced':
      // In balanced mode, commands that write/install are caution
      if (/\b(npm\s+install|pip\s+install|apt|brew|yarn\s+add)\b/.test(command)) {
        return {
          level: 'caution',
          reason: 'Package installation requires confirmation',
          category: 'bash',
          recommendation: 'require-user',
        };
      }
      // Build/compile commands are safe in balanced
      if (/\b(npm\s+run|make|cargo\s+build|go\s+build|tsc|webpack|vite)\b/.test(command)) {
        return {
          level: 'safe',
          reason: 'Build/compile command',
          category: 'bash',
          recommendation: 'auto-approve',
        };
      }
      return {
        level: 'caution',
        reason: 'Unknown command in balanced mode',
        category: 'bash',
        recommendation: 'require-user',
      };

    case 'aggressive':
      return {
        level: 'safe',
        reason: 'Aggressive mode: bash command auto-approved (not in block list)',
        category: 'bash',
        recommendation: 'auto-approve',
      };

    default:
      return {
        level: 'caution',
        reason: 'Unknown safety mode for bash command',
        category: 'bash',
        recommendation: 'require-user',
      };
    }
  }

  private _compileBlockPatterns(): void {
    this._compiledBlockPatterns = [];
    for (const pattern of this._config.blockPatterns) {
      try {
        this._compiledBlockPatterns.push(new RegExp(pattern));
      } catch {
        console.warn(`[Mysti] SafetyClassifier: Invalid block pattern: ${pattern}`);
      }
    }
  }
}
