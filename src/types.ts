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
/**
 * Unified reasoning-effort scale, matching Claude Code's `--effort` tiers
 * (low·medium·high·xhigh·max). Distinct from ThinkingLevel: effort controls how
 * much adaptive reasoning a model invests, thinking controls reasoning-output
 * visibility. Each backend maps these tiers to its own native control
 * (Claude → --effort, Codex → model_reasoning_effort, OpenRouter → reasoning.effort,
 * …); backends with no reasoning control declare no effortLevels and hide the UI.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AccessLevel = 'read-only' | 'ask-permission' | 'full-access';
export type ContextMode = 'auto' | 'manual';
export type ProviderType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'cline' | 'github-copilot' | 'cursor' | 'openclaw' | 'opencode' | 'ollama' | 'localai' | 'qwen-code' | 'hermes' | 'continue' | 'openrouter' | 'kimi-code';

/**
 * Pseudo-agents: selectable in the agent menu, but NOT registered providers —
 * they have no CLI, no install command and no model list of their own.
 *   'mysti'      — the coordinator agent (its own model + gated delegation)
 *   'brainstorm' — two backends collaborating (routed as `sendBrainstormMessage`)
 */
export type PseudoAgentType = 'mysti' | 'brainstorm';

/**
 * What the user picked in the agent menu. A superset of ProviderType — the
 * selection may be a pseudo-agent, the BACKEND resolved for it never is.
 * `ChatViewProvider._getPanelAgent()` returns this; `_getPanelProvider()`
 * returns a registered ProviderType and must never return a pseudo-agent.
 */
export type AgentSelection = ProviderType | PseudoAgentType;

export type AutocompleteType = 'sentence' | 'paragraph' | 'message';

// Agent and Brainstorm types
export type AgentType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'cline' | 'github-copilot' | 'cursor' | 'openclaw' | 'opencode' | 'ollama' | 'localai' | 'qwen-code' | 'hermes' | 'continue' | 'openrouter' | 'kimi-code';
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
  /** Reasoning-effort tier (Claude Code parity). Optional for back-compat; defaults to 'high'. */
  effortLevel?: EffortLevel;
  accessLevel: AccessLevel;
  contextMode: ContextMode;
  model: string;
  provider: ProviderType;
  autonomousMode?: boolean;
  /**
   * An explicitly ROUTED model (Plan 17 P2.3 tier routing / P0.2b honoring) that
   * must WIN over a per-provider `mysti.<provider>Model` custom-model setting.
   * Set by CollaboratorPool from an explicit spec.model; `_getEffectiveModel`
   * checks it before the config custom-model read. Undefined ⇒ normal precedence.
   */
  routedModel?: string;
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

export type SlashCommandSection = 'context' | 'model' | 'customize' | 'commands' | 'native' | 'settings' | 'support';
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
  /**
   * For entries in the provider-native section: the bare command name the
   * BACKEND knows it by (`compact`, `design`, `frontend:audit`) — without the
   * leading slash. `id` stays Mysti-scoped (`native:claude-code:compact`) so
   * two providers can both own a `/compact` without colliding.
   */
  nativeName?: string;
  /**
   * Hint for a command that takes arguments, e.g. `<pr-number>`. When present
   * the menu PREFILLS the composer with `/name ` instead of dispatching, so a
   * command is never sent half-finished.
   */
  argumentHint?: string;
  /** Where the entry came from — drives the "Project"/"User" badge in the menu. */
  origin?: NativeCommandOrigin;
}

/**
 * Where a provider-native command was found.
 *   'builtin'   — shipped by the CLI itself (Mysti's curated catalog)
 *   'user'      — the user's home-directory command/prompt/skill directory
 *   'project'   — the workspace's command directory (checked into the repo)
 *   'agent'     — pushed live by the agent over ACP (`available_commands_update`)
 */
export type NativeCommandOrigin = 'builtin' | 'user' | 'project' | 'agent';

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
 * Payload of the `promptEnhanced` message.
 *
 * Every `enhancePrompt()` implementation resolves the ORIGINAL prompt when its
 * CLI fails, so "we got a string back" is not the same as "the prompt was
 * enhanced" — `changed` carries that distinction to the webview so a silent
 * no-op stops looking like a success. `enhancedBy` names the backend that did
 * the rewrite, which differs from the active provider when `fallback` is true.
 */
