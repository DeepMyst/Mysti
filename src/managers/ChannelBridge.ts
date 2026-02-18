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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ActiveModeManager } from './ActiveModeManager';
import type { ChannelEvent, ChannelInfo } from '../providers/openclaw/OpenClawGateway';

// --- Marker regex patterns ---

const SEND_REGEX = /<<<CHANNEL_SEND\s+channel="([^"]+)"(?:\s+to="([^"]+)")?\s*>>>([\s\S]*?)<<<END_CHANNEL_SEND>>>/g;
const ASK_REGEX = /<<<CHANNEL_ASK\s+channel="([^"]+)"(?:\s+to="([^"]+)")?\s+id="([^"]+)"\s*>>>([\s\S]*?)<<<END_CHANNEL_ASK>>>/g;
const DELEGATE_REGEX = /<<<OPENCLAW>>>([\s\S]*?)<<<END_OPENCLAW>>>/g;

/** Strip all channel/delegate markers from text for clean display */
const MARKER_STRIP_REGEX = /<<<(?:CHANNEL_(?:SEND|ASK)\s+[^>]*|OPENCLAW)>>>([\s\S]*?)<<<END_(?:CHANNEL_(?:SEND|ASK)|OPENCLAW)>>>/g;

// --- Cancel command detection ---

const CANCEL_KEYWORDS = new Set(['/stop', '/cancel', 'stop', 'cancel']);

function isCancelCommand(text: string): boolean {
  return CANCEL_KEYWORDS.has(text.trim().toLowerCase());
}

// --- Types ---

export interface ChannelAction {
  type: 'send' | 'ask' | 'delegate';
  channel: string;
  content: string;
  to?: string;
  askId?: string;
  /** Character index in the accumulated text where this marker starts */
  startIndex: number;
}

export interface PendingAsk {
  askId: string;
  panelId: string;
  channel: string;
  channelId: string;
  question: string;
  to?: string;
  sentAt: number;
  reply?: string;
  repliedAt?: number;
}

export interface QueuedChannelMessage {
  channelId: string;
  channelName: string;
  content: string;
  sender?: string;
  timestamp: number;
}

/** A contact that Mysti has initiated a conversation with */
interface TrackedContact {
  /** Normalized identifier (lowercase name or E.164 phone) */
  identifier: string;
  channel: string;
  /** When the outbound message was sent */
  sentAt: number;
}

/** How long (ms) to keep tracking a contact after last outbound message */
const TRACKED_CONTACT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Callback interface for ChannelBridge to interact with ChatViewProvider.
 * Avoids circular dependency by using an interface instead of importing ChatViewProvider.
 */
export interface ChannelBridgeDelegate {
  hasPendingQuestion(panelId: string): boolean;
  getPendingQuestionToolCallId(panelId: string): string | null;
  answerPendingQuestion(panelId: string, toolCallId: string, answer: string): void;
  cancelPanelRequest(panelId: string): void;
  injectChannelMessage(panelId: string, channelName: string, content: string, sender?: string): void;
  isRunning(panelId: string): boolean;
  getActivePanelId(): string | null;
}

/**
 * ChannelBridge manages cross-channel messaging between AI providers and
 * OpenClaw-connected channels (WhatsApp, Telegram, etc.).
 *
 * Outbound: Detects structured markers in AI response text and routes
 * messages/questions to channels via the OpenClaw Gateway.
 *
 * Inbound: Routes incoming channel messages to the correct panel and action
 * based on current agent state (idle, running, waiting for input).
 */
export class ChannelBridge {
  private _activeModeManager: ActiveModeManager;
  private _delegate: ChannelBridgeDelegate | null = null;

  /** Tracks which marker positions have already been processed per panel */
  private _processedMarkerPositions: Map<string, Set<number>> = new Map();

  /** Pending outbound asks awaiting channel replies */
  private _pendingAsks: Map<string, PendingAsk[]> = new Map();

  /** Queued inbound messages to be drained after current response finishes */
  private _queuedMessages: Map<string, QueuedChannelMessage[]> = new Map();

  /** Cleanup function for channel event subscription */
  private _channelEventCleanup: (() => void) | null = null;

