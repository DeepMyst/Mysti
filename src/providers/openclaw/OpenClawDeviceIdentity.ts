/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'crypto';
import type { SecretStorage } from 'vscode';

export interface GatewayDeviceChallenge { nonce: string; token?: string; scopes: string[]; }
export type GatewayDeviceSigner = (challenge: GatewayDeviceChallenge) => Promise<Record<string, unknown>>;
const identities = new WeakMap<SecretStorage, Promise<string>>();

/** Mysti owns its device key; it never borrows another client's paired identity. */
export function gatewayDeviceSigner(secrets: SecretStorage): GatewayDeviceSigner {
  return async ({ nonce, token, scopes }) => {
    let pending = identities.get(secrets);
    if (!pending) {
      pending = (async () => {
        const key = 'mysti.openclaw.deviceKey.v1';
        const stored = await secrets.get(key);
        if (stored) {
          const parsed = createPrivateKey(stored);
          if (parsed.asymmetricKeyType !== 'ed25519') { throw new Error('Invalid Mysti OpenClaw device key'); }
          return stored;
        }
        const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        await secrets.store(key, pem);
        return pem;
      })();
      identities.set(secrets, pending);
      void pending.catch(() => { identities.delete(secrets); });
    }
    const privateKey = await pending;
    const raw = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
    const id = createHash('sha256').update(raw).digest('hex');
    const signedAt = Date.now();
    // OpenClaw v3 device signature payload (gateway protocols 3 and 4).
    const payload = ['v3', id, 'cli', 'cli', 'operator', scopes.join(','), String(signedAt), token || '', nonce, process.platform, ''].join('|');
    return { id, publicKey: raw.toString('base64url'), signedAt, nonce,
      signature: sign(null, Buffer.from(payload), privateKey).toString('base64url') };
  };
}
