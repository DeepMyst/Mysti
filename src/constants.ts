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
 */

import type { ProviderType } from './types';

/**
 * Provider defaults (Plan 02 Phase 2, C5)
 *
 * The single fallback provider id used wherever a provider can't be resolved
 * from settings or the registry. Replaces scattered 'claude-code' literals in
 * ChatViewProvider/ProviderManager — change the default in exactly one place.
 */
export const DEFAULT_PROVIDER: ProviderType = 'claude-code';

/**
 * Last-resort model id used only when no panel/default model is configured.
 * Replaces scattered 'claude-sonnet-4-5-20250929' literals. Per-provider
 * defaults still come from each ProviderConfig.defaultModel.
 */
export const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Process management constants
 */
export const PROCESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const PROCESS_KILL_GRACE_PERIOD_MS = 5000; // 5 seconds
export const PROCESS_FORCE_KILL_TIMEOUT_MS = 10000; // 10 seconds for final force kill

/**
 * Authentication and setup constants
 */
export const AUTH_POLL_INTERVAL_MS = 2000; // 2 seconds
export const AUTH_POLL_MAX_ATTEMPTS = 60; // 2 minutes total (60 * 2s)

/**
 * Permission system constants
 */
export const PERMISSION_DEFAULT_TIMEOUT_S = 30; // 30 seconds
export const PERMISSION_MAX_TIMEOUT_S = 300; // 5 minutes

/**
 * Semi-autonomous mode constants
 */
export const SEMI_AUTONOMOUS_DEFAULT_TIMEOUT_S = 60; // 60 seconds before AI decides
export const SEMI_AUTONOMOUS_MIN_TIMEOUT_S = 10;
export const SEMI_AUTONOMOUS_MAX_TIMEOUT_S = 300; // 5 minutes

/**
 * Conversation history constants
 */
export const MAX_CONVERSATION_MESSAGES = 10; // Maximum messages to include in history

/**
 * Autonomous mode constants
 */
export const AUTONOMOUS_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
export const AUTONOMOUS_MAX_SESSION_HOURS = 24;
export const AUTONOMOUS_DEFAULT_MAX_MEMORY_ENTRIES = 500;
export const AUTONOMOUS_MEMORY_DECAY_FACTOR = 0.95; // Confidence decay per day
export const AUTONOMOUS_MIN_CONFIDENCE_THRESHOLD = 0.6;
export const AUTONOMOUS_AUDIT_LOG_MAX_ENTRIES = 1000;
export const AUTONOMOUS_CONTINUATION_DELAY_MS = 2000; // Delay between auto-continuations
export const AUTONOMOUS_PROCESS_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours for autonomous sessions
export const AUTONOMOUS_MEMORY_SYNC_INTERVAL_MS = 5 * 60 * 1000; // Sync memory to files every 5 min

/**
 * Installation system constants
 */
export const INSTALL_TIMEOUT_MS = 120_000;              // 2 minutes for npm install
export const INSTALL_MAX_RETRIES = 2;                   // Retry once on transient failures
export const INSTALL_RETRY_DELAY_MS = 3_000;            // 3 seconds between retries
export const NPM_CACHE_TTL_MS = 5 * 60 * 1000;         // 5 minutes (replaces permanent cache)
export const NETWORK_CHECK_TIMEOUT_MS = 10_000;         // 10 seconds for npm ping
export const MIN_NODE_VERSION = 18;                     // Minimum supported Node.js version
export const LOCAL_CLI_PREFIX = '.mysti/cli';            // Fallback user-local install prefix

/**
 * Sub-agent (mention routing) constants
 */
export const SUBAGENT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour for sub-agent tasks
export const SUBAGENT_MAX_RETRIES = 1;             // Auto-retry once, then manual
export const SUBAGENT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to answer sub-agent question
export const MAX_MENTIONS_PER_MESSAGE = 5;         // Maximum @-mentions per user message

/**
 * Brainstorm mode constants
 */
export const BRAINSTORM_SILENCE_TIMEOUT_MS = 90 * 1000; // 90s silence before aborting an agent stream

/**
 * Compaction system constants
 */
export const COMPACTION_DEFAULT_THRESHOLD_PERCENT = 75;
export const COMPACTION_COOLDOWN_MS = 30_000; // Minimum 30s between compactions
export const COMPACTION_MIN_MESSAGES_BEFORE_COMPACT = 4; // Don't compact if fewer than 4 messages
export const COMPACTION_MESSAGES_TO_PRESERVE = 4; // Keep last N messages uncompacted
export const COMPACTION_SUMMARY_MAX_TOKENS = 2000; // Target token count for client summaries

/**
 * Smart compaction constants (Plan 08, DeepMyst-gated).
 */
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;          // Anthropic default ephemeral (5-min) cache window
export const SMART_CRITICAL_FILL_PERCENT = 90;             // Compact regardless of cache warmth above this fill
export const SMART_MIN_SUMMARY_TOKENS = 5000;             // Floor so the compacted prefix stays cacheable (Opus/Haiku min 4096)
export const SMART_DEFAULT_REMAINING_TURNS = 6;           // Default N estimate for the economic gate
export const SMART_DEFAULT_CHEAP_MODEL = 'claude-haiku-4-5'; // DeepMyst gateway cheap compactor model
export const SMART_GATEWAY_DEFAULT_URL = 'https://gateway.v2.deepmyst.com';
export const SMART_ENTITLEMENT_TTL_MS = 5 * 60 * 1000;    // Re-check entitlement at most every 5 min
export const RETRIEVAL_MAX_WORKERS = 4;                   // Concurrency cap for parallel relevance scorers
export const RETRIEVAL_CHUNK_TARGET_TOKENS = 7000;        // Target tokens per history chunk
export const RETRIEVAL_TOP_K = 5;                         // Snippets kept after the reduce step
export const RETRIEVAL_SNIPPET_TOKEN_BUDGET = 1500;       // Hard token budget for the retrieved-context suffix
export const RETRIEVAL_DEDUP_SIMILARITY = 0.8;            // Jaccard threshold for near-duplicate snippet dedup

