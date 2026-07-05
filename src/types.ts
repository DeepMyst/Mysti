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

export type OperationMode = 'default' | 'ask-before-edit' | 'edit-automatically' | 'quick-plan' | 'detailed-plan';
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';
export type AccessLevel = 'read-only' | 'ask-permission' | 'full-access';
export type ContextMode = 'auto' | 'manual';
export type ProviderType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'cline' | 'github-copilot' | 'cursor' | 'openclaw' | 'opencode' | 'ollama' | 'localai' | 'qwen-code';
export type AutocompleteType = 'sentence' | 'paragraph' | 'message';

// Agent and Brainstorm types
export type AgentType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'cline' | 'github-copilot' | 'cursor' | 'openclaw' | 'opencode' | 'ollama' | 'localai' | 'qwen-code';
export type PersonaType = 'neutral' | 'architect' | 'pragmatist' | 'engineer' | 'reviewer' | 'designer' | 'custom';
export type BrainstormPhase = 'initial' | 'individual' | 'discussion' | 'synthesis' | 'complete';
export type CollaborationStrategy = 'quick' | 'debate' | 'red-team' | 'perspectives' | 'delphi';
// Backward compat alias
export type DiscussionMode = CollaborationStrategy;

// Discussion roles assigned by strategy (not user-configured)
export type DiscussionRole =
  | 'critic' | 'defender'          // debate strategy
  | 'proposer' | 'challenger'      // red-team strategy
  | 'risk-analyst' | 'innovator'   // perspectives strategy
  | 'facilitator' | 'refiner';     // delphi strategy

export interface ContextItem {
  id: string;
  type: 'file' | 'selection' | 'folder' | 'symbol';
  path: string;
  content?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
  /**
   * Plan 07: when false, the item stays in the context list (visible in the
   * panel) but is excluded from the prompt — the "deactivate" affordance.
   * Treated as enabled when undefined (back-compat).
   */
  enabled?: boolean;
}

export type AttachmentType = 'image' | 'file';

export interface Attachment {
  id: string;
  type: AttachmentType;
  fileName: string;
  mimeType: string;
  /** base64-encoded data (for images from clipboard) */
  base64Data?: string;
  /** Absolute file path (for dropped/pasted files from disk) */
  filePath?: string;
  /** Size in bytes */
  size: number;
}

// ============================================================================
// Persisted message anatomy (Plan 02 Phase 3)
//
// Restored conversations must replay through the same renderer as live
// streams. To make that possible each assistant Message can carry:
//   - provider/model  — per-message attribution (survives provider switches;
//                       legacy messages fall back to Conversation.provider/model)
//   - toolCalls       — the resolved tool cards (inputs/outputs capped at
//                       persistence time, see ConversationManager)
//   - thinking        — legacy plain string OR { style, content } so the
//                       renderer picks the right thinking widget without
//                       consulting the manifest
//   - segments        — ordered render segments (below)
//
// ALL of these fields are optional: conversations persisted before this
// change load unchanged.
// ============================================================================

/** Mirrors ProviderCapabilities.thinkingStyle minus 'none' (no thinking ⇒ no value). */
export type MessageThinkingStyle = 'streamed' | 'complete-blocks';

export interface MessageThinking {
  /** How the provider streamed reasoning — drives the thinking widget shape. */
  style: MessageThinkingStyle;
  content: string;
}

/**
 * One ordered render segment of an assistant message.
 *
 * Segments record the interleaving order in which content streamed so the
 * webview can replay a restored message exactly as it appeared live:
 *   - 'text'     — a contiguous run of body markdown (consecutive text chunks
 *                  are merged into one segment)
 *   - 'thinking' — a contiguous run of reasoning content (merged likewise)
 *   - 'tool'     — a tool card, referenced by id into Message.toolCalls
 *                  (exactly one segment per tool call, emitted at the
 *                  position the tool_use first appeared in the stream)
 *
 * Invariants: concatenating all 'text' segment contents equals
 * Message.content; concatenating all 'thinking' segment contents equals the
 * message's thinking content; every 'tool' toolCallId resolves to an entry
 * in Message.toolCalls. Messages without segments (legacy) render as one
 * flat thinking block + body + tool list.
 */
export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; toolCallId: string };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  context?: ContextItem[];
  attachments?: Attachment[];
  /**
   * Reasoning content. Legacy persisted conversations store a plain string;
   * Plan 02 Phase 3 writes { style, content } when the provider's
   * thinkingStyle is known. Renderers must handle both shapes.
   */
  thinking?: string | MessageThinking;
  toolCalls?: ToolCall[];
  /** Provider that produced this message (assistant messages, Plan 02 Phase 3). */
  provider?: ProviderType;
  /** Model that produced this message (assistant messages, Plan 02 Phase 3). */
  model?: string;
  /** Ordered render segments for exact stream replay (see MessageSegment). */
  segments?: MessageSegment[];
  /**
   * Shadow-repo code checkpoint captured just before this user turn ran
   * (anchors "rewind code to here"). Present only on user messages when the
   * checkpoint engine is available; optional ⇒ old conversations load unchanged.
   */
  checkpoint?: { commit: string; createdAt: number };
}

export interface DiffLine {
  type: 'addition' | 'deletion' | 'context';
  content: string;
  lineNum?: number;
}

export interface FileChangeInfo {
  action: 'create' | 'edit' | 'delete';
  filePath: string;
  fileName: string;
  linesAdded: number;
  linesRemoved: number;
  diffLines: DiffLine[];
}

/**
 * ACP-style semantic tool kind (Plan 02): lets the webview render one
 * icon/card system instead of inferring from raw per-CLI tool names.
 * Populated at parse time by each provider (Plan 02 Phase 3).
 */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  fileChange?: FileChangeInfo;
  /** Semantic kind for provider-agnostic rendering (optional until Phase 3 stamps it) */
  kind?: ToolCallKind;
  /**
   * Set by ConversationManager at persistence time when input/output strings
   * exceeded the storage cap and were cut (Plan 03 Phase 6 stopgap — see
   * PERSISTED_TOOL_STRING_CAP in ConversationManager). Live-streamed tool
   * calls never carry this flag.
   */
  truncated?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  mode: OperationMode;
  model: string;
  provider: ProviderType;
  agentConfig?: AgentConfiguration;
}

export interface Settings {
  mode: OperationMode;
  thinkingLevel: ThinkingLevel;
  accessLevel: AccessLevel;
  contextMode: ContextMode;
  model: string;
  provider: ProviderType;
  autonomousMode?: boolean;
}

export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
  icon?: string;
}

export type SuggestionColor = 'blue' | 'green' | 'purple' | 'orange' | 'indigo' | 'red' | 'teal' | 'pink' | 'amber';

export interface QuickActionSuggestion {
  id: string;
  title: string;        // Short title (3-5 words)
  description: string;  // Brief description (10-15 words)
  message: string;      // Full prompt to send when clicked
  icon: string;         // Single emoji
  color: SuggestionColor;
}

/** @deprecated Use SlashCommandDefinition instead */
export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => string;
}

// ============================================================================
// Slash Command Menu System
// ============================================================================

export type SlashCommandSection = 'context' | 'model' | 'customize' | 'commands' | 'settings' | 'support';
export type SlashCommandAction = 'execute' | 'submenu' | 'external';

