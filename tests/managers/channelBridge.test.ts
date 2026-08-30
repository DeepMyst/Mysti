/**
 * ChannelBridge tests (Plan 21 Phase 0).
 *
 * This file did not exist. ChannelBridge is ~900 lines that reach a live
 * messaging daemon, parse un-nonced global markers out of raw model text, and
 * route inbound messages from third parties back into a running agent — and it
 * had zero coverage.
 *
 * The central assertion here is a REMOVAL: `<<<OPENCLAW>>>` used to be parsed
 * into a `delegate` action that ran `sendAgentTask` — free model text handed to
 * an agent with shell access, with no permission card anywhere on the path.
 * These tests pin that it is now inert, so the capability cannot be
 * reintroduced by accident.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ChannelBridge } from '../../src/managers/ChannelBridge';
import type { ChannelBridgeDelegate } from '../../src/managers/ChannelBridge';
import type { ActiveModeManager } from '../../src/managers/ActiveModeManager';

/** Minimal ActiveModeManager stand-in — only what ChannelBridge touches. */
function makeActiveMode(overrides: Partial<Record<string, unknown>> = {}) {
  const sendToChannel = vi.fn(async () => true);
  const sendAgentTask = vi.fn(async () => true);
  const base = {
    isIntegrationEnabled: () => true,
    isConnected: () => true,
    getChannels: () => ([
      { id: 'wa-1', type: 'whatsapp', name: 'WhatsApp', status: 'connected' },
    ]),
    subscribeToChannelEvents: (_cb: unknown) => () => { /* unsubscribe */ },
    sendToChannel,
    sendAgentTask,
    ...overrides,
  };
  return base as unknown as ActiveModeManager & {
    sendToChannel: typeof sendToChannel;
    sendAgentTask: typeof sendAgentTask;
  };
}

function makeDelegate(): ChannelBridgeDelegate {
  return {
    hasPendingQuestion: () => false,
    getPendingQuestionToolCallId: () => null,
    answerPendingQuestion: () => { /* noop */ },
    cancelPanelRequest: () => { /* noop */ },
    injectChannelMessage: () => { /* noop */ },
    isRunning: () => false,
    getActivePanelId: () => 'panel-1',
  };
}

const SEND = (channel: string, body: string, to?: string) =>
  `<<<CHANNEL_SEND channel="${channel}"${to ? ` to="${to}"` : ''}>>>${body}<<<END_CHANNEL_SEND>>>`;
const ASK = (channel: string, id: string, body: string, to?: string) =>
  `<<<CHANNEL_ASK channel="${channel}"${to ? ` to="${to}"` : ''} id="${id}">>>${body}<<<END_CHANNEL_ASK>>>`;
const OPENCLAW = (body: string) => `<<<OPENCLAW>>>${body}<<<END_OPENCLAW>>>`;