  /** Inbound message polling timer */
  private _inboundPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Timestamp watermark — only process messages newer than this */
  private _lastPollTimestamp: number = 0;

  /** Whether sessions.history RPC is available (null = unknown, true/false = tested) */
  private _sessionHistoryAvailable: boolean | null = null;

  /** Track which message timestamps we've already processed to avoid duplicates */
  private _processedMessageIds: Set<string> = new Set();

  /** Contacts that Mysti has sent messages to — only these get inbound routing */
  private _trackedContacts: Map<string, TrackedContact> = new Map();

  constructor(activeModeManager: ActiveModeManager) {
    this._activeModeManager = activeModeManager;
    this._subscribeToChannelEvents();
    // Start inbound polling — ticks are no-op when Gateway is disconnected
    this.startInboundPolling();
  }

  /**
   * Set the delegate (ChatViewProvider) that handles panel interactions.
   * Called after construction to avoid circular dependency.
   */
  setDelegate(delegate: ChannelBridgeDelegate): void {
    this._delegate = delegate;
  }

  // --- Outbound: Prompt Injection ---

  /**
   * Generate the channel context snippet to inject into prompts.
   * Returns empty string if no connected channels.
   */
  getChannelPromptSnippet(): string {
    if (!this._activeModeManager.isIntegrationEnabled()) {
      return '';
    }
    if (!this._activeModeManager.isConnected()) {
      console.log('[Mysti] ChannelBridge: Gateway not connected, skipping snippet');
      return '';
    }

    const channels = this._activeModeManager.getChannels();
    const connected = channels.filter(c => c.status === 'connected');
    if (connected.length === 0) {
      console.log(`[Mysti] ChannelBridge: No connected channels (${channels.length} total, statuses: ${channels.map(c => c.status).join(', ')})`);
      return '';
    }

    console.log(`[Mysti] ChannelBridge: Generating snippet for ${connected.length} channels: ${connected.map(c => c.type).join(', ')}`);

    const channelList = connected.map(c =>
      `- ${this._formatChannelName(c)} (${c.type}, id: ${c.id})`
    ).join('\n');

    const channelTypes = connected.map(c => c.type).join(', ');

    return `[SYSTEM: OpenClaw Integration]

OpenClaw is a local gateway daemon running on the user's machine. It provides:
- Bidirectional messaging with WhatsApp, Telegram, Slack, Discord, Signal, iMessage, and more
- An AI agent with skills for automation, research, messaging, and more
- Contact resolution — you can refer to people by name (no need for exact match or phone number)

Currently connected channels:
${channelList}

You have built-in access to these capabilities via structured markers in your response.

CHANNEL MESSAGING:

Send a message to the user's own device:
<<<CHANNEL_SEND channel="${connected[0].type}">>>
Your message content here
<<<END_CHANNEL_SEND>>>

Send a message to a specific person (use their name — OpenClaw resolves it):
<<<CHANNEL_SEND channel="${connected[0].type}" to="PersonName">>>
Your message content here
<<<END_CHANNEL_SEND>>>

Ask someone a question and wait for their reply:
<<<CHANNEL_ASK channel="${connected[0].type}" to="PersonName" id="unique-id">>>
Your question here
<<<END_CHANNEL_ASK>>>

GENERAL TASK DELEGATION:

Delegate any task to the OpenClaw agent. Available skills:
${this._buildSkillsList()}

<<<OPENCLAW>>>
Your task description here — be specific about what you need done
<<<END_OPENCLAW>>>

RULES:
- The channel value must be one of: ${channelTypes}
- Use CHANNEL_SEND for messages that don't need a reply
- Use CHANNEL_ASK when you need someone to respond before continuing
- The "to" attribute is optional — omit it to send to the user's own device
- When the user says "tell X", "ask X", "message X", or "send to X", use to="X" — OpenClaw automatically resolves contact names, no exact match required
- Use OPENCLAW for any delegatable task: weather, notes, reminders, image generation, web research, GitHub, PDF editing, transcription, and anything else listed in the skills above
- You can include multiple markers in a single response
- All markers are processed automatically — content is delivered or delegated instantly
- Do NOT say you cannot send messages, contact specific people, or perform tasks — these are built-in capabilities via OpenClaw`;
  }

