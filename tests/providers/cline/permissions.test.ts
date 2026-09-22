import { describe, it, expect } from 'vitest';
import { decodeClinePermission } from '../../../src/providers/cline/ClineAcp';

const request = (title: string, kind: string, rawInput: unknown) => ({ toolCall: { toolCallId: 'tool-1', title, kind, rawInput } });
describe('Cline native permission identity', () => {
  it('rejects inherited JavaScript property names as native tools', () => {
    expect(decodeClinePermission({ toolCall: { toolCallId: 'id', title: 'constructor', rawInput: {} } })).toBeUndefined();
  });
  it('uses the final native input including command arrays', () => {
    const input = { commands: [{ command: 'printf approved > marker' }] };
    expect(decodeClinePermission(request('run_commands: write marker', 'execute', input))).toMatchObject({ name: 'Bash', input });
  });
  // 3.0.63 configured subagents (`subagent_*`) run their children without further approval once delegated.
  it.each(['Agent', 'spawn_agent', 'subagent_reviewer', 'skills', 'schedule_task', 'mcp_other'])('denies unsupported %s even when Cline labels it think', title => {
    expect(decodeClinePermission(request(title, 'think', { prompt: 'write marker' }))).toBeUndefined();
  });
  it('rejects a command disguised as a safe read', () => {
    expect(decodeClinePermission(request('run_commands: dangerous', 'read', { command: 'touch marker' }))).toBeUndefined();
  });
  it.each([{ run_in_background: true }, { background: true }, { detached: true }])('denies background inputs %j', extra => {
    expect(decodeClinePermission(request('Bash', 'execute', { command: 'touch marker', ...extra }))).toBeUndefined();
  });
  it.each([undefined, null, 'command', []])('rejects incomplete final input %j', input => {
    expect(decodeClinePermission(request('Bash', 'execute', input))).toBeUndefined();
  });
});