export interface PromptEnhancedPayload {
  prompt: string;
  enhancedBy: string;
  enhancedById: string;
  fallback: boolean;
  changed: boolean;
}

/**
 * Payload of the `promptEnhanceUnavailable` message — posted instead of
 * `promptEnhanced` when neither the active provider nor any installed backend
 * implements prompt enhancement. The webview disables the button and shows
 * `reason` rather than pretending the request succeeded.
 */
export interface PromptEnhanceUnavailablePayload {
  activeProviderName: string;
  reason: string;
}

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
/**
 * One "a new model was released" card. `settingKey` is the per-agent model
 * setting the quick-select button writes (mysti.<key>), resolved extension-side
 * from PROVIDER_CUSTOM_MODEL_SETTING_KEYS so the webview never has to know the
 * provider→setting mapping.
 */
export interface AnnouncedModelPayload {
  providerId: string;
  providerLabel: string;
  modelId: string;
  name: string;
  description?: string;
  contextWindow?: number;
  announcedAt: number;
  settingKey: string;
  /**
   * True when this provider is the one the panel is currently using. The
   * webview uses it to order cards, not to decide whether to show them —
   * a new model on an idle agent is still worth surfacing.
   */
  isActiveProvider: boolean;
}

export interface NewModelsAvailableMessage {
  type: 'newModelsAvailable';
  payload: { models: AnnouncedModelPayload[] };
}

/** One outdated backend CLI. `command` is built from an in-repo package literal. */
export interface CliUpdatePayload {
  providerId: string;
  providerLabel: string;
  packageName: string;
  installed: string;
  latest: string;
  command: string;
}

export interface CliUpdatesAvailableMessage {
  type: 'cliUpdatesAvailable';
  payload: { updates: CliUpdatePayload[] };
}

export type TypedWebviewMessage =
  | ManifestUpdatedMessage
  | StreamStatusMessage
  | ModelsUpdatedMessage
  | NewModelsAvailableMessage
  | CliUpdatesAvailableMessage;

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
  /**
   * ISO-8601 date the model was publicly released, when known.
   *
   * Exists for one reason: the announcement baseline. A provider's FIRST
   * reconcile is silent (otherwise every install would announce the entire
   * catalogue), which would also swallow a model that genuinely shipped days
   * ago — including on the very build that adds it. A model carrying a recent
   * releasedAt announces THROUGH that baseline, and only inside a short window,
   * so old entries never resurface as news.
   */
  releasedAt?: string;
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
  /**
   * True when the provider SYNTHESIZED these figures rather than reporting
   * them (e.g. LocalAI counting SSE deltas when the server omits a usage
   * frame). Consumers that persist or display totals must not present an
   * estimate as measured — see BoostTurnRecord.estimated.
   */
  estimated?: boolean;
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

// ============================================================================
// Boost Mode Types (Plan 24)
// ============================================================================

/**
 * Boost preset profile. `economy` favours aggressive compaction and cheap
 * delegation tiers; `quality` pins effort high and never routes work down;
 * `balanced` applies the measured defaults from the Plan 24 evidence base.
 */
export type BoostProfile = 'economy' | 'balanced' | 'quality';

/** Where a Boost turn record came from. */
export type BoostTurnKind = 'cli' | 'coordinator';

/**
 * One completed turn as observed by the Boost ledger (Plan 24 Phase 1).
 * All token fields are optional: providers legitimately omit usage on done
 * chunks, and coordinator totals can be estimates (`estimated: true`).
 */
