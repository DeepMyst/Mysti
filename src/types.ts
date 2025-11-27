export type OperationMode = 'ask-before-edit' | 'edit-automatically' | 'plan' | 'brainstorm';
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';
export type AccessLevel = 'read-only' | 'ask-permission' | 'full-access';
export type ContextMode = 'auto' | 'manual';
export type ProviderType = 'claude-code' | 'openai-codex';

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

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'done' | 'session_active';
  content?: string;
  toolCall?: ToolCall;
  sessionId?: string;
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
