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

import type {
  ArtifactPage,
  CanvasArtifact,
  CanvasAssetRecord,
  CanvasFormatSpec,
  CanvasJobEvent,
  CanvasOpKind,
  CanvasOp as LegacyCanvasOpRecord,
  DesignTheme,
} from '../types';
import type { CanvasOp, CanvasOpRecordV2 } from './CanvasOps';
import type { CanvasHistoryStatus } from './CanvasHistory';
import type { CapabilityStatus } from '../managers/CanvasCapabilityRegistry';
import type { CanvasApprovalMode } from '../managers/CanvasOpExecutor';
import type { PageValidationIssue } from '../managers/CanvasValidator';

/**
 * Plan 20 §3.4 — the **one** host↔webview canvas wire contract.
 *
 * Both ends import these unions and switch exhaustively over them, so an
 * orphaned handler or a handler-less button is a `tsc` failure rather than a
 * silent no-op. That is the specific class of bug this file exists to kill:
 * today `_handleCanvasMessage` has 14 cases, the shell sends 4 of them,
 * `#btn-present` posts `canvasPresent` which nothing handles, and the host
 * answers `canvasReady` with a `canvasLoad` the shell ignores (while minting a
 * junk "Untitled Canvas" session as a side effect).
 *
 * ## The type is the roadmap
 *
 * The **full** union from Plan 20 §3.4 is declared here up front. Variants that
 * no phase-0/1 producer emits yet carry a `Phase N` tag naming the phase that
 * lights them up. Later phases therefore only ever add **producers and
 * handlers** — never wire types — so no phase can quietly invent a private
 * side-channel and no consumer has to guess what may arrive.
 *
 * Deliberately **absent**: `canvasSave`, `canvasPrompt`, `canvasReimagine`,
 * `canvasGenerateDraft`, `canvasUnifiedPrompt`. Those belong to `CanvasManager`,
 * which Plan 20 Phase 0 deletes along with the `CanvasSession`/`canvasJson`
 * freeform layer. They are not part of the contract and must not come back as
 * message variants — a salvaged capability returns as a *tool*, not a transport.
 *
 * ## Trust model
 *
 * Every client message carries a `viewToken` minted host-side per canvas view
 * ({@link mintViewToken}) and checked on arrival ({@link acceptCanvasClientMessage}).
 * Model-authored page source runs in a `sandbox="allow-scripts"` frame with no
 * `allow-same-origin` and talks to the board over a dedicated `MessageChannel`
 * port — it can neither read the token nor reach `postMessage` on the host
 * channel. So a prompt-injected page cannot forge `canvas/submit` and have its
 * op stamped `author: 'user'`. `author`, `runId` and `actorId` are **never** on
 * the wire from the client: the host stamps them from the arriving channel
 * (§3.2). {@link CanvasOp} — what `canvas/submit` carries — omits them
 * structurally, so that invariant is a type error to violate rather than a
 * code-review note, and `CanvasBridge` is the one place that stamps them.
 */

// ============================================================================
// Shared payload types
// ============================================================================

/**
 * Stable element identity — 10-char base32, minted host-side (§3.1).
 *
 * Phase 2 moves the canonical declaration to `src/canvas/doc/DocNode.ts`; this
 * becomes a re-export so every wire consumer keeps importing it from here.
 */
export type Mid = string;

/**
 * The op-log record as it appears on the wire.
 *
 * Phase 2 landed the `CanvasOpRecordV2` algebra (`txnId` + `op` + `inverse`)
 * while the pre-Phase-2 `{kind, proposedValue}` record is still what the legacy
 * transports emit, so the wire carries **both** — which is exactly what the
 * renderer already assumes: `src/webview/canvas/state.ts` reads a record
 * *structurally* (`recordOp`) and routes a v2 record down the delta path and a
 * legacy one down an honest frame reload.
 *
 * Widening the alias to the union rather than flipping it is what lets the host
 * put real element ops on the wire (so an agent's `el.setText` patches a live
 * frame instead of rebuilding it) without a flag day for the legacy producers
 * that have not migrated.
 */
export type CanvasOpRecord = LegacyCanvasOpRecord | CanvasOpRecordV2;

/** The pre-Phase-2 half of {@link CanvasOpRecord}. */
export type LegacyCanvasOpWireRecord = LegacyCanvasOpRecord;

