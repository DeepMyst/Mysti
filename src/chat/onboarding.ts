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
 * Plan 33 — the onboarding state the host owns: which first-time tips this
 * user has already seen, whether the Getting-started card still renders, and
 * whether they have ever sent a message to another agent with @. Pure over a
 * Memento so it tests without a VS Code host.
 */
import type * as vscode from 'vscode';

export const TIP_IDS = ['permission', 'mention', 'rewind', 'brainstorm', 'compaction'] as const;
export type TipId = (typeof TIP_IDS)[number];
export function isTipId(value: unknown): value is TipId {
  return typeof value === 'string' && (TIP_IDS as readonly string[]).includes(value);
}

export const WIZARD_STEPS = ['connect', 'mode', 'task'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export function isWizardStep(value: unknown): value is WizardStep {
  return typeof value === 'string' && (WIZARD_STEPS as readonly string[]).includes(value);
}

export const TIPS_SEEN_KEY = 'mysti.tips.seen';
export const GETTING_STARTED_KEY = 'mysti.gettingStarted';
export const USED_MENTION_KEY = 'mysti.onboarding.usedMention';

type Store = Pick<vscode.Memento, 'get' | 'update'>;

export interface GettingStartedItems { connect: boolean; mode: boolean; task: boolean; mention: boolean }
export interface OnboardingSnapshot {
  tips: { enabled: boolean; seen: TipId[] };
  /** null = do not render the card. */
  gettingStarted: { items: GettingStartedItems } | null;
}
export interface OnboardingInputs {
  store: Store;
  tipsEnabled: boolean;
  /** `mysti.hasCompletedSetup`: true for anyone who got an answer before this shipped. */
  hasCompletedSetup: boolean;
  agentReady: boolean;
  modeChosen: boolean;
  messagesSent: number;
}

/** True once the user has set mode or access themselves (the pill and the wizard both write these). */
export function hasChosenMode(config: { inspect(key: string): { globalValue?: unknown } | undefined }): boolean {
  return ['defaultMode', 'accessLevel'].some((k) => config.inspect(k)?.globalValue !== undefined);
}

export function seenTips(store: Store): TipId[] {
  const raw = store.get<unknown>(TIPS_SEEN_KEY, []);
  return Array.isArray(raw) ? raw.filter(isTipId) : [];
}

export async function markTipSeen(store: Store, id: TipId): Promise<void> {
  const seen = seenTips(store);
  if (!seen.includes(id)) { await store.update(TIPS_SEEN_KEY, [...seen, id]); }
}

export async function hideGettingStarted(store: Store): Promise<void> {
  await store.update(GETTING_STARTED_KEY, 'hidden');
}

export async function recordAgentMention(store: Store): Promise<void> {
  if (store.get<boolean>(USED_MENTION_KEY) !== true) { await store.update(USED_MENTION_KEY, true); }
}

export async function onboardingSnapshot(i: OnboardingInputs): Promise<OnboardingSnapshot> {
  let visibility = i.store.get<string>(GETTING_STARTED_KEY);
  if (visibility !== 'show' && visibility !== 'hidden') {
    // Decided once, on the first panel load after install or upgrade.
    visibility = i.hasCompletedSetup ? 'hidden' : 'show';
    await i.store.update(GETTING_STARTED_KEY, visibility);
  }
  const items: GettingStartedItems = {
    connect: i.agentReady,
    mode: i.modeChosen,
    task: typeof i.messagesSent === 'number' && i.messagesSent > 0,
    mention: i.store.get<boolean>(USED_MENTION_KEY) === true,
  };
  const allDone = Object.values(items).every(Boolean);
  return {
    tips: { enabled: i.tipsEnabled, seen: seenTips(i.store) },
    gettingStarted: visibility === 'show' && !allDone ? { items } : null,
  };
}
