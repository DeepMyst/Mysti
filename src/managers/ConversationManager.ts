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
import type { Conversation, Message, ContextItem, Attachment, OperationMode, ProviderType, AgentConfiguration } from '../types';

export class ConversationManager {
  private _conversations: Map<string, Conversation> = new Map();
  private _currentConversationId: string | null = null;
  private _extensionContext: vscode.ExtensionContext;
  private _onTitleGenerated?: (conversationId: string, title: string) => void;

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
      provider: config.get('defaultProvider', 'claude-code') as ProviderType
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
   */
  public addMessageToConversation(
    conversationId: string | null | undefined,
    role: 'user' | 'assistant' | 'system',
    content: string,
    context?: ContextItem[],
    attachments?: Attachment[],
    thinking?: string
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

    conversation.messages.push(message);
    conversation.updatedAt = Date.now();

    this._saveConversations();
    return message;
  }

  public updateMessage(messageId: string, updates: Partial<Message>): boolean {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      return false;
    }

    const message = conversation.messages.find(m => m.id === messageId);
    if (message) {
      Object.assign(message, updates);
      conversation.updatedAt = Date.now();
      this._saveConversations();
      return true;
    }
    return false;
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
      messages: (data.messages || []).map(m => ({
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
      provider: (data.provider || 'imported') as ProviderType,
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
      t: conversation.title,
      p: conversation.provider,
      m: conversation.messages.slice(-10).map(m => ({
        r: m.role === 'user' ? 'u' : 'a',
        c: m.content.slice(0, 2000),
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
      const json = zlib.inflateSync(compressed).toString('utf-8');
      const shareData = JSON.parse(json);

      const messages: Message[] = (shareData.m || []).map((m: { r: string; c: string }) => ({
        id: this._generateId(),
        role: m.r === 'u' ? 'user' as const : 'assistant' as const,
        content: m.c,
        timestamp: Date.now()
      }));

      if (messages.length === 0) {
        return null;
      }

      const conversation: Conversation = {
        id: this._generateId(),
        title: shareData.t || 'Shared Conversation',
        messages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        mode: 'ask-before-edit' as OperationMode,
        model: 'unknown',
        provider: (shareData.p || 'claude-code') as ProviderType
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

  private _loadConversations() {
    const stored = this._extensionContext.globalState.get<{
      conversations: [string, Conversation][];
      currentId: string | null;
    }>('mysti.conversations');

    if (stored) {
      this._conversations = new Map(stored.conversations);
      this._currentConversationId = stored.currentId;
    }
  }

  /**
   * Save conversations to global state with error handling
   * Critical: Prevents state inconsistency by awaiting the async operation
   */
  private async _saveConversations(): Promise<void> {
    try {
      await this._extensionContext.globalState.update('mysti.conversations', {
        conversations: Array.from(this._conversations.entries()),
        currentId: this._currentConversationId
      });
    } catch (error) {
      console.error('[Mysti] Failed to save conversations:', error);
      vscode.window.showErrorMessage('Failed to save conversation history');
      throw error; // Re-throw to let callers know save failed
    }
  }
}
