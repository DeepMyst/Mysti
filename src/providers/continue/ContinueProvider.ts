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
 * Continue provider (continuedev's `cn` CLI, npm: @continuedev/cli).
 *
 * Transport: single-shot headless mode — `cn -p` officially reads the
 * prompt from piped stdin (`echo "hello" | cn -p`), runs the agent to
 * completion, and prints the final response to stdout. There is no
 * stream-JSON event mode (`--format json` merely wraps the final blob),
 * so tool activity is not visible; capabilities are declared honestly
 * (no tool events, no usage). `<think>…</think>` blocks in the output
 * are parsed into thinking chunks.
 *
 * This notification-free transport is available only in unrestricted tiers.
 * Native --readonly permits Bash and MCP tools; it is not a read-only boundary.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { requireUnrestrictedLegacyTransport } from '../base/NativeApprovalPolicy';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus
} from '../../types';
import { validateModelName } from '../../utils/validation';

/**
 * Per-panel session state for Continue: think-tag parsing state.
 */
export interface ContinueSessionState extends PanelSessionState {
  /** True while inside a <think>…</think> block spanning multiple lines. */
  inThinkBlock: boolean;
}

export class ContinueProvider extends BaseCliProvider {
  readonly id = 'continue';
  readonly displayName = 'Continue';

  readonly config: ProviderConfig = {
    name: 'continue',
    displayName: 'Continue',
    models: [
      {
        id: 'default',
        name: 'Configured Model',
        description: 'Uses the models configured in ~/.continue/config.yaml (or a hub assistant via --config)',
        contextWindow: 200000
      }
    ],
    defaultModel: 'default'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,      // <think> blocks parsed from headless output
    // Headless `cn -p` prints only the final response — no tool events
    // ever reach stdout, so no tool cards / permission gating.
    supportsToolUse: false,
    toolExecution: 'native',
    supportsSessions: true,
    supportsImages: false,
    supportsAutoInstall: true,   // plain npm global install
    supportsPromptEnhancement: false,
    thinkingStyle: 'complete-blocks',
    thinkingLevelEffective: false,
    planMode: 'none',
    // `--resume` targets the globally-last session (cross-panel bleed) and
    // headless mode never reports a session id to fork — so continuity is
    // Mysti-side prompt history, same as Copilot.
    sessionKind: 'prompt-history',
    emitsToolResults: false,
    emitsUsage: false,           // headless stdout carries no token stats
    usageConvention: 'none',   // headless stdout carries no token stats at all.
    modelSelection: 'custom-only' // hub slug (owner/package) via --model
  };

  protected _createSession(panelId: string): ContinueSessionState {
    return {
      panelId,
      process: null,
      sessionId: null,
      autonomousMode: false,
      persistentProcess: null,
      persistentReady: false,
      lastHealthCheck: 0,
      suspended: false,
      inThinkBlock: false,
    };
  }

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  protected _getCliCommandName(): string {
    return 'cn';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('continuePath', 'cn');
  }

