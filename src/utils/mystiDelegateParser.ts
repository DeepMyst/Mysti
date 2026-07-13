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
 *
 * MystiTagScanner (Plan 16 C2, extended by Plan 17 P0.1) — an incremental
 * parser for the Mysti coordinator's inline directive protocol. The coordinator
 * requests an action by emitting, in its text stream, a tag fenced with a
 * per-run nonce:
 *
 *   <delegate:NONCE agent="claude-code">a self-contained task</delegate>
 *   <read:NONCE>src/managers/AgentLoader.ts</read>
 *   <read:NONCE lines="120-260">src/extension.ts</read>
 *   <ls:NONCE>src/providers</ls>
 *   <grep:NONCE path="src/**">parseStreamLine</grep>
 *   <diag:NONCE>all</diag>
 *
 * The nonce (given to the model in the system prompt) makes the control channel
 * UNFORGEABLE: a plain `<delegate ...>`/`<read ...>` echoed from user text,
 * quoted from an untrusted file result, or emitted by the model when
 * *describing* the protocol does NOT match, so it can never trigger an
 * unintended action. read/ls/grep/diag are READ-ONLY local tools handled
 * in-process (no CLI spawn, no shell — see plans/17 P0.1 and §5 "what not to
 * do": there is deliberately NO local write or bash directive).
 *
 * The scanner is fed the coordinator's streamed text chunks and:
 *   - emits the prose BEFORE a directive as safe, user-visible text (so it can
 *     stream into the answer bubble),
 *   - holds back any tail that might be the start of a marker split across
 *     chunks (so a half-marker never leaks into the UI),
 *   - surfaces the first COMPLETE directive so the caller can run it,
 *   - and FAILS OPEN: a malformed or unclosed directive degrades to visible
 *     text rather than silently swallowing the coordinator's output.
 */

export type MystiDirectiveKind = 'delegate' | 'read' | 'ls' | 'grep' | 'diag' | 'remember';

export type ModelTier = 'fast' | 'strong';

export type MystiDirective =
  | { kind: 'delegate'; agent: string; task: string; tier?: ModelTier }
  | { kind: 'read'; path: string; startLine?: number; endLine?: number }
  | { kind: 'ls'; path: string }
  | { kind: 'grep'; pattern: string; include?: string }
  | { kind: 'diag'; target: string }
  | { kind: 'remember'; fact: string };

export interface TagScanResult {
  /** Prose that is safe to show/stream to the user right now. */
  text: string;
  /** Present when a complete directive was parsed in this step. */
  directive?: MystiDirective;
}

/** All directive kinds the coordinator loop understands. */
export const ALL_MYSTI_KINDS: MystiDirectiveKind[] = ['delegate', 'read', 'ls', 'grep', 'diag', 'remember'];

export class MystiTagScanner {
  private _buf = '';
  private readonly _opens: Array<{ kind: MystiDirectiveKind; open: string; close: string; re: RegExp }>;

  constructor(nonce: string, kinds: MystiDirectiveKind[] = ALL_MYSTI_KINDS) {
    const esc = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this._opens = kinds.map(kind => ({
      kind,
      open: `<${kind}:${nonce}`,
      close: `</${kind}>`,
      re: MystiTagScanner._kindRegex(kind, esc),
    }));
  }

  private static _kindRegex(kind: MystiDirectiveKind, esc: string): RegExp {
    switch (kind) {
      case 'delegate':
        // review[2]: accept ANY tier value ("([^"]*)") so an unknown tier (e.g.
        // tier="medium") still matches the tag — `_parse` validates it and falls
        // back to default routing rather than voiding the whole delegation.
        return new RegExp(`^<delegate:${esc}\\s+agent\\s*=\\s*"([^"]+)"(?:\\s+tier\\s*=\\s*"([^"]*)")?\\s*>([\\s\\S]*?)<\\/delegate>$`);
      case 'read':
        return new RegExp(`^<read:${esc}(?:\\s+lines\\s*=\\s*"(\\d+)\\s*-\\s*(\\d+)")?\\s*>([\\s\\S]*?)<\\/read>$`);
      case 'ls':
        return new RegExp(`^<ls:${esc}\\s*>([\\s\\S]*?)<\\/ls>$`);
      case 'grep':
        return new RegExp(`^<grep:${esc}(?:\\s+path\\s*=\\s*"([^"]+)")?\\s*>([\\s\\S]*?)<\\/grep>$`);
      case 'diag':
        return new RegExp(`^<diag:${esc}\\s*>([\\s\\S]*?)<\\/diag>$`);
      case 'remember':
        return new RegExp(`^<remember:${esc}\\s*>([\\s\\S]*?)<\\/remember>$`);
    }
  }

  /** Feed a streamed chunk; get back safe text (and a directive if one closed). */
  feed(chunk: string): TagScanResult {
    this._buf += chunk;
    return this._drain(false);
  }

  /** Flush remaining buffer at end of a coordinator turn. */
  flush(): TagScanResult {
    return this._drain(true);
  }

  private _drain(isFinal: boolean): TagScanResult {
    // Earliest open marker of ANY kind wins.
    let openIdx = -1;
    let hit: { kind: MystiDirectiveKind; open: string; close: string; re: RegExp } | undefined;
    for (const o of this._opens) {
      const i = this._buf.indexOf(o.open);
      if (i !== -1 && (openIdx === -1 || i < openIdx)) { openIdx = i; hit = o; }
    }

    if (openIdx === -1 || !hit) {
      // No open marker anywhere. Non-final: hold back a possible partial marker
      // at the tail. Final: emit everything.
      if (isFinal) {
        const text = this._buf;
        this._buf = '';
        return { text };
      }
      const safeLen = this._safePrefixLen();
      const text = this._buf.slice(0, safeLen);
      this._buf = this._buf.slice(safeLen);
      return { text };
    }

    const before = this._buf.slice(0, openIdx);
    const closeIdx = this._buf.indexOf(hit.close, openIdx);

    if (closeIdx === -1) {
      // Open marker seen but not yet closed.
      if (!isFinal) {
        this._buf = this._buf.slice(openIdx); // keep the (incomplete) directive
        return { text: before };
      }
      // Final + unclosed ⇒ FAIL OPEN: show the fragment as text, don't drop it.
      const rest = this._buf.slice(openIdx);
      this._buf = '';
      return { text: before + rest };
    }

    const raw = this._buf.slice(openIdx, closeIdx + hit.close.length);
    this._buf = this._buf.slice(closeIdx + hit.close.length);
    const directive = this._parse(hit, raw);
    if (!directive) {
      // Malformed directive — surface the raw block as text so nothing is lost.
      return { text: before + raw };
    }
    return { text: before, directive };
  }

  /**
   * Length of the buffer prefix that cannot be the start of ANY marker. We hold
   * back from the last '<' whose suffix is a prefix of one of the (nonce-
   * bearing) open markers.
   */
  private _safePrefixLen(): number {
    const buf = this._buf;
    const maxOpen = Math.max(...this._opens.map(o => o.open.length));
    const start = Math.max(0, buf.length - maxOpen);
    for (let i = buf.length - 1; i >= start; i--) {
      if (buf[i] === '<' && this._opens.some(o => o.open.startsWith(buf.slice(i)))) {
        return i;
      }
    }
    return buf.length;
  }

  private _parse(hit: { kind: MystiDirectiveKind; re: RegExp }, raw: string): MystiDirective | null {
    const m = raw.trim().match(hit.re);
    if (!m) {
      return null;
    }
    switch (hit.kind) {
      case 'delegate': {
        const agent = m[1].trim();
        // Validate the (now permissively-captured) tier: anything other than the
        // known tiers degrades to default routing (undefined) — review[2].
        const rawTier = m[2];
        const tier: ModelTier | undefined = rawTier === 'fast' || rawTier === 'strong' ? rawTier : undefined;
        const task = m[3].trim();
        return agent && task ? { kind: 'delegate', agent, task, ...(tier ? { tier } : {}) } : null;
      }
      case 'read': {
        const path = m[3].trim();
        if (!path) { return null; }
        const startLine = m[1] ? parseInt(m[1], 10) : undefined;
        const endLine = m[2] ? parseInt(m[2], 10) : undefined;
        return { kind: 'read', path, startLine, endLine };
      }
      case 'ls': {
        const path = m[1].trim();
        // '' / '.' both mean the workspace root — normalize downstream.
        return { kind: 'ls', path: path || '.' };
      }
      case 'grep': {
        const pattern = m[2].trim();
        if (!pattern) { return null; }
        return { kind: 'grep', pattern, include: m[1]?.trim() || undefined };
      }
      case 'diag': {
        const target = m[1].trim();
        return { kind: 'diag', target: target || 'all' };
      }
      case 'remember': {
        const fact = m[1].trim();
        return fact ? { kind: 'remember', fact } : null;
      }
    }
  }
}

// ============================================================================
// Back-compat wrapper — the original delegate-only scanner shape (Plan 16 C2).
// ============================================================================

export interface DelegateDirective {
  agent: string;
  task: string;
}

export interface ScanResult {
  /** Prose that is safe to show/stream to the user right now. */
  text: string;
  /** Present when a complete directive was parsed in this step. */
  directive?: DelegateDirective;
}

export class DelegateScanner {
  private readonly _inner: MystiTagScanner;

  constructor(nonce: string) {
    this._inner = new MystiTagScanner(nonce, ['delegate']);
  }

  feed(chunk: string): ScanResult {
    return DelegateScanner._map(this._inner.feed(chunk));
  }

  flush(): ScanResult {
    return DelegateScanner._map(this._inner.flush());
  }

  private static _map(r: TagScanResult): ScanResult {
    if (r.directive && r.directive.kind === 'delegate') {
      return { text: r.text, directive: { agent: r.directive.agent, task: r.directive.task } };
    }
    return { text: r.text };
  }
}