/**
 * Narrow a wire record to the legacy `{kind, proposedValue}` half.
 *
 * The v2 half is detected by `recordOp` (webview) / `record.op` (host); this is
 * the complement, and it exists so a consumer's `switch (record.kind)` is a
 * narrowed access rather than a cast.
 */
export function isLegacyCanvasOpRecord(record: CanvasOpRecord): record is LegacyCanvasOpRecord {
  return typeof (record as LegacyCanvasOpRecord).kind === 'string';
}

/**
 * A client-authored op, as submitted by a human gesture in the board.
 *
 * Note what is *missing*: `runId`, `author`, `actorId`, `opId`, `status`, `ts`.
 * Those are host-stamped from the arriving channel (§3.2) — putting them on the
 * wire is exactly how a sandboxed page would forge a human edit and slip past
 * pin enforcement. Keeping them off the type makes forging them uncompilable.
 *
 * Superseded on the wire: `canvas/submit.ops` now carries the `CanvasOp`
 * algebra (`el.setText`, `el.setStyle`, …) from `src/canvas/CanvasOps.ts`,
 * which every webview producer already emits. This shape is kept only for the
 * pre-Phase-2 transports that still speak `{kind, proposedValue}`; nothing on
 * the client→host channel uses it.
 */
export interface CanvasOpInput {
  kind: CanvasOpKind;
  /** Target page for page-scope ops; omitted for artifact-scope ops. */
  targetPageId?: string;
  /** Page (or, for artifact-scope ops, artifact) version the author read. */
  baseVersion?: number;
  proposedValue: unknown;
}

/**
 * Receipt for a submitted op (§3.2). `ok` is not a field because "the request
 * was accepted" is not the question — `status` says whether the **document
 * changed**, and the rest tells the writer everything it missed, so a chain of
 * edits costs one read instead of one read per edit.
 */
export interface CanvasOpReceipt {
  opId: string;
  status: CanvasOpRecord['status'];
  pageId?: string;
  /** Version of `pageId` after the op. */
  pageVersion?: number;
  /** Artifact version after the op — always present, even for rejects. */
  artifactVersion: number;
  /** Phase 2 — base version was stale but the target mid survived a rebase. */
  rebased?: boolean;
  /** Phase 2 — cells refused because a human owns them (`style.background`, …). */
  pinned?: string[];
  /** Phase 2 — ids minted for nodes the writer did not name. */
  newMids?: Record<string, Mid>;
  /** Phase 2 — records committed since `baseVersion`, so one read catches up. */
  since?: CanvasOpRecord[];
  /** Static validation issues for the affected page, if it was revalidated. */
  issues?: PageValidationIssue[];
  /** Set when `status` is a refusal; the reason to hand back to the author. */
  error?: string;
}

/**
 * The artifact as the webview sees it: the persisted artifact minus the op log
 * (an unbounded audit trail the board never renders and must not be shipped on
 * every resync) and minus host-only provenance.
 *
 * `approvalMode` rides along because it is derived from settings, can change
 * under a live view, and must be identical to the value fed to
 * `buildCanvasContextBlock` — see `resolveCanvasApproval`. Shipping it with the
 * artifact makes "the chrome says staged while the prompt says auto" impossible.
 */
export interface WireArtifact {
  id: string;
  version: number;
  kind: CanvasArtifact['kind'];
  name: string;
  format: CanvasFormatSpec;
  theme: DesignTheme;
  pages: ArtifactPage[];
  assets: CanvasAssetRecord[];
  updatedAt: number;
  approvalMode: CanvasApprovalMode;
}

/**
 * A generation/source capability chip in the canvas chrome. Extends the
 * registry's own status shape so the chips cannot drift from the registry that
 * decides them; `connectSlug` is what the "Connect" affordance passes to the
 * `<<<MYSTI_CONNECT:slug>>>` flow when `enabled` is false.
 */
export interface CapChip extends CapabilityStatus {
  /** Phase 6 — DeepMyst connection slug to offer when the capability is off. */
  connectSlug?: string;
}

/** One row of `index.json` — enough to render the artifact picker (§3.1). */
export interface ArtifactSummary {
  id: string;
  name: string;
  kind: CanvasArtifact['kind'];
  pageCount: number;
  updatedAt: number;
  /** Phase 6 — `asset://` ref for the picker thumbnail. */
  thumb?: string;
}

