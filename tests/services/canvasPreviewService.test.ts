/**
 * CanvasPreviewService tests — the render→screenshot→vision-critique self-QA
 * loop with the Playwright/vision calls mocked. Covers the critique prompt, the
 * tolerant response parser, and the orchestration (success + failure).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CanvasPreviewService,
  buildCritiquePrompt,
  parseCritique,
} from '../../src/services/CanvasPreviewService';
import type { PreviewDeps } from '../../src/services/CanvasPreviewService';
import { DesignSpecManager } from '../../src/managers/DesignSpecManager';
import { getFormat } from '../../src/managers/CanvasFormats';
import type { ArtifactPage } from '../../src/types';

const theme = DesignSpecManager.getDefaultTheme();
const format = getFormat('desktop')!;
const page: ArtifactPage = { id: 'p1', version: 1, mode: 'jsx', jsxSource: 'function Page(){return <div/>;}', actionTitle: 'Home' };
const runtime = { headScripts: [], harness: '' };

describe('buildCritiquePrompt', () => {
  it('describes the screen, demands strict JSON, and embeds questions', () => {
    const p = buildCritiquePrompt(page, format, ['Is the title readable?', 'Any overflow?']);
    expect(p).toContain('desktop');
    expect(p).toContain('STRICT JSON');
    expect(p).toContain('"issues"');
    expect(p).toContain('(1) Is the title readable?');
    expect(p).toContain('"answers"');
  });
  it('omits the answers contract when no questions', () => {
    expect(buildCritiquePrompt(page, format)).not.toContain('"answers"');
  });
});

describe('parseCritique', () => {
  it('parses strict JSON issues + answers', () => {
    const r = parseCritique('{"issues":[{"severity":"error","message":"title clipped"}],"answers":["yes"]}');
    expect(r.issues).toEqual([{ severity: 'error', message: 'title clipped' }]);
    expect(r.answers).toEqual(['yes']);
  });
  it('tolerates a ```json fenced block', () => {
    const r = parseCritique('Here:\n```json\n{"issues":[{"severity":"warning","message":"low contrast"}]}\n```');
    expect(r.issues[0].message).toBe('low contrast');
  });
  it('coerces an unknown severity to warning and drops message-less items', () => {
    const r = parseCritique('{"issues":[{"severity":"nope","message":"x"},{"severity":"error"}]}');
    expect(r.issues).toEqual([{ severity: 'warning', message: 'x' }]);
  });
  it('clean screen → no issues', () => {
    expect(parseCritique('{"issues":[]}').issues).toEqual([]);
  });
  it('falls back to one info issue when the response is not JSON', () => {
    const r = parseCritique('The layout looks unbalanced on the right.');
    expect(r.issues).toEqual([{ severity: 'info', message: 'The layout looks unbalanced on the right.' }]);
  });
});

describe('CanvasPreviewService.renderPreview', () => {
  it('captures, analyzes, and returns parsed issues + the png', async () => {
    const deps: PreviewDeps = {
      capturePng: vi.fn().mockResolvedValue('PNGBASE64'),
      analyze: vi.fn().mockResolvedValue('{"issues":[{"severity":"warning","message":"cramped footer"}]}'),
    };
    const svc = new CanvasPreviewService(deps);
    const r = await svc.renderPreview({ page, theme, format, runtime });
    expect(r.ok).toBe(true);
    expect(r.previewBase64).toBe('PNGBASE64');
    expect(r.issues).toEqual([{ severity: 'warning', message: 'cramped footer' }]);
    // capture got real HTML built from the page (contains the page root + format size).
    const html = (deps.capturePng as any).mock.calls[0][0];
    expect(html).toContain('__mysti_page');
    expect(html).toContain('1440px');
  });

  it('returns ok:false with the error when capture fails', async () => {
    const deps: PreviewDeps = {
      capturePng: vi.fn().mockRejectedValue(new Error('browser launch failed')),
      analyze: vi.fn(),
    };
    const r = await new CanvasPreviewService(deps).renderPreview({ page, theme, format, runtime });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('browser launch failed');
    expect(deps.analyze).not.toHaveBeenCalled();
  });
});
