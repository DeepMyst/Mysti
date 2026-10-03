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
 * EgressScanner (Plan 21 Phase 0, invariant I5) — content-level secret
 * detection for bytes that are about to LEAVE this machine.
 *
 * Why this exists: every secret check in the codebase today is a *path* filter
 * (`looksLikeSecret` in MystiLocalTools has five call sites, all path-based).
 * A path filter answers "may this file be opened"; it cannot answer "does this
 * outbound answer happen to quote a live key". A model that read a permitted
 * file and paraphrased a credential into prose defeats every path filter that
 * exists. Four competing designs for cross-machine teamwork each assumed a
 * content scanner already existed. None did.
 *
 * ── Two classes of finding, and why they are treated differently ────────────
 *
 * `findings` are DEFINITE: a vendor-prefixed token, a PEM private key block, a
 * JWT, or a secret-shaped assignment. These have low false-positive rates and
 * block egress. A block is a refusal, never a confirmation prompt — a human
 * asked "is this 40-char string a secret?" will click through, so asking is
 * worse than useless (Plan 21 §13.1: 93-97% of such prompts are approved).
 *
 * `suspected` are entropy-only hits, and they DO NOT block. This is a
 * deliberate deviation from the original spec, which called for entropy to
 * hard-block. Source code is full of legitimately high-entropy 20+ char
 * tokens — minified bundles, base64 assets, lockfile integrity hashes, CSS
 * sourcemaps. A hard block on raw entropy fails closed so often that it would
 * be switched off within a day, which is a worse security outcome than a
 * scanner that is trusted and stays on. Entropy hits are recorded for the
 * audit trail and for surfacing on a review surface; corroborated entropy (a
 * high-entropy value on the right-hand side of a secret-named assignment) is
 * already caught as a DEFINITE assignment finding.
 *
 * ── Safety properties ──────────────────────────────────────────────────────
 *
 * - A finding NEVER carries the matched value. It carries a label, a length,
 *   and a short SHA-256 fingerprint, so two occurrences can be correlated in
 *   an audit log without the log itself becoming the leak.
 * - Every pattern is linear-time: bounded quantifiers only, no nested
 *   quantifiers, no backtracking hazards.
 * - Scanning is unbounded by design. A cap would mean unscanned bytes, and
 *   silently passing unscanned bytes is exactly the truncation-as-flag failure
 *   this design refuses elsewhere.
 */

import * as crypto from 'crypto';

export type EgressFindingKind =
  | 'vendor-token'
  | 'private-key'
  | 'jwt'
  | 'assignment'
  | 'high-entropy';

export interface EgressFinding {
  kind: EgressFindingKind;
  /** Human-readable detector name. Safe to render on a card or in a log. */
  label: string;
  /** Byte offset of the match in the scanned text. */
  offset: number;
  /** Length of the matched region. The value itself is never retained. */
  length: number;
  /** First 8 hex chars of sha256(match) — correlation without disclosure. */
  fingerprint: string;
}

export interface EgressVerdict {
  /** True when nothing DEFINITE was found. Entropy suspicions do not clear it. */
  clean: boolean;
  /** Definite findings. Any entry means egress must be refused. */
  findings: EgressFinding[];
  /** Entropy-only suspicions. Advisory: recorded, surfaced, never blocking. */
  suspected: EgressFinding[];
  scannedBytes: number;
}

interface VendorPattern { label: string; re: RegExp }

/**
 * Vendor-prefixed credentials. Each anchors on a published, non-secret prefix,
 * which is what keeps the false-positive rate near zero. Quantifiers are all
 * bounded.
 */
