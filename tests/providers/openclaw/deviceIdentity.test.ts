import { createPublicKey, verify } from 'crypto';
import type { SecretStorage } from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { gatewayDeviceSigner } from '../../../src/providers/openclaw/OpenClawDeviceIdentity';

describe('OpenClaw device authentication', () => {
  it('persists one private key in SecretStorage and signs the server nonce, scopes and token', async () => {
    const saved = new Map<string, string>();
    const store = vi.fn(async (key: string, value: string) => { saved.set(key, value); });
    const secrets = { get: async (key: string) => saved.get(key), store } as unknown as SecretStorage;
    const sign = gatewayDeviceSigner(secrets);
    const challenge = { nonce: 'server-nonce', token: 'test-token', scopes: ['operator.read', 'operator.write'] };
    const [a, b] = await Promise.all([sign(challenge), gatewayDeviceSigner(secrets)(challenge)]);
    expect(store).toHaveBeenCalledOnce(); expect(a.id).toBe(b.id); expect(a.nonce).toBe('server-nonce');
    expect(a).not.toHaveProperty('privateKey');
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(String(a.publicKey), 'base64url')]), type: 'spki', format: 'der' });
    const payload = ['v3', a.id, 'cli', 'cli', 'operator', challenge.scopes.join(','), a.signedAt, challenge.token, challenge.nonce, process.platform, ''].join('|');
    expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(String(a.signature), 'base64url'))).toBe(true);
    expect(verify(null, Buffer.from(payload.replace('server-nonce', 'replayed')), publicKey, Buffer.from(String(a.signature), 'base64url'))).toBe(false);
  });
  it('does not silently replace a corrupt stored identity', async () => {
    const secrets = { get: async () => 'invalid', store: vi.fn() } as unknown as SecretStorage;
    await expect(gatewayDeviceSigner(secrets)({ nonce: 'n', scopes: [] })).rejects.toThrow();
    expect(secrets.store).not.toHaveBeenCalled();
  });
});
