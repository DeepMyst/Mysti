/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 * See the LICENSE file in the project root for full license terms.
 */

/** JSON objects exclude arrays and null, which cannot carry named payload fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) { throw new Error('Expected a JSON object'); }
  return value;
}

/** Preserve useful messages from libraries that reject with plain objects or strings. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) { return error.message; }
  const message = asString(asRecord(error)?.message);
  if (message) { return message; }
  try { return String(error); } catch { return 'Unknown error'; }
}