export interface SlashCommandDefinition {
  /** Unique command identifier, e.g. 'cmd:clear', 'claude:compact' */
  id: string;
  /** Display label in the menu */
  label: string;
  /** Description shown as subtitle/tooltip */
  description: string;
  /** Which section this command belongs to */
  section: SlashCommandSection;
  /** Optional icon - codicon name (e.g. 'trash', 'terminal') */
  icon?: string;
  /** Which provider this command is for. 'all' = universal command */
  provider: ProviderType | 'all';
  /** Current value to show on the right side (e.g. "Opus 4.6") */
  currentValue?: string;
  /** Whether this item shows a toggle switch */
  isToggle?: boolean;
  /** Current toggle state (only meaningful when isToggle is true) */
  toggleState?: boolean;
  /** What happens on click */
  action: SlashCommandAction;
  /** For 'external' action, the URL to open */
  url?: string;
  /** Whether this is a provider-native CLI command (passed through to CLI stdin) */
  isCliPassthrough?: boolean;
  /** Search keywords for fuzzy matching beyond label/description */
  keywords?: string[];
}

export interface SlashCommandSectionInfo {
  id: SlashCommandSection;
  label: string;
  order: number;
}

export interface WebviewMessage {
  type: string;
  payload?: unknown;
}

// ============================================================================
// Typed webview message contracts (Plan 02 Phase 1)
// New extension→webview messages get compile-time shapes; legacy messages
// stay on the loose WebviewMessage type until the full discriminated-union
// migration (Plan 02 Open Question 6).
// ============================================================================

/**
 * Provider Manifest payload — posted inside `initialState` (as
 * `payload.providerManifest`) and as the full payload of `manifestUpdated`.
 * schemaVersion guards cached webviews against message-shape skew.
 */
export interface ProviderManifestPayload {
  schemaVersion: number;
  providers: import('./providers/base/IProvider').ProviderManifestEntry[];
}

export interface ManifestUpdatedMessage {
  type: 'manifestUpdated';
  payload: ProviderManifestPayload;
}

/** Streaming heartbeat phase (Plan 02 Phase 7, GitHub #31) */
export type StreamStatusPhase = 'waiting-first-token' | 'thinking' | 'tool-running' | 'generating';

/**
 * Heartbeat posted by the extension while a stream is silent (>10s) so the
 * user always sees that something is happening.
 */
export interface StreamStatusPayload {
  panelId: string;
  phase: StreamStatusPhase;
  /** Milliseconds since the last chunk arrived */
  silentMs: number;
  /** Milliseconds since the stream started */
  elapsedMs: number;
  /** Set when phase === 'tool-running' */
  toolName?: string;
}

export interface StreamStatusMessage {
  type: 'streamStatus';
  payload: StreamStatusPayload;
}

/**
 * Plan 01 — extension→webview model list push (Phase 4 consumer wiring).
 * Posted to all panels when the ModelRegistryService fires onDidUpdateModels;
 * each panel filters by its active provider. Declared here in Phase 1 so the
 * consumer agent codes against a stable shape.
 */
export interface ModelsUpdatedPayload {
  provider: string;
  models: ModelEntry[];
  defaultModel: string;
  discoveryStatus: ProviderModelState['discoveryStatus'];
  fetchedAt: number;
}

export interface ModelsUpdatedMessage {
  type: 'modelsUpdated';
  payload: ModelsUpdatedPayload;
}

/**
 * Plan 01 — webview→extension request to (re)fresh a provider's model list
 * (dropdown focus / provider switch / explicit "Refresh models"). `force`
 * bypasses TTL and is only set by the explicit refresh action.
 */
export interface RequestModelsPayload {
  provider: string;
  force?: boolean;
}

export interface RequestModelsMessage {
  type: 'requestModels';
  payload: RequestModelsPayload;
}

/** Union of the new, strictly-typed extension→webview messages */
export type TypedWebviewMessage = ManifestUpdatedMessage | StreamStatusMessage | ModelsUpdatedMessage;

export interface ProviderConfig {
  name: string;
  displayName: string;
  models: ModelInfo[];
  defaultModel: string;
}

export interface ProviderAvailability {
  available: boolean;
  installCommand?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  /**
   * Plan 01 — provenance of the entry once the ModelRegistryService is wired:
   *   'curated'    — bundled per-provider config.models / remote curated feed
   *   'discovered' — live CLI/HTTP discovery (Phase 3+)
   *   'custom'     — user-defined (mysti.customModels / per-provider setting)
   * Optional so existing ModelInfo literals (provider config arrays) stay valid.
   */
  source?: 'curated' | 'discovered' | 'custom';
  /** Curated feed can mark sunset models for de-emphasis in the UI. */
  deprecated?: boolean;
}

/**
 * Plan 01 — a model entry as served by the ModelRegistryService (a ModelInfo
 * with provenance always populated). Alias kept distinct from ModelInfo so the
 * registry's merged output is typed precisely while provider config arrays
 * continue to use the looser ModelInfo (source optional).
 */
export interface ModelEntry extends ModelInfo {
  source: 'curated' | 'discovered' | 'custom';
}

/**
 * Plan 01 — the merged per-provider view the registry answers synchronously.
 * `fetchedAt === 0` means "bundled curated only, never discovered".
 */
export interface ProviderModelState {
  models: ModelEntry[];
  defaultModel: string;
  fetchedAt: number;
  discoveryStatus: 'discovered' | 'cached' | 'fallback' | 'unsupported';
}

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ============================================================================
// Compaction System Types
// ============================================================================

export type CompactionStrategy = 'native-cli' | 'client-summarize';
export type CompactionStatus = 'idle' | 'evaluating' | 'compacting' | 'complete' | 'error';

/**
 * Cumulative token usage tracked per panel session
 */
export interface CumulativeUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  messageCount: number;
  lastUpdated: number;
}

/**
 * Compaction event sent to the webview
 */
export interface CompactionEvent {
  status: CompactionStatus;
  strategy: CompactionStrategy;
  beforeTokens: number;
  afterTokens?: number;
  contextWindow: number;
  threshold: number;
  summary?: string;
  error?: string;
}

/**
 * Compaction result from a completed compaction
 */
export interface CompactionResult {
  success: boolean;
  beforeTokens: number;
  afterTokens: number;
  strategy: CompactionStrategy;
  duration: number;
  summary?: string;
  error?: string;
}

// ============================================================================
// Smart Compaction Types (Plan 08, DeepMyst-gated)
// ============================================================================

/** Whether the prompt cache is still warm (observational; cache-reporting providers only). */
export type CacheWarmth = 'warm' | 'cold' | 'unknown';

/** The decision the smart engine returns for a panel after a response. */
export interface CompactionDecision {
  /** Whether to act now. */
  act: boolean;
  /** What action: do nothing, free tool-result prune, or a full compaction pass. */
  tier: 'none' | 'prune' | 'compact';
  /** Human-readable rationale (shown in logs / the savings popover). */
  reason: string;
  /** True when a compaction is warranted by fill but deferred to wait for a cold cache. */
  deferred: boolean;
  warmth: CacheWarmth;
  /** Economic break-even turn count N* (when computable). */
  breakEvenTurns?: number;
  /** Estimated remaining turns N used in the decision. */
  remainingTurns?: number;
  /** Projected USD saved if we act now (when computable). */
  projectedSavingsUsd?: number;
}

/** Kinds of realized savings the ledger tracks. */
export type SavingsKind = 'cheap-model' | 'cache-timing' | 'avoided-compaction' | 'prune' | 'retrieval';