// ============================================================================
// host → webview
// ============================================================================

export type CanvasHostMessage =
  /**
   * Phase 0 — the authoritative state transfer, sent in response to
   * `canvas/ready`. Nothing is baked into the shell HTML, so a webview reload
   * cannot show a stale artifact.
   */
  | { t: 'canvas/hello'; artifactId: string; artifact: WireArtifact; viewToken: string; caps: CapChip[] }
  /**
   * Phase 1 — capability probing is async (up to four `listMcpConnections()`
   * round-trips) and no longer blocks the shell; the chips patch in when it
   * resolves. Not in the §3.4 listing, but §3.3's "boot splits" requires a wire
   * for the late half.
   */
  | { t: 'canvas/caps'; caps: CapChip[] }
  /** Phase 2 — STEADY STATE. Op-level deltas; the board patches, never reloads. */
  | { t: 'canvas/ops'; records: CanvasOpRecord[]; artifactVersion: number }
  /** Phase 5 — agent proposals awaiting accept/reject in `staged` mode. */
  | { t: 'canvas/staged'; records: CanvasOpRecord[] }
  /** Phase 0 — one receipt per write; non-applied ops render as cards, not warnings. */
  | { t: 'canvas/receipt'; receipt: CanvasOpReceipt }
  /** Phase 5 — `started`/`heartbeat`/`progress` from `CanvasJobRouter`. */
  | { t: 'canvas/job'; event: CanvasJobEvent }
  /** Phase 5 — ghost highlight on the node an agent is editing right now. */
  | { t: 'canvas/agentCursor'; pageId: string; mid?: Mid; label: string }
  /**
   * Phase 3 — the undo/redo/versions snapshot, decided by `CanvasHistory` over
   * the real op log and PUSHED here.
   *
   * The webview deliberately keeps no mirror of the stack: it never sees the
   * ops that arrive over MCP from a CLI backend, over a `<canvas:NONCE>`
   * directive, or from a detached background job, so a client-side cursor would
   * be confidently wrong in exactly the state a human reaches for Cmd+Z in.
   */
  | { t: 'canvas/history'; status: CanvasHistoryStatus }
  /** Phase 2 — full state re-send after the client detects an `artifactVersion` gap. */
  | { t: 'canvas/resync'; artifact: WireArtifact; artifactVersion: number }
  /** Phase 6 — the artifact picker's rows. */
  | { t: 'canvas/artifacts'; summaries: ArtifactSummary[] };

export type CanvasHostMessageTag = CanvasHostMessage['t'];

// ============================================================================
// webview → host
// ============================================================================

/** Auth envelope stamped on every client message. See the trust model above. */
export interface CanvasViewAuth {
  viewToken: string;
}

