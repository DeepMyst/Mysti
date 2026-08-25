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
 * Plan 24 Phase 0 — the CompactionManager Boost-overlay seam. The invariants:
 * (1) with no overlay wired, behaviour is byte-identical to stock; (2) wiring
 * an overlay takes effect immediately (no settings change needed); (3) an
 * overlay returning undefined means "stock read", per key; (4) the overlay
 * SURVIVES a settings-change reload, because the loaders re-consult it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { fireConfigurationChange, clearConfigurationListeners } from '../helpers/mockVscode';
import { CompactionManager, BoostCompactionOverlay } from '../../src/managers/CompactionManager';

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function overlay(threshold: number | undefined, smart: boolean | undefined): BoostCompactionOverlay {
  return {
    compactionThreshold: () => threshold,
    smartCompactionEnabled: () => smart,
  };
}

describe('CompactionManager Boost overlay seam', () => {
  const managers: CompactionManager[] = [];
  afterEach(() => {
    for (const m of managers.splice(0)) { m.dispose(); }
    clearConfigurationListeners();
  });
  function make(): CompactionManager {
    const m = new CompactionManager(makeContext());
    managers.push(m);
    return m;
  }

  it('is stock without an overlay (default threshold 75, smart off)', () => {
    const m = make();
    expect(m.getThreshold()).toBe(75);
    expect(m.isSmartEnabled()).toBe(false);
  });

  it('applies the overlay immediately on wiring', () => {
    const m = make();
    m.setBoostOverlay(overlay(45, true));
    expect(m.getThreshold()).toBe(45);
    expect(m.isSmartEnabled()).toBe(true);
  });

  it('treats undefined per-key as "use the stock read"', () => {
    const m = make();
    m.setBoostOverlay(overlay(undefined, true));
    expect(m.getThreshold()).toBe(75);
    expect(m.isSmartEnabled()).toBe(true);

    const m2 = make();
    m2.setBoostOverlay(overlay(35, undefined));
    expect(m2.getThreshold()).toBe(35);
    expect(m2.isSmartEnabled()).toBe(false);
  });

  it('survives a mysti.compaction settings reload', () => {
    const m = make();
    m.setBoostOverlay(overlay(45, true));
    fireConfigurationChange('mysti.compaction.threshold');
    expect(m.getThreshold()).toBe(45);
    expect(m.isSmartEnabled()).toBe(true);
  });

  it('re-runs the loaders on a mysti.boost settings change', () => {
    const m = make();
    let current: number | undefined = 45;
    m.setBoostOverlay({ compactionThreshold: () => current, smartCompactionEnabled: () => undefined });
    expect(m.getThreshold()).toBe(45);
    // Simulate the user flipping Boost off: the overlay starts answering
    // undefined, and the mysti.boost config-change event triggers the reload.
    current = undefined;
    fireConfigurationChange('mysti.boost.enabled');
    expect(m.getThreshold()).toBe(75);
  });
});
