/** Real composer controls shared by the native journey and owned browser controls. */
import * as assert from 'assert';
import type { Frame } from 'playwright';
export type EffortDom = { settingsSelect: string; inlineSelect: string; label: string; sliderValue: string | null; sliderValueText: string | null };
export async function effortDom(frame: Frame): Promise<EffortDom> {
  return frame.evaluate(() => {
    const doc = (globalThis as any).document, slider = doc.getElementById('model-menu-effort-slider');
    return { settingsSelect: doc.getElementById('effort-select')?.value ?? '', inlineSelect: doc.getElementById('effort-select-inline')?.value ?? '',
      label: doc.getElementById('model-menu-effort')?.textContent?.trim() ?? '', sliderValue: slider?.value ?? null, sliderValueText: slider?.getAttribute('aria-valuetext') ?? null };
  });
}
export function assertLowEffort(dom: EffortDom): void {
  assert.strictEqual(dom.settingsSelect, 'low'); assert.strictEqual(dom.inlineSelect, 'low');
  assert.strictEqual(dom.label.toLowerCase(), 'low'); assert.strictEqual(dom.sliderValueText?.toLowerCase(), 'low');
  assert.ok(dom.sliderValue !== null && /^\d+$/.test(dom.sliderValue));
}
export async function selectLowEffort(frame: Frame): Promise<{ before: EffortDom; after: EffortDom; levels: string[] }> {
  const before = await effortDom(frame); await frame.locator('#model-menu-btn').click();
  const levels = await frame.locator('#effort-select-inline option').evaluateAll(elements => elements.map(element => element.getAttribute('value')!));
  assert.ok(levels.includes('low')); const slider = frame.locator('#model-menu-effort-slider'); await slider.focus(); await slider.press('Home');
  for (let index = 0; index < levels.indexOf('low'); index++) await slider.press('ArrowRight');
  await frame.locator('#model-menu-btn').click(); const after = await effortDom(frame); assertLowEffort(after);
  assert.strictEqual(after.sliderValue, String(levels.indexOf('low'))); return { before, after, levels };
}
