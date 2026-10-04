import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';
const settings: Settings = { mode: 'ask-before-edit', thinkingLevel: 'none', accessLevel: 'ask-permission', contextMode: 'manual', model: '', provider: 'openclaw' };
beforeEach(clearMockConfig);
describe('OpenClaw authority contract', () => {
  it.each([
    { mode: 'quick-plan' }, { mode: 'detailed-plan' }, { accessLevel: 'read-only' },
    { mode: 'ask-before-edit', accessLevel: 'full-access' }, { mode: 'edit-automatically' },
  ] as Partial<Settings>[])('rejects unsupported restrictions before either transport: %j', async override => {
    const provider = new TestableOpenClawProvider();
    const gateway = (provider as any)._gateway;
    const connect = vi.spyOn(gateway, 'connect');
    const spawn = vi.spyOn(provider, 'buildCliArgs');
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('test', [], { ...settings, ...override }, null)) { chunks.push(chunk); }
    expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
    expect(connect).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); provider.dispose();
  });
  it('never generates nonexistent CLI permission flags', () => {
    const provider = new TestableOpenClawProvider();
    const args = provider.buildCliArgs({ ...settings, mode: 'edit-automatically', accessLevel: 'full-access' }, createOpenClawSession());
    expect(args).not.toContain('--sandbox'); expect(args).not.toContain('--yolo'); provider.dispose();
  });
});