/** A single realized-savings event (counted only after the action happened). */
export interface SavingsEvent {
  kind: SavingsKind;
  tokensSaved: number;
  usdSaved: number;
  /** True when the figure is an estimate (e.g. cache-timing), false when grounded in a billed cost. */
  estimated: boolean;
  at: number;
}

export interface SavingsTotals {
  tokens: number;
  usd: number;
}

/** Snapshot pushed to the webview for the always-on savings chip. */
export interface SavingsSnapshot {
  session: SavingsTotals;
  lifetime: SavingsTotals;
  byKind: Partial<Record<SavingsKind, SavingsTotals>>;
  /** Whether any figure is an estimate (so the UI can show "~"). */
  estimated: boolean;
  /** Remaining free-tier smart compactions this month, when the entitlement endpoint reports it. */
  freeRemaining?: number;
  freeLimit?: number;
}

/** Structured incremental-memory sections the compactor agent maintains. */
export type MemorySectionKey = 'goal' | 'decisions' | 'files' | 'code' | 'open-threads';

/** A section-scoped patch the cheap compactor model returns (applied deterministically). */
export interface MemoryPatch {
  section: MemorySectionKey;
  op: 'append' | 'replace' | 'remove';
  content: string;
}

/** Result of an entitlement check (paid OR within the free monthly allowance). */
export interface EntitlementState {
  entitled: boolean;
  tier: string;
  freeRemaining?: number;
  freeLimit?: number;
  /** 'endpoint' when /api/v1/me answered; 'fallback' when it 404'd / was unreachable. */
  source: 'endpoint' | 'fallback';
  checkedAt: number;
}

/** A completion returned by the DeepMyst gateway client. */
export interface GatewayCompletion {
  text: string;
  /** Real billed cost from the X-DeepMyst-Cost-USD response header, when present. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** True when the gateway call failed and the caller should fall back. */
  failed?: boolean;
  error?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface AskUserQuestionData {
  toolCallId: string;
  questions: AskUserQuestionItem[];
  /** Where this question originated: 'tool' (explicit CLI tool) or 'detected' (AI-classified from response text) */
  source?: 'tool' | 'detected';
  /** Assistant message ID (populated for detected questions) */
  messageId?: string;
}

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'auth_error' | 'done' | 'session_active' | 'ask_user_question' | 'exit_plan_mode' | 'compaction';
  content?: string;
  toolCall?: ToolCall;
  sessionId?: string;
  usage?: UsageStats;
  askUserQuestion?: AskUserQuestionData;
  planFilePath?: string | null;
  compactionEvent?: CompactionEvent;
  // Auth error specific fields
  authCommand?: string;
  providerName?: string;
}

// Brainstorm mode configuration
export interface BrainstormConfig {
  enabled: boolean;
  agents: AgentType[];
  strategy: CollaborationStrategy;
  maxDiscussionRounds: number;
  autoConverge: boolean;
  synthesisAgent: AgentType;
  /** @deprecated Use strategy instead */
  discussionMode?: DiscussionMode;
  /** @deprecated Use maxDiscussionRounds instead */
  discussionRounds?: 1 | 2 | 3;
}

// Convergence tracking for discussion phase
export interface ConvergenceMetrics {
  round: number;
  agreementCount: number;
  disagreementCount: number;
  agreementRatio: number;
  positionStability: Map<AgentType, number>;
  overallConvergence: number;
  recommendation: 'continue' | 'converged' | 'stalled';
}

// Agent persona configuration
export interface AgentPersonaConfig {
  type: PersonaType;
  customPrompt?: string;
}

// Agent configuration for brainstorm
export interface AgentConfig {
  id: AgentType;
  displayName: string;
  color: string;
  icon: string;
  persona: AgentPersonaConfig;
  discussionRole?: DiscussionRole;
}

// Individual agent response in brainstorm
export interface AgentResponse {
  agentId: AgentType;
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  status: 'pending' | 'streaming' | 'complete' | 'error';
  timestamp: number;
}

// Discussion round in brainstorm
export interface DiscussionRound {
  roundNumber: number;
  contributions: Map<AgentType, string>;
  roleAssignments: Map<AgentType, DiscussionRole>;
  convergence?: ConvergenceMetrics;
}

// Brainstorm session state
export interface BrainstormSession {
  id: string;
  query: string;
  phase: BrainstormPhase;
  strategy: CollaborationStrategy;
  agents: AgentConfig[];
  agentResponses: Map<AgentType, AgentResponse>;
  discussionRounds: DiscussionRound[];
  convergenceHistory: ConvergenceMetrics[];
  unifiedSolution: string | null;
  createdAt: number;
  updatedAt: number;
}

// Streaming chunk for brainstorm mode
export interface BrainstormStreamChunk {
  type: 'agent_text' | 'agent_thinking' | 'agent_complete' | 'agent_error' |
        'agent_status' |
        'discussion_text' | 'discussion_round_start' | 'discussion_error' |
        'convergence_update' |
        'synthesis_text' | 'synthesis_fallback' | 'phase_change' | 'done';
  agentId?: AgentType;
  content?: string;
  phase?: BrainstormPhase;
  usage?: UsageStats;
  discussionRole?: DiscussionRole;
  roundNumber?: number;
  convergence?: ConvergenceMetrics;
  strategy?: CollaborationStrategy;
  /** agent_status (Plan 02 Phase 7 warn-then-wait): how long the agent has been silent */
  silentMs?: number;
  /** agent_status: total elapsed time for the agent's turn */
  elapsedMs?: number;
}

// ============================================================================
// @-Mention Types
// ============================================================================

export type MentionType = 'agent' | 'file';

export interface Mention {
  type: MentionType;
  value: string;        // provider ID ('google-gemini') or file path
  displayName: string;  // '@gemini' or '@types.ts'
  startIndex: number;   // Position in message string
  endIndex: number;
}

export interface SubAgentResponse {
  agentId: AgentType;
  content: string;
  thinking?: string;
  status: 'pending' | 'streaming' | 'complete' | 'error';
  error?: string;
}

export type MentionTaskType = 'execute' | 'switch';

export interface MentionTask {
  agent: AgentType;
  task: string;
  taskType: MentionTaskType;
  order: number;
  dependsOnPrevious: boolean;
}

export interface MentionTaskList {
  tasks: MentionTask[];
  confidence: number;
  originalContent: string;
  strippedContent: string;
}

export interface MentionStreamChunk {
  type: 'task_list_generated' | 'task_started' | 'task_complete' |
        'subagent_started' | 'subagent_text' | 'subagent_thinking' |
        'subagent_tool_use' | 'subagent_tool_result' |
        'subagent_complete' | 'subagent_error' | 'subagent_retry' |
        'subagent_ask_user_question' |
        'files_resolved' | 'file_resolution_warning' |
        'mentions_truncated' | 'main_tasks' | 'main_start';
  agentId?: AgentType;
  content?: string;
  resolvedFiles?: ContextItem[];
  toolCall?: ToolCall;
  taskList?: MentionTaskList;
  taskIndex?: number;
  taskDescription?: string;
  hasError?: boolean;
  retryCount?: number;
  mainProviderTasks?: MentionTask[];
  askUserQuestion?: AskUserQuestionData;
}

/**
 * Callback for sub-agent questions that need user interaction.
 * Returns the user's answers, or null if skipped.
 */
export type SubAgentQuestionCallback = (
  agentId: AgentType,
  questionData: AskUserQuestionData
) => Promise<{ answers: Record<string, string | string[]> } | null>;

