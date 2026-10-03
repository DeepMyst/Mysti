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
 * DeskMcpBridge (Plan 21) — maps the Desk verb table onto MCP `tools/list`
 * and `tools/call` shapes.
 *
 * SDK-agnostic on purpose, exactly like `CanvasMcpBridge`: it speaks plain
 * objects, so the whole surface is testable with no transport, no server and
 * no network — and so the import-graph test can prove the serving path never
 * reaches a socket.
 *
 * ── Discovery is authorization-scoped ──────────────────────────────────────
 *
 * `listTools` returns only the verbs THIS peer was granted. An ungranted verb
 * is absent rather than listed-and-refused: a caller must not be able to
 * enumerate the capabilities it was denied, because that list is what an
 * attacker uses to choose a target. `DeskDispatch` enforces the same rule on
 * the call path, so the two cannot drift into disagreement.
 */

import type { DeskCallResult, DeskVerb, PeerGrant } from '../../types';
import { DESK_VERBS } from './DeskContract';
import { dispatch, listVerbs } from './DeskDispatch';
import type { DispatchContext } from './DeskDispatch';

/** An MCP tool descriptor. Plain data; no SDK types. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

/** An MCP `tools/call` response. */
export interface McpCallResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Tool names are namespaced so they cannot collide with a local tool. */
export const TOOL_PREFIX = 'desk.';

/** JSON Schema per verb. Mirrors DeskContract's validators, which remain the
 *  authority — a schema is a hint to the caller, never the enforcement. */
const SCHEMAS: Record<DeskVerb, McpToolDescriptor['inputSchema']> = {
  status: { type: 'object', properties: {}, additionalProperties: false },
  locate: {
    type: 'object',
    properties: {
      token: { type: 'string', description: 'An exact literal to look up. Not a pattern.' },
      kind: { type: 'string', enum: ['symbol', 'path'], default: 'symbol' },
    },
    required: ['token'],
    additionalProperties: false,
  },
  consult: {
    type: 'object',
    properties: { question: { type: 'string', description: 'A question about this peer’s codebase.' } },
    required: ['question'],
    additionalProperties: false,
  },
  review: {
    type: 'object',
    properties: {
      baseSha: { type: 'string', description: '40-char lowercase git object id.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths.' },
    },
    required: ['baseSha', 'paths'],
    additionalProperties: false,
  },
  handoff: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      baseSha: { type: 'string' },
    },
    required: ['title', 'baseSha'],
    additionalProperties: false,
  },
  assign: {
    type: 'object',
    properties: {
      proposalId: { type: 'string' },
      title: { type: 'string' },
      detail: { type: 'string' },
    },
    required: ['proposalId', 'title', 'detail'],
    additionalProperties: false,
  },
  followup: {
    type: 'object',
    properties: { cursor: { type: 'string' } },
    additionalProperties: false,
  },
};

/** The tools this peer may see, at this moment. */
export function listTools(grant: PeerGrant, now: number): McpToolDescriptor[] {
  return listVerbs(grant, now).map(verb => ({
    name: `${TOOL_PREFIX}${verb}`,
    // The description states what LEAVES the machine, not what the verb is
    // "for": the reader of a tool list is deciding whether to call it.
    description: `${DESK_VERBS[verb].discloses}.`,
    inputSchema: SCHEMAS[verb],
  }));
}

/** Strip the namespace, or null when the name is not one of ours. */
export function verbFromToolName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(TOOL_PREFIX)) { return null; }
  return name.slice(TOOL_PREFIX.length);
}

/**
 * Serve one `tools/call`.
 *
 * An unknown tool name produces the SAME error as an ungranted verb, for the
 * same reason the dispatcher does: the two must be indistinguishable.
 */
export function callTool(
  name: unknown,
  args: unknown,
  ctx: DispatchContext,
): McpCallResponse {
  const verb = verbFromToolName(name);
  if (verb === null) { return errorResponse('unknown verb'); }
  return toMcp(dispatch(verb, args, ctx));
}

function errorResponse(message: string): McpCallResponse {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Render a DeskCallResult as MCP content.
 *
 * The payload is serialized deterministically (sorted keys) so an identical
 * result produces identical bytes — which is what lets the caller's
 * approved-disclosure cache key on the response.
 */
export function toMcp(result: DeskCallResult): McpCallResponse {
  if (!result.ok) { return errorResponse(result.error ?? 'error'); }
  return { content: [{ type: 'text', text: stableStringify(result.payload ?? {}) }] };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') { return JSON.stringify(value) ?? 'null'; }
  if (Array.isArray(value)) { return `[${value.map(stableStringify).join(',')}]`; }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort()
    .map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