  /**
   * Generate context for pending ask replies to inject into the next prompt.
   * Returns empty string if no resolved replies.
   */
  getReplyContext(panelId: string): string {
    const asks = this._pendingAsks.get(panelId);
    if (!asks || asks.length === 0) { return ''; }

    const replied = asks.filter(a => a.reply !== undefined);
    if (replied.length === 0) { return ''; }

    const parts = ['[Channel Replies]'];
    for (const ask of replied) {
      const fromLabel = ask.to ? ` from ${ask.to}` : '';
      parts.push(`Reply${fromLabel} via ${this._formatChannelType(ask.channel)} (to question ${ask.askId}: "${ask.question}"):`);
      parts.push(`"${ask.reply}"`);
    }

    // Clear replied asks after injecting
    const remaining = asks.filter(a => a.reply === undefined);
    if (remaining.length === 0) {
      this._pendingAsks.delete(panelId);
    } else {
      this._pendingAsks.set(panelId, remaining);
    }

    return parts.join('\n');
  }

  // --- Outbound: Marker Detection ---

  /**
   * Scan accumulated response text for completed channel markers.
   * Returns only newly detected actions (not previously processed).
   */
  detectMarkers(panelId: string, accumulatedText: string): ChannelAction[] {
    if (!this._activeModeManager.isIntegrationEnabled()) { return []; }
    const processed = this._getProcessedPositions(panelId);
    const actions: ChannelAction[] = [];

    // Detect CHANNEL_SEND markers — groups: [1]=channel, [2]=to (optional), [3]=content
    let match: RegExpExecArray | null;
    SEND_REGEX.lastIndex = 0;
    while ((match = SEND_REGEX.exec(accumulatedText)) !== null) {
      if (!processed.has(match.index)) {
        processed.add(match.index);
        actions.push({
          type: 'send',
          channel: match[1],
          to: match[2] || undefined,
          content: match[3].trim(),
          startIndex: match.index,
        });
      }
    }

    // Detect CHANNEL_ASK markers — groups: [1]=channel, [2]=to (optional), [3]=id, [4]=content
    ASK_REGEX.lastIndex = 0;
    while ((match = ASK_REGEX.exec(accumulatedText)) !== null) {
      if (!processed.has(match.index)) {
        processed.add(match.index);
        actions.push({
          type: 'ask',
          channel: match[1],
          to: match[2] || undefined,
          content: match[4].trim(),
          askId: match[3],
          startIndex: match.index,
        });
      }
    }

    // Detect OPENCLAW delegate markers — groups: [1]=content
    DELEGATE_REGEX.lastIndex = 0;
    while ((match = DELEGATE_REGEX.exec(accumulatedText)) !== null) {
      if (!processed.has(match.index)) {
        processed.add(match.index);
        actions.push({
          type: 'delegate',
          channel: 'openclaw',
          content: match[1].trim(),
          startIndex: match.index,
        });
      }
    }

    return actions;
  }

  /**
   * Strip channel markers from text for clean display.
   */
  static stripMarkers(text: string): string {
    return text.replace(MARKER_STRIP_REGEX, '').trim();
  }

  // --- Outbound: Execute Actions ---

  /**
   * Execute a send action — deliver message to channel.
   * Routes through agent pipeline for fuzzy contact names, direct for phone numbers / self.
   */
  async executeSend(action: ChannelAction): Promise<boolean> {
    const channelId = this._resolveChannelId(action.channel);
    if (!channelId) {
      console.log(`[Mysti] ChannelBridge: No connected channel for type '${action.channel}'`);
      return false;
    }

    // Fuzzy name (not E.164 phone) → delegate to agent for contact resolution
    if (action.to && !action.to.startsWith('+')) {
      const prompt = `Send the following message to ${action.to} on ${action.channel}:\n\n${action.content}`;
      const ok = await this._activeModeManager.sendAgentTask(prompt, action.channel);
      console.log(`[Mysti] ChannelBridge: Delegated send to '${action.to}' via agent: ${ok ? 'accepted' : 'failed'}`);
      if (ok && action.to) { this._trackContact(action.to, action.channel); }
      return ok;
    }

    // Direct delivery (self-chat or exact phone number)
    const target = action.to || this._resolveChannelTarget(action.channel);
    const ok = await this._activeModeManager.sendToChannel(channelId, action.content, target || undefined);
    console.log(`[Mysti] ChannelBridge: Sent to ${action.channel} (${channelId}${target ? ', to: ' + target : ''}): ${ok ? 'success' : 'failed'}`);
    if (ok && action.to) { this._trackContact(action.to, action.channel); }
    return ok;
  }

