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
export const SUBAGENT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes for sub-agent tasks
export const SUBAGENT_MAX_RETRIES = 1;             // Auto-retry once, then manual

/**
 * Compaction system constants
 */
export const COMPACTION_DEFAULT_THRESHOLD_PERCENT = 75;
export const COMPACTION_COOLDOWN_MS = 30_000; // Minimum 30s between compactions
export const COMPACTION_MIN_MESSAGES_BEFORE_COMPACT = 4; // Don't compact if fewer than 4 messages
export const COMPACTION_MESSAGES_TO_PRESERVE = 4; // Keep last N messages uncompacted
export const COMPACTION_SUMMARY_MAX_TOKENS = 2000; // Target token count for client summaries

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