// ============================================================================
// Permission System Types
// ============================================================================

export type PermissionActionType =
  | 'file-read'
  | 'file-create'
  | 'file-edit'
  | 'file-delete'
  | 'bash-command'
  | 'web-request'
  | 'multi-file-edit';

export type PermissionStatus = 'pending' | 'approved' | 'denied' | 'expired';

export type PermissionTimeoutBehavior = 'auto-accept' | 'auto-reject' | 'require-action' | 'semi-autonomous';

export type PermissionRiskLevel = 'low' | 'medium' | 'high';

export interface PermissionConfig {
  timeout: number;                         // Seconds (0 = no timeout)
  timeoutBehavior: PermissionTimeoutBehavior;
  semiAutonomousTimeout: number;           // Seconds for semi-autonomous countdown
}

export interface PermissionDetails {
  // For file operations
  filePath?: string;
  fileName?: string;
  linesAdded?: number;
  linesRemoved?: number;
  diffPreview?: DiffLine[];

  // For bash commands
  command?: string;
  workingDirectory?: string;

  // For multi-file operations
  files?: Array<{
    path: string;
    action: 'create' | 'edit' | 'delete';
  }>;

  // Risk level indicator
  riskLevel: PermissionRiskLevel;

  // Whether the CLI process was suspended via SIGSTOP (true = tool cannot execute until approved)
  suspended?: boolean;
}

export interface PermissionRequest {
  id: string;
  actionType: PermissionActionType;
  title: string;              // e.g., "Edit file"
  description: string;        // e.g., "Add onClick handler to Button component"
  details: PermissionDetails;
  status: PermissionStatus;
  createdAt: number;
  expiresAt: number;          // Timestamp for timeout (0 = no expiry)
  toolCallId?: string;        // Link to originating tool call
  semiAutonomous?: boolean;   // True when AI will decide on timeout
}

export interface PermissionResponse {
  requestId: string;
  decision: 'approve' | 'deny' | 'always-allow';
  scope?: 'this-action' | 'session';
}

// ============================================================================
// Plan Selection Types
// ============================================================================

export interface PlanOption {
  id: string;
  title: string;              // "Option A: Microservices"
  summary: string;            // Brief description (2-3 sentences)
  approach: string;           // Full approach details
  pros: string[];             // Advantages
  cons: string[];             // Trade-offs
  complexity: 'low' | 'medium' | 'high';
  icon: string;               // Emoji icon
  color: SuggestionColor;
}

export interface PlanDetectionResult {
  hasPlanOptions: boolean;
  options: PlanOption[];
  context: string;            // Original AI explanation before options
}

export interface PlanSelectionResult {
  selectedPlan: PlanOption;
  originalQuery: string;
  messageId: string;          // Reference to assistant message containing options
  executionMode: OperationMode;
  customInstructions?: string;
}

// ============================================================================
// AI Response Classification Types
// ============================================================================

export type QuestionInputType = 'select' | 'radio' | 'checkbox' | 'text';

export interface QuestionOption {
  id: string;
  label: string;              // "Delete them completely"
  description?: string;       // Optional longer description
  value: string;              // The value to send back
}

export interface ClarifyingQuestion {
  id: string;
  question: string;           // "What should we do with the analysis documents?"
  inputType: QuestionInputType;
  options?: QuestionOption[]; // For select/radio/checkbox
  placeholder?: string;       // For text input
  required: boolean;
  questionType?: 'clarifying' | 'meta'; // Type: clarifying (pre-plan) or meta (post-plan)
}

export interface ResponseClassification {
  // Any clarifying questions the AI is asking
  questions: ClarifyingQuestion[];

  // Implementation plan options (if presenting approaches)
  planOptions: PlanOption[];

  // The main content context (text before questions/options)
  context: string;
}

export interface QuestionAnswer {
  questionId: string;
  value: string | string[];   // Single value or array for checkbox
}

export interface QuestionSubmission {
  messageId: string;
  answers: QuestionAnswer[];
}

// ============================================================================
// Agent Configuration Types (Personas + Skills)
// ============================================================================

/**
 * 16 Developer Personas - specialized agent behavior profiles
 */
export type DeveloperPersonaId =
  | 'architect'
  | 'prototyper'
  | 'product-centric'
  | 'refactorer'
  | 'devops'
  | 'domain-expert'
  | 'researcher'
  | 'builder'
  | 'debugger'
  | 'integrator'
  | 'mentor'
  | 'designer'
  | 'fullstack'
  | 'security'
  | 'performance'
  | 'toolsmith';

/**
 * 12 Toggleable Skills - behavioral modifiers
 */
export type SkillId =
  | 'concise'
  | 'repo-hygiene'
  | 'organized'
  | 'auto-commit'
  | 'first-principles'
  | 'auto-compact'
  | 'dependency-aware'
  | 'graceful-degradation'
  | 'scope-discipline'
  | 'doc-reflexes'
  | 'test-driven'
  | 'rollback-ready';

/**
 * Developer persona definition with instructions
 */
export interface DeveloperPersona {
  id: DeveloperPersonaId;
  name: string;
  description: string;
  keyCharacteristics: string;
  icon: string;
}

/**
 * Skill definition with instructions
 */
export interface Skill {
  id: SkillId;
  name: string;
  description: string;
  instructions: string;
}

/**
 * Agent configuration for a conversation (persisted per-conversation)
 */
export interface AgentConfiguration {
  personaId: DeveloperPersonaId | null;
  enabledSkills: SkillId[];
}

// ============================================================================
// Setup & Authentication Types
// ============================================================================

/**
 * Setup step in the auto-setup flow
 */
export type SetupStep = 'checking' | 'installing' | 'authenticating' | 'ready' | 'failed';

/**
 * Error classification for install failures
 */
export type InstallErrorCategory =
  | 'permission'      // EACCES, EPERM - global npm dir not writable
  | 'network'         // ENOTFOUND, ETIMEDOUT, fetch failed
  | 'version'         // Node.js too old
  | 'not-found'       // npm not available
  | 'command-failed'  // Non-zero exit, unclassified
  | 'timeout'         // Command timed out
  | 'unknown';

/**
 * Authentication status for a provider
 */
export interface AuthStatus {
  authenticated: boolean;
  user?: string;
  error?: string;
}

/**
 * Result of auto-install attempt
 */
export interface InstallResult {
  success: boolean;
  error?: string;
  requiresManual?: boolean;
  errorCategory?: InstallErrorCategory;
  errorDetails?: string;        // stderr output for diagnostics
  suggestedFix?: string;        // user-facing fix suggestion
  retryable?: boolean;          // whether retry makes sense
  attemptNumber?: number;       // which attempt this was
}

/**
 * Alternative install method for providers that support non-npm installs
 */
export interface InstallMethod {
  id: string;           // 'npm', 'brew', 'curl', 'manual'
  label: string;        // 'npm (recommended)'
  command: string;      // actual command string
  platform?: 'darwin' | 'linux' | 'win32' | 'all';
  priority: number;     // lower = try first
}

/**
 * Diagnostic result for troubleshooting install issues
 */
export interface DiagnosticResult {
  timestamp: number;
  platform: {
    os: string;
    arch: string;
    shell: string;
    hasNvm: boolean;
  };
  npmStatus: {
    available: boolean;
    version?: string;
    prefix?: string;
    canWriteGlobalDir: boolean;
  };
  nodeStatus: {
    available: boolean;
    version?: string;
    meetsMinimum: boolean;
  };
  providers: Array<{
    id: string;
    displayName: string;
    installed: boolean;
    version?: string;
    authenticated: boolean;
    error?: string;
  }>;
  networkReachable: boolean;
  recommendations: string[];
}

