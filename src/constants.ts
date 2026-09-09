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

import type { ProviderType, PseudoAgentType, AgentSelection } from './types';

/**
 * Provider defaults (Plan 02 Phase 2, C5)
 *
 * The single fallback provider id used wherever a provider can't be resolved
 * from settings or the registry. Replaces scattered 'claude-code' literals in
 * ChatViewProvider/ProviderManager — change the default in exactly one place.
 */
export const DEFAULT_PROVIDER: ProviderType = 'claude-code';

/**
 * Plan 25: the agent SELECTION defaults (what the user talks to), which is not
 * the same thing as DEFAULT_PROVIDER (the CLI backend a pseudo-agent delegates
 * to, and the registry rescue in ProviderManager._getActiveProvider — that one
 * must stay a REGISTERED provider id or an unknown-provider fallback throws).
 */
export const PSEUDO_AGENT_IDS: readonly PseudoAgentType[] = ['mysti', 'brainstorm'];

/** True for a selectable agent that has no registered provider behind it. */
export function isPseudoAgentId(id: string | undefined): id is PseudoAgentType {
  return !!id && (PSEUDO_AGENT_IDS as readonly string[]).includes(id);
}

/** Fallback agent selection when `mysti.defaultAgent` is unset/invalid. */
export const DEFAULT_AGENT: AgentSelection = 'mysti';

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
// Plan 18 (4.2, W4 review): inactivity bound for an OPEN stdout stream. Must be
// far more generous than PROCESS_TIMEOUT_MS — stream-json CLIs legitimately
// emit NOTHING between a tool_use start and its tool_result (long test runs,
// builds), so a 5-min inter-chunk kill would murder approved work mid-tool.
// 30 min of zero stdout+stderr is a wedge, not a quiet tool.
export const STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
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
/**
 * How long a prompt cache stays live — the staleness bound on "the last turn hit
 * cache, so caching is working here".
 *
 * One hour, not the 5 minutes this used to say. Claude Code writes its prefix
 * with the 1-hour TTL (which is why a cache WRITE costs 2x input rather than
 * 1.25x, and why BoostManager's cold-resume trap is keyed to an hour of idle) —
 * so a 5-minute window declared a still-live cache COLD after five minutes and
 * handed SmartCompactor a green light to compact it away.
 *
 * The two errors are not symmetric, which settles the direction to round in:
 * too SHORT destroys a warm cache and pays full price to rebuild it, while too
 * LONG merely defers a compaction that the 90% critical-fill override forces
 * anyway. Prefer the long side.
 */
export const PROMPT_CACHE_TTL_MS = 60 * 60 * 1000;
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
export const MODEL_DISCOVERY_MAX_PER_PROVIDER = 250;            // hard cap on models persisted per provider from one discovery probe

/**
 * New-model announcements (model release notifications).
 *
 * MODEL_SEEN_MAX_PER_PROVIDER bounds the "ids we have already shown the user"
 * set. It is deliberately larger than MODEL_DISCOVERY_MAX_PER_PROVIDER so a
 * provider at the discovery cap still has headroom for ids that have since
 * rotated out — trimming the seen-set is what would cause a stale id to be
 * re-announced as "new", so the cap must not bite in normal operation.
 *
 * MODEL_ANNOUNCE_MAX_PENDING bounds the cards the UI can accumulate. A backend
 * that publishes a large catalog in one go (OpenRouter) must not be able to
 * bury the panel; the newest N survive and the rest are silently marked seen.
 */
export const MODEL_SEEN_MAX_PER_PROVIDER = 400;
export const MODEL_ANNOUNCE_MAX_PENDING = 12;

/**
 * How recent a model's `releasedAt` must be to announce through a provider's
 * FIRST (otherwise silent) reconcile. Bounds the one-off case where a model
 * ships in the same build that first baselines its provider: inside the window
 * it is news, outside it is just part of the catalogue.
 */
export const MODEL_ANNOUNCE_FRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * CLI update checking (Plan 28). The check is a network read of the npm
 * registry, so it is cached hard: 24h between checks, 8s per probe. Nothing is
 * ever installed automatically — the check only decides whether to show a card.
 */
export const CLI_UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;     // 24h between npm registry checks
export const CLI_UPDATE_PROBE_TIMEOUT_MS = 8000;                // hard cap per `npm view` probe
export const CLI_UPDATE_STAGGER_MS = 600;                       // spacing between per-provider probes

/**
 * Delay between activate() returning and the automatic background model-list
 * warm-up (Plan 01 Phase 3). The warm-up additionally waits for provider
 * initialization to settle, so this is a floor, not a guess: it keeps the
 * discovery probes clear of the startup CLI-discovery burst on fast machines
 * while `providerManager.whenReady` covers the slow ones.
 */
export const MODEL_REFRESH_WARMUP_DELAY_MS = 8000;

/**
 * Visual testing constants
 */
// (The former iteration/total/hot-reload timeouts belonged to the deleted
// screenshot->analyze->fix loop; the warm session is bounded by
// VISUAL_SESSION_IDLE_MS and the caller's own per-run budget instead.)
export const VISUAL_TEST_SERVER_STARTUP_TIMEOUT_MS = 30 * 1000; // 30 seconds
export const VISUAL_TEST_SERVER_HEALTH_POLL_MS = 500;
export const VISUAL_TEST_SCREENSHOT_WAIT_MS = 1000; // Wait for page to settle before screenshot
export const VISUAL_TEST_SERVER_KILL_GRACE_MS = 5000; // 5 seconds before SIGKILL

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

// ── Agent-callable visual observation (the `look` / `act` primitive) ──
/** Idle lifetime of a warm visual session (dev server + browser) before it is torn down. */
export const VISUAL_SESSION_IDLE_MS = 10 * 60 * 1000; // 10 minutes
/** Hard cap on actions in a single `act` call. */
export const VISUAL_MAX_ACTIONS_PER_ACT = 8;
/** Ring-buffer sizes for the per-look console/network capture. */
export const VISUAL_CONSOLE_BUFFER = 50;
export const VISUAL_NETWORK_BUFFER = 30;
/** Total character cap on the observation digest fed back to the model. */
export const VISUAL_DIGEST_MAX_CHARS = 8000;
/** Cap on the DOM outline section inside the digest. */
export const VISUAL_DOM_OUTLINE_MAX_CHARS = 3000;
/** Bounded settle wait after `load` before a capture (networkidle never fires against HMR). */
export const VISUAL_SETTLE_TIMEOUT_MS = 3000;
/** Maximum characters a model may put in a `type` interaction. */
export const VISUAL_MAX_TYPE_LENGTH = 4096;
/** Input-length caps for model-supplied strings (the policy resolver enforces these). */
export const VISUAL_MAX_PATH_LENGTH = 512;
export const VISUAL_MAX_SELECTOR_LENGTH = 200;
export const VISUAL_MAX_FOCUS_LENGTH = 500;
/** Cap on a user-supplied dev-server ready pattern, so a repo cannot inject a catastrophic regex. */
export const VISUAL_MAX_READY_PATTERN_LENGTH = 200;
/** Ring-buffer cap on captured dev-server stdout/stderr. */
export const VISUAL_DEVSERVER_LOG_MAX_CHARS = 64 * 1024;
/** Loopback-only default allowlist. A browser that can reach arbitrary hosts is an exfiltration channel. */
export const VISUAL_DEFAULT_ALLOWED_ORIGINS = ['http://localhost', 'http://127.0.0.1', 'http://[::1]'];
