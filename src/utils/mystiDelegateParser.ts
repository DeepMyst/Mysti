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

export type MystiDirectiveKind = 'delegate' | 'read' | 'ls' | 'grep' | 'diag' | 'remember' | 'write' | 'edit' | 'bash' | 'patch' | 'connect' | 'mcptool' | 'look' | 'act' | 'canvas' | 'canvaspage';

export type ModelTier = 'fast' | 'strong';

export type MystiDirective =
  | { kind: 'delegate'; agent: string; task: string; tier?: ModelTier }
  | { kind: 'read'; path: string; startLine?: number; endLine?: number }
  | { kind: 'ls'; path: string }
  | { kind: 'grep'; pattern: string; include?: string }
  | { kind: 'diag'; target: string }
  | { kind: 'remember'; fact: string }
  // Plan 19 Phase 0 — GATED local execution (write/edit). These carry a body
  // (file content / old+new). They are NOT read-only: the coordinator loop
  // routes them through MystiLocalExec → the permission gate + checkpoint.
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; oldString: string; newString: string; replaceAll: boolean }
  // Plan 19 Phase 2 — GATED, SANDBOXED shell execution.
  | { kind: 'bash'; command: string }
  // Plan 19 Phase 1 — atomic multi-file patch (add/update/delete/move).
  | { kind: 'patch'; patchText: string }
  // Plan 19 Phase 6 — surface an in-chat "Connect <service>" button (DeepMyst).
  // SAFE: grants no authority — it only offers the user a one-click OAuth link.
  | { kind: 'connect'; service: string }
  // Plan 19 Phase 6 — call one of the user's CONNECTED external MCP tools
  // (Gmail/Slack/Trello/…). GATED like exec: an un-undoable network side effect,
  // always user-approved. `args` is untrusted model JSON (may be {} on parse fail).
  | { kind: 'mcptool'; tool: string; args: Record<string, unknown> }
  // Agent-callable visual observation. `look` renders the running app in a real
  // browser and returns a deterministic digest (console, failed requests, layout
  // probes, a11y tree, DOM outline, screenshot). It is a READ: it never writes a
  // file or runs a model. The caller fixes what it saw with its own gated tools.
  // Note what is ABSENT: no url, no devServerCommand. The address and the shell
  // command come from the user's settings — the model may say WHAT to look at,
  // never WHERE or HOW the server starts.
  | { kind: 'look'; path?: string; selector?: string; mode?: 'viewport' | 'full-page' | 'element'; waitFor?: string; reload?: boolean; focus?: string }
  // `act` performs a bounded batch of page interactions, then looks. Gated: the
  // user approves the batch (a click can POST to the app's real database).
  | { kind: 'act'; actions: Array<Record<string, unknown>>; focus?: string; parseError?: string }
  // Plan 20 §3.3 Transport A — the canvas lane. `canvas` is one structured call
  // against the canvas op algebra (`set_text`, `insert_element`, `open_canvas`,
  // …); `args` is UNTRUSTED model JSON, so a parse failure degrades to `{}` AND
  // sets `argsError` — the dispatch reports "your JSON was malformed" instead of
  // running the tool with silently empty arguments.
  | { kind: 'canvas'; tool: string; args: Record<string, unknown>; argsError?: string }
  // Plan 20 §3.3 Transport A — a WHOLE ARTBOARD, carried as verbatim source
  // rather than JSON. It exists precisely because a native tool call cannot hold
  // an artboard (maxTokens 4096) and JSON-escaping a page of JSX doubles it; the
  // text lane also reassembles a payload split by a length cut. `pageId` absent
  // ⇒ a new page.
  | { kind: 'canvaspage'; pageId?: string; title?: string; source: string };

export interface TagScanResult {
  /** Prose that is safe to show/stream to the user right now. */
  text: string;
  /** Present when a complete directive was parsed in this step. */
  directive?: MystiDirective;
}

/** Read-only + delegate directive kinds — always active in the coordinator loop. */
export const ALL_MYSTI_KINDS: MystiDirectiveKind[] = ['delegate', 'read', 'ls', 'grep', 'diag', 'remember'];

/**
 * Local EXECUTION directive kinds (Plan 19 Phase 0) — gated `write`/`edit`.
 * Deliberately NOT in ALL_MYSTI_KINDS: the coordinator loop only adds these to
 * the scanner when local execution is enabled AND the workspace is trusted (and
 * not in a plan / read-only tier). When off, a `<write:…>` / `<edit:…>` tag is
 * never even recognized — it degrades to visible text, so the capability simply
 * does not exist rather than existing-but-erroring.
 */
