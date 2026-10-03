/**
 * SSRF gate for model-/tool-supplied URLs (audit FINDING 3).
 *
 * The canvas media path scrapes a URL out of an MCP tool's TEXT response
 * (ChatViewProvider.ts:11473-11477) and hands it to a bare `fetch`
 * (:11490-11495) whose bytes are base64'd and persisted as a canvas asset. The
 * URL's author is a remote MCP server, so it is attacker-influenceable, and the
 * extension host sits inside the user's network — in a Codespace, inside a
 * cloud instance with a metadata service on 169.254.169.254.
 *
 * These tests pin the shared policy that every such fetch must pass through.
 * The first test is a CHARACTERIZATION of the unguarded call site: it shows a
 * bare `fetch` really does retain the bytes of a loopback "metadata" service,
 * which is the behaviour the guard has to refuse.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  assertAllowedOutboundUrl,
  fetchGuarded,
  fetchGuardedBytes,
  isForbiddenAddress,
  OutboundUrlBlockedError,
} from '../../src/services/outboundUrlPolicy';

/** A stand-in for an instance-metadata endpoint, on loopback. */
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('AccessKeyId: AKIAEXAMPLE');
});
let baseUrl = '';
const listening = new Promise<void>(resolve => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    resolve();
  });
});

afterAll(() => { server.close(); });

const publicResolve = async () => ['93.184.216.34'];

