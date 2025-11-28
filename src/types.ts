export type OperationMode = 'ask-before-edit' | 'edit-automatically' | 'plan' | 'brainstorm';
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';
export type AccessLevel = 'read-only' | 'ask-permission' | 'full-access';
export type ContextMode = 'auto' | 'manual';
export type ProviderType = 'claude-code' | 'openai-codex';
export type AutocompleteType = 'sentence' | 'paragraph' | 'message';

// Agent and Brainstorm types
export type AgentType = 'claude-code' | 'openai-codex';
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

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'done' | 'session_active';
  content?: string;
  toolCall?: ToolCall;
  sessionId?: string;
  usage?: UsageStats;
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
  executionMode: 'edit-automatically' | 'ask-before-edit' | 'plan';
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
