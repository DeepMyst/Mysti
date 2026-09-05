/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * ModelAnnouncementService tests.
 *
 * The property that makes this safe to run on every model refresh is the SILENT
 * BASELINE: a provider's first reconcile announces nothing. Everything else here
 * exists to pin that the baseline cannot be skipped, faked by an empty list, or
 * undone by a dismiss — because each of those failures ends in a user being
 * spammed with a card for every model a backend has ever offered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import {
  ModelAnnouncementService,
  MODEL_ANNOUNCEMENTS_KEY,
} from '../../src/services/ModelAnnouncementService';
import { MODEL_ANNOUNCE_MAX_PENDING, MODEL_SEEN_MAX_PER_PROVIDER } from '../../src/constants';
import { createMockMemento } from '../helpers/mockVscode';

function makeContext() {
  const globalState = createMockMemento();
  return { context: { globalState } as unknown as ExtensionContext, globalState };
}

const CODEX = [
  { id: 'gpt-5.4-codex', name: 'GPT-5.4 Codex' },
  { id: 'gpt-5.2', name: 'GPT-5.2' },
];

describe('ModelAnnouncementService', () => {
  let ctx: ReturnType<typeof makeContext>;
  let svc: ModelAnnouncementService;

  beforeEach(() => {
    ctx = makeContext();
    svc = new ModelAnnouncementService(ctx.context);
  });

  describe('silent baseline', () => {
    it('announces nothing on a provider first sight, and records it as seen', () => {
      const spy = vi.fn();
      svc.onDidAnnounce(spy);

      expect(svc.reconcile('openai-codex', CODEX)).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      expect(svc.getPending()).toEqual([]);
      expect(svc.hasBaseline('openai-codex')).toBe(true);
    });

    it('announces ONLY the ids added after the baseline', () => {
      svc.reconcile('openai-codex', CODEX);

      const announced = svc.reconcile('openai-codex', [
        { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
        ...CODEX,
      ]);

      expect(announced.map(a => a.modelId)).toEqual(['gpt-6-astra']);
      expect(announced[0].providerId).toBe('openai-codex');
      expect(announced[0].name).toBe('GPT-6 Astra');
    });

    it('does not baseline on an EMPTY list — an unknown provider must not announce its whole catalogue later', () => {
      // A provider whose discovery has not answered yet reports nothing. If that
      // were treated as a baseline, the real list would arrive as "all new".
      expect(svc.reconcile('openai-codex', [])).toEqual([]);
      expect(svc.hasBaseline('openai-codex')).toBe(false);

      // First REAL list is the baseline, and is still silent.
      expect(svc.reconcile('openai-codex', CODEX)).toEqual([]);
      expect(svc.getPending()).toEqual([]);
    });

    it('baselines each provider independently', () => {
      svc.reconcile('openai-codex', CODEX);
      // A different provider is still on its own first sight → silent.
      expect(svc.reconcile('claude-code', [{ id: 'opus-5', name: 'Opus 5' }])).toEqual([]);
      expect(svc.hasBaseline('claude-code')).toBe(true);
    });
  });

  describe('fresh releases announce THROUGH the baseline', () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();

    it('announces a recently released model even on the provider first sight', () => {
      // The case this exists for: the build that adds announcements is also the
      // build that takes the first baseline. Without this, no existing user
      // would ever be told about a model already in the curated list.
      const announced = svc.reconcile('openai-codex', [
        ...CODEX,
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', releasedAt: iso(2) },
      ]);
      expect(announced.map(a => a.modelId)).toEqual(['gpt-6-astra']);
    });

    it('still stays silent about the OLD models in that same baseline', () => {
      const announced = svc.reconcile('openai-codex', [
        { id: 'gpt-5.4-codex', name: 'GPT-5.4 Codex' },
        { id: 'gpt-5.2', name: 'GPT-5.2', releasedAt: iso(400) },
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', releasedAt: iso(1) },
      ]);
      expect(announced.map(a => a.modelId)).toEqual(['gpt-6-astra']);
    });

    it('does not announce a release older than the freshness window', () => {
      expect(svc.reconcile('openai-codex', [
        ...CODEX,
        { id: 'old-model', name: 'Old', releasedAt: iso(90) },
      ])).toEqual([]);
    });

    it('fails closed on a malformed or future releasedAt', () => {
      expect(svc.reconcile('a', [{ id: 'x', name: 'X', releasedAt: 'not-a-date' }])).toEqual([]);
      expect(svc.reconcile('b', [{ id: 'y', name: 'Y', releasedAt: '' }])).toEqual([]);
      // A future date would otherwise announce forever once it arrives.
      expect(svc.reconcile('c', [{ id: 'z', name: 'Z', releasedAt: iso(-30) }])).toEqual([]);
    });

    it('does not re-announce the fresh model on the next refresh', () => {
      const list = [...CODEX, { id: 'gpt-6-astra', name: 'GPT-6 Astra', releasedAt: iso(2) }];
      expect(svc.reconcile('openai-codex', list)).toHaveLength(1);
      expect(svc.reconcile('openai-codex', list)).toEqual([]);
    });

    it('records the whole baseline as seen, so the non-fresh models never announce later', () => {
      svc.reconcile('openai-codex', [
        ...CODEX,
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', releasedAt: iso(2) },
      ]);
      // CODEX entries were silent at baseline; they must be seen, not pending-in-waiting.
      expect(svc.reconcile('openai-codex', CODEX)).toEqual([]);
    });

    it('takes a baseline without throwing when the provider has no prior state', () => {
      // Regression pin: the baseline path passes an ABSENT seen-list into the
      // cap helper. Iterating that undefined threw on every first reconcile.
      expect(() => svc.reconcile('brand-new', [{ id: 'a', name: 'A' }])).not.toThrow();
      expect(svc.hasBaseline('brand-new')).toBe(true);
    });
  });

  describe('announcing', () => {
    beforeEach(() => { svc.reconcile('openai-codex', CODEX); });

    it('fires onDidAnnounce and onDidChangePending exactly once for a new model', () => {
      const announce = vi.fn();
      const change = vi.fn();
      svc.onDidAnnounce(announce);
      svc.onDidChangePending(change);

      svc.reconcile('openai-codex', [...CODEX, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }]);

      expect(announce).toHaveBeenCalledTimes(1);
      expect(change).toHaveBeenCalledTimes(1);
      expect(announce.mock.calls[0][0].map((a: { modelId: string }) => a.modelId)).toEqual(['gpt-6-astra']);
    });

    it('stays silent (no event) when nothing changed', () => {
      const announce = vi.fn();
      svc.onDidAnnounce(announce);
      expect(svc.reconcile('openai-codex', CODEX)).toEqual([]);
      expect(announce).not.toHaveBeenCalled();
    });

    it('does not re-announce a model already announced', () => {
      const withAstra = [...CODEX, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }];
      expect(svc.reconcile('openai-codex', withAstra)).toHaveLength(1);
      // Second refresh sees the same list — already seen, so silent.
      expect(svc.reconcile('openai-codex', withAstra)).toEqual([]);
      expect(svc.getPending()).toHaveLength(1);
    });

    it('de-dupes a repeated id inside one list', () => {
      const announced = svc.reconcile('openai-codex', [
        ...CODEX,
        { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
        { id: 'gpt-6-astra', name: 'GPT-6 Astra (dup)' },
      ]);
      expect(announced).toHaveLength(1);
    });

    it('falls back to the id when a model carries no name', () => {
      const announced = svc.reconcile('openai-codex', [
        ...CODEX,
        { id: 'gpt-6-astra', name: '' },
      ]);
      expect(announced[0].name).toBe('gpt-6-astra');
    });

    it('caps pending cards, keeping the newest', () => {
      const many = Array.from({ length: MODEL_ANNOUNCE_MAX_PENDING + 5 }, (_, i) => ({
        id: `m-${i}`, name: `M${i}`,
      }));
      svc.reconcile('openai-codex', [...CODEX, ...many]);
      expect(svc.getPending()).toHaveLength(MODEL_ANNOUNCE_MAX_PENDING);
    });

    it('marks capped-out models as seen so they never resurface as new', () => {
      const many = Array.from({ length: MODEL_ANNOUNCE_MAX_PENDING + 5 }, (_, i) => ({
        id: `m-${i}`, name: `M${i}`,
      }));
      svc.reconcile('openai-codex', [...CODEX, ...many]);
      // Same list again: everything is seen, so nothing new — even the ids that
      // never got a card.
      expect(svc.reconcile('openai-codex', [...CODEX, ...many])).toEqual([]);
    });
  });

  describe('dismissal', () => {
    beforeEach(() => {
      svc.reconcile('openai-codex', CODEX);
      svc.reconcile('openai-codex', [...CODEX, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }]);
    });

    it('removes the card and does NOT bring it back on the next refresh', async () => {
      await svc.dismiss('openai-codex', 'gpt-6-astra');
      expect(svc.getPending()).toEqual([]);

      const again = svc.reconcile('openai-codex', [...CODEX, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }]);
      expect(again).toEqual([]);
      expect(svc.getPending()).toEqual([]);
    });

    it('dismiss of an unknown id is a no-op and fires nothing', async () => {
      const change = vi.fn();
      svc.onDidChangePending(change);
      await svc.dismiss('openai-codex', 'not-a-model');
      expect(change).not.toHaveBeenCalled();
      expect(svc.getPending()).toHaveLength(1);
    });

    it('dismissAll clears every card', async () => {
      svc.reconcile('claude-code', [{ id: 'a', name: 'A' }]);
      svc.reconcile('claude-code', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
      expect(svc.getPending().length).toBeGreaterThan(1);

      await svc.dismissAll();
      expect(svc.getPending()).toEqual([]);
    });

    it('getPendingFor filters by provider', () => {
      svc.reconcile('claude-code', [{ id: 'a', name: 'A' }]);
      svc.reconcile('claude-code', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);

      expect(svc.getPendingFor('openai-codex').map(p => p.modelId)).toEqual(['gpt-6-astra']);
      expect(svc.getPendingFor('claude-code').map(p => p.modelId)).toEqual(['b']);
    });
  });

  describe('persistence', () => {
    it('survives a restart: the baseline is not re-taken and cards come back', () => {
      svc.reconcile('openai-codex', CODEX);
      svc.reconcile('openai-codex', [...CODEX, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }]);

      const revived = new ModelAnnouncementService(ctx.context);
      expect(revived.hasBaseline('openai-codex')).toBe(true);
      expect(revived.getPending().map(p => p.modelId)).toEqual(['gpt-6-astra']);
      // And the same list is still not new to it.
      expect(revived.reconcile('openai-codex', [...CODEX, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }])).toEqual([]);
    });

    it('starts empty (and does not throw) on corrupt persisted state', () => {
      void ctx.globalState.update(MODEL_ANNOUNCEMENTS_KEY, { seen: 'not-an-object', pending: 42 });
      const revived = new ModelAnnouncementService(ctx.context);
      expect(revived.getPending()).toEqual([]);
      expect(revived.hasBaseline('openai-codex')).toBe(false);
    });

    it('drops malformed pending entries but keeps well-formed ones', () => {
      void ctx.globalState.update(MODEL_ANNOUNCEMENTS_KEY, {
        seen: { 'openai-codex': ['a'] },
        pending: [
          { providerId: 'openai-codex', modelId: 'a', name: 'A', announcedAt: 1 },
          { providerId: 42, modelId: 'b' },
          null,
        ],
      });
      const revived = new ModelAnnouncementService(ctx.context);
      expect(revived.getPending().map(p => p.modelId)).toEqual(['a']);
    });

    it('reset clears both the baseline and the cards', async () => {
      svc.reconcile('openai-codex', CODEX);
      await svc.reset();
      expect(svc.hasBaseline('openai-codex')).toBe(false);
    });
  });

  describe('seen-set bound', () => {
    it('never drops a CURRENT id when capping, so nothing re-announces', () => {
      const big = Array.from({ length: MODEL_SEEN_MAX_PER_PROVIDER, }, (_, i) => ({
        id: `m-${i}`, name: `M${i}`,
      }));
      svc.reconcile('bulk', big);            // baseline
      svc.reconcile('bulk', big);            // no change

      // A fresh list that fully replaces the old one: all new (announced), and
      // then stable — the cap must not evict any of these current ids.
      const replacement = Array.from({ length: MODEL_SEEN_MAX_PER_PROVIDER }, (_, i) => ({
        id: `n-${i}`, name: `N${i}`,
      }));
      expect(svc.reconcile('bulk', replacement).length).toBeGreaterThan(0);
      expect(svc.reconcile('bulk', replacement)).toEqual([]);
    });
  });
});
