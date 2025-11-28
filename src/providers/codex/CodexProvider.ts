import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { BaseCliProvider } from '../base/BaseCliProvider';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  PersonaConfig
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  ContextItem,
  Conversation
} from '../../types';

/**
 * OpenAI Codex CLI provider implementation
 * Requires ChatGPT Plus/Pro subscription or API key for authentication
 *
 * Uses `codex exec --json` for non-interactive streaming output
 *
 * @see https://github.com/openai/codex
 * @see https://developers.openai.com/codex/cli/
 */
export class CodexProvider extends BaseCliProvider {
  readonly id = 'openai-codex';
  readonly displayName = 'OpenAI Codex';

  // Track active tool calls for state management through lifecycle
  private _activeToolCalls: Map<string, {
    id: string;
    name: string;
    inputJson: string;
    status: 'running' | 'completed' | 'failed';
  }> = new Map();

  // Track completed tool calls to prevent duplicate tool_result emissions
  private _completedToolCalls: Set<string> = new Set();

  // Usage stats from turn.completed
  private _lastUsageStats: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } | null = null;

  readonly config: ProviderConfig = {
    name: 'openai-codex',
    displayName: 'OpenAI Codex',
    models: [
      {
        id: 'gpt-5.1-codex',
        name: 'GPT-5.1 Codex',
        description: 'Latest model optimized for coding',
        contextWindow: 1000000
      },
      {
        id: 'gpt-5-codex',
        name: 'GPT-5 Codex',
        description: 'Stable model for coding tasks',
        contextWindow: 1000000
      },
      {
        id: 'o3',
        name: 'o3',
        description: 'Advanced reasoning model',
        contextWindow: 200000
      },
      {
        id: 'o4-mini',
        name: 'o4-mini',
        description: 'Fast and efficient for simpler tasks',
        contextWindow: 200000
      }
    ],
    defaultModel: 'gpt-5.1-codex'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true, // Codex has 'reasoning' events
    supportsToolUse: true,
    supportsSessions: true  // Can resume sessions with `codex exec resume`
  };

  async discoverCli(): Promise<CliDiscoveryResult> {
    const paths = this._getSearchPaths();

    for (const searchPath of paths) {
      if (await this._validateCliPath(searchPath)) {
        return { found: true, path: searchPath };
      }
    }

    return {
      found: false,
      path: 'codex',
      installCommand: 'npm install -g @openai/codex'
    };
  }

  getCliPath(): string {
    // First check if user has configured a custom path
    const config = vscode.workspace.getConfiguration('mysti');
    const configuredPath = config.get<string>('codexPath', 'codex');

    // If user specified a non-default path, use it
    if (configuredPath !== 'codex') {
      return configuredPath;
    }

    // Otherwise, search known installation paths
    const paths = this._getSearchPaths();
    for (const searchPath of paths) {
      try {
        fs.accessSync(searchPath, fs.constants.X_OK);
        console.log(`[Mysti] Codex: Found CLI at: ${searchPath}`);
        return searchPath;
      } catch {
        // Continue to next path
      }
    }

    // Fallback to default (will likely fail but provides clear error)
    return configuredPath;
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const hasConfig = fs.existsSync(configPath);

    return {
      type: 'oauth', // ChatGPT account login
      isAuthenticated: hasConfig,
      configPath
    };
  }

  /**
   * Get stored usage stats from turn.completed and clear them
   */
  getStoredUsage(): { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } | null {
    const usage = this._lastUsageStats;
    this._lastUsageStats = null;
    return usage;
  }

  async checkAuthentication(): Promise<boolean> {
    const auth = await this.getAuthConfig();
    return auth.isAuthenticated;
  }

  /**
   * Override clearSession to also clear tool state
   */
  clearSession(): void {
    super.clearSession();
    this._activeToolCalls.clear();
    this._completedToolCalls.clear();
  }

  /**
   * Override buildPrompt to skip mode instructions
   * Codex's --sandbox flags handle access control at CLI level,
   * so we don't need prompt-level mode instructions that cause
   * verbose planning responses for simple messages
   */
  protected buildPrompt(
    content: string,
    context: ContextItem[],
    conversation: Conversation | null,
    _settings: Settings,
    persona?: PersonaConfig
  ): string {
    let fullPrompt = '';

    // Add persona instructions if provided (for brainstorm mode)
    if (persona) {
      const personaPrompt = this.getPersonaPrompt(persona);
      if (personaPrompt) {
        fullPrompt += personaPrompt + '\n\n';
      }
    }

    // Add context if present
    if (context.length > 0) {
      fullPrompt += this.formatContext(context);
      fullPrompt += '\n\n';
    }

    // Add conversation history
    if (conversation && conversation.messages.length > 0) {
      fullPrompt += this.formatConversationHistory(conversation);
      fullPrompt += '\n\n';
    }

    // Add the current message - NO mode instructions appended
    fullPrompt += content;

    return fullPrompt;
  }

  /**
   * Override sendMessage to use codex exec with proper argument passing
   * Codex exec expects: codex exec [flags] "prompt"
   * @param panelId Optional panel ID for per-panel process tracking
   * @param providerManager Optional ProviderManager for registering process
   */
  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    providerManager?: unknown
  ): AsyncGenerator<StreamChunk> {
    const cliPath = this.getCliPath();

    // Build prompt with context and persona
    const fullPrompt = this.buildPrompt(content, context, conversation, settings, persona);

    // Build CLI arguments
    const args = this._buildCodexArgs(settings);

    // Add prompt as the last argument (use '-' to read from stdin for long prompts)
    // For shorter prompts we could pass directly, but stdin is safer for any length
    args.push('-');

    try {
      // Get workspace folder for CWD
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

      console.log(`[Mysti] ${this.displayName}: Starting CLI`);
      console.log(`[Mysti] ${this.displayName}: Command: ${cliPath} ${args.join(' ')}`);
      console.log(`[Mysti] ${this.displayName}: Working directory: ${cwd}`);

      // Spawn the process
      this._currentProcess = spawn(cliPath, args, {
        cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Register process with ProviderManager for per-panel cancellation
      if (panelId && providerManager && typeof (providerManager as any).registerProcess === 'function') {
        (providerManager as any).registerProcess(panelId, this._currentProcess);
      }

      // Collect stderr for error reporting
      let stderrOutput = '';
      if (this._currentProcess.stderr) {
        this._currentProcess.stderr.on('data', (data) => {
          const text = data.toString();
          stderrOutput += text;
          // In --json mode, activity goes to stderr, results to stdout
          // So stderr might contain useful progress info
          console.log(`[Mysti] ${this.displayName} stderr:`, text);
        });
      }

      // Send prompt via stdin (using '-' argument)
      if (this._currentProcess.stdin) {
        this._currentProcess.stdin.write(fullPrompt);
        this._currentProcess.stdin.end();
      }

      // Process stream output
      yield* this._processCodexStream();

      // Yield final done with any stored usage from stream parsing
      const storedUsage = this.getStoredUsage();
      yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
    } catch (error) {
      yield this.handleError(error);
    } finally {
      this._currentProcess = null;
      // Clear process tracking when done
      if (panelId && providerManager && typeof (providerManager as any).clearProcess === 'function') {
        (providerManager as any).clearProcess(panelId);
      }
    }
  }

  /**
   * Build Codex-specific CLI arguments
   *
   * Key flags from codex exec --help:
   * - --sandbox, -s: read-only | workspace-write | danger-full-access
   * - --full-auto: workspace-write sandbox with auto-approve on request
   * - --dangerously-bypass-approvals-and-sandbox: skip all confirmations (DANGEROUS)
   * - --json: output JSONL events to stdout
   * - --model, -m: override configured model
   * - --skip-git-repo-check: allow running outside git repo
   */
  private _buildCodexArgs(settings: Settings): string[] {
    const args: string[] = ['exec'];

    // Always use JSON mode for structured streaming output
    args.push('--json');

    // Map Mysti settings to Codex sandbox flags
    // Priority: mode restrictions first, then access level
    this._addSandboxFlags(args, settings);

    // Only set model if it's a valid Codex model (not a Claude model)
    // This prevents passing Claude model names like 'claude-sonnet-4-5-20250929' to Codex
    if (settings.model) {
      const validCodexModels = this.config.models.map(m => m.id);
      if (validCodexModels.includes(settings.model)) {
        // Only pass model if different from Codex default
        if (settings.model !== this.config.defaultModel) {
          args.push('--model', settings.model);
        }
      }
      // If model is not a valid Codex model, don't pass --model flag
      // Codex will use its own default
    }

    // Skip git repo check - useful if workspace isn't a git repo
    args.push('--skip-git-repo-check');

    return args;
  }

  /**
   * Add sandbox flags based on mode and access level
   * Maps Mysti settings to Codex CLI sandbox modes
   */
  private _addSandboxFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    // Plan and brainstorm modes are always read-only (no file modifications)
    if (mode === 'plan' || mode === 'brainstorm') {
      args.push('--sandbox', 'read-only');
      console.log('[Mysti] Codex: Using read-only sandbox (plan/brainstorm mode)');
      return;
    }

    // Read-only access level enforces read-only sandbox regardless of operation mode
    if (accessLevel === 'read-only') {
      args.push('--sandbox', 'read-only');
      console.log('[Mysti] Codex: Using read-only sandbox (read-only access level)');
      return;
    }

    // Full access - bypass all approvals and sandboxing (DANGEROUS)
    if (accessLevel === 'full-access') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
      console.log('[Mysti] Codex: Bypassing all approvals and sandbox (full-access)');
      return;
    }

    // edit-automatically + ask-permission = workspace-write with auto-approve
    if (mode === 'edit-automatically') {
      args.push('--full-auto');
      console.log('[Mysti] Codex: Using full-auto mode (edit-automatically)');
      return;
    }

    // ask-before-edit + ask-permission = workspace-write (CLI prompts)
    if (mode === 'ask-before-edit' && accessLevel === 'ask-permission') {
      args.push('--sandbox', 'workspace-write');
      console.log('[Mysti] Codex: Using workspace-write sandbox (ask-before-edit)');
      return;
    }

    // Fallback: read-only sandbox (safest option)
    args.push('--sandbox', 'read-only');
    console.log('[Mysti] Codex: Using read-only sandbox (fallback)');
  }

  /**
   * Process Codex JSONL stream output
   *
   * Event types from codex exec --json:
   * - thread.started, turn.started, turn.completed, turn.failed
   * - item.started, item.updated, item.completed
   * - error (unrecoverable errors)
   *
   * Item types:
   * - agent_message: Text response from the agent
   * - reasoning: Internal reasoning/thinking
   * - command_execution: Shell command execution
   * - file_change: File modifications
   * - mcp_tool_call: MCP tool invocations
   * - web_search: Web search operations
   * - todo_list: Task tracking
   */
  private async *_processCodexStream(): AsyncGenerator<StreamChunk> {
    let buffer = '';
    let hasYieldedContent = false;

    if (this._currentProcess?.stdout) {
      for await (const chunk of this._currentProcess.stdout) {
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        // Process complete lines (JSONL format)
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            const parsed = this._parseCodexEvent(line);
            if (parsed) {
              hasYieldedContent = true;
              yield parsed;
            }
          }
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const parsed = this._parseCodexEvent(buffer);
      if (parsed) {
        hasYieldedContent = true;
        yield parsed;
      }
    }

    // Wait for process to complete
    const exitCode = await this.waitForProcess();

    if (exitCode !== 0 && exitCode !== null && !hasYieldedContent) {
      yield { type: 'error', content: `Codex exited with code ${exitCode}` };
    }
  }

  /**
   * Parse a Codex JSONL event line
   */
  private _parseCodexEvent(line: string): StreamChunk | null {
    try {
      const event = JSON.parse(line);

      // Handle different Codex event types
      switch (event.type) {
        // Thread/session events
        case 'thread.started':
          if (event.thread_id) {
            this._currentSessionId = event.thread_id;
            return { type: 'session_active', sessionId: event.thread_id };
          }
          return null;

        case 'turn.completed':
          // Turn completed - store usage stats for retrieval by getStoredUsage()
          const usage = event.usage || event.turn?.usage;
          if (usage) {
            this._lastUsageStats = {
              input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
              output_tokens: usage.output_tokens || usage.completion_tokens || 0,
              // Codex uses cached_input_tokens, map to cache_read_input_tokens
              cache_read_input_tokens: usage.cached_input_tokens
            };
          }
          return null; // Don't return done here - let sendMessage handle it

        case 'turn.failed':
          return { type: 'error', content: event.error || 'Turn failed' };

        // Item events - these contain the actual content
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          // All item events go through the same parser
          // - item.started: emits tool_use with status 'running'
          // - item.updated: emits deltas for streaming content
          // - item.completed: emits tool_result with status 'completed'
          return this._parseCodexItem(event);

        // Direct error event
        case 'error':
          return { type: 'error', content: event.message || event.error || 'Unknown error' };

        default:
          // Try to extract content from unknown event types
          if (event.content || event.text || event.message) {
            const content = event.content || event.text || event.message;
            // Check if content looks like thinking (starts and ends with **)
            if (typeof content === 'string' && content.startsWith('**') && content.endsWith('**')) {
              const thinking = content.replace(/^\*\*/, '').replace(/\*\*$/, '').trim() + '\n';
              return { type: 'thinking', content: thinking };
            }
            return { type: 'text', content };
          }
          return null;
      }
    } catch {
      // If it's not JSON, treat as plain text output
      if (line.trim()) {
        // Check if line looks like thinking (starts and ends with **)
        if (line.startsWith('**') && line.endsWith('**')) {
          const thinking = line.replace(/^\*\*/, '').replace(/\*\*$/, '').trim() + '\n';
          return { type: 'thinking', content: thinking };
        }
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  /**
   * Parse a Codex item event into a StreamChunk
   * Improved to handle delta updates for streaming and proper tool state tracking
   */
  private _parseCodexItem(event: any): StreamChunk | null {
    const item = event.item || event;
    const itemType = item.type || item.item_type;
    const eventType = event.type; // 'item.updated' vs 'item.completed'

    console.log('[Mysti] Codex item event:', JSON.stringify({ eventType, itemType, item: item }));

    switch (itemType) {
      case 'agent_message':
      case 'message': {
        // Codex sends full text in item.text, not streaming deltas
        const text = item.text || item.content || item.message || '';
        if (text) {
          return { type: 'text', content: text };
        }
        return null;
      }

      case 'reasoning':
      case 'thinking': {
        // Codex sends reasoning as item.text, not streaming deltas
        let thinking = item.text || item.content || item.reasoning || '';
        console.log('[Mysti] Codex thinking raw:', JSON.stringify(thinking));
        if (thinking) {
          // Clean up thinking: remove ** from beginning and end, add newline
          thinking = thinking.replace(/^\*\*/, '').replace(/\*\*$/, '').trim() + '\n';
          console.log('[Mysti] Codex thinking cleaned:', JSON.stringify(thinking));
          return { type: 'thinking', content: thinking };
        }
        return null;
      }

      case 'command_execution':
      case 'shell': {
        // Shell command handling - Codex uses 'command' and 'aggregated_output'
        const toolId = item.id || `tool-${Date.now()}`;

        // DEDUPLICATION: Skip if this tool has already completed
        if (this._completedToolCalls.has(toolId)) {
          return null;
        }

        // Normalize to 'Bash' to match Claude's tool naming
        const toolName = 'Bash';

        // Codex uses 'command' field for the shell command
        const input: Record<string, any> = {
          command: item.command || ''
        };

        // Codex uses exit_code and status for completion detection
        const isCompleted = eventType === 'item.completed' ||
                           item.status === 'completed' ||
                           item.exit_code !== null && item.exit_code !== undefined;
        const isFailed = item.status === 'failed' || (item.exit_code !== null && item.exit_code !== 0);

        if (isCompleted) {
          // Mark as completed to prevent duplicate tool_result emissions
          this._completedToolCalls.add(toolId);
          this._activeToolCalls.delete(toolId);
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: toolName,
              input,
              output: item.aggregated_output || item.error || '',  // Codex uses aggregated_output
              status: isFailed ? 'failed' : 'completed'
            }
          };
        } else {
          // Only emit tool_use if not already active (prevent duplicate running events)
          if (this._activeToolCalls.has(toolId)) {
            return null;
          }
          this._activeToolCalls.set(toolId, {
            id: toolId,
            name: toolName,
            inputJson: JSON.stringify(input),
            status: 'running'
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: toolId,
              name: toolName,
              input,
              status: 'running'
            }
          };
        }
      }

      case 'mcp_tool_call':
      case 'tool_call':
      case 'function_call': {
        // Generic tool call handling (MCP tools, function calls)
        const toolId = item.id || item.call_id || `tool-${Date.now()}`;

        // DEDUPLICATION: Skip if this tool has already completed
        if (this._completedToolCalls.has(toolId)) {
          return null;
        }

        const toolName = item.name || item.tool || item.function?.name || 'tool';
        const input = item.arguments || item.input || item.function?.arguments || {};

        // Determine if this is a completion event
        const isCompleted = eventType === 'item.completed' ||
                           item.status === 'completed' ||
                           item.output !== undefined ||
                           item.result !== undefined;
        const isFailed = item.status === 'failed' || item.error;

        if (isCompleted || isFailed) {
          // Mark as completed to prevent duplicate tool_result emissions
          this._completedToolCalls.add(toolId);
          this._activeToolCalls.delete(toolId);
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: toolName,
              input,
              output: item.output || item.result || item.error,
              status: isFailed ? 'failed' : 'completed'
            }
          };
        } else {
          // Only emit tool_use if not already active (prevent duplicate running events)
          if (this._activeToolCalls.has(toolId)) {
            return null;
          }
          this._activeToolCalls.set(toolId, {
            id: toolId,
            name: toolName,
            inputJson: JSON.stringify(input),
            status: 'running'
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: toolId,
              name: toolName,
              input,
              status: 'running'
            }
          };
        }
      }

      case 'file_change':
      case 'file_edit':
      case 'write':
      case 'edit': {
        // File modification with structured format for edit report cards
        const fileId = item.id || `file-${Date.now()}`;

        // DEDUPLICATION: Skip if this file operation has already completed
        if (this._completedToolCalls.has(fileId)) {
          return null;
        }

        const filePath = item.file_path || item.path || item.file || '';

        // Determine tool name based on operation type
        const toolName = (itemType === 'write' || item.operation === 'create') ? 'Write' : 'Edit';

        // Build structured input for edit report cards
        const input: Record<string, any> = {
          file_path: filePath
        };

        // For edits, include old/new strings for diff display
        if (toolName === 'Edit') {
          input.old_string = item.old_content || item.original || '';
          input.new_string = item.new_content || item.replacement || item.content || '';
        } else {
          // For writes, include full content
          input.content = item.content || item.new_content || '';
        }

        // Determine if this is a completion event
        const isCompleted = eventType === 'item.completed' || item.status === 'completed';
        const isFailed = item.status === 'failed' || item.error;

        if (isCompleted || isFailed) {
          // Mark as completed to prevent duplicates
          this._completedToolCalls.add(fileId);
          return {
            type: 'tool_result',
            toolCall: {
              id: fileId,
              name: toolName,
              input,
              output: isFailed ? (item.error || 'File operation failed') : 'File updated successfully',
              status: isFailed ? 'failed' : 'completed'
            }
          };
        } else {
          // Only emit tool_use if not already active
          if (this._activeToolCalls.has(fileId)) {
            return null;
          }
          this._activeToolCalls.set(fileId, {
            id: fileId,
            name: toolName,
            inputJson: JSON.stringify(input),
            status: 'running'
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: fileId,
              name: toolName,
              input,
              status: 'running'
            }
          };
        }
      }

      case 'web_search': {
        // Web search with proper status tracking
        const searchId = item.id || `search-${Date.now()}`;

        // DEDUPLICATION: Skip if this search has already completed
        if (this._completedToolCalls.has(searchId)) {
          return null;
        }

        const searchInput = { query: item.query || item.content };

        // Determine if this is a completion event
        const isCompleted = eventType === 'item.completed' || item.status === 'completed' || item.results;
        const isFailed = item.status === 'failed' || item.error;

        if (isCompleted || isFailed) {
          // Mark as completed to prevent duplicates
          this._completedToolCalls.add(searchId);
          return {
            type: 'tool_result',
            toolCall: {
              id: searchId,
              name: 'web_search',
              input: searchInput,
              output: item.results ? JSON.stringify(item.results, null, 2) : item.error,
              status: isFailed ? 'failed' : 'completed'
            }
          };
        } else {
          // Only emit tool_use if not already active
          if (this._activeToolCalls.has(searchId)) {
            return null;
          }
          this._activeToolCalls.set(searchId, {
            id: searchId,
            name: 'web_search',
            inputJson: JSON.stringify(searchInput),
            status: 'running'
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: searchId,
              name: 'web_search',
              input: searchInput,
              status: 'running'
            }
          };
        }
      }

      case 'todo_list': {
        // Task tracking - emit as text for now
        if (item.todos && Array.isArray(item.todos)) {
          const todoText = item.todos.map((t: any) =>
            `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`
          ).join('\n');
          return { type: 'text', content: `\n**Tasks:**\n${todoText}\n` };
        }
        return null;
      }

      default: {
        // Check if this is reasoning/thinking content in a different structure
        if (item.reasoning) {
          let thinking = item.reasoning;
          thinking = thinking.replace(/^\*\*/, '').replace(/\*\*$/, '').trim() + '\n';
          return { type: 'thinking', content: thinking };
        }

        // Try to extract text content from unknown item types
        // Check delta first for streaming
        if (item.delta?.content) {
          let content = item.delta.content;
          // Check if content looks like thinking (starts and ends with **)
          if (content.startsWith('**') && content.endsWith('**')) {
            content = content.replace(/^\*\*/, '').replace(/\*\*$/, '').trim() + '\n';
            return { type: 'thinking', content };
          }
          return { type: 'text', content };
        }
        const content = item.content || item.text || item.message;
        if (content && typeof content === 'string') {
          // Check if content looks like thinking (starts and ends with **)
          if (content.startsWith('**') && content.endsWith('**')) {
            const thinking = content.replace(/^\*\*/, '').replace(/\*\*$/, '').trim() + '\n';
            return { type: 'thinking', content: thinking };
          }
          return { type: 'text', content };
        }
        return null;
      }
    }
  }

  // These methods are required by abstract base but we override sendMessage
  protected buildCliArgs(settings: Settings, _hasSession: boolean): string[] {
    return this._buildCodexArgs(settings);
  }

  protected parseStreamLine(line: string): StreamChunk | null {
    return this._parseCodexEvent(line);
  }

  // Private helper methods

  private _getSearchPaths(): string[] {
    const paths: string[] = [];
    const homeDir = os.homedir();

    // Configured path first
    const config = vscode.workspace.getConfiguration('mysti');
    const configuredPath = config.get<string>('codexPath');
    if (configuredPath && configuredPath !== 'codex') {
      paths.push(configuredPath);
    }

    // Standard locations
    if (process.platform === 'win32') {
      paths.push(path.join(homeDir, 'AppData', 'Roaming', 'npm', 'codex.cmd'));
      paths.push(path.join(homeDir, 'AppData', 'Roaming', 'npm', 'codex'));
    } else {
      // macOS and Linux
      paths.push('/usr/local/bin/codex');
      paths.push('/opt/homebrew/bin/codex'); // Homebrew on Apple Silicon
      paths.push(path.join(homeDir, '.npm-global', 'bin', 'codex'));
      paths.push(path.join(homeDir, 'node_modules', '.bin', 'codex'));
      paths.push(path.join(homeDir, '.local', 'bin', 'codex'));
      // Homebrew cask location
      paths.push('/Applications/Codex.app/Contents/MacOS/codex');
    }

    // Default fallback
    paths.push('codex');

    return paths;
  }

  private async _validateCliPath(cliPath: string): Promise<boolean> {
    try {
      fs.accessSync(cliPath, fs.constants.X_OK);
      return true;
    } catch {
      // Try which/where command as fallback
      if (cliPath === 'codex') {
        return this._checkCommandExists('codex');
      }
      return false;
    }
  }

  private async _checkCommandExists(command: string): Promise<boolean> {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';

    return new Promise((resolve) => {
      const proc = spawn(checkCmd, [command], { stdio: ['ignore', 'pipe', 'ignore'] });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }
}