describe('the unguarded call site (characterization)', () => {
  it('a bare fetch of a tool-supplied URL retains the response bytes', async () => {
    await listening;
    // Verbatim shape of ChatViewProvider._buildCanvasMediaService's fetchBytes.
    const res = await fetch(`${baseUrl}/latest/meta-data/iam/security-credentials/role`);
    const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    expect(Buffer.from(base64, 'base64').toString()).toContain('AKIAEXAMPLE');
  });

  it('...and the guard refuses the same URL', async () => {
    await listening;
    await expect(
      fetchGuardedBytes(`${baseUrl}/latest/meta-data/iam/security-credentials/role`, { allowHttp: true })
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  });
});

describe('assertAllowedOutboundUrl — schemes and credentials', () => {
  it('rejects non-http(s) schemes', async () => {
    for (const u of ['file:///etc/passwd', 'data:text/plain,hi', 'gopher://x/', 'ftp://h/f']) {
      await expect(assertAllowedOutboundUrl(u, { resolve: publicResolve })).rejects.toThrow(/not http|unparseable/);
    }
  });

  it('rejects plain http unless explicitly allowed', async () => {
    await expect(assertAllowedOutboundUrl('http://cdn.example.com/a.png', { resolve: publicResolve }))
      .rejects.toThrow(/plain http/);
    await expect(assertAllowedOutboundUrl('http://cdn.example.com/a.png', { resolve: publicResolve, allowHttp: true }))
      .resolves.toBeInstanceOf(URL);
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(assertAllowedOutboundUrl('https://user:pw@cdn.example.com/a.png', { resolve: publicResolve }))
      .rejects.toThrow(/credentials/);
  });

  it('fails closed on an unparseable URL', async () => {
    await expect(assertAllowedOutboundUrl('not a url')).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  });
});

describe('assertAllowedOutboundUrl — addresses', () => {
  const blocked = [
    'https://169.254.169.254/latest/meta-data/',        // AWS/Azure metadata
    'https://[fd00:ec2::254]/latest/meta-data/',        // AWS IPv6 metadata
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://metadata/computeMetadata/v1/',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://10.0.0.5/x',
    'https://172.16.3.4/x',
    'https://192.168.1.1/x',
    'https://100.64.0.1/x',                             // CGNAT
    'https://[fe80::1]/x',                              // link-local v6
    'https://[fc00::1]/x',                              // unique-local v6
    'https://0.0.0.0/x',
    'https://localhost/x',
    'https://db.internal/x',
    'https://printer.local/x',
    'https://api.localhost/x',
  ];
  for (const u of blocked) {
    it(`blocks ${u}`, async () => {
      await expect(assertAllowedOutboundUrl(u, { resolve: publicResolve }))
        .rejects.toBeInstanceOf(OutboundUrlBlockedError);
    });
  }

  it('blocks obfuscated literal notations that Node normalizes', async () => {
    // 2130706433 === 127.0.0.1; 0x7f.0.0.1 likewise; ::ffff:a9fe:a9fe is the
    // IPv4-mapped form of 169.254.169.254 that Node prints back in hex.
    for (const u of ['http://2130706433/x', 'http://0x7f.0.0.1/x', 'http://[::ffff:169.254.169.254]/x', 'http://[::ffff:a9fe:a9fe]/x']) {
      await expect(assertAllowedOutboundUrl(u, { resolve: publicResolve, allowHttp: true }))
        .rejects.toBeInstanceOf(OutboundUrlBlockedError);
    }
  });

  it('matches names exactly — localhost.evil.com is NOT localhost', async () => {
    await expect(assertAllowedOutboundUrl('https://localhost.evil.com/x', { resolve: publicResolve }))
      .resolves.toBeInstanceOf(URL);
  });

  it('blocks a public NAME that resolves to a private address', async () => {
    await expect(
      assertAllowedOutboundUrl('https://cdn.example.com/a.png', { resolve: async () => ['169.254.169.254'] })
    ).rejects.toThrow(/non-public/);
    await expect(
      assertAllowedOutboundUrl('https://cdn.example.com/a.png', { resolve: async () => ['93.184.216.34', '10.1.2.3'] })
    ).rejects.toThrow(/non-public/);
  });

  it('fails closed when resolution fails or returns nothing', async () => {
    await expect(assertAllowedOutboundUrl('https://cdn.example.com/a.png', {
      resolve: async () => { throw new Error('ENOTFOUND'); },
    })).rejects.toThrow(/did not resolve/);
    await expect(assertAllowedOutboundUrl('https://cdn.example.com/a.png', { resolve: async () => [] }))
      .rejects.toThrow(/resolved to nothing/);
  });

  it('isForbiddenAddress classifies literals directly', () => {
    expect(isForbiddenAddress('169.254.169.254')).toBe(true);
    expect(isForbiddenAddress('[fd00:ec2::254]')).toBe(true);
    expect(isForbiddenAddress('fe80::1%eth0')).toBe(true);
    expect(isForbiddenAddress('93.184.216.34')).toBe(false);
  });
});

describe('fetchGuarded — redirects', () => {
  it('re-validates every hop: a public host that redirects to metadata is blocked', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith('https://cdn.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      }
      return new Response('secret', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchGuarded('https://cdn.example.com/a.png', undefined, { fetchImpl, resolve: publicResolve }))
      .rejects.toBeInstanceOf(OutboundUrlBlockedError);
    // The second hop must never have been issued.
    expect(seen).toEqual(['https://cdn.example.com/a.png']);
  });

  it('never lets the runtime follow a redirect for us', async () => {
    // If the request went out with the default `redirect: 'follow'`, undici
    // would chase the Location header itself and the per-hop re-validation
    // above would never run — the guard would be decoration.
    const inits: Array<RequestInit | undefined> = [];
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      inits.push(init);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    await fetchGuarded('https://cdn.example.com/a.png', undefined, { fetchImpl, resolve: publicResolve });
    expect(inits[0]?.redirect).toBe('manual');
  });

  it('follows an allowed redirect and caps the hop count', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return n <= 2
        ? new Response(null, { status: 302, headers: { location: `https://cdn.example.com/${n}` } })
        : new Response('ok', { status: 200, headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const res = await fetchGuarded('https://cdn.example.com/a.png', undefined, { fetchImpl, resolve: publicResolve });
    expect(res.status).toBe(200);

    const loop = (async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/next' } })) as unknown as typeof fetch;
    await expect(fetchGuarded('https://cdn.example.com/a.png', undefined, { fetchImpl: loop, resolve: publicResolve }))
      .rejects.toThrow(/too many redirects/);
  });
});

describe('fetchGuardedBytes', () => {
  it('returns base64 + mime for an allowed URL', async () => {
    const fetchImpl = (async () => new Response('PNGDATA', { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    const out = await fetchGuardedBytes('https://cdn.example.com/a.png', { fetchImpl, resolve: publicResolve });
    expect(Buffer.from(out.base64, 'base64').toString()).toBe('PNGDATA');
    expect(out.mimeType).toBe('image/png');
  });

  it('caps retained bytes', async () => {
    const fetchImpl = (async () => new Response('x'.repeat(64), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchGuardedBytes('https://cdn.example.com/a.png', { fetchImpl, resolve: publicResolve, maxBytes: 8 }))
      .rejects.toThrow(/exceeds 8/);
  });
});

describe('the policy is WIRED, not merely shipped', () => {
  // A security control with no production caller is worse than none: its
  // existence reads, to the next person, like the vulnerability is closed.
  // When this module landed, `fetchGuardedBytes` had ZERO production callers —
  // the canvas media path still did a bare `await fetch(url)` on a URL scraped
  // out of an MCP tool's prose, with redirect:'follow'. That is the SSRF this
  // file exists to stop, and it stayed live.
  const SRC = path.resolve(__dirname, '..', '..', 'src');

  function sources(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { sources(full, out); }
      else if (e.name.endsWith('.ts')) { out.push(full); }
    }
    return out;
  }

  const files = sources(SRC).filter(f => !f.endsWith(path.join('services', 'outboundUrlPolicy.ts')));

  it('fetchGuardedBytes has at least one production caller', () => {
    const callers = files.filter(f => /fetchGuardedBytes\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(callers.map(f => path.relative(SRC, f)), 'fetchGuardedBytes is dead code — the SSRF sink it exists for is unguarded')
      .not.toEqual([]);
  });

  it('the canvas media downloader routes through the policy, not bare fetch', () => {
    const cvp = fs.readFileSync(path.join(SRC, 'providers', 'ChatViewProvider.ts'), 'utf8');
    // The helper handed to CanvasMediaService as `fetchBytes`.
    const at = cvp.indexOf('const fetchBytes');
    expect(at, 'the `fetchBytes` helper moved — re-point this guard before deleting it')
      .toBeGreaterThan(-1);
    const helper = cvp.slice(at, at + 500);
    expect(helper).toContain('fetchGuardedBytes');
    // `\bfetch\s*\(` cannot match `fetchGuardedBytes(` — the paren does not follow.
    expect(helper, 'a bare fetch() here follows redirects into the link-local range')
      .not.toMatch(/\bfetch\s*\(/);
  });
});
