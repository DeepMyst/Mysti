import { describe, it, expect } from 'vitest';
import { decodeCopilotPermission, copilotAcpArgs } from '../../../src/providers/copilot/CopilotAcp';
import type { Settings } from '../../../src/types';
const request = (kind: string, rawInput: unknown) => ({ toolCall: { toolCallId: 'tool-1', kind, rawInput } });
describe('Copilot native permission identity', () => {
  it('denies shell requests even if the native agent emits a permission card', () => {
    const input = { command: 'printf approved > marker', commands: ['printf approved > marker'] };
    expect(decodeCopilotPermission(request('execute', input))).toBeUndefined();
  });
  it('rejects file edits outside the verified read/search surface', () => {
    const input = { fileName: '/workspace/marker', diff: '+approved' };
    expect(decodeCopilotPermission(request('edit', input))).toBeUndefined();
  });
  it.each(['think', 'other', 'read', 'unknown'])('denies unsupported permission kind %s', kind => {
    expect(decodeCopilotPermission(request(kind, { path: '/outside', prompt: 'write marker' }))).toBeUndefined();
  });
  it('denies sandbox bypass URL requests', () => {
    expect(decodeCopilotPermission(request('fetch', { url: 'https://example.com', requestSandboxBypass: true }))).toBeUndefined();
  });
  it.each([{ mode: 'async' }, { detach: true }, { shellId: 'prior-shell' }])('denies unowned command lifecycle input %j', original => {
    expect(decodeCopilotPermission(request('execute', { command: 'touch marker', commands: ['touch marker'] }), { rawInput: original })).toBeUndefined();
  });
  it.each([{ fileName: '/target' }, { fileName: '../target', diff: 'write' }, { diff: 'write' }])('denies unbound edits %j', input => {
    expect(decodeCopilotPermission(request('edit', input))).toBeUndefined();
  });
  it.each(['default', 'edit-automatically', 'ask-before-edit'] as const)('keeps only read/search tools in %s mode', mode => {
    const args = copilotAcpArgs({ mode, accessLevel: 'full-access' } as Settings);
    expect(args).toContain('--acp');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).not.toContain('--allow-all');
    expect(args).toContain('--available-tools');
    expect(args).not.toContain('task');
    expect(args).not.toContain('bash');
    expect(args).toContain('shell');
    expect(args).toContain('write');
    expect(args).not.toContain('apply_patch');
  });
});
