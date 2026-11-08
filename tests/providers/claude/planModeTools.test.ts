import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleClaudeControl, type ClaudeControlState } from '../../../src/providers/claude/ClaudeControlProtocol';

/** Claude Code's own plan mode (--permission-mode plan, used for Mysti's plan and
 * read-only tiers) explores with read-only subagents and writes its plan file
 * under ~/.claude/plans. Denying those left Claude unable to present a plan. A
 * subagent's own tool calls still reach this same hook, so writes stay denied. */
const PLANS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plans');

function control(mode: 'quick-plan' | 'ask-before-edit', accessLevel: 'read-only' | 'ask-permission') {
  const writes: any[] = [];
  const proc = { stdin: { writable: true, destroyed: false, write: (line: string) => { writes.push(JSON.parse(line)); return true; } } } as any;
  const state: ClaudeControlState = { settings: { mode, accessLevel }, initialized: true };
  const requests = { request: vi.fn(), hold: vi.fn() } as any;
  const hook = (tool: string, toolInput: Record<string, unknown> = {}) => {
    handleClaudeControl({ type: 'control_request', request_id: `h-${writes.length}`, request: { subtype: 'hook_callback', callback_id: 'mysti-pre-tool',
      input: { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput } } }, state, proc, requests);
    return writes.at(-1).response.response.hookSpecificOutput.permissionDecision;
  };
  const canUse = (tool: string, input: Record<string, unknown> = {}) => {
    handleClaudeControl({ type: 'control_request', request_id: 'c', request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 't' } }, state, proc, requests);
    return requests.request.mock.calls.at(-1)?.[2];
  };
  return { hook, canUse };
}

describe('Claude plan mode keeps its own planning tools', () => {
  it('lets plan mode explore with subagents (their tool calls are still gated)', () => {
    const c = control('quick-plan', 'read-only');
    expect(c.hook('Agent', { subagent_type: 'Explore', prompt: 'list files' })).toBe('ask');
    expect(c.canUse('Agent', { subagent_type: 'Explore' })).toBe('allow');
  });

  it('lets plan mode write and edit only its plan file', () => {
    const c = control('quick-plan', 'read-only');
    const plan = path.join(PLANS, 'tidy-plan.md');
    expect(c.hook('Write', { file_path: plan, content: '# Plan' })).toBe('ask');
    expect(c.canUse('Write', { file_path: plan, content: '# Plan' })).toBe('allow');
    expect(c.canUse('Edit', { file_path: plan, old_string: 'a', new_string: 'b' })).toBe('allow');
  });

  it.each([
    ['a workspace file', '/work/src/app.ts'],
    ['a traversal out of the plans folder', path.join(PLANS, '..', 'settings.json')],
    ['a nested path', path.join(PLANS, 'nested', 'plan.md')],
    ['a non-markdown plan path', path.join(PLANS, 'plan.sh')],
    ['a relative path', 'plans/plan.md'],
  ])('still denies writing %s', (_label, filePath) => {
    const c = control('quick-plan', 'read-only');
    expect(c.hook('Write', { file_path: filePath, content: 'x' })).toBe('deny');
  });

  it('still denies shell and other writes in plan mode, including inside subagents', () => {
    const c = control('quick-plan', 'read-only');
    expect(c.hook('Bash', { command: 'touch x' })).toBe('deny');
    expect(c.hook('NotebookEdit', { notebook_path: '/work/a.ipynb' })).toBe('deny');
  });

  it('leaves non-plan tiers unchanged', () => {
    const c = control('ask-before-edit', 'ask-permission');
    expect(c.canUse('Write', { file_path: path.join(PLANS, 'x.md') })).toBe('ask');
    expect(c.canUse('Agent', {})).toBe('ask');
  });
});

describe('the plan file allowance cannot be redirected by links', () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-plans-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', root);
    const outside = path.join(root, 'outside.ts'); fs.writeFileSync(outside, 'original');
    return { root, plans: path.join(root, 'plans'), outside };
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  it('allows a new or ordinary plan file in a real plans folder', () => {
    const { plans } = setup(); const c = control('quick-plan', 'read-only');
    expect(c.hook('Write', { file_path: path.join(plans, 'new.md') })).toBe('ask'); // folder not created yet
    fs.mkdirSync(plans); fs.writeFileSync(path.join(plans, 'kept.md'), '# plan');
    expect(c.hook('Edit', { file_path: path.join(plans, 'kept.md') })).toBe('ask');
  });

  it('denies a plan path that is a symlink to another file', () => {
    const { plans, outside } = setup(); fs.mkdirSync(plans);
    fs.symlinkSync(outside, path.join(plans, 'evil.md'));
    expect(control('quick-plan', 'read-only').hook('Write', { file_path: path.join(plans, 'evil.md') })).toBe('deny');
  });

  it('denies a plan path that is a hard link to another file', () => {
    const { plans, outside } = setup(); fs.mkdirSync(plans);
    fs.linkSync(outside, path.join(plans, 'linked.md'));
    expect(control('quick-plan', 'read-only').hook('Write', { file_path: path.join(plans, 'linked.md') })).toBe('deny');
  });

  it('denies writes when the plans folder itself is a symlink', () => {
    const { root, plans } = setup(); const elsewhere = path.join(root, 'elsewhere'); fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, plans);
    expect(control('quick-plan', 'read-only').hook('Write', { file_path: path.join(plans, 'plan.md') })).toBe('deny');
  });
});