  /** Continue home dir (~/.continue by default, CONTINUE_GLOBAL_DIR override). */
  private _continueHome(): string {
    return process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), '.continue');
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const configPath = path.join(this._continueHome(), 'config.yaml');
    const hasAuthFile = fs.existsSync(path.join(this._continueHome(), 'auth.json'));
    const hasEnvKey = !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.CONTINUE_API_KEY
    );

    return {
      type: 'api-key',
      isAuthenticated: hasEnvKey || hasAuthFile || fs.existsSync(configPath),
      configPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    // Signed in to Continue Hub (`cn login`) — tokens in ~/.continue/auth.json.
    // Only ever written post-login, so no first-run false-positive.
    if (fs.existsSync(path.join(this._continueHome(), 'auth.json'))) {
      return { authenticated: true, user: 'Continue Hub' };
    }

    // Local-first: models + API keys live in ~/.continue/config.yaml. cn
    // creates ~/.continue on first launch even if onboarding is abandoned,
    // so mere file existence is NOT proof of a usable config — require it to
    // actually declare models / a key / an assistant.
    const configPath = path.join(this._continueHome(), 'config.yaml');
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        // Require a genuinely usable config. The abandoned-onboarding scaffold
        // carries harmless keys like `name:` / `assistant:` with no working
        // model, so accepting those defeated the "existence is not proof" intent.
        // Demand either a non-empty `models:` list (a `models:` key immediately
        // followed by a `- ` item) or an apiKey/apiBase declaration.
        if (/^\s*models\s*:\s*\n\s*-/m.test(content) || /apiKey|apiBase/i.test(content)) {
          return { authenticated: true, user: 'Continue Config' };
        }
      } catch {
        // unreadable — fall through to env-key check
      }
    }

    // Provider keys Continue's config templating resolves from the environment
    if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.CONTINUE_API_KEY) {
      return { authenticated: true, user: 'Environment API Key' };
    }

    return {
      authenticated: false,
      error: 'Not configured. Run "cn" once to finish setup in ~/.continue/config.yaml (add models + an API key), or set a provider key such as ANTHROPIC_API_KEY.'
    };
  }

  getAuthCommand(): string {
    // No dedicated login subcommand in the OSS CLI — first interactive run
    // walks through onboarding and writes ~/.continue/config.yaml
    return 'cn';
  }

  getInstallCommand(): string {
    return 'npm i -g @continuedev/cli';
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined; // reasoning is governed by the configured model
  }

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    const cn = session as ContinueSessionState;
    cn.inThinkBlock = false;

    // Headless print mode; prompt arrives via piped stdin
    const args: string[] = ['-p'];
    this._addPermissionFlags(args, settings);

    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    // NOTE: channelSystemContext is deliberately NOT passed as a `--rule`
    // arg. It is a multi-line markdown blob (project rules + memory + …); a
    // newline in a CLI arg trips the shell-mode injection gate on Windows
    // (every message would fail), and the base already injects the same
    // context into the stdin prompt — a flag would double it. The base's
    // buildPromptAsync path is the single injection point (Copilot pattern).

    console.log('[Mysti] Continue: Built CLI args:', args.join(' '));
    return args;
  }

  protected async _validateNativeApprovalCli(_session: PanelSessionState, settings: Readonly<Settings>): Promise<void> {
    requireUnrestrictedLegacyTransport(settings, this.displayName);
  }

  private _addPermissionFlags(args: string[], settings: Settings): void {
    requireUnrestrictedLegacyTransport(settings, this.displayName);
    args.push('--auto');
  }

  /**
   * Custom model as a hub slug (owner/package) or config model name.
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('continueModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        return customModel;
      }
      console.warn(`[Mysti] Continue: Invalid custom model "${customModel}": ${validation.error}`);
    }
    if (settings.model && settings.model !== 'default') {
      return settings.model;
    }
    return undefined;
  }

  /**
   * Parse headless plain-text output. The final response arrives as a
   * multi-line blob; the base splits it into lines (delimiters dropped, and
   * blank lines filtered), so '\n' is re-appended to preserve line breaks.
   *
   * `<think>…</think>` blocks map to thinking chunks. Because parseStreamLine
   * can return only ONE chunk, a line that mixes thinking and response text
   * must sacrifice one — and it ALWAYS preserves the RESPONSE text (dropping
   * only the lower-value thinking fragment on that single mixed line). This
   * guarantees the model's answer is never lost.
   *
   * We do NOT pass `--format json`, so cn emits plain prose only — no interim
   * status/JSON envelopes to filter (and filtering them risked swallowing a
   * model answer that happened to be JSON).
   */
  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const cn = session as ContinueSessionState;
    // (Blank lines never reach here — the base filters them before parsing.)

    if (cn.inThinkBlock) {
      const closeIdx = line.indexOf('</think>');
      if (closeIdx === -1) {
        return { type: 'thinking', content: line + '\n' };
      }
      cn.inThinkBlock = false;
      const after = line.slice(closeIdx + '</think>'.length).trim();
      // Prefer response text after the close tag; the thinking tail before it
      // on this same line is dropped (can't emit two chunks).
      if (after) {
        return { type: 'text', content: after + '\n' };
      }
      const inner = line.slice(0, closeIdx).trim();
      return inner ? { type: 'thinking', content: inner + '\n' } : null;
    }

    const openIdx = line.indexOf('<think>');
    if (openIdx === -1) {
      return { type: 'text', content: line + '\n' };
    }

    const before = line.slice(0, openIdx).trim();
    const afterOpen = line.slice(openIdx + '<think>'.length);
    const closeIdx = afterOpen.indexOf('</think>');

    if (closeIdx === -1) {
      cn.inThinkBlock = true;
      // Response text BEFORE the tag is the answer — never drop it. The
      // thinking fragment after <think> is folded into the block that
      // follows (its opening fragment on this line is dropped).
      if (before) {
        return { type: 'text', content: before + '\n' };
      }
      const inner = afterOpen.trim();
      return inner ? { type: 'thinking', content: inner + '\n' } : null;
    }

    // Complete <think>…</think> on one line.
    const rest = (before + ' ' + afterOpen.slice(closeIdx + '</think>'.length).trim()).trim();
    if (rest) {
      return { type: 'text', content: rest + '\n' };
    }
    const inner = afterOpen.slice(0, closeIdx).trim();
    return inner ? { type: 'thinking', content: inner + '\n' } : null;
  }

  getStoredUsage(_panelId?: string): { input_tokens: number; output_tokens: number } | null {
    return null; // headless stdout carries no usage stats
  }
}
