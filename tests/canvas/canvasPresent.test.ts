/**
 * CanvasPresent tests (Plan 22 Phase 6 / parity row 7).
 *
 * `#btn-present` has posted `canvas/present` into the void since Plan 05. This
 * is the other half, and the point of the tests is that it is *not* a second
 * viewer: the document comes out of the same builder the export bundle uses,
 * and every artboard comes out of the same `buildPageDocument` the board uses.
 *
 * The one piece of logic Present genuinely owns — fit-to-screen — exists twice
 * by necessity (once in TS for the host, once as injected JS for the resize
 * handler), so it is exported as ONE expression and the equivalence is asserted
 * here rather than trusted.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPresentDocument,
  presentFitScale,
  presentPages,
  presentStartIndex,
  presentStep,
  presentNeedsEval,
  PRESENT_FIT_SCALE_JS,
  PRESENT_MAX_SCALE,
  PRESENT_MIN_SCALE,
  PRESENT_PADDING_PX,
} from '../../src/canvas/CanvasPresent';
import {
  EXPORT_PAGE_CSP,
  EXPORT_LEGACY_PAGE_CSP,
  VIEWER_MANIFEST_ID,
  makeDataUriAssetResolver,
} from '../../src/services/CanvasExportService';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import type { CanvasArtifact } from '../../src/types';

const LEGACY_JSX = 'function Page(){ return <div>{items.map(function (i) { return <span/>; })}</div>; }';

const runtime = {
  headRuntime: [{ name: 'react.js', content: '/*react*/' }, { name: 'ui.js', content: '/*ui*/' }],
  harness: { name: 'harness.js', content: '/*harness*/' },
  babel: { name: 'babel.min.js', content: '/*babel*/' },
};

function deck(...titles: string[]): CanvasArtifact {
  const store = new ArtifactStore({ getRoot: () => null });
  const a = store.createArtifact({ name: 'Deck', kind: 'screens' });
  for (const t of titles) {
    store.insertPage(a, store.makePage({ mode: 'jsx', jsxSource: `function Page(){return <div>${t}</div>;}`, actionTitle: t }));
  }
  return a;
}

function manifest(doc: string): Array<{ title: string; width: number; height: number; doc?: string }> {
  const json = new RegExp(`id="${VIEWER_MANIFEST_ID}">(.*?)</script>`, 's').exec(doc)![1];
  return JSON.parse(json);
}

describe('presentFitScale', () => {
  it('fits the artboard inside the viewport, padding included', () => {
    // 1000×1000 board, 600×600 viewport, 50px padding → 500/1000.
    expect(presentFitScale({ width: 1000, height: 1000 }, { width: 600, height: 600 }, { padding: 50 })).toBe(0.5);
  });

  it('is governed by the tighter axis', () => {
    const s = presentFitScale({ width: 1000, height: 2000 }, { width: 1000, height: 1000 }, { padding: 0 });
    expect(s).toBe(0.5);
  });

  it('upscales a small artboard (live DOM, not a bitmap) but not past the cap', () => {
    expect(presentFitScale({ width: 100, height: 100 }, { width: 4000, height: 4000 }, { padding: 0 }))
      .toBe(PRESENT_MAX_SCALE);
  });

  it('never collapses to zero on a tiny or absurd viewport', () => {
    expect(presentFitScale({ width: 4000, height: 4000 }, { width: 1, height: 1 })).toBe(PRESENT_MIN_SCALE);
    expect(presentFitScale({ width: 4000, height: 4000 }, { width: 0, height: 0 })).toBe(PRESENT_MIN_SCALE);
  });

  it('survives a garbage artboard size instead of returning NaN', () => {
    const s = presentFitScale(
      { width: Number.NaN, height: 0 } as unknown as { width: number; height: number },
      { width: 800, height: 600 },
    );
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBe(PRESENT_MAX_SCALE);
  });

  it('the injected JS expression computes exactly what the TS function does', () => {
    // The Present document has to recompute this on every resize; this is the
    // drift guard that lets it live in two languages.
    const js = new Function('w', 'h', 'vw', 'vh', 'min', 'max', `return ${PRESENT_FIT_SCALE_JS};`) as
      (w: number, h: number, vw: number, vh: number, min: number, max: number) => number;
    const cases: Array<[number, number, number, number]> = [
      [1000, 1000, 600, 600], [390, 844, 1920, 1080], [1440, 900, 800, 2000],
      [2480, 3508, 1280, 800], [100, 100, 4000, 4000], [1440, 900, 1, 1],
    ];
    for (const [w, h, vpW, vpH] of cases) {
      const pad = PRESENT_PADDING_PX;
      const vw = Math.max(1, vpW - pad * 2);
      const vh = Math.max(1, vpH - pad * 2);
      expect(js(w, h, vw, vh, PRESENT_MIN_SCALE, PRESENT_MAX_SCALE))
        .toBeCloseTo(presentFitScale({ width: w, height: h }, { width: vpW, height: vpH }), 10);
    }
  });
});