/**
 * Agent lifecycle management constants
 */
export const LIFECYCLE_DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;    // 1 hour
export const LIFECYCLE_CHECK_INTERVAL_MS = 30 * 1000;                // 30 seconds
export const LIFECYCLE_PROCESS_SCAN_TIMEOUT_MS = 3000;               // 3s for pgrep/wmic

/**
 * OpenClaw Gateway constants
 */
export const OPENCLAW_GATEWAY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes overall gateway timeout

/**
 * Manus API constants
 */
export const MANUS_API_BASE_URL = 'https://api.manus.im';
export const MANUS_POLL_INTERVAL_MS = 3000; // 3 seconds between status polls

/**
 * Model registry constants (Plan 01 — automatic model updates)
 *
 * The fallback model id itself lives in DEFAULT_FALLBACK_MODEL (declared near
 * the provider defaults above). The TTLs/timeouts govern the dynamic discovery
 * + curated-feed refresh paths added in later phases; in Phase 1 the registry's
 * refresh() is a no-op and these are unused but declared so the service surface
 * is stable for consumers.
 */
export const MODEL_DISCOVERY_TIMEOUT_MS = 5000;                 // hard cap per discovery probe
export const MODEL_CACHE_TTL_CLI_MS = 24 * 60 * 60 * 1000;     // 24h for CLI-derived lists
export const MODEL_CACHE_TTL_LOCAL_MS = 5 * 60 * 1000;          // 5min for local servers (Ollama/LocalAI)
export const MODEL_CURATED_FEED_TTL_MS = 24 * 60 * 60 * 1000;  // 24h for the remote curated feed
export const MODEL_CUSTOM_MAX_PER_PROVIDER = 50;               // hard cap on user custom models per provider

/**
 * Visual testing constants
 */
export const VISUAL_TEST_MAX_ITERATIONS = 5;
export const VISUAL_TEST_ITERATION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes per iteration
export const VISUAL_TEST_TOTAL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes total
export const VISUAL_TEST_SERVER_STARTUP_TIMEOUT_MS = 30 * 1000; // 30 seconds
export const VISUAL_TEST_SERVER_HEALTH_POLL_MS = 500;
export const VISUAL_TEST_SCREENSHOT_WAIT_MS = 1000; // Wait for page to settle before screenshot
export const VISUAL_TEST_SERVER_KILL_GRACE_MS = 5000; // 5 seconds before SIGKILL
export const VISUAL_TEST_HOT_RELOAD_WAIT_MS = 2000; // Wait for hot-reload after code changes
export const VISUAL_TEST_DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/**
 * Canvas constants
 */
export const CANVAS_AUTOSAVE_DEBOUNCE_MS = 500;
export const CANVAS_MAX_VARIANTS = 4;
export const CANVAS_IMAGE_QUALITY = 0.9;
export const CANVAS_MAX_ASSET_SIZE_MB = 10;
export const CANVAS_DIR = '.mysti/canvas';
export const CANVAS_ASSETS_DIR = '.mysti/canvas/assets';
export const CANVAS_RENDER_TIMEOUT_MS = 30_000;
export const CANVAS_RENDER_DEFAULT_VIEWPORT = { width: 1280, height: 800 };
export const CANVAS_VIDEO_POLL_INTERVAL_MS = 3_000;
// F-25: Sora/Veo generations frequently exceed 2 minutes; allow 10 minutes.
export const CANVAS_VIDEO_POLL_MAX_MS = 600_000;
export const CANVAS_VIDEO_DEFAULT_DURATION_S = 8; // Veo accepts 4, 6, or 8 only
export const CANVAS_BATCH_CONCURRENCY = 3;
export const CANVAS_ASSET_REF_PREFIX = 'asset://';
export const CANVAS_CODE_DEFAULT_FRAMEWORK = 'react';
export const CANVAS_CODE_OUTPUT_DIR = 'src/components';

/**
 * Code-checkpoint constants (shadow git repo for "rewind code to here").
 *
 * The shadow repo's git-dir lives under the extension's globalStorage (never
 * inside the workspace, so it can't pollute the user's own .git), while its
 * work-tree is the workspace root. CHECKPOINTS_DIR is the globalStorage
 * subdirectory; per-workspace repos are keyed by a hash of the root path.
 */
export const CHECKPOINTS_DIR = 'checkpoints';
export const CHECKPOINT_AUTHOR_NAME = 'Mysti Checkpoints';
export const CHECKPOINT_AUTHOR_EMAIL = 'checkpoints@mysti.local';
/** Default cap on tracked+untracked files before a snapshot is skipped (huge-repo guard). */
export const CHECKPOINT_DEFAULT_MAX_FILES = 20000;
/** Timeout for a single shadow-git command. */
export const CHECKPOINT_GIT_TIMEOUT_MS = 30_000;

/**
 * Google Stitch constants
 */
export const STITCH_API_TIMEOUT_MS = 120_000;
export const STITCH_DEFAULT_DEVICE_TYPE = 'DESKTOP';
export const STITCH_DEFAULT_VARIANT_COUNT = 3;
export const STITCH_PROJECT_NAME_PREFIX = 'mysti-canvas-';
export const STITCH_DEVICE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  DESKTOP: { width: 1440, height: 900 },
  MOBILE: { width: 375, height: 812 },
  TABLET: { width: 768, height: 1024 },
  AGNOSTIC: { width: 1200, height: 800 },
};
