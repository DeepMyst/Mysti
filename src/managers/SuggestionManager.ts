import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { QuickActionSuggestion, SuggestionColor, Conversation, Message } from '../types';

const COLORS: SuggestionColor[] = ['blue', 'green', 'purple', 'orange', 'indigo', 'teal'];
const ICONS = ['💡', '🔧', '📝', '🚀', '✨', '🎯'];

/**
 * SuggestionManager - Generates AI-powered quick action suggestions using Claude Haiku 4.5
 * Uses pre-spawned CLI processes to eliminate spawn latency
 * No API key needed - uses existing Claude Code authentication
 */
export class SuggestionManager {
  private _extensionContext: vscode.ExtensionContext;
  private _currentProcess: ChildProcess | null = null;
  private _warmProcess: ChildProcess | null = null;
  private _claudePath: string;
  private _isSpawning: boolean = false;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._claudePath = this._findClaudeCliPath();

    // Pre-spawn a warm process immediately
    this._spawnWarmProcess();

    console.log('[Mysti] SuggestionManager initialized with pre-spawn CLI');
  }

  /**
   * Pre-spawn a Claude CLI process that's ready and waiting for stdin
   * This eliminates the ~500ms spawn overhead from the critical path
   */
  private _spawnWarmProcess(): void {
    if (this._isSpawning || this._warmProcess) {
      return;
    }

    this._isSpawning = true;

    try {
      this._warmProcess = spawn(this._claudePath, [
        '--print',
        '--output-format', 'text',
        '--model', 'claude-haiku-4-5-20251001'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Handle process errors - respawn on failure
      this._warmProcess.on('error', (err) => {
        console.error('[Mysti] Suggestion warm process error:', err);
        this._warmProcess = null;
        this._isSpawning = false;
      });

      // Handle unexpected close
      this._warmProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.log('[Mysti] Suggestion warm process closed with code:', code);
        }
        this._warmProcess = null;
        this._isSpawning = false;
      });

      this._isSpawning = false;
      console.log('[Mysti] Suggestion warm process spawned and ready');
    } catch (error) {
      console.error('[Mysti] Failed to spawn suggestion warm process:', error);
      this._isSpawning = false;
    }
  }

  public async generateSuggestions(
    _conversation: Conversation,
    lastMessage: Message
  ): Promise<QuickActionSuggestion[]> {
    this.cancelGeneration();

    // Let errors propagate - caller will handle by showing loading state or clearing
    const suggestions = await this._callClaude(lastMessage.content);
    if (suggestions.length > 0) {
      return suggestions;
    }

    // If AI returned empty, throw to let caller handle it
    throw new Error('No suggestions generated');
  }

  /**
   * Generate a concise title for a conversation based on the first user message
   * Uses Claude Haiku 4.5 for fast, intelligent title generation
   */
  public async generateTitle(userMessage: string): Promise<string> {
    try {
      const title = await this._generateTitleWithClaude(userMessage);
      return title || this._fallbackTitle(userMessage);
    } catch (error) {
      console.error('[Mysti] Title generation failed:', error);
      return this._fallbackTitle(userMessage);
    }
  }

  private async _generateTitleWithClaude(userMessage: string): Promise<string | null> {
    const prompt = `Generate a short, concise title (3-6 words max) for this chat conversation based on the user's first message. Return ONLY the title, no quotes, no explanation.

User message: "${userMessage.substring(0, 500)}"

Title:`;

    return new Promise((resolve) => {
      let proc: ChildProcess | null = null;

      if (this._warmProcess) {
        proc = this._warmProcess;
        this._warmProcess = null;
        console.log('[Mysti] Using warm process for title generation');
      } else {
        console.log('[Mysti] Spawning new process for title generation');
        proc = spawn(this._claudePath, [
          '--print',
          '--output-format', 'text',
          '--model', 'claude-haiku-4-5-20251001'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
      }

      let output = '';
      proc.stdin?.write(prompt);
      proc.stdin?.end();

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      const timeout = setTimeout(() => {
        proc?.kill('SIGTERM');
        resolve(null);
      }, 5000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this._spawnWarmProcess();

        if (code === 0 && output.trim()) {
          const title = output.trim().substring(0, 50);
          console.log('[Mysti] Generated title:', title);
          resolve(title);
        } else {
          resolve(null);
        }
      });

      proc.on('error', () => {
        clearTimeout(timeout);
        this._spawnWarmProcess();
        resolve(null);
      });
    });
  }

  private _fallbackTitle(content: string): string {
    const title = content.trim().substring(0, 50);
    return title.length < content.length ? `${title}...` : title;
  }

  private async _callClaude(responseContent: string): Promise<QuickActionSuggestion[]> {
    // Shorter, more focused prompt for faster response
    const prompt = `Given this AI response, suggest 6 follow-up actions as JSON array.

Response: "${responseContent.substring(0, 1000)}"

Rules:
- Extract any numbered options or "Would you like..." choices
- Make suggestions specific to this response
- Each item: {"title": "3-5 words", "description": "8 words", "prompt": "message to send"}

Return ONLY JSON array, no other text.`;

    return new Promise((resolve, reject) => {
      // Use warm process if available
      let proc: ChildProcess | null = null;

      if (this._warmProcess) {
        proc = this._warmProcess;
        this._warmProcess = null;
        console.log('[Mysti] Using warm process for suggestions');
      } else {
        // Fall back to spawning a new process
        console.log('[Mysti] No warm process, spawning new one for suggestions');
        proc = spawn(this._claudePath, [
          '--print',
          '--output-format', 'text',
          '--model', 'claude-haiku-4-5-20251001'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
      }

      this._currentProcess = proc;

      let output = '';
      let stderr = '';

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // Timeout after 10 seconds (faster model = shorter timeout)
      const timeout = setTimeout(() => {
        console.error('[Mysti] Suggestion generation timed out after 10s');
        proc?.kill('SIGTERM');
        reject(new Error('Timeout'));
      }, 10000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this._currentProcess = null;

        // Immediately respawn for next request
        this._spawnWarmProcess();

        console.log('[Mysti] Claude exited with code:', code);
        if (stderr) {
          console.error('[Mysti] Claude stderr:', stderr);
        }

        if (code === 0 && output.trim()) {
          try {
            const jsonMatch = output.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              const suggestions: QuickActionSuggestion[] = parsed.map((item: Record<string, unknown>, i: number) => ({
                id: `suggestion-${Date.now()}-${i}`,
                title: String(item.title || 'Suggestion'),
                description: String(item.description || ''),
                message: String(item.prompt || item.title || ''),
                icon: ICONS[i % ICONS.length],
                color: COLORS[i % COLORS.length]
              }));
              console.log('[Mysti] Generated suggestions:', suggestions.map(s => s.title));
              resolve(suggestions.slice(0, 6));
              return;
            } else {
              console.error('[Mysti] No JSON array found in output:', output.substring(0, 200));
            }
          } catch (e) {
            console.error('[Mysti] Failed to parse suggestions JSON:', e);
            console.error('[Mysti] Raw output:', output.substring(0, 500));
          }
        } else {
          console.error('[Mysti] Claude failed - code:', code, 'output length:', output.length);
        }
        reject(new Error(`Failed to parse (code: ${code})`));
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this._currentProcess = null;
        // Respawn on error
        this._spawnWarmProcess();
        console.error('[Mysti] Spawn error:', err);
        reject(err);
      });
    });
  }

  public cancelGeneration(): void {
    if (this._currentProcess) {
      this._currentProcess.kill('SIGTERM');
      this._currentProcess = null;
    }
  }

  public clearSuggestionHistory(): void {
    // No-op - kept for API compatibility
  }

  /**
   * Dispose the manager - kill processes
   */
  public dispose(): void {
    this.cancelGeneration();
    if (this._warmProcess) {
      this._warmProcess.kill('SIGTERM');
      this._warmProcess = null;
    }
  }

  private _findClaudeCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    const configuredPath = config.get<string>('claudeCodePath', 'claude');

    if (configuredPath !== 'claude') {
      return configuredPath;
    }

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
            console.log('[Mysti] Found Claude CLI at:', binaryPath);
            return binaryPath;
          }
        }
      }
    } catch (error) {
      console.error('[Mysti] Error searching for Claude CLI:', error);
    }

    return configuredPath;
  }
}