export interface BoostTurnRecord {
  kind: BoostTurnKind;
  provider: string;
  /**
   * Panel this turn belongs to. Lets the ledger keep per-panel activity for
   * cold-resume detection (Phase 5); omitted on paths with no single panel.
   */
  panelId?: string;
  model?: string;
  /**
   * Prompt-side tokens for the turn, or undefined when the provider reported
   * none. On the CLI path this is a context FILL (input + cache-read, the
   * CompactionManager convention); on the coordinator path it is the SUM of
   * prompt tokens across the run's ReAct round-trips. Both answer "prompt
   * tokens this turn cost", but only the CLI figure is comparable to
   * `contextWindow` — don't derive a fill percentage from a coordinator record.
   */
  contextTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Context window of the model, when resolvable — lets the UI show fill %. */
  contextWindow?: number;
  /** Model round-trips inside the turn (coordinator ReAct turns; 1 for a CLI turn). */
  roundTrips?: number;
  /** Delegations spawned during the turn (coordinator only). */
  delegations?: number;
  /** True when any token figure is an estimate rather than provider-reported. */
  estimated: boolean;
  /**
   * Plan 24 Phase 3, record-only. Tool calls whose (kind, args) had already run
   * in this same coordinator run — a repeat the model could have avoided.
   */
  redundantToolCalls?: number;
  /**
   * Plan 24 Phase 3, record-only. Round-trips that carried exactly one
   * read-only tool call AND followed another such turn: each one is a
   * round-trip the model could have saved by emitting both calls together.
   */
  mergeableRoundTrips?: number;
  /** Plan 24 Phase 5: this turn intercepted a cold resume before dispatch. */
  coldResumeIntercepted?: boolean;
}

export interface BoostTotals {
  turns: number;
  roundTrips: number;
  contextTokens: number;
  outputTokens: number;
  delegations: number;
  /** Tool calls re-run with arguments already seen in the same run (Plan 24 Phase 3). */
  redundantToolCalls: number;
  /** Round-trips that carried one read-only tool and followed another such turn. */
  mergeableRoundTrips: number;
  /** Cold resumes intercepted before the expensive prefix re-write (Phase 5). */
  coldResumesIntercepted: number;
}

