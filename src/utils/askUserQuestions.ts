/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { AskUserQuestionItem } from '../types';
import { isRecord } from './valueGuards';

/** Validate the whole card before assigning answer ownership. Optional display
 * fields retain backwards-compatible defaults; malformed supplied fields never
 * produce a partially answerable question or rewrite the model's text. */
export function normalizeAskUserQuestions(value: unknown): AskUserQuestionItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0) { return undefined; }
  const questions: AskUserQuestionItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.question !== 'string' || !item.question.trim()
      || (item.header !== undefined && typeof item.header !== 'string')
      || (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean')
      || (item.options !== undefined && !Array.isArray(item.options))) { return undefined; }
    const options: AskUserQuestionItem['options'] = [];
    for (const option of item.options ?? []) {
      if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim()
        || (option.description !== undefined && typeof option.description !== 'string')) { return undefined; }
      options.push({ label: option.label, description: typeof option.description === 'string' ? option.description : '' });
    }
    questions.push({ question: item.question, header: typeof item.header === 'string' ? item.header : '', options,
      multiSelect: typeof item.multiSelect === 'boolean' ? item.multiSelect : false });
  }
  return questions;
}
