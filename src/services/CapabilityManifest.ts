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
 * CapabilityManifest (Plan 20 Phase 3) — `mysti.tools.json`, and the
 * non-executing half of the verification ladder.
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE
 * -----------------------------------
 * A skill folder that carries a `mysti.tools.json` is also CALLABLE. The
 * manifest names entries, describes them, and declares a CLOSED argument
 * schema. What it deliberately cannot do is say how to run itself: there is no
 * `command`, no `shell`, no `args` template and no interpreter path. The
 * interpreter comes from a fixed host map and the command line is materialized
 * by the host. A model that cannot name a command is a model no confirmation
 * dialog can be talked into approving — strictly stronger than gating one it
 * can name, and the direct lesson of this repo's earlier ungated-spawn RCE.
 *
 * WHY `allowed-tools` DOES NOT EXIST HERE
 * ---------------------------------------
 * Anthropic's own docs concede a project skill's `allowed-tools` applies even
 * in an untrusted folder, and that "a skill can grant itself broad tool
 * access". Any field through which an artifact grants ITSELF authority is an
 * escalation primitive, so the manifest has no such field to hoist.
 *
 * This module is pure: no fs, no vscode. Validation is deterministic host code
 * precisely so it cannot be argued with by a model.
 */

/** How a callable entry is executed. Interpreter is a KEY, never a path. */
export interface CapabilityExec {
  interpreter: 'bash' | 'python3' | 'node';
  /** Path relative to the artifact's own directory. */
  script: string;
}

export interface CapabilityEntry {
  name: string;
  description: string;
  /** JSON-Schema object subset; MUST be closed (`additionalProperties: false`). */
  inputSchema: Record<string, unknown>;
  exec: CapabilityExec;
  /** Egress is opt-in, always forces a card, and needs bashNetwork on. */
  network?: boolean;
  timeoutMs?: number;
}

export interface ManifestIssue {
  entry: string;
  problem: string;
}

export interface ManifestValidation {
  entries: CapabilityEntry[];
  issues: ManifestIssue[];
  ok: boolean;
}

/** The ONLY interpreters a capability may use. Resolved to a path host-side. */
export const CAPABILITY_INTERPRETERS = ['bash', 'python3', 'node'] as const;

/**
 * `namespace_verb` — namespaced so a capability can never collide with a
 * built-in tool, and readable enough that a reviewer can tell what it claims to
 * do from the name alone.
 */
export const CAPABILITY_NAME_RE = /^[a-z][a-z0-9]*_[a-z][a-z0-9_]{0,40}$/;

const MAX_ENTRIES = 20;
const MAX_DESC = 200;
const MAX_TIMEOUT_MS = 120_000;

/** Control characters stripped from any description before it is shown. */
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

/**
 * Host-owned prefix on every capability description.
 *
 * Tool descriptions render in the model's tool-definition tier, which cannot be
 * fenced — models treat that array as operator configuration. A user-authored
 * description sitting there unmarked is an instruction channel, so the host
 * stamps it as a label and the stamp is not removable by the author.
 */
export const CAPABILITY_DESC_PREFIX = '[user-authored capability] ';

/** Descriptions that address the assistant are instructions, not labels. */
const IMPERATIVE_RE = /\b(you must|you should|always call|never call|before any|ignore (the |all )?(previous|above|prior)|disregard|system prompt|instead of)\b/i;

/** Primitives that reach the network; allowed only when `network: true`. */
const NETWORK_PRIMITIVE_RE = /\b(fetch|curl|wget|urllib|requests|socket|telnet|ssh|scp|rsync|nc)\b/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a parsed `mysti.tools.json`. Deterministic and non-executing — this
 * is V1 of the ladder, and it completes before any bytes run.
 *
 * Returns every issue rather than the first, so a reviewer sees the whole
 * picture and an author can fix in one pass.
 */
export function validateCapabilityManifest(raw: unknown): ManifestValidation {
  const issues: ManifestIssue[] = [];
  const entries: CapabilityEntry[] = [];

  if (!Array.isArray(raw)) {
    return { entries: [], issues: [{ entry: '(file)', problem: 'mysti.tools.json must be a JSON array of entries.' }], ok: false };
  }
  if (raw.length === 0) {
    return { entries: [], issues: [{ entry: '(file)', problem: 'mysti.tools.json is empty.' }], ok: false };
  }
  if (raw.length > MAX_ENTRIES) {
    issues.push({ entry: '(file)', problem: `Too many entries (${raw.length} > ${MAX_ENTRIES}).` });
  }

  const seen = new Set<string>();
  for (const [i, item] of raw.slice(0, MAX_ENTRIES).entries()) {
    const label = isPlainObject(item) && typeof item.name === 'string' ? item.name : `entry #${i + 1}`;
    const bad = (problem: string): void => { issues.push({ entry: label, problem }); };

    if (!isPlainObject(item)) { bad('Entry is not an object.'); continue; }

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!CAPABILITY_NAME_RE.test(name)) {
      bad('`name` must look like `namespace_verb` (lowercase, underscore-separated).');
      continue;
    }
    if (seen.has(name)) { bad('Duplicate `name`.'); continue; }
    seen.add(name);

    const rawDesc = typeof item.description === 'string'
      ? item.description.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
      : '';
    if (!rawDesc) { bad('`description` is required.'); continue; }
    if (IMPERATIVE_RE.test(rawDesc)) {
      bad('`description` addresses the assistant. It is a label for a reviewer, not an instruction.');
      continue;
    }
    const description = CAPABILITY_DESC_PREFIX + rawDesc.slice(0, MAX_DESC);

    const schemaIssue = closedSchemaProblem(item.inputSchema);
    if (schemaIssue) { bad(schemaIssue); continue; }

    const exec = item.exec;
    if (!isPlainObject(exec)) { bad('`exec` is required ({ interpreter, script }).'); continue; }
    const interpreter = String(exec.interpreter || '');
    if (!(CAPABILITY_INTERPRETERS as readonly string[]).includes(interpreter)) {
      bad(`\`exec.interpreter\` must be one of: ${CAPABILITY_INTERPRETERS.join(', ')}.`);
      continue;
    }
    const script = String(exec.script || '').trim();
    if (!script || script.startsWith('/') || script.includes('..') || script.includes('\\') || /^[a-zA-Z]:/.test(script)) {
      bad('`exec.script` must be a relative path inside the artifact.');
      continue;
    }

    const network = item.network === true;
    const timeoutRaw = typeof item.timeoutMs === 'number' ? item.timeoutMs : 30_000;
    const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw), 1_000), MAX_TIMEOUT_MS);

    entries.push({
      name,
      description,
      inputSchema: item.inputSchema as Record<string, unknown>,
      exec: { interpreter: interpreter as CapabilityExec['interpreter'], script },
      network,
      timeoutMs,
    });
  }

  return { entries, issues, ok: issues.length === 0 && entries.length > 0 };
}

