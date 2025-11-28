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
import { PERSONA_PROMPTS, DEVELOPER_PERSONAS, DEVELOPER_SKILLS } from './IProvider';
import type {
  ContextItem,
  Settings,
  Conversation,
  StreamChunk,
  ProviderConfig,
  AgentConfiguration
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

  /**
   * Get thinking tokens based on thinking level
   * @param thinkingLevel The thinking level setting
   * @returns Token count or undefined if not supported
   */
  protected abstract getThinkingTokens(thinkingLevel: string): number | undefined;

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
   * @param agentConfig Optional agent configuration (personas + skills)
   */
  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration
  ): AsyncGenerator<StreamChunk> {
    const cliPath = this.getCliPath();
    const args = this.buildCliArgs(settings, this.hasSession());

    // Build prompt with context, persona, and agent config
    const fullPrompt = this.buildPrompt(content, context, conversation, settings, persona, agentConfig);

    try {
      // Get workspace folder for CWD
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

      console.log(`[Mysti] ${this.displayName}: Starting CLI with args:`, args);
      console.log(`[Mysti] ${this.displayName}: Working directory:`, cwd);

      // Build environment with thinking tokens if applicable
      const thinkingTokens = this.getThinkingTokens(settings.thinkingLevel);
      const env: Record<string, string | undefined> = { ...process.env };
      if (thinkingTokens && thinkingTokens > 0) {
        env.MAX_THINKING_TOKENS = String(thinkingTokens);
        console.log(`[Mysti] ${this.displayName}: Setting MAX_THINKING_TOKENS:`, thinkingTokens);
      }

      // Spawn the process
      this._currentProcess = spawn(cliPath, args, {
        cwd,
        env,
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
   * Build agent instructions from persona + skills configuration
   * Returns empty string if nothing configured (default CLI behavior)
   */
  protected buildAgentInstructions(agentConfig?: AgentConfiguration): string {
    if (!agentConfig || (!agentConfig.personaId && agentConfig.enabledSkills.length === 0)) {
      return '';
    }

    const parts: string[] = [];

    // Add persona instructions if selected
    if (agentConfig.personaId) {
      const persona = DEVELOPER_PERSONAS[agentConfig.personaId];
      if (persona) {
        parts.push(`[Persona: ${persona.name}]\n${persona.keyCharacteristics}`);
      }
    }

    // Add skill instructions if any enabled
    if (agentConfig.enabledSkills.length > 0) {
      const skillInstructions = agentConfig.enabledSkills
        .map(skillId => DEVELOPER_SKILLS[skillId]?.instructions)
        .filter(Boolean)
        .join(' ');
      if (skillInstructions) {
        parts.push(`[Active Skills]\n${skillInstructions}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Build the full prompt with context, history, persona, and agent config
   */
  protected buildPrompt(
    content: string,
    context: ContextItem[],
    conversation: Conversation | null,
    settings: Settings,
    persona?: PersonaConfig,
    agentConfig?: AgentConfiguration
  ): string {
    let fullPrompt = '';

    // PRIORITY 1: Agent configuration (new system) takes precedence
    const agentInstructions = this.buildAgentInstructions(agentConfig);
    if (agentInstructions) {
      fullPrompt += agentInstructions + '\n\n';
    }
    // PRIORITY 2: Legacy persona (for brainstorm compatibility)
    else if (persona) {
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

    // Add quick plan instruction for quick-plan mode
    if (settings.mode === 'quick-plan') {
      fullPrompt += '\n\n[Planning Mode] Create ONE concise implementation plan. Focus on the most practical approach without exploring multiple alternatives. Be brief and actionable.';
    }

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
