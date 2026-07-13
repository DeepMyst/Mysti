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
 * OrchestratorDag (Plan 15 Phase 2a) — the task DAG the @mysti coordinator runs.
 *
 * Pure, dependency-free: parse the coordinator model's JSON decomposition into a
 * node graph, validate it (unique ids, resolvable deps, acyclic, size-bounded),
 * and split it into topological frontiers (each frontier = a set of nodes with
 * all deps satisfied, dispatched in parallel through the CollaboratorPool).
 * Diamonds (a node depended on by several) are legal and handled by construction.
 */

/** Hard cap on decomposed nodes — a governor backstop against runaway plans. */
export const DAG_MAX_NODES = 24;

export interface OrchestratorNode {
  /** Unique id within the plan. */
  id: string;
  /** The sub-task description handed to the assigned backend. */
  task: string;
  /** Optional explicit backend (provider id); resolved by the router when absent. */
  backend?: string;
  /** Ids of nodes whose output this node depends on (empty = a root). */
  dependsOn: string[];
}

export interface OrchestratorPlan {
  nodes: OrchestratorNode[];
}

export interface DagValidation {
  valid: boolean;
  error?: string;
}

/**
 * Extract an OrchestratorPlan from the coordinator model's text output. Accepts a
 * `{ "nodes": [...] }` object or a bare `[...]` array of nodes, tolerating prose
 * around the JSON. Returns null when no valid plan can be parsed.
 */
export function parseOrchestratorPlan(raw: string): OrchestratorPlan | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const candidate = extractJson(raw);
  if (candidate === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const rawNodes = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { nodes?: unknown }).nodes))
      ? (parsed as { nodes: unknown[] }).nodes
      : null;
  if (!rawNodes) {
    return null;
  }

  const nodes: OrchestratorNode[] = [];
  for (const n of rawNodes) {
    if (!n || typeof n !== 'object') {
      continue;
    }
    const obj = n as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    const task = typeof obj.task === 'string' ? obj.task.trim() : '';
    if (!id || !task) {
      continue;
    }
    const backend = typeof obj.backend === 'string' && obj.backend.trim() ? obj.backend.trim() : undefined;
    const dependsOn = Array.isArray(obj.dependsOn)
      ? obj.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map(d => d.trim())
      : [];
    nodes.push({ id, task, backend, dependsOn });
  }

  if (nodes.length === 0) {
    return null;
  }
  return { nodes };
}

/**
 * Validate a plan: non-empty, within the node cap, unique ids, every dependency
 * resolvable, no self-dependency, and acyclic.
 */
export function validateDag(plan: OrchestratorPlan): DagValidation {
  const { nodes } = plan;
  if (nodes.length === 0) {
    return { valid: false, error: 'plan has no nodes' };
  }
  if (nodes.length > DAG_MAX_NODES) {
    return { valid: false, error: `plan exceeds the ${DAG_MAX_NODES}-node cap (${nodes.length})` };
  }

  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) {
      return { valid: false, error: `duplicate node id '${n.id}'` };
    }
    ids.add(n.id);
  }

  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (dep === n.id) {
        return { valid: false, error: `node '${n.id}' depends on itself` };
      }
      if (!ids.has(dep)) {
        return { valid: false, error: `node '${n.id}' depends on unknown node '${dep}'` };
      }
    }
  }

  // Acyclicity: a full topological sort must consume every node.
  if (!isAcyclic(nodes)) {
    return { valid: false, error: 'plan has a dependency cycle' };
  }

  return { valid: true };
}

/**
 * Split a validated plan into topological frontiers. Each frontier is a set of
 * node ids whose dependencies are all in earlier frontiers, so they can run in
 * parallel; dependents fall into later frontiers. Assumes the plan is acyclic
 * (validate first). Ids within a frontier preserve input order for determinism.
 */
export function topologicalFrontiers(plan: OrchestratorPlan): string[][] {
  const nodes = plan.nodes;
  const remaining = new Map<string, Set<string>>();
  for (const n of nodes) {
    remaining.set(n.id, new Set(n.dependsOn));
  }

  const frontiers: string[][] = [];
  const done = new Set<string>();

  while (remaining.size > 0) {
    // Nodes with all deps satisfied, in original order.
    const frontier = nodes
      .filter(n => remaining.has(n.id))
      .filter(n => Array.from(remaining.get(n.id)!).every(dep => done.has(dep)))
      .map(n => n.id);

    if (frontier.length === 0) {
      // Should not happen on a validated (acyclic) plan; guard against infinite loop.
      break;
    }
    frontiers.push(frontier);
    for (const id of frontier) {
      remaining.delete(id);
      done.add(id);
    }
  }

  return frontiers;
}

/** Longest dependency chain length (number of frontiers) — informational. */
export function chainLength(plan: OrchestratorPlan): number {
  return topologicalFrontiers(plan).length;
}

// ---------------------------------------------------------------------------

function isAcyclic(nodes: OrchestratorNode[]): boolean {
  const remaining = new Map<string, Set<string>>();
  for (const n of nodes) {
    remaining.set(n.id, new Set(n.dependsOn.filter(d => nodes.some(m => m.id === d))));
  }
  const done = new Set<string>();
  let progress = true;
  while (remaining.size > 0 && progress) {
    progress = false;
    for (const [id, deps] of Array.from(remaining.entries())) {
      if (Array.from(deps).every(d => done.has(d))) {
        remaining.delete(id);
        done.add(id);
        progress = true;
      }
    }
  }
  return remaining.size === 0;
}

/**
 * Find the first balanced top-level JSON object or array in a string. Handles
 * strings/escapes so braces inside JSON string literals don't confuse the scan.
 */
function extractJson(text: string): string | null {
  const startObj = text.indexOf('{');
  const startArr = text.indexOf('[');
  let start: number;
  let open: string;
  let close: string;
  if (startObj === -1 && startArr === -1) {
    return null;
  }
  if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
    start = startObj; open = '{'; close = '}';
  } else {
    start = startArr; open = '['; close = ']';
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
