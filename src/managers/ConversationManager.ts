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

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as zlib from 'zlib';
import type { Conversation, Message, MessageSegment, MessageThinking, ContextItem, Attachment, OperationMode, ProviderType, AgentConfiguration, ToolCall } from '../types';
import { PROVIDER_DISPLAY_META } from '../providers/base/ProviderManifest';

/**
 * Cap (in characters) for each persisted tool input string field and tool
 * output, applied in addMessageToConversation.
 *
 * Stopgap: tool calls can carry very large inputs (e.g. a Write tool's full
 * file content) and results; persisting them verbatim would bloat
 * globalState, which round-trips through extension-host JSON storage on
 * every save. Plan 03 Phase 6 redesigns conversation storage (moving large
 * payloads out of globalState) — until then anything over this cap is cut
 * and the ToolCall is flagged `truncated: true`.
 */
export const PERSISTED_TOOL_STRING_CAP = 4096;

/**
 * Hard ceiling for a whole serialized tool input after per-field truncation
 * (guards against bloat hiding in nested objects/arrays). When exceeded, the
 * input is replaced by a `{ _preview }` stub.
 */
const PERSISTED_TOOL_INPUT_MAX_JSON = PERSISTED_TOOL_STRING_CAP * 4;

/** globalState key holding the persisted conversation store. */
const CONVERSATIONS_KEY = 'mysti.conversations';

/**
 * Schema version stamped into the persisted conversation blob.
 *
 * Modelled on `ARTIFACT_SCHEMA_VERSION` (ArtifactStore), for the same reason:
 * a blob carrying a HIGHER version was written by a newer Mysti and is refused
 * loudly — neither read nor overwritten — rather than half-read, so a
 * downgrade cannot destroy history. A blob carrying NO stamp predates this
 * change (v0.4.0 and earlier) and is accepted as version 1: the shape is
 * unchanged, only the stamp is new. Without this stamp there is no safe way to
 * ever change the format again.
 */
export const CONVERSATIONS_SCHEMA_VERSION = 1;

/**
 * Prefix for the key an unreadable blob is parked under. Losing chat history
 * silently is nearly as bad as crashing, so the original bytes are kept.
 */
const CONVERSATIONS_CORRUPT_KEY_PREFIX = 'mysti.conversations.corrupt.';

/**
 * Shareable deep-link bounds. `exportToShareable` emits at most
 * SHAREABLE_MESSAGE_LIMIT messages of SHAREABLE_CONTENT_CAP chars each and a
 * title of at most SHAREABLE_TITLE_CAP chars;
 * `importFromShareable` — reachable from the UNAUTHENTICATED
 * `vscode://…/import?data=…` handler — enforces the same bounds on the way
 * in, and refuses to inflate a payload past SHAREABLE_INFLATED_MAX_BYTES
 * (a URI-sized deflate stream can expand ~1000×; the bound is ~50× a
 * maximal legitimate export, so it never trips on a real link).
 */
export const SHAREABLE_MESSAGE_LIMIT = 10;
export const SHAREABLE_CONTENT_CAP = 2000;
export const SHAREABLE_TITLE_CAP = 200;
export const SHAREABLE_INFLATED_MAX_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Optional render-relevant structure persisted with a message
 * (Plan 02 Phase 3 — see the Message anatomy block in types.ts).
 */
export interface MessagePersistExtras {
  provider?: ProviderType;
  model?: string;
  toolCalls?: ToolCall[];
  segments?: MessageSegment[];
}

/**
 * A detached copy for parking. The stored value came from JSON, so a JSON round
 * trip is faithful; if it somehow is not serialisable, keeping the live object
 * is still better than keeping nothing.
 */
function snapshotForPark(raw: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(raw));
  } catch {
    return raw;
  }
}

export class ConversationManager {
  private _conversations: Map<string, Conversation> = new Map();
  private _currentConversationId: string | null = null;
  private _extensionContext: vscode.ExtensionContext;
  private _onTitleGenerated?: (conversationId: string, title: string) => void;
  /**
   * Set when the stored blob could not be read in full. Non-null means the
   * user has history that this build did not load; surfaced through
   * {@link getLoadDiagnostic} so a UI layer can show it without re-deriving it.
   */
  private _loadDiagnostic: string | null = null;
  /**
   * True when this instance must NOT write the store: either the stored blob
   * was written by a newer Mysti (overwriting it would destroy that history)
   * or globalState could not be read at all (so we do not know what we would
   * be overwriting).
   */
  private _persistenceDisabled = false;
  /** One notification per instance — a broken store must not spam toasts. */
  private _notifiedLoadFailure = false;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._loadConversations();

