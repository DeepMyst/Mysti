/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { ARTIFACT_SCHEMA_VERSION } from '../managers/ArtifactStore';
import type { CanvasArtifact } from '../types';

const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * A closing Canvas could not save its design and the view's in-memory copy is
 * going away. Write a never-overwriting recovery copy, in `artifact.json`
 * format, outside the workspace (whose save just failed). Returns the truthful
 * user-facing outcome: where the copy is, or that the edits were lost.
 *
 * The design is serialized before the first await, so the copy is exactly the
 * state close failed to persist. It is never restored automatically: that could
 * overwrite newer edits or resurrect a deleted design.
 */
export async function retainUnsavedCanvasDesign(
  storageDir: string | undefined, artifact: CanvasArtifact, cause: unknown, now = Date.now(),
): Promise<string> {
  const name = artifact.name || 'Untitled design';
  const reason = cause === undefined ? 'unknown error' : detail(cause);
  let serialized: string;
  try {
    serialized = JSON.stringify({ ...artifact, schemaVersion: ARTIFACT_SCHEMA_VERSION }, null, 2);
    if (!storageDir) { throw new Error('no extension storage is available'); }
    const dir = path.join(storageDir, 'canvas-recovery');
    const file = path.join(dir, `${String(artifact.id).replace(/[^A-Za-z0-9_-]/g, '_')}-${now}.json`);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, serialized, { encoding: 'utf8', flag: 'wx' });
    return `Mysti Canvas could not save "${name}" when it closed (${reason}). `
      + `Your unsaved changes were kept in a recovery copy: ${file}`;
  } catch (error) {
    return `Mysti Canvas could not save "${name}" when it closed (${reason}), `
      + `and a recovery copy could not be written (${detail(error)}). Its unsaved changes were lost.`;
  }
}
