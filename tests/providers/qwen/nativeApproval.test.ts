import { describe, expect, it } from 'vitest';
import { decodeQwenPermission } from '../../../src/providers/qwen/QwenNativeApproval';

function request(name = 'run_shell_command', kind = 'execute', input: object = { command: 'printf approved > marker' }) {
  return { sessionId: 'session', toolCall: { toolCallId: 'tool', status: 'pending', kind, rawInput: input, _meta: { toolName: name } } };
}
describe('Qwen exact native approval inputs', () => {
  it('carries the exact native command and its effective working directory', () => {
    expect(decodeQwenPermission(request(), '/workspace')?.input).toEqual({ command: 'printf approved > marker', directory: '/workspace' });
  });
  it.each([
    request('agent'), request('run_shell_command', 'read'), request('run_shell_command', 'execute', {}),
    request('run_shell_command', 'execute', { command: 'sleep 100', is_background: true }),
    request('run_shell_command', 'execute', { command: 'printf approved', dangerouslyDisableSandbox: true }),
    { toolCall: { toolCallId: 'tool', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } } },
  ])('denies unsupported authority before reaching the host', frame => {
    expect(decodeQwenPermission(frame, '/workspace')).toBeUndefined();
  });
  it('requires the actual final file diff together with edit parameters', () => {
    const frame = request('edit', 'edit', { file_path: '/workspace/file', old_string: 'before', new_string: 'after' });
    expect(decodeQwenPermission(frame, '/workspace')).toBeUndefined();
    Object.assign(frame.toolCall, { content: [{ type: 'diff', path: '/workspace/file', oldText: 'before', newText: 'after' }] });
    expect(decodeQwenPermission(frame, '/workspace')?.input.changes).toEqual([{ type: 'diff', path: '/workspace/file', oldText: 'before', newText: 'after' }]);
  });
});
