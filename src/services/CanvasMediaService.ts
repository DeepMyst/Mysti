/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { CanvasCapabilityRegistry } from '../managers/CanvasCapabilityRegistry';
import type { ArtifactStore } from '../managers/ArtifactStore';
import type { CanvasAssetRecord, CanvasOp } from '../types';
import { CanvasMediaCancelled, CanvasMediaOperation } from '../canvas/CanvasMediaOperation';

/**
 * Media generation for the canvas (Plan 05 §9 / Phase 6.3): `generate_visual`
 * and `generate_video` resolve their capability through the
 * {@link CanvasCapabilityRegistry} — **DeepMyst-brokered (fal via the hub)**
 * when connected, the **local BYO-key service** otherwise, or a clear
 * "connect it" error when off — and every result lands in the artifact's
 * content-addressed asset store with full provenance (prompt/model/role/page).
 *
 * All effectful edges are injected (`callBrokered`, `generateLocal`,
 * `fetchBytes`), so routing + persistence are pure and unit-testable; the
 * extension wires the real `McpClient`, `ImageGenerationService`, and fetch.
 */

export type MediaKind = 'image' | 'video';

export interface GenerateMediaRequest {
  kind: MediaKind;
  prompt: string;
  /** Asset role for provenance (hero/background/illustration/icon/...). */
  role?: string;
  /** Page this asset is being generated for (provenance). */
  sourcePageId?: string;
  size?: { width: number; height: number };
}

/** A brokered/local generation outcome before persistence. */
export interface GeneratedMedia {
  /** Raw bytes, base64. Exactly one of base64/url is required. */
  base64?: string;
  /** URL to fetch the bytes from (fal returns CDN urls). */
  url?: string;
  mimeType: string;
  /** Model that produced it (provenance). */
  model?: string;
}

export interface CanvasMediaDeps {
  registry: CanvasCapabilityRegistry;
  /** Call the brokered (DeepMyst-hub) generator for a kind. */
  callBrokered(kind: MediaKind, req: GenerateMediaRequest, signal: AbortSignal): Promise<GeneratedMedia>;
  /** Call the local BYO-key generator for a kind. */
  generateLocal(kind: MediaKind, req: GenerateMediaRequest, signal: AbortSignal): Promise<GeneratedMedia>;
  /** Download bytes for URL results (returns base64). */
  fetchBytes(url: string, signal: AbortSignal): Promise<{ base64: string; mimeType?: string }>;
  store: ArtifactStore;
}

export interface GenerateMediaResult {
  ok: boolean;
  /** The persisted, provenance-tracked asset (on success). */
  asset?: CanvasAssetRecord;
  /** How the request was fulfilled. */
  source?: 'deepmyst' | 'local';
  error?: string;
  /** Set when the capability is off — the UI turns this into a connect card. */
  connectHint?: string;
  /** Accepted commits may need persistence recovery; cancellation cannot undo them. */
  committed?: boolean;
  persisted?: boolean;
  cancelled?: boolean;
  pending?: boolean;
  opId?: string;
  status?: CanvasOp['status'];
  recoveryRetained?: boolean;
  cleanupIncomplete?: boolean;
}

const KIND_TO_SLUG = { image: 'canvas-image', video: 'canvas-video' } as const;

export class CanvasMediaService {
  private _deps: CanvasMediaDeps;

  constructor(deps: CanvasMediaDeps) {
    this._deps = { ...deps };
  }

  async generate(operation: CanvasMediaOperation, request: GenerateMediaRequest): Promise<GenerateMediaResult> {
    try {
      operation.assertCurrent();
      if (operation.store !== this._deps.store || !operation.destination) {
        return { ok: false, committed: false, error: 'No captured workspace destination for this media operation.' };
      }
      // Generation and provenance use the same admitted inputs, even if a
      // caller changes its object while a provider or download is pending.
      const req: GenerateMediaRequest = Object.freeze({ ...request,
        ...(request.size ? { size: Object.freeze({ ...request.size }) } : {}),
      });
      const slug = KIND_TO_SLUG[req.kind];
      const status = this._deps.registry.resolve(slug);
      operation.assertCurrent();
      if (!status.enabled) {
        return { ok: false, committed: false,
          error: `${req.kind} generation is not connected. Connect it via DeepMyst (fal) or add a local API key.`,
          connectHint: slug };
      }
      const media = status.source === 'deepmyst'
        ? await operation.wait(() => this._deps.callBrokered(req.kind, req, operation.signal))
        : await operation.wait(() => this._deps.generateLocal(req.kind, req, operation.signal));

      let base64 = media.base64;
      let mimeType = media.mimeType;
      const model = media.model;
      if (!base64 && media.url) {
        const url = media.url;
        const fetched = await operation.wait(() => this._deps.fetchBytes(url, operation.signal));
        base64 = fetched.base64;
        mimeType = fetched.mimeType || mimeType;
      }
      if (!base64) {
        return { ok: false, committed: false, error: 'generator returned no media content' };
      }

      // The record role is the storage kind; the intent (hero/background/...)
      // travels in the prompt provenance.
      const role: CanvasAssetRecord['role'] =
        req.kind === 'video' ? 'video' : req.role === 'icon' || req.role === 'svg' ? req.role : 'image';
      operation.assertCurrent();
      // Do not race this promise against Stop: once the store admits its final
      // publication, that exact accepted commit must finish or retain recovery.
      const committed = await this._deps.store.commitGeneratedAsset(operation.destination, Buffer.from(base64, 'base64'), mimeType, {
        role,
        prompt: req.role ? `[${req.role}] ${req.prompt}` : req.prompt,
        model,
        size: req.size,
        sourcePageId: req.sourcePageId,
      }, operation.control, operation.submission);
      if (committed.state === 'refused') {
        return { ok: false, committed: false, cancelled: committed.reason === 'cancelled' || committed.reason === 'stale',
          error: committed.error ?? `Canvas media commit refused: ${committed.reason}.`,
          ...(committed.cleanupIncomplete ? { cleanupIncomplete: true } : {}) };
      }
      if (committed.state === 'retired') {
        return { ok: false, committed: true, persisted: false,
          error: `The accepted media edit was retired because the design was ${committed.reason}.` };
      }
      if (committed.state === 'unsaved') {
        return { ok: false, committed: true, persisted: false, recoveryRetained: true,
          opId: committed.opId, error: committed.error };
      }
      // Publication is secondary to the completed store write; a failed view
      // notification must not misreport an accepted edit as uncommitted.
      let publicationError: string | undefined;
      try { operation.publish(); }
      catch (error) { publicationError = error instanceof Error ? error.message : String(error); }
      return { ok: true, committed: true, persisted: true, asset: committed.asset,
        opId: committed.op.opId, status: committed.op.status,
        pending: committed.op.status === 'pending' || committed.op.status === 'stale',
        source: status.source as 'deepmyst' | 'local',
        ...(committed.cleanupIncomplete ? { cleanupIncomplete: true } : {}),
        ...(publicationError ? { error: `Media saved; Canvas refresh failed: ${publicationError}` } : {}) };
    } catch (err) {
      return { ok: false, committed: false, ...(err instanceof CanvasMediaCancelled ? { cancelled: true } : {}),
        error: err instanceof Error ? err.message : String(err) };
    } finally {
      operation.dispose();
    }
  }
}
