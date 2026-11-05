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

import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { killProcessTree, markOwnedProcessGroup } from '../utils/processKill';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../constants';
import { spawnTextOnlyClaudeWorker } from '../utils/textOnlyClaudeWorker';
import type {
  ResponseClassification,
  ClarifyingQuestion,
  PlanOption,
  SuggestionColor
} from '../types';

const PLAN_COLORS: SuggestionColor[] = ['blue', 'green', 'purple', 'orange', 'indigo', 'teal'];
const PLAN_ICONS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];

/** Selection handles belong to the UI. A repeated model ID must never make
 * choosing one displayed plan or question address a different entry. */
function uniqueChoiceIds<T extends { id: string }>(choices: T[], prefix: string): T[] {
  const validId = (id: unknown): id is string => typeof id === 'string' && id.trim().length > 0;
  const reserved = new Set(choices.map(choice => choice.id).filter(validId));
  const used = new Set<string>();
  return choices.map((choice, index) => {
    let id = validId(choice.id) ? choice.id : '';
    if (!id || used.has(id)) {
      const base = `${prefix}${index + 1}`;
      id = base;
      let suffix = 1;
      while (used.has(id) || reserved.has(id)) { id = `${base}-${suffix++}`; }
    }
    used.add(id);
    return { ...choice, id };
  });
}

/**
 * ResponseClassifier - AI-powered classification of assistant responses
 * Uses Claude Haiku to distinguish between clarifying questions and implementation plans
 */
export class ResponseClassifier {
  private _claudePath: string;
  private _currentProcess: ChildProcess | null = null;
  private _disposed = false;
  private readonly _ownedProcesses = new Set<ChildProcess>();
  private readonly _activeOperations = new Map<ChildProcess, () => void>();

  constructor() {
    this._claudePath = this._findClaudeCliPath();
    console.log('[Mysti] ResponseClassifier initialized with CLI path:', this._claudePath);
  }

  /**
   * Classify an AI response to identify questions and plan options
   */
  async classify(content: string): Promise<ResponseClassification> {
    if (this._disposed) { return { questions: [], planOptions: [], context: content }; }
    console.log('[Mysti] ResponseClassifier: Content length:', content.length);

    // Quick check: if content is very short, skip classification
    if (content.length < 50) {
      console.log('[Mysti] ResponseClassifier: Skipping - content too short (<50 chars)');
      return { questions: [], planOptions: [], context: content };
    }

    // Let Claude decide if there are plans/questions - removed pattern check
    console.log('[Mysti] ResponseClassifier: Calling Claude for classification');

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
      /\d+[.)]\s+/,               // Numbered lists
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
      "questionType": "clarifying",
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
1. "questions" - Classify into two types using "questionType" field:

   a) **clarifying** questions (questionType: "clarifying"):
      - Ask for MISSING information, requirements, or preferences
      - AI needs answers to GENERATE implementation plans
      - Examples: "Which framework are you using?", "What's your database?", "REST or GraphQL?"
      - These questions should be answered BEFORE plans can be generated

   b) **meta** questions (questionType: "meta"):
      - Ask for APPROVAL, SELECTION, or CONFIRMATION
      - Implementation plans are ALREADY present in the same response
      - Examples: "Would you like to proceed?", "Which approach do you prefer?", "Ready to implement?"
      - These questions appear AFTER plans are shown

2. "planOptions" = DETAILED implementation approaches with pros/cons/complexity
   - Must have substantial content (not just short labels)
   - Should discuss implementation, architecture, or technical approach

3. CRITICAL: If content has implementation plans AND asks for selection/approval:
   - Mark the approval question as "meta" (questionType: "meta")
   - Include BOTH questions AND planOptions arrays in the response

4. Input types:
   - Use "radio" for single-choice questions
   - Use "checkbox" for multi-select
   - Use "text" for open-ended questions

5. Return empty arrays [] if no questions or planOptions detected

6. Do NOT classify simple statements or explanations as questions

