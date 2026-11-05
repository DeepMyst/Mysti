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
import { validateModelName } from '../utils/validation';

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

export interface ShareableExportInfo {
  data: string;
  totalMessages: number;
  includedMessages: number;
  omittedMessages: number;
  truncatedMessages: number;
  titleTruncated: boolean;
  metadataOmitted: boolean;
}

const MARKDOWN_WATERMARK = '*I was Mysting — built with [Mysti](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti), the multi-agent AI coding assistant*';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Optional render-relevant structure persisted with a message
 * (Plan 02 Phase 3 — see the Message anatomy block in types.ts).
 */
export interface MessagePersistExtras {
  provider?: ProviderType;
  participants?: ProviderType[];
  model?: string;
  requestedModel?: string;
  toolCalls?: ToolCall[];
  segments?: MessageSegment[];
}

/**
 * A detached copy of stored data. The value came from JSON, so a JSON round
 * trip is faithful; if it somehow is not serialisable, keeping the live object
 * is still better than keeping nothing.
 */
function snapshotStoredValue(raw: unknown): unknown {
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
   * or globalState could not be read or backed up safely.
   */
  private _persistenceDisabled = false;
  /** Every live-key write waits for the recovery copy to be acknowledged. */
  private _recoveryReady: Promise<boolean> | null = null;
  /** One notification per instance — a broken store must not spam toasts. */
  private _notifiedLoadFailure = false;
  /** A burst of writes during one storage outage gets one actionable notice. */
  private _notifiedSaveFailure = false;
  private _lastImportDiagnostic: string | null = null;

  public getLastImportDiagnostic(): string | null { return this._lastImportDiagnostic; }

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
      title: vscode.l10n.t('New Conversation'),
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
      void this._saveConversations();
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
      agentConfig: source.agentConfig ? JSON.parse(JSON.stringify(source.agentConfig)) : undefined
    };

    this._conversations.set(fork.id, fork);
    this._saveConversations();
    return fork;
  }

  /** Structured deep copy of a message (safe to mutate on a forked branch). */
  private _cloneMessage(m: Message): Message {
    // Normalized on the way in: a fork of a conversation that predates the
    // store-side guard must not duplicate its oversized payloads.
    // Messages use the same JSON contract as globalState. Copy the entire
    // normalized value, including nested tool inputs, thinking and extensible
    // metadata; shallow copies let a late source turn rewrite a saved branch.
    return JSON.parse(JSON.stringify(this._normalizeMessageForStorage(m)));
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
    // An explicit identity belongs to its originating panel/turn. A delayed
    // completion after deletion must never spill into the globally current chat.
    let conversation: Conversation | null;
    if (conversationId) {
      conversation = this._conversations.get(conversationId) || null;
      if (!conversation) { throw new Error(`Conversation no longer exists: ${conversationId}`); }
    } else {
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
      if (extras.participants) { message.participants = extras.participants; }
      if (extras.model) { message.model = extras.model; }
      if (extras.requestedModel) { message.requestedModel = extras.requestedModel; }
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
    if (typeof normalized.requestedModel !== 'string' || !validateModelName(normalized.requestedModel).valid
      || !normalized.model || normalized.requestedModel.trim() === normalized.model) {
      delete normalized.requestedModel;
    } else { normalized.requestedModel = normalized.requestedModel.trim(); }
    if (Array.isArray(message.participants)) {
      normalized.participants = [...new Set(message.participants.filter(id =>
        typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_META, id)))].slice(0, 5);
      if (!normalized.participants.length) { delete normalized.participants; }
    } else { delete normalized.participants; }

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
  public exportToMarkdown(conversationId: string, includeImportFraming = false): string {
    const conversation = this._conversations.get(conversationId);
    if (!conversation) {
      return '';
    }

    const lines: string[] = [];
    let boundary = '';
    if (includeImportFraming) {
      do { boundary = randomUUID(); } while (conversation.messages.some(message => message.content.includes(boundary)));
      const metadata = JSON.stringify({ title: conversation.title, provider: conversation.provider, model: conversation.model, boundary })
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
      lines.push(`<!-- mysti-transcript-v1 ${metadata} -->`);
    }

    // Title header
    lines.push(`# ${conversation.title}`);
    lines.push('');

    // Metadata
    lines.push(`> Provider: ${conversation.provider} | Model: ${conversation.model}`);
    lines.push('');

    // Messages
    for (const message of conversation.messages) {
      if (boundary) { lines.push(`<!-- mysti-message:${boundary} ${message.role} -->`); }
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
      if (boundary) { lines.push(`<!-- mysti-message-end:${boundary} -->`, ''); }
    }

    // Footer watermark
    lines.push('---');
    lines.push('');
    lines.push(MARKDOWN_WATERMARK);
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
   * - Mysti .md transcript export (text and roles; legacy headings best-effort)
   * Returns the imported conversation or null on failure.
   */
  public importFromContent(content: string, fileName: string): Conversation | null {
    this._lastImportDiagnostic = null;
    try {
      const text = content.replace(/^\uFEFF/, '');
      const extension = fileName.toLowerCase();
      if (extension.endsWith('.jsonl')) { return this._importFromJsonl(text); }
      if (extension.endsWith('.md') || extension.endsWith('.markdown')) { return this._importFromMarkdown(text); }
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) { throw new Error('Expected a conversation object.'); }

      // Mysti format
      if (parsed.format === 'mysti') {
        if (parsed.version !== undefined && parsed.version !== 1) { throw new Error('Unsupported Mysti export version.'); }
        if (!isRecord(parsed.conversation)) { throw new Error('Missing Mysti conversation.'); }
        return this._importMystiJson(parsed.conversation);
      }
      // Legacy direct conversations must keep their metadata too.
      if (Array.isArray(parsed.messages)) {
        return this._importMystiJson(parsed);
      }
      throw new Error('Unrecognized conversation format.');
    } catch (error) {
      this._lastImportDiagnostic = error instanceof Error ? error.message : 'Conversation import failed.';
      return null;
    }
  }

  private _importMystiJson(data: Record<string, unknown>): Conversation {
    if (!Array.isArray(data.messages)) { throw new Error('Conversation messages must be an array.'); }
    const now = Date.now(), notes: string[] = [];
    const messages = data.messages.map((raw, index) => {
      if (!isRecord(raw)) { throw new Error(`Message ${index + 1} is not an object.`); }
      const role = raw.role === 'human' ? 'user' : raw.role;
      const content = this._importText(raw.content);
      if (!['user', 'assistant', 'system'].includes(role as string) || content === null) {
        throw new Error(`Message ${index + 1} needs a supported role and text content.`);
      }
      const message = this._coerceStoredMessage({ ...raw, id: this._generateId(), role, content }, now)!;
      if (Array.isArray(raw.toolCalls) && raw.toolCalls.some(tool => isRecord(tool)
        && !['pending', 'running', 'completed', 'failed', 'proposed', 'unconfirmed'].includes(tool.status as string))) {
        notes.push('An invalid tool status was replaced with failed; its recorded input and output were preserved.');
      }
      if (message.provider !== undefined) {
        if (typeof message.provider !== 'string' || !Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_META, message.provider)) { delete message.provider; }
      }
      if (raw.checkpoint !== undefined) { notes.push('Imported checkpoint references cannot restore files in this workspace.'); }
      delete message.checkpoint;
      if (message.attachments?.some(attachment => attachment.base64Data !== undefined)) { notes.push('Attachment cards were kept without embedded file data.'); }
      if (message.toolCalls?.length) {
        message.toolCalls = message.toolCalls.map(tool => ({ ...tool, historicalOnly: true }));
        notes.push('Imported tool calls are historical records and cannot undo local files.');
      }
      const normalized = this._normalizeMessageForStorage(message);
      if (normalized.toolCalls?.some(tool => tool.truncated)) { notes.push('Oversized tool inputs or outputs were truncated to the history storage limits.'); }
      return normalized;
    });
    const id = this._generateId();
    const candidate = { ...data, id, title: typeof data.title === 'string' ? data.title : vscode.l10n.t('Imported Conversation'), messages,
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : now, updatedAt: now,
      provider: this._coerceProvider(data.provider), model: typeof data.model === 'string' ? data.model : 'unknown',
      mode: data.mode || 'ask-before-edit' };
    const conversation = this._coerceStoredEntry([id, candidate])![1];
    if (notes.length) { this._lastImportDiagnostic = [...new Set([this._lastImportDiagnostic, ...notes].filter(Boolean))].join(' '); }
    this._conversations.set(conversation.id, conversation);
    this._currentConversationId = conversation.id;
    this._saveConversations();
    return conversation;
  }

  private _importText(value: unknown): string | null {
    if (typeof value === 'string') { return value; }
    if (Array.isArray(value) && value.every(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')) {
      return value.map(block => (block as { text: string }).text).join('');
    }
    return null;
  }

  private _importFromMarkdown(content: string): Conversation {
    const framed = content.match(/^<!-- mysti-transcript-v1 (.+) -->\r?\n/);
    if (framed) {
      const metadata: unknown = JSON.parse(framed[1]);
      if (!isRecord(metadata) || typeof metadata.boundary !== 'string' || !/^[a-f0-9-]{36}$/.test(metadata.boundary)) {
        throw new Error('Invalid Mysti Markdown framing.');
      }
      const boundary = metadata.boundary;
      // Framing has one known newline convention. Accepting optional CRs at
      // the content boundary would consume a legitimate final bare CR.
      const newline = framed[0].endsWith('\r\n') ? '\r\n' : '\n';
      const header = `# ${metadata.title}\n\n> Provider: ${metadata.provider} | Model: ${metadata.model}\n\n`
        .replace(/\n/g, newline);
      if (!content.startsWith(header, framed[0].length)) { throw new Error('Invalid Mysti Markdown framing header.'); }
      const start = new RegExp(`<!-- mysti-message:${boundary} (user|assistant|system) -->\\r?\\n### (?:User|Assistant|system)\\r?\\n\\r?\\n`, 'g');
      const end = new RegExp(`${newline}${newline}<!-- mysti-message-end:${boundary} -->`, 'g');
      const messages: Array<{ role: string; content: string }> = [];
      let match: RegExpExecArray | null, previousEnd = framed[0].length + header.length;
      start.lastIndex = previousEnd;
      while ((match = start.exec(content))) {
        if (content.slice(previousEnd, match.index).trim()) { throw new Error('Invalid Mysti Markdown message boundary.'); }
        end.lastIndex = start.lastIndex;
        const ending = end.exec(content);
        if (!ending) { throw new Error('Truncated Mysti Markdown message.'); }
        const nextStart = content.indexOf(`<!-- mysti-message:${boundary} `, start.lastIndex);
        if (nextStart !== -1 && nextStart < ending.index) { throw new Error('Truncated Mysti Markdown message boundary.'); }
        messages.push({ role: match[1], content: content.slice(start.lastIndex, ending.index) });
        previousEnd = end.lastIndex; start.lastIndex = end.lastIndex;
      }
      if (content.slice(previousEnd).trim() !== `---\n\n${MARKDOWN_WATERMARK}`) {
        // Match the framing's line endings while leaving actual message bytes intact.
        // An empty transcript is valid only with the same complete header/footer.
        const footer = content.slice(previousEnd).replace(/\r\n/g, '\n').trim();
        if (footer !== `---\n\n${MARKDOWN_WATERMARK}`) { throw new Error('Invalid or truncated Mysti Markdown transcript.'); }
      }
      this._lastImportDiagnostic = 'Markdown imports preserve transcript text and roles; use Mysti JSON for attachments and structured metadata.';
      return this._importMystiJson({ title: metadata.title, provider: metadata.provider, model: metadata.model, messages });
    }

    // Older readable exports have no unambiguous boundaries. Accept only the
    // recognizable Mysti wrapper and ignore role-looking lines inside fences.
    const text = content.replace(/\r\n/g, '\n');
    const header = text.match(/^# (.*)\n\n> Provider: ([^\n]*?) \| Model: ([^\n]*)\n\n/);
    const footer = `\n\n---\n\n${MARKDOWN_WATERMARK}`;
    const footerAt = text.lastIndexOf(footer);
    if (!header || footerAt < header[0].length || text.slice(footerAt + footer.length).trim()) { throw new Error('Only Mysti Markdown transcript exports are supported.'); }
    const body = text.slice(header[0].length, footerAt), messages: Array<{ role: string; content: string }> = [];
    let fence: { character: string; length: number } | null = null;
    let role: string | null = null, lines: string[] = [];
    const finish = () => { if (role) { if (lines[0] === '') { lines.shift(); } if (lines.at(-1) === '') { lines.pop(); } messages.push({ role, content: lines.join('\n') }); } lines = []; };
    for (const line of body.split('\n')) {
      const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
      const heading = !fence && line.match(/^### (User|Assistant|system)$/);
      if (heading) { finish(); role = heading[1].toLowerCase(); continue; }
      if (delimiter) {
        if (!fence) { fence = { character: delimiter[1][0], length: delimiter[1].length }; }
        else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) { fence = null; }
      }
      lines.push(line);
    }
    finish();
    if (!messages.length) { throw new Error('No messages found in the Mysti Markdown transcript.'); }
    this._lastImportDiagnostic = 'Legacy Markdown was imported as text using best-effort heading boundaries; structured metadata is unavailable.';
    return this._importMystiJson({ title: header[1], provider: header[2], model: header[3], messages });
  }

  /**
   * Export conversation as a compact base64 string for deep link sharing.
   * Compresses with zlib to keep URIs small. Only includes last 10 messages.
   */
  public exportToShareable(conversationId: string): string {
    return this.exportToShareableWithInfo(conversationId).data;
  }

  public exportToShareableWithInfo(conversationId: string): ShareableExportInfo {
    const conversation = this._conversations.get(conversationId);
    if (!conversation) {
      return { data: '', totalMessages: 0, includedMessages: 0, omittedMessages: 0, truncatedMessages: 0, titleTruncated: false, metadataOmitted: false };
    }
    const included = conversation.messages.slice(-SHAREABLE_MESSAGE_LIMIT);
    const shareData = {
      // Text-only sharing is deliberately bounded; the caller uses the
      // accompanying counts to choose full JSON before any data is lost.
      t: conversation.title.slice(0, SHAREABLE_TITLE_CAP),
      p: conversation.provider,
      m: included.map(m => ({
        r: m.role === 'user' ? 'u' : m.role === 'system' ? 's' : 'a',
        c: m.content.slice(0, SHAREABLE_CONTENT_CAP),
      }))
    };
    const json = JSON.stringify(shareData);
    const compressed = zlib.deflateSync(Buffer.from(json));
    return { data: compressed.toString('base64url'), totalMessages: conversation.messages.length, includedMessages: included.length,
      omittedMessages: conversation.messages.length - included.length,
      truncatedMessages: included.filter(message => message.content.length > SHAREABLE_CONTENT_CAP).length,
      titleTruncated: conversation.title.length > SHAREABLE_TITLE_CAP,
      // IDs/timestamps and conversation configuration are also intentionally
      // absent, even for a transcript with no tools or attachments.
      metadataOmitted: true };
  }

  /**
   * Import conversation from a shareable base64 deep link payload.
   */
  public importFromShareable(data: string): Conversation | null {
    this._lastImportDiagnostic = null;
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
          role: m.r === 'u' ? 'user' as const : m.r === 's' ? 'system' as const : 'assistant' as const,
          content: (m.c as string).slice(0, SHAREABLE_CONTENT_CAP),
          timestamp: Date.now()
        }));

      if (messages.length === 0) {
        this._lastImportDiagnostic = 'The share link contains no readable text messages.';
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
      const truncated = rawMessages.length > messages.length || rawMessages.some(message => isRecord(message) && typeof message.c === 'string' && message.c.length > SHAREABLE_CONTENT_CAP)
        || (typeof shareData.t === 'string' && shareData.t.length > SHAREABLE_TITLE_CAP);
      this._lastImportDiagnostic = `Imported a text-only share link; attachments and structured metadata are not included.${truncated ? ' The incoming payload exceeded supported limits or contained unreadable entries; only bounded readable text was kept.' : ''}`;
      return conversation;
    } catch {
      this._lastImportDiagnostic = 'The share link is invalid or exceeds the supported decompression limit.';
      return null;
    }
  }

  private _importFromJsonl(content: string): Conversation | null {
    const lines = content.split('\n');
    const messages: Record<string, unknown>[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) { continue; }
      let entry: unknown;
      try { entry = JSON.parse(lines[index]); }
      catch { throw new Error(`JSONL line ${index + 1} is invalid or truncated; no messages were imported.`); }
      if (!isRecord(entry)) { throw new Error(`JSONL line ${index + 1} must be an object.`); }
      if (isRecord(entry.message)) {
        messages.push({ ...entry.message, timestamp: entry.message.timestamp ?? entry.timestamp });
      } else if ('message' in entry && 'role' in entry) {
        messages.push({ ...entry, content: entry.message });
      } else if ('content' in entry) {
        messages.push(entry);
      } else if (['session', 'session_metadata', 'metadata', 'model_change', 'thinking_level_change'].includes(String(entry.type))) {
        this._lastImportDiagnostic = 'JSONL session metadata was skipped; readable message records were imported.';
      } else { throw new Error(`JSONL line ${index + 1} is not a recognized message or session record.`); }
    }
    if (!messages.length) { throw new Error('The JSONL file contains no readable messages.'); }
    return this._importMystiJson({ messages });
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

    // Restore detached entries. Message updates mutate objects in place, so
    // sharing them with the memento could change the original history even
    // while a pending or failed recovery copy prevents live-key writes.
    const storedEntries = snapshotStoredValue(raw.conversations) as unknown[];

    const restored = new Map<string, Conversation>();
    let dropped = 0;
    let droppedMessages = 0;
    let duplicates = 0;
    let repaired = 0;
    for (const entry of storedEntries) {
      const coerced = this._coerceStoredEntry(entry);
      if (!coerced) { dropped++; continue; }
      if (restored.has(coerced[0])) { duplicates++; continue; }
      droppedMessages += coerced[2];
      repaired += coerced[3];
      restored.set(coerced[0], coerced[1]);
    }

    this._conversations = restored;
    const currentId = raw.currentId;
    this._currentConversationId =
      typeof currentId === 'string' && restored.has(currentId) ? currentId : null;

    if (dropped > 0 || droppedMessages > 0 || duplicates > 0 || repaired > 0) {
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
      if (duplicates > 0) {
        parts.push(`${duplicates} stored conversation ${duplicates === 1 ? 'entry reused an ID' : 'entries reused IDs'}`);
      }
      if (repaired > 0) {
        parts.push(`${repaired} stored conversation ${repaired === 1 ? 'entry needed structural repair' : 'entries needed structural repair'}`);
      }
      this._parkUnreadableBlob(snapshotStoredValue(raw), parts.join(' and '));

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
  private _coerceStoredEntry(entry: unknown): [string, Conversation, number, number] | null {
    if (!Array.isArray(entry) || entry.length < 2) { return null; }
    const id: unknown = entry[0];
    const value: unknown = entry[1];
    if (typeof id !== 'string' || id.length === 0) { return null; }
    if (!isRecord(value) || !Array.isArray(value.messages)) { return null; }

    // Keep entry repairs local; stored data and recovery copies stay intact.
    const conversation = { ...value } as unknown as Conversation;
    // History actions pass Conversation.id back to the Map lookup. Even a
    // nonempty but different id can target another conversation's transcript.
    conversation.id = id;
    if (typeof conversation.title !== 'string') { conversation.title = vscode.l10n.t('New Conversation'); }
    if (typeof conversation.model !== 'string') { conversation.model = 'unknown'; }
    conversation.provider = this._coerceProvider(conversation.provider);
    if (!['default', 'ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'].includes(conversation.mode)) {
      conversation.mode = 'ask-before-edit';
    }
    if (!Number.isFinite(conversation.createdAt)) { conversation.createdAt = Date.now(); }
    if (!Number.isFinite(conversation.updatedAt)) { conversation.updatedAt = conversation.createdAt; }
    if (conversation.agentConfig !== undefined) {
      const config = conversation.agentConfig;
      if (!isRecord(config) || !Array.isArray(config.enabledSkills)
        || config.enabledSkills.some(skill => typeof skill !== 'string')
        || (config.personaId !== null && typeof config.personaId !== 'string')) {
        delete conversation.agentConfig;
      }
    }
    // Keep usable text while removing malformed optional render structures.
    // All repairs are reported and the untouched original is parked first.
    const source = value.messages as unknown[];
    const messages = source.map(message => this._coerceStoredMessage(message, conversation.createdAt))
      .filter((message): message is Message => message !== null);
    conversation.messages = messages;
    const repaired = JSON.stringify(conversation) !== JSON.stringify(value) ? 1 : 0;
    return [id, conversation, source.length - messages.length, repaired];
  }

  private _coerceStoredMessage(value: unknown, fallbackTimestamp: number): Message | null {
    if (!isRecord(value) || typeof value.content !== 'string'
      || !['user', 'assistant', 'system'].includes(value.role as string)) { return null; }
    const message = { ...value } as unknown as Message;
    if (typeof message.id !== 'string' || !message.id) { message.id = this._generateId(); }
    if (!Number.isFinite(message.timestamp)) { message.timestamp = fallbackTimestamp; }
    // Model IDs are extensible strings, but historical attribution formats
    // them as strings. Invalid optional values must use the conversation fallback.
    if (message.model !== undefined && typeof message.model !== 'string') { delete message.model; }
    if (typeof message.requestedModel !== 'string' || !validateModelName(message.requestedModel).valid
      || !message.model || message.requestedModel.trim() === message.model) { delete message.requestedModel; }
    else { message.requestedModel = message.requestedModel.trim(); }
    for (const field of ['context', 'attachments', 'toolCalls'] as const) {
      const items = message[field];
      if (items === undefined) { continue; }
      if (!Array.isArray(items)) { delete message[field]; continue; }
      // Consumers spread/index these elements; null/scalar elements are unsafe.
      (message as unknown as Record<string, unknown>)[field] = items.filter(isRecord);
    }
    if (message.segments !== undefined) {
      const segments = message.segments;
      if (!Array.isArray(segments) || !segments.every(segment => isRecord(segment)
        && (((segment.type === 'text' || segment.type === 'thinking') && typeof segment.content === 'string')
          || (segment.type === 'tool' && typeof segment.toolCallId === 'string')))) {
        // A filtered subset would hide intact canonical paragraphs because the
        // renderer prefers segments. Fall back to the whole message instead.
        delete message.segments;
      }
    }
    if (message.context) {
      message.context = message.context.filter(item => typeof item.path === 'string'
        && (item.content === undefined || typeof item.content === 'string'));
    }
    if (message.attachments) {
      message.attachments = message.attachments.filter(item => typeof item.fileName === 'string'
        && typeof item.mimeType === 'string' && (item.type === 'file' || item.type === 'image'));
    }
    if (message.toolCalls) {
      message.toolCalls = message.toolCalls.filter(tool => typeof tool.id === 'string' && typeof tool.name === 'string')
        .map(tool => ({ ...tool, input: isRecord(tool.input) ? tool.input : {},
          status: tool.proposalOnly === true ? 'proposed' : ['pending', 'running', 'completed', 'failed', 'proposed', 'unconfirmed'].includes(tool.status) ? tool.status : 'failed',
          ...(tool.output !== undefined && typeof tool.output !== 'string' ? { output: undefined } : {}) }));
    }
    if (message.thinking !== undefined && typeof message.thinking !== 'string'
      && (!isRecord(message.thinking) || typeof message.thinking.content !== 'string'
        || !['streamed', 'complete-blocks'].includes(message.thinking.style))) {
      delete message.thinking;
    }
    return message;
  }

  /**
   * Keep an unreadable blob instead of destroying it, and say so once.
   * The constructor stays synchronous, but all saves wait for the parked copy
   * to succeed before they can replace the original live key.
   */
  private _parkUnreadableBlob(raw: unknown, reason: string): void {
    const parkKey = `${CONVERSATIONS_CORRUPT_KEY_PREFIX}${Date.now()}.${randomUUID()}`;
    console.error(
      `[Mysti] Saved chat history could not be read (${reason}); saving a recovery copy under "${parkKey}".`
    );
    this._loadDiagnostic = `${reason} — the original history is preserved while a recovery copy is saved`;
    this._recoveryReady = (async () => {
      try {
        await this._extensionContext.globalState.update(parkKey, raw);
        this._loadDiagnostic = `${reason} — the unreadable value was kept under the storage key "${parkKey}"`;
        this._notifyLoadFailure(
          `Mysti could not read part of your saved chat history (${reason}). `
          + `Nothing was deleted: the stored value was kept under the storage key "${parkKey}".`
        );
        return true;
      } catch (err) {
        this._persistenceDisabled = true;
        console.error('[Mysti] Failed to keep a copy of the unreadable chat history:', err);
        this._loadDiagnostic = `${reason} — the recovery copy could not be saved; the original history is unchanged and saving is disabled`;
        this._notifyLoadFailure(
          'Mysti could not save a recovery copy of your unreadable chat history. '
          + 'The original history is unchanged. New messages in this session will not be saved.'
        );
        return false;
      }
    })();
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
    if (this._recoveryReady) {
      if (!await this._recoveryReady) { return false; }
      this._recoveryReady = null;
    }
    try {
      await this._extensionContext.globalState.update(CONVERSATIONS_KEY, {
        schemaVersion: CONVERSATIONS_SCHEMA_VERSION,
        conversations: Array.from(this._conversations.entries()),
        currentId: this._currentConversationId
      });
      this._notifiedSaveFailure = false;
      return true;
    } catch (error) {
      console.error('[Mysti] Failed to save conversations:', error);
      if (this._notifiedSaveFailure) { return false; }
      this._notifiedSaveFailure = true;
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