/**
 * Result of full setup flow
 */
export interface SetupResult {
  success: boolean;
  installed: boolean;
  authenticated: boolean;
  error?: string;
  requiresManualStep?: 'install' | 'auth';
  errorCategory?: InstallErrorCategory;
  suggestedFix?: string;
}

/**
 * Setup status for a provider
 */
export interface ProviderSetupStatus {
  providerId: string;
  displayName: string;
  installed: boolean;
  authenticated: boolean;
  installing?: boolean;
  authenticating?: boolean;
  error?: string;
}

// Setup-related webview message types
export interface SetupProgressMessage {
  type: 'setupProgress';
  payload: {
    step: SetupStep;
    providerId: string;
    message: string;
    progress?: number;  // 0-100 for progress bar
  };
}

export interface SetupCompleteMessage {
  type: 'setupComplete';
  payload: {
    providerId: string;
  };
}

export interface SetupFailedMessage {
  type: 'setupFailed';
  payload: {
    providerId: string;
    error: string;
    canRetry: boolean;
    requiresManual?: boolean;
  };
}

export interface AuthPromptMessage {
  type: 'authPrompt';
  payload: {
    providerId: string;
    displayName: string;
    message: string;
  };
}

export interface AuthConfirmMessage {
  type: 'authConfirm';
  payload: {
    providerId: string;
  };
}

export interface AuthSkipMessage {
  type: 'authSkip';
  payload: {
    providerId: string;
  };
}

export interface RetrySetupMessage {
  type: 'retrySetup';
  payload: {
    providerId: string;
  };
}

export interface SkipSetupMessage {
  type: 'skipSetup';
}

export interface CheckSetupMessage {
  type: 'checkSetup';
}

export interface SetupStatusMessage {
  type: 'setupStatus';
  payload: {
    providers: ProviderSetupStatus[];
    npmAvailable: boolean;
    anyReady: boolean;
  };
}

// ============================================================================
// Setup Wizard Types (Enhanced Onboarding)
// ============================================================================

/**
 * Setup wizard step for granular progress
 */
export type WizardSetupStep = 'checking' | 'downloading' | 'installing' | 'verifying' | 'authenticating' | 'complete' | 'failed';

/**
 * Extended provider status for wizard UI with detailed info
 */
export interface WizardProviderStatus extends ProviderSetupStatus {
  cliVersion?: string;
  installCommand: string;
  authCommand: string;
  authInstructions: string[];
  docsUrl?: string;
  setupStep?: WizardSetupStep;
  setupProgress?: number;
  setupMessage?: string;
  supportsAutoInstall?: boolean;
}

/**
 * Auth method types for providers with multiple options
 */
export type AuthMethodType = 'oauth' | 'api-key' | 'gca' | 'cli-login';

/**
 * Auth option for providers with multiple authentication methods (e.g., Gemini)
 */
export interface AuthOption {
  id: string;
  label: string;
  description: string;
  icon: string;
  action: AuthMethodType;
}

/**
 * Show wizard message - sent when no providers are ready
 */
export interface ShowWizardMessage {
  type: 'showWizard';
  payload: {
    providers: WizardProviderStatus[];
    npmAvailable: boolean;
    nodeVersion?: string;
    anyReady: boolean;
  };
}

/**
 * Update wizard status message
 */
export interface WizardStatusMessage {
  type: 'wizardStatus';
  payload: {
    providers: WizardProviderStatus[];
    npmAvailable: boolean;
    anyReady: boolean;
  };
}

/**
 * Provider setup step progress message
 */
export interface ProviderSetupStepMessage {
  type: 'providerSetupStep';
  payload: {
    providerId: string;
    step: WizardSetupStep;
    progress: number;
    message: string;
    details?: string;
    errorCategory?: InstallErrorCategory;
    suggestedFix?: string;
    retryable?: boolean;
    alternativeCommands?: Array<{ label: string; command: string }>;
  };
}

/**
 * Auth options message for providers with multiple auth methods
 */
export interface AuthOptionsMessage {
  type: 'authOptions';
  payload: {
    providerId: string;
    displayName: string;
    options: AuthOption[];
  };
}

/**
 * Select auth method message from webview
 */
export interface SelectAuthMethodMessage {
  type: 'selectAuthMethod';
  payload: {
    providerId: string;
    method: AuthMethodType;
    apiKey?: string;
  };
}

/**
 * Start provider setup message from webview
 */
export interface StartProviderSetupMessage {
  type: 'startProviderSetup';
  payload: {
    providerId: string;
    autoInstall?: boolean;
  };
}

/**
 * Select provider as default and close wizard
 */
export interface SelectProviderMessage {
  type: 'selectProvider';
  payload: {
    providerId: string;
  };
}

/**
 * Dismiss wizard message
 */
export interface DismissWizardMessage {
  type: 'dismissWizard';
  payload?: {
    dontShowAgain?: boolean;
  };
}

/**
 * Wizard complete message - provider selected, close wizard
 */
export interface WizardCompleteMessage {
  type: 'wizardComplete';
  payload: {
    providerId: string;
  };
}

/**
 * Wizard dismissed message - user skipped setup
 */
export interface WizardDismissedMessage {
  type: 'wizardDismissed';
}

// ============================================================================
// Agent System Types (Three-Tier Loading)
// ============================================================================

/**
 * Agent source location
 */
export type AgentSource = 'core' | 'plugin' | 'user' | 'workspace';

/**
 * Agent type discriminator
 */
export type AgentTypeDiscriminator = 'persona' | 'skill';

/**
 * Loading tier level for progressive disclosure
 */
export type AgentLoadingTier = 'metadata' | 'instructions' | 'full';

/**
 * Tier 1: Minimal metadata for UI display (always loaded)
 */
export interface AgentMetadataInfo {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category: string;
  source: AgentSource;
  activationTriggers?: string[];
}

/**
 * Recommendation confidence level
 */
export type RecommendationConfidence = 'high' | 'medium' | 'low';

/**
 * Agent recommendation with context
 */
export interface AgentRecommendationInfo {
  agent: AgentMetadataInfo;
  type: AgentTypeDiscriminator;
  confidence: RecommendationConfidence;
  matchedTriggers: string[];
  reason: string;
}

/**
 * Webview message for agent recommendations
 */
export interface AgentRecommendationsMessage {
  type: 'agentRecommendations';
  payload: {
    recommendations: AgentRecommendationInfo[];
    query: string;
  };
}

/**
 * Webview message for selecting a recommended agent
 */
export interface SelectAgentMessage {
  type: 'selectAgent';
  payload: {
    agentId: string;
    agentType: AgentTypeDiscriminator;
  };
}

/**
 * Webview message for agent details request
 */
export interface GetAgentDetailsMessage {
  type: 'getAgentDetails';
  payload: {
    agentId: string;
  };
}

/**
 * Webview message for agent details response
 */
export interface AgentDetailsMessage {
  type: 'agentDetails';
  payload: {
    agentId: string;
    name: string;
    description: string;
    instructions: string;
    bestPractices?: string[];
    antiPatterns?: string[];
    codeExamples?: string;
  };
}

// ============================================================================
// Autonomous Mode Types
// ============================================================================

