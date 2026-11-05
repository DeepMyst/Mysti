import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { Conversation, Message, Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async () => ({ ...await vi.importActual<any>('../../../src/utils/processKill'), killProcessTree: mocks.kill }));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners(); });
const SETTINGS = { provider: 'claude-code', model: 'sonnet', mode: 'default', accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none' } as Settings;
const conversation = (id = 'conversation'): Conversation => ({ id, title: 'Peer review', messages: [], createdAt: 1, updatedAt: 1, mode: 'default', model: 'sonnet', provider: 'claude-code' });
function append(history: Conversation, content: string, role: Message['role'], provider?: Message['provider']) {
  history.messages.push({ id: `${history.id}-${history.messages.length}`, timestamp: history.messages.length, content, role, ...(provider ? { provider } : {}) });
}
function peer(history: Conversation, marker: string, provider: Message['provider'] = 'github-copilot') {
  append(history, `Question ${marker}`, 'user'); append(history, `Peer answer ${marker}`, 'assistant', provider);
}

/** Real public provider send, prompt formatting, Claude initialize/user/result protocol.
 * Only the child transport is controlled; no editor, account or native CLI starts. */
function harness() {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  const provider = new TestableClaudeProvider(), internal = provider as any;
  internal._cachedCliVersion = '2.1.288';
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/claude');
  vi.spyOn(internal, 'prepareAttachments').mockResolvedValue(async () => {});
  vi.spyOn(internal, 'buildAgentInstructionsAsync').mockResolvedValue('');
  const children: Array<{ args: string[]; proc: ChildProcess; prompts: string[]; sessionId: string }> = [];
  const prompts: string[] = [];
  let behavior: 'success' | 'silent' | 'error' | 'error-array' | 'partial-error' = 'success';
  let onInput: (() => void) | undefined;
  mocks.spawn.mockImplementation((_file: string, args: string[]) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 85000 + children.length, exitCode: null, signalCode: null, killed: false });
    const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : `native-${children.length}`;
    const child = { args, proc: proc as unknown as ChildProcess, prompts: [] as string[], sessionId }; children.push(child);
    let buffer = '';
    const emit = (value: unknown) => stdout.write(JSON.stringify(value) + '\n');
    stdin.on('data', chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (message.type === 'control_request') {
          setImmediate(() => emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } }));
        } else if (message.type === 'user') {
          child.prompts.push(message.message.content.map((block: { text: string }) => block.text).join(''));
          prompts.push(child.prompts.at(-1)!);
          const outcome = behavior; behavior = 'success';
          setImmediate(() => {
            emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'sonnet' });
            onInput?.(); onInput = undefined;
            if (outcome === 'silent') return;
            if (outcome === 'error') { emit({ type: 'result', is_error: true, result: 'controlled turn failure' }); return; }
            if (outcome === 'error-array') { emit({ type: 'result', is_error: true, errors: ['controlled array failure', { ignored: true }] }); return; }
            emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Controlled Claude answer' } } });
            if (outcome === 'partial-error') { emit({ type: 'result', is_error: true, errors: ['controlled failure after partial response'] }); return; }
            emit({ type: 'result', result: '' });
          });
        }
      }
    });
    return proc;
  });
  cleanups.push(() => provider.dispose());
  const send = async (history: Conversation, content: string, panel = history.id) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage(content, [], SETTINGS, history, undefined, panel)) chunks.push(chunk);
    return { chunks, prompt: prompts.at(-1)! };
  };
  const establish = async (history = conversation()) => {
    const result = await send(history, 'OWN_FIRST_QUESTION');
    expect(result.chunks.some(chunk => chunk.type === 'text')).toBe(true);
    append(history, 'OWN_FIRST_QUESTION', 'user'); append(history, 'OWN_FIRST_ANSWER', 'assistant', 'claude-code');
    return history;
  };
  return { provider, children, send, establish, setBehavior: (next: typeof behavior) => { behavior = next; },
    withoutHistory: (content: string): Promise<string> => internal.buildPromptAsync(content, [], null, SETTINGS),
    nextInput: () => new Promise<void>(resolve => { onInput = resolve; }) };
}

