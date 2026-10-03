import { afterEach, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
afterEach(clearMockConfig);
it('disabling suggestions prevents the background provider call and loading UI', async () => {
  setMockConfig('showSuggestions', false);
  const view = Object.create(ChatViewProvider.prototype) as any;
  view._suggestionManager = { generateSuggestions: vi.fn() };
  view._postToPanel = vi.fn();
  await view._generateSuggestionsAsync({ content: 'test' }, 'panel');
  expect(view._suggestionManager.generateSuggestions).not.toHaveBeenCalled();
  expect(view._postToPanel).not.toHaveBeenCalled();
});