export const MYSTI_EXEC_KINDS: MystiDirectiveKind[] = ['write', 'edit', 'bash', 'patch'];

/**
 * Connect directive (Plan 19 Phase 6) — added to the scanner only when DeepMyst
 * is wired. SAFE (offers a button, no authority) but kept out of ALL_MYSTI_KINDS
 * so the tag is only recognized when the connect capability actually exists.
 */
export const MYSTI_CONNECT_KINDS: MystiDirectiveKind[] = ['connect'];

/**
 * External MCP tool directive (Plan 19 Phase 6) — added to the scanner only when
 * MCP tools are enabled AND a live handshake to the user's connected tools
 * succeeded. GATED (every call is user-approved); when off the tag degrades to
 * visible text, so the capability simply does not exist.
 */
export const MYSTI_MCP_KINDS: MystiDirectiveKind[] = ['mcptool'];

/**
 * Visual observation kinds. `look` is a read (it renders and reports); `act`
 * touches the page and is therefore gated separately, so the two are split —
 * a read-only or plan-mode turn keeps `look` and loses `act`.
 * Both are added to the scanner only when the capability is enabled; when off
 * the tag is not recognized and degrades to visible text.
 */
export const MYSTI_VISUAL_KINDS: MystiDirectiveKind[] = ['look'];
export const MYSTI_VISUAL_ACT_KINDS: MystiDirectiveKind[] = ['act'];

/**
 * Canvas directive kinds (Plan 20 §3.3 Transport A) — added to the scanner only
 * when a canvas is bound to the run, so the tag is recognized exactly when the
 * capability exists; when unbound a `<canvas:…>` / `<canvaspage:…>` tag is never
 * matched and degrades to visible text. (The coordinator may also enable the
 * pair from zero purely so `open_canvas` is reachable before any canvas exists —
 * see plans/20 §3.3 item 3; binding is still what makes every other tool
 * resolvable, and dispatch fails closed on an unbound run.)
 */
export const MYSTI_CANVAS_KINDS: MystiDirectiveKind[] = ['canvas', 'canvaspage'];

