/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 * See the LICENSE file in the project root for full license terms.
 */

interface ControlCharacterOptions {
  /** Prose may contain tab, newline and carriage return. Identifiers may not. */
  allowTextWhitespace?: boolean;
  /** C1 controls are rejected by the Desk protocol, but not all legacy text fields. */
  includeC1?: boolean;
}

/** Detect controls without rewriting input at a validation boundary. */
export function hasControlCharacters(value: string, options: ControlCharacterOptions = {}): boolean {
  const { allowTextWhitespace = false, includeC1 = true } = options;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (allowTextWhitespace && (code === 9 || code === 10 || code === 13)) { continue; }
    if (code < 32 || code === 127 || (includeC1 && code >= 128 && code <= 159)) { return true; }
  }
  return false;
}

/** Replace C0 controls and DEL in informational text before whitespace normalization. */
export function replaceAsciiControlCharacters(value: string, replacement: string): string {
  let result = '';
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      result += value.slice(start, i) + replacement;
      start = i + 1;
    }
  }
  return result + value.slice(start);
}
