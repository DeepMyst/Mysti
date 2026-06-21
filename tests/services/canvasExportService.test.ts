/**
 * CanvasExportService tests — the self-contained HTML bundle (viewer + per-page
 * docs + shared runtime, all relative) and PNG export (via injected capture).
 */
import { describe, it, expect, vi } from 'vitest';
import { exportHtmlBundle, exportPng } from '../../src/services/CanvasExportService';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import type { CanvasArtifact } from '../../src/types';

function makeArtifact(): CanvasArtifact {
  const store = new ArtifactStore({ getRoot: () => null });
  const a = store.createArtifact({ name: 'My App', kind: 'screens' });
  store.insertPage(a, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){return <div>One</div>;}', actionTitle: 'Home' }));
  store.insertPage(a, store.makePage({ mode: 'html', htmlSource: '<h1>Two</h1>', actionTitle: 'Settings' }));
  return a;
}

const opts = {
  headRuntime: [
    { name: 'react.production.min.js', content: '/*react*/' },
    { name: 'babel.min.js', content: '/*babel*/' },
    { name: 'ui-primitives.js', content: '/*ui*/' },
  ],
  harness: { name: 'harness.js', content: '/*harness*/' },
};

describe('exportHtmlBundle', () => {
  const files = exportHtmlBundle(makeArtifact(), opts);
  const byPath = Object.fromEntries(files.map(f => [f.path, f]));

  it('emits a viewer, one html per page, and the shared runtime', () => {
    expect(byPath['index.html']).toBeTruthy();
    expect(byPath['pages/page-0.html']).toBeTruthy();
    expect(byPath['pages/page-1.html']).toBeTruthy();
    expect(byPath['runtime/react.production.min.js']).toBeTruthy();
    expect(byPath['runtime/harness.js'].content).toBe('/*harness*/');
  });

  it('the viewer lists the page titles and points its iframe at page 0', () => {
    const v = byPath['index.html'].content;
    expect(v).toContain('My App');
    expect(v).toContain('Home');
    expect(v).toContain('Settings');
    expect(v).toContain('pages/page-0.html');
  });

  it('page docs reference the runtime via relative ../runtime paths (portable, no inlining)', () => {
    const p0 = byPath['pages/page-0.html'].content;
    expect(p0).toContain('src="../runtime/react.production.min.js"');
    expect(p0).toContain('src="../runtime/harness.js"');
    expect(p0).toContain('function Page()');           // the page source
    expect(p0).not.toContain('/*react*/');             // not inlined
  });

  it('all files are utf8', () => {
    expect(files.every(f => f.encoding === 'utf8')).toBe(true);
  });
});

describe('exportPng', () => {
  it('captures one base64 PNG per page (runtime inlined as data URIs)', async () => {
    const capture = vi.fn().mockImplementation(async (html: string) => {
      expect(html).toContain('data:text/javascript;base64,'); // runtime inlined for headless capture
      return 'PNGDATA';
    });
    const out = await exportPng(makeArtifact(), { ...opts, capture });
    expect(out.map(f => f.path)).toEqual(['page-0.png', 'page-1.png']);
    expect(out.every(f => f.encoding === 'base64' && f.content === 'PNGDATA')).toBe(true);
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
