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
 * Native tool-calling foundation for the Mysti coordinator (Plan 19 Phase 4,
 * the deferred Plan 16 P1.4b). One op set, two encodings:
 *   - text directives (<read:>, <write:>, …) parsed by MystiTagScanner, and
 *   - OpenAI-style function `tools` for models that support tool-calling.
 * This module is the SHARED, pure core: the tool schemas, a conservative
 * capability check (unknown models fall back to the proven text protocol), and
 * a converter that maps a parsed tool_call back onto a `MystiDirective` so the
 * coordinator's EXISTING dispatch/gate/fence logic runs unchanged — a native
 * tool_call is never more trusted than a text directive.
 */

import type { MystiDirective } from '../utils/mystiDelegateParser';

/** OpenAI-style function tool schema. */
export interface CoordinatorTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const str = (description: string) => ({ type: 'string', description });

/** Read-only + delegate tools — always available to the coordinator. */
const READ_TOOLS: CoordinatorTool[] = [
  { type: 'function', function: { name: 'read', description: 'Read a workspace file (line-numbered). Optional 1-based inclusive range.', parameters: { type: 'object', properties: { path: str('workspace-relative path'), start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'ls', description: 'List a workspace directory (one level).', parameters: { type: 'object', properties: { path: str('workspace-relative directory (empty = root)') }, required: [] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents across the repo by regex.', parameters: { type: 'object', properties: { pattern: str('regex'), include: str('optional path glob, e.g. src/**') }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'diag', description: 'Live compiler/linter diagnostics from the editor (or a single file path).', parameters: { type: 'object', properties: { target: str('"all" or a file path') }, required: [] } } },
  { type: 'function', function: { name: 'remember', description: 'Persist a durable project fact across sessions/backends. Use sparingly.', parameters: { type: 'object', properties: { fact: str('the fact') }, required: ['fact'] } } },
  { type: 'function', function: { name: 'delegate', description: 'Hand a self-contained task to a specialist coding backend.', parameters: { type: 'object', properties: { agent: str('backend id'), task: str('self-contained task text'), tier: { type: 'string', enum: ['fast', 'strong'] } }, required: ['agent', 'task'] } } },
];

/** Gated local execution tools — only when local execution is enabled. */
const EXEC_TOOLS: CoordinatorTool[] = [
  { type: 'function', function: { name: 'write', description: 'Create or overwrite a whole file (gated + checkpointed).', parameters: { type: 'object', properties: { path: str('workspace-relative path'), content: str('full file content') }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Targeted string replacement in an existing file (old_string must be unique unless replace_all).', parameters: { type: 'object', properties: { path: str('workspace-relative path'), old_string: str('exact existing text'), new_string: str('replacement'), replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'patch', description: 'Apply an atomic multi-file patch (Add/Update SEARCH-REPLACE/Delete/Move envelope).', parameters: { type: 'object', properties: { patch: str('the *** Add/Update/Delete/Move envelope') }, required: ['patch'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run ONE shell command in an OS sandbox (no network, writes limited to the workspace). No chaining.', parameters: { type: 'object', properties: { command: str('a single shell command') }, required: ['command'] } } },
];

/** A `connect` tool — offered when DeepMyst is wired (Plan 19 Phase 6). SAFE. */
const CONNECT_TOOL: CoordinatorTool = {
  type: 'function',
  function: {
    name: 'connect',
    description: 'Offer the user a one-click button to connect an external service (Gmail, Slack, Notion, a database, …) through DeepMyst — use when the task needs a service the user has NOT connected yet. Grants no access by itself; the user completes an OAuth flow.',
    parameters: { type: 'object', properties: { service: str('short lowercase service slug, e.g. gmail, slack, notion, postgres, github') }, required: ['service'] },
  },
};

/**
 * The tool schemas offered to a capable coordinator model.
 * @param mcpTools the user's CONNECTED external MCP tools (name + description),
 *   exposed as `mcp__<name>` functions so the model can call them natively.
 * @param connectEnabled whether to offer the `connect` tool (DeepMyst wired).
 */
export function coordinatorToolSchemas(
  execEnabled: boolean,
  mcpTools: Array<{ name: string; description?: string }> = [],
  connectEnabled = false,
): CoordinatorTool[] {
  const base = execEnabled ? [...READ_TOOLS, ...EXEC_TOOLS] : [...READ_TOOLS];
  if (connectEnabled) { base.push(CONNECT_TOOL); }
  // External MCP tools are namespaced `mcp__<name>` so they can never collide
  // with a built-in tool. No inputSchema is available from listTools(), so the
  // parameters are open (the model infers args from the description).
  for (const t of mcpTools) {
    base.push({
      type: 'function',
      function: {
        name: `mcp__${t.name}`,
        description: (t.description || t.name).slice(0, 1024),
        parameters: { type: 'object', additionalProperties: true, properties: {} },
      },
    });
  }
  return base;
}

/**
 * Conservative capability check. Returns true ONLY for models known to do
 * OpenAI-style function calling well; anything unknown falls back to the proven
 * text-directive protocol (a broken native path would break the coordinator).
 */
const TOOL_CAPABLE = /(gpt|claude|gemini|gemma|nemotron|qwen|mistral|command-r|codestral|deepseek|grok|kimi|llama-3\.[1-9]|llama-4|phi-[34]|mixtral)/i;
export function modelSupportsToolCalls(modelId: string | undefined): boolean {
  return !!modelId && TOOL_CAPABLE.test(modelId);
}

function asStr(v: unknown): string { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }
function asIntOrU(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/**
 * Map a parsed native tool_call to a MystiDirective so the coordinator's
 * existing dispatch runs it (same gate/fence/budget). Returns {error} for an
 * unknown tool or missing required args — the caller feeds that back to the model.
 */
export function toolCallToDirective(name: string, args: Record<string, unknown>): MystiDirective | { error: string } {
  const a = args || {};
  switch (name) {
    case 'read': {
      const path = asStr(a.path).trim();
      if (!path) { return { error: 'read: "path" is required.' }; }
      return { kind: 'read', path, startLine: asIntOrU(a.start_line), endLine: asIntOrU(a.end_line) };
    }
    case 'ls':
      return { kind: 'ls', path: asStr(a.path).trim() || '.' };
    case 'grep': {
      const pattern = asStr(a.pattern);
      if (!pattern.trim()) { return { error: 'grep: "pattern" is required.' }; }
      const include = asStr(a.include).trim();
      return { kind: 'grep', pattern, include: include || undefined };
    }
    case 'diag':
      return { kind: 'diag', target: asStr(a.target).trim() || 'all' };
    case 'remember': {
      const fact = asStr(a.fact).trim();
      if (!fact) { return { error: 'remember: "fact" is required.' }; }
      return { kind: 'remember', fact };
    }
    case 'delegate': {
      const agent = asStr(a.agent).trim();
      const task = asStr(a.task).trim();
      if (!agent || !task) { return { error: 'delegate: "agent" and "task" are required.' }; }
      const tier = a.tier === 'fast' || a.tier === 'strong' ? a.tier : undefined;
      return { kind: 'delegate', agent, task, ...(tier ? { tier } : {}) };
    }
    case 'write': {
      const path = asStr(a.path).trim();
      if (!path) { return { error: 'write: "path" is required.' }; }
      if (a.content === undefined || a.content === null) { return { error: 'write: "content" is required (use "" for an empty file).' }; }
      return { kind: 'write', path, content: asStr(a.content) };
    }
    case 'edit': {
      const path = asStr(a.path).trim();
      const oldString = asStr(a.old_string);
      if (!path || !oldString) { return { error: 'edit: "path" and a non-empty "old_string" are required.' }; }
      return { kind: 'edit', path, oldString, newString: asStr(a.new_string), replaceAll: !!a.replace_all };
    }
    case 'patch': {
      const patchText = asStr(a.patch);
      if (!patchText.trim()) { return { error: 'patch: "patch" envelope is required.' }; }
      return { kind: 'patch', patchText };
    }
    case 'bash': {
      const command = asStr(a.command).trim();
      if (!command) { return { error: 'bash: "command" is required.' }; }
      return { kind: 'bash', command };
    }
    case 'connect': {
      const service = asStr(a.service).trim().toLowerCase();
      if (!service || !/^[a-z0-9][a-z0-9._-]*$/.test(service)) { return { error: 'connect: a valid lowercase "service" slug is required.' }; }
      return { kind: 'connect', service };
    }
    default:
      // External MCP tools arrive namespaced `mcp__<name>` (Plan 19 Phase 6) —
      // map back to the gated mcptool directive so the SAME dispatch runs them.
      if (name.startsWith('mcp__')) {
        const tool = name.slice(5).trim();
        if (!tool) { return { error: 'mcp tool: missing tool name.' }; }
        return { kind: 'mcptool', tool, args: (a && typeof a === 'object' ? a : {}) as Record<string, unknown> };
      }
      return { error: `Unknown tool "${name}".` };
  }
}
