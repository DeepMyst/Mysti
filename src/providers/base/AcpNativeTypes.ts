/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { PanelSessionState } from './BaseCliProvider';
import type { Settings, ToolCall, UsageStats } from '../../types';
import type { AcpNativeClient } from './AcpNativeClient';

export type AcpObject = Record<string, unknown>;

export interface AcpNativeLaunchContext {
  settings: Readonly<Settings>;
  session: PanelSessionState;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cliPath: string;
  signal: AbortSignal;
}

/** Provider-specific native authority must be established before model input. */
export interface AcpNativeLaunch {
  args: string[];
  /** Complete environment, when supplied. Inherited values are not merged back. */
  env?: NodeJS.ProcessEnv;
  cliPath?: string;
  expectedAgentInfo?: { name?: string; version?: string };
  mode?: string;
  model?: string;
  /** Enable only when this exact native release consumes ACP image blocks. */
  images?: boolean;
  /** Always answered with MethodNotFound; verified agents may ignore optional UI requests. */
  nonFatalUnsupportedRequests?: readonly string[];
  /** Never infer authority from a display update without a verified provider contract. */
  decodePermission(params: Readonly<AcpObject>, trackedTool: Readonly<AcpObject> | undefined): ToolCall | undefined;
  decodeUsage?(update: Readonly<AcpObject>): UsageStats | undefined;
  validateInitialize?(result: Readonly<AcpObject>): void;
  validateSession?(result: Readonly<AcpObject>): void;
  /** Attest native permission-bearing option updates during setup and prompting. */
  validateUpdate?(update: Readonly<AcpObject>): void;
  /** Inspect verified provider-specific notifications for the owned session. */
  validateNotification?(method: string, params: Readonly<AcpObject>): void;
  configure?(client: AcpNativeClient, session: Readonly<AcpObject>, initialized: Readonly<AcpObject>): Promise<void>;
  /** Recheck policy after session creation/configuration, before the prompt. */
  assertUnchanged?(): Promise<void>;
  cleanup?(): Promise<void>;
}
