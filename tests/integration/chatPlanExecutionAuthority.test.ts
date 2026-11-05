import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { PendingPlanStore } from '../../src/chat/PendingPlanStore';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const plan = { id: 'plan', title: 'Bounded change', summary: 'Change the fixture', approach: 'Change only fixture.txt', pros: [], cons: [], complexity: 'low' };
const stores: PendingPlanStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); clearMockConfig(); });
afterAll(() => registry.dispose());

async function harness(providerId = 'cline', accessLevel = 'read-only') {
  setMockConfig('defaultMode', 'quick-plan'); setMockConfig('accessLevel', accessLevel);
  const selected = { provider: providerId };
  const posted = vi.fn(), send = vi.fn(async (_payload: any, _panelId: string) => {});
  const update = vi.fn(async (settings: any) => {
    if (settings.mode !== undefined) setMockConfig('defaultMode', settings.mode);
    if (settings.accessLevel !== undefined) setMockConfig('accessLevel', settings.accessLevel);
  });
  const pending = new PendingPlanStore(); stores.push(pending);
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: new Map([['owner', { currentConversationId: 'conversation', webview: {} }]]),
    _pendingPlans: pending, _pendingPlanSelections: new Set(), _mystiRunGen: new Map(),
    _autonomousManager: { isActive: () => false }, _isSemiAutonomousEnabled: () => false,
    _getPanelProvider: () => selected.provider, _getPanelModel: () => 'fixture-model',
    _providerManager: { getProviderInstance: (id: string) => registry.get(id) },
    _contextManager: { getContext: () => [] },
    _planOptionManager: { createSelectionPrompt: () => 'Implement the bounded change.' },
    _postToPanel: posted, _handleUpdateSettings: update, _handleSendMessage: send,
  });
  await host._handleDetectedPlanOptions([plan], 'message', 'Original task', undefined, 'owner');
  const delivered = posted.mock.calls.find(([, message]) => message.type === 'planOptions')![1].payload;
  const selection = { selectedPlan: plan, messageId: 'message', originalQuery: 'Original task',
    conversationId: 'conversation', syntheticPlanId: delivered.syntheticPlanId, executionMode: 'edit-automatically', customInstructions: '' };
  return { host, selection, pending, posted, send, update, selected, delivered };
}

describe('plan execution authority at the real host selection boundary', () => {
  for (const provider of ['cline', 'google-gemini', 'opencode', 'qwen-code']) {
    it(`${provider}: Plan execution stays pending until Full is explicitly selected`, async () => {
      const h = await harness(provider);
      await h.host._handlePlanOptionSelected(h.selection, 'owner');
      expect(h.send).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
      expect(h.pending.peek('owner', h.selection.syntheticPlanId)).toBeDefined();
      expect(h.posted).toHaveBeenCalledWith('owner', expect.objectContaining({ type: 'planExecutionModeRequired' }));
    });
  }

  it('Cline executes once with Full only after the selected mode and explicit callback agree', async () => {
    const h = await harness();
    setMockConfig('defaultMode', 'edit-automatically'); setMockConfig('accessLevel', 'full-access');
    const selection = { ...h.selection, executionAccessLevel: 'full-access' };
    await h.host._handlePlanOptionSelected(selection, 'owner');
    await h.host._handlePlanOptionSelected(selection, 'owner');
    expect(h.send).toHaveBeenCalledOnce();
    const settings = h.send.mock.calls[0][0].settings;
    expect(settings).toMatchObject({ provider: 'cline', mode: 'edit-automatically', accessLevel: 'full-access' });
    const args = (registry.get('cline') as any).buildCliArgs(settings, {});
    expect(args).toContain('--auto-approve'); expect(args).toContain('true'); expect(args).not.toContain('--plan');
    expect(h.update).toHaveBeenCalledWith({ mode: 'edit-automatically', accessLevel: 'full-access' }, 'owner');
  });

  it('forged Full callback cannot upgrade a still read-only owner', async () => {
    const h = await harness();
    await h.host._handlePlanOptionSelected({ ...h.selection, executionAccessLevel: 'full-access' }, 'owner');
    expect(h.send).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    expect(h.pending.peek('owner', h.selection.syntheticPlanId)).toBeDefined();
  });

  it('a global Full setting alone cannot auto-upgrade a Cline plan selection', async () => {
    const h = await harness(); setMockConfig('accessLevel', 'full-access');
    await h.host._handlePlanOptionSelected(h.selection, 'owner');
    expect(h.send).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });

  for (const provider of ['claude-code', 'openai-codex']) for (const mode of ['edit-automatically', 'ask-before-edit']) {
    it(`${provider}: ${mode} leaves Plan with gated authority`, async () => {
      const h = await harness(provider);
      await h.host._handlePlanOptionSelected({ ...h.selection, executionMode: mode }, 'owner');
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.send.mock.calls[0][0].settings).toMatchObject({ provider, mode, accessLevel: 'ask-permission' });
      expect(h.update).toHaveBeenCalledWith({ mode, accessLevel: 'ask-permission' }, 'owner');
    });
  }

  it('Cline rejects unsupported Ask without consuming the plan', async () => {
    const h = await harness('cline', 'full-access');
    await h.host._handlePlanOptionSelected({ ...h.selection, executionMode: 'ask-before-edit' }, 'owner');
    expect(h.send).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    expect(h.pending.peek('owner', h.selection.syntheticPlanId)).toBeDefined();
  });

  it('a provider switch cannot execute the old provider’s plan', async () => {
    const h = await harness('claude-code'); h.selected.provider = 'cline';
    await h.host._handlePlanOptionSelected(h.selection, 'owner');
    expect(h.send).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });

  it('a provider switch during the settings write cannot dispatch through the replacement', async () => {
    const h = await harness('claude-code');
    h.update.mockImplementationOnce(async () => { h.selected.provider = 'cline'; });
    await h.host._handlePlanOptionSelected(h.selection, 'owner');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a sibling panel cannot consume the owner’s plan', async () => {
    const h = await harness('claude-code');
    await h.host._handlePlanOptionSelected(h.selection, 'sibling');
    expect(h.send).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    expect(h.pending.peek('owner', h.selection.syntheticPlanId)).toBeDefined();
  });

  it('an unsupported autonomous selection still delivers its pending recovery card', async () => {
    const h = await harness(); h.posted.mockClear();
    h.host._autonomousManager = { isActive: () => true,
      generateAutoAnswer: () => ({ answers: { Approach: plan.title }, decision: { reasoning: 'Choose the bounded plan.' } }) };
    await h.host._handleDetectedPlanOptions([plan], 'next-message', 'Original task', undefined, 'owner');
    expect(h.send).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    const deliveries = h.posted.mock.calls.filter(([, message]) => message.type === 'planOptions');
    expect(deliveries).toHaveLength(1);
    expect(h.pending.peek('owner', deliveries[0][1].payload.syntheticPlanId)).toBeDefined();
  });
});