describe('paging', () => {
  const pages = deck('A', 'B', 'C').pages;

  it('opens on the selected artboard, or the first when there is none', () => {
    expect(presentStartIndex(pages, pages[2].id)).toBe(2);
    expect(presentStartIndex(pages, undefined)).toBe(0);
    expect(presentStartIndex(pages, 'ghost')).toBe(0);
    expect(presentStartIndex([], 'x')).toBe(0);
  });

  it('clamps at both ends rather than silently wrapping', () => {
    expect(presentStep(0, -1, 3)).toBe(0);
    expect(presentStep(2, 1, 3)).toBe(2);
    expect(presentStep(1, 1, 3)).toBe(2);
    expect(presentStep(1, -1, 3)).toBe(0);
  });

  it('wraps only when asked, in both directions', () => {
    expect(presentStep(2, 1, 3, true)).toBe(0);
    expect(presentStep(0, -1, 3, true)).toBe(2);
    expect(presentStep(0, -7, 3, true)).toBe(2);
  });

  it('survives an empty deck and hostile inputs', () => {
    expect(presentStep(0, 1, 0)).toBe(0);
    expect(presentStep(Number.NaN, Number.NaN, 3)).toBe(0);
    expect(presentStep(0, 1.9, 3)).toBe(1);
  });

  it('presentPages copies rather than aliasing the artifact', () => {
    const a = deck('A');
    const list = presentPages(a);
    list.push(list[0]);
    expect(a.pages).toHaveLength(1);
  });
});

describe('buildPresentDocument', () => {
  const a = deck('Home', 'Settings', 'Profile');
  const doc = buildPresentDocument({ artifact: a, runtime, startPageId: a.pages[1].id });

  it('carries every artboard as its own sandboxed, self-contained document', () => {
    const frames = manifest(doc);
    expect(frames.map(f => f.title)).toEqual(['Home', 'Settings', 'Profile']);
    for (const f of frames) {
      expect(f.doc).toContain('/*harness*/');
      expect(f.doc).toContain(EXPORT_PAGE_CSP);
      expect(f.doc).not.toContain('<script src=');
    }
    expect(doc).toMatch(/<iframe[^>]*\ssandbox="allow-scripts"/);
    expect(doc).not.toContain('allow-same-origin');
    expect(doc.match(/<iframe/g)).toHaveLength(1);
  });

  it('opens on the artboard Present was invoked from', () => {
    expect(doc).toContain('var i = 1;');
  });

  it('is full-bleed and self-contained — it posts nothing to a host', () => {
    expect(doc).toContain('class="present"');
    expect(doc).not.toContain('acquireVsCodeApi');
    expect(doc).not.toContain('postMessage');
    expect(doc).toContain(PRESENT_FIT_SCALE_JS);
  });

  it('does not allow eval for an all-document deck', () => {
    expect(presentNeedsEval(a.pages)).toBe(false);
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(doc)![1];
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-src 'self';");
    expect(csp).not.toContain('https:');
  });

  it('allows eval exactly when a legacy artboard is in the deck (srcdoc inherits the embedder policy)', () => {
    const store = new ArtifactStore({ getRoot: () => null });
    const mixed = store.createArtifact({ name: 'Mixed', kind: 'screens' });
    store.insertPage(mixed, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){return <div/>;}' }));
    const legacy = store.insertPage(mixed, store.makePage({ mode: 'jsx', jsxSource: LEGACY_JSX }));
    expect(legacy.legacy?.mode).toBe('jsx');
    expect(presentNeedsEval(mixed.pages)).toBe(true);

    const out = buildPresentDocument({ artifact: mixed, runtime });
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(out)![1];
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    const frames = manifest(out);
    expect(frames[0].doc).not.toContain('/*babel*/');       // the doc page stays compiler-free
    expect(frames[1].doc).toContain('/*babel*/');
    expect(frames[1].doc).toContain(EXPORT_LEGACY_PAGE_CSP);
  });

  it('escapes a hostile artboard title in both the manifest and the document', () => {
    const hostile = deck('</script><script>fetch("//evil")</script>');
    const out = buildPresentDocument({ artifact: hostile, runtime });
    expect(out).not.toContain('</script><script>fetch');
    expect(manifest(out)[0].title).toBe('</script><script>fetch("//evil")</script>');
  });

  it('R4-3 threads the asset resolver through to every artboard document', () => {
    // Present has no files on disk, so an `asset://` ref that is not resolved
    // is an image the viewer simply does not have. The resolver rides in the
    // shared `HtmlBundleOptions` bag; this asserts Present does not rebuild
    // that bag and drop the field.
    const store = new ArtifactStore({ getRoot: () => null });
    const a = store.createArtifact({ name: 'Assets', kind: 'screens' });
    const ref = `asset://${a.id}/assets/deadbeef0011.png`;
    store.insertPage(a, store.makePage({
      mode: 'jsx',
      jsxSource: `function Page(){ return <div><img src="${ref}" /></div>; }`,
    }));
    const out = buildPresentDocument({
      artifact: a,
      runtime: { ...runtime, resolveAsset: makeDataUriAssetResolver([{ ref, base64: 'AAAA' }]) },
    });
    expect(manifest(out)[0].doc).toContain('data:image/png;base64,AAAA');
    expect(out).not.toContain('asset:');
  });

  it('never carries the panel CSP nonce into the Present document', () => {
    // Present builds its artboards through the export path, which is nonce-free
    // by construction: the panel shell's nonce authorises the PANEL's scripts,
    // and a document that leaves the editor must not depend on it.
    const out = buildPresentDocument({ artifact: deck('One', 'Two'), runtime });
    expect(out).not.toContain('nonce=');
    expect(out).not.toContain("'nonce-");
  });

  it('handles an empty design without throwing', () => {
    const empty = new ArtifactStore({ getRoot: () => null }).createArtifact({ name: 'Empty', kind: 'screens' });
    const out = buildPresentDocument({ artifact: empty, runtime });
    expect(manifest(out)).toEqual([]);
    expect(out).toContain('class="present"');
  });
});
