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
import type { CanvasArtifact, CanvasAssetRecord } from '../types';

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
  callBrokered(kind: MediaKind, req: GenerateMediaRequest): Promise<GeneratedMedia>;
  /** Call the local BYO-key generator for a kind. */
  generateLocal(kind: MediaKind, req: GenerateMediaRequest): Promise<GeneratedMedia>;
  /** Download bytes for URL results (returns base64). */
  fetchBytes(url: string): Promise<{ base64: string; mimeType?: string }>;
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
}

const KIND_TO_SLUG = { image: 'canvas-image', video: 'canvas-video' } as const;

export class CanvasMediaService {
  private _deps: CanvasMediaDeps;

  constructor(deps: CanvasMediaDeps) {
    this._deps = deps;
  }

  async generate(artifact: CanvasArtifact, req: GenerateMediaRequest): Promise<GenerateMediaResult> {
    const slug = KIND_TO_SLUG[req.kind];
    const status = this._deps.registry.resolve(slug);

    if (!status.enabled) {
      return {
        ok: false,
        error: `${req.kind} generation is not connected. Connect it via DeepMyst (fal) or add a local API key.`,
        connectHint: slug,
      };
    }

    try {
      const media = status.source === 'deepmyst'
        ? await this._deps.callBrokered(req.kind, req)
        : await this._deps.generateLocal(req.kind, req);

      let base64 = media.base64;
      let mimeType = media.mimeType;
      if (!base64 && media.url) {
        const fetched = await this._deps.fetchBytes(media.url);
        base64 = fetched.base64;
        mimeType = fetched.mimeType || mimeType;
      }
      if (!base64) {
        return { ok: false, error: 'generator returned no media content' };
      }

      // The record role is the storage kind; the intent (hero/background/...)
      // travels in the prompt provenance.
      const role: CanvasAssetRecord['role'] =
        req.kind === 'video' ? 'video' : req.role === 'icon' || req.role === 'svg' ? req.role : 'image';
      const asset = await this._deps.store.addAsset(artifact, base64, mimeType, {
        role,
        prompt: req.role ? `[${req.role}] ${req.prompt}` : req.prompt,
        model: media.model,
        size: req.size,
        sourcePageId: req.sourcePageId,
      });
      if (!asset) {
        return { ok: false, error: 'no workspace to store the asset in' };
      }
      return { ok: true, asset, source: status.source as 'deepmyst' | 'local' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