    // Create initial conversation if none exists
    if (this._conversations.size === 0) {
      this.createNewConversation();
    }
  }

  public getCurrentConversation(): Conversation | null {
    if (!this._currentConversationId) {
      return null;
    }
    return this._conversations.get(this._currentConversationId) || null;
  }

  public getConversation(id: string): Conversation | null {
    return this._conversations.get(id) || null;
  }

  public getAllConversations(): Conversation[] {
    return Array.from(this._conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public createNewConversation(): Conversation {
    const config = vscode.workspace.getConfiguration('mysti');

    const conversation: Conversation = {
      id: this._generateId(),
      title: 'New Conversation',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: config.get('defaultMode', 'ask-before-edit') as OperationMode,
      model: config.get('defaultModel', 'claude-sonnet-4-5-20250929'),
      // Validated like the import path: a repo-supplied non-enum value must
      // not become the first persisted conversation's provider.
      provider: this._coerceProvider(config.get<string>('defaultProvider', 'claude-code'))
    };

    this._conversations.set(conversation.id, conversation);
    this._currentConversationId = conversation.id;
    this._saveConversations();

    return conversation;
  }

  public switchConversation(id: string): boolean {
    if (this._conversations.has(id)) {
      this._currentConversationId = id;
      return true;
    }
    return false;
  }

  /**
   * Fork a conversation at a given message: create a NEW conversation
   * containing a deep copy of every message up to AND including `messageId`.
   * The original conversation is left untouched. Cloned messages keep their
   * `checkpoint` refs (the shadow-repo commits still exist), so a forked
   * branch can still rewind code. Does NOT switch the current conversation —
   * the caller (per-panel handler) decides whether to activate the fork.
   * Returns the new conversation, or null if the source/message is not found.
   */
  public forkConversation(conversationId: string, messageId: string): Conversation | null {
    const source = this._conversations.get(conversationId);
    if (!source) {
      return null;
    }

    const cutoff = source.messages.findIndex(m => m.id === messageId);
    if (cutoff === -1) {
      return null;
    }

    const now = Date.now();
    const fork: Conversation = {
      id: this._generateId(),
      title: `${source.title} (fork)`,
      // Deep copy so edits to the fork never mutate the original's messages.
      messages: source.messages.slice(0, cutoff + 1).map(m => this._cloneMessage(m)),
      createdAt: now,
      updatedAt: now,
      mode: source.mode,
      model: source.model,
      provider: source.provider,
      agentConfig: source.agentConfig ? { ...source.agentConfig } : undefined
    };

    this._conversations.set(fork.id, fork);
    this._saveConversations();
    return fork;
  }

  /** Structured deep copy of a message (safe to mutate on a forked branch). */
  private _cloneMessage(m: Message): Message {
    // Normalized on the way in: a fork of a conversation that predates the
    // store-side guard must not duplicate its oversized payloads.
    return this._normalizeMessageForStorage({
      ...m,
      context: m.context ? m.context.map(c => ({ ...c })) : undefined,
      attachments: m.attachments ? m.attachments.map(a => ({ ...a })) : undefined,
      toolCalls: m.toolCalls ? m.toolCalls.map(t => ({ ...t })) : undefined,
      segments: m.segments ? m.segments.map(s => ({ ...s })) : undefined,
      checkpoint: m.checkpoint ? { ...m.checkpoint } : undefined
    });
  }

  public deleteConversation(id: string): boolean {
    if (this._conversations.has(id)) {
      this._conversations.delete(id);

      // If we deleted the current conversation, switch to another or create new
      if (this._currentConversationId === id) {
        const remaining = Array.from(this._conversations.keys());
        if (remaining.length > 0) {
          this._currentConversationId = remaining[0];
        } else {
          this.createNewConversation();
        }
      }

      this._saveConversations();
      return true;
    }
    return false;
  }

  /**
   * Set callback for when a conversation title is generated
   */
  public setTitleCallback(callback: (conversationId: string, title: string) => void) {
    this._onTitleGenerated = callback;
  }

  /**
   * Update conversation title (used for AI-generated titles)
   */
  public updateConversationTitle(conversationId: string, title: string): boolean {
    const conversation = this._conversations.get(conversationId);
    if (conversation) {
      conversation.title = title;
      conversation.updatedAt = Date.now();
      this._saveConversations();
      this._onTitleGenerated?.(conversationId, title);
      return true;
    }
    return false;
  }

  /**
   * Check if this is the first user message in a conversation
   */
  public isFirstUserMessage(conversationId: string): boolean {
    const conversation = this._conversations.get(conversationId);
    if (!conversation) {return false;}
    const userMessages = conversation.messages.filter(m => m.role === 'user');
    return userMessages.length === 1;
  }

  public addMessage(
    role: 'user' | 'assistant' | 'system',
    content: string,
    context?: ContextItem[],
    thinking?: string
  ): Message {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      throw new Error('No active conversation');
    }

    const message: Message = {
      id: this._generateId(),
      role,
      content,
      timestamp: Date.now(),
      context,
      thinking
    };

    conversation.messages.push(message);
    conversation.updatedAt = Date.now();

    // Note: Title generation is now handled externally via AI
    // The title will be updated via updateConversationTitle() after AI generates it

    this._saveConversations();
    return message;
  }

  /**
   * Add a message to a specific conversation by ID
   * Used for per-panel message routing
   *
   * `thinking` accepts the legacy plain string or the structured
   * { style, content } shape; `extras` carries the Plan 02 Phase 3
   * render-relevant structure (provider/model/toolCalls/segments). Tool
   * inputs/outputs are truncated to PERSISTED_TOOL_STRING_CAP before
   * persisting (see the constant's comment).
   */
  public addMessageToConversation(
    conversationId: string | null | undefined,
    role: 'user' | 'assistant' | 'system',
    content: string,
    context?: ContextItem[],
    attachments?: Attachment[],
    thinking?: string | MessageThinking,
    extras?: MessagePersistExtras
  ): Message {
    // Get the specific conversation or fall back to current
    let conversation: Conversation | null = null;
    if (conversationId) {
      conversation = this._conversations.get(conversationId) || null;
    }
    if (!conversation) {
      conversation = this.getCurrentConversation();
    }
    if (!conversation) {
      throw new Error('No conversation available');
    }

    const message: Message = {
      id: this._generateId(),
      role,
      content,
      timestamp: Date.now(),
      context,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      thinking
    };

    if (extras) {
      if (extras.provider) { message.provider = extras.provider; }
      if (extras.model) { message.model = extras.model; }
      if (extras.toolCalls && extras.toolCalls.length > 0) { message.toolCalls = extras.toolCalls; }
      if (extras.segments && extras.segments.length > 0) { message.segments = extras.segments; }
    }

    // The storage guard runs HERE, in the store, not at the call site — see
    // _normalizeMessageForStorage.
    const stored = this._normalizeMessageForStorage(message);
    conversation.messages.push(stored);
    conversation.updatedAt = Date.now();

    this._saveConversations();
    return stored;
  }

  /**
   * The single storage guard every writer into the persisted blob passes
   * through.
   *
   * Two payloads can make `mysti.conversations` unboundedly large:
   * `Attachment.base64Data` (an unbounded base64 string) and tool
   * inputs/outputs (a Write tool carries whole files). Both guards used to
   * live at ONE call site in ChatViewProvider, which made them an invariant
   * enforced by convention — and `_importMystiJson`, the second writer,
   * bypassed both. Keeping them here means a new writer cannot forget them.
   *
   * Returns a copy; the caller-supplied message is never mutated.
   */
  private _normalizeMessageForStorage(message: Message): Message {
    const normalized: Message = { ...message };

    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      // Attachments are kept (name/type/size render the card); only the
      // base64 payload is dropped, exactly as the send path already did.
      normalized.attachments = message.attachments.map(a =>
        isRecord(a) && (a as Attachment).base64Data !== undefined
          ? { ...(a as Attachment), base64Data: undefined }
          : a
      );
    }

    if (message.toolCalls) {
      const sanitized = this._sanitizeToolCallsForStorage(
        message.toolCalls.filter(isRecord) as unknown as ToolCall[]
      );
      if (sanitized) { normalized.toolCalls = sanitized; }
      else { delete normalized.toolCalls; }
    }

    return normalized;
  }

  /**
   * Truncate large tool inputs/outputs before they reach globalState.
   *
   * Per-field rule: any top-level string value of `input` longer than
   * PERSISTED_TOOL_STRING_CAP chars is sliced to the cap; `output` likewise.
   * If the serialized input is still oversized after that (nested bloat),
   * the whole input is replaced with a `{ _preview }` stub. Any cut sets
   * `truncated: true` on the persisted ToolCall so renderers can show a
   * "truncated" hint. Stopgap until Plan 03 Phase 6 redesigns storage.
   */
  private _sanitizeToolCallsForStorage(toolCalls?: ToolCall[]): ToolCall[] | undefined {
    if (!toolCalls || toolCalls.length === 0) {
      return undefined;
    }

    return toolCalls.map(toolCall => {
      let truncated = false;

      let output = toolCall.output;
      if (typeof output === 'string' && output.length > PERSISTED_TOOL_STRING_CAP) {
        output = output.slice(0, PERSISTED_TOOL_STRING_CAP);
        truncated = true;
      }

      let input = toolCall.input;
      if (input && typeof input === 'object') {
        const capped: Record<string, unknown> = {};
        let changed = false;
        for (const [key, value] of Object.entries(input)) {
          if (typeof value === 'string' && value.length > PERSISTED_TOOL_STRING_CAP) {
            capped[key] = value.slice(0, PERSISTED_TOOL_STRING_CAP);
            truncated = true;
            changed = true;
          } else {
            capped[key] = value;
          }
        }
        try {
          const serialized = JSON.stringify(capped);
          if (serialized.length > PERSISTED_TOOL_INPUT_MAX_JSON) {
            input = { _preview: serialized.slice(0, PERSISTED_TOOL_STRING_CAP) };
            truncated = true;
          } else if (changed) {
            input = capped;
          }
        } catch {
          // Circular/unserializable input would break globalState persistence
          input = {};
          truncated = true;
        }
      }

      const sanitized: ToolCall = { ...toolCall, input, output };
      if (truncated) {
        sanitized.truncated = true;
      }
      return sanitized;
    });
  }

  public updateMessage(messageId: string, updates: Partial<Message>): boolean {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      return false;
    }

    const message = conversation.messages.find(m => m.id === messageId);
    if (message) {
      Object.assign(message, updates);
      // The store guard also covers in-place updates: `updates` can carry the
      // same two unbounded payloads a new message can.
      if (updates.attachments !== undefined || updates.toolCalls !== undefined) {
        const guarded = this._normalizeMessageForStorage(message);
        message.attachments = guarded.attachments;
        message.toolCalls = guarded.toolCalls;
      }
      conversation.updatedAt = Date.now();
      this._saveConversations();
      return true;
    }
    return false;
  }

  /**
   * Update a message in a SPECIFIC conversation (per-panel safe — unlike
   * updateMessage, which only touches the globally-current conversation).
   */
  public updateMessageInConversation(
    conversationId: string | null | undefined,
    messageId: string,
    updates: Partial<Message>
  ): boolean {
    const conversation = conversationId ? this._conversations.get(conversationId) : null;
    if (!conversation) {
      return false;
    }
    const message = conversation.messages.find(m => m.id === messageId);
    if (!message) {
      return false;
    }
    Object.assign(message, updates);
    // The store guard also covers in-place updates: `updates` can carry the
    // same two unbounded payloads a new message can.
    if (updates.attachments !== undefined || updates.toolCalls !== undefined) {
      const guarded = this._normalizeMessageForStorage(message);
      message.attachments = guarded.attachments;
      message.toolCalls = guarded.toolCalls;
    }
    conversation.updatedAt = Date.now();
    this._saveConversations();
    return true;
  }

  public getMessages(): Message[] {
    const conversation = this.getCurrentConversation();
    return conversation ? conversation.messages : [];
  }

  public clearMessages() {
    const conversation = this.getCurrentConversation();
    if (conversation) {
      conversation.messages = [];
      conversation.updatedAt = Date.now();
      this._saveConversations();
    }
  }

  public updateConversationSettings(settings: {
    mode?: OperationMode;
    model?: string;
    provider?: ProviderType;
  }) {
    const conversation = this.getCurrentConversation();
    if (conversation) {
      if (settings.mode) {conversation.mode = settings.mode;}
      if (settings.model) {conversation.model = settings.model;}
      if (settings.provider) {conversation.provider = settings.provider;}
      conversation.updatedAt = Date.now();
      this._saveConversations();
    }
  }

  /**
   * Update agent configuration for a conversation
   */
  public updateAgentConfig(conversationId: string, config: AgentConfiguration): boolean {
    const conversation = this._conversations.get(conversationId);
    if (conversation) {
      conversation.agentConfig = config;
      conversation.updatedAt = Date.now();
      this._saveConversations();
      return true;
    }
    return false;
  }

  /**
   * Get agent configuration for a conversation
   * Returns undefined if not configured (default behavior)
   */
  public getAgentConfig(conversationId: string): AgentConfiguration | undefined {
    return this._conversations.get(conversationId)?.agentConfig;
  }

  /**
   * Clear agent configuration for a conversation (reset to defaults)
   */
  public clearAgentConfig(conversationId: string): boolean {
    const conversation = this._conversations.get(conversationId);
    if (conversation) {
      delete conversation.agentConfig;
      conversation.updatedAt = Date.now();
      this._saveConversations();
      return true;
    }
    return false;
  }

  /**
   * Export a conversation as Markdown with Mysti attribution watermark.
   * Returns empty string if conversation not found.
   */
  public exportToMarkdown(conversationId: string): string {
    const conversation = this._conversations.get(conversationId);
    if (!conversation) {
      return '';
    }

    const lines: string[] = [];

    // Title header
    lines.push(`# ${conversation.title}`);
    lines.push('');

    // Metadata
    lines.push(`> Provider: ${conversation.provider} | Model: ${conversation.model}`);
    lines.push('');

    // Messages
    for (const message of conversation.messages) {
      if (message.role === 'user') {
        lines.push('### User');
      } else if (message.role === 'assistant') {
        lines.push('### Assistant');
      } else {
        lines.push(`### ${message.role}`);
      }
      lines.push('');
      lines.push(message.content);
      lines.push('');
    }

    // Footer watermark
    lines.push('---');
    lines.push('');
    lines.push('*I was Mysting — built with [Mysti](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti), the multi-agent AI coding assistant*');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Export a single message as Markdown with Mysti attribution watermark.
   * Returns empty string if message not found.
   */
  public exportMessageToMarkdown(conversationId: string, messageId: string): string {
    const conversation = this._conversations.get(conversationId);
    if (!conversation) {
      return '';
    }

    const message = conversation.messages.find(m => m.id === messageId);
    if (!message) {
      return '';
    }

    const lines: string[] = [];

    // Message header
    if (message.role === 'user') {
      lines.push('### User');
    } else if (message.role === 'assistant') {
      lines.push('### Assistant');
    } else {
      lines.push(`### ${message.role}`);
    }
    lines.push('');
    lines.push(message.content);
    lines.push('');

    // Footer watermark
    lines.push('---');
    lines.push('');
    lines.push('*I was Mysting — built with [Mysti](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti), the multi-agent AI coding assistant*');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Export a conversation as a full-fidelity .mysti.json file.
   * Returns the JSON string for the conversation.
   */
  public exportToJson(conversationId: string): string {
    const conversation = this._conversations.get(conversationId);
    if (!conversation) {
      return '';
    }
    const exportData = {
      format: 'mysti',
      version: 1,
      exportedAt: Date.now(),
      conversation: {
        ...conversation,
        messages: conversation.messages.map(m => ({
          ...m,
          // Strip large base64 data from attachments
          attachments: m.attachments?.map(a => ({ ...a, base64Data: undefined }))
        }))
      }
    };
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import a conversation from file content. Auto-detects format:
   * - .mysti.json: Full Mysti conversation format
   * - .jsonl: OpenClaw JSONL format (best-effort)
   * - Generic .json with messages[] array
   * Returns the imported conversation or null on failure.
   */
  public importFromContent(content: string, fileName: string): Conversation | null {
    try {
      if (fileName.endsWith('.jsonl')) {
        return this._importFromJsonl(content);
      }

      const parsed = JSON.parse(content);

      // Mysti format
      if (parsed.format === 'mysti' && parsed.conversation) {
        return this._importMystiJson(parsed.conversation);
      }

      // Generic messages array
      if (parsed.messages && Array.isArray(parsed.messages)) {
        return this._importGenericJson(parsed);
      }

      // Try as conversation object directly
      if (parsed.id && parsed.title && Array.isArray(parsed.messages)) {
        return this._importMystiJson(parsed);
      }

      console.log('[Mysti] Import: Unrecognized format');
      return null;
    } catch (error) {
      console.error('[Mysti] Import failed:', error);
      return null;
    }
  }

  private _importMystiJson(data: Partial<Conversation>): Conversation | null {
    const conversation: Conversation = {
      id: this._generateId(),
      title: data.title || 'Imported Conversation',
      // Imported messages go through the SAME storage guard as sent ones:
      // the file is untrusted and can carry a megabyte of base64 or an
      // uncapped tool payload straight into globalState.
      messages: (Array.isArray(data.messages) ? data.messages : [])
        .filter(isRecord)
        .map(m => this._normalizeMessageForStorage({
          id: m.id || this._generateId(),
          role: m.role || 'assistant',
          content: m.content || '',
          timestamp: m.timestamp || Date.now(),
          context: m.context,
          attachments: m.attachments,
          thinking: m.thinking,
          toolCalls: m.toolCalls
        })),
      createdAt: data.createdAt || Date.now(),
      updatedAt: Date.now(),
      mode: data.mode || 'ask-before-edit',
      model: data.model || 'unknown',
      // Never persist a provider id that is not a ProviderType (the old
      // fallback wrote the literal 'imported', which no consumer handles).
      provider: this._coerceProvider(data.provider),
      agentConfig: data.agentConfig
    };

    this._conversations.set(conversation.id, conversation);
    this._currentConversationId = conversation.id;
    this._saveConversations();
    return conversation;
  }

  private _importGenericJson(data: { messages: Array<{ role?: string; content?: string }> }): Conversation | null {
    const messages: Message[] = data.messages.map(m => ({
      id: this._generateId(),
      role: (m.role === 'user' || m.role === 'assistant' || m.role === 'system') ? m.role : 'assistant',
      content: m.content || '',
      timestamp: Date.now()
    }));

    const conversation: Conversation = {
      id: this._generateId(),
      title: 'Imported Conversation',
      messages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'ask-before-edit' as OperationMode,
      model: 'unknown',
      provider: 'claude-code' as ProviderType
    };

    this._conversations.set(conversation.id, conversation);
    this._currentConversationId = conversation.id;
    this._saveConversations();
    return conversation;
  }

  /**
   * Export conversation as a compact base64 string for deep link sharing.
   * Compresses with zlib to keep URIs small. Only includes last 10 messages.
   */
  public exportToShareable(conversationId: string): string {
    const conversation = this._conversations.get(conversationId);
    if (!conversation) {
      return '';
    }
    const shareData = {
      // Same cap the importer enforces, so import(export(c)) is lossless.
      t: conversation.title.slice(0, SHAREABLE_TITLE_CAP),
      p: conversation.provider,
      m: conversation.messages.slice(-SHAREABLE_MESSAGE_LIMIT).map(m => ({
        r: m.role === 'user' ? 'u' : 'a',
        c: m.content.slice(0, SHAREABLE_CONTENT_CAP),
      }))
    };
    const json = JSON.stringify(shareData);
    const compressed = zlib.deflateSync(Buffer.from(json));
    return compressed.toString('base64url');
  }

  /**
   * Import conversation from a shareable base64 deep link payload.
   */
  public importFromShareable(data: string): Conversation | null {
    try {
      const compressed = Buffer.from(data, 'base64url');
      // Bound the inflation BEFORE a single field is looked at; an oversized
      // stream throws RangeError here and lands in the catch below.
      const json = zlib.inflateSync(compressed, { maxOutputLength: SHAREABLE_INFLATED_MAX_BYTES }).toString('utf-8');
      const shareData: unknown = JSON.parse(json);
      if (!isRecord(shareData)) {
        return null;
      }

      // Same storage guard and the same caps as the export side: a bogus
      // element is dropped, an oversized one is sliced, never persisted raw.
      const rawMessages = Array.isArray(shareData.m) ? shareData.m : [];
      const messages: Message[] = rawMessages
        .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.c === 'string')
        .slice(-SHAREABLE_MESSAGE_LIMIT)
        .map(m => this._normalizeMessageForStorage({
          id: this._generateId(),
          role: m.r === 'u' ? 'user' as const : 'assistant' as const,
          content: (m.c as string).slice(0, SHAREABLE_CONTENT_CAP),
          timestamp: Date.now()
        }));

      if (messages.length === 0) {
        return null;
      }

      const conversation: Conversation = {
        id: this._generateId(),
        title: typeof shareData.t === 'string' && shareData.t.length > 0
          ? shareData.t.slice(0, SHAREABLE_TITLE_CAP)
          : 'Shared Conversation',
        messages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        mode: 'ask-before-edit' as OperationMode,
        model: 'unknown',
        // Never persist a provider id that is not a ProviderType (the link
        // is untrusted; see _coerceProvider).
        provider: this._coerceProvider(shareData.p)
      };

      this._conversations.set(conversation.id, conversation);
      this._currentConversationId = conversation.id;
      this._saveConversations();
      return conversation;
    } catch (e) {
      console.log('[Mysti] Failed to import shareable conversation:', e);
      return null;
    }
  }

  private _importFromJsonl(content: string): Conversation | null {
    const lines = content.split('\n').filter(l => l.trim());
    const messages: Message[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // OpenClaw JSONL format: { type, message, role }
        if (entry.message && entry.role) {
          messages.push({
            id: this._generateId(),
            role: entry.role === 'human' ? 'user' : entry.role === 'assistant' ? 'assistant' : 'system',
            content: typeof entry.message === 'string' ? entry.message : JSON.stringify(entry.message),
            timestamp: entry.timestamp || Date.now()
          });
        } else if (entry.content) {
          // Generic JSONL with content field
          messages.push({
            id: this._generateId(),
            role: (entry.role === 'user' || entry.role === 'assistant') ? entry.role : 'assistant',
            content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
            timestamp: entry.timestamp || Date.now()
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    if (messages.length === 0) {
      return null;
    }

    const conversation: Conversation = {
      id: this._generateId(),
      title: 'Imported Conversation',
      messages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'ask-before-edit' as OperationMode,
      model: 'unknown',
      provider: 'claude-code' as ProviderType
    };

    this._conversations.set(conversation.id, conversation);
    this._currentConversationId = conversation.id;
    this._saveConversations();
    return conversation;
  }

  private _generateId(): string {
    return randomUUID();
  }

  /** Coerce an imported/foreign provider id to a real ProviderType. */
  private _coerceProvider(candidate: unknown): ProviderType {
    if (typeof candidate === 'string'
      && Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_META, candidate)) {
      return candidate as ProviderType;
    }
    // The fallback is validated too: `mysti.defaultProvider` is window-scoped,
    // so a cloned repository's settings.json can carry any string, and VS Code
    // does not enforce declared enums at read time.
    const fallback = vscode.workspace.getConfiguration('mysti')
      .get<string>('defaultProvider', 'claude-code');
    return Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_META, fallback)
      ? fallback as ProviderType
      : 'claude-code';
  }

  /** Why the persisted store could not be read in full, or null if it was. */
  public getLoadDiagnostic(): string | null {
    return this._loadDiagnostic;
  }

  /**
   * True when this instance refuses to write the store (a newer schema, or an
   * unreadable read). The in-memory conversation still works for this session.
   */
  public isPersistenceDisabled(): boolean {
    return this._persistenceDisabled;
  }

  /**
   * Read the persisted conversation store.
   *
   * The contract, matching `ArtifactStore` and the Desk stores (the in-tree
   * templates): a store that cannot read its own bytes starts empty, KEEPS the
   * bytes it could not read, says so once, and NEVER throws toward
   * `activate()`.
   *
   * That last clause is the whole point. This runs from the constructor, which
   * `extension.ts` calls hundreds of lines before the webview provider is
   * registered — a throw here (and `new Map(x)` throws for a Record, a string,
   * or any non-pair element) means the extension does not activate at all: no
   * sidebar, no commands, no wizard, and therefore no in-product way to clear
   * the offending blob. It is permanent across reloads.
   */
  private _loadConversations(): void {
    let raw: unknown;
    try {
      raw = this._extensionContext.globalState.get<unknown>(CONVERSATIONS_KEY);
    } catch (error) {
      // We do not know what is stored, so we must not overwrite it either.
      this._persistenceDisabled = true;
      const detail = 'the saved chat history could not be read from storage';
      console.error(`[Mysti] ${detail}:`, error);
      this._loadDiagnostic = detail;
      this._notifyLoadFailure(
        `Mysti could not read your saved chat history, so it will not save this session either. Nothing has been deleted.`
      );
      return;
    }

    // Fresh install, or the key was never written.
    if (raw === undefined || raw === null) { return; }

    if (!isRecord(raw)) {
      this._parkUnreadableBlob(raw, 'the stored value is not a JSON object');
      return;
    }

    const schemaVersion = raw.schemaVersion;
    if (schemaVersion !== undefined) {
      if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
        this._parkUnreadableBlob(raw, `"schemaVersion" is not a positive integer (${JSON.stringify(schemaVersion)})`);
        return;
      }
      if (schemaVersion > CONVERSATIONS_SCHEMA_VERSION) {
        this._refuseNewerSchema(schemaVersion);
        return;
      }
    }
    // An ABSENT stamp is the v0.4.0-and-earlier shape and is read as version 1.

    if (!Array.isArray(raw.conversations)) {
      this._parkUnreadableBlob(raw, '"conversations" is not an array');
      return;
    }

    // Snapshot BEFORE validation. `_coerceStoredEntry` used to repair entries in
    // place, so the blob handed to `_parkUnreadableBlob` after the loop had
    // already had the very elements the park exists to preserve stripped out of
    // it — while the toast it raises says "Nothing was deleted".
    const snapshot = snapshotForPark(raw);

    const restored = new Map<string, Conversation>();
    let dropped = 0;
    let droppedMessages = 0;
    for (const entry of raw.conversations) {
      const coerced = this._coerceStoredEntry(entry);
      if (!coerced) { dropped++; continue; }
      droppedMessages += coerced[2];
      restored.set(coerced[0], coerced[1]);
    }

    this._conversations = restored;
    const currentId = raw.currentId;
    this._currentConversationId =
      typeof currentId === 'string' && restored.has(currentId) ? currentId : null;

    if (dropped > 0 || droppedMessages > 0) {
      const parts: string[] = [];
      if (dropped > 0) {
        parts.push(`${dropped} stored conversation ${dropped === 1 ? 'entry was' : 'entries were'} not readable`);
      }
      // Message-element drops used to be invisible: they never incremented the
      // tally, so a store whose entries were all well-formed but whose
      // `messages` arrays held scalars was silently truncated with no park, no
      // diagnostic and no warning — and the next save made the deletion
      // permanent. The pre-fix loader kept and re-persisted those elements.
      if (droppedMessages > 0) {
        parts.push(`${droppedMessages} stored message${droppedMessages === 1 ? ' was' : 's were'} not readable`);
      }
      this._parkUnreadableBlob(snapshot, parts.join(' and '));

      // Rewrite the live key from what we could read. Without this the stored
      // value stays malformed, so EVERY later activation parks another full
      // copy under a new `mysti.conversations.corrupt.<ts>` key — and nothing
      // in the extension ever enumerates or deletes those.
      void this._saveConversations();
    }
  }

  /**
   * Validate one persisted `[id, Conversation]` pair.
   *
   * Structural, not exhaustive — unrecognised fields are preserved untouched
   * (the schema version is what guards genuinely new shapes); only what a
   * consumer indexes blindly is checked or repaired.
   */
  private _coerceStoredEntry(entry: unknown): [string, Conversation, number] | null {
    if (!Array.isArray(entry) || entry.length < 2) { return null; }
    const id: unknown = entry[0];
    const value: unknown = entry[1];
    if (typeof id !== 'string' || id.length === 0) { return null; }
    if (!isRecord(value) || !Array.isArray(value.messages)) { return null; }

    // A COPY. Repairing `value` in place mutates the object the memento handed
    // back, which is the same object `_parkUnreadableBlob` is about to keep.
    const conversation = { ...value } as unknown as Conversation;
    if (typeof conversation.id !== 'string' || conversation.id.length === 0) {
      conversation.id = id;
    }
    // Renderers and the exporters walk `messages` and read `.role`/`.content`
    // off each element, so a non-object element would throw far from here.
    const source = value.messages as unknown[];
    const messages = source.filter(isRecord) as unknown as Message[];
    conversation.messages = messages;
    return [id, conversation, source.length - messages.length];
  }

  /**
   * Keep an unreadable blob instead of destroying it, and say so once.
   * The parked copy is written under its own key, so the ordinary save that
   * follows (a fresh conversation) never overwrites the only copy.
   */
  private _parkUnreadableBlob(raw: unknown, reason: string): void {
    const parkKey = `${CONVERSATIONS_CORRUPT_KEY_PREFIX}${Date.now()}`;
    console.error(
      `[Mysti] Saved chat history could not be read (${reason}); keeping the stored value under "${parkKey}".`
    );
    this._loadDiagnostic = `${reason} — the unreadable value was kept under the storage key "${parkKey}"`;
    try {
      void Promise.resolve(this._extensionContext.globalState.update(parkKey, raw))
        .then(undefined, (err: unknown) =>
          console.error('[Mysti] Failed to keep a copy of the unreadable chat history:', err));
    } catch (err) {
      console.error('[Mysti] Failed to keep a copy of the unreadable chat history:', err);
    }
    this._notifyLoadFailure(
      `Mysti could not read part of your saved chat history (${reason}). `
      + `Nothing was deleted: the stored value was kept under the storage key "${parkKey}".`
    );
  }

  /**
   * A blob written by a newer Mysti: do not read it, and do not write over it.
   * The session still works, it just does not persist — the alternative is
   * silently replacing history the user can get back by updating.
   */
  private _refuseNewerSchema(schemaVersion: number): void {
    this._persistenceDisabled = true;
    const detail = `the saved chat history was written by a newer version of Mysti `
      + `(schema ${schemaVersion} > ${CONVERSATIONS_SCHEMA_VERSION})`;
    console.error(`[Mysti] Refusing to read or overwrite the conversation store — ${detail}.`);
    this._loadDiagnostic = detail;
    this._notifyLoadFailure(
      `Mysti is not loading or saving chat history because ${detail}. `
      + `Nothing has been deleted — update Mysti to use that history again.`
    );
  }

  /** Best-effort, at most one per instance, and never throws. */
  private _notifyLoadFailure(message: string): void {
    if (this._notifiedLoadFailure) { return; }
    this._notifiedLoadFailure = true;
    try {
      void Promise.resolve(vscode.window.showWarningMessage(message)).then(undefined, () => { /* ignore */ });
    } catch {
      // A notification failure must never reach activate().
    }
  }

  /**
   * Persist the store. Never throws and never rejects: all callers float this
   * promise, so a rejection here is an unhandled rejection rather than a
   * signal anyone consumes. Returns whether the write landed.
   */
  private async _saveConversations(): Promise<boolean> {
    if (this._persistenceDisabled) { return false; }
    try {
      await this._extensionContext.globalState.update(CONVERSATIONS_KEY, {
        schemaVersion: CONVERSATIONS_SCHEMA_VERSION,
        conversations: Array.from(this._conversations.entries()),
        currentId: this._currentConversationId
      });
      return true;
    } catch (error) {
      console.error('[Mysti] Failed to save conversations:', error);
      try {
        void Promise.resolve(vscode.window.showErrorMessage('Failed to save conversation history'))
          .then(undefined, () => { /* ignore */ });
      } catch {
        // best effort
      }
      return false;
    }
  }
}
