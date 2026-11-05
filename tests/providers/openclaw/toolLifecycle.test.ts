import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';

vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(), readOpenClawToken: () => undefined,
}));
const TOKEN = 'owned-tool-result-credential';
let provider: TestableOpenClawProvider;
beforeEach(() => { clearMockConfig(); provider = new TestableOpenClawProvider(); vi.stubEnv('MYSTI_TOOL_TEST_TOKEN', TOKEN); });
afterEach(() => { provider.dispose(); vi.unstubAllEnvs(); clearMockConfig(); });
const parse = (session: ReturnType<typeof createOpenClawSession>, event: unknown) => provider.parseStreamLine(JSON.stringify(event), session);
function start(session: ReturnType<typeof createOpenClawSession>, id = 'owned-tool', name = 'read') {
  return parse(session, { type: 'tool_call', status: 'started', id, name, input: { path: `${id}.txt` } });
}

it.each(['tool_use_id', 'tool_id', 'tool_call_id', 'id'])('correlates standalone results by %s and clears only the finished tool', key => {
  const session = createOpenClawSession(); start(session); start(session, 'other-tool', 'edit');
  const result = parse(session, { type: 'tool_result', [key]: 'owned-tool', content: 'File contents' });
  expect(result).toMatchObject({ type: 'tool_result', toolCall: {
    id: 'owned-tool', name: 'read', input: { path: 'owned-tool.txt' }, output: 'File contents', status: 'completed',
  } });
  expect([...session.activeToolCalls.keys()]).toEqual(['other-tool']);
});

it.each([{ is_error: true }, { success: false }, { status: 'failed' }])('preserves standalone failure %j and redacts output', flags => {
  const session = createOpenClawSession(); start(session);
  expect(parse(session, { type: 'tool_result', tool_use_id: 'owned-tool', content: `Failure ${TOKEN}`, ...flags }))
    .toMatchObject({ type: 'tool_result', toolCall: { name: 'read', input: { path: 'owned-tool.txt' }, status: 'failed', output: 'Failure [REDACTED]' } });
  expect(session.activeToolCalls.size).toBe(0);
});

it('does not borrow metadata from another tool or another panel', () => {
  const a = createOpenClawSession('A'), b = createOpenClawSession('B'); start(a); start(b, 'owned-tool', 'edit');
  const unknown = parse(a, { type: 'tool_result', tool_use_id: 'unknown', tool_name: 'fetch', input: { url: 'https://example.invalid' }, content: 'Remote result' });
  expect(unknown?.toolCall).toMatchObject({ id: 'unknown', name: 'fetch', input: { url: 'https://example.invalid' } });
  expect(a.activeToolCalls.size).toBe(1);
  expect(parse(b, { type: 'tool_result', tool_use_id: 'owned-tool', content: 'B result' })?.toolCall?.name).toBe('edit');
  expect(a.activeToolCalls.size).toBe(1); expect(b.activeToolCalls.size).toBe(0);
});

it('retains successful zero/false output and explicitly supplied result input', () => {
  const session = createOpenClawSession();
  for (const content of [0, false]) expect(parse(session, { type: 'tool_result', tool_id: 'untracked', content, input: { supplied: true } })?.toolCall)
    .toMatchObject({ output: JSON.stringify(content), input: { supplied: true }, status: 'completed' });
});

it('does not reuse completed metadata when an id appears again without a new start', () => {
  const session = createOpenClawSession(); start(session);
  parse(session, { type: 'tool_result', tool_use_id: 'owned-tool', content: 'First result' });
  expect(parse(session, { type: 'tool_call', status: 'completed', id: 'owned-tool', name: 'fresh', input: { fresh: true }, output: 'Later result' })?.toolCall)
    .toMatchObject({ name: 'fresh', input: { fresh: true } });
});