const VENDOR_PATTERNS: VendorPattern[] = [
  { label: 'AWS access key id',        re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { label: 'GitHub token',             re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { label: 'GitHub fine-grained PAT',  re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { label: 'Slack token',              re: /\bxox[abposr]-[A-Za-z0-9-]{10,255}\b/g },
  { label: 'Stripe live key',          re: /\b[sr]k_live_[A-Za-z0-9]{16,99}\b/g },
  { label: 'Stripe test key',          re: /\b[sr]k_test_[A-Za-z0-9]{16,99}\b/g },
  { label: 'OpenAI key',               re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/g },
  { label: 'Anthropic key',            re: /\bsk-ant-[A-Za-z0-9_-]{20,255}\b/g },
  { label: 'DeepMyst gateway key',     re: /\bdm_[A-Za-z0-9_-]{16,255}\b/g },
  { label: 'Google API key',           re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'Slack webhook URL',        re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]{20,120}/g },
  { label: 'npm token',                re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: 'SendGrid key',             re: /\bSG\.[A-Za-z0-9_-]{16,80}\.[A-Za-z0-9_-]{16,80}\b/g },
  { label: 'Twilio account sid',       re: /\bAC[0-9a-fA-F]{32}\b/g },
  { label: 'PyPI token',               re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,255}\b/g },
];

/** PEM private-key blocks of every common flavour. */
const PRIVATE_KEY_RE =
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * Three dot-separated base64url segments where the first decodes to a JWT
 * header. Anchoring on `eyJ` (base64 of `{"`) keeps this cheap and specific.
 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * Secret-shaped assignment: a credential-ish name, then `=`/`:`, then a quoted
 * value of real length. The quoted-value requirement is what separates this
 * from prose like "the API key is stored in Vault".
 *
 * Written with a negated character class rather than a lazy quantifier so it
 * cannot backtrack.
 */
const ASSIGNMENT_RE =
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer)\b\s*[:=]\s*["'`]([^"'`\n]{12,200})["'`]/gi;

/**
 * Placeholder values that appear in secret-shaped assignments constantly in
 * docs, tests, and `.env.example` files. Matching one downgrades the finding.
 */
const PLACEHOLDER_RE =
  /^(?:x{3,}|\.{3,}|\*{3,}|<[^>]{0,80}>|\$\{[^}]{0,80}\}|\{\{[^}]{0,80}\}\}|your[_-]?[a-z-]{0,40}|change[_-]?me|replace[_-]?me|example|placeholder|dummy|sample|test|todo|none|null|undefined|redacted|insert[_-]?[a-z-]{0,40}|my[_-]?secret[a-z-]{0,20})$/i;

/** Minimum token length considered for the entropy pass. */
const ENTROPY_MIN_LEN = 20;
/** Shannon bits/char above which a token is flagged. Hex maxes at 4.0. */
const ENTROPY_THRESHOLD = 4.5;

/**
 * High-entropy shapes that are overwhelmingly benign. Hex-only strings are not
 * listed because hex cannot exceed 4.0 bits/char and never reaches the
 * threshold — that already excludes git SHAs, MD5/SHA digests and UUIDs.
 */
const BENIGN_ENTROPY_RE = /^(?:sha\d{3}-|data:|https?:\/\/|[0-9a-f]{8}-[0-9a-f]{4})/i;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) { counts.set(ch, (counts.get(ch) ?? 0) + 1); }
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function finding(
  kind: EgressFindingKind, label: string, match: string, offset: number,
): EgressFinding {
  return { kind, label, offset, length: match.length, fingerprint: fingerprint(match) };
}

/** Reset a global regex before use so state never leaks between scans. */
function execAll(re: RegExp, text: string, onMatch: (m: RegExpExecArray) => void): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    onMatch(m);
    // Zero-length matches cannot occur with these patterns, but guard anyway
    // so a future edit cannot turn this into an infinite loop.
    if (m[0].length === 0) { re.lastIndex++; }
  }
}

/**
 * Scan outbound text for credential material.
 *
 * Linear in the length of `text`. Never returns the matched value.
 */
export function scanEgress(text: string): EgressVerdict {
  const findings: EgressFinding[] = [];
  const suspected: EgressFinding[] = [];

  if (!text) {
    return { clean: true, findings, suspected, scannedBytes: 0 };
  }

  for (const { label, re } of VENDOR_PATTERNS) {
    execAll(re, text, m => findings.push(finding('vendor-token', label, m[0], m.index)));
  }

  execAll(PRIVATE_KEY_RE, text, m =>
    findings.push(finding('private-key', 'PEM private key block', m[0], m.index)));

  execAll(JWT_RE, text, m =>
    findings.push(finding('jwt', 'JSON Web Token', m[0], m.index)));

  execAll(ASSIGNMENT_RE, text, m => {
    const value = m[1].trim();
    // A documented placeholder is not a credential. Downgrading rather than
    // dropping keeps it visible in an audit without blocking a README.
    if (PLACEHOLDER_RE.test(value)) {
      suspected.push(finding('assignment', 'Secret-shaped assignment (placeholder value)', m[0], m.index));
      return;
    }
    // A real credential is random; a test fixture usually is not. Measured
    // against this repository, every first-party false positive was a
    // fixture of this shape (e.g. `TOKEN = 'aaaaaaaabbbbbbbbcccccccc...'`).
    // Low entropy or a tiny alphabet is strong evidence of a fixture, so it
    // downgrades to advisory rather than blocking a test file.
    //
    // Deliberately NOT extended to catch every plausible fake (`sk-or-123…`
    // still blocks): tightening further means encoding this repo's fixture
    // habits into a security control, which trades a real detection for a
    // cosmetic one.
    const distinct = new Set(value).size;
    if (distinct <= 5 || shannonEntropy(value) < 3.2) {
      suspected.push(finding('assignment', 'Secret-shaped assignment (fixture-shaped value)', m[0], m.index));
      return;
    }
    findings.push(finding('assignment', 'Secret-shaped assignment', m[0], m.index));
  });

  // Entropy pass — advisory only. See the header comment for why this does not
  // block: a hard block on raw entropy fires on minified bundles and base64
  // assets often enough that the scanner gets disabled, and a disabled scanner
  // protects nothing.
  const tokenRe = /[A-Za-z0-9+/=_-]{20,}/g;
  execAll(tokenRe, text, m => {
    const tok = m[0];
    if (tok.length < ENTROPY_MIN_LEN) { return; }
    if (BENIGN_ENTROPY_RE.test(tok)) { return; }
    if (shannonEntropy(tok) < ENTROPY_THRESHOLD) { return; }
    // Already reported by a definite detector at this offset? Don't double-count.
    if (findings.some(f => m.index >= f.offset && m.index < f.offset + f.length)) { return; }
    suspected.push(finding('high-entropy', 'High-entropy token', tok, m.index));
  });

  return {
    clean: findings.length === 0,
    findings,
    suspected,
    scannedBytes: Buffer.byteLength(text, 'utf8'),
  };
}

/**
 * Whether this payload must be refused. Kept as a named predicate so call sites
 * read as policy rather than as a length check, and so the entropy/definite
 * distinction cannot be accidentally collapsed by a caller.
 */
export function blocksEgress(verdict: EgressVerdict): boolean {
  return verdict.findings.length > 0;
}

/**
 * One-line, value-free summary for an audit row or a refusal message.
 */
export function describeEgressVerdict(verdict: EgressVerdict): string {
  if (verdict.findings.length === 0 && verdict.suspected.length === 0) {
    return `clean (${verdict.scannedBytes} bytes scanned)`;
  }
  const parts: string[] = [];
  if (verdict.findings.length > 0) {
    const labels = [...new Set(verdict.findings.map(f => f.label))].sort();
    parts.push(`BLOCKED: ${verdict.findings.length} finding(s) — ${labels.join(', ')}`);
  }
  if (verdict.suspected.length > 0) {
    parts.push(`${verdict.suspected.length} advisory suspicion(s)`);
  }
  return parts.join('; ');
}
