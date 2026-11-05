import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanOptionManager } from '../../src/managers/PlanOptionManager';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PendingPlanStore } from '../../src/chat/PendingPlanStore';
import { CodexProvider } from '../../src/providers/codex/CodexProvider';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../src/utils/processKill', async original => ({ ...await original<typeof import('../../src/utils/processKill')>(), killProcessTree: vi.fn(async () => {}) }));
vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
let children: any[];
let manager: PlanOptionManager;
const stores: PendingPlanStore[] = [];
const codex = new CodexProvider({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
afterAll(() => codex.dispose());
const content = 'Compare a small retry correction with replacing the complete scheduling service.';
beforeEach(() => {
  vi.useFakeTimers(); clearMockConfig(); setMockConfig('claudeCodePath', '/controlled/classifier'); children = [];
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kill: vi.fn(() => true) }); children.push(child); return child;
  });
  manager = new PlanOptionManager();
});
afterEach(() => {
  manager.dispose(); stores.splice(0).forEach(store => store.dispose()); children.forEach(child => child.emit('close', null));
  vi.clearAllTimers(); vi.useRealTimers(); clearMockConfig(); vi.restoreAllMocks();
});
async function classify(value: unknown) {
  const result = manager.classifyResponse(content), child = children.at(-1);
  child.stdout.write(JSON.stringify(value)); child.emit('close', 0);
  return result;
}
const plans = (ids: unknown[]) => ids.map((id, index) => ({ id, title: `Approach ${index + 1}`, approach: `Implement only option ${index + 1}.` }));
function host() {
  const store = new PendingPlanStore(); stores.push(store);
  return Object.assign(Object.create(ChatViewProvider.prototype), {
    _pendingPlans: store, _pendingPlanSelections: new Set(), _mystiRunGen: new Map(),
    _panelStates: new Map([['panel', { id: 'panel', webview: {}, currentConversationId: 'conversation' }]]),
    _autonomousManager: { isActive: () => false }, _planOptionManager: manager,
    _providerManager: { getProviderInstance: (id: string) => id === codex.id ? codex : undefined },
    _postToPanel: vi.fn(), _handleSendMessage: vi.fn(async () => {}), _handleUpdateSettings: vi.fn(async () => {}),
    _isSemiAutonomousEnabled: () => false, _contextManager: { getContext: () => [] },
    _getPanelModel: () => 'gpt-5.6-sol', _getPanelProvider: () => 'openai-codex',
  });
}

describe('PB02-D14 classified choices retain distinct selection identities', () => {
  it('selecting the second displayed plan cannot execute the first when the helper reuses an ID', async () => {
    const classified = await classify({ planOptions: plans(['plan', 'plan']) });
    const provider = host();
    await provider._handleDetectedPlanOptions(classified.planOptions, 'answer', content, undefined, 'panel');
    const delivery = provider._postToPanel.mock.calls.find(([, message]: any[]) => message.type === 'planOptions')[1].payload;
    await provider._handlePlanOptionSelected({ ...delivery, selectedPlan: delivery.options[1], executionMode: 'ask-before-edit' }, 'panel');
    expect(provider._handleSendMessage).toHaveBeenCalledOnce();
    const sent = provider._handleSendMessage.mock.calls[0][0].content;
    expect(sent).toContain('Implement only option 2.'); expect(sent).not.toContain('Implement only option 1.');
  });

  it.each([
    { name: 'duplicate', ids: ['same', 'same'] },
    { name: 'missing and an explicit generated-looking ID', ids: [undefined, 'plan1'] },
    { name: 'duplicate and future reserved ID', ids: ['same', 'same', 'plan2'] },
    { name: 'non-string IDs', ids: [3, { nested: true }, false] },
    { name: 'blank IDs', ids: [' ', '\t', ''] },
  ])('plan handles are unique nonempty strings for $name', async ({ ids }) => {
    const result = await classify({ planOptions: plans(ids) });
    expect(result.planOptions).toHaveLength(ids.length);
    expect(new Set(result.planOptions.map(option => option.id)).size).toBe(ids.length);
    for (const option of result.planOptions) { expect(typeof option.id).toBe('string'); expect(option.id.trim()).not.toBe(''); }
    expect(result.planOptions.map(option => option.approach)).toEqual(ids.map((_, index) => `Implement only option ${index + 1}.`));
  });

  it('two classified questions with duplicate IDs retain independent answers', async () => {
    const result = await classify({ questions: [
      { id: 'q', question: 'Which database?', inputType: 'text' },
      { id: 'q', question: 'Which framework?', inputType: 'text' },
    ] });
    const prompt = manager.createAnswerPrompt(result.questions, new Map([
      [result.questions[0].id, 'PostgreSQL'], [result.questions[1].id, 'React'],
    ]));
    expect(prompt).toContain('**Which database?**\n→ PostgreSQL');
    expect(prompt).toContain('**Which framework?**\n→ React');
  });

  it('question-option IDs cannot collide with generated fallback IDs', async () => {
    const result = await classify({ questions: [{ question: 'Choose a backend', options: [
      { label: 'Node', value: 'node' }, { id: 'opt0', label: 'Python', value: 'python' },
      { id: 'opt0', label: 'Go', value: 'go' },
    ] }] });
    const options = result.questions[0].options!;
    expect(new Set(options.map(option => option.id)).size).toBe(3);
    expect(options.map(option => [option.label, option.value])).toEqual([['Node', 'node'], ['Python', 'python'], ['Go', 'go']]);
  });

  it('keeps existing distinct string IDs and all displayed content', async () => {
    const result = await classify({ questions: [{ id: 'database', question: 'Which database?', options: [{ id: 'pg', label: 'PostgreSQL', value: 'postgres' }] }],
      planOptions: plans(['minimal-fix', 'service-redesign']) });
    expect(result.questions[0].id).toBe('database'); expect(result.questions[0].options![0].id).toBe('pg');
    expect(result.planOptions.map(option => option.id)).toEqual(['minimal-fix', 'service-redesign']);
  });
});