export class MystiTagScanner {
  private _buf = '';
  /**
   * Plan 18 (F7): running "inside a ``` code fence" state for the VISIBLE
   * text stream. A directive that opens inside a fence is the model SHOWING
   * the protocol, not invoking it — it renders as text instead of executing.
   * Heuristic (a fence marker split across chunks can toggle late); the real
   * security control remains the nonce — this aligns the scanner with the
   * repo's fence-aware-parser invariant for UX correctness.
   */
  private _fenceOpen = false;
  /** Consecutive-backtick run carried across chunk boundaries (a \`\`\` split
   * over emissions must still toggle). */
  private _tickRun = 0;
  /** Line-anchoring state for the fence walker (beginning-of-line, indent,
   * whether the current backtick run started line-anchored). */
  private _bol = true;
  private _indent = 0;
  private _anchored = true;
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
      case 'write':
        // <write:NONCE path="rel/path">FILE CONTENT</write> — body captured verbatim.
        return new RegExp(`^<write:${esc}\\s+path\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)<\\/write>$`);
      case 'edit':
        // <edit:NONCE path="rel" replace="all|first"?><old>…</old><new>…</new></edit>
        return new RegExp(`^<edit:${esc}\\s+path\\s*=\\s*"([^"]+)"(?:\\s+replace\\s*=\\s*"(all|first)")?\\s*>\\s*<old>([\\s\\S]*?)<\\/old>\\s*<new>([\\s\\S]*?)<\\/new>\\s*<\\/edit>$`);
      case 'bash':
        // <bash:NONCE>a single shell command</bash>
        return new RegExp(`^<bash:${esc}\\s*>([\\s\\S]*?)<\\/bash>$`);
      case 'patch':
        // <patch:NONCE>*** Add/Update/Delete/Move envelope ***</patch>
        return new RegExp(`^<patch:${esc}\\s*>([\\s\\S]*?)<\\/patch>$`);
      case 'connect':
        // <connect:NONCE service="slug">optional reason (ignored)</connect>
        return new RegExp(`^<connect:${esc}\\s+service\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)<\\/connect>$`);
      case 'mcptool':
        // <mcptool:NONCE tool="TOOL_NAME">{ "json": "args" }</mcptool>
        return new RegExp(`^<mcptool:${esc}\\s+tool\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)<\\/mcptool>$`);
      case 'look':
        // <look:NONCE path="/x" selector="#y" mode="viewport" wait="#z" reload="true">focus</look>
        // The attribute blob is captured as ONE linear group and parsed
        // separately by _parseAttrs. Spelling five optional ordered attributes as
        // an alternation inside the regex is exactly the shape that produced the
        // Plan 19 round-4 cubic ReDoS; each repetition here is anchored by a
        // mandatory `=` and a quoted value, so there is no ambiguous backtrack.
        return new RegExp(`^<look:${esc}((?:\\s+[a-z]+\\s*=\\s*"[^"]*")*)\\s*>([\\s\\S]*?)<\\/look>$`);
      case 'act':
        // <act:NONCE focus="…">[{"action":"click","target":"#save"}]</act>
        return new RegExp(`^<act:${esc}((?:\\s+[a-z]+\\s*=\\s*"[^"]*")*)\\s*>([\\s\\S]*?)<\\/act>$`);
      case 'canvas':
        // <canvas:NONCE tool="set_text">{"pageId":"p1","mid":"k7f2xq9b1m","text":"Go"}</canvas>
        // Attributes are captured as ONE linear blob and split by _parseAttrs, so
        // they are order-independent, whitespace-tolerant and optional-tolerant
        // without the alternation shape that produced the Plan 19 round-4 cubic
        // ReDoS: every repetition is anchored by a mandatory `=` and a quoted value.
        return new RegExp(`^<canvas:${esc}((?:\\s+[a-zA-Z]+\\s*=\\s*"[^"]*")*)\\s*>([\\s\\S]*?)<\\/canvas>$`);
      case 'canvaspage':
        // <canvaspage:NONCE page="p1" title="Login">function Page(){ … }</canvaspage>
        // The body is VERBATIM source, NOT JSON — see the union comment. It may
        // contain backticks, nested ``` fences and `</canvas>`-looking text; only
        // the literal close tag `</canvaspage>` terminates it.
        return new RegExp(`^<canvaspage:${esc}((?:\\s+[a-zA-Z]+\\s*=\\s*"[^"]*")*)\\s*>([\\s\\S]*?)<\\/canvaspage>$`);
    }
  }

  /**
   * Parse an attribute blob into a map with a LINEAR scan.
   * Keys are case-insensitive (folded to lower case); unknown keys are dropped;
   * on a duplicate the last wins.
   */
  private static _parseAttrs(blob: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!blob) { return out; }
    const re = /([a-zA-Z]+)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blob)) !== null) {
      out[m[1].toLowerCase()] = m[2];
    }
    return out;
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
        this._trackFences(text);
        return { text };
      }
      const safeLen = this._safePrefixLen();
      const text = this._buf.slice(0, safeLen);
      this._buf = this._buf.slice(safeLen);
      this._trackFences(text);
      return { text };
    }

    const before = this._buf.slice(0, openIdx);
    const closeIdx = this._buf.indexOf(hit.close, openIdx);

    if (closeIdx === -1) {
      // Open marker seen but not yet closed.
      if (!isFinal) {
        this._buf = this._buf.slice(openIdx); // keep the (incomplete) directive
        this._trackFences(before);
        return { text: before };
      }
      // Final + unclosed ⇒ FAIL OPEN: show the fragment as text, don't drop it.
      const rest = this._buf.slice(openIdx);
      this._buf = '';
      const text = before + rest;
      this._trackFences(text);
      return { text };
    }

    const raw = this._buf.slice(openIdx, closeIdx + hit.close.length);
    this._buf = this._buf.slice(closeIdx + hit.close.length);

    // Plan 18 (F7): a directive opening INSIDE a code fence renders as text.
    const insideFence = this._walkFences(before, {
      open: this._fenceOpen, run: this._tickRun,
      bol: this._bol, indent: this._indent, anchored: this._anchored,
    }).open;
    if (insideFence) {
      return this._emitAsText(before + raw, isFinal);
    }

    const directive = this._parse(hit, raw);
    if (!directive) {
      // Malformed directive — surface the raw block as text so nothing is lost.
      return this._emitAsText(before + raw, isFinal);
    }
    this._trackFences(before);
    if (isFinal && this._buf.length > 0) {
      // Plan 18 (F8): flush() used to strand post-directive prose in _buf
      // forever (nothing drains after a final directive). Emit it as text —
      // any second directive in the tail degrades to visible text (only the
      // first directive per step executes). The remainder renders alongside
      // `before`, slightly ahead of its true stream position; losing it
      // would be worse.
      const rest = this._buf;
      this._buf = '';
      this._trackFences(rest);
      return { text: before + rest, directive };
    }
    return { text: before, directive };
  }

  /**
   * Emit consumed content as text. At FINAL, keep draining the remaining
   * buffer too — the fenced/malformed branches previously returned early and
   * stranded (dropped) whatever followed them at flush, including a real
   * directive (Plan 18 review of F7/F8).
   */
  private _emitAsText(text: string, isFinal: boolean): TagScanResult {
    this._trackFences(text);
    if (!isFinal || this._buf.length === 0) {
      return { text };
    }
    const rest = this._drain(true);
    return rest.directive
      ? { text: text + rest.text, directive: rest.directive }
      : { text: text + rest.text };
  }

  /** Commit emitted text to the fence state (stateful — survives splits). */
  private _trackFences(text: string): void {
    if (!text) { return; }
    const s = this._walkFences(text, {
      open: this._fenceOpen, run: this._tickRun,
      bol: this._bol, indent: this._indent, anchored: this._anchored,
    });
    this._fenceOpen = s.open;
    this._tickRun = s.run;
    this._bol = s.bol;
    this._indent = s.indent;
    this._anchored = s.anchored;
  }

  /**
   * Pure char walk: toggle on a run of three backticks that starts at the
   * beginning of a line (≤3 spaces indent — CommonMark fence anchoring).
   * Inline \`\`\` in prose must NOT toggle, or one stray mention would
   * demote every later real directive in the turn to text.
   */
  private _walkFences(
    text: string,
    state: { open: boolean; run: number; bol?: boolean; indent?: number; anchored?: boolean }
  ): { open: boolean; run: number; bol: boolean; indent: number; anchored: boolean } {
    let { open, run } = state;
    let bol = state.bol ?? true;
    let indent = state.indent ?? 0;
    let anchored = state.anchored ?? true;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '`') {
        if (run === 0) { anchored = bol && indent <= 3; }
        run++;
        if (run === 3 && anchored) { open = !open; run = 0; }
        bol = false;
      } else if (ch === '\n') {
        run = 0; bol = true; indent = 0;
      } else if (ch === ' ' && bol) {
        run = 0; indent++;
        // stays bol-eligible while indent small; deeper indent is code, not a fence
        if (indent > 3) { bol = false; }
      } else {
        run = 0; bol = false;
      }
    }
    return { open, run, bol, indent, anchored };
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
      case 'write': {
        const p = m[1].trim();
        if (!p) { return null; }
        let content = m[2];
        // Strip a single leading newline the model naturally emits after `>`;
        // everything else (incl. a trailing newline) is preserved verbatim.
        if (content.startsWith('\r\n')) { content = content.slice(2); }
        else if (content.startsWith('\n')) { content = content.slice(1); }
        return { kind: 'write', path: p, content };
      }
      case 'edit': {
        const p = m[1].trim();
        if (!p) { return null; }
        const oldString = m[3];
        const newString = m[4];
        // old_string must be non-empty (an empty match can't anchor); new_string
        // may be empty (a deletion).
        if (!oldString) { return null; }
        return { kind: 'edit', path: p, oldString, newString, replaceAll: m[2] === 'all' };
      }
      case 'bash': {
        const command = m[1].trim();
        return command ? { kind: 'bash', command } : null;
      }
      case 'patch': {
        // Preserve the body verbatim (content whitespace matters); strip one
        // leading newline the model emits after `>`.
        let patchText = m[1];
        if (patchText.startsWith('\r\n')) { patchText = patchText.slice(2); }
        else if (patchText.startsWith('\n')) { patchText = patchText.slice(1); }
        return patchText.trim() ? { kind: 'patch', patchText } : null;
      }
      case 'connect': {
        // m[1] = service slug; m[2] = optional reason (ignored — the card shows
        // the service name). Normalize to a safe lowercase slug.
        const service = m[1].trim().toLowerCase();
        if (!service || !/^[a-z0-9][a-z0-9._-]*$/.test(service)) { return null; }
        return { kind: 'connect', service };
      }
      case 'mcptool': {
        const tool = m[1].trim();
        if (!tool) { return null; }
        // Args are UNTRUSTED model JSON — a parse failure degrades to {} and lets
        // the dispatch feed a correction back rather than voiding the directive.
        let args: Record<string, unknown> = {};
        const raw = m[2].trim();
        if (raw) {
          try {
            const p = JSON.parse(raw);
            if (p && typeof p === 'object' && !Array.isArray(p)) { args = p as Record<string, unknown>; }
          } catch { /* leave {} — dispatch reports the parse error to the model */ }
        }
        return { kind: 'mcptool', tool, args };
      }
      case 'look': {
        const a = MystiTagScanner._parseAttrs(m[1]);
        const rawMode = (a.mode || '').toLowerCase();
        // An unrecognised enum value falls back to the policy default rather
        // than voiding the tag — same forgiving contract as `tier` on delegate.
        const mode = rawMode === 'viewport' || rawMode === 'full-page' || rawMode === 'element'
          ? rawMode as 'viewport' | 'full-page' | 'element'
          : undefined;
        const focus = (m[2] || '').trim();
        return {
          kind: 'look',
          path: a.path?.trim() || undefined,
          selector: a.selector?.trim() || undefined,
          mode,
          waitFor: (a.wait || a.waitfor)?.trim() || undefined,
          reload: a.reload === undefined ? undefined : a.reload.trim().toLowerCase() !== 'false',
          focus: focus || undefined,
        };
      }
      case 'act': {
        const a = MystiTagScanner._parseAttrs(m[1]);
        const raw = (m[2] || '').trim();
        // The body is UNTRUSTED model JSON. A parse failure yields an empty
        // action list plus an error the dispatch feeds back, so the model can
        // correct itself instead of the tag silently vanishing.
        let actions: Array<Record<string, unknown>> = [];
        let parseError: string | undefined;
        if (!raw) {
          parseError = 'the actions list was empty';
        } else {
          try {
            const p = JSON.parse(raw);
            if (Array.isArray(p)) {
              actions = p.filter(x => x && typeof x === 'object' && !Array.isArray(x)) as Array<Record<string, unknown>>;
              if (actions.length === 0) { parseError = 'the actions array contained no action objects'; }
            } else {
              parseError = 'the body must be a JSON ARRAY of action objects';
            }
          } catch (err) {
            parseError = `the body was not valid JSON (${err instanceof Error ? err.message : 'parse error'})`;
          }
        }
        return { kind: 'act', actions, focus: a.focus?.trim() || undefined, ...(parseError ? { parseError } : {}) };
      }
      case 'canvas': {
        const a = MystiTagScanner._parseAttrs(m[1]);
        const tool = (a.tool || '').trim();
        // No tool name ⇒ structurally void: there is nothing to route, so fail
        // open as visible text. A tool that merely does not EXIST still parses —
        // dispatch reports the unknown name back to the model, which is a far
        // better correction signal than the tag vanishing into prose.
        if (!tool) { return null; }
        // Args are UNTRUSTED model JSON. Unlike the `mcptool` lane (which
        // silently degrades to {}), a failure is SIGNALLED: `args` stays {} and
        // `argsError` says why, so the loop never runs a canvas write with
        // accidentally-empty arguments while telling the model it succeeded.
        let args: Record<string, unknown> = {};
        let argsError: string | undefined;
        // An EMPTY body is legitimate — several canvas tools take no arguments.
        const body = (m[2] || '').trim();
        if (body) {
          try {
            const p: unknown = JSON.parse(body);
            if (p && typeof p === 'object' && !Array.isArray(p)) {
              args = p as Record<string, unknown>;
            } else {
              argsError = 'the arguments must be a JSON OBJECT';
            }
          } catch (err) {
            argsError = `the arguments were not valid JSON (${err instanceof Error ? err.message : 'parse error'})`;
          }
        }
        return { kind: 'canvas', tool, args, ...(argsError ? { argsError } : {}) };
      }
      case 'canvaspage': {
        const a = MystiTagScanner._parseAttrs(m[1]);
        // Body preserved verbatim: page source is whitespace-significant. Only
        // the single newline the model naturally emits right after `>` is
        // stripped (same contract as `write`/`patch`).
        let source = m[2] ?? '';
        if (source.startsWith('\r\n')) { source = source.slice(2); }
        else if (source.startsWith('\n')) { source = source.slice(1); }
        // Nothing to write ⇒ fail open as text rather than staging an empty page.
        if (!source.trim()) { return null; }
        const pageId = (a.page ?? a.pageid ?? '').trim();
        const title = (a.title ?? '').trim();
        return {
          kind: 'canvaspage',
          ...(pageId ? { pageId } : {}),
          ...(title ? { title } : {}),
          source,
        };
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
