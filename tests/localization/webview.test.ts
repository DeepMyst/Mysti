import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { env, l10n } from '../helpers/mockVscode';
import { getWebviewLocalizationScript } from '../../src/localization';

afterEach(() => { env.language = 'en'; vi.restoreAllMocks(); });
describe('localized webview chrome', () => {
  it('does not install an observer for English', () => { expect(getWebviewLocalizationScript()).toBe(''); });
  it('translates dynamic chrome without changing user, agent or code content', async () => {
    env.language = 'ru';
    vi.spyOn(l10n, 't').mockImplementation(s => s === 'Cancel' ? 'Отмена' : s);
    const dom = new JSDOM('<body><button>  Cancel  </button><div class="message-content">Cancel</div><div class="subagent-content">Cancel</div><code>Cancel</code><textarea>Cancel</textarea><span>constructor</span></body>', { runScripts: 'outside-only' });
    try {
      dom.window.eval(getWebviewLocalizationScript());
      expect(dom.window.document.querySelector('button')?.textContent).toBe('  Отмена  ');
      for (const selector of ['.message-content', '.subagent-content', 'code', 'textarea']) {
        expect(dom.window.document.querySelector(selector)?.textContent).toBe('Cancel');
      }
      expect(dom.window.document.querySelector('span')?.textContent).toBe('constructor');
      const button = dom.window.document.createElement('button'); button.title = 'Cancel'; button.textContent = 'Cancel';
      dom.window.document.body.append(button);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(button.textContent).toBe('Отмена'); expect(button.title).toBe('Отмена');
    } finally { dom.window.close(); }
  });
  it('escapes script terminators in translated catalogs', () => {
    env.language = 'ru'; vi.spyOn(l10n, 't').mockImplementation(s => s === 'Cancel' ? '</script><script>bad()</script>' : s);
    expect(getWebviewLocalizationScript()).not.toContain('</script>');
  });
});
