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

import { buildPageDocument } from '../managers/CanvasSandbox';
import type { SandboxRuntime } from '../managers/CanvasSandbox';
import type { ArtifactPage, DesignTheme, CanvasFormatSpec } from '../types';

/**
 * The render-to-PNG + vision-critique self-QA loop (Plan 05 §6 / Phase 4.2 —
 * `render_page_preview`). The agent's highest-leverage quality tool: it *sees*
 * its own page (a real screenshot) and gets back structured issues to fix,
 * catching overflow/clipping/contrast/empty-chart defects that static checks
 * can't. The Playwright screenshot and the vision call are **injected**, so the
 * orchestration is pure and unit-testable; the extension supplies the real
 * implementations (ScreenshotService/BrowserManager + ImageGenerationService).
 */

export type PreviewSeverity = 'error' | 'warning' | 'info';
export interface PreviewIssue {
  severity: PreviewSeverity;
  message: string;
}
export interface PreviewResult {
  ok: boolean;
  /** The captured PNG (base64), for caching as a page thumbnail. */
  previewBase64?: string;
  issues: PreviewIssue[];
  /** Answers to the agent's targeted questions, if any were asked. */
  answers?: string[];
  error?: string;
}

export interface PreviewDeps {
  /** Render the page document to a PNG (base64) at the given design-px size. */
  capturePng(html: string, dims: { width: number; height: number }): Promise<string>;
  /** Vision-analyze a PNG against a prompt, returning the model's text. */
  analyze(pngBase64: string, prompt: string): Promise<string>;
}

export interface RenderPreviewInput {
  page: ArtifactPage;
  theme: DesignTheme;
  format: CanvasFormatSpec;
  /** Inlined sandbox runtime (React/Babel/ui-primitives/harness) for the iframe. */
  runtime: SandboxRuntime;
  /** Up to 5 targeted questions for the vision model to answer. */
  questions?: string[];
  resolveAsset?: (ref: string) => string;
}

export class CanvasPreviewService {
  private _deps: PreviewDeps;

  constructor(deps: PreviewDeps) {
    this._deps = deps;
  }

  async renderPreview(input: RenderPreviewInput): Promise<PreviewResult> {
    try {
      const html = buildPageDocument({
        page: input.page, theme: input.theme, format: input.format,
        runtime: input.runtime, resolveAsset: input.resolveAsset,
      });
      const png = await this._deps.capturePng(html, { width: input.format.width, height: input.format.height });
      const prompt = buildCritiquePrompt(input.page, input.format, input.questions);
      const raw = await this._deps.analyze(png, prompt);
      const parsed = parseCritique(raw);
      return { ok: true, previewBase64: png, issues: parsed.issues, answers: parsed.answers };
    } catch (err) {
      return { ok: false, issues: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** The structured-critique instruction sent to the vision model. */
export function buildCritiquePrompt(page: ArtifactPage, format: CanvasFormatSpec, questions?: string[]): string {
  const qs = (questions ?? []).slice(0, 5);
  return [
    `You are reviewing a rendered UI screen (${format.formatId}, ${format.width}×${format.height} design px${page.actionTitle ? `, "${page.actionTitle}"` : ''}).`,
    `Identify real visual defects: text overflow or clipping, elements cut off at the edges, low contrast / unreadable text, overlapping content, empty or broken charts/images, cramped or unbalanced layout, and anything that looks unfinished.`,
    `Respond with STRICT JSON only, no prose, in this shape:`,
    `{"issues":[{"severity":"error|warning|info","message":"..."}]${qs.length ? `,"answers":["one answer per question, in order"]` : ''}}`,
    qs.length ? `Questions to answer in "answers": ${qs.map((q, i) => `(${i + 1}) ${q}`).join(' ')}` : '',
    `If the screen looks good, return {"issues":[]}.`,
  ].filter(Boolean).join('\n');
}

/** Parse the vision model's response into issues (tolerant of fenced/looser JSON). */
export function parseCritique(text: string): { issues: PreviewIssue[]; answers?: string[] } {
  const json = extractJsonObject(text);
  if (json) {
    try {
      const obj = JSON.parse(json) as { issues?: unknown; answers?: unknown };
      const issues = Array.isArray(obj.issues)
        ? obj.issues.flatMap(coerceIssue)
        : [];
      const answers = Array.isArray(obj.answers) ? obj.answers.map(a => String(a)) : undefined;
      return { issues, answers };
    } catch {
      /* fall through to the textual fallback */
    }
  }
  // No parseable JSON — surface the raw response as one info issue rather than dropping it.
  const trimmed = text.trim();
  return { issues: trimmed ? [{ severity: 'info', message: trimmed.slice(0, 500) }] : [] };
}

// ── helpers ──

function coerceIssue(raw: unknown): PreviewIssue[] {
  if (!raw || typeof raw !== 'object') { return []; }
  const o = raw as { severity?: unknown; message?: unknown };
  const message = typeof o.message === 'string' ? o.message : '';
  if (!message) { return []; }
  const sev = o.severity === 'error' || o.severity === 'warning' || o.severity === 'info' ? o.severity : 'warning';
  return [{ severity: sev, message }];
}

/** Pull the first top-level {...} JSON object out of a possibly-fenced string. */
function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  if (start === -1) { return null; }
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') { depth++; }
    else if (body[i] === '}') { depth--; if (depth === 0) { return body.slice(start, i + 1); } }
  }
  return null;
}
