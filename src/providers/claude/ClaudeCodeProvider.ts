import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider } from '../base/BaseCliProvider';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig
} from '../../types';

/**
 * Claude Code CLI provider implementation
 */
export class ClaudeCodeProvider extends BaseCliProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';

  readonly config: ProviderConfig = {
    name: 'claude-code',
    displayName: 'Claude Code',
    models: [
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        description: 'Most capable model, best for complex tasks',
        contextWindow: 200000
      },
      {
        id: 'claude-opus-4-5-20251101',
        name: 'Claude Opus 4.5',
        description: 'Advanced reasoning and analysis',
        contextWindow: 200000
      },
      {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude 3.5 Haiku',
        description: 'Fast and efficient for simpler tasks',
        contextWindow: 200000
      }
    ],
    defaultModel: 'claude-sonnet-4-5-20250929'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    supportsSessions: true
  };

  // Tool call state tracking (Claude-specific)
  private _activeToolCalls: Map<number, { id: string; name: string; inputJson: string }> = new Map();

  // Usage stats from message_delta (message_stop doesn't include usage)
  private _lastUsageStats: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null = null;

  async discoverCli(): Promise<CliDiscoveryResult> {
    const extensionPath = this._findVSCodeExtensionCli();
    if (extensionPath) {
      return { found: true, path: extensionPath };
    }

    const configuredPath = this._getConfiguredPath();
    const found = await this._validateCliPath(configuredPath);

    return {
      found,
      path: configuredPath,
      installCommand: 'Install the Claude Code VSCode extension or run: npm install -g @anthropic-ai/claude-code'
    };
  }

  getCliPath(): string {
    const extensionPath = this._findVSCodeExtensionCli();
    return extensionPath || this._getConfiguredPath();
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const configPath = path.join(os.homedir(), '.claude', 'config.json');
    return {
      type: 'cli-login',
      isAuthenticated: fs.existsSync(configPath),
      configPath
    };
  }

  async checkAuthentication(): Promise<boolean> {
    const auth = await this.getAuthConfig();
    return auth.isAuthenticated;
  }

  protected buildCliArgs(settings: Settings, hasSession: boolean): string[] {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    // Map Mysti modes/access levels to Claude Code permission flags
    // This ensures proper enforcement at the CLI level
    this._addPermissionFlags(args, settings);

    // Session handling
    if (hasSession && this._currentSessionId) {
      args.push('--resume', this._currentSessionId);
      console.log('[Mysti] Claude: Resuming session:', this._currentSessionId);
    } else {
      args.push('--print');
      console.log('[Mysti] Claude: Starting new session');
    }

    // Add model selection
    if (settings.model) {
      args.push('--model', settings.model);
    }

    return args;
  }

  /**
   * Get thinking tokens based on thinking level
   */
  protected getThinkingTokens(thinkingLevel: string): number | undefined {
    const tokenMap: Record<string, number> = {
      'none': 0,
      'low': 4000,
      'medium': 8000,
      'high': 16000
    };
    return tokenMap[thinkingLevel];
  }

  /**
   * Add permission flags based on mode and access level
   * Maps Mysti settings to Claude Code CLI permission modes
   */
  private _addPermissionFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    // Quick Plan - read-only, Mysti adds quick plan instruction via prompt
    if (mode === 'quick-plan') {
      args.push('--permission-mode', 'plan');
      console.log('[Mysti] Claude: Using quick plan mode (read-only)');
      return;
    }

    // Detailed Plan - read-only, uses CLI's native multi-plan behavior
    if (mode === 'detailed-plan') {
      args.push('--permission-mode', 'plan');
      console.log('[Mysti] Claude: Using detailed plan mode (read-only)');
      return;
    }

    // Read-only access level enforces plan mode regardless of operation mode
    if (accessLevel === 'read-only') {
      args.push('--permission-mode', 'plan');
      console.log('[Mysti] Claude: Using plan mode (read-only access level)');
      return;
    }

    // edit-automatically + full-access = bypass all permissions
    if (mode === 'edit-automatically' && accessLevel === 'full-access') {
      args.push('--dangerously-skip-permissions');
      args.push('--permission-mode', 'bypassPermissions');
      console.log('[Mysti] Claude: Bypassing all permissions (edit-automatically + full-access)');
      return;
    }

    // edit-automatically + ask-permission = bypass permissions (auto-approve)
    if (mode === 'edit-automatically' && accessLevel === 'ask-permission') {
      args.push('--permission-mode', 'bypassPermissions');
      console.log('[Mysti] Claude: Using bypass mode (edit-automatically + ask-permission)');
      return;
    }

    // ask-before-edit + full-access = bypass permissions
    if (mode === 'ask-before-edit' && accessLevel === 'full-access') {
      args.push('--permission-mode', 'bypassPermissions');
      console.log('[Mysti] Claude: Using bypass mode (ask-before-edit + full-access)');
      return;
    }

    // ask-before-edit + ask-permission = default mode (CLI prompts for permissions)
    if (mode === 'ask-before-edit' && accessLevel === 'ask-permission') {
      args.push('--permission-mode', 'default');
      console.log('[Mysti] Claude: Using default mode (CLI will prompt for permissions)');
      return;
    }

    // Default mode or fallback - normal operation
    args.push('--permission-mode', 'default');
    console.log('[Mysti] Claude: Using default mode');
  }

  protected parseStreamLine(line: string): StreamChunk | null {
    try {
      const data = JSON.parse(line);

      // Handle stream_event wrapper
      if (data.type === 'stream_event') {
        const nestedEvent = data.event || {};
        const nestedType = nestedEvent.type || '';
        const blockIndex = nestedEvent.index ?? -1;

        // Handle content_block_delta - the main streaming content
        if (nestedType === 'content_block_delta') {
          const delta = nestedEvent.delta || {};
          if (delta.type === 'text_delta') {
            return { type: 'text', content: delta.text || '' };
          }
          if (delta.type === 'thinking_delta') {
            return { type: 'thinking', content: delta.thinking || '' };
          }
          if (delta.type === 'input_json_delta') {
            // Accumulate tool input JSON
            const activeTool = this._activeToolCalls.get(blockIndex);
            if (activeTool) {
              activeTool.inputJson += delta.partial_json || '';
            }
            return null;
          }
        }

        // Handle content_block_start - beginning of a content block
        if (nestedType === 'content_block_start') {
          const contentBlock = nestedEvent.content_block || {};
          if (contentBlock.type === 'tool_use') {
            // Store tool call info for accumulation
            this._activeToolCalls.set(blockIndex, {
              id: contentBlock.id || '',
              name: contentBlock.name || '',
              inputJson: ''
            });
            // Return tool_use immediately with running status
            return {
              type: 'tool_use',
              toolCall: {
                id: contentBlock.id || '',
                name: contentBlock.name || '',
                input: {},
                status: 'running'
              }
            };
          }
          if (contentBlock.type === 'thinking') {
            return { type: 'thinking', content: '' };
          }
        }

        // Handle content_block_stop - end of a content block
        if (nestedType === 'content_block_stop') {
          const completedTool = this._activeToolCalls.get(blockIndex);
          if (completedTool) {
            this._activeToolCalls.delete(blockIndex);
            // Parse the accumulated JSON
            let parsedInput = {};
            try {
              if (completedTool.inputJson) {
                parsedInput = JSON.parse(completedTool.inputJson);
              }
            } catch {
              console.log('[Mysti] Claude: Failed to parse tool input JSON:', completedTool.inputJson);
            }
            return {
              type: 'tool_use',
              toolCall: {
                id: completedTool.id,
                name: completedTool.name,
                input: parsedInput,
                status: 'running'
              }
            };
          }
          return null;
        }

        // Handle message lifecycle events
        if (nestedType === 'message_start') {
          return null;
        }

        // Handle message_delta - capture usage stats (usage is in delta, not stop)
        if (nestedType === 'message_delta') {
          const usage = nestedEvent.usage;
          if (usage) {
            this._lastUsageStats = {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens
            };
            console.log('[Mysti] Claude: Captured usage from message_delta:', this._lastUsageStats);
          }
          return null;
        }

        // Handle message_stop - signal end of message
        // Usage is already cached from message_delta, will be retrieved by getStoredUsage()
        if (nestedType === 'message_stop') {
          return null; // Don't return done here - let sendMessage handle it
        }

        return null;
      }

      // Handle direct result event (final message)
      if (data.type === 'result') {
        if (data.result) {
          return { type: 'text', content: data.result };
        }
        return null;
      }

      // Handle system events (session init, etc.)
      if (data.type === 'system') {
        if (data.subtype === 'init') {
          const sessionId = data.session_id || data.sessionId;
          if (sessionId && !this._currentSessionId) {
            this._currentSessionId = sessionId;
            console.log('[Mysti] Claude: Session ID extracted:', sessionId);
            return { type: 'session_active', sessionId };
          }
        }
        return null;
      }

      // Handle assistant complete message - extract tool results
      if (data.type === 'assistant') {
        if (data.message?.content) {
          for (const block of data.message.content) {
            if (block.type === 'tool_use') {
              return {
                type: 'tool_use',
                toolCall: {
                  id: block.id || '',
                  name: block.name || '',
                  input: block.input || {},
                  status: 'running'
                }
              };
            }
          }
        }
        return null;
      }

      // Handle error events
      if (data.type === 'error') {
        return {
          type: 'error',
          content: data.error?.message || data.message || 'Unknown error'
        };
      }

      // Handle tool_result events (user message containing tool results)
      if (data.type === 'user' && data.message?.content) {
        for (const block of data.message.content) {
          if (block.type === 'tool_result') {
            return {
              type: 'tool_result',
              toolCall: {
                id: block.tool_use_id || '',
                name: '',
                input: {},
                output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                status: block.is_error ? 'failed' : 'completed'
              }
            };
          }
        }
      }

      // Handle direct tool_result events
      if (data.type === 'tool_result') {
        return {
          type: 'tool_result',
          toolCall: {
            id: data.tool_use_id || data.tool_id || '',
            name: data.tool_name || '',
            input: {},
            output: typeof data.content === 'string' ? data.content : JSON.stringify(data.content || ''),
            status: data.is_error ? 'failed' : 'completed'
          }
        };
      }

    } catch {
      // If it's not JSON, treat as plain text
      if (line.trim()) {
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  /**
   * Get stored usage stats from the last message and clear them
   * Called by sendMessage after stream processing to include in final done chunk
   */
  getStoredUsage(): { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null {
    const usage = this._lastUsageStats;
    this._lastUsageStats = null;
    console.log('[Mysti] Claude: getStoredUsage returning:', usage);
    return usage;
  }

  /**
   * Enhance a prompt using Claude
   */
  async enhancePrompt(prompt: string): Promise<string> {
    const { spawn } = await import('child_process');
    const claudePath = this.getCliPath();

    const enhancePrompt = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:

Original prompt: "${prompt}"

Enhanced prompt:`;

    return new Promise((resolve) => {
      const args = ['--print', '--output-format', 'text'];

      const proc = spawn(claudePath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';

      if (proc.stdin) {
        proc.stdin.write(enhancePrompt);
        proc.stdin.end();
      }

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim());
        } else {
          resolve(prompt);
        }
      });

      proc.on('error', () => {
        resolve(prompt);
      });
    });
  }

  // Private helper methods

  private _getConfiguredPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('claudeCodePath', 'claude');
  }

  private _findVSCodeExtensionCli(): string | null {
    const homeDir = os.homedir();
    const extensionsDir = path.join(homeDir, '.vscode', 'extensions');

    try {
      if (fs.existsSync(extensionsDir)) {
        const entries = fs.readdirSync(extensionsDir);
        const claudeExtensions = entries
          .filter(e => e.startsWith('anthropic.claude-code-'))
          .sort()
          .reverse();

        for (const ext of claudeExtensions) {
          const binaryPath = path.join(extensionsDir, ext, 'resources', 'native-binary', 'claude');
          if (fs.existsSync(binaryPath)) {
            console.log('[Mysti] Claude: Found CLI at:', binaryPath);
            return binaryPath;
          }
        }
      }
    } catch (error) {
      console.error('[Mysti] Claude: Error searching for CLI:', error);
    }

    return null;
  }

  private async _validateCliPath(cliPath: string): Promise<boolean> {
    try {
      fs.accessSync(cliPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}