/**
 * A capability's schema must be CLOSED. Unlike the advisory MCP schemas, the
 * host VALIDATES arguments against this one before materializing a command, so
 * an open schema would mean unvalidated model strings reaching a script.
 */
export function closedSchemaProblem(schema: unknown): string | null {
  if (!isPlainObject(schema)) { return '`inputSchema` is required and must be an object.'; }
  if (schema.type !== 'object') { return '`inputSchema.type` must be "object".'; }
  if (schema.additionalProperties !== false) {
    return '`inputSchema.additionalProperties` must be false — the host validates arguments against this schema.';
  }
  const props = schema.properties;
  if (!isPlainObject(props)) { return '`inputSchema.properties` is required.'; }
  const names = Object.keys(props);
  if (names.length === 0) { return '`inputSchema.properties` is empty.'; }
  if (names.length > 20) { return '`inputSchema.properties` has too many properties (max 20).'; }
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(n)) { return `Property "${n}" is not a plain identifier.`; }
    const p = props[n];
    if (!isPlainObject(p) || typeof p.type !== 'string') { return `Property "${n}" needs a scalar \`type\`.`; }
    if (!['string', 'number', 'integer', 'boolean'].includes(p.type)) {
      // Scalars only: every argument is serialized into a JSON args file and
      // read by a script. Nested objects widen what a script must parse for no
      // benefit a flat schema cannot express.
      return `Property "${n}" must be a scalar type (string/number/integer/boolean).`;
    }
  }
  const required = schema.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) { return '`inputSchema.required` must be an array.'; }
    for (const r of required) {
      if (typeof r !== 'string' || !names.includes(r)) { return `\`required\` names "${String(r)}", which is not a property.`; }
    }
  }
  return null;
}

/**
 * Validate model-supplied arguments against a stored closed schema.
 *
 * This is what lets `skill_run` be a genuine NARROWING of `bash` rather than a
 * synonym for it: by the time anything is materialized, every value has been
 * type-checked against a schema a human approved, and the values travel in a
 * FILE rather than on a command line, so there is no quoting surface at all.
 */
export function validateCapabilityArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const props = (schema.properties || {}) as Record<string, { type?: string }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  for (const key of Object.keys(args)) {
    if (!(key in props)) {
      return { ok: false, error: `Unknown argument "${key}". Allowed: ${Object.keys(props).join(', ') || '(none)'}.` };
    }
  }
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return { ok: false, error: `Missing required argument "${key}".` };
    }
  }

  const value: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(props)) {
    const raw = args[key];
    if (raw === undefined || raw === null) { continue; }
    switch (spec.type) {
      case 'string': {
        if (typeof raw !== 'string') { return { ok: false, error: `"${key}" must be a string.` }; }
        if (raw.length > 8_000) { return { ok: false, error: `"${key}" is too long (max 8000 characters).` }; }
        value[key] = raw;
        break;
      }
      case 'number':
      case 'integer': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) { return { ok: false, error: `"${key}" must be a number.` }; }
        if (spec.type === 'integer' && !Number.isInteger(n)) { return { ok: false, error: `"${key}" must be an integer.` }; }
        value[key] = n;
        break;
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') { return { ok: false, error: `"${key}" must be true or false.` }; }
        value[key] = raw;
        break;
      }
      default:
        return { ok: false, error: `"${key}" has an unsupported type in the stored schema.` };
    }
  }
  return { ok: true, value };
}

/**
 * Scan a script body for egress primitives it did not declare.
 *
 * Not a sandbox and not claimed to be one — the sandbox is the enforcement
 * point. This exists so an undeclared `curl` is caught at REVIEW time, in front
 * of the human, rather than silently failing later inside a network-denied
 * sandbox where the model would simply be told the command errored.
 */
export function undeclaredNetworkUse(scriptBody: string, declaredNetwork: boolean): string | null {
  if (declaredNetwork) { return null; }
  const hit = NETWORK_PRIMITIVE_RE.exec(scriptBody);
  return hit ? `Script uses "${hit[0]}" but does not declare \`network: true\`.` : null;
}
