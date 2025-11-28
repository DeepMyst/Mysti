import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  ResponseClassification,
  ClarifyingQuestion,
  PlanOption,
  SuggestionColor
} from '../types';

const PLAN_COLORS: SuggestionColor[] = ['blue', 'green', 'purple', 'orange', 'indigo', 'teal'];
const PLAN_ICONS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];

/**
 * ResponseClassifier - AI-powered classification of assistant responses
 * Uses Claude Haiku to distinguish between clarifying questions and implementation plans
 */
export class ResponseClassifier {
  private _claudePath: string;
  private _warmProcess: ChildProcess | null = null;
  private _currentProcess: ChildProcess | null = null;
  private _isSpawning: boolean = false;

  constructor() {
    this._claudePath = this._findClaudeCliPath();
    this._spawnWarmProcess();
    console.log('[Mysti] ResponseClassifier initialized');
  }

  /**
   * Pre-spawn a Claude CLI process for fast response
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

      this._warmProcess.on('error', (err) => {
        console.error('[Mysti] ResponseClassifier warm process error:', err);
        this._warmProcess = null;
        this._isSpawning = false;
      });

      this._warmProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.log('[Mysti] ResponseClassifier warm process closed with code:', code);
        }
        this._warmProcess = null;
        this._isSpawning = false;
      });

      this._isSpawning = false;
      console.log('[Mysti] ResponseClassifier warm process spawned');
    } catch (error) {
      console.error('[Mysti] Failed to spawn ResponseClassifier warm process:', error);
      this._isSpawning = false;
    }
  }

  /**
   * Classify an AI response to identify questions and plan options
   */
  async classify(content: string): Promise<ResponseClassification> {
    // Quick check: if content is too short or has no structure, skip
    if (content.length < 100 || !this._hasStructuredContent(content)) {
      return { questions: [], planOptions: [], context: content };
    }

    try {
      const result = await this._callClaude(content);
      return result;
    } catch (error) {
      console.error('[Mysti] ResponseClassifier failed:', error);
      return { questions: [], planOptions: [], context: content };
    }
  }

