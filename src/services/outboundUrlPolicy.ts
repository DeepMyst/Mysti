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

import { promises as dnsPromises } from 'dns';

/**
 * outboundUrlPolicy — the single gate every fetch of a MODEL- or TOOL-supplied
 * URL must pass through.
 *
 * Why this exists: a URL scraped out of an MCP tool's prose (fal CDN links are
 * returned as text) is attacker-influenceable — a compromised connector, a
 * poisoned upstream, or the model steering tool selection is enough. The
 * extension host runs inside the user's network and, in a Codespace or
 * devcontainer, inside a cloud instance, so an unguarded GET is a credential
 * read primitive: `http://169.254.169.254/latest/meta-data/iam/...` comes back
 * as bytes we then base64 and persist where the model can read them.
 *
 * The policy DENIES BY DEFAULT and fails closed on anything it cannot parse or
 * resolve. It rejects:
 *   - non-http(s) schemes (`file:`, `data:`, `gopher:`, …) and, unless
 *     `allowHttp` is set, plain `http:`
 *   - credentials embedded in the URL (`https://user:pw@host/`)
 *   - loopback, private (RFC1918/CGNAT/ULA), link-local, multicast/reserved and
 *     cloud metadata addresses — whether written as a literal, reached through
 *     DNS, or arrived at through a redirect (every hop is re-validated)
 *
 * Deliberately NOT solved here: DNS rebinding. We resolve the hostname, check
 * every address, and then hand the hostname to fetch, which resolves again — a
 * TTL-0 record can differ between the two. Closing that needs connect-time
 * pinning (an undici Agent with a custom `lookup`), which is a larger change
 * than this fix; the residual risk is recorded rather than hidden.
 */

/** Hosts that are never fetchable, whatever they resolve to. */
const FORBIDDEN_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
  '169.254.169.254',
  'fd00:ec2::254',
]);

/** Suffixes that name a private/ambient namespace rather than a public host. */
const FORBIDDEN_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

export interface OutboundUrlPolicyOptions {
  /** Permit plain `http:`. Default false — https only. */
  allowHttp?: boolean;
  /** Injected DNS resolver (tests). Must return the addresses `host` resolves to. */
  resolve?: (host: string) => Promise<string[]>;
  /** Redirect hops re-validated before giving up. Default 5. */
  maxRedirects?: number;
  /** Hard cap on retained bytes. Default 32 MiB. */
  maxBytes?: number;
  /** Injected fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
}

/** Thrown for every refusal, so callers can tell a policy denial from a network error. */
export class OutboundUrlBlockedError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`blocked outbound URL (${reason})`);
    this.name = 'OutboundUrlBlockedError';
  }
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

/** Strip the decorations a hostname can carry: brackets, zone id, trailing dot, case. */
function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) { h = h.slice(1, -1); }
  const zone = h.indexOf('%');
  if (zone >= 0) { h = h.slice(0, zone); }
  while (h.endsWith('.')) { h = h.slice(0, -1); }
  return h;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Is this dotted-quad outside the public internet? Covers every range that can
 * reach something the user did not mean to expose.
 */
function isForbiddenIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  if (!m) { return false; }
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) { return true; }
  if (a === 0) { return true; }                                   // 0.0.0.0/8 "this network"
  if (a === 10) { return true; }                                  // RFC1918
  if (a === 100 && b >= 64 && b <= 127) { return true; }          // CGNAT 100.64/10
  if (a === 127) { return true; }                                 // loopback
  if (a === 169 && b === 254) { return true; }                    // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) { return true; }           // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) { return true; } // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) { return true; }                    // RFC1918
  if (a === 198 && (b === 18 || b === 19)) { return true; }       // benchmarking
  if (a === 198 && b === 51 && c === 100) { return true; }        // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) { return true; }         // TEST-NET-3
  if (a >= 224) { return true; }                                  // multicast, reserved, broadcast
  return false;
}

