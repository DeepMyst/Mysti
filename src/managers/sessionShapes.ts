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
 * Plan 29 — the session catalog.
 *
 * One table, three consumers: the slash menu builds its Sessions section from
 * it, the webview picker reads the minimum and the cost rate from it, and
 * SessionManager dispatches from it. A shape added here appears in all three
 * without another edit, which is what keeps the menu from offering a command
 * that cannot run.
 */
import type { SessionShapeDef, SessionShapeId } from '../types';

export const SESSION_SHAPES: readonly SessionShapeDef[] = [
  {
    id: 'review',
    command: '/review',
    label: '/review',
    description: 'each reads the same diff',
    minAgents: 2,
    maxAgents: 5,
    rounds: 1,
    costRate: 0.14,
  },
  {
    id: 'panel',
    command: '/panel',
    label: '/panel',
    description: 'independent answers, shown together',
    // Three is the floor on purpose: two agents answering independently is a
    // debate with the disagreement hidden, which is the one thing a panel is
    // supposed to surface.
    minAgents: 3,
    maxAgents: 5,
    rounds: 1,
    costRate: 0.10,
  },
  {
    id: 'critique',
    command: '/critique',
    label: '/critique',
    description: 'one proposes, the rest attack',
    // One proposer plus at least two attackers. With a single attacker this is
    // a conversation, and its verdict means much less.
    minAgents: 3,
    maxAgents: 5,
    rounds: 2,
    costRate: 0.09,
  },
  {
    id: 'race',
    command: '/race',
    label: '/race',
    description: 'all attempt it, you keep one',
    minAgents: 2,
    maxAgents: 5,
    rounds: 1,
    costRate: 0.18,
  },
  {
    id: 'brainstorm',
    command: '/brainstorm',
    label: '/brainstorm',
    description: 'build until they converge',
    minAgents: 2,
    maxAgents: 4,
    rounds: 2,
    costRate: 0.09,
  },
] as const;

const BY_ID = new Map<string, SessionShapeDef>(SESSION_SHAPES.map(s => [s.id, s]));

export function getSessionShape(id: string): SessionShapeDef | undefined {
  return BY_ID.get(id);
}

/** True when `id` names a shape — the guard every untrusted entry point uses. */
export function isSessionShapeId(id: string | undefined): id is SessionShapeId {
  return !!id && BY_ID.has(id);
}

/** The slash command id for a shape, e.g. `session:review`. */
export function sessionCommandId(id: SessionShapeId): string {
  return `session:${id}`;
}

/** The shape a `session:<id>` command id names, or undefined. */
export function shapeFromCommandId(commandId: string): SessionShapeDef | undefined {
  if (!commandId.startsWith('session:')) { return undefined; }
  return BY_ID.get(commandId.slice('session:'.length));
}

/**
 * The pre-run estimate, in USD. Deliberately rough and deliberately shown
 * BEFORE the button goes live: the point is that N agents costs N times, and a
 * race bills every lane including the ones you discard. The ledger reports the
 * real figure afterwards.
 */
export function estimateSessionCost(shape: SessionShapeDef, agentCount: number): number {
  return agentCount * shape.costRate * shape.rounds;
}
