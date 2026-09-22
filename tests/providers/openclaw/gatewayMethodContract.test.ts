/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { VERIFIED_NATIVE_CLI_VERSIONS } from '../../../src/providers/base/NativeCliVersions';

// Advertised by the verified runtime's listGatewayMethods() (core + aux; channel
// plugin methods excluded), extracted from the npm 2026.6.34 dist. The earlier
// `sessions.history` call does not exist in 2026.6.34, 2026.7.35 or 2026.9.5,
// and `wizard.start` rejected the `{ wizard, channel }` params it was sent.
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../fixtures/openclaw/gateway-methods-2026.6.34.json'), 'utf8')) as { methods: string[] };
const source = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../../src', file), 'utf8');

describe('OpenClaw gateway method contract', () => {
  it('fixture matches the verified runtime pin', () => {
    expect(VERIFIED_NATIVE_CLI_VERSIONS.openclaw).toBe('2026.6.34');
    expect(fixture.methods).toContain('sessions.abort');
  });
  it('only requests methods the verified gateway advertises (connect is the handshake frame)', () => {
    const gateway = source('providers/openclaw/OpenClawGateway.ts');
    const requested = [...gateway.matchAll(/_sendRequest\('([^']+)'/g), ...gateway.matchAll(/method: '([^']+)'/g)].map(match => match[1]);
    expect(requested.length).toBeGreaterThan(5);
    expect(requested.filter(method => method !== 'connect' && !fixture.methods.includes(method))).toEqual([]);
    expect(requested).not.toContain('wizard.start');
  });
});