describe('native resumed conversations receive intervening peer history', () => {
  it('replays Codex and Copilot on Claude return while retaining native resume and avoiding duplicates on consecutive returns', async () => {
    const h = harness(), history = await h.establish();
    peer(history, 'CODEX_ONLY', 'openai-codex'); peer(history, 'COPILOT_ONLY');
    h.provider.disposePersistentProcess(history.id);
    const resumed = await h.send(history, 'CLAUDE_RETURN');
    expect(h.children.at(-1)!.args).toContain('--resume');
    expect(h.children.at(-1)!.sessionId).toBe(h.children[0].sessionId);
    expect(resumed.prompt).toContain('Peer answer CODEX_ONLY'); expect(resumed.prompt).toContain('Peer answer COPILOT_ONLY');
    // The host persists this pair after native completion. Until explicitly
    // received in a later prompt, conservative one-time replay is intentional.
    expect(resumed.prompt).toContain('OWN_FIRST_ANSWER');
    expect(resumed.prompt.match(/CLAUDE_RETURN/g)).toHaveLength(1);
    append(history, 'CLAUDE_RETURN', 'user'); append(history, 'OWN_RETURN_ANSWER', 'assistant', 'claude-code');
    const consecutive = await h.send(history, 'CONSECUTIVE_OWN_TURN');
    expect(consecutive.prompt).not.toContain('COPILOT_ONLY'); expect(consecutive.prompt).not.toContain('CODEX_ONLY');
    append(history, 'CONSECUTIVE_OWN_TURN', 'user'); append(history, 'OWN_CONSECUTIVE_ANSWER', 'assistant', 'claude-code');
    peer(history, 'SECOND_PEER_ONLY');
    const secondReturn = await h.send(history, 'SECOND_RETURN');
    expect(secondReturn.prompt).toContain('SECOND_PEER_ONLY'); expect(secondReturn.prompt).not.toContain('COPILOT_ONLY');
  });

  it('suppresses acknowledged history while conservatively replaying the latest unacknowledged own pair', async () => {
    const h = harness(), history = await h.establish();
    expect((await h.send(history, 'FOLLOWUP_ONLY')).prompt).toContain('OWN_FIRST_ANSWER');
    expect((await h.send(history, 'NO_NEW_HISTORY')).prompt).toBe(await h.withoutHistory('NO_NEW_HISTORY'));
  });

  it('does not truncate an early peer requirement when more than ten unseen messages intervene', async () => {
    const h = harness(), history = await h.establish();
    for (let index = 0; index < 7; index++) peer(history, `PEER_${index}`);
    const result = await h.send(history, 'Review every peer requirement');
    expect(result.prompt).toContain('Peer answer PEER_0'); expect(result.prompt).toContain('Peer answer PEER_6');
  });

  it('keeps an unanswered cancelled requirement and peer response as context on recovery', async () => {
    const h = harness(), history = await h.establish();
    h.setBehavior('silent'); const received = h.nextInput();
    const stopped = h.send(history, 'CANCELLED_REQUIREMENT'); await received;
    h.provider.cancelCurrentRequest(history.id); await stopped;
    append(history, 'CANCELLED_REQUIREMENT', 'user'); peer(history, 'PEER_AFTER_STOP');
    const recovered = await h.send(history, 'NEW_RECOVERY_REQUEST');
    expect(recovered.prompt).toContain('OWN_FIRST_ANSWER');
    expect(recovered.prompt).toContain('User: CANCELLED_REQUIREMENT'); expect(recovered.prompt).toContain('Peer answer PEER_AFTER_STOP');
    expect(recovered.prompt.endsWith(await h.withoutHistory('NEW_RECOVERY_REQUEST'))).toBe(true);
  });

  it.each(['error', 'error-array', 'partial-error'] as const)('does not acknowledge failed result history (%s)', async outcome => {
    const h = harness(), history = await h.establish(); h.setBehavior(outcome);
    const failed = await h.send(history, 'FAILED_REQUIREMENT');
    expect(failed.chunks.some(chunk => chunk.type === 'error')).toBe(true);
    if (outcome === 'partial-error') expect(failed.chunks).toContainEqual({ type: 'text', content: 'Controlled Claude answer' });
    append(history, 'FAILED_REQUIREMENT', 'user'); peer(history, 'PEER_AFTER_FAILURE');
    const recovered = await h.send(history, 'RETRY_REVIEW');
    expect(recovered.prompt).toContain('User: FAILED_REQUIREMENT'); expect(recovered.prompt).toContain('OWN_FIRST_ANSWER');
  });

  it('conservatively preserves peers when a native session exists without an own assistant yet', async () => {
    const h = harness(), history = conversation(); peer(history, 'PRIOR_PEER');
    h.setBehavior('silent'); const received = h.nextInput(); const stopped = h.send(history, 'INITIAL_CANCEL'); await received;
    h.provider.cancelCurrentRequest(history.id); await stopped;
    append(history, 'INITIAL_CANCEL', 'user');
    const recovered = await h.send(history, 'FIRST_COMPLETED_REVIEW');
    expect(recovered.prompt).toContain('PRIOR_PEER'); expect(recovered.prompt).toContain('User: INITIAL_CANCEL');
  });

  it('does not treat legacy assistants without provider metadata as proof of native history ownership', async () => {
    const h = harness(), history = await h.establish();
    delete history.messages[1].provider;
    append(history, 'LEGACY_PEER_QUESTION', 'user'); append(history, 'LEGACY_PEER_ANSWER', 'assistant');
    const result = await h.send(history, 'Review the legacy transcript');
    expect(result.prompt).toContain('LEGACY_PEER_ANSWER');
  });

  it('keeps peer deltas scoped to their conversation and panel', async () => {
    const h = harness(), a = await h.establish(conversation('panel-a')), b = await h.establish(conversation('panel-b'));
    peer(a, 'PANEL_A_ONLY'); peer(b, 'PANEL_B_ONLY');
    const left = await h.send(a, 'Review A'), right = await h.send(b, 'Review B');
    expect(left.prompt).toContain('PANEL_A_ONLY'); expect(left.prompt).not.toContain('PANEL_B_ONLY');
    expect(right.prompt).toContain('PANEL_B_ONLY'); expect(right.prompt).not.toContain('PANEL_A_ONLY');
  });

  it('does not mistake another panel of the same provider for its own native history', async () => {
    const h = harness(), history = await h.establish();
    await h.send(history, 'PANEL_B_TURN', 'other-panel');
    append(history, 'PANEL_B_TURN', 'user'); append(history, 'PANEL_B_CLAUDE_ANSWER', 'assistant', 'claude-code');
    const left = await h.send(history, 'PANEL_A_RETURN');
    expect(left.prompt).toContain('PANEL_B_CLAUDE_ANSWER');
    append(history, 'PANEL_A_RETURN', 'user'); append(history, 'PANEL_A_RETURN_ANSWER', 'assistant', 'claude-code');
    const right = await h.send(history, 'PANEL_B_RETURN', 'other-panel');
    expect(right.prompt).toContain('PANEL_A_RETURN_ANSWER');
  });

  it('replays unseen IDs even when they occur before an already acknowledged later message', async () => {
    const h = harness(), history = await h.establish(); peer(history, 'KNOWN_LATER');
    await h.send(history, 'ACK_KNOWN_HISTORY');
    history.messages.splice(1, 0, { id: 'concurrent-earlier', role: 'assistant', content: 'UNSEEN_EARLIER_PEER', timestamp: 1, provider: 'claude-code' });
    const result = await h.send(history, 'REVIEW_INSERTED_PEER');
    expect(result.prompt).toContain('UNSEEN_EARLIER_PEER'); expect(result.prompt).not.toContain('KNOWN_LATER');
  });

  it('replays same-ID content or role revisions while ignoring checkpoint-only metadata changes', async () => {
    const h = harness(), history = await h.establish(); peer(history, 'ORIGINAL_PEER');
    await h.send(history, 'ACK_ORIGINAL');
    history.messages[0].checkpoint = { commit: 'late-checkpoint', createdAt: 10 };
    expect((await h.send(history, 'CHECKPOINT_ONLY')).prompt).toBe(await h.withoutHistory('CHECKPOINT_ONLY'));
    history.messages[3].content = 'REVISED_PEER_CONTENT';
    expect((await h.send(history, 'REVIEW_REVISION')).prompt).toContain('Assistant: REVISED_PEER_CONTENT');
    history.messages[3].role = 'user';
    expect((await h.send(history, 'REVIEW_ROLE_REVISION')).prompt).toContain('User: REVISED_PEER_CONTENT');
  });

  it('does not acknowledge history omitted by a native slash command', async () => {
    const h = harness(), history = await h.establish(); peer(history, 'UNREAD_DURING_COMMAND');
    expect((await h.send(history, '/compact')).prompt).toBe('/compact');
    expect((await h.send(history, 'REVIEW_AFTER_COMMAND')).prompt).toContain('UNREAD_DURING_COMMAND');
  });

  it('does not reuse acknowledgements across conversation identities on the same native session', async () => {
    const h = harness(), history = await h.establish(); await h.send(history, 'ACK_FIRST_CONVERSATION');
    const other = { ...history, id: 'other-conversation', messages: history.messages.map(message => ({ ...message })) };
    expect((await h.send(other, 'OTHER_CONVERSATION', history.id)).prompt).toContain('OWN_FIRST_ANSWER');
  });

  it('replays ordinary history after native-session reset instead of dropping old own messages', async () => {
    const h = harness(), history = await h.establish(); peer(history, 'AFTER_RESET_PEER');
    h.provider.clearSession(history.id);
    const fresh = await h.send(history, 'Fresh review');
    expect(h.children.at(-1)!.args).not.toContain('--resume');
    expect(fresh.prompt).toContain('OWN_FIRST_ANSWER'); expect(fresh.prompt).toContain('AFTER_RESET_PEER');
  });
});
