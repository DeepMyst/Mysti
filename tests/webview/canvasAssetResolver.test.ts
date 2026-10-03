/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * CANVAS-SEC-3 — the two ends of the `asset://` grammar must be the SAME grammar.
 *
 * `ArtifactStore.addAsset` mints a three-segment ref
 * (`asset://<artifactId>/assets/<sha>.<ext>`) and `resolveAssetPath` re-states
 * that shape as the contract. `makeAssetResolver` accepted only a flat,
 * slash-free name, so it returned `null` for 100% of real refs: the static
 * preview dropped the `<img src>` and bumped `stats.dropped`, and the live frame
 * received the unresolved `asset://…` string, which `harness.js`'s `safeUrl`
 * refuses because `asset:` is not in `URL_OK_RE`. Every generated or imported
 * image in the product was invisible, in every renderer, with no error.
 *
 * The seam had no end-to-end test because both sides were pinned with
 * HAND-WRITTEN fixtures — which is exactly how they drifted. So the ref under
 * test here is produced by the real store, and the base URI is built the way
 * `ChatViewProvider._canvasAssetBaseUri` builds it: `<artifactDir>/assets`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { makeAssetResolver } from '../../src/webview/canvas/boot';
import { renderPreview } from '../../src/webview/canvas/preview';
import type { CanvasArtifact } from '../../src/types';
import type { DocNode } from '../../src/canvas/doc/DocNode';

describe('CANVAS-SEC-3: makeAssetResolver resolves the refs ArtifactStore actually mints', () => {
  let root: string;
  let store: ArtifactStore;
  let artifact: CanvasArtifact;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-canvas-asset-'));
    store = new ArtifactStore({ getRoot: () => root });
    artifact = store.createArtifact({ name: 'Assets' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Exactly what `ChatViewProvider._canvasAssetBaseUri` produces, minus vscode. */
  function assetBase(): string {
    const dir = store.artifactDir(artifact.id)!;
    return `vscode-webview://0a1b${dir}/assets`;
  }

  async function realRef(): Promise<string> {
    const png = Buffer.from('fake-png-bytes').toString('base64');
    const rec = await store.addAsset(artifact, png, 'image/png', { role: 'image' });
    expect(rec).not.toBeNull();
    return rec!.ref;
  }

  it('resolves a ref produced by addAsset (not a hand-written fixture)', async () => {
    const ref = await realRef();
    // Sanity: the producer really does mint three segments.
    expect(ref).toMatch(new RegExp(`^asset://${artifact.id}/assets/[a-f0-9]{16}\\.png$`));

    const resolved = makeAssetResolver(assetBase())(ref);
    expect(resolved).not.toBeNull();
    // The base ALREADY ends in `/assets`, so only the file segment is appended.
    expect(resolved).toBe(`${assetBase()}/${ref.split('/').pop()}`);
    expect(resolved).not.toContain('/assets/assets/');
  });

  it('the resolved URL survives preview.ts\'s independent second gate', async () => {
    const ref = await realRef();
    const doc: DocNode = {
      mid: 'aaaaaaaaaa', tag: 'UI.Screen',
      children: [{ mid: 'bbbbbbbbbb', tag: 'img', props: { src: ref } }],
    };
    const out = renderPreview(doc, { resolveAsset: makeAssetResolver(assetBase()) });
    const img = JSON.stringify(out.root);
    expect(img).toContain('vscode-webview://0a1b');
    expect(img).not.toContain('asset://');
    expect(out.stats.dropped).toBe(0);
  });

  it('still refuses traversal, wrong middle segment, and foreign schemes', async () => {
    const resolve = makeAssetResolver(assetBase());
    for (const ref of [
      `asset://${artifact.id}/assets/../artifact.json`,
      `asset://${artifact.id}/assets/../../../../etc/passwd`,
      `asset://../../.mysti/secrets.json`,
      `asset://${artifact.id}/secrets/x.png`,       // middle segment must be `assets`
      `asset://${artifact.id}/assets/a/b.png`,      // one file segment only
      `asset://${artifact.id}/assets/`,
      'asset:///etc/passwd',
      'https://evil.example/x.png',
      'asset://',
      `asset://${artifact.id}/assets/${'a'.repeat(500)}.png`,
    ]) {
      expect(resolve(ref)).toBeNull();
    }
  });

  it('resolves nothing at all when the host gave no asset base', async () => {
    const ref = await realRef();
    expect(makeAssetResolver(undefined)(ref)).toBeNull();
  });
});
