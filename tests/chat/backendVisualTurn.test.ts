import { describe, expect, it } from 'vitest';
import { BackendVisualTurn } from '../../src/chat/BackendVisualTurn';
import type { Settings } from '../../src/types';

const settings: Settings = { mode: 'default', thinkingLevel: 'medium', accessLevel: 'read-only', contextMode: 'manual', provider: 'claude-code', model: 'original' };
const tag = (owner: BackendVisualTurn) => `<look:${owner.nonce}>inspect</look>`;

describe('BackendVisualTurn response ownership', () => {
  it('isolates nonce, streaming scanner and one-shot trigger across panels', () => {
    const a = new BackendVisualTurn('a', 'left', settings, () => true);
    const b = new BackendVisualTurn('b', 'right', settings, () => true);
    a.enable(); b.enable();
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.feed(tag(b))).toBeUndefined();
    const own = tag(a);
    expect(a.feed(own.slice(0, 9))).toBeUndefined();
    expect(a.feed(own.slice(9))).toMatchObject({ kind: 'look', focus: 'inspect' });
    expect(b.feed(tag(b))).toMatchObject({ kind: 'look' });
    expect(a.feed(tag(a))).toBeUndefined();
  });

  it('stages early results until successful parent commit, then claims exactly once', async () => {
    const owner = new BackendVisualTurn('a', 'left', settings, () => true); owner.enable(); owner.feed(tag(owner));
    let settled = false;
    const staged = owner.waitForSuccess().then(result => { settled = true; return result; });
    await Promise.resolve(); expect(settled).toBe(false); expect(owner.claimContinuation()).toBe(false);
    owner.succeeded(); expect(await staged).toBe(true);
    expect(owner.claimContinuation()).toBe(true); expect(owner.claimContinuation()).toBe(false);
  });

  it.each(['pending', 'succeeded'] as const)('Stop revokes %s parent and releases a staged result', async state => {
    const owner = new BackendVisualTurn('a', 'left', settings, () => true); owner.enable(); owner.feed(tag(owner));
    if (state === 'succeeded') { owner.succeeded(); }
    const staged = owner.waitForSuccess(); owner.retire();
    expect(await staged).toBe(false); expect(owner.signal.aborted).toBe(true);
    owner.succeeded(); expect(owner.claimContinuation()).toBe(false);
  });

  it('rejects a replaced owner even if its cancellation flag later clears', async () => {
    let current = true;
    const owner = new BackendVisualTurn('a', 'left', settings, () => current); owner.enable(); owner.feed(tag(owner));
    owner.succeeded(); current = false;
    expect(await owner.waitForSuccess()).toBe(false); current = true;
    expect(owner.claimContinuation()).toBe(false);
  });

  it('captures original model, instructions and permission floor before caller mutation', () => {
    const mutable = { ...settings, customInstructions: 'original' };
    const owner = new BackendVisualTurn('a', 'left', mutable, () => true);
    mutable.model = 'later'; mutable.accessLevel = 'full-access'; mutable.customInstructions = 'changed';
    expect(owner.settings).toMatchObject({ model: 'original', accessLevel: 'read-only', customInstructions: 'original' });
  });
});
