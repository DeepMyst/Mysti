/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import type { ContextItem } from '../types';

/** Human line labels from raw VS Code selection coordinates, without mutation. */
export function formatContextLineRange(
  item: Pick<ContextItem, 'startLine' | 'endLine' | 'endCharacter'>,
): string | undefined {
  const { startLine, endLine, endCharacter } = item;
  if (startLine === undefined || endLine === undefined
    || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
    || startLine < 0 || endLine < startLine
    || startLine >= Number.MAX_SAFE_INTEGER || endLine >= Number.MAX_SAFE_INTEGER
    || (endCharacter !== undefined && (!Number.isSafeInteger(endCharacter) || endCharacter < 0))) {
    return undefined;
  }
  // Old saved selections have no end column: label the recorded endpoint,
  // without inferring a range from content or rewriting the stored coordinates.
  const lastLine = endCharacter === 0 && endLine > startLine ? endLine : endLine + 1;
  return `${startLine + 1}-${lastLine}`;
}
