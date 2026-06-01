import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelBridge } from '../../src/managers/ChannelBridge';
import type { ActiveModeManager } from '../../src/managers/ActiveModeManager';
import type { ChannelEvent, ChannelInfo } from '../../src/providers/openclaw/OpenClawGateway';

interface DelegateCall {
  type: string;
  panelId: string;
  channelName?: string;
  content?: string;
  sender?: string;
}

function createBridgeHarness() {
  let eventHandler: ((event: ChannelEvent) => void) | null = null;
  const delegateCalls: DelegateCall[] = [];
  const sent: Array<{ channelId?: string; message?: string; target?: string; prompt?: string; sessionKey?: string }> = [];

  const channels: ChannelInfo[] = [
    { id: 'wa-1', type: 'whatsapp', name: 'WhatsApp', status: 'connected' },
    { id: 'tg-1', type: 'telegram', name: 'Telegram', status: 'connected' },
  ];

  const activeModeManager = {
    isConnected: () => false,
    isIntegrationEnabled: () => true,
    getChannels: () => channels,
    getSkills: () => [],
    sendToChannel: vi.fn((channelId: string, message: string, target?: string) => {
      sent.push({ channelId, message, target });
      return Promise.resolve(true);
    }),
    sendAgentTask: vi.fn((prompt: string, sessionKey?: string) => {
      sent.push({ prompt, sessionKey });
      return Promise.resolve(true);
    }),
    subscribeToChannelEvents: vi.fn((handler: (event: ChannelEvent) => void) => {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    }),
  } as unknown as ActiveModeManager;

  const bridge = new ChannelBridge(activeModeManager);
  bridge.setDelegate({
    hasPendingQuestion: () => false,
    getPendingQuestionToolCallId: () => null,
    answerPendingQuestion: (panelId: string, _toolCallId: string, content: string) => {
      delegateCalls.push({ type: 'answerPendingQuestion', panelId, content });
    },
    cancelPanelRequest: (panelId: string) => {
      delegateCalls.push({ type: 'cancelPanelRequest', panelId });
    },
    injectChannelMessage: (panelId: string, channelName: string, content: string, sender?: string) => {
      delegateCalls.push({ type: 'injectChannelMessage', panelId, channelName, content, sender });
    },
    isRunning: () => false,
    getActivePanelId: () => 'panel-1',
  });

  return {
    bridge,
    delegateCalls,
    sent,
    emit(event: ChannelEvent) {
      if (!eventHandler) {
        throw new Error('Channel event handler was not registered');
      }
      eventHandler(event);
    },
  };
}

describe('ChannelBridge channel-scoped contact tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('rejects inbound messages from a tracked sender on a different channel', async () => {
    const { bridge, delegateCalls, emit } = createBridgeHarness();

    await bridge.executeSend({
      type: 'send',
      channel: 'whatsapp',
      to: 'Bob',
      content: 'hello',
      startIndex: 0,
    });

    emit({
      channelId: 'tg-1',
      channelType: 'telegram',
      eventType: 'message_received',
      sender: 'Bob',
      content: 'attacker-controlled reply',
      timestamp: Date.now(),
    });

    expect(delegateCalls).toEqual([]);
    bridge.dispose();
  });

  it('accepts inbound messages from a tracked sender on the same concrete channel', async () => {
    const { bridge, delegateCalls, emit } = createBridgeHarness();

    await bridge.executeSend({
      type: 'send',
      channel: 'whatsapp',
      to: 'Bob',
      content: 'hello',
      startIndex: 0,
    });

    emit({
      channelId: 'wa-1',
      channelType: 'whatsapp',
      eventType: 'message_received',
      sender: 'Bob',
      content: 'legitimate reply',
      timestamp: Date.now(),
    });

    expect(delegateCalls).toEqual([
      {
        type: 'injectChannelMessage',
        panelId: 'panel-1',
        channelName: 'Whatsapp',
        content: 'legitimate reply',
        sender: 'Bob',
      },
    ]);
    bridge.dispose();
  });

  it('accepts session-polling events that only expose the channel type fallback', async () => {
    const { bridge, delegateCalls, emit } = createBridgeHarness();

    await bridge.executeSend({
      type: 'send',
      channel: 'whatsapp',
      to: 'Bob',
      content: 'hello',
      startIndex: 0,
    });

    emit({
      channelId: 'whatsapp',
      channelType: 'whatsapp',
      eventType: 'message_received',
      sender: 'Bob',
      content: 'polling reply',
      timestamp: Date.now(),
    });

    expect(delegateCalls).toHaveLength(1);
    expect(delegateCalls[0]).toMatchObject({
      type: 'injectChannelMessage',
      channelName: 'Whatsapp',
      content: 'polling reply',
      sender: 'Bob',
    });
    bridge.dispose();
  });
});
