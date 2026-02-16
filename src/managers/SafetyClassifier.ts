/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
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
  { pattern: /\brmdir\b/, reason: 'Directory removal' },
  { pattern: /\bdel\s+\/[sS]/, reason: 'Windows recursive deletion' },
  // Destructive git operations
  { pattern: /\bgit\s+push\s+.*--force\b/, reason: 'Force push can overwrite remote history' },
  { pattern: /\bgit\s+push\s+-f\b/, reason: 'Force push can overwrite remote history' },
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
  // Data exfiltration via pipe
  { pattern: /\|\s*(curl|wget|nc|netcat)\b/, reason: 'Piping data to external network command' },
  // System-level danger
  { pattern: /\bmkfs\b/, reason: 'Filesystem formatting' },
  { pattern: /\bdd\s+/, reason: 'Low-level disk writing' },
  { pattern: />\s*\/dev\//, reason: 'Writing to device files' },
];

/**
 * Bash commands that are generally safe to execute
 */
const SAFE_BASH_PATTERNS: RegExp[] = [
  /^\s*(ls|cat|head|tail|less|more|wc|grep|find|which|where|echo|pwd|date|whoami)\b/,
  /^\s*(npm\s+(test|run|list|info|ls|outdated|audit))\b/,
  /^\s*(npx\s+)/,
  /^\s*(node\s+-[ev]|node\s+--version)\b/,
  /^\s*(git\s+(status|log|diff|branch|show|stash\s+list|remote|fetch))\b/,
  /^\s*(tsc|eslint|prettier|jest|vitest|mocha|pytest|cargo\s+test)\b/,
  /^\s*(pip\s+(list|show|freeze))\b/,
  /^\s*(cargo\s+(check|clippy|test|build))\b/,
  /^\s*(go\s+(test|vet|build))\b/,
  /^\s*(make\s+(test|check|lint|build))\b/,
];

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
