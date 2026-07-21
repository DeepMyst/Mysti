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
 *
 * Patch envelope parser (Plan 19 Phase 1) — parses the Mysti coordinator's
 * atomic multi-file `<patch>` body into a list of typed operations. Format
 * (SEARCH/REPLACE hunks, à la Aider/Cline — familiar to most models):
 *
 *   *** Add: relative/path.ts
 *   <full new file content>
 *   *** Update: relative/path.ts
 *   <<<<<<< SEARCH
 *   exact existing text (must be unique in the file)
 *   =======
 *   replacement text
 *   >>>>>>> REPLACE
 *   *** Delete: relative/path.ts
 *   *** Move: old/path.ts >>> new/path.ts
 *   *** End
 *
 * Pure + total: never throws, returns {ok:false,error} on any malformation so
 * the caller can reject the WHOLE patch (atomicity) rather than apply a partial.
 */

export type PatchOp =
  | { op: 'add'; path: string; content: string }
  | { op: 'update'; path: string; search: string; replace: string }
  | { op: 'delete'; path: string }
  | { op: 'move'; path: string; dest: string };

const HEADER = /^\*\*\*\s+(Add|Update|Delete|Move):\s+(.+?)\s*$/;
const END = /^\*\*\*\s+End\s*$/;
const SEARCH_MARK = /^<{5,}\s*SEARCH\s*$/;
const SEP_MARK = /^={5,}\s*$/;
const REPLACE_MARK = /^>{5,}\s*REPLACE\s*$/;

export function parsePatchEnvelope(text: string): { ok: true; ops: PatchOp[] } | { ok: false; error: string } {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const ops: PatchOp[] = [];
  let i = 0;

  // Allow only blank lines before the first op header.
  while (i < lines.length && !HEADER.test(lines[i]) && !END.test(lines[i])) {
    if (lines[i].trim() !== '') {
      return { ok: false, error: `patch: unexpected text before the first "*** Add/Update/Delete/Move:" header — "${lines[i].slice(0, 60)}"` };
    }
    i++;
  }

  while (i < lines.length) {
    if (END.test(lines[i])) { i++; break; }
    const h = lines[i].match(HEADER);
    if (!h) { return { ok: false, error: `patch: expected an "*** <Op>:" header, got "${lines[i].slice(0, 60)}"` }; }
    const kind = h[1].toLowerCase();
    const arg = h[2];
    i++;

    if (kind === 'delete') { ops.push({ op: 'delete', path: arg }); continue; }

    if (kind === 'move') {
      const parts = arg.split('>>>').map(s => s.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return { ok: false, error: `patch: Move needs "src >>> dest", got "${arg}"` };
      }
      ops.push({ op: 'move', path: parts[0], dest: parts[1] }); continue;
    }

    if (kind === 'add') {
      const body: string[] = [];
      while (i < lines.length && !HEADER.test(lines[i]) && !END.test(lines[i])) { body.push(lines[i]); i++; }
      ops.push({ op: 'add', path: arg, content: body.join('\n') }); continue;
    }

    // update: <<<<<<< SEARCH … ======= … >>>>>>> REPLACE
    if (i >= lines.length || !SEARCH_MARK.test(lines[i])) {
      return { ok: false, error: `patch: Update "${arg}" must be followed by a "<<<<<<< SEARCH" line.` };
    }
    i++;
    const search: string[] = [];
    while (i < lines.length && !SEP_MARK.test(lines[i])) {
      if (HEADER.test(lines[i]) || END.test(lines[i])) { return { ok: false, error: `patch: Update "${arg}" SEARCH block not closed with "=======".` }; }
      search.push(lines[i]); i++;
    }
    if (i >= lines.length) { return { ok: false, error: `patch: Update "${arg}" missing "=======".` }; }
    i++; // consume =======
    const replace: string[] = [];
    while (i < lines.length && !REPLACE_MARK.test(lines[i])) {
      if (HEADER.test(lines[i]) || END.test(lines[i])) { return { ok: false, error: `patch: Update "${arg}" REPLACE block not closed with ">>>>>>> REPLACE".` }; }
      replace.push(lines[i]); i++;
    }
    if (i >= lines.length) { return { ok: false, error: `patch: Update "${arg}" missing ">>>>>>> REPLACE".` }; }
    i++; // consume >>>>>>> REPLACE
    ops.push({ op: 'update', path: arg, search: search.join('\n'), replace: replace.join('\n') });
  }

  if (ops.length === 0) { return { ok: false, error: 'patch: no operations found.' }; }
  return { ok: true, ops };
}