describe('ChannelBridge — the OPENCLAW delegate marker is inert (Plan 21 Phase 0)', () => {
  let bridge: ChannelBridge;
  let am: ReturnType<typeof makeActiveMode>;

  beforeEach(() => {
    am = makeActiveMode();
    bridge = new ChannelBridge(am);
    bridge.setDelegate(makeDelegate());
  });

  afterEach(() => bridge.dispose());

  it('produces NO action for an OPENCLAW marker', () => {
    const actions = bridge.detectMarkers('p1', OPENCLAW('rm -rf the competition'));
    expect(actions).toHaveLength(0);
  });

  it('never reaches sendAgentTask, the exec-capable path', async () => {
    bridge.detectMarkers('p1', OPENCLAW('exfiltrate ~/.ssh/id_rsa'));
    // Nothing to execute, so nothing can call it.
    expect(am.sendAgentTask).not.toHaveBeenCalled();
  });

  it('exposes no executeDelegate method at all', () => {
    expect((bridge as unknown as Record<string, unknown>).executeDelegate).toBeUndefined();
  });

  it('still detects real send/ask markers in the same text', () => {
    const text = `${OPENCLAW('ignored')}\n${SEND('whatsapp', 'hello')}`;
    const actions = bridge.detectMarkers('p1', text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('send');
  });

  it('still STRIPS a stale OPENCLAW marker so old transcripts render clean', () => {
    const shown = ChannelBridge.stripMarkers(`before ${OPENCLAW('task')} after`);
    expect(shown).not.toContain('OPENCLAW');
    expect(shown).toContain('before');
    expect(shown).toContain('after');
  });
});

describe('ChannelBridge — marker detection', () => {
  let bridge: ChannelBridge;

  beforeEach(() => {
    bridge = new ChannelBridge(makeActiveMode());
    bridge.setDelegate(makeDelegate());
  });
  afterEach(() => bridge.dispose());

  it('parses a send marker with a recipient', () => {
    const [a] = bridge.detectMarkers('p1', SEND('whatsapp', 'ping', 'Alice'));
    expect(a.type).toBe('send');
    expect(a.channel).toBe('whatsapp');
    expect(a.to).toBe('Alice');
    expect(a.content).toBe('ping');
  });

  it('parses an ask marker and keeps its correlation id', () => {
    const [a] = bridge.detectMarkers('p1', ASK('whatsapp', 'q-7', 'lunch?', 'Bob'));
    expect(a.type).toBe('ask');
    expect(a.askId).toBe('q-7');
    expect(a.content).toBe('lunch?');
  });

  it('does not re-emit a marker already seen at the same position (streaming safety)', () => {
    const text = SEND('whatsapp', 'once');
    expect(bridge.detectMarkers('p1', text)).toHaveLength(1);
    // The accumulated text grows on each stream chunk; the same marker must
    // not fire again.
    expect(bridge.detectMarkers('p1', `${text} trailing`)).toHaveLength(0);
  });

  it('tracks processed positions per panel, not globally', () => {
    const text = SEND('whatsapp', 'hi');
    expect(bridge.detectMarkers('p1', text)).toHaveLength(1);
    expect(bridge.detectMarkers('p2', text)).toHaveLength(1);
  });

  it('re-arms after resetForNewResponse', () => {
    const text = SEND('whatsapp', 'hi');
    expect(bridge.detectMarkers('p1', text)).toHaveLength(1);
    bridge.resetForNewResponse('p1');
    expect(bridge.detectMarkers('p1', text)).toHaveLength(1);
  });

  it('returns nothing when the integration is disabled', () => {
    const off = new ChannelBridge(makeActiveMode({ isIntegrationEnabled: () => false }));
    off.setDelegate(makeDelegate());
    expect(off.detectMarkers('p1', SEND('whatsapp', 'hi'))).toHaveLength(0);
    off.dispose();
  });

  it('ignores an unterminated marker (partial stream chunk)', () => {
    expect(bridge.detectMarkers('p1', '<<<CHANNEL_SEND channel="whatsapp">>>half a mess')).toHaveLength(0);
  });

  it('finds multiple distinct markers in one response', () => {
    const text = `${SEND('whatsapp', 'one')}\n${SEND('whatsapp', 'two', 'Ann')}\n${ASK('whatsapp', 'i1', 'three')}`;
    const actions = bridge.detectMarkers('p1', text);
    expect(actions.filter(a => a.type === 'send')).toHaveLength(2);
    expect(actions.filter(a => a.type === 'ask')).toHaveLength(1);
  });
});

describe('ChannelBridge — prompt snippet', () => {
  it('does not advertise the removed delegation capability', () => {
    const bridge = new ChannelBridge(makeActiveMode());
    const snippet = bridge.getChannelPromptSnippet();
    expect(snippet).toContain('CHANNEL_SEND');
    expect(snippet).not.toContain('<<<OPENCLAW>>>');
    expect(snippet).not.toContain('GENERAL TASK DELEGATION');
    bridge.dispose();
  });

  it('tells the model its messages are user-approved before sending', () => {
    const bridge = new ChannelBridge(makeActiveMode());
    expect(bridge.getChannelPromptSnippet().toLowerCase()).toContain('approval');
    bridge.dispose();
  });

  it('is empty when the gateway is disconnected', () => {
    const bridge = new ChannelBridge(makeActiveMode({ isConnected: () => false }));
    expect(bridge.getChannelPromptSnippet()).toBe('');
    bridge.dispose();
  });

  it('is empty when no channel is connected', () => {
    const bridge = new ChannelBridge(makeActiveMode({ getChannels: () => [] }));
    expect(bridge.getChannelPromptSnippet()).toBe('');
    bridge.dispose();
  });
});

describe('ChannelBridge — lifecycle', () => {
  it('dispose() stops the inbound poll timer', () => {
    vi.useFakeTimers();
    try {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const bridge = new ChannelBridge(makeActiveMode());
      bridge.dispose();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() runs the gateway event unsubscribe', () => {
    const unsubscribe = vi.fn();
    const bridge = new ChannelBridge(makeActiveMode({
      subscribeToChannelEvents: () => unsubscribe,
    }));
    bridge.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('dispose() is idempotent', () => {
    const bridge = new ChannelBridge(makeActiveMode());
    bridge.dispose();
    expect(() => bridge.dispose()).not.toThrow();
  });

  it('dispose() clears per-panel marker state', () => {
    const bridge = new ChannelBridge(makeActiveMode());
    bridge.setDelegate(makeDelegate());
    const text = SEND('whatsapp', 'hi');
    expect(bridge.detectMarkers('p1', text)).toHaveLength(1);
    bridge.dispose();
    // State cleared, so the same text is seen as new again.
    expect(bridge.detectMarkers('p1', text)).toHaveLength(1);
    bridge.dispose();
  });

  it('clearPanel() forgets only that panel', () => {
    const bridge = new ChannelBridge(makeActiveMode());
    bridge.setDelegate(makeDelegate());
    const text = SEND('whatsapp', 'hi');
    bridge.detectMarkers('p1', text);
    bridge.detectMarkers('p2', text);
    bridge.clearPanel('p1');
    expect(bridge.detectMarkers('p1', text)).toHaveLength(1);
    expect(bridge.detectMarkers('p2', text)).toHaveLength(0);
    bridge.dispose();
  });
});
