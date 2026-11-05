/* Pure verification; an arbitrary marker may never disable process cleanup. */
'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');
exports.verifyClipboardRecovery = ({ marker, secret, window, hostPid, identities, rows, launchedAt }) => {
  if (!marker || typeof marker !== 'object' || typeof marker.signature !== 'string' || !/^[a-f0-9]{64}$/.test(marker.signature)) return false;
  const { signature, ...body } = marker;
  const expected = createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return false;
  if (body.status !== 'FAIL_RETAINED_CLIPBOARD_RECOVERY' || body.window !== window.id || body.profile !== window.profile
    || body.extensionHostPid !== hostPid || !Number.isInteger(body.guardPid) || typeof body.guardStartedAt !== 'string'
    || !Number.isFinite(body.at) || body.at < launchedAt) return false;
  const identity = `${body.guardPid}|${body.guardStartedAt}`;
  if (!identities.has(identity) || !rows.some(row => row.pid === body.guardPid && row.startedAt === body.guardStartedAt)) return false;
  const host = rows.find(row => row.pid === hostPid);
  if (!host || !identities.has(`${host.pid}|${host.startedAt}`)) return false;
  return body;
};
