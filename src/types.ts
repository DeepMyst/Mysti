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

export type OperationMode = 'default' | 'ask-before-edit' | 'edit-automatically' | 'quick-plan' | 'detailed-plan';
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';
export type AccessLevel = 'read-only' | 'ask-permission' | 'full-access';
export type ContextMode = 'auto' | 'manual';
export type ProviderType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'github-copilot';
export type AutocompleteType = 'sentence' | 'paragraph' | 'message';

// Agent and Brainstorm types
export type AgentType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'github-copilot';
export type PersonaType = 'neutral' | 'architect' | 'pragmatist' | 'engineer' | 'reviewer' | 'designer' | 'custom';
export type BrainstormPhase = 'initial' | 'individual' | 'discussion' | 'synthesis' | 'complete';
export type DiscussionMode = 'quick' | 'full';

export interface ContextItem {
  id: string;
  type: 'file' | 'selection' | 'folder' | 'symbol';
  path: string;
  content?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  context?: ContextItem[];
  thinking?: string;
  toolCalls?: ToolCall[];
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

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  fileChange?: FileChangeInfo;
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

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => string;
}

export interface WebviewMessage {
  type: string;
  payload?: unknown;
}

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
}

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
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
}

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'auth_error' | 'done' | 'session_active' | 'ask_user_question' | 'exit_plan_mode';
  content?: string;
  toolCall?: ToolCall;
  sessionId?: string;
  usage?: UsageStats;
  askUserQuestion?: AskUserQuestionData;
  planFilePath?: string | null;
  // Auth error specific fields
  authCommand?: string;
  providerName?: string;
}

// Brainstorm mode configuration
export interface BrainstormConfig {
  enabled: boolean;
  agents: AgentType[];
  discussionMode: DiscussionMode;
  discussionRounds: 1 | 2 | 3;
  synthesisAgent: AgentType;
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
}

// Brainstorm session state
export interface BrainstormSession {
  id: string;
  query: string;
  phase: BrainstormPhase;
  agents: AgentConfig[];
  agentResponses: Map<AgentType, AgentResponse>;
  discussionRounds: DiscussionRound[];
  unifiedSolution: string | null;
  createdAt: number;
  updatedAt: number;
}

// Streaming chunk for brainstorm mode
export interface BrainstormStreamChunk {
  type: 'agent_text' | 'agent_thinking' | 'agent_complete' | 'agent_error' |
        'discussion_text' | 'synthesis_text' | 'phase_change' | 'done';
  agentId?: AgentType;
  content?: string;
  phase?: BrainstormPhase;
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
  | 'multi-file-edit';

export type PermissionStatus = 'pending' | 'approved' | 'denied' | 'expired';

export type PermissionTimeoutBehavior = 'auto-accept' | 'auto-reject' | 'require-action';

export type PermissionRiskLevel = 'low' | 'medium' | 'high';

export interface PermissionConfig {
  timeout: number;                         // Seconds (0 = no timeout)
  timeoutBehavior: PermissionTimeoutBehavior;
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
