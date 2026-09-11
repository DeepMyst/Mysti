import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'child_process';
import { Writable } from 'node:stream';
import type { Settings } from '../../src/types';
import { shouldGateToolUse } from '../../src/utils/permissionClassifier';
import {
  TestableContinueProvider, TestableCopilotProvider,
  TestableHermesProvider, TestableKimiProvider,
} from '../helpers/providerFactory';
import {
  createContinueSession, createCopilotSession,
  createHermesSession, createKimiSession,
} from '../helpers/sessionFactory';

const settings = (mode: Settings['mode'], accessLevel: Settings['accessLevel']): Settings => ({
  mode, accessLevel, thinkingLevel: 'none', contextMode: 'auto', model: '', provider: 'hermes',
});

describe.each([
  ['Hermes', () => new TestableHermesProvider(), createHermesSession],
  ['Kimi', () => new TestableKimiProvider(), createKimiSession],
] as const)('%s native permission policy', (_name, createProvider, createSession) => {
  it.each(['edit', 'execute', 'delete', 'fetch'])('denies an unowned %s request under ask-before-edit even with full access', kind => {
    const provider = createProvider();
    const session = createSession();
    session.acpMode = 'ask-before-edit';
    session.acpAccessLevel = 'full-access';
    const written: string[] = [];
    session.persistentProcess = {
      stdin: new Writable({ write(chunk, _encoding, callback) { written.push(String(chunk)); callback(); } }),
    } as unknown as ChildProcess;

    expect(shouldGateToolUse(settings('ask-before-edit', 'full-access'), 'Bash')).toBe(true);
    const chunk = provider.parseStreamLine(JSON.stringify({
      jsonrpc: '2.0', id: 31, method: 'session/request_permission',
      params: {
        toolCall: { kind },
        options: [
          { optionId: 'approve', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    }), session);

    expect(chunk).toBeNull();
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).result.outcome).toEqual({ outcome: 'selected', optionId: 'reject' });
  });

  it.each([
    ['read', true], ['edit', true], ['move', true],
    ['execute', false], ['delete', false], ['fetch', false], ['unknown', false],
  ] as const)('auto-edit native response for %s allows=%s', (kind, allowed) => {
    const provider = createProvider();
    const session = createSession();
    session.acpMode = 'edit-automatically';
    session.acpAccessLevel = 'ask-permission';
    const written: string[] = [];
    session.persistentProcess = {
      stdin: new Writable({ write(chunk, _encoding, callback) { written.push(String(chunk)); callback(); } }),
    } as unknown as ChildProcess;
    provider.parseStreamLine(JSON.stringify({
      jsonrpc: '2.0', id: 32, method: 'session/request_permission',
      params: {
        toolCall: { kind },
        options: [
          { optionId: 'approve', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    }), session);
    expect(JSON.parse(written[0]).result.outcome.optionId).toBe(allowed ? 'approve' : 'reject');
  });
});

describe('native CLI execution policy', () => {
  it('Continue keeps commands disabled in the auto-edit tier', () => {
    expect(() => new TestableContinueProvider().buildCliArgs(
      settings('edit-automatically', 'ask-permission'), createContinueSession(),
    )).toThrow('cannot enforce');
  });

  it('Copilot never selects legacy execution even with a cached old version', () => {
    const provider = new TestableCopilotProvider();
    (provider as unknown as { _cachedCliVersion: string })._cachedCliVersion = '0.0.372';
    const args = provider.buildCliArgs(settings('edit-automatically', 'ask-permission'), createCopilotSession());
    expect(args).toContain('--acp');
    expect(provider.capabilities.supportsNativeApproval).toBe(true);
    expect(args).not.toContain('--allow-all-tools');
  });
});
