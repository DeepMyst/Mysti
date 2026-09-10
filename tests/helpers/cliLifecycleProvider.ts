/** A neutral CLI adapter for testing base ownership without a provider's native handshake. */
import { BaseCliProvider, type PanelSessionState } from '../../src/providers/base/BaseCliProvider';
import type { ProviderCapabilities } from '../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../src/types';
import { createMockContext } from './providerFactory';

export class CliLifecycleProvider extends BaseCliProvider {
  readonly id = 'fixture';
  readonly displayName = 'Fixture';
  readonly config = { name: 'fixture', displayName: 'Fixture', models: [], defaultModel: '' };
  readonly capabilities: ProviderCapabilities;

  constructor(persistent = false, nativeApprovals = false) {
    super(createMockContext());
    this.capabilities = { supportsStreaming: true, supportsThinking: false, supportsToolUse: true,
      supportsSessions: false, supportsPersistentProcess: persistent, supportsNativeApproval: nativeApprovals };
  }
  async discoverCli() { return { found: true, path: '/mock/fixture' }; }
  getCliPath() { return '/mock/fixture'; }
  async getAuthConfig() { return { type: 'none' as const, isAuthenticated: true }; }
  async checkAuthentication() { return { authenticated: true }; }
  getAuthCommand() { return ''; }
  getInstallCommand() { return ''; }
  public buildCliArgs(_settings: Settings, _session: PanelSessionState) { return []; }
  protected buildPersistentCliArgs() { return this.capabilities.supportsPersistentProcess ? [] : null; }
  protected getThinkingTokens() { return undefined; }
  protected _isResponseBoundary(line: string) {
    try { return JSON.parse(line).type === 'result'; } catch { return false; }
  }
  public parseStreamLine(line: string): StreamChunk | null {
    try {
      const data = JSON.parse(line);
      const content = data.type === 'stream_event' ? data.event?.delta?.text
        : data.type === 'item.completed' && data.item?.type === 'agent_message' ? data.item.text
          : data.type === 'text' ? data.content : undefined;
      return typeof content === 'string' ? { type: 'text', content } : null;
    } catch { return null; }
  }
}
