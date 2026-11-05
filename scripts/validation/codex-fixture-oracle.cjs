/* PB-02 independent F1 acceptance. Runs only an explicitly supplied owned fixture. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { createHash } = require('node:crypto');
const [supplied, stage = 'full'] = process.argv.slice(2);
assert(supplied, 'Supply the owned F1 src/retry.cjs path');
assert(['backoff', 'jitter', 'retry', 'full'].includes(stage));
const file = fs.realpathSync(supplied);
const ownedRoot = path.resolve(__dirname, '../../out-test/feature-tests/PB-02') + path.sep;
assert(file.startsWith(ownedRoot), 'Oracle may load only a PB-02 owned fixture');
const original = fs.readFileSync(file);
const api = require(file);
const checks = [];
async function check(name, action) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Independent check timed out')), 3000);
    })]);
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: { name: error.name, message: error.message } });
  } finally { clearTimeout(timer); }
}
function sequence(values) {
  let index = 0;
  return () => { assert(index < values.length, 'Too many random samples'); return values[index++]; };
}
async function run() {
  await check('known exponential values and independent custom cap vectors', () => {
    const vectors = [[0, 100, 1000, 100], [1, 100, 1000, 200], [2, 100, 1000, 400],
      [4, 100, 1000, 1000], [60, 100, 1000, 1000], [0, 75, 30, 30],
      [3, 7, 100, 56], [4, 7, 100, 100], [1, 0.5, 3, 1]];
    for (const [attempt, base, cap, expected] of vectors) assert.equal(api.retryDelay(attempt, base, cap), expected);
    assert.equal(api.retryDelay(0), 100); assert.equal(api.retryDelay(4), 1000);
  });
  await check('delay is bounded, finite and monotone over increasing attempts', () => {
    let previous = 0;
    for (const attempt of [0, 1, 2, 3, 4, 9, 32, 1024]) {
      const delay = api.retryDelay(attempt, 17, 300);
      assert(Number.isFinite(delay) && delay >= previous && delay <= 300); previous = delay;
    }
  });
  await check('invalid attempts and invalid base/cap are rejected', () => {
    for (const attempt of [-1, 0.5, NaN, Infinity, '1', null]) assert.throws(() => api.retryDelay(attempt));
    for (const value of [0, -1, NaN, Infinity, '100']) {
      assert.throws(() => api.retryDelay(1, value, 1000));
      assert.throws(() => api.retryDelay(1, 100, value));
    }
  });
  if (stage !== 'backoff') {
    await check('jitter endpoints and fractional samples use exactly one sample', () => {
      for (const [sample, expected] of [[0, 0], [0.25, 100], [0.999, 399], [1, 400]]) {
        let count = 0;
        assert.equal(api.fullJitter(2, { random: () => { count++; return sample; } }), expected);
        assert.equal(count, 1);
      }
      assert.equal(api.fullJitter(4, { base: 7, cap: 100, random: () => 0.5 }), 50);
    });
    await check('invalid random outputs are rejected', () => {
      for (const value of [-0.01, 1.01, NaN, Infinity, '0.5']) {
        assert.throws(() => api.fullJitter(1, { random: () => value }));
      }
    });
  }
  if (stage === 'retry' || stage === 'full') {
    await check('429 retries preserve attempt/signal and deterministic sleep order', async () => {
      const controller = new AbortController(), calls = [], sleeps = [], ok = { status: 200, body: 'ok' };
      const result = await api.retry429(async (attempt, signal) => {
        assert.equal(signal, controller.signal); calls.push(attempt); return attempt < 2 ? { status: 429 } : ok;
      }, { maxRetries: 2, random: sequence([0.25, 0.5]), sleep: async (delay, signal) => {
        assert.equal(signal, controller.signal); sleeps.push(delay);
      }, signal: controller.signal });
      assert.equal(result, ok); assert.deepEqual(calls, [0, 1, 2]); assert.deepEqual(sleeps, [25, 100]);
    });
    await check('exhaustion returns last response and maxRetries zero calls once', async () => {
      const replies = [{ status: 429, id: 0 }, { status: 429, id: 1 }, { status: 429, id: 2 }];
      let calls = 0, sleeps = 0;
      const result = await api.retry429(async () => replies[calls++], { maxRetries: 2, random: () => 0, sleep: async () => { sleeps++; } });
      assert.equal(result, replies[2]); assert.equal(calls, 3); assert.equal(sleeps, 2);
      calls = 0; sleeps = 0;
      assert.equal(await api.retry429(async () => replies[calls++], { maxRetries: 0, sleep: async () => { sleeps++; } }), replies[0]);
      assert.equal(calls, 1); assert.equal(sleeps, 0);
    });
    await check('other status and operation failure never retry or sleep', async () => {
      const forbiddenSleep = async () => assert.fail('Unexpected sleep');
      for (const status of [200, 201, 400, 500, 503]) {
        const response = { status }; let count = 0;
        assert.equal(await api.retry429(async () => { count++; return response; }, { sleep: forbiddenSleep }), response);
        assert.equal(count, 1);
      }
      const failure = new Error('Owned operation failure'); let count = 0;
      await assert.rejects(api.retry429(async () => { count++; throw failure; }, { sleep: forbiddenSleep }), error => error === failure);
      assert.equal(count, 1);
    });
    await check('pre-aborted signal prevents operation and sleep', async () => {
      const controller = new AbortController(); controller.abort(); let calls = 0;
      await assert.rejects(api.retry429(async () => { calls++; return { status: 200 }; }, {
        signal: controller.signal, sleep: async () => assert.fail('Unexpected sleep'),
      }), error => error.name === 'AbortError'); assert.equal(calls, 0);
    });
    await check('abort during sleep prevents every subsequent operation', async () => {
      const controller = new AbortController(); let calls = 0, sleeps = 0;
      await assert.rejects(api.retry429(async () => { calls++; return { status: 429 }; }, {
        signal: controller.signal, random: () => 1,
        sleep: async (_delay, signal) => { sleeps++; assert.equal(signal, controller.signal); controller.abort(); throw signal.reason; },
      }), error => error.name === 'AbortError'); assert.equal(calls, 1); assert.equal(sleeps, 1);
    });
    await check('abort remains effective if an injected sleep resolves after abort', async () => {
      const controller = new AbortController(); let calls = 0;
      await assert.rejects(api.retry429(async () => { calls++; return { status: 429 }; }, {
        signal: controller.signal, sleep: async () => { controller.abort(); },
      }), error => error.name === 'AbortError'); assert.equal(calls, 1);
    });
    await check('real loopback HTTP 429 recovers with ordered sleeps', async () => {
      let requests = 0; const sleeps = [];
      const server = http.createServer((_request, response) => {
        requests++; response.statusCode = requests < 3 ? 429 : 200;
        response.setHeader('retry-after', '0'); response.end(requests < 3 ? 'rate limited' : 'recovered');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const operation = () => new Promise((resolve, reject) => {
          const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, response => {
            const chunks = []; response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
          }); request.on('error', reject);
        });
        const result = await api.retry429(operation, { maxRetries: 2, random: () => 1, sleep: async delay => { sleeps.push(delay); } });
        assert.equal(result.status, 200); assert.equal(result.body, 'recovered'); assert.equal(requests, 3); assert.deepEqual(sleeps, [100, 200]);
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });
  }
  if (stage === 'full') {
    const now = Date.UTC(2026, 9, 10, 6, 0, 0);
    await check('Retry-After integer seconds, HTTP dates, past dates and invalid input', () => {
      assert.equal(api.retryAfterMs('0', now), 0); assert.equal(api.retryAfterMs(' 2 ', now), 2000);
      assert.equal(api.retryAfterMs('Sat, 10 Oct 2026 06:00:03 GMT', now), 3000);
      assert.equal(api.retryAfterMs('Sat, 10 Oct 2026 05:59:59 GMT', now), 0);
      for (const value of ['', ' ', '-1', 'not-a-date', undefined, null]) assert.equal(api.retryAfterMs(value, now), undefined);
    });
    await check('Retry-After competes with jitter and the explicit cap bounds both', async () => {
      const sleeps = [], headers = ['2', 'Sat, 10 Oct 2026 06:00:03 GMT']; let calls = 0;
      await api.retry429(async () => calls++ < 2 ? { status: 429, headers: { 'retry-after': headers[calls - 1] } } : { status: 200 }, {
        maxRetries: 2, cap: 1500, random: () => 0, now: () => now, sleep: async delay => { sleeps.push(delay); },
      }); assert.deepEqual(sleeps, [1500, 1500]); assert.equal(calls, 3);
    });
  }
  assert.deepEqual(fs.readFileSync(file), original, 'The oracle must not alter the fixture source');
  const result = { status: checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL', stage,
    sourceSha256: createHash('sha256').update(original).digest('hex'), checks,
    passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length,
    realProviderInputs: 0, network: ['owned loopback HTTP only'], fixtureSourceUnchanged: true };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.failed ? 1 : 0;
}
run().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
