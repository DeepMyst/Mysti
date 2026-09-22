/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { validForegroundRequestId } from './ForegroundRequest';

/** Bind routing to the host's webview identity, including before initialState. */
export function bindIncomingMessage(message: unknown, panelId: string): (Record<string, unknown> & {
  type: string; panelId: string;
}) | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) { return null; }
  if (!('type' in message) || typeof message.type !== 'string') { return null; }
  if ('requestId' in message && !validForegroundRequestId(message.requestId)) { return null; }
  return { ...message, type: message.type, panelId };
}
