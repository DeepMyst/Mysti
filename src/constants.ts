/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
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
 * Conversation history constants
 */
export const MAX_CONVERSATION_MESSAGES = 10; // Maximum messages to include in history
