import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import type {
  ICliProvider,
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  PersonaConfig,
  PersonaType
} from './IProvider';
import { PERSONA_PROMPTS } from './IProvider';
import type {
  ContextItem,
  Settings,
  Conversation,
  StreamChunk,
  ProviderConfig
} from '../../types';

/**
 * Abstract base class for CLI-based AI providers
 * Implements common functionality shared across providers
 */
export abstract class BaseCliProvider implements ICliProvider {
  protected _extensionContext: vscode.ExtensionContext;
  protected _currentProcess: ChildProcess | null = null;
  protected _currentSessionId: string | null = null;

  // Identity - must be implemented by subclasses
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly config: ProviderConfig;
  abstract readonly capabilities: ProviderCapabilities;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
  }

  // Abstract methods - must be implemented by subclasses
  abstract discoverCli(): Promise<CliDiscoveryResult>;
  abstract getCliPath(): string;
  abstract getAuthConfig(): Promise<AuthConfig>;
  abstract checkAuthentication(): Promise<boolean>;

  /**
   * Build CLI arguments for the provider
   * @param settings Current settings
   * @param hasSession Whether there's an active session
   */
  protected abstract buildCliArgs(settings: Settings, hasSession: boolean): string[];

  /**
   * Parse a single line of stream output
   * @param line Raw line from CLI output
   */
  protected abstract parseStreamLine(line: string): StreamChunk | null;

  // Common implementations

  async initialize(): Promise<void> {
    const discovery = await this.discoverCli();
    if (!discovery.found) {
      console.warn(`[Mysti] ${this.displayName} CLI not found at ${discovery.path}`);
    } else {
      console.log(`[Mysti] ${this.displayName} CLI found at ${discovery.path}`);
    }
  }

  dispose(): void {
    this.cancelCurrentRequest();
  }

  clearSession(): void {
    console.log(`[Mysti] ${this.displayName}: Clearing session:`, this._currentSessionId);
    this._currentSessionId = null;
  }

  hasSession(): boolean {
    return this._currentSessionId !== null;
  }

  getSessionId(): string | null {
    return this._currentSessionId;
  }

  cancelCurrentRequest(): void {
    if (this._currentProcess) {
      console.log(`[Mysti] ${this.displayName}: Cancelling request`);
      this._currentProcess.kill('SIGTERM');
      this._currentProcess = null;
    }
  }

  /**
   * Get stored usage stats from parsing (if any)
   * Override in subclasses to provide usage from parsed stream events
   */
  getStoredUsage(): { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null {
    return null;
  }

  /**
   * Send a message to the AI provider
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
    const args = this.buildCliArgs(settings, this.hasSession());

    // Build prompt with context and persona
    const fullPrompt = this.buildPrompt(content, context, conversation, settings, persona);

    try {
      // Get workspace folder for CWD
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

      console.log(`[Mysti] ${this.displayName}: Starting CLI with args:`, args);
      console.log(`[Mysti] ${this.displayName}: Working directory:`, cwd);

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
          console.log(`[Mysti] ${this.displayName} stderr:`, text);
        });
      }

      // Send prompt via stdin
      if (this._currentProcess.stdin) {
        this._currentProcess.stdin.write(fullPrompt);
        this._currentProcess.stdin.end();
      }

      // Process stream output
      yield* this.processStream(stderrOutput);

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
   * Process the CLI output stream
   */
  protected async *processStream(stderrCollector: string): AsyncGenerator<StreamChunk> {
    let buffer = '';
    let hasYieldedContent = false;

    if (this._currentProcess?.stdout) {
      for await (const chunk of this._currentProcess.stdout) {
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            const parsed = this.parseStreamLine(line);
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
      const parsed = this.parseStreamLine(buffer);
      if (parsed) {
        hasYieldedContent = true;
        yield parsed;
      }
    }

    // Wait for process to complete
    const exitCode = await this.waitForProcess();

    // Handle errors
    if (exitCode !== 0 && exitCode !== null && !hasYieldedContent && stderrCollector) {
      yield { type: 'error', content: stderrCollector };
    } else if (!hasYieldedContent && stderrCollector) {
      yield { type: 'error', content: `No response received. stderr: ${stderrCollector}` };
    }
  }

  /**
   * Wait for the current process to complete
   */
  protected async waitForProcess(): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      if (!this._currentProcess) {
        resolve(null);
        return;
      }

      this._currentProcess.on('close', (code) => {
        console.log(`[Mysti] ${this.displayName}: Process closed with code:`, code);
        resolve(code);
      });

      this._currentProcess.on('error', (err) => {
        console.error(`[Mysti] ${this.displayName}: Process error:`, err);
        reject(err);
      });
    });
  }

  /**
   * Build the full prompt with context, history, and persona
   */
  protected buildPrompt(
    content: string,
    context: ContextItem[],
    conversation: Conversation | null,
    settings: Settings,
    persona?: PersonaConfig
  ): string {
    let fullPrompt = '';

    // Add persona instructions if provided
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

    // Add the current message
    fullPrompt += content;

    // Add mode-specific instructions
    fullPrompt = this.addModeInstructions(fullPrompt, settings.mode);

    return fullPrompt;
  }

  /**
   * Get the prompt for a given persona
   */
  protected getPersonaPrompt(persona: PersonaConfig): string {
    if (persona.type === 'custom' && persona.customPrompt) {
      return `[Custom Persona] ${persona.customPrompt}`;
    }
    return PERSONA_PROMPTS[persona.type as Exclude<PersonaType, 'custom'>] || '';
  }

  /**
   * Format context items for the prompt
   */
  protected formatContext(context: ContextItem[]): string {
    let formatted = '# Context Files\n\n';

    for (const item of context) {
      if (item.type === 'file') {
        formatted += `## ${item.path}\n`;
        formatted += `\`\`\`${item.language || ''}\n${item.content}\n\`\`\`\n\n`;
      } else if (item.type === 'selection') {
        formatted += `## Selection from ${item.path} (lines ${item.startLine}-${item.endLine})\n`;
        formatted += `\`\`\`${item.language || ''}\n${item.content}\n\`\`\`\n\n`;
      }
    }

    return formatted;
  }

  /**
   * Format conversation history for the prompt
   */
  protected formatConversationHistory(conversation: Conversation): string {
    let formatted = '# Previous Conversation\n\n';

    // Include last 10 messages
    for (const message of conversation.messages.slice(-10)) {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      formatted += `**${role}:** ${message.content}\n\n`;
    }

    return formatted;
  }

  /**
   * Add mode-specific instructions to the prompt
   */
  protected addModeInstructions(prompt: string, mode: string): string {
    const modeInstructions: Record<string, string> = {
      'ask-before-edit': '\n\n[Mode: Ask before making any edits. Explain what changes you want to make and wait for approval before modifying any files.]',
      'edit-automatically': '\n\n[Mode: You may edit files directly without asking for permission.]',
      'plan': '\n\n[Mode: Planning mode. Create a detailed plan for the task without making any actual changes. Break down the work into steps.]'
    };

    return prompt + (modeInstructions[mode] || '');
  }

  /**
   * Handle errors from the CLI
   */
  protected handleError(error: unknown): StreamChunk {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Mysti] ${this.displayName}: Error:`, errorMessage);
    return { type: 'error', content: errorMessage };
  }
}
