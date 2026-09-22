import { describe, expect, it } from 'vitest';
import { ForegroundRequest, validForegroundRequestId } from '../../src/chat/ForegroundRequest';
import { bindIncomingMessage } from '../../src/chat/incomingMessage';
import type { WebviewMessage } from '../../src/types';

describe('captured foreground request port', () => {
  it.each([null, 42, {}, [], '', 'x'.repeat(129), '<script>', 'a b', 'line\nbreak'])('rejects invalid correlation %j before dispatch', requestId => {
    expect(validForegroundRequestId(requestId)).toBe(false);
    expect(bindIncomingMessage({ type: 'sendMessage', requestId, panelId: 'forged' }, 'bound')).toBeNull();
  });

  it('preserves valid correlation while binding the sender, and keeps legacy absence absent', () => {
    expect(bindIncomingMessage({ type: 'sendMessage', requestId: 'view_A-12', panelId: 'forged' }, 'bound'))
      .toEqual({ type: 'sendMessage', requestId: 'view_A-12', panelId: 'bound' });
    expect(bindIncomingMessage({ type: 'settings' }, 'bound')).toEqual({ type: 'settings', panelId: 'bound' });
  });

  it('refuses stale captured callbacks without relabeling them as their successor', () => {
    const events: WebviewMessage[] = []; let current = 'old';
    const old = new ForegroundRequest('old', 1, 'panel', () => current === 'old', event => events.push(event));
    old.acknowledge(); const callback = old.post; current = 'new';
    const next = new ForegroundRequest('new', 2, 'panel', () => current === 'new', event => events.push(event));
    next.acknowledge(); callback({ type: 'responseChunk', payload: { content: 'STALE' } });
    callback({ type: 'responseComplete' }); next.post({ type: 'responseChunk', payload: { content: 'NEW' } });
    expect(events).toEqual([
      { type: 'responsePending', requestId: 'old', payload: { sequence: 1 } },
      { type: 'responsePending', requestId: 'new', payload: { sequence: 2 } },
      { type: 'responseChunk', requestId: 'new', payload: { content: 'NEW' } },
    ]);
  });

  it('closes streaming once while admitting only explicit same-owner accessories', () => {
    const events: WebviewMessage[] = []; let current = true;
    const request = new ForegroundRequest('run', 1, 'panel', () => current, event => events.push(event));
    request.post({ type: 'responseComplete' });
    for (const type of ['responseComplete','responseStarted','responseChunk','toolUse','toolResult','error','requestCancelled']) { request.post({ type }); }
    request.post({ type: 'suggestionsReady' });
    request.post({ type: 'toolResult', scope: 'accessory', payload: { id: 'question' } });
    current = false; request.post({ type: 'planOptions' });
    expect(events.map(event => event.type)).toEqual(['responseComplete','suggestionsReady','toolResult']);
    expect(events.every(event => event.requestId === 'run')).toBe(true);
  });

  it('emits captured Stop before retirement without revoking the host cleanup predicate', () => {
    const events: WebviewMessage[] = [];
    const request = new ForegroundRequest('run', 1, 'panel', () => true, event => events.push(event));
    request.cancel(); expect(request.isCurrent()).toBe(true);
    request.cancel(); request.retire(); expect(request.isCurrent()).toBe(false);
    request.post({ type: 'suggestionsReady' });
    expect(events).toEqual([{ type: 'requestCancelled', requestId: 'run' }]);
  });

  it.each(['visualTestMiniStatus', 'visualTestDashboardUpdate'])(
    'retains captured %s only for an active or successful parent', type => {
      const events: WebviewMessage[] = []; let current = true;
      const request = new ForegroundRequest('parent', 1, 'panel', () => current, event => events.push(event));
      request.post({ type });
      request.post({ type, scope: 'accessory', payload: { phase: 'active' } });
      request.post({ type: 'responseComplete' });
      request.post({ type, scope: 'accessory', payload: { phase: 'completed' } });
      current = false;
      request.post({ type, scope: 'accessory', payload: { phase: 'obsolete' } });
      expect(events).toEqual([
        { type, scope: 'accessory', requestId: 'parent', payload: { phase: 'active' } },
        { type: 'responseComplete', requestId: 'parent' },
        { type, scope: 'accessory', requestId: 'parent', payload: { phase: 'completed' } },
      ]);
    },
  );

  it.each(['requestCancelled', 'error', 'authError', 'jobStarted', 'mystiUnavailable', 'mystiSignInRequired', 'mystiActionRequired'])(
    'refuses visual publication after %s even if a late completion arrives', type => {
      const events: WebviewMessage[] = [];
      const request = new ForegroundRequest('parent', 1, 'panel', () => true, event => events.push(event));
      request.post({ type, payload: { terminal: true } });
      request.post({ type: 'responseComplete' });
      for (const visualType of ['visualTestMiniStatus', 'visualTestDashboardUpdate']) {
        request.post({ type: visualType, scope: 'accessory' });
      }
      expect(events.map(event => event.type)).toEqual([type]);
    },
  );
});
