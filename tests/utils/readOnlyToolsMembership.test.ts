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
 * READ_ONLY_TOOLS membership snapshot (Plan 23/24 follow-up).
 *
 * This Set UNGATES a tool before every mode check — it is the "never gated"
 * list consumed by `classifyToolAction`, and every CLI backend runs with its
 * native permissions bypassed, so a single wrong string here disables the sole
 * enforcement point across every provider and every mode. That exact mistake
 * has happened once already: `task`/`agent`/`dispatch_agent` used to sit in
 * this Set until Plan 15 Phase 0 moved delegation to the gated ACTION_TOOLS.
 *
 * These are security tests, not tidiness tests: the membership below is an
 * exact snapshot. Adding a name to READ_ONLY_TOOLS must fail here first, so
 * the addition is a REVIEWED decision, never a drive-by in a vocabulary sweep.
 */
import { describe, it, expect } from 'vitest';
import { READ_ONLY_TOOLS } from '../../src/utils/toolNames';

/** Exact expected membership, sorted. Update ONLY with a reviewed diff. */
const EXPECTED: readonly string[] = [
  'ask_followup_question',
  'ask_user',
  'ask_user_question',
  'askuserquestion',
  'bashoutput',
  'cat',
  'codebase_search',
  'directory_tree',
  'exit_plan_mode',
  'exitplanmode',
  'find_files',
  'glob',
  'grep',
  'list',
  'list_dir',
  'list_directory',
  'list_files',
  'ls',
  'notebook_read',
  'notebookread',
  'open_file',
  'read',
  'read_file',
  'read_files',
  'read_many_files',
  'readfile',
  'search',
  'search_file_content',
  'search_files',
  'todo_read',
  'todo_write',
  'todoread',
  'todowrite',
  'tool_search',
  'toolsearch',
  'view',
  'view_file',
];

describe('READ_ONLY_TOOLS membership snapshot', () => {
  it('matches the reviewed membership exactly (no additions, no removals)', () => {
    const actual = [...READ_ONLY_TOOLS].sort();
    expect(actual).toEqual([...EXPECTED].sort());
    expect(READ_ONLY_TOOLS.size).toBe(EXPECTED.length);
  });

  it('never contains delegation tools (Plan 15 Phase 0 regression guard)', () => {
    for (const name of ['task', 'agent', 'dispatch_agent', 'delegate', 'spawn', 'subagent']) {
      expect(READ_ONLY_TOOLS.has(name), name).toBe(false);
    }
  });

  it('never contains write/exec-shaped names', () => {
    for (const name of [
      'write', 'write_file', 'edit', 'edit_file', 'bash', 'execute', 'exec',
      'run', 'run_command', 'shell', 'apply_patch', 'create_file', 'delete',
      'rm', 'mv', 'fetch', 'web_fetch', 'browser',
    ]) {
      expect(READ_ONLY_TOOLS.has(name), name).toBe(false);
    }
  });

  it('never contains prototype-polluting names', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(READ_ONLY_TOOLS.has(name), name).toBe(false);
    }
  });
});