export type AutonomousDecisionType = 'permission-approve' | 'permission-deny' | 'question-answer' | 'action-blocked';
export type SafetyLevel = 'safe' | 'caution' | 'blocked';
export type AutonomousSafetyMode = 'conservative' | 'balanced' | 'aggressive';
export type AutonomousContinuationMode = 'goal' | 'task-queue';

/**
 * Record of an autonomous decision made on behalf of the user
 */
export interface AutonomousDecision {
  id: string;
  timestamp: number;
  type: AutonomousDecisionType;
  safetyLevel: SafetyLevel;
  description: string;
  reasoning: string;
  decision: string;
  memoryUsed: string[];
}

/**
 * Session statistics for autonomous mode
 */
export interface AutonomousSessionStats {
  startTime: number;
  duration: number;
  permissionsApproved: number;
  permissionsDenied: number;
  questionsAnswered: number;
  actionsBlocked: number;
  tasksCompleted: number;
  totalDecisions: number;
}

/**
 * Configuration for autonomous mode behavior
 */
export interface AutonomousConfig {
  safetyMode: AutonomousSafetyMode;
  maxSessionDuration: number;
  allowFileCreation: boolean;
  allowFileEdit: boolean;
  allowBashCommands: boolean;
  blockPatterns: string[];
  continuationMode: AutonomousContinuationMode;
}

// ============================================================================
// Memory System Types
// ============================================================================

export type MemoryCategory =
  | 'permission-preference'
  | 'question-preference'
  | 'project-context'
  | 'workflow-pattern'
  | 'explicit-instruction';

/**
 * A single memory entry learned from user interactions
 */
export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  context: string;
  confidence: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  tags: string[];
}

/**
 * Result from querying memory with relevance scoring
 */
export interface MemoryQueryResult {
  entry: MemoryEntry;
  relevanceScore: number;
}

// ============================================================================
// Safety Classification Types
// ============================================================================

/**
 * Result of classifying an action's safety level
 */
export interface SafetyClassification {
  level: SafetyLevel;
  reason: string;
  category: string;
  recommendation: 'auto-approve' | 'auto-deny' | 'require-user';
}

// ============================================================================
// Agent Lifecycle Types
// ============================================================================

export type AgentSessionStatus = 'active' | 'idle' | 'busy' | 'shutting-down';

export type LifecycleEventType =
  | 'session-started'
  | 'session-idle'
  | 'session-expired'
  | 'session-shutdown'
  | 'children-detected'
  | 'children-cleared'
  | 'shutdown-blocked';

export interface AgentSessionInfo {
  panelId: string;
  providerId: ProviderType;
  sessionId: string | null;
  status: AgentSessionStatus;
  lastActivityTimestamp: number;
  createdAt: number;
  hasActiveChildren: boolean;
  childPids: number[];
  idleRemainingMs: number;
}

export interface LifecycleEvent {
  type: LifecycleEventType;
  panelId: string;
  providerId: ProviderType;
  detail?: string;
  childPids?: number[];
}

export interface ShutdownResult {
  success: boolean;
  blocked: boolean;
  reason?: string;
  childPids?: number[];
}

// ============================================================================
// Visual Testing Types
// ============================================================================

export type VisualTestStatus = 'idle' | 'starting-server' | 'capturing' | 'analyzing'
  | 'fixing' | 'verifying' | 'complete' | 'failed' | 'cancelled';

export interface VisualTestConfig {
  url: string;
  devServerCommand?: string;
  requirements: string;
  maxIterations: number;
  screenshotMode: 'full-page' | 'viewport' | 'element';
  elementSelector?: string;
  browser: 'chromium' | 'firefox' | 'webkit';
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  waitForSelector?: string;
  waitForTimeout?: number;
  interactionsEnabled: boolean;
}

export interface VisualTestScreenshot {
  id: string;
  iteration: number;
  timestamp: number;
  filePath: string;
  base64Data?: string;
  label: string;
  url: string;
}

export interface VisualTestIssue {
  id: string;
  description: string;
  severity: 'critical' | 'major' | 'minor' | 'cosmetic';
  location?: string;
  screenshotId: string;
  status: 'open' | 'fixing' | 'fixed' | 'wont-fix';
}

export interface VisualTestIteration {
  number: number;
  screenshot: VisualTestScreenshot;
  issues: VisualTestIssue[];
  fixesApplied: string[];
  interactions: VisualTestInteraction[];
  duration: number;
}

export interface VisualTestInteraction {
  action: 'click' | 'type' | 'navigate' | 'scroll' | 'hover' | 'select';
  target?: string;
  value?: string;
  screenshotBefore?: string;
  screenshotAfter?: string;
  timestamp: number;
}

export interface VisualTestReport {
  id: string;
  status: VisualTestStatus;
  config: VisualTestConfig;
  iterations: VisualTestIteration[];
  summary: {
    totalIssuesFound: number;
    totalIssuesFixed: number;
    totalIterations: number;
    maxIterations: number;
    totalDuration: number;
    passRate: number;
    verdict: 'pass' | 'partial' | 'fail';
  };
  startedAt: number;
  completedAt?: number;
}

export interface VisualTestStreamChunk {
  type: 'visual_test_started' | 'visual_test_screenshot' | 'visual_test_iteration'
    | 'visual_test_interaction' | 'visual_test_issue' | 'visual_test_fix'
    | 'visual_test_complete' | 'visual_test_error';
  screenshot?: VisualTestScreenshot;
  iteration?: VisualTestIteration;
  interaction?: VisualTestInteraction;
  issue?: VisualTestIssue;
  report?: VisualTestReport;
  status?: VisualTestStatus;
  message?: string;
  feedbackForAgent?: string;
  toolDetail?: {
    toolName: string;
    filePath?: string;
    action?: string;
    description: string;
    linesAdded?: number;
    linesRemoved?: number;
    command?: string;
  };
}

export interface VisualTestTrigger {
  url?: string;
  devServerCommand?: string;
  requirements: string;
  maxIterations?: number;
  screenshotMode?: 'full-page' | 'viewport' | 'element';
  elementSelector?: string;
  showDashboard?: boolean;
}

// ============================================================================
// Canvas Types
// ============================================================================

export type CanvasToolType = 'select' | 'pencil' | 'text' | 'comment' | 'frame' | 'image' | 'pan';
export type ImageGenerationProvider = 'gpt-image-1.5' | 'gpt-image-1' | 'gpt-image-1-mini' | 'nano-banana' | 'nano-banana-pro' | 'none';
export type VideoGenerationProvider = 'sora' | 'veo' | 'none';

export interface CanvasObjectSummary {
  id: string;
  type: 'path' | 'text' | 'comment' | 'image' | 'frame' | 'group';
  position: { left: number; top: number };
  size: { width: number; height: number };
  content?: string;
  label?: string;
  description?: string;
  metadata?: Record<string, string>;
  imagePath?: string;
  children?: string[];
}

export interface CanvasSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  canvasJson: string;
  assetPaths: string[];
  linkedChatPanelId?: string;
  designSpec?: DesignSpec;
  stitchProjectId?: string;
  /**
   * Plan 05 Phase 1: links this session to its {@link CanvasArtifact} — the
   * persisted source of truth. When set, `canvasJson` holds *only* the freeform
   * fabric layer; structured pages/themes live in the artifact and the webview
   * derives proxy rects + iframe overlays from it on load (closes F-16).
   */
  artifactId?: string;
}