  /**
   * Execute a delegate action — send a general task to the OpenClaw agent.
   */
  async executeDelegate(action: ChannelAction): Promise<boolean> {
    const ok = await this._activeModeManager.sendAgentTask(action.content);
    console.log(`[Mysti] ChannelBridge: Delegated task to OpenClaw (${action.content.length} chars): ${ok ? 'accepted' : 'failed'}`);
    return ok;
  }

  /**
   * Execute an ask action — send question and register pending reply listener.
   * Routes through agent pipeline for fuzzy contact names.
   */
  async executeAsk(action: ChannelAction, panelId: string): Promise<boolean> {
    const channelId = this._resolveChannelId(action.channel);
    if (!channelId) {
      console.log(`[Mysti] ChannelBridge: No connected channel for type '${action.channel}'`);
      return false;
    }

    let ok: boolean;

    // Fuzzy name → delegate to agent for contact resolution
    if (action.to && !action.to.startsWith('+')) {
      const prompt = `Send the following question to ${action.to} on ${action.channel} and wait for their reply:\n\n${action.content}`;
      ok = await this._activeModeManager.sendAgentTask(prompt, action.channel);
      console.log(`[Mysti] ChannelBridge: Delegated ask to '${action.to}' via agent: ${ok ? 'accepted' : 'failed'}`);
    } else {
      // Direct delivery (self-chat or exact phone number)
      const target = action.to || this._resolveChannelTarget(action.channel);
      ok = await this._activeModeManager.sendToChannel(channelId, action.content, target || undefined);
    }

    // Track the contact so inbound replies are routed
    if (ok && action.to) { this._trackContact(action.to, action.channel); }

    // Register PendingAsk for both paths so inbound replies can be matched
    if (ok && action.askId) {
      const pending: PendingAsk = {
        askId: action.askId,
        panelId,
        channel: action.channel,
        channelId,
        to: action.to,
        question: action.content,
        sentAt: Date.now(),
      };
      const asks = this._pendingAsks.get(panelId) || [];
      asks.push(pending);
      this._pendingAsks.set(panelId, asks);
      console.log(`[Mysti] ChannelBridge: Ask '${action.askId}' sent to ${action.channel}${action.to ? ' (to: ' + action.to + ')' : ''}, awaiting reply`);
    }
    return ok;
  }

  // --- Inbound: Message Routing ---

  /**
   * Drain queued inbound messages for a panel.
   * Called by ChatViewProvider after a response finishes ('done' chunk).
   */
  drainQueuedMessages(panelId: string): QueuedChannelMessage[] {
    const queued = this._queuedMessages.get(panelId) || [];
    this._queuedMessages.delete(panelId);
    return queued;
  }

  // --- Lifecycle ---

  /**
   * Reset per-panel tracking state. Called on new message send.
   */
  resetForNewResponse(panelId: string): void {
    this._processedMarkerPositions.delete(panelId);
  }

  /**
   * Clean up all state for a panel on dispose.
   */
  clearPanel(panelId: string): void {
    this._processedMarkerPositions.delete(panelId);
    this._pendingAsks.delete(panelId);
    this._queuedMessages.delete(panelId);
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.stopInboundPolling();
    if (this._channelEventCleanup) {
      this._channelEventCleanup();
      this._channelEventCleanup = null;
    }
    this._processedMarkerPositions.clear();
    this._pendingAsks.clear();
    this._queuedMessages.clear();
    this._processedMessageIds.clear();
    this._trackedContacts.clear();
  }

  // --- Inbound Polling ---

