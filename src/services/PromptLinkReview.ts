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

/**
 * The text a `vscode://DeepMyst.mysti/prompt` link carried, held until its
 * reader decides.
 *
 * A link's text is aimed at an agent that can edit the workspace, and it comes
 * from anyone who can get the editor to open a URI. So it is never placed in
 * the chat box on a dialog's say-so: a dialog can show a prefix of it at most,
 * and the chat box shows a few lines of however many arrive. The WHOLE text is
 * shown read-only in an editor tab, and the one control that places it sits
 * under the last line — reached by reading past everything it would place.
 *
 * No `vscode` import: the extension maps `content` to a
 * `TextDocumentContentProvider` and `lenses` to CodeLenses, and this stays
 * testable without an editor.
 */
import * as crypto from 'crypto';

export const PROMPT_LINK_SCHEME = 'mysti-link-prompt';
export const PROMPT_LINK_PLACE_COMMAND = 'mysti.linkPrompt.place';
export const PROMPT_LINK_DISCARD_COMMAND = 'mysti.linkPrompt.discard';
/** A page that fires links in a loop fills nothing: the oldest held text goes. */
export const PROMPT_LINK_MAX_PENDING = 5;

export interface PromptLinkLens {
  /** Zero-based line of the read-only document the lens sits above. */
  line: number;
  title: string;
  /** Empty for a lens that only says something. */
  command: string;
  arguments?: unknown[];
}

export class PromptLinkReview {
  private readonly _pending = new Map<string, string>();

  /** `onEvict` is told the id of a text pushed out, so its tab can be closed. */
  constructor(private readonly _onEvict?: (id: string) => void) {}

  /** Keep the text and return the id its document, lenses and commands go by. */
  hold(text: string): string {
    const id = crypto.randomUUID();
    this._pending.set(id, text);
    while (this._pending.size > PROMPT_LINK_MAX_PENDING) {
      const oldest = this._pending.keys().next().value;
      if (oldest === undefined) { break; }
      this._pending.delete(oldest);
      this._onEvict?.(oldest);
    }
    return id;
  }

  /**
   * What the read-only document shows: the text exactly, then one empty line.
   * The empty line is where the choice hangs — a CodeLens is drawn ABOVE its
   * line, so one on the text's own last line would sit over that line instead
   * of under it.
   */
  content(id: string): string {
    const text = this._pending.get(id);
    return text === undefined ? '' : `${text}\n`;
  }

  lenses(id: string): PromptLinkLens[] {
    const text = this._pending.get(id);
    if (text === undefined) { return []; }
    const lines = text.split('\n').length;
    return [
      {
        line: 0,
        title: `From a link outside the editor · ${text.length} characters on ${lines} lines · the choice is under the last line`,
        command: '',
      },
      {
        line: lines,
        title: 'Put this in the Mysti chat box (replaces what is typed there)',
        command: PROMPT_LINK_PLACE_COMMAND,
        arguments: [id],
      },
      { line: lines, title: 'Discard', command: PROMPT_LINK_DISCARD_COMMAND, arguments: [id] },
    ];
  }

  /** Take the text out — once. A second press, a stale id or a guess gets nothing. */
  take(id: unknown): string | undefined {
    if (typeof id !== 'string') { return undefined; }
    const text = this._pending.get(id);
    this._pending.delete(id);
    return text;
  }
}
