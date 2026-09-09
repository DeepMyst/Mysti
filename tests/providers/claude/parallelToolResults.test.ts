/**
 * Plan 18 4.5 — Claude parseStreamLine used to `return` on the FIRST
 * tool_result block of a `user` message, silently dropping the sibling results
 * of parallel tool calls. The fix returns the first chunk and queues the rest
 * on ClaudeSessionState.pendingChunks; the processStream override drains the
 * queue right after each yielded chunk and once more at end-of-stream, so the
 * extras are emitted even when NO further lines arrive.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';
import type { ClaudeSessionState } from '../../../src/providers/claude/ClaudeCodeProvider';
import type { StreamChunk } from '../../../src/types';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'node:events';

/** Expose the protected processStream override for end-to-end drain tests. */
class StreamingClaudeProvider extends TestableClaudeProvider {
  public async collectStream(session: PanelSessionState): Promise<StreamChunk[]> {
    const collected: StreamChunk[] = [];
    for await (const chunk of this.processStream({ output: '' }, session)) {
      collected.push(chunk);
    }
    return collected;
  }
}

/** Minimal fake ChildProcess whose stdout replays the given NDJSON lines. */
function fakeProcess(lines: string[]): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: (async function* () {
      yield Buffer.from(lines.join('\n') + '\n');
    })(),
    exitCode: 0,
  }) as unknown as ChildProcess;
}

function toolResultLine(results: Array<{ id: string; content: string; isError?: boolean }>): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: results.map(r => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError ?? false,
      })),
    },
  });
}

describe('ClaudeCodeProvider parallel tool_results (Plan 18 4.5)', () => {
  let provider: StreamingClaudeProvider;
  let session: ClaudeSessionState;

  beforeEach(() => {
    provider = new StreamingClaudeProvider();
    session = createClaudeSession();
  });

  describe('parseStreamLine (unit)', () => {
    it('returns the first tool_result and queues the siblings on the session', () => {
      const line = toolResultLine([
        { id: 'toolu_a', content: 'result A' },
        { id: 'toolu_b', content: 'result B' },
        { id: 'toolu_c', content: 'result C', isError: true },
      ]);
      const first = provider.parseStreamLine(line, session);
      expect(first?.type).toBe('tool_result');
      expect(first?.toolCall?.id).toBe('toolu_a');
      expect(first?.toolCall?.output).toBe('result A');

      const pending = session.pendingChunks!;
      expect(pending).toHaveLength(2);
      expect(pending[0].toolCall?.id).toBe('toolu_b');
      expect(pending[1].toolCall?.id).toBe('toolu_c');
      expect(pending[1].toolCall?.status).toBe('failed');
    });

    it('queues nothing for a single tool_result (unchanged behavior)', () => {
      const line = toolResultLine([{ id: 'toolu_solo', content: 'only one' }]);
      const chunk = provider.parseStreamLine(line, session);
      expect(chunk?.toolCall?.id).toBe('toolu_solo');
      expect(session.pendingChunks ?? []).toHaveLength(0);
    });

    it('stringifies non-string tool_result content in queued siblings too', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'plain' },
            { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'structured' }] },
          ],
        },
      });
      provider.parseStreamLine(line, session);
      expect(session.pendingChunks![0].toolCall?.output).toBe(
        JSON.stringify([{ type: 'text', text: 'structured' }]),
      );
    });
  });

  describe('processStream (end-to-end drain)', () => {
    it('emits ALL tool_results even when no further lines arrive', async () => {
      session.process = fakeProcess([
        toolResultLine([
          { id: 'toolu_1', content: 'r1' },
          { id: 'toolu_2', content: 'r2' },
          { id: 'toolu_3', content: 'r3' },
        ]),
      ]);
      const chunks = await provider.collectStream(session);
      const results = chunks.filter(c => c.type === 'tool_result');
      expect(results.map(c => c.toolCall?.id)).toEqual(['toolu_1', 'toolu_2', 'toolu_3']);
    });

    it('emits queued siblings immediately after the first result, before later lines', async () => {
      const textLine = JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'after tools' } },
      });
      session.process = fakeProcess([
        toolResultLine([
          { id: 'toolu_x', content: 'rx' },
          { id: 'toolu_y', content: 'ry' },
        ]),
        textLine,
      ]);
      const chunks = await provider.collectStream(session);
      const kinds = chunks.map(c => c.type === 'tool_result' ? `result:${c.toolCall?.id}` : c.type);
      expect(kinds).toEqual(['result:toolu_x', 'result:toolu_y', 'text']);
    });

    it('drops stale pendingChunks from a previous cancelled run', async () => {
      session.pendingChunks = [
        { type: 'tool_result', toolCall: { id: 'stale', name: '', input: {}, output: 'old', status: 'completed' } },
      ];
      session.process = fakeProcess([
        toolResultLine([{ id: 'toolu_fresh', content: 'fresh' }]),
      ]);
      const chunks = await provider.collectStream(session);
      const ids = chunks.filter(c => c.type === 'tool_result').map(c => c.toolCall?.id);
      expect(ids).toEqual(['toolu_fresh']);
    });
  });
});