Return ONLY the JSON object, nothing else.`;

    // Keep the CLI startup stdin deadline inside the active operation.
    const proc = this._createProcess();
    this._currentProcess = proc;
    return new Promise(resolve => {
      let output = '';
      const decoder = new StringDecoder('utf8');
      let settled = false;
      const fallback = (): ResponseClassification => ({ questions: [], planOptions: [], context: content });
      const onData = (data: Buffer) => { output += decoder.write(data); };
      const finish = (result: ResponseClassification) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        this._activeOperations.delete(proc);
        if (this._currentProcess === proc) { this._currentProcess = null; }
        proc.stdout?.removeListener('data', onData);
        proc.removeListener('close', onClose);
        proc.removeListener('error', onError);
        resolve(result);
      };
      const onClose = () => {
        output += decoder.end();
        let result = fallback();
        if (output.trim()) {
          try { result = this._parseResponse(output, content); } catch { /* Optional classification failed. */ }
        }
        finish(result);
      };
      const onError = () => { finish(fallback()); this._terminateProcess(proc); };
      this._activeOperations.set(proc, () => finish(fallback()));
      proc.stdout?.on('data', onData);
      proc.on('close', onClose);
      proc.on('error', onError);
      const timeout = setTimeout(() => { finish(fallback()); this._terminateProcess(proc); }, 20000);
      try { proc.stdin?.write(prompt); proc.stdin?.end(); } catch { onError(); }
    });
  }

  private _createProcess(): ChildProcess {
    const proc = spawnTextOnlyClaudeWorker(this._claudePath);
    markOwnedProcessGroup(proc);
    this._ownedProcesses.add(proc);
    proc.stderr?.resume();
    proc.on('error', () => {});
    proc.stdin?.on('error', () => {
      this._activeOperations.get(proc)?.();
      this._terminateProcess(proc);
    });
    proc.once('exit', () => this._terminateProcess(proc));
    proc.once('close', () => { this._ownedProcesses.delete(proc); });
    return proc;
  }

  private _terminateProcess(proc: ChildProcess): void {
    void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { initialSignal: 'SIGKILL', label: 'classification worker' });
  }

  /**
   * Parse and validate the AI response
   */
  private _parseResponse(output: string, _originalContent: string): ResponseClassification {
    // Extract JSON from output (handle potential markdown wrapping)
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in output');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and normalize questions
    const questions: ClarifyingQuestion[] = (parsed.questions || [])
      .filter((q: Record<string, unknown>) => q.question && (((q.options as unknown[] | undefined)?.length ?? 0) > 0 || q.inputType === 'text'))
      .map((q: Record<string, unknown>) => ({
        id: q.id as string,
        question: String(q.question),
        inputType: ['select', 'radio', 'checkbox', 'text'].includes(q.inputType as string) ? q.inputType as string : 'radio',
        options: uniqueChoiceIds(((q.options as Record<string, unknown>[] | undefined) || []).map((opt: Record<string, unknown>) => ({
          id: opt.id as string,
          label: String(opt.label || ''),
          description: opt.description as string | undefined,
          value: String(opt.value || opt.label || '')
        })), 'opt'),
        placeholder: q.placeholder as string | undefined,
        required: q.required !== false,
        questionType: ['clarifying', 'meta'].includes(q.questionType as string) ? q.questionType as string : 'clarifying'
      }));

    // Validate and normalize plan options (removed approach length requirement)
    const planOptions: PlanOption[] = (parsed.planOptions || [])
      .filter((p: Record<string, unknown>) => p.title && p.approach)
      .map((p: Record<string, unknown>, i: number) => ({
        id: p.id as string,
        title: String(p.title).substring(0, 60),
        summary: String(p.summary || '').substring(0, 200),
        approach: String(p.approach),
        pros: Array.isArray(p.pros) ? p.pros.map(String).slice(0, 5) : [],
        cons: Array.isArray(p.cons) ? p.cons.map(String).slice(0, 5) : [],
        complexity: ['low', 'medium', 'high'].includes(p.complexity as string) ? p.complexity : 'medium',
        icon: PLAN_ICONS[i % PLAN_ICONS.length],
        color: PLAN_COLORS[i % PLAN_COLORS.length]
      }));

    return {
      questions: uniqueChoiceIds(questions, 'q'),
      planOptions: uniqueChoiceIds(planOptions, 'plan'),
      context: String(parsed.context || '').substring(0, 500)
    };
  }

  /**
   * Cancel any ongoing classification
   */
  cancel(): void {
    const proc = this._currentProcess;
    if (proc) {
      this._activeOperations.get(proc)?.();
      this._terminateProcess(proc);
      if (this._currentProcess === proc) { this._currentProcess = null; }
    }
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    for (const settle of [...this._activeOperations.values()]) { settle(); }
    for (const proc of this._ownedProcesses) { this._terminateProcess(proc); }
    this._currentProcess = null;
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
