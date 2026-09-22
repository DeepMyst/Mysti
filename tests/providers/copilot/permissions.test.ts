import { describe, it, expect } from 'vitest';
import { decodeCopilotPermission, copilotAcpArgs } from '../../../src/providers/copilot/CopilotAcp';
import type { Settings } from '../../../src/types';
const request = (kind: string, rawInput: unknown) => ({ toolCall: { toolCallId: 'tool-1', kind, rawInput } });
const shell = { command: 'printf approved > marker', commands: ['printf approved > marker'] };
const tracked = (kind: string, rawInput: unknown, status = 'pending') => ({ toolCallId: 'tool-1', kind, status, rawInput });
describe('Copilot native permission identity', () => {
  it('binds a sync shell request to the announced command', () => {
    const call = decodeCopilotPermission(request('execute', shell), tracked('execute', { command: shell.command, description: 'marker', mode: 'sync', shellId: 's1' }));
    expect(call).toMatchObject({ id: 'tool-1', name: 'Bash', input: { command: shell.command } });
  });
  it('binds one patched file by absolute path and diff', () => {
    const input = { fileName: '/workspace/marker', diff: '+approved' };
    expect(decodeCopilotPermission(request('edit', input), tracked('edit', '*** Begin Patch'))).toMatchObject({ name: 'Edit', input: { file_path: '/workspace/marker', diff: '+approved' } });
  });
  it('denies requests without a matching announced tool', () => {
    expect(decodeCopilotPermission(request('execute', shell))).toBeUndefined();
    expect(decodeCopilotPermission(request('execute', shell), tracked('execute', { command: 'other' }))).toBeUndefined();
    expect(decodeCopilotPermission(request('execute', shell), tracked('edit', { command: shell.command }))).toBeUndefined();
    expect(decodeCopilotPermission(request('execute', shell), tracked('execute', { command: shell.command }, 'completed'))).toBeUndefined();
  });
  it.each(['think', 'other', 'read', 'unknown'])('denies unsupported permission kind %s', kind => {
    expect(decodeCopilotPermission(request(kind, { path: '/outside', prompt: 'write marker' }), tracked(kind, {}))).toBeUndefined();
  });
  it('denies sandbox bypass URL requests', () => {
    expect(decodeCopilotPermission(request('fetch', { url: 'https://example.com', requestSandboxBypass: true }), tracked('fetch', {}))).toBeUndefined();
  });
  it.each([{ mode: 'async' }, { mode: 'async', detach: true }, { detach: false }, { unexpected: 1 }])('denies unowned command lifecycle input %j', extra => {
    expect(decodeCopilotPermission(request('execute', shell), tracked('execute', { command: shell.command, ...extra }))).toBeUndefined();
  });
  it.each([{ fileName: '/target' }, { fileName: '../target', diff: 'write' }, { diff: 'write' }])('denies unbound edits %j', input => {
    expect(decodeCopilotPermission(request('edit', input), tracked('edit', 'patch'))).toBeUndefined();
  });
  it.each(['default', 'edit-automatically', 'ask-before-edit'] as const)('exposes approval-gated shell and edit tools in %s mode', mode => {
    const args = copilotAcpArgs({ mode, accessLevel: 'ask-permission' } as Settings);
    expect(args).not.toContain('--allow-all-tools');
    expect(args).not.toContain('--allow-all');
    expect(args).not.toContain('--allow-tool');
    expect(args).not.toContain('--deny-tool');
    expect(args).not.toContain('task');
    expect(args).toEqual(expect.arrayContaining(['bash', 'apply_patch', 'edit', 'create', 'view']));
  });
  it.each([['default', 'read-only'], ['quick-plan', 'full-access'], ['detailed-plan', 'ask-permission']] as const)('keeps only read/search tools in %s/%s', (mode, accessLevel) => {
    const args = copilotAcpArgs({ mode, accessLevel } as Settings);
    expect(args).not.toContain('bash'); expect(args).not.toContain('apply_patch'); expect(args).not.toContain('edit');
    expect(args.slice(args.indexOf('--deny-tool'))).toEqual(expect.arrayContaining(['--deny-tool', 'shell', 'write']));
  });
});