/** Snapshot of the Boost ledger for the status bar / summary command. */
export interface BoostSnapshot {
  enabled: boolean;
  profile: BoostProfile;
  session: BoostTotals;
  lifetime: BoostTotals;
  /** Mean context tokens per recorded turn this session (0 when no data). */
  sessionMeanContextTokens: number;
  /**
   * Whether any figure in THIS SESSION is an estimate. Session-scoped on
   * purpose: a lifetime-sticky flag would mark every later session's clean
   * numbers as estimated forever, and a warning that is always on is a warning
   * users stop reading.
   */
  estimated: boolean;
  /** Whether any figure in the persisted LIFETIME totals is an estimate. */
  lifetimeEstimated: boolean;
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
  /** The concrete model the gateway resolved to (e.g. behind a router id). */
  model?: string;
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
  /**
   * Child panel keys this session dispatched under (`${panelId}-brainstorm-
   * ${agentId}`), with the owning provider recorded so teardown can target
   * that provider directly even after the panel→provider map entry is gone.
   * Includes the synthesis agent, which may not be one of `agents`.
   */
  childPanels?: { panelId: string; providerId: AgentType }[];
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

/**
 * Plan 27 Phase 5 — the @-mention surface.
 *
 * `problems` and `git` are WORKSPACE-STATE mentions: they resolve to a
 * generated summary rather than a file on disk, so they carry no path and are
 * never written back. Both are read-only reads of state the user can already
 * see in the editor.
 */
export type MentionType = 'agent' | 'file' | 'problems' | 'git';

export interface Mention {
  type: MentionType;
  value: string;        // provider ID ('google-gemini') or file path
  displayName: string;  // '@gemini' or '@types.ts'
  startIndex: number;   // Position in message string
  endIndex: number;
  /**
   * Plan 14: optional collaboration role for agent mentions, parsed from the
   * `@agent:role` grammar (e.g. `@google-gemini:critic`). A role id resolves
   * to a markdown role definition (advisor/critic/reviewer/…). Undefined for
   * plain `@agent` mentions and all file mentions — those keep today's routing.
   */
  role?: string;
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
// Collaboration Roles (Plan 14) — any agent(s) as advisor/critic/reviewer/…
// ============================================================================

/**
 * The access profile a collaborator runs under.
 * - `read-only`: the pool hard-denies any non-file-read tool locally (advisory
 *   roles never write, regardless of provider CLI flags). Web reads still defer
 *   to the user's own gate policy — an advisor doing research is the point.
 * - `gated-write`: write/exec tools are routed through the caller's permission
 *   gate before execution (coworker/collaborator roles).
 * - `sealed` (Plan 21 Phase 0): reads and nothing else. No policy consultation,
 *   no `accessLevel` check, and no web-request carve-out, so the reachable
 *   surface is exactly the read fast-path. This is the class for a turn whose
 *   PROMPT is authored off-machine: there the request body is attacker-chosen,
 *   which makes the same fetch an exfiltration primitive rather than research.
 */
export type CollaboratorAccess = 'read-only' | 'gated-write' | 'sealed';

/**
 * How a collaborator interacts with the run.
 * - `one-shot`: a single dispatch (advisor/critic/reviewer/second-opinion/coworker).
 * - `rounds`: participates in a multi-round exchange (collaborator) — the pool
 *   still dispatches one turn at a time; the caller orchestrates rounds.
 */
export type CollaboratorPattern = 'one-shot' | 'rounds';

/**
 * Structured failure taxonomy for a collaborator dispatch. Every non-success
 * outcome maps to exactly one of these so the UI can label the agent's card and
 * a single failure never sinks the whole run.
 */
export type CollaboratorFailure =
  | 'not-installed'
  | 'not-authenticated'
  | 'timeout'
  | 'crashed'
  | 'stream-error'
  | 'empty-response'
  | 'cancelled'
  | 'denied';

/**
 * One collaborator to dispatch. `collaboratorId` is the run-unique key that
 * distinguishes two dispatches of the same provider in different roles (e.g.
 * `@claude-code:critic` + `@claude-code:reviewer`).
 */
export interface CollaboratorSpec {
  /** Run-unique id (caller-assigned, stable for the run). */
  collaboratorId: string;
  /** The backend/provider to dispatch to. */
  agentId: AgentType;
  /** Optional role id (advisor/critic/…); undefined = plain dispatch. */
  role?: string;
  /** Human-facing label for cards (defaults to the provider display name). */
  label?: string;
  /** The fully-assembled prompt for this collaborator. */
  prompt: string;
  /** Access profile — advisory roles pass `read-only`. */
  access: CollaboratorAccess;
  /** Per-collaborator timeout override (ms); defaults to the role/pool default. */
  timeoutMs?: number;
  /** Optional model override; defaults to the provider's default model. */
  model?: string;
  /**
   * Optional reasoning-effort override for this collaborator (Plan 24 routing).
   * Applied to the child settings like `model`; undefined ⇒ inherit the parent's
   * effort. Providers that don't declare effortLevels ignore it (clampEffort).
   */
  effortLevel?: EffortLevel;
}

/**
 * A streaming event from the CollaboratorPool. Every chunk carries the
 * `collaboratorId` it belongs to so the caller can route it to the right card.
 */
export interface CollaboratorChunk {
  type:
    | 'collab_started'
    | 'collab_skipped'      // availability pre-check failed (never dispatched)
    | 'collab_text'
    | 'collab_thinking'
    | 'collab_tool_use'
    | 'collab_tool_result'
    | 'collab_tool_denied'  // read-only deny or gate rejection
    | 'collab_retry'
    | 'collab_ask_user_question'
    | 'collab_complete'
    | 'collab_error';
  collaboratorId: string;
  agentId: AgentType;
  role?: string;
  label?: string;
  content?: string;
  toolCall?: ToolCall;
  /** Present on collab_complete: the accumulated response text. */
  responseText?: string;
  /** Present on collab_complete/collab_error: whether the collaborator failed. */
  hasError?: boolean;
  /** Present on collab_error/collab_skipped: the structured failure reason. */
  failure?: CollaboratorFailure;
  /** Present on collab_skipped: install/auth hint for the user. */
  hint?: string;
  retryCount?: number;
  askUserQuestion?: AskUserQuestionData;
  usage?: UsageStats;
}

/**
 * Optional gate hook: for `gated-write` collaborators the pool calls this
 * before re-emitting a write/exec tool_use, having already SIGSTOPped the
 * child process. Returns whether the tool is approved. The pool resumes on
 * approval and cancels the child on rejection — enforcement targets the
 * child's own derived panel (unlike the legacy MentionRouter gate).
 */
export type CollaboratorGateCallback = (
  spec: CollaboratorSpec,
  toolCall: ToolCall
) => Promise<boolean>;

/**
 * Options for a CollaboratorPool.dispatch run.
 */
export interface CollaboratorDispatchOptions {
  /** Base settings; the pool overrides provider/model/accessLevel per spec. */
  settings: Settings;
  /** Parent panel id; derived child panels are `${panelId}-collab-${runId}-${n}`. */
  panelId: string;
  /** Run id (UUID) — caller-supplied so cancel can target the run. */
  runId: string;
  /** Max collaborators dispatched concurrently (defaults to the pool cap). */
  maxConcurrent?: number;
  /** Conversation context passed to each collaborator (read-only). */
  conversation?: Conversation | null;
  /** Question relay for a collaborator's ask_user_question. */
  onQuestion?: SubAgentQuestionCallback;
  /** Gate hook for gated-write collaborators. */
  onGate?: CollaboratorGateCallback;
}

// ============================================================================
// Mysti Agent / Orchestrator (Plan 15 Phase 2)
// ============================================================================

/** A node in the coordinator's plan, as surfaced to the UI. */
export interface OrchestratorPlanNode {
  id: string;
  task: string;
  backend?: string;
  dependsOn: string[];
}

/** A streaming event from the @mysti orchestrator run. */
export interface OrchestratorEvent {
  type:
    | 'orch_status'      // phase transition (decompose/execute/synthesize)
    | 'orch_plan'        // the decomposed DAG (surfaced once)
    | 'orch_node_start'  // a node began executing on its backend
    | 'orch_node_done'   // a node finished (text/error)
    | 'orch_collab'      // a raw per-node CollaboratorChunk (live streaming)
    | 'orch_synthesis'   // final synthesized text (streamed or whole)
    | 'orch_error'       // a run-level error
    | 'orch_done';       // the run completed
  phase?: 'decompose' | 'execute' | 'synthesize';
  content?: string;
  plan?: { nodes: OrchestratorPlanNode[] };
  nodeId?: string;
  nodeBackend?: string;
  hasError?: boolean;
  collab?: CollaboratorChunk;
  error?: string;
}

/** Per-node outcome accumulated during a run. */
export interface OrchestratorNodeOutcome {
  nodeId: string;
  task: string;
  backend: string;
  text: string;
  hasError: boolean;
  failure?: string;
}

/** The result of an orchestrator run, returned when the generator completes. */
export interface OrchestratorResult {
  runId: string;
  outcomes: OrchestratorNodeOutcome[];
  /** Final synthesized answer folded from the node outputs. */
  synthesis: string;
  /**
   * Set when the run declined to dispatch (Plan 24 Phase 4). `single-lane`
   * means the plan decomposed to one node, and one serial delegation measured
   * SLOWER than answering inline — the caller should answer inline instead.
   * `synthesis` is empty in that case and nothing was dispatched.
   */
  refused?: 'single-lane';
}

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
  | 'multi-file-edit'
  // Plan 15 Phase 0 (security floor): spawning/handing off to a sub-agent
  // (task/agent/dispatch_agent). Gated like a write — a delegated agent can run
  // arbitrary tools, so model-initiated delegation must be user-approved unless
  // an explicit full-access/autonomous tier auto-approves it.
  | 'delegate'
  // Plan 20 §3.6 (canvas permission class). Canvas ops are NOT workspace
  // writes: they touch `.mysti/canvas/<id>/` only, are fully invertible via the
  // op log, and reach neither a shell nor the network. They therefore get their
  // own authority class rather than borrowing `file-edit`/`bash-command`, whose
  // gating and SafetyClassifier verdicts are calibrated for the user's source
  // tree.
  //
  // - `canvas-read`  — NEVER gated. Reading a design is not a privileged act.
  // - `canvas-edit`  — never a blocking modal. When settings resolve the canvas
  //   to `staged` approval (`resolveCanvasApproval`), the op is staged and the
  //   approval surface is an in-canvas accept/reject card; in `auto` it applies
  //   immediately and is undoable. Deliberately NOT routed through
  //   `SafetyClassifier` — its file/bash verdicts do not describe this act.
  //
  // The canvas tools that DO cross a boundary — `generate_visual`,
  // `generate_video`, `import_design`, `export_artifact`, `render_page_preview`
  // — are excluded from these classes (see `CANVAS_BOUNDARY_TOOLS` in
  // `utils/toolNames.ts`) and keep their fail-closed, `forceInteractive`
  // treatment.
  | 'canvas-read'
  | 'canvas-edit';

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

