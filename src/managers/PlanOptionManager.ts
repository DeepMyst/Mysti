/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import { ResponseClassifier } from './ResponseClassifier';
import type { PlanOption, PlanDetectionResult, ResponseClassification, ClarifyingQuestion } from '../types';

/**
 * PlanOptionManager - AI-powered detection of plan options and clarifying questions
 * Delegates to ResponseClassifier for intelligent content analysis
 */
export class PlanOptionManager {
  private _classifier: ResponseClassifier;

  constructor() {
    this._classifier = new ResponseClassifier();
  }

  /**
   * Analyze an AI response using AI-powered classification
   * Returns both plan options and clarifying questions
   */
  async classifyResponse(content: string): Promise<ResponseClassification> {
    return this._classifier.classify(content);
  }

  /**
   * Legacy method for backward compatibility - detects only plan options
   * Prefer classifyResponse() for full classification
   */
  detectPlanOptions(content: string): PlanDetectionResult {
    // For sync compatibility, return empty - use classifyResponse() instead
    console.warn('[Mysti] PlanOptionManager.detectPlanOptions() is deprecated. Use classifyResponse() instead.');
    return {
      hasPlanOptions: false,
      options: [],
      context: content
    };
  }

  /**
   * Async version that uses AI classification for plan detection
   */
  async detectPlanOptionsAsync(content: string): Promise<PlanDetectionResult> {
    const result = await this._classifier.classify(content);
    return {
      hasPlanOptions: result.planOptions.length >= 1,
      options: result.planOptions,
      context: result.context
    };
  }

  /**
   * Check if classification result has clarifying questions
   */
  hasQuestions(result: ResponseClassification): boolean {
    return result.questions.length > 0;
  }

  /**
   * Check if classification result has plan options (allow 1+ options)
   */
  hasPlanOptions(result: ResponseClassification): boolean {
    return result.planOptions.length >= 1;
  }

  /**
   * Create a follow-up prompt when user selects a plan option
   */
  createSelectionPrompt(option: PlanOption, originalQuery: string): string {
    return `I'd like to proceed with "${option.title}".

Original request: ${originalQuery}

Please implement this approach:
${option.approach}

Go ahead and make the necessary changes.`;
  }

  /**
   * Create a follow-up message with user's question answers
   */
  createAnswerPrompt(questions: ClarifyingQuestion[], answers: Map<string, string | string[]>): string {
    const parts: string[] = ['Here are my answers to your questions:\n'];

    for (const question of questions) {
      const answer = answers.get(question.id);
      if (answer !== undefined) {
        // Format the answer based on input type
        let formattedAnswer: string;
        if (Array.isArray(answer)) {
          // Checkbox - multiple selections
          formattedAnswer = answer.join(', ');
        } else if (question.inputType === 'radio' || question.inputType === 'select') {
          // Find the label for the selected option
          const selectedOption = question.options?.find(opt => opt.value === answer);
          formattedAnswer = selectedOption?.label || answer;
        } else {
          formattedAnswer = answer;
        }

        parts.push(`**${question.question}**`);
        parts.push(`→ ${formattedAnswer}\n`);
      }
    }

    parts.push('\nPlease proceed based on these choices.');
    return parts.join('\n');
  }

  /**
   * Cancel any ongoing classification
   */
  cancel(): void {
    this._classifier.cancel();
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this._classifier.dispose();
  }
}