/** `::ffff:a9fe:a9fe` (how Node normalizes `::ffff:169.254.169.254`) → `169.254.169.254`. */
function embeddedIpv4(ip: string): string | null {
  const dotted = /^(?:::ffff:|::ffff:0:|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (dotted) { return dotted[1]; }
  const hex = /^(?:::ffff:|::ffff:0:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (!hex) { return null; }
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** IPv6 ranges that are not the public internet (plus IPv4-in-IPv6 forms). */
function isForbiddenIpv6(ip: string): boolean {
  if (!ip.includes(':')) { return false; }
  const v4 = embeddedIpv4(ip);
  if (v4) { return isForbiddenIpv4(v4); }
  if (ip === '::' || ip === '::1' || ip === '::0') { return true; }
  // Anything else starting `::` is a reserved/unspecified form — never a real host.
  if (ip.startsWith('::')) { return true; }
  if (/^f[cd]/.test(ip)) { return true; }        // fc00::/7 unique-local (incl. fd00:ec2::254)
  if (/^fe[89ab]/.test(ip)) { return true; }     // fe80::/10 link-local
  if (/^ff/.test(ip)) { return true; }           // ff00::/8 multicast
  if (/^2002:/.test(ip)) { return true; }        // 6to4 — carries an embedded v4 destination
  if (/^64:ff9b:/.test(ip)) { return true; }     // NAT64
  return false;
}

/** True when `host` is an IP literal we refuse to talk to. */
export function isForbiddenAddress(host: string): boolean {
  const h = normalizeHost(host);
  if (FORBIDDEN_HOSTS.has(h)) { return true; }
  if (IPV4_RE.test(h)) { return isForbiddenIpv4(h); }
  return isForbiddenIpv6(h);
}

/**
 * True when `host` names this machine. Used where loopback is the ONE tolerated
 * exception (a local dev broker), never as a general allow.
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) { return true; }
  if (IPV4_RE.test(h)) { return h.startsWith('127.'); }
  return h === '::1' || h === '::' || h === '::0';
}

/** True when `host` is an IP literal in any notation (Node's URL parser normalizes these). */
function isIpLiteral(host: string): boolean {
  return IPV4_RE.test(host) || host.includes(':');
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await dnsPromises.lookup(host, { all: true, verbatim: true });
  return records.map(r => r.address);
}

/**
 * Validate one URL. Resolves to the parsed URL, or throws OutboundUrlBlockedError.
 * Fails closed: an unparseable URL, an unresolvable host, or a host with no
 * addresses is a refusal, not a pass.
 */
export async function assertAllowedOutboundUrl(
  raw: string,
  opts: OutboundUrlPolicyOptions = {}
): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OutboundUrlBlockedError(String(raw), 'unparseable URL');
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new OutboundUrlBlockedError(raw, `scheme ${u.protocol} is not http(s)`);
  }
  if (u.protocol === 'http:' && !opts.allowHttp) {
    throw new OutboundUrlBlockedError(raw, 'plain http is not allowed');
  }
  // Credentials in a model-supplied URL are either an exfiltration channel or a
  // way to make a proxy/basic-auth endpoint behave differently than it looks.
  if (u.username || u.password) {
    throw new OutboundUrlBlockedError(raw, 'URL carries credentials');
  }

  const host = normalizeHost(u.hostname);
  if (!host) {
    throw new OutboundUrlBlockedError(raw, 'empty host');
  }
  if (FORBIDDEN_HOSTS.has(host)) {
    throw new OutboundUrlBlockedError(raw, `forbidden host ${host}`);
  }
  // Exact/suffix match on names, never a substring compare: a suffix rule on a
  // bare `localhost` would let `http://localhost.evil.com` through.
  if (host === 'localhost' || FORBIDDEN_SUFFIXES.some(s => host.endsWith(s))) {
    throw new OutboundUrlBlockedError(raw, `forbidden host ${host}`);
  }

  if (isIpLiteral(host)) {
    if (isForbiddenAddress(host)) {
      throw new OutboundUrlBlockedError(raw, `address ${host} is not public`);
    }
    return u;
  }

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    throw new OutboundUrlBlockedError(raw, `host ${host} did not resolve`);
  }
  if (!addresses || addresses.length === 0) {
    throw new OutboundUrlBlockedError(raw, `host ${host} resolved to nothing`);
  }
  for (const addr of addresses) {
    if (isForbiddenAddress(addr)) {
      throw new OutboundUrlBlockedError(raw, `host ${host} resolves to non-public ${addr}`);
    }
  }
  return u;
}

/**
 * Fetch through the policy. Redirects are followed MANUALLY so every hop is
 * re-validated — a public host that 302s to the metadata service is the classic
 * way an origin allowlist becomes decoration.
 */
export async function fetchGuarded(
  raw: string,
  init?: RequestInit,
  opts: OutboundUrlPolicyOptions = {}
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertAllowedOutboundUrl(current, opts);
    const res = await doFetch(url.toString(), { ...(init ?? {}), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) { return res; }
      try {
        current = new URL(location, url).toString();
      } catch {
        throw new OutboundUrlBlockedError(location, 'unparseable redirect target');
      }
      continue;
    }
    return res;
  }
  throw new OutboundUrlBlockedError(raw, 'too many redirects');
}

/**
 * Fetch a media URL and return its bytes, size-capped. This is the shape the
 * canvas media path needs, so the call site is one guarded call rather than a
 * bare `fetch` plus a policy it can forget to apply.
 */
export async function fetchGuardedBytes(
  raw: string,
  opts: OutboundUrlPolicyOptions = {}
): Promise<{ base64: string; mimeType?: string }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const res = await fetchGuarded(raw, undefined, opts);
  if (!res.ok) {
    throw new Error(`media download failed: HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OutboundUrlBlockedError(raw, `content-length ${declared} exceeds ${maxBytes}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new OutboundUrlBlockedError(raw, `body ${buf.byteLength} exceeds ${maxBytes}`);
  }
  return { base64: buf.toString('base64'), mimeType: res.headers.get('content-type') ?? undefined };
}
