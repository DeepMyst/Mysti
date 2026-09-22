/**
 * Hermes asks only for denylisted shell commands and file edits; Kimi Code
 * auto-approves in-repository writes, fetches, subagents and skills and honours
 * an inherited yolo/auto default. Neither can enforce a restricted Mysti tier,
 * so those turns must stop before discovery, spawn or prompt preparation.
 */
import { describe, expect, it, vi } from 'vitest';
import { TestableHermesProvider, TestableKimiProvider } from '../helpers/providerFactory';
import type { Settings, StreamChunk } from '../../src/types';

const modes: Settings['mode'][] = ['default', 'ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'];
const levels: Settings['accessLevel'][] = ['read-only', 'ask-permission', 'full-access'];

describe.each([
  ['Hermes', () => new TestableHermesProvider()],
  ['Kimi Code', () => new TestableKimiProvider()],
] as const)('%s restricted tiers', (_name, create) => {
  for (const mode of modes) {
    for (const accessLevel of levels) {
      if (accessLevel === 'full-access' && (mode === 'default' || mode === 'edit-automatically')) { continue; }
      it(`${mode}/${accessLevel} is rejected before discovery or spawn`, async () => {
        const provider = create();
        const settings: Settings = { mode, accessLevel, thinkingLevel: 'none', contextMode: 'auto', model: '', provider: provider.id };
        const discover = vi.spyOn(provider, 'getCliPath').mockImplementation(() => { throw new Error('must not discover'); });
        const spawn = vi.spyOn(provider as unknown as { _spawnCliProcess(): never }, '_spawnCliProcess').mockImplementation(() => { throw new Error('must not spawn'); });
        const chunks: StreamChunk[] = [];
        for await (const chunk of provider.sendMessage('write a marker', [], settings, null, undefined, 'restricted')) { chunks.push(chunk); }
        expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
        expect(JSON.stringify(chunks)).toContain('This turn was not started');
        expect(discover).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
        provider.dispose();
      });
    }
  }
});
