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

import { spawn, ChildProcess } from 'child_process';
import type {
  ResponseClassification,
  ClarifyingQuestion,
  PlanOption,
  SuggestionColor
} from '../types';
import { findClaudeCliPath } from '../utils/cliDiscovery';
import { DEFAULT_LIGHTWEIGHT_MODEL } from '../constants';

const PLAN_COLORS: SuggestionColor[] = ['blue', 'green', 'purple', 'orange', 'indigo', 'teal'];
const PLAN_ICONS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];

/**
 * ResponseClassifier - AI-powered classification of assistant responses
 * Uses Claude Haiku to distinguish between clarifying questions and implementation plans
 */
export class ResponseClassifier {
  private _claudePath: string;
  private _currentProcess: ChildProcess | null = null;

  constructor() {
    this._claudePath = findClaudeCliPath();
    console.log('[Mysti] ResponseClassifier initialized with CLI path:', this._claudePath);
  }

  /**
   * Classify an AI response to identify questions and plan options
   */
  async classify(content: string): Promise<ResponseClassification> {
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

    return new Promise((resolve) => {
      console.log('[Mysti] Spawning process for classification');
      const proc = spawn(this._claudePath, [
        '--print',
        '--output-format', 'text',
        '--model', DEFAULT_LIGHTWEIGHT_MODEL
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

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

      // Timeout after 15 seconds (increased from 8)
      const timeout = setTimeout(() => {
        console.error('[Mysti] Classification timed out after 15s');
        proc?.kill('SIGTERM');
        resolve({ questions: [], planOptions: [], context: content });
      }, 15000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this._currentProcess = null;

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
          console.error('[Mysti] Classification failed - code:', code, 'stderr:', stderr.substring(0, 200));
        }

        resolve({ questions: [], planOptions: [], context: content });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this._currentProcess = null;
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
        required: q.required !== false,
        questionType: ['clarifying', 'meta'].includes(q.questionType) ? q.questionType : 'clarifying'
      }));

    // Validate and normalize plan options (removed approach length requirement)
    const planOptions: PlanOption[] = (parsed.planOptions || [])
      .filter((p: any) => p.title && p.approach)
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
  }

}
