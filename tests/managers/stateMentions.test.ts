/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 Phase 5 — `@problems` and `@git`.
 *
 * The @-mention surface was agents and files only. Cline offers six kinds and
 * VS Code's agent mode reads diagnostics directly; the two that carry the most
 * signal per character are the error list and the git state, and `@git` also
 * closes Phase 5's separate "git state in turn context" item.
 *
 * Both are READ-ONLY generated summaries, not files: they carry no real path,
 * nothing writes back, and a failure to resolve degrades to "not included"
 * rather than costing the user their message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MentionRouter } from '../../src/managers/MentionRouter';
import { languages, resetLanguageStubs, extensions } from '../helpers/mockVscode';
import type { Mention } from '../../src/types';

type Resolver = { _resolveStateMentions(m: Mention[]): Promise<Array<{ path: string; content?: string }>> };

function router(): Resolver {
  return new MentionRouter({} as never, {} as never, {} as never) as unknown as Resolver;
}
const mention = (type: string): Mention =>
  ({ type, value: type, displayName: '@' + type, startIndex: 0, endIndex: 1 } as Mention);

let originalGetExtension: unknown;
beforeEach(() => {
  resetLanguageStubs();
  originalGetExtension = extensions.getExtension;
});
afterEach(() => {
  resetLanguageStubs();
  (extensions as { getExtension: unknown }).getExtension = originalGetExtension;
});

describe('@problems', () => {
  it('reports "no problems" rather than an empty block', async () => {
    const [item] = await router()._resolveStateMentions([mention('problems')]);
    expect(item.path).toBe('Problems (diagnostics)');
    expect(item.content).toContain('No problems reported');
  });

  it('summarises diagnostics with counts, file, line and severity', async () => {
    languages.getDiagnostics = () => ([
      [{ fsPath: '/repo/src/a.ts' }, [
        { severity: 0, message: 'Cannot find name x', range: { start: { line: 9, character: 4 } } },
        { severity: 1, message: 'Unused var', range: { start: { line: 20, character: 0 } } },
      ]],
    ]) as never;
    const [item] = await router()._resolveStateMentions([mention('problems')]);
    expect(item.content).toContain('1 error(s), 1 warning(s)');
    expect(item.content).toContain(':10:5');           // 0-based -> 1-based
    expect(item.content).toContain('[Error] Cannot find name x');
    expect(item.content).toContain('[Warning] Unused var');
  });

  it('puts errors before warnings — 400 warnings must not bury 2 errors', async () => {
    languages.getDiagnostics = () => ([
      [{ fsPath: '/repo/w.ts' }, [{ severity: 1, message: 'warn one', range: { start: { line: 0, character: 0 } } }]],
      [{ fsPath: '/repo/e.ts' }, [{ severity: 0, message: 'err one', range: { start: { line: 0, character: 0 } } }]],
    ]) as never;
    const [item] = await router()._resolveStateMentions([mention('problems')]);
    expect(item.content!.indexOf('err one')).toBeLessThan(item.content!.indexOf('warn one'));
  });

  it('a throwing diagnostics API costs the user nothing', async () => {
    languages.getDiagnostics = () => { throw new Error('boom'); };
    await expect(router()._resolveStateMentions([mention('problems')])).resolves.toEqual([]);
  });
});

describe('@git', () => {
  const repo = (state: Record<string, unknown>) => {
    (extensions as { getExtension: unknown }).getExtension = () => ({
      isActive: true,
      exports: { getAPI: () => ({ repositories: [{ rootUri: { fsPath: '/repo' }, state }] }) },
    });
  };

  it('reports branch, upstream and changed files', async () => {
    repo({
      HEAD: { name: 'feat/x', upstream: { remote: 'origin', name: 'feat/x' }, ahead: 2, behind: 0 },
      indexChanges: [{ uri: { fsPath: '/repo/a.ts' } }],
      workingTreeChanges: [{ uri: { fsPath: '/repo/b.ts' } }],
    });
    const [item] = await router()._resolveStateMentions([mention('git')]);
    expect(item.path).toBe('Git status');
    expect(item.content).toContain('Branch: feat/x');
    expect(item.content).toContain('origin/feat/x');
    expect(item.content).toContain('ahead 2, behind 0');
    expect(item.content).toContain('Staged (1)');
    expect(item.content).toContain('a.ts');
    expect(item.content).toContain('Modified (1)');
  });

  it('says so when there is no upstream, rather than omitting the line', async () => {
    repo({ HEAD: { name: 'local-only' }, indexChanges: [], workingTreeChanges: [] });
    const [item] = await router()._resolveStateMentions([mention('git')]);
    expect(item.content).toContain('Upstream: none');
  });

  it('resolves to nothing when git is unavailable — never an error', async () => {
    (extensions as { getExtension: unknown }).getExtension = () => undefined;
    await expect(router()._resolveStateMentions([mention('git')])).resolves.toEqual([]);
  });
});

describe('both are bounded and inert', () => {
  it('a huge diagnostics list is capped and says so', async () => {
    const many = Array.from({ length: 4000 }, (_, i) => (
      { severity: 0, message: `error number ${i} with a reasonably long message`, range: { start: { line: i, character: 0 } } }
    ));
    languages.getDiagnostics = () => ([[{ fsPath: '/repo/a.ts' }, many]]) as never;
    const [item] = await router()._resolveStateMentions([mention('problems')]);
    expect(item.content!.length).toBeLessThan(9000);
    expect(item.content).toContain('[truncated]');
  });

  it('nothing is produced when neither is mentioned', async () => {
    await expect(router()._resolveStateMentions([mention('file')])).resolves.toEqual([]);
  });
});
