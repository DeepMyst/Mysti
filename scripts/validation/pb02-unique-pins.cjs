/* Collapse identical manifest declarations; conflicting identities always fail. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
function uniquePins(pins) {
  assert(Array.isArray(pins));
  const seen = new Map();
  for (const pin of pins) {
    assert.deepEqual(Object.keys(pin).sort(), ['path', 'sha256']);
    assert(path.isAbsolute(pin.path) && path.resolve(pin.path) === pin.path);
    assert(/^[a-f0-9]{64}$/.test(pin.sha256));
    if (seen.has(pin.path)) assert.deepEqual(seen.get(pin.path), pin, 'Conflicting manifest identity');
    else seen.set(pin.path, { ...pin });
  }
  return [...seen.values()];
}
module.exports = { uniquePins };
