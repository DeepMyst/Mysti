/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UsageStats } from '../../types';
import { contextFillTokens, normalizeUsage } from '../../services/TokenAccounting';
import { validateModelName } from '../../utils/validation';

export interface OpenClawRunMetadata {
  usage?: UsageStats;
  contextUsage: UsageStats | null;
  contextWindow?: number;
  reportedModel?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** OpenClaw has already split cached tokens out of input, even for OpenAI models. */
function usageSnapshot(value: unknown): UsageStats | undefined {
  if (!record(value)) { return undefined; }
  // The native accumulator omits zero buckets. A present malformed bucket is
  // different: it cannot support a measured prompt size or a valid cost total.
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  if (fields.some(field => value[field] !== undefined && !tokenCount(value[field]))) { return undefined; }
  const [input, output, cacheRead, cacheWrite] = fields.map(field => (value[field] as number | undefined) ?? 0);
  const total = input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(total) || total === 0) { return undefined; }
  return normalizeUsage({ input_tokens: input, output_tokens: output,
    ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
  }, 'anthropic');
}

/** Read native final-result metadata without inferring context from run totals. */
export function readOpenClawRunMetadata(result: unknown): OpenClawRunMetadata | undefined {
  if (!record(result) || !record(result.meta) || !record(result.meta.agentMeta)) { return undefined; }
  const meta = result.meta.agentMeta;
  const usage = usageSnapshot(meta.usage);
  const lastCall = usageSnapshot(meta.lastCallUsage);
  let contextUsage = lastCall && contextFillTokens(lastCall) > 0 ? lastCall : null;
  if (tokenCount(meta.promptTokens) && meta.promptTokens > 0 && meta.promptTokens !== contextFillTokens(contextUsage)) {
    // An explicit latest-prompt measurement can differ after compaction. Its
    // cache split is unknown, so do not attach the older call's cache buckets.
    contextUsage = normalizeUsage({ input_tokens: meta.promptTokens, output_tokens: 0 }, 'none');
  }
  let reportedModel: string | undefined;
  if (typeof meta.model === 'string' && meta.model === meta.model.trim() && validateModelName(meta.model).valid) {
    if (meta.provider === undefined) { reportedModel = meta.model; }
    else if (typeof meta.provider === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(meta.provider)) {
      const model = meta.model.startsWith(`${meta.provider}/`) ? meta.model : `${meta.provider}/${meta.model}`;
      if (validateModelName(model).valid) { reportedModel = model; }
    }
  }
  return { ...(usage ? { usage } : {}), contextUsage,
    ...(tokenCount(meta.contextTokens) && meta.contextTokens > 0 ? { contextWindow: meta.contextTokens } : {}),
    ...(reportedModel ? { reportedModel } : {}),
  };
}
