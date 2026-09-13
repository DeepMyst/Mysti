import * as http from 'http';
import type { DeskTransport } from './DeskClient';

/** T0 has no DNS, proxies, redirects, or non-loopback destinations. */
export function isDeskLoopbackUrl(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/desk$/.exec(value);
  return !!match && Number(match[1]) <= 65535;
}

export class DeskLoopbackTransport implements DeskTransport {
  post(url: string, body: unknown, opts: Parameters<DeskTransport['post']>[2]): ReturnType<DeskTransport['post']> {
    return new Promise((resolve, reject) => {
      if (!isDeskLoopbackUrl(url) || opts.signal.aborted
        || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > 600_000
        || !Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0 || opts.maxBytes > 65536) {
        reject(new Error('Desk transport refused')); return;
      }
      const data = Buffer.from(JSON.stringify(body), 'utf8');
      if (data.length > 65536) { reject(new Error('Desk request too large')); return; }
      let settled = false;
      let response: http.IncomingMessage | undefined;
      const finish = (error?: Error, result?: { status: number; body: unknown }) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', abort);
        response?.destroy();
        request.destroy();
        if (error) { reject(error); } else { resolve(result!); }
      };
      const abort = () => finish(new Error('Desk request cancelled'));
      const request = http.request(url, {
        method: 'POST', agent: false,
        headers: { authorization: `Bearer ${opts.bearer}`, 'content-type': 'application/json', 'content-length': data.length },
      });
      const timer = setTimeout(abort, opts.timeoutMs);
      opts.signal.addEventListener('abort', abort, { once: true });
      request.on('error', () => finish(new Error('Desk transport failed')));
      request.on('response', res => {
        response = res;
        if (res.statusCode !== 200) {
          finish(undefined, { status: res.statusCode ?? 500, body: null }); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('error', () => finish(new Error('Desk response interrupted')));
        res.on('aborted', () => finish(new Error('Desk response interrupted')));
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > opts.maxBytes) { finish(new Error('Desk response too large')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) { return; }
          try { finish(undefined, { status: 200, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { finish(new Error('Desk response invalid')); }
        });
      });
      if (opts.signal.aborted) { abort(); } else { request.end(data); }
    });
  }
}