  /**
   * Start polling for inbound messages via session history.
   * Called by ActiveModeManager after Gateway connects.
   */
  startInboundPolling(intervalMs: number = 10000): void {
    this.stopInboundPolling();
    this._lastPollTimestamp = Date.now();
    console.log(`[Mysti] ChannelBridge: Starting inbound polling (${intervalMs}ms interval)`);
    // Run first poll after a short delay to let Gateway stabilize
    setTimeout(() => this._pollForInboundMessages(), 2000);
    this._inboundPollTimer = setInterval(() => this._pollForInboundMessages(), intervalMs);
  }

  /**
   * Stop inbound message polling.
   */
  stopInboundPolling(): void {
    if (this._inboundPollTimer) {
      clearInterval(this._inboundPollTimer);
      this._inboundPollTimer = null;
      console.log('[Mysti] ChannelBridge: Stopped inbound polling');
    }
  }

  /**
   * Core polling logic: read session JSONL files directly from disk.
   * Uses ~/.openclaw/agents/main/sessions/sessions.json as index to find
   * channel-related sessions, then reads their JSONL files for new messages.
   */
  private async _pollForInboundMessages(): Promise<void> {
    if (!this._activeModeManager.isConnected()) { return; }
    await this._pollViaSessionFiles();
  }