// ── Google Stitch types ──
export type StitchDeviceType = 'MOBILE' | 'DESKTOP' | 'TABLET' | 'AGNOSTIC';
export type StitchModel = 'GEMINI_3_PRO' | 'GEMINI_3_FLASH';
export type StitchCreativeRange = 'REFINE' | 'EXPLORE' | 'REIMAGINE';
export type StitchVariantAspect = 'LAYOUT' | 'COLOR_SCHEME' | 'IMAGES' | 'TEXT_FONT' | 'TEXT_CONTENT';

export interface StitchScreenRef {
  projectId: string;
  screenId: string;
  htmlUrl?: string;
  imageUrl?: string;
  htmlContent?: string;
  imageBase64?: string;
}

export interface CanvasSnapshot {
  imageBase64: string;
  sceneDescription: string;
  objects: CanvasObjectSummary[];
  selectedRegion?: {
    imageBase64: string;
    objects: CanvasObjectSummary[];
    bounds: { left: number; top: number; width: number; height: number };
  };
  elementSelection?: ElementSelection;
}

export interface CanvasPromptRequest {
  canvasId: string;
  prompt: string;
  snapshot: CanvasSnapshot;
  selectedObjectIds?: string[];
  action: 'reimagine' | 'prompt' | 'generate-draft';
}

export interface ReimaginationResult {
  variants: Array<{
    id: string;
    imageBase64: string;
    description: string;
  }>;
}

export type CanvasUnifiedAction = 'render' | 'generate' | 'reimagine' | 'video' | 'prompt' | 'page' | 'section' | 'component' | 'website' | 'svg' | 'code' | 'edit-element' | 'edit-layout' | 'mockup' | 'theme' | 'stitch-edit' | 'stitch-variants' | 'stitch-html' | 'design-dna';

export interface CanvasRenderRequest {
  canvasId: string;
  url?: string;
  selector?: string;
  autoDetect: boolean;
}

export interface CanvasUnifiedParsed {
  action: CanvasUnifiedAction;
  argument: string;
}

/**
 * @deprecated Plan 05 Phase 1 replaces the stringly-typed 40-variant chunk union
 * with the jobId-keyed {@link CanvasJobEvent} envelope. New canvas pipelines emit
 * `CanvasJobEvent`s through `CanvasJobRouter`; this union remains only until the
 * legacy prompt-bar handlers are ported (Phase 1.7 / webview F5 pass).
 */
export type CanvasStreamChunkType =
  | 'canvas_reimagine_started'
  | 'canvas_reimagine_variant'
  | 'canvas_reimagine_complete'
  | 'canvas_prompt_response'
  | 'canvas_draft_started'
  | 'canvas_draft_progress'
  | 'canvas_draft_complete'
  | 'canvas_render_started'
  | 'canvas_render_progress'
  | 'canvas_render_complete'
  | 'canvas_video_started'
  | 'canvas_video_progress'
  | 'canvas_video_complete'
  | 'canvas_layout_started'
  | 'canvas_layout_progress'
  // F-15: 'canvas_layout_complete', the 'canvas_batch_*' family, and
  // 'canvas_website_complete' removed — they had no producer after the
  // batch-generation pipeline was deleted from CanvasManager.
  | 'canvas_website_started'
  | 'canvas_website_page_started'
  | 'canvas_svg_started'
  | 'canvas_svg_progress'
  | 'canvas_svg_complete'
  | 'canvas_code_started'
  | 'canvas_code_progress'
  | 'canvas_code_complete'
  | 'canvas_props_extracted'
  // F-15: 'canvas_component_render_progress'/'canvas_component_render_complete'
  // removed with the dead `canvasRenderComponent` stub (no real producer).
  | 'canvas_integrate_started'
  | 'canvas_integrate_progress'
  | 'canvas_integrate_complete'
  | 'canvas_element_edit_started'
  | 'canvas_element_edit_complete'
  | 'canvas_mockup_started'
  | 'canvas_mockup_progress'
  | 'canvas_mockup_complete'
  | 'canvas_theme_complete'
  | 'canvas_asset_generated'
  | 'canvas_multipass_progress'
  | 'canvas_stitch_started'
  | 'canvas_stitch_screen_ready'
  | 'canvas_stitch_html_ready'
  | 'canvas_stitch_variants_ready'
  | 'canvas_stitch_design_dna'
  | 'canvas_error';

export interface CanvasStreamChunk {
  type: CanvasStreamChunkType;
  canvasId: string;
  variant?: { id: string; imageBase64: string; description: string };
  content?: string;
  progress?: number;
  error?: string;
  imageBase64?: string;
  videoBase64?: string;
  mimeType?: string;
  durationSeconds?: number;
  label?: string;
  url?: string;
  frames?: Array<{ left: number; top: number; width: number; height: number; label: string; description?: string; metadata?: Record<string, string> }>;
  frameId?: string;
  frameIndex?: number;
  totalFrames?: number;
  pageIndex?: number;
  totalPages?: number;
  pageName?: string;
  pages?: Array<{
    name: string;
    description: string;
    frames: Array<{ left: number; top: number; width: number; height: number; label: string; description?: string; metadata?: Record<string, string> }>;
  }>;
  svgMarkup?: string;
  generatedFiles?: Array<{ filePath: string; fileName: string; fileType: 'component' | 'story' | 'styles'; content: string }>;
  componentProps?: ComponentProp[];
  framework?: 'react' | 'vue' | 'html';
  componentName?: string;
  objectId?: string;
  designNodes?: DesignNode[];
  designTheme?: DesignTheme;
  asset?: DesignAssetRef;
  // Multi-pass progress fields
  pass?: number;
  totalPasses?: number;
  current?: number;
  total?: number;
  // Stitch fields
  stitchScreenRef?: StitchScreenRef;
  stitchHtml?: string;
  variantIndex?: number;
  variantCount?: number;
}

export interface ComponentProp {
  id: string;
  name: string;
  type: 'color' | 'text' | 'number' | 'enum' | 'boolean';
  value: string;
  options?: string[];
  category: 'colors' | 'typography' | 'spacing' | 'content' | 'layout';
}

export interface GeneratedFile {
  filePath: string;
  fileName: string;
  fileType: 'component' | 'story' | 'styles';
  content: string;
}

export interface ElementSelection {
  objectId: string;
  selectorPath: string;
  tagName: string;
  textContent: string;
  computedStyles: Record<string, string>;
  componentSource: string;
  componentName: string;
  framework: string;
  domSnapshot: string;
}

export interface ElementEditPayload {
  canvasId: string;
  objectId: string;
  componentName: string;
  framework: string;
  edits: Array<{ selectorPath: string; property: string; value: string }>;
  currentCode: string;
}

// ============================================================================
// Canvas v3: Structured Design System Types
// ============================================================================

export type DesignNodeType = 'page' | 'section' | 'component' | 'element';

export interface DesignLayout {
  display: 'flex' | 'grid' | 'block';
  direction?: 'row' | 'column';
  gap?: number;
  padding?: number | [number, number, number, number];
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  gridCols?: number;
}

export interface DesignStyle {
  background?: string;
  border?: { width: number; color: string; style: string };
  shadow?: string;
  radius?: number;
  opacity?: number;
  overflow?: 'visible' | 'hidden';
}

export interface DesignTypography {
  family?: string;
  size?: number;
  weight?: number;
  color?: string;
  lineHeight?: number;
  align?: 'left' | 'center' | 'right';
}

export interface DesignAssetRef {
  id: string;
  type: 'image' | 'video' | 'svg' | 'icon' | 'html';
  prompt?: string;
  src?: string;
  alt?: string;
  fit?: 'cover' | 'contain' | 'fill';
}

