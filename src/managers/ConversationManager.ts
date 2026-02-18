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
