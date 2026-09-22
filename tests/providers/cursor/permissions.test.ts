import { describe, it, expect, vi } from 'vitest';
import { TestableCursorProvider, TestableContinueProvider } from '../../helpers/providerFactory';
import { createCursorSession, createContinueSession } from '../../helpers/sessionFactory';
import type { Settings, StreamChunk } from '../../../src/types';

const modes: Settings['mode'][] = ['default', 'ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'];
const levels: Settings['accessLevel'][] = ['read-only', 'ask-permission', 'full-access'];

describe.each([
  ['Cursor', TestableCursorProvider, createCursorSession],
  ['Continue', TestableContinueProvider, createContinueSession],
] as const)('%s legacy execution boundary', (_name, Provider, session) => {
  for (const mode of modes) {
    for (const accessLevel of levels) {
      const unrestricted = accessLevel === 'full-access' && (mode === 'default' || mode === 'edit-automatically');
      it(`${mode}/${accessLevel}: ${unrestricted ? 'explicit autonomy' : 'rejects before discovery or prompt preparation'}`, async () => {
        const provider = new Provider();
        const settings: Settings = { mode, accessLevel, thinkingLevel: 'none', contextMode: 'auto', model: '', provider: provider.id };
        if (unrestricted) {
          const args = provider.buildCliArgs(settings, session());
          expect(args).toContain(provider.id === 'cursor' ? '--force' : '--allow');
          return;
        }
        expect(() => provider.buildCliArgs(settings, session())).toThrow('cannot enforce');
        const discover = vi.spyOn(provider, 'getCliPath').mockImplementation(() => { throw new Error('must not discover'); });
        const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockRejectedValue(new Error('must not prepare'));
        const chunks: StreamChunk[] = [];
        for await (const chunk of provider.sendMessage('write a marker', [], settings, null, undefined, 'restricted')) { chunks.push(chunk); }
        expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
        expect(JSON.stringify(chunks)).toContain('This turn was not started');
        expect(discover).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
        provider.dispose();
      });
    }
  }
});