export interface DesignNode {
  id: string;
  type: DesignNodeType;
  name: string;
  description?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layout: DesignLayout;
  style: DesignStyle;
  typography?: DesignTypography;
  text?: string;
  assets?: DesignAssetRef[];
  parentId?: string;
  children?: DesignNode[];
  componentType?: string;
  metadata?: Record<string, string>;
}

export interface DesignTheme {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    textSecondary: string;
    border: string;
    error: string;
    success: string;
    [key: string]: string;
  };
  typography: {
    fontFamily: string;
    headingFamily?: string;
    scale: number[];
    lineHeight: number;
    weights: { regular: number; medium: number; bold: number };
  };
  spacing: {
    unit: number;
    scale: number[];
  };
  radii: { sm: number; md: number; lg: number; full: number };
  shadows: { sm: string; md: string; lg: string };
}

export interface SavedTheme {
  id: string;
  name: string;
  theme: DesignTheme;
  createdAt: number;
}

export interface DesignSpec {
  id: string;
  version: number;
  name: string;
  theme: DesignTheme;
  rootNodes: DesignNode[];
  assets: DesignAssetRef[];
  themeLibrary?: SavedTheme[];
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Canvas Artifact model (Plan 05 — agent-driven artifact studio)
//
// The persisted source of truth for a canvas. Unlike the legacy fabric-render
// JSON (which only captured the drawing surface), the artifact carries the full
// structured design — pages, theme, format, media provenance, and the op log —
// so a reload reconstructs the canvas exactly (closes F-16). The rendered fabric
// board becomes a derived view; `CanvasSession.canvasJson` persists only the
// freeform/spatial layer (annotations, ad-hoc frames, uploaded images).
// ============================================================================

/** Canvas format / page geometry. See `CanvasFormats` catalog (Phase 4). */
export interface CanvasFormatSpec {
  /** Catalog id, e.g. `deck-16x9`, `story-9x16`, `a4-portrait`, `custom`. */
  formatId: string;
  kind: 'screen' | 'print';
  /** Design-px dimensions (longer edge normalized to 1920 by convention). */
  width: number;
  height: number;
  dpi?: number;
  /** Print bleed in design px. */
  bleed?: number;
  /** Print safe margin in design px. */
  safeMargin?: number;
}

/** Per-element durable override keyed by DOM index path (`0/2/1`). */
export interface ElementOverride {
  /** New inner HTML (inline-edit fallback when source splice is ambiguous). */
  innerHtml?: string;
  /** Per-element transform applied over generated JSX/HTML. */
  transform?: { x?: number; y?: number; scale?: number; rotation?: number };
  /** Arbitrary style attribute overrides. */
  styles?: Record<string, string>;
}

/** An image/media asset dropped or pasted onto a page (overlay layer). */
export interface DroppedAsset {
  id: string;
  assetId: string;           // → CanvasAssetRecord.id
  x: number; y: number;
  width: number; height: number;
  rotation?: number;
}

/** Provenance for a Stitch-backed page. */
// (StitchScreenRef is declared above; ArtifactPage reuses it.)

export interface ArtifactPage {
  id: string;
  /** Bumped on every applied mutation; used for agent base-version checks. */
  version: number;
  mode: 'html' | 'jsx' | 'structured';
  /** Stitch screens / plain HTML pages. */
  htmlSource?: string;
  /** `function Page()` React component source (Phase 3). */
  jsxSource?: string;
  /** Structured-mode node tree (reuses the existing DesignNode shape). */
  nodes?: DesignNode[];
  actionTitle?: string;
  notes?: string;
  source?: string;
  /** DOM-index-path keyed durable overrides for human/agent element edits. */
  elementOverrides?: Record<string, ElementOverride>;
  droppedAssets?: DroppedAsset[];
  /** Provenance for Stitch-generated pages. */
  stitchRef?: StitchScreenRef;
  /** Cached self-QA preview/thumbnail (asset:// ref), Phase 4. */
  previewAsset?: string;
}

/** Provenance-tracked media asset belonging to an artifact. */
export interface CanvasAssetRecord {
  id: string;
  role: 'image' | 'video' | 'svg' | 'icon' | 'preview';
  /** `asset://` ref into the content-addressed store. */
  ref: string;
  prompt?: string;
  model?: string;
  size?: { width: number; height: number };
  /** Lineage: the asset this was derived from (crop/edit/mask). */
  parentAssetId?: string;
  /** Page this asset was generated for, if any. */
  sourcePageId?: string;
  ts: number;
}

export type CanvasOpKind =
  | 'insert_page'
  | 'edit_page'
  | 'delete_page'
  | 'reorder'
  | 'set_theme'
  | 'set_format'
  | 'edit_element'
  | 'add_asset';

export type CanvasOpStatus =
  | 'pending'
  | 'applied'
  | 'rejected'
  | 'superseded'
  | 'stale';

/** A staged or applied mutation against an artifact — undo/audit source. */
export interface CanvasOp {
  opId: string;
  /** runId = chat turn / job id that authored this op. */
  runId: string;
  kind: CanvasOpKind;
  targetPageId?: string;
  /** Page version the author read before proposing (stale detection). */
  baseVersion?: number;
  proposedValue: unknown;
  /** Snapshot of the prior value for undo/revert (recorded on apply). */
  previousValue?: unknown;
  status: CanvasOpStatus;
  author: 'agent' | 'user';
  ts: number;
}

export interface CanvasArtifact {
  id: string;
  /** Monotonically increasing artifact version (bumped per applied op). */
  version: number;
  kind: 'deck' | 'document' | 'screens' | 'board';
  name: string;
  format: CanvasFormatSpec;
  /** Snapshotted at creation (DeepMyst brand-snapshot pattern). */
  theme: DesignTheme;
  pages: ArtifactPage[];
  assets: CanvasAssetRecord[];
  /** Staged + applied ops — the undo/audit log. */
  opLog: CanvasOp[];
  /** Stitch project id, persisted (replaces the in-memory map, fixes amnesia). */
  stitchProjectId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Typed job envelope replacing {@link CanvasStreamChunkType}. Every canvas job
 * (prompt-bar command, chat-driven op, media generation, export) is keyed by a
 * `jobId` so spinners/cancellation/heartbeats are tracked per job rather than by
 * fragile singleton slots (fixes the F-4 class of leaked-spinner bugs).
 */
export interface CanvasJobEvent {
  jobId: string;
  type:
    | 'started'
    | 'progress'
    | 'heartbeat'
    | 'op_staged'
    | 'op_applied'
    | 'op_rejected'
    | 'page_updated'
    | 'asset_ready'
    | 'op_error'
    | 'error'
    | 'done';
  /** Human-facing label for the job overlay. */
  label?: string;
  /** 0..1 progress for `progress` events. */
  progress?: number;
  /** Elapsed seconds for `heartbeat` events on long media tools. */
  elapsedSeconds?: number;
  /** Op payload for `op_staged`/`op_applied`/`op_rejected`/`op_error`. */
  op?: CanvasOp;
  /** Page id for `page_updated` (re-render just that page's iframe mid-turn). */
  pageId?: string;
  /** Asset record for `asset_ready`. */
  asset?: CanvasAssetRecord;
  /** Error message for `error`/`op_error`. */
  error?: string;
  /** Free-form payload for `done` (e.g. export path). */
  result?: unknown;
}
