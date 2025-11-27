import type * as vscode from 'vscode';
import type {
  ContextItem,
  Settings,
  Conversation,
  StreamChunk,
  ProviderConfig,
  ModelInfo
} from '../../types';

/**
 * Result of CLI discovery attempt
 */
export interface CliDiscoveryResult {
  found: boolean;
  path: string;
  version?: string;
  installCommand?: string;
}

/**
 * Authentication configuration for a provider
 */
export interface AuthConfig {
  type: 'api-key' | 'oauth' | 'cli-login' | 'none';
  isAuthenticated: boolean;
  configPath?: string;
}

/**
 * Provider capabilities - what each provider supports
 */
export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsThinking: boolean;
  supportsToolUse: boolean;
  supportsSessions: boolean;
}

/**
 * Agent persona configuration for brainstorm mode
 */
export type PersonaType = 'neutral' | 'architect' | 'pragmatist' | 'engineer' | 'reviewer' | 'designer' | 'custom';

export interface PersonaConfig {
  type: PersonaType;
  customPrompt?: string;
}

/**
 * Persona prompt definitions
 */
export const PERSONA_PROMPTS: Record<Exclude<PersonaType, 'custom'>, string> = {
  neutral: '', // No additional framing
  architect: `[Persona: Architect] Focus on system design, architectural patterns, scalability, and clean code structure. Consider separation of concerns, SOLID principles, and long-term maintainability. Prefer elegant, well-structured solutions.`,
  pragmatist: `[Persona: Pragmatist] Focus on practical implementation, getting things done efficiently, and solving the immediate problem. Favor simple, working solutions over perfect abstractions. Consider time-to-implement and real-world constraints.`,
  engineer: `[Persona: Engineer] Focus on technical correctness, performance optimization, and edge case handling. Consider memory efficiency, algorithmic complexity, error handling, and robustness. Be precise and thorough.`,
  reviewer: `[Persona: Reviewer] Focus on code quality, potential issues, security vulnerabilities, and improvements. Look for bugs, anti-patterns, and opportunities to improve readability and maintainability.`,
  designer: `[Persona: Designer] Focus on API design, user experience, and interface clarity. Consider how developers will use this code, naming conventions, documentation needs, and intuitive interfaces.`
};

/**
 * Base interface for all CLI-based AI providers
 */
export interface ICliProvider {
  // Identity
  readonly id: string;
  readonly displayName: string;
  readonly config: ProviderConfig;
  readonly capabilities: ProviderCapabilities;

  // Lifecycle
  initialize(): Promise<void>;
  dispose(): void;

  // CLI Discovery
  discoverCli(): Promise<CliDiscoveryResult>;
  getCliPath(): string;

  // Authentication
  getAuthConfig(): Promise<AuthConfig>;
  checkAuthentication(): Promise<boolean>;

  // Message Handling
  sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    providerManager?: unknown  // ProviderManager for process registration
  ): AsyncGenerator<StreamChunk>;

  // Request Management
  cancelCurrentRequest(): void;
  clearSession(): void;
  hasSession(): boolean;
  getSessionId(): string | null;

  // Utility
  enhancePrompt?(prompt: string): Promise<string>;
}

/**
 * Constructor type for providers
 */
export interface ICliProviderConstructor {
  new(context: vscode.ExtensionContext): ICliProvider;
}