type CanvasClientBody =
  /** Phase 0 — boot / reload. `haveVersion` lets the host answer with a delta later. */
  | { t: 'canvas/ready'; artifactId?: string; haveVersion?: number }
  /**
   * One-shot render confirmation, sent after the client first paints an
   * artifact. This is the ONLY positive proof the handshake completed inside
   * the real VS Code host — the failure that stranded the panel on
   * "Loading your designs…" twice was invisible precisely because nothing
   * ever reported success. Consumed by `mysti.canvasDiagnostics`.
   */
  | { t: 'canvas/diag'; pages: number; layoutMode: string; liveFrames: number;
      /** Frame times sampled during the last pan/zoom, in ms. Absent until one happens. */
      gestureP50?: number; gestureP95?: number; gestureDropped?: number }
  /**
   * Phase 3 — a human gesture. One drag = one `txnId`, so Cmd+Z undoes the
   * gesture rather than its 60 intermediate frames. `force` names pinned cells
   * the user explicitly chose to overwrite.
   */
  | { t: 'canvas/submit'; txnId: string; ops: CanvasOp[]; baseVersions: Record<string, number>; force?: string[] }
  /** Phase 3 — selection is *view* state; the host mirrors it for the agent cursor only. */
  | { t: 'canvas/selection'; pageId: string; mids: Mid[] }
  /** Phase 3 — inline text edit in progress; parks agent ops in that subtree. */
  | { t: 'canvas/editing'; pageId: string; mids: Mid[]; editing: boolean }
  /** Phase 5 — accept/reject staged suggestions. */
  | { t: 'canvas/decide'; opIds: string[]; accept: boolean }
  /** Phase 3 — one shared undo stack; Cmd+Z means "undo the last thing that happened". */
  | { t: 'canvas/undo' }
  | { t: 'canvas/redo' }
  /** Phase 3 — named content-addressed checkpoint. */
  | { t: 'canvas/checkpoint'; label: string }
  /** Phase 3 — restore emits ops, so restoring is itself undoable. */
  | { t: 'canvas/restore'; ref: string }
  /** Phase 5 — human text into the per-run steering inbox. Untrusted data. */
  | { t: 'canvas/comment'; pageId: string; mid?: Mid; text: string }
  /** Phase 5 — the Cancel on a ghost artboard; routes to `CanvasJobRouter.cancel`. */
  | { t: 'canvas/cancelJob'; jobId: string }
  /** Phase 2 — a render error reported by the frame; becomes an on-artboard card. */
  | { t: 'canvas/frameError'; pageId: string; mid?: Mid; message: string }
  /** Phase 0 — today's `canvasAddScaffold`; the shell's one working button. */
  | { t: 'canvas/addScaffold'; scaffold: string }
  /** Phase 0 — today's `canvasExport`. */
  | { t: 'canvas/export'; format?: 'html' | 'png' | 'pdf' }
  /** Phase 0 — `#btn-present`, which today posts into the void. Wire it or delete it. */
  | { t: 'canvas/present'; pageId?: string }
  /** Phase 6 — multiple designs open side by side. */
  | { t: 'canvas/newArtifact'; name?: string; kind?: CanvasArtifact['kind']; formatId?: string }
  | { t: 'canvas/openArtifact'; artifactId: string }
  | { t: 'canvas/renameArtifact'; artifactId: string; name: string };

/**
 * Distribute the auth envelope across every variant, so `t` stays a usable
 * discriminant (`(A | B) & C` would not reliably narrow).
 */
type WithViewAuth<T> = T extends unknown ? T & CanvasViewAuth : never;

export type CanvasClientMessage = WithViewAuth<CanvasClientBody>;

export type CanvasClientMessageTag = CanvasClientMessage['t'];

// ============================================================================
// Tag tables — TS-enforced complete
// ============================================================================

/*
 * These are `Record<Tag, true>`, not hand-written arrays: adding a variant to
 * either union without adding its tag here fails `tsc`. That is what makes the
 * runtime guards below provably cover the whole union.
 */

const HOST_MESSAGE_TAGS: Readonly<Record<CanvasHostMessageTag, true>> = {
  'canvas/hello': true,
  'canvas/caps': true,
  'canvas/ops': true,
  'canvas/staged': true,
  'canvas/receipt': true,
  'canvas/job': true,
  'canvas/agentCursor': true,
  'canvas/history': true,
  'canvas/resync': true,
  'canvas/artifacts': true,
};

const CLIENT_MESSAGE_TAGS: Readonly<Record<CanvasClientMessageTag, true>> = {
  'canvas/ready': true,
  'canvas/diag': true,
  'canvas/submit': true,
  'canvas/selection': true,
  'canvas/editing': true,
  'canvas/decide': true,
  'canvas/undo': true,
  'canvas/redo': true,
  'canvas/checkpoint': true,
  'canvas/restore': true,
  'canvas/comment': true,
  'canvas/cancelJob': true,
  'canvas/frameError': true,
  'canvas/addScaffold': true,
  'canvas/export': true,
  'canvas/present': true,
  'canvas/newArtifact': true,
  'canvas/openArtifact': true,
  'canvas/renameArtifact': true,
};

/** Every host→webview tag. Order is declaration order; treat it as a set. */
export const CANVAS_HOST_MESSAGE_TAGS: readonly CanvasHostMessageTag[] =
  Object.keys(HOST_MESSAGE_TAGS) as CanvasHostMessageTag[];

/** Every webview→host tag. Order is declaration order; treat it as a set. */
export const CANVAS_CLIENT_MESSAGE_TAGS: readonly CanvasClientMessageTag[] =
  Object.keys(CLIENT_MESSAGE_TAGS) as CanvasClientMessageTag[];

// ============================================================================
// Guards
// ============================================================================

function tagOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) { return null; }
  const t = (value as { t?: unknown }).t;
  return typeof t === 'string' ? t : null;
}

export function isCanvasHostMessageTag(value: unknown): value is CanvasHostMessageTag {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HOST_MESSAGE_TAGS, value);
}

export function isCanvasClientMessageTag(value: unknown): value is CanvasClientMessageTag {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CLIENT_MESSAGE_TAGS, value);
}

/**
 * Shape guard for the webview side. Only the tag is checked: the host is the
 * trusted end of this channel, so payload re-validation would be theatre.
 */
export function isCanvasHostMessage(value: unknown): value is CanvasHostMessage {
  return isCanvasHostMessageTag(tagOf(value));
}

/**
 * Shape guard for a client message **without** authenticating it. Use
 * {@link acceptCanvasClientMessage} on the host; this is for tests and for the
 * client's own outbound assertions.
 */
export function isCanvasClientMessage(value: unknown): value is CanvasClientMessage {
  if (!isCanvasClientMessageTag(tagOf(value))) { return false; }
  return typeof (value as { viewToken?: unknown }).viewToken === 'string';
}

/**
 * The host's front door. Returns the narrowed message, or `null` when the
 * payload is not a known client message or its `viewToken` does not match the
 * token minted for this view. Fails **closed**: an absent or empty expected
 * token rejects everything rather than accepting everything.
 */
export function acceptCanvasClientMessage(
  value: unknown,
  expectedViewToken: string,
): CanvasClientMessage | null {
  if (!isCanvasClientMessage(value)) { return null; }
  if (!viewTokensMatch(value.viewToken, expectedViewToken)) { return null; }
  return value;
}

/**
 * Exhaustiveness guard for a `switch` over either union. Reaching it means a
 * variant was added without a handler — which `tsc` will already have flagged;
 * the throw only covers a message arriving from a *newer* build of the other
 * end at runtime.
 */
export function assertNeverCanvasMessage(x: never): never {
  const tag = tagOf(x);
  throw new Error(`[Mysti] unhandled canvas message: ${tag ?? String(x)}`);
}

// ============================================================================
// View tokens
// ============================================================================

/**
 * Mint a per-view token (128 bits, hex). Host-side only.
 *
 * Uses the ambient Web Crypto CSPRNG so this module stays importable by both
 * the extension host and the `target:'web'` canvas bundle — no `node:crypto`
 * import, no `Math.random` fallback (a guessable view token is the whole
 * vulnerability, so an absent CSPRNG must fail loudly).
 */
export function mintViewToken(): string {
  // Structural, not `lib.dom`'s `Crypto`: tsconfig ships `lib: ["ES2022"]`.
  const cryptoObj = (globalThis as {
    crypto?: { getRandomValues?(array: Uint8Array): Uint8Array };
  }).crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('[Mysti] canvas view token requires crypto.getRandomValues');
  }
  const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
  let out = '';
  for (const b of bytes) { out += b.toString(16).padStart(2, '0'); }
  return out;
}

/**
 * Compare two view tokens without an early-exit on the first differing byte.
 * Empty or mismatched-length tokens never match, so an unminted view rejects
 * every message.
 */
export function viewTokensMatch(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') { return false; }
  if (a.length === 0 || b.length === 0) { return false; }
  if (a.length !== b.length) { return false; }
  let diff = 0;
  for (let i = 0; i < a.length; i++) { diff |= a.charCodeAt(i) ^ b.charCodeAt(i); }
  return diff === 0;
}

// ============================================================================
// Projection
// ============================================================================

/**
 * Project a persisted artifact onto the wire. The op log and the Stitch project
 * id are dropped by construction — the board never renders them, they grow
 * without bound, and `canvas/resync` would otherwise re-ship the entire audit
 * trail on every version gap.
 */
export function toWireArtifact(
  artifact: CanvasArtifact,
  opts: { approvalMode: CanvasApprovalMode },
): WireArtifact {
  return {
    id: artifact.id,
    version: artifact.version,
    kind: artifact.kind,
    name: artifact.name,
    format: artifact.format,
    theme: artifact.theme,
    pages: artifact.pages,
    assets: artifact.assets,
    updatedAt: artifact.updatedAt,
    approvalMode: opts.approvalMode,
  };
}
