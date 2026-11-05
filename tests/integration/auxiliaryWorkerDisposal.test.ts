import { expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';

it('host disposal releases the owned plan classifier alongside conversational providers', () => {
  const resource = () => ({ dispose: vi.fn() });
  const classifier = resource();
  const providers = resource();
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _nativeApprovalRegistration: resource(), _nativeApprovalCards: resource(),
    _subAgentQuestions: resource(), _delayedChannelTurns: resource(),
    _panelStates: new Map(), _brainstormPreparations: new Map(), _lastUserMessage: new Map(), _lastMentionContext: new Map(),
    _cancelledPanels: new Set(), _pendingPlans: resource(), _pendingPlanSelections: new Map(),
    _planOptionManager: classifier, _providerManager: providers,
    _backgroundJobManager: resource(), _channelBridge: resource(),
  });

  host.dispose();

  expect(classifier.dispose).toHaveBeenCalledTimes(1);
  expect(providers.dispose).toHaveBeenCalledTimes(1);
});