  /**
   * Quick heuristic check for structured content
   */
  private _hasStructuredContent(content: string): boolean {
    // Check for numbered lists, headers, or question patterns
    const patterns = [
      /\d+[.\)]\s+/,              // Numbered lists
      /^#{1,3}\s+/m,              // Markdown headers
      /\?$/m,                     // Questions
      /options?:/i,               // "Options:" section
      /approach/i,                // Approach mentions
      /\b[a-d]\)/i,               // a) b) c) style options
    ];
    return patterns.some(p => p.test(content));
  }

  /**
   * Call Claude Haiku to classify the response
   */
  private async _callClaude(content: string): Promise<ResponseClassification> {
    const prompt = `Analyze this AI response and classify its interactive elements.

Response to analyze:
"""
${content.substring(0, 3000)}
"""

Return ONLY valid JSON (no markdown, no explanation) with this exact structure:
{
  "questions": [
    {
      "id": "q1",
      "question": "The exact question being asked to the user",
      "inputType": "radio",
      "options": [
        {"id": "a", "label": "First option text", "value": "first_option"},
        {"id": "b", "label": "Second option text", "value": "second_option"}
      ],
      "required": true
    }
  ],
  "planOptions": [
    {
      "id": "plan1",
      "title": "Short approach name (3-6 words)",
      "summary": "Brief 1-2 sentence description",
      "approach": "Full details of this approach",
      "pros": ["Advantage 1", "Advantage 2"],
      "cons": ["Disadvantage 1"],
      "complexity": "medium"
    }
  ],
  "context": "Any introductory text before questions/options"
}

Classification Rules:
1. "questions" = Items asking for user INPUT/PREFERENCE with short choices (no implementation details)
   - Use "radio" for single-choice questions
   - Use "checkbox" for multi-select
   - Use "text" for open-ended questions
2. "planOptions" = DETAILED implementation approaches with pros/cons/complexity
   - Must have substantial content (not just short labels)
   - Should discuss implementation, architecture, or technical approach
3. If content has BOTH questions AND implementation plans, include both
4. Return empty arrays [] if no questions or planOptions detected
5. Do NOT classify simple statements or explanations as questions

Return ONLY the JSON object, nothing else.`;

    return new Promise((resolve) => {
      let proc: ChildProcess | null = null;

      if (this._warmProcess) {
        proc = this._warmProcess;
        this._warmProcess = null;
        console.log('[Mysti] Using warm process for classification');
      } else {
        console.log('[Mysti] Spawning new process for classification');
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

      // Timeout after 8 seconds
      const timeout = setTimeout(() => {
        console.error('[Mysti] Classification timed out');
        proc?.kill('SIGTERM');
        resolve({ questions: [], planOptions: [], context: content });
      }, 8000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this._currentProcess = null;
        this._spawnWarmProcess();

        if (code === 0 && output.trim()) {
          try {
            const parsed = this._parseResponse(output, content);
            console.log('[Mysti] Classification result:', {
              questions: parsed.questions.length,
              planOptions: parsed.planOptions.length
            });
            resolve(parsed);
            return;
          } catch (e) {
            console.error('[Mysti] Failed to parse classification:', e);
          }
        } else {
          console.error('[Mysti] Classification failed - code:', code, 'stderr:', stderr);
        }

        resolve({ questions: [], planOptions: [], context: content });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this._currentProcess = null;
        this._spawnWarmProcess();
        console.error('[Mysti] Spawn error:', err);
        resolve({ questions: [], planOptions: [], context: content });
      });
    });
  }

  /**
   * Parse and validate the AI response
   */
  private _parseResponse(output: string, originalContent: string): ResponseClassification {
    // Extract JSON from output (handle potential markdown wrapping)
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in output');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and normalize questions
    const questions: ClarifyingQuestion[] = (parsed.questions || [])
      .filter((q: any) => q.question && (q.options?.length > 0 || q.inputType === 'text'))
      .map((q: any, i: number) => ({
        id: q.id || `q${i + 1}`,
        question: String(q.question),
        inputType: ['select', 'radio', 'checkbox', 'text'].includes(q.inputType) ? q.inputType : 'radio',
        options: (q.options || []).map((opt: any, j: number) => ({
          id: opt.id || `opt${j}`,
          label: String(opt.label || ''),
          description: opt.description,
          value: String(opt.value || opt.label || '')
        })),
        placeholder: q.placeholder,
        required: q.required !== false
      }));

    // Validate and normalize plan options
    const planOptions: PlanOption[] = (parsed.planOptions || [])
      .filter((p: any) => p.title && p.approach && p.approach.length > 50)
      .map((p: any, i: number) => ({
        id: p.id || `plan${i + 1}`,
        title: String(p.title).substring(0, 60),
        summary: String(p.summary || '').substring(0, 200),
        approach: String(p.approach),
        pros: Array.isArray(p.pros) ? p.pros.map(String).slice(0, 5) : [],
        cons: Array.isArray(p.cons) ? p.cons.map(String).slice(0, 5) : [],
        complexity: ['low', 'medium', 'high'].includes(p.complexity) ? p.complexity : 'medium',
        icon: PLAN_ICONS[i % PLAN_ICONS.length],
        color: PLAN_COLORS[i % PLAN_COLORS.length]
      }));

    return {
      questions,
      planOptions,
      context: String(parsed.context || '').substring(0, 500)
    };
  }

  /**
   * Cancel any ongoing classification
   */
  cancel(): void {
    if (this._currentProcess) {
      this._currentProcess.kill('SIGTERM');
      this._currentProcess = null;
    }
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.cancel();
    if (this._warmProcess) {
      this._warmProcess.kill('SIGTERM');
      this._warmProcess = null;
    }
  }

  /**
   * Find Claude CLI path (same as SuggestionManager)
   */
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
