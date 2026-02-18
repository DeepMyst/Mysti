/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider, type PanelSessionState, type ProcessTracker } from '../base/BaseCliProvider';
import { OpenClawGateway } from './OpenClawGateway';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ContextItem,
  Conversation,
  AgentConfiguration,
} from '../../types';
import { validateModelName } from '../../utils/validation';
import { getEnrichedEnv, readOpenClawToken } from '../../utils/platform';

export interface OpenClawSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; inputJson: string }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

/**
 * OpenClaw provider implementation with dual transport
 *
 * Primary: Gateway WebSocket at ws://127.0.0.1:18789 for real-time streaming
 * Fallback: CLI spawn via `openclaw agent --message "..." --json --local`
 *
 * Install: npm install -g openclaw@latest && openclaw onboard --install-daemon
 * Auth: openclaw login
 * Config: ~/.openclaw/openclaw.json
 */
export class OpenClawProvider extends BaseCliProvider {
  readonly id = 'openclaw';
  readonly displayName = 'OpenClaw';

  readonly config: ProviderConfig = {
    name: 'openclaw',
    displayName: 'OpenClaw',
    models: [
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        description: 'Latest flagship model via OpenClaw',
        contextWindow: 200000,
      },
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        description: 'Fast and capable via OpenClaw',
        contextWindow: 200000,
      },
      {
        id: 'gpt-5',
        name: 'GPT-5',
        description: 'OpenAI GPT-5 via OpenClaw',
        contextWindow: 128000,
      },
    ],
    defaultModel: 'claude-opus-4-6',
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    supportsSessions: true,
    supportsAutoInstall: false,
  };

  private _gateway: OpenClawGateway;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    const gatewayUrl = vscode.workspace.getConfiguration('mysti').get<string>(
      'openclawGatewayUrl', 'ws://127.0.0.1:18789'
    );
    const token = readOpenClawToken();
    this._gateway = new OpenClawGateway(gatewayUrl, token);
  }

  protected _createSession(panelId: string): OpenClawSessionState {
    return {
      panelId,
      process: null,
      sessionId: null,
      autonomousMode: false,
      persistentProcess: null,
      persistentReady: false,
      lastHealthCheck: 0,
      activeToolCalls: new Map(),
      lastUsageStats: null,
    };
  }

  /**
   * Initialize the provider and attempt Gateway connection
   */
  async initialize(): Promise<void> {
    const useGateway = vscode.workspace.getConfiguration('mysti').get<boolean>('openclawUseGateway', true);

    if (useGateway) {
      const connected = await this._gateway.connect();
      if (connected) {
        console.log('[Mysti] OpenClaw: Gateway connected at initialization');
      } else {
        console.log('[Mysti] OpenClaw: Gateway not available, will use CLI fallback');
      }
    } else {
      console.log('[Mysti] OpenClaw: Gateway disabled by setting, using CLI only');
    }
  }

  /**
   * Dispose the provider and disconnect Gateway
   */
  dispose(): void {
    this._gateway.disconnect();
    super.dispose();
  }

  // --- CLI Discovery ---

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  protected _getCliCommandName(): string {
    return 'openclaw';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('openclawPath', 'openclaw');
  }

  // --- Authentication ---

  async getAuthConfig(): Promise<AuthConfig> {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const credentialsDir = path.join(os.homedir(), '.openclaw', 'credentials');

    const hasConfig = fs.existsSync(configPath);
    const hasCredentials = fs.existsSync(credentialsDir) &&
      (() => { try { return fs.readdirSync(credentialsDir).length > 0; } catch { return false; } })();

    return {
      type: 'cli-login',
      isAuthenticated: hasConfig || hasCredentials,
      configPath,
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const auth = await this.getAuthConfig();
    if (!auth.isAuthenticated) {
      return {
        authenticated: false,
        error: 'Not authenticated. Please run "openclaw login" to sign in.',
      };
    }

    // Try to read user info from config
    try {
      if (auth.configPath && fs.existsSync(auth.configPath)) {
        const configContent = fs.readFileSync(auth.configPath, 'utf-8');
        // JSON5 is a superset of JSON; try standard JSON parse first
        // Strip single-line comments and trailing commas for basic JSON5 compat
        const cleaned = configContent
          .replace(/\/\/.*$/gm, '')
          .replace(/,(\s*[}\]])/g, '$1');
        const config = JSON.parse(cleaned);
        return {
          authenticated: true,
          user: config.email || config.user || 'Authenticated',
        };
      }
    } catch {
      // Config exists but couldn't parse — still authenticated
    }

    return { authenticated: true };
  }

  getAuthCommand(): string {
    return 'openclaw login';
  }

  getInstallCommand(): string {
    return 'npm install -g openclaw@latest && openclaw onboard --install-daemon';
  }

  getInstallMethods(): import('../../types').InstallMethod[] {
    return [
      {
        id: 'npm',
        label: 'npm (recommended)',
        command: 'npm install -g openclaw@latest',
        platform: 'all',
        priority: 1
      },
      {
        id: 'onboard',
        label: 'Full setup with daemon',
        command: 'npm install -g openclaw@latest && openclaw onboard --install-daemon',
        platform: 'all',
        priority: 2
      }
    ];
  }

  // --- CLI Args (for fallback mode) ---

  protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
    const args: string[] = ['agent', '--json'];

    // Map thinking levels: Mysti none/low/medium/high -> OpenClaw off/low/medium/high
    const thinkingMap: Record<string, string> = {
      'none': 'off',
      'low': 'low',
      'medium': 'medium',
      'high': 'high',
    };
    const thinkingLevel = thinkingMap[settings.thinkingLevel] || 'medium';
    args.push('--thinking', thinkingLevel);

    // Local mode (no gateway needed for CLI fallback)
    args.push('--local');

    return args;
  }

  /**
   * OpenClaw handles thinking natively via --thinking flag
   */
  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  // --- Stream Parsing (for CLI fallback) ---

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const openClawSession = session as OpenClawSessionState;

    if (!line.trim()) {
      return null;
    }

    try {
      const data = JSON.parse(line.trim());

      // System/init events
      if (data.type === 'system' || data.type === 'init') {
        const sessionId = data.session_id || data.sessionId || data.agent_id;
        if (sessionId) {
          console.log('[Mysti] OpenClaw: Session init:', sessionId);
          return { type: 'session_active', sessionId };
        }
        return null;
      }

      // Text content
      if (data.type === 'text' || data.type === 'assistant' || data.type === 'content') {
        const content = data.content || data.text ||
          (data.delta && (data.delta.text || data.delta.content));
        if (content) {
          return { type: 'text', content };
        }
        return null;
      }

      // Thinking/reasoning content
      if (data.type === 'thinking' || data.type === 'reasoning') {
        const content = data.content || data.thinking || data.text;
        if (content) {
          return { type: 'thinking', content };
        }
        return null;
      }

      // Tool call events
      if (data.type === 'tool_call' || data.type === 'tool_use') {
        const toolId = data.id || data.tool_call_id || `tool_${Date.now()}`;
        const toolName = data.name || data.tool || 'unknown';
        const toolInput = data.input || data.arguments || {};

        // Detect ask_user-style tools and convert to ask_user_question chunk
        if ((toolName === 'ask_user' || toolName === 'AskUserQuestion' || toolName === 'ask_user_question') &&
            toolInput.questions && Array.isArray(toolInput.questions)) {
          console.log('[Mysti] OpenClaw: Detected ask_user tool, converting to ask_user_question chunk');
          return {
            type: 'ask_user_question',
            askUserQuestion: {
              toolCallId: toolId,
              questions: (toolInput.questions as Array<Record<string, unknown>>).map((q: Record<string, unknown>) => ({
                question: String(q.question || ''),
                header: String(q.header || '').substring(0, 12),
                options: Array.isArray(q.options) ? q.options.map((o: Record<string, unknown>) => ({
                  label: String(o.label || ''),
                  description: String(o.description || '')
                })) : [],
                multiSelect: Boolean(q.multiSelect)
              }))
            }
          };
        }

        if (data.status === 'started' || data.subtype === 'started') {
          openClawSession.activeToolCalls.set(toolId, {
            id: toolId,
            name: toolName,
            inputJson: JSON.stringify(data.input || data.arguments || {}),
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: toolId,
              name: toolName,
              input: data.input || data.arguments || {},
              status: 'running',
            },
          };
        }

        if (data.status === 'completed' || data.subtype === 'completed') {
          const active = openClawSession.activeToolCalls.get(toolId);
          openClawSession.activeToolCalls.delete(toolId);
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: active?.name || toolName,
              input: active ? JSON.parse(active.inputJson) : (data.input || {}),
              output: data.output || data.result ||
                (data.success !== undefined ? (data.success ? 'Success' : 'Failed') : ''),
              status: 'completed',
            },
          };
        }

        return null;
      }

      // Standalone tool result
      if (data.type === 'tool_result') {
        return {
          type: 'tool_result',
          toolCall: {
            id: data.tool_use_id || data.tool_id || '',
            name: data.tool_name || '',
            input: {},
            output: typeof data.content === 'string' ? data.content : JSON.stringify(data.content || ''),
            status: data.is_error ? 'failed' : 'completed',
          },
        };
      }

      // Block/chunk streaming (OpenClaw-specific)
      if (data.type === 'block' || data.type === 'chunk') {
        const content = data.content || data.text || data.data;
        if (content) {
          return { type: 'text', content };
        }
        return null;
      }

      // Usage/metrics events
      if (data.type === 'usage' || data.type === 'metrics' || data.type === 'result') {
        const usage = data.usage || data.stats || data;
        if (usage.input_tokens || usage.output_tokens) {
          openClawSession.lastUsageStats = {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          };
          console.log('[Mysti] OpenClaw: Usage stats:', openClawSession.lastUsageStats);
        }
        return null;
      }

      // Error events
      if (data.type === 'error') {
        return {
          type: 'error',
          content: data.error || data.message || 'Unknown OpenClaw error',
        };
      }

      // Done/complete events
      if (data.type === 'done' || data.type === 'complete' || data.type === 'end') {
        return { type: 'done' };
      }

      return null;
    } catch {
      // Not JSON — treat non-empty lines as plain text
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('[') && trimmed.length > 1) {
        return { type: 'text', content: trimmed };
      }
      return null;
    }
  }

  /**
   * Override processStream for CLI fallback — uses hybrid streaming:
   * 1. Try line-by-line NDJSON first (like BaseCliProvider) for real-time output
   * 2. Fall back to full-blob JSON parse if no NDJSON lines yielded content
   */
  protected async *processStream(stderrRef: { output: string }, session: PanelSessionState): AsyncGenerator<StreamChunk> {
    let buffer = '';
    let fullOutput = '';
    let hasYieldedContent = false;

    // Stream line-by-line, accumulating full output for fallback
    if (session.process?.stdout) {
      for await (const chunk of session.process.stdout) {
        const chunkStr = chunk.toString();
        buffer += chunkStr;
        fullOutput += chunkStr;

        // Split by newlines, keep incomplete line in buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) { continue; }
          // Only process lines that are valid standalone JSON objects —
          // fragments of a multi-line blob should be left for the full-blob fallback
          const trimmed = line.trim();
          try { JSON.parse(trimmed); } catch { continue; }
          const parsed = this.parseStreamLine(line, session);
          if (parsed) {
            hasYieldedContent = true;
            yield parsed;
          }
        }
      }
    }

    // Process remaining buffer (only if it's valid standalone JSON)
    if (buffer.trim()) {
      try {
        JSON.parse(buffer.trim());
        const parsed = this.parseStreamLine(buffer, session);
        if (parsed) {
          hasYieldedContent = true;
          yield parsed;
        }
      } catch {
        // Not standalone JSON — will be handled by full-blob fallback
      }
    }

    // Wait for process exit
    const exitCode = await this.waitForProcess(session);
    console.log('[Mysti] OpenClaw: Process exited with code:', exitCode);

    // Fallback: if no NDJSON lines yielded content, try full-blob JSON parse
    if (!hasYieldedContent && fullOutput.trim()) {
      try {
        const data = JSON.parse(fullOutput);

        // Extract text from payloads array
        if (data.payloads && Array.isArray(data.payloads)) {
          for (const payload of data.payloads) {
            if (payload.text) {
              yield { type: 'text', content: payload.text };
              hasYieldedContent = true;
            }
          }
        }

        // Extract usage stats from meta
        if (data.meta?.agentMeta?.usage) {
          const u = data.meta.agentMeta.usage;
          (session as OpenClawSessionState).lastUsageStats = {
            input_tokens: u.input || 0,
            output_tokens: u.output || 0,
          };
          console.log('[Mysti] OpenClaw: Usage stats:', (session as OpenClawSessionState).lastUsageStats);
        }

        // Extract session ID for reuse
        if (data.meta?.agentMeta?.sessionId) {
          session.sessionId = data.meta.agentMeta.sessionId;
        }
      } catch {
        // Not valid JSON — yield as plain text
        yield { type: 'text', content: fullOutput.trim() };
        hasYieldedContent = true;
      }
    }

    // Handle errors (same pattern as base class)
    if (exitCode !== 0 && exitCode !== null && stderrRef.output) {
      if (this.isAuthenticationError(stderrRef.output)) {
        yield { type: 'auth_error', content: stderrRef.output, authCommand: this.getAuthCommand(), providerName: this.displayName };
      } else {
        yield { type: 'error', content: stderrRef.output };
      }
    } else if (!hasYieldedContent && stderrRef.output) {
      if (this.isAuthenticationError(stderrRef.output)) {
        yield { type: 'auth_error', content: stderrRef.output, authCommand: this.getAuthCommand(), providerName: this.displayName };
      } else {
        yield { type: 'error', content: `No response received. stderr: ${stderrRef.output}` };
      }
    }
  }

  // --- Message Sending (dual transport) ---

  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    _conversation: Conversation | null,
    persona?: import('../base/IProvider').PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration,
  ): AsyncGenerator<StreamChunk> {
    const useGateway = vscode.workspace.getConfiguration('mysti').get<boolean>('openclawUseGateway', true);

    // Try Gateway first
    if (useGateway && this._gateway.isConnected()) {
      console.log('[Mysti] OpenClaw: Using Gateway');
      yield* this._sendViaGateway(content, context, settings, persona, panelId, agentConfig);
      return;
    }

    // Attempt Gateway reconnection if enabled
    if (useGateway && !this._gateway.isConnected()) {
      const reconnected = await this._gateway.connect();
      if (reconnected) {
        console.log('[Mysti] OpenClaw: Gateway reconnected, using Gateway');
        yield* this._sendViaGateway(content, context, settings, persona, panelId, agentConfig);
        return;
      }
    }

    // Fallback to CLI
    console.log('[Mysti] OpenClaw: Using CLI fallback');
    yield* this._sendViaCli(content, context, settings, persona, panelId, providerManager, agentConfig);
  }

  /**
   * Send message via Gateway WebSocket
   */
  private async *_sendViaGateway(
    content: string,
    context: ContextItem[],
    settings: Settings,
    persona?: import('../base/IProvider').PersonaConfig,
    panelId?: string,
    agentConfig?: AgentConfiguration,
  ): AsyncGenerator<StreamChunk> {
    const session = this._getSession(panelId);
    const fullPrompt = await this.buildPromptAsync(
      content, context, null, settings, persona, agentConfig,
      undefined, session.channelSystemContext,
    );

    // Map settings to Gateway options
    const thinkingMap: Record<string, string> = {
      'none': 'off', 'low': 'low', 'medium': 'medium', 'high': 'high',
    };

    const { mode, accessLevel } = settings;
    let elevated = 'ask';
    if (mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only') {
      elevated = 'off';
    } else if (accessLevel === 'ask-permission') {
      elevated = 'ask';
    } else if (accessLevel === 'full-access') {
      elevated = mode === 'edit-automatically' ? 'full' : 'on';
    }

    try {
      // Emit session_active so the webview shows the session indicator
      // The Gateway WebSocket doesn't emit system/init events like the CLI does
      const session = this._getSession(panelId);
      if (!session.sessionId) {
        session.sessionId = `openclaw-gw-${panelId || 'default'}-${Date.now()}`;
      }
      yield { type: 'session_active' as const, sessionId: session.sessionId };

      yield* this._gateway.sendAgentMessage(fullPrompt, {
        thinking: thinkingMap[settings.thinkingLevel] || 'medium',
        elevated,
        model: this._getEffectiveModel(settings),
      });

      // Yield done with usage stats
      const storedUsage = this.getStoredUsage(panelId);
      yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
      console.log('[Mysti] OpenClaw: Gateway stream complete');
    } catch (error) {
      console.log('[Mysti] OpenClaw: Gateway error, may retry via CLI:', error);
      yield this.handleError(error);
      yield { type: 'done' };
    }
  }

  /**
   * Send message via CLI fallback (spawn process)
   */
  private async *_sendViaCli(
    content: string,
    context: ContextItem[],
    settings: Settings,
    persona?: import('../base/IProvider').PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration,
  ): AsyncGenerator<StreamChunk> {
    const session = this._getSession(panelId);
    const cliPath = this.getCliPath();
    const baseArgs = this.buildCliArgs(settings, session);

    const fullPrompt = await this.buildPromptAsync(
      content, context, null, settings, persona, agentConfig,
      undefined, session.channelSystemContext,
    );

    // Session identifier — reuse existing session or derive from panelId
    const sessionId = session.sessionId || panelId || `mysti-${Date.now()}`;
    const args = [...baseArgs, '--session-id', sessionId, '--message', fullPrompt];

    // Declare outside try so finally block can access for cleanup
    const stderrRef = { output: '' };
    const stderrHandler = (data: Buffer) => {
      const text = data.toString();
      stderrRef.output += text;
      console.log('[Mysti] OpenClaw stderr:', text);
    };

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

      console.log('[Mysti] OpenClaw: Starting CLI at:', cliPath);
      console.log('[Mysti] OpenClaw: Working directory:', cwd);

      const { spawn } = await import('child_process');
      session.process = spawn(cliPath, args, {
        cwd,
        env: getEnrichedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Register process for per-panel cancellation
      if (panelId && providerManager && typeof (providerManager as ProcessTracker).registerProcess === 'function') {
        (providerManager as ProcessTracker).registerProcess(panelId, session.process);
      }

      // Capture stderr for error reporting
      if (session.process.stderr) {
        session.process.stderr.on('data', stderrHandler);
      }

      // Process streaming output
      yield* this.processStream(stderrRef, session);

      // Yield done with usage stats
      const storedUsage = this.getStoredUsage(panelId);
      yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
      console.log('[Mysti] OpenClaw: CLI stream complete');
    } catch (error) {
      yield this.handleError(error);
      yield { type: 'done' };
    } finally {
      if (session.process && !session.process.killed) {
        if (session.process.stderr) {
          session.process.stderr.removeListener('data', stderrHandler);
        }
        session.process.kill('SIGTERM');
      }
      session.process = null;
      if (panelId && providerManager && typeof (providerManager as ProcessTracker).clearProcess === 'function') {
        (providerManager as ProcessTracker).clearProcess(panelId);
      }
    }
  }

  /**
   * Cancel current request (Gateway or CLI)
   */
  cancelCurrentRequest(panelId?: string): void {
    // Cancel Gateway run
    this._gateway.cancelAgent();
    // Cancel CLI process via base class
    super.cancelCurrentRequest(panelId);
  }

  // --- Utility methods ---

  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as OpenClawSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  async enhancePrompt(prompt: string): Promise<string> {
    // Prefer Gateway if connected
    if (this._gateway.isConnected()) {
      try {
        let result = '';
        const enhanceMsg = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:\n\nOriginal prompt: "${prompt}"\n\nEnhanced prompt:`;
        for await (const chunk of this._gateway.sendAgentMessage(enhanceMsg, { thinking: 'off' })) {
          if (chunk.type === 'text' && chunk.content) {
            result += chunk.content;
          }
        }
        return result.trim() || prompt;
      } catch {
        // Fall through to CLI
      }
    }

    // CLI fallback
    const { spawn } = await import('child_process');
    const cliPath = this.getCliPath();
    const enhanceMsg = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:\n\nOriginal prompt: "${prompt}"\n\nEnhanced prompt:`;

    return new Promise((resolve) => {
      const proc = spawn(cliPath, ['agent', '--message', enhanceMsg, '--json', '--local'], {
        env: getEnrichedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      proc.stdout?.on('data', (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString().trim());
          if (parsed.content || parsed.text) {
            output += parsed.content || parsed.text;
          }
        } catch {
          output += data.toString();
        }
      });

      proc.on('close', (code: number | null) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim());
        } else {
          resolve(prompt);
        }
      });

      proc.on('error', () => resolve(prompt));
    });
  }

  // --- Private helpers ---

  private _getEffectiveModel(settings: Settings): string | undefined {
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('openclawModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] OpenClaw: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] OpenClaw: Invalid custom model "${customModel}": ${validation.error}`);
    }

    // Use the model from settings dropdown
    if (settings.model && settings.model !== this.config.defaultModel) {
      return settings.model;
    }

    return undefined;
  }

}
