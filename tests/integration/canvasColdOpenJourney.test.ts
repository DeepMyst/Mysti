/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * The cold-open journey, against a REAL store on a REAL temp workspace.
 *
 * "Canvas is not loading designs" is the one report that has recurred, and each
 * time the static chain looked complete. This drives the whole host-side path a
 * first-time user takes — empty workspace → hello → pick a template → persist →
 * reopen — and asserts the artifact actually lands on disk and comes back.
 *
 * Every hop here was previously verified only by reading it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { CanvasBridge, type CanvasBridgeSession } from '../../src/canvas/CanvasBridge';
import { dispatchCanvasTool } from '../../src/managers/CanvasToolDispatch';
import { buildEmptyCanvasArtifact } from '../../src/webview/canvasContent';
import { listScaffolds } from '../../src/managers/CanvasScaffolds';
import type { CanvasArtifact } from '../../src/types';
import type { CanvasHostMessage } from '../../src/canvas/protocol';

const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';

describe('canvas cold-open journey (real store, temp workspace)', () => {
  let root: string;
  let store: ArtifactStore;
  let artifact: CanvasArtifact;
  let executor: CanvasOpExecutor;
  let history: CanvasHistory;
  let router: CanvasJobRouter;
  let posted: CanvasHostMessage[];
  let bridge: CanvasBridge;

  const canvasDir = () => path.join(root, '.mysti', 'canvas');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cold-open-'));
    store = new ArtifactStore({ getRoot: () => root });
    posted = [];
    router = new CanvasJobRouter(() => {});
    executor = new CanvasOpExecutor(store, router);
    // Exactly what openCanvas does on a workspace with no .mysti/canvas.
    artifact = buildEmptyCanvasArtifact('demo designs');
    history = new CanvasHistory(artifact, executor, { jobId: 'canvas-test' });
    const session: CanvasBridgeSession = { artifact, store, executor, history, jobRouter: router };
    bridge = new CanvasBridge({
      post: m => posted.push(m),
      session: () => session,
      viewToken: () => TOKEN,
      approvalMode: () => 'auto',
      caps: () => [],
      scheduleSave: () => { void store.save(artifact); },
      onAddScaffold: (scaffold) => {
        dispatchCanvasTool('scaffold_page', { scaffold }, {
          artifact, store, executor, jobId: 'j1', runId: 'human', approvalMode: 'auto',
        });
        void store.save(artifact);
      },
      log: () => {},
    });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('starts genuinely empty — nothing on disk, nothing to load', async () => {
    expect(artifact.pages).toHaveLength(0);
    expect(await store.list()).toEqual([]);
    expect(fs.existsSync(canvasDir())).toBe(false);
  });

  it('answers canvas/ready with a hello carrying the artifact', async () => {
    await bridge.handle({ t: 'canvas/ready', viewToken: TOKEN });
    const hello = posted.find(m => m.t === 'canvas/hello');
    expect(hello, `posted: ${posted.map(m => m.t).join(', ')}`).toBeDefined();
    expect((hello as { artifact: { pages: unknown[] } }).artifact.pages).toHaveLength(0);
  });

  it('turns an empty-state template click into a page that PERSISTS', async () => {
    const scaffold = listScaffolds()[0];
    expect(scaffold, 'no scaffolds are registered').toBeDefined();

    await bridge.handle({ t: 'canvas/addScaffold', scaffold: scaffold.id, viewToken: TOKEN });

    // In memory.
    expect(artifact.pages, 'the scaffold produced no page').toHaveLength(1);
    // And on disk — this is the half that "not loading designs" would break.
    await store.save(artifact);
    expect(fs.existsSync(canvasDir()), `.mysti/canvas was never created under ${root}`).toBe(true);
    const onDisk = path.join(canvasDir(), artifact.id, 'artifact.json');
    expect(fs.existsSync(onDisk), `no artifact.json at ${onDisk}`).toBe(true);
  });

  it('lists and reloads that design the way a second open does', async () => {
    await bridge.handle({ t: 'canvas/addScaffold', scaffold: listScaffolds()[0].id, viewToken: TOKEN });
    await store.save(artifact);

    // openCanvas: list() → load(summaries[0].id)
    const summaries = await store.list();
    expect(summaries, 'a saved design is not listed').toHaveLength(1);

    const reopened = await store.load(summaries[0].id);
    expect(reopened, 'the saved design failed to load').not.toBeNull();
    expect(reopened!.pages, 'the reloaded design lost its page').toHaveLength(1);
    expect(reopened!.pages[0].doc, 'the reloaded page has no document').toBeDefined();
  });

  it('rejects a client message carrying the wrong view token', async () => {
    await bridge.handle({ t: 'canvas/addScaffold', scaffold: listScaffolds()[0].id, viewToken: 'forged' });
    expect(artifact.pages).toHaveLength(0);
  });

  it('every shipped scaffold produces a renderable page', async () => {
    for (const s of listScaffolds()) {
      const fresh = buildEmptyCanvasArtifact('x');
      dispatchCanvasTool('scaffold_page', { scaffold: s.id }, {
        artifact: fresh, store, executor: new CanvasOpExecutor(store, router),
        jobId: 'j', runId: 'r', approvalMode: 'auto',
      });
      expect(fresh.pages, `scaffold "${s.id}" produced no page`).toHaveLength(1);
      expect(fresh.pages[0].doc ?? fresh.pages[0].legacy, `scaffold "${s.id}" has neither doc nor legacy`).toBeTruthy();
    }
  });
});
