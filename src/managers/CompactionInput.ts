/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { Conversation, Message } from '../types';

/** A summary may replace only the exact history it read, even without a run owner. */
export function captureCompactionInput(conversation: Conversation, isCurrent: () => boolean) {
  const source = conversation.messages;
  const conversationId = conversation.id;
  // Stored messages are JSON data. Capture every field, including tool segments,
  // thinking and attachments, so an in-place update also invalidates the commit.
  const encoded = JSON.stringify(source);
  const messages = JSON.parse(encoded) as Message[];
  return {
    messages,
    canCommit(): boolean {
      if (!isCurrent() || conversation.id !== conversationId || conversation.messages !== source) { return false; }
      try { return JSON.stringify(source) === encoded; }
      catch { return false; }
    },
  };
}