  /**
   * P0#2 — the gated tool call itself, so the permission card can render the
   * diff being approved. `command` above stays the 500-char JSON preview for
   * older consumers, but a sliced JSON string is unparseable past 500 chars, so
   * a realistic 3-line Edit rendered NO diff. `toolInput` is a structurally
   * intact copy of the tool_use input: when it exceeds the wire budget the
   * producer truncates the long STRING fields inside it (with an explicit
   * `…[truncated N chars]` marker) rather than slicing the JSON, so it always
   * parses and `file_path` / `edits[]` / key set survive.
   */
  toolName?: string;
  toolInput?: Record<string, unknown>;
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
  /**
   * Cancellation owner (Plan 16 / Phase D). A foreground turn owns its gates
   * under its panelId; a background Mysti job owns them under its jobId. Lets a
   * Stop / re-entrancy cancel scope to ONLY its own gates instead of denying
   * every concurrent job's pending permission card.
   */
  ownerKey?: string;
  /**
   * Plan 21 Phase 0 (I14). True when this run's root input contains bytes
   * authored off this machine (a teammate's Desk request, an inbound channel
   * message). Such a run may never be auto-approved by ANY channel: the session
   * upgrade, autonomous mode, the semi-autonomous auto-path, and timeout
   * auto-accept are all bypassed, and a forced card auto-DENIES on timeout.
   *
   * Implemented by folding into `forceInteractive` at the single entry point,
   * so there is no second switch that a later branch could forget to check.
   */
  remoteOrigin?: boolean;
  /**
   * Plan 19: a caller FORCED an interactive card for an un-undoable side effect
   * (a coordinator external MCP call / non-safe bash). Such a card must NEVER be
   * satisfied by an auto-approve — not by session full-access, not by autonomous
   * mode, and NOT by a permission timeout (it auto-DENIES on expiry regardless
   * of timeoutBehavior, and is never handed to the semi-autonomous approver).
   */
  forceInteractive?: boolean;
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
 * Agent configuration for a conversation (persisted per-conversation).
 * Ids are open strings (not the built-in unions) because users can add
 * their own personas/skills via ~/.mysti/agents, .mysti/agents, or
 * skill import — the markdown-based AgentLoader is the source of truth.
 */
export interface AgentConfiguration {
  personaId: string | null;
  enabledSkills: string[];
  /**
   * Plan 14: optional default collaboration role for this conversation's agent.
   * Absent on legacy persisted configs — treat `undefined` as "no role".
   */
  roleId?: string | null;
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
export type AgentTypeDiscriminator = 'persona' | 'skill' | 'role';

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
    | 'visual_test_complete' | 'visual_test_error' | 'visual_observation';
  screenshot?: VisualTestScreenshot;
  iteration?: VisualTestIteration;
  interaction?: VisualTestInteraction;
  issue?: VisualTestIssue;
  observation?: VisualObservation;
  report?: VisualTestReport;
  status?: VisualTestStatus;
  message?: string;
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

// ── Agent-callable observation (the `look` / `act` primitive) ──

export interface VisualConsoleEntry {
  level: 'error' | 'warning';
  text: string;
  /** `file.ts:line` when the page reported one. */
  source?: string;
}

export interface VisualNetworkFailure {
  method: string;
  url: string;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  error?: string;
}

/** One element that tripped a layout/contrast probe. */
export interface VisualLayoutProbe {
  selector: string;
  width: number;
  height: number;
  x: number;
  y: number;
  /** Human-readable problems, e.g. `OVERFLOW-X (…)`, `LOW-CONTRAST 2.4:1 (…)`. */
  flags: string[];
}

/**
 * What one `look` produced. This — not the screenshot — is the primary channel
 * back to the calling agent.
 */
export interface VisualObservation {
  sequence: number;
  url: string;
  browser: string;
  viewport: { width: number; height: number };
  focus?: string;
  selector?: string;
  console: VisualConsoleEntry[];
  network: VisualNetworkFailure[];
  layout: VisualLayoutProbe[];
  accessibility?: string;
  domOutline?: string;
  screenshotPath?: string;
  screenshotBase64?: string;
  screenshotAttached?: boolean;
  /** Interactions actually executed before the capture (the `act` path). */
  actionsPerformed?: string[];
  /** Requested-but-refused items, so the caller stops retrying them. */
  denials?: string[];
  durationMs?: number;
  serverReused?: boolean;
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

/**
 * Page content that is NOT part of the compilable JSX subset — the escape
 * hatch (Plan 22 §3.1). A `legacy` page still renders (Babel is injected into
 * that one frame) and is badged "code page — not directly editable", because
 * honest visible degradation beats a page that silently disappears.
 */
export interface LegacyPageSource {
  mode: 'jsx' | 'html';
  source: string;
}

/**
 * One artboard (Plan 22 §3.1) — **document-first**.
 *
 * `doc` is the source of truth. Everything else on this type is derived from
 * it (`jsxCache`), an escape hatch for content the compiler could not accept
 * (`legacy` / `compileError`), or board metadata.
 *
 * Deliberately absent, and deliberately gone as *concepts*: `elementOverrides`,
 * `droppedAssets`, `previewAsset`, `nodes`, `stitchRef`, `mode`, `htmlSource`,
 * `jsxSource`. When the document is the truth a human's element edit is a
 * first-class `el.*` op against a `mid`, not a shadow layer keyed by a DOM
 * index path that silently retargets the moment an agent inserts a wrapper.
 *
 * Legacy shapes on disk are upgraded by `src/canvas/pageMigration.ts` on load;
 * the legacy jsx/html views a transport still needs are read through
 * `pageMode()` / `pageJsx()` / `pageWire()` in that module — never re-added
 * here as stored fields.
 */
export interface ArtifactPage {
  id: string;
  /** Bumped on every applied mutation; used for agent base-version checks. */
  version: number;
  /** SOURCE OF TRUTH — the element tree every op addresses by `mid`. */
  doc: import('./canvas/doc/DocNode').DocNode;
  /** Derived by `DocEmitter`; what `read_page` / `get_page_jsx` return. */
  jsxCache?: string;
  /** Set when {@link doc} is a placeholder because the source did not compile. */
  legacy?: LegacyPageSource;
  /** Why compilation failed, when it did. Rendered as the rail badge's tooltip. */
  compileError?: string;
  actionTitle?: string;
  notes?: string;
  /** Provenance of the page's content (`'figma'`, `'stitch'`, …). */
  source?: string;
  /** Per-artboard device override (falls back to `artifact.format`). */
  format?: CanvasFormatSpec;
  /** Position on the infinite board. */
  boardPos: { x: number; y: number };
  /** Artboards that are variants of one another share this id. */
  variantGroupId?: string;
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
  /**
   * Plan 22 §3.2: the op that exactly undoes this one, computed at apply time
   * by `DocPatch.applyOp`. Present for document-scoped mutations, where it
   * replaces `previousValue`'s deep clone of the whole page source.
   */
  inverse?: import('./canvas/CanvasOps').CanvasOp;
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

// ============================================================================
// Desk (Plan 21) — cross-machine, cross-user agent teamwork.
//
// A teammate is not a peer you chat with; it is a desk you knock on. Every
// cross-machine interaction is ONE signed, typed, deadline-bounded request
// against a closed capability set. There is no session, no stream, and no
// free-form agent-to-agent channel — see plans/21 §8 for what is deliberately
// absent and §12 for the evidence behind it.
// ============================================================================

/**
 * The verbs a Desk can serve. The VOCABULARY is open (a team may add
 * read-shaped verbs; see plans/21 §11.1), but the CAPABILITY SET behind it is
 * sealed: no verb, present or future, may reach a tool outside
 * {read, ls, locate} bounded by DeskScope. That property is asserted by
 * tests/services/desk/importGraph.test.ts, not by policy.
 */
export type DeskVerb =
  | 'status'    // owner-typed availability strings. No path ever.
  | 'locate'    // exact-token coordinate lookup. No content ever.
  | 'consult'   // a question answered from the peer's own codebase.
  | 'review'    // structured findings against a diff.
  | 'handoff'   // work crosses as an artifact, never a string.
  | 'assign'    // a proposal record + a card. Never remote execution.
  | 'followup'; // the status of proposals the caller itself sent.

/** Protocol verbs — always available, never grantable as capabilities. */
export type DeskProtocolVerb = 'hello' | 'cancel';

/**
 * A paired peer. `peerId` IS the key fingerprint: identity is never read from
 * a payload, and `alias` is typed by the LOCAL human — it is the only name
 * rendered anywhere and the only routing key (plans/21 I12).
 */
export interface DeskPeer {
  /** `p_` + base32(sha256(ed25519Pub)).slice(0,16). Derived, never asserted. */
  peerId: string;
  /** Locally-typed handle. `^[a-z0-9][a-z0-9_-]{0,31}$`. */
  alias: string;
  /** The pinned Ed25519 public key, base64. */
  publicKey: string;
  /** Same company / same secrets domain? Gates whether git refs may cross. */
  trustDomain: string;
  /** When this peer was first pinned (visibility begins here — I13). */
  pairedAt: number;
  /** Absolute expiry; renewed only by locally-originated outbound activity. */
  expiresAt: number;
}

/**
 * What one peer may ask of this Desk. A grant only ever NARROWS: any holder
 * may add a caveat, nobody may remove one, and widening requires a fresh
 * human-signed root (plans/21 I30).
 */
export interface PeerGrant {
  peerId: string;
  /** Verbs this peer may see at all. An ungranted verb is invisible, not refused. */
  verbs: DeskVerb[];
  /** Workspace-relative glob prefixes this grant may reach. */
  scope: string[];
  /** Absolute epoch after which the grant is dead. */
  expiresAt: number;
  /** Hard spend ceiling for serving this peer, in USD. */
  budgetUsd: number;
  /** Hard call ceiling over the grant's life. */
  maxCalls: number;
  /** Minimum acceptable model retention class for a serving turn (I9). */
  minRetentionClass: 'zero-retention' | 'logged' | 'training-permitted';
}

/** Resolved read boundary for one request: workspace share ∩ machine ceiling. */
export interface DeskScopeSpec {
  /** Workspace-relative POSIX prefixes. Empty means nothing is shared. */
  allow: string[];
  /** Monotonic marker; bumping it invalidates every cached disclosure (I35). */
  scopeVersion: string;
}

/** A single typed request result. Never carries a partial artifact (I21). */
export interface DeskCallResult {
  ok: boolean;
  /** Populated only when ok. */
  payload?: Record<string, unknown>;
  /** Machine-readable failure: 'denied' | 'not-found' | 'incomplete' | … */
  error?: string;
  /** Paths withheld by egress screening, when error === 'incomplete'. */
  withheld?: string[];
}

/** An `assign` proposal. A record and a card — never a remote run (I10). */
export interface DeskProposal {
  proposalId: string;
  fromPeerId: string;
  title: string;
  detail: string;
  /** Lamport clock for convergent claim arbitration (I19). */
  lamport: number;
  /** Monotonic supersession counter; only the highest is authoritative (I20). */
  generation: number;
  /** Duration, never an absolute epoch — expired against the observer's clock. */
  leaseMs: number;
  createdAt: number;
}