  /**
   * Read OpenClaw session files for new inbound messages.
   *
   * Strategy:
   * 1. Read sessions.json index to find which sessions are channel-related
   * 2. For each channel session, read the JSONL file tail
   * 3. Parse new inbound messages and dispatch as ChannelEvents
   */
  private async _pollViaSessionFiles(): Promise<void> {
    const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');
    const indexPath = path.join(sessionsDir, 'sessions.json');

    try {
      // Step 1: Read sessions.json to find channel sessions
      let indexData: string;
      try {
        indexData = await fs.promises.readFile(indexPath, 'utf-8');
      } catch {
        return; // No index file — OpenClaw not installed or no sessions
      }

      const sessionsIndex = JSON.parse(indexData) as Record<string, Record<string, unknown>>;
      let totalNew = 0;

      const channelTypes = ['whatsapp', 'telegram', 'signal', 'slack', 'discord'];

      for (const [sessionKey, sessionInfo] of Object.entries(sessionsIndex)) {
        // Check if this session is channel-related via origin or deliveryContext metadata
        const origin = sessionInfo.origin as Record<string, unknown> | undefined;
        const delivery = sessionInfo.deliveryContext as Record<string, unknown> | undefined;
        const channelType = [
          origin?.provider, origin?.surface, delivery?.channel, sessionKey
        ].find(v => typeof v === 'string' && channelTypes.includes(v)) as string | undefined;
        if (!channelType) {
          continue;
        }

        // Check if session was updated since last poll
        const updatedAt = (sessionInfo.updatedAt || 0) as number;
        if (updatedAt <= this._lastPollTimestamp) { continue; }

        // Get session file path
        const sessionId = (sessionInfo.sessionId || '') as string;
        if (!sessionId) { continue; }
        const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

        try {
          const stat = await fs.promises.stat(sessionFile);
          if (stat.mtimeMs <= this._lastPollTimestamp) { continue; }

          // Read last 8KB to get recent entries (messages can be large)
          const size = stat.size;
          const readStart = Math.max(0, size - 8192);
          const fd = await fs.promises.open(sessionFile, 'r');
          const buffer = Buffer.alloc(Math.min(size, 8192));
          await fd.read(buffer, 0, buffer.length, readStart);
          await fd.close();

          const content = buffer.toString('utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          const startIdx = readStart > 0 ? 1 : 0; // skip partial first line

          for (let i = startIdx; i < lines.length; i++) {
            try {
              const entry = JSON.parse(lines[i]) as Record<string, unknown>;
              const parsed = this._parseSessionEntry(entry, channelType);
              if (parsed && !this._isDuplicate(parsed)) {
                // Only route messages from contacts we've actively messaged
                if (!this._isTrackedConversation(parsed.sender, parsed.channelType)) {
                  continue;
                }
                console.log(`[Mysti] ChannelBridge: Inbound poll detected message from ${parsed.sender || 'unknown'} on ${channelType}`);
                this._handleInboundChannelEvent(parsed);
                totalNew++;
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      this._lastPollTimestamp = Date.now();

      if (totalNew > 0) {
        console.log(`[Mysti] ChannelBridge: Inbound poll: ${totalNew} new messages from session files`);
      }
    } catch (err) {
      console.log('[Mysti] ChannelBridge: Session file poll error:', err);
    }
  }

  /**
   * Parse an OpenClaw JSONL session entry into a ChannelEvent if it's an inbound message.
   *
   * Format: {type:"message", message:{role:"user", content:[{type:"text", text:"..."}], timestamp:N}}
   * Inbound messages have conversation_label metadata in the text:
   *   Conversation info (untrusted metadata):\n```json\n{"conversation_label":"..."}\n```\n\nActual message
   */
  private _parseSessionEntry(entry: Record<string, unknown>, channelType: string): ChannelEvent | null {
    if (entry.type !== 'message') { return null; }

    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) { return null; }

    const role = message.role as string;
    if (role !== 'user') { return null; } // Only inbound (user) messages

    const timestamp = (message.timestamp || 0) as number;
    if (timestamp && timestamp <= this._lastPollTimestamp) { return null; } // Already seen

    // Extract text content from content array
    const contentArr = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(contentArr)) { return null; }

    const textPart = contentArr.find(c => c.type === 'text');
    if (!textPart) { return null; }
    let text = (textPart.text || '') as string;
    if (!text) { return null; }

    // Skip system messages (heartbeats, connection status)
    if (text.includes('HEARTBEAT_OK') || text.includes('Read HEARTBEAT.md')) { return null; }
    if (/^System:\s*\[/.test(text) && !text.includes('\n\n')) { return null; }

    // Extract sender from conversation_label metadata
    let sender: string | undefined;
    const metadataMatch = text.match(/Conversation info \(untrusted metadata\):\n```json\n([\s\S]*?)\n```\n\n([\s\S]*)/);
    if (metadataMatch) {
      try {
        const meta = JSON.parse(metadataMatch[1]) as Record<string, unknown>;
        sender = (meta.conversation_label || meta.from || meta.sender) as string | undefined;
      } catch { /* ignore parse errors */ }
      text = metadataMatch[2]; // Strip metadata, keep actual message
    }

    // Also strip system prefix lines (e.g., "System: [...] WhatsApp gateway connected.\n\n")
    text = text.replace(/^(?:System:\s*\[.*?\]\s*.*?\n\n)+/s, '').trim();
    if (!text) { return null; }

    return {
      channelId: channelType,
      channelType,
      eventType: 'message_received',
      content: text,
      sender,
      timestamp: timestamp || Date.now(),
    };
  }

  /**
   * Check if we've already processed this message (by content+timestamp hash).
   */
  private _isDuplicate(event: ChannelEvent): boolean {
    const id = `${event.timestamp}:${(event.content || '').substring(0, 50)}`;
    if (this._processedMessageIds.has(id)) { return true; }
    this._processedMessageIds.add(id);
    // Keep set bounded
    if (this._processedMessageIds.size > 500) {
      const entries = [...this._processedMessageIds];
      this._processedMessageIds = new Set(entries.slice(-250));
    }
    return false;
  }

  // --- Private helpers ---

  private _subscribeToChannelEvents(): void {
    this._channelEventCleanup = this._activeModeManager.subscribeToChannelEvents(
      (event: ChannelEvent) => this._handleInboundChannelEvent(event)
    );
  }

  private _handleInboundChannelEvent(event: ChannelEvent): void {
    if (event.eventType !== 'message_received' || !event.content) {
      return;
    }

    // Only process messages from contacts we've actively messaged
    if (!this._isTrackedConversation(event.sender, event.channelType)) {
      return;
    }

    const content = event.content;
    const channelId = event.channelId;
    const channelType = event.channelType;
    const sender = event.sender;

    // First, check if this reply matches a pending outbound ask
    const matchedAsk = this._tryMatchPendingAsk(channelId, channelType, content, sender);
    if (matchedAsk) {
      // Auto-trigger Claude with the reply if agent is idle
      if (this._delegate) {
        const panelId = matchedAsk.panelId;
        const channelName = this._formatChannelType(channelType);
        const senderLabel = sender ? ` from ${sender}` : '';
        const replyPrefix = `[Via ${channelName}${senderLabel} — reply to "${matchedAsk.question.substring(0, 80)}"]: `;

        if (!this._delegate.isRunning(panelId) && !this._delegate.hasPendingQuestion(panelId)) {
          console.log(`[Mysti] ChannelBridge: Auto-triggering Claude with reply to ask '${matchedAsk.askId}'`);
          this._delegate.injectChannelMessage(panelId, channelName, replyPrefix + content, sender);
        }
      }
      return;
    }

    // Route to the active panel via delegate
    if (!this._delegate) { return; }
    const panelId = this._delegate.getActivePanelId();
    if (!panelId) { return; }

    const channelName = this._formatChannelType(channelType);
    const senderLabel = sender ? ` from ${sender}` : '';

    // Scenario A: Agent waiting for user input
    if (this._delegate.hasPendingQuestion(panelId)) {
      const toolCallId = this._delegate.getPendingQuestionToolCallId(panelId);
      if (toolCallId) {
        const answerText = sender ? `[Via ${channelName} from ${sender}]: ${content}` : content;
        console.log(`[Mysti] ChannelBridge: Routing ${channelName}${senderLabel} reply as answer to pending question`);
        this._delegate.answerPendingQuestion(panelId, toolCallId, answerText);
        // Confirm receipt on channel (use sender as target — WhatsApp requires E.164)
        if (sender) {
          this._activeModeManager.sendToChannel(channelId, 'Got it, passing your answer to the agent.', sender);
        }
        return;
      }
    }

    // Scenario B: Agent is running
    if (this._delegate.isRunning(panelId)) {
      if (isCancelCommand(content)) {
        console.log(`[Mysti] ChannelBridge: Cancel command from ${channelName}${senderLabel}`);
        this._delegate.cancelPanelRequest(panelId);
        if (sender) {
          this._activeModeManager.sendToChannel(channelId, 'Request cancelled.', sender);
        }
      } else {
        // Queue for after current response
        console.log(`[Mysti] ChannelBridge: Queuing message from ${channelName}${senderLabel} for panel ${panelId}`);
        const queue = this._queuedMessages.get(panelId) || [];
        queue.push({ channelId, channelName, content, sender, timestamp: Date.now() });
        this._queuedMessages.set(panelId, queue);
      }
      return;
    }

    // Scenario C: Agent is idle — inject as new message
    console.log(`[Mysti] ChannelBridge: Injecting ${channelName}${senderLabel} message as new request`);
    this._delegate.injectChannelMessage(panelId, channelName, content, sender);
  }

  private _tryMatchPendingAsk(channelId: string, channelType: string, content: string, sender?: string): PendingAsk | null {
    // Search all panels for a matching pending ask
    for (const [_panelId, asks] of this._pendingAsks) {
      const channelAsks = asks.filter(a =>
        !a.reply && (a.channelId === channelId || a.channel === channelType)
      );
      if (channelAsks.length === 0) { continue; }

      // Prefer sender-aware matching when both sender and ask.to are available
      if (sender) {
        const senderLower = sender.toLowerCase();
        const senderMatch = channelAsks.find(a =>
          a.to && senderLower.includes(a.to.toLowerCase())
        );
        if (senderMatch) {
          senderMatch.reply = content;
          senderMatch.repliedAt = Date.now();
          console.log(`[Mysti] ChannelBridge: Matched reply from '${sender}' to ask '${senderMatch.askId}'`);
          return senderMatch;
        }
      }

      // Fall back to oldest channel-only match
      const fallback = channelAsks[0];
      fallback.reply = content;
      fallback.repliedAt = Date.now();
      console.log(`[Mysti] ChannelBridge: Matched reply to ask '${fallback.askId}' from ${channelType} (channel-only match)`);
      return fallback;
    }
    return null;
  }

  private _resolveChannelId(channelTypeOrId: string): string | null {
    const channels = this._activeModeManager.getChannels();
    console.log(`[Mysti] ChannelBridge: Resolving '${channelTypeOrId}' against ${channels.length} channels:`,
      channels.map(c => `${c.id}(type=${c.type},status=${c.status})`).join(', '));

    // Try exact ID match first
    const byId = channels.find(c => c.id === channelTypeOrId && c.status === 'connected');
    if (byId) { return byId.id; }
    // Try by type
    const byType = channels.find(c => c.type === channelTypeOrId && c.status === 'connected');
    return byType?.id || null;
  }

  private _getProcessedPositions(panelId: string): Set<number> {
    let positions = this._processedMarkerPositions.get(panelId);
    if (!positions) {
      positions = new Set();
      this._processedMarkerPositions.set(panelId, positions);
    }
    return positions;
  }

  private _resolveChannelTarget(channelTypeOrId: string): string | null {
    const channels = this._activeModeManager.getChannels();
    const channel = channels.find(c =>
      (c.id === channelTypeOrId || c.type === channelTypeOrId) && c.status === 'connected'
    );
    if (!channel?.metadata) { return null; }
    // Use phoneNumber (E.164) for WhatsApp/Signal, or other identifiers as available
    return (channel.metadata.phoneNumber as string) || null;
  }

  private _formatChannelName(channel: ChannelInfo): string {
    return channel.name || this._formatChannelType(channel.type);
  }

  private _formatChannelType(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  // --- Skills ---

  /**
   * Build a formatted list of available OpenClaw skills for prompt injection.
   * Falls back to a static summary if skills haven't been fetched yet.
   */
  private _buildSkillsList(): string {
    const skills = this._activeModeManager.getSkills();
    if (skills.length === 0) {
      return [
        '- Messaging (WhatsApp, Telegram, Slack, Discord, Signal, iMessage)',
        '- Web browsing, research, and summarization',
        '- GitHub (issues, PRs, CI runs)',
        '- Apple Notes & Reminders',
        '- Image generation',
        '- Weather forecasts',
        '- PDF editing',
        '- Audio transcription',
        '- macOS automation',
        '- And more — describe any task and OpenClaw will try to handle it',
      ].join('\n');
    }

    return skills.map(s => `- ${s.emoji} ${s.name}: ${s.description}`).join('\n');
  }

  // --- Contact tracking ---

  /**
   * Register a contact that Mysti has sent a message to.
   * Only messages from tracked contacts will be routed inbound.
   */
  private _trackContact(nameOrPhone: string, channel: string): void {
    const key = this._normalizeContactId(nameOrPhone);
    this._trackedContacts.set(key, {
      identifier: key,
      channel,
      sentAt: Date.now(),
    });
    console.log(`[Mysti] ChannelBridge: Tracking contact '${key}' on ${channel} for inbound replies`);
  }

  /**
   * Check if an inbound message sender matches a contact we've messaged.
   * Returns false for unknown senders — prevents random conversations
   * from being routed into the AI agent.
   */
  private _isTrackedConversation(sender: string | undefined, _channelType: string): boolean {
    if (!sender) { return false; }

    const now = Date.now();
    const senderNorm = this._normalizeContactId(sender);

    for (const [key, contact] of this._trackedContacts) {
      // Expire stale tracked contacts
      if (now - contact.sentAt > TRACKED_CONTACT_TTL_MS) {
        this._trackedContacts.delete(key);
        continue;
      }

      // Match by normalized identifier (case-insensitive, partial name match)
      if (key === senderNorm) { return true; }
      // Fuzzy: tracked "Sharif" matches sender "+962792552872" if we also
      // track by phone. And tracked "+962..." matches conversation_label "+962..."
      // Also support partial: tracked "sharif" matches sender "Sharif Abu Nada"
      if (senderNorm.includes(key) || key.includes(senderNorm)) { return true; }
    }

    return false;
  }

  /**
   * Normalize a contact identifier for matching.
   * Phone numbers keep their E.164 format, names are lowercased.
   */
  private _normalizeContactId(id: string): string {
    const trimmed = id.trim();
    if (trimmed.startsWith('+')) { return trimmed; } // E.164 phone
    return trimmed.toLowerCase();
  }
}
