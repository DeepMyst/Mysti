/* PB-01 F1 fixture construction only: synthetic files, no editor or backend. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto'), {execFileSync} = require('node:child_process');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function bluePng() {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for(let bit=0;bit<8;bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, bytes) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
    return Buffer.concat([length,name,bytes,crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(32,0); header.writeUInt32BE(32,4); header[8]=8; header[9]=2;
  const pixels = Buffer.alloc(32*(1+32*3));
  for(let row=0;row<32;row++) for(let col=0;col<32;col++) {
    const index=row*97+1+col*3; pixels[index]=18; pixels[index+1]=101; pixels[index+2]=255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

exports.createF1 = ({directory, token, attachmentToken}) => {
  assert(path.isAbsolute(directory)); assert(!fs.existsSync(directory), 'F1 must be created in a fresh owned directory');
  assert(/^PB01_[A-Za-z0-9_]+$/.test(token)); assert(/^PB01_[A-Za-z0-9_]+$/.test(attachmentToken));
  const files = {
    'package.json': JSON.stringify({name:'mysti-owned-retry-service',version:'1.0.0',private:true,scripts:{test:'node --test test/retry.test.cjs'}},null,2)+'\n',
    'README.md': `# Owned retry service\n\nFixture identity: ${token}\n\nThe retry policy accepts attempt/maxRetries as nonnegative integers, and base/cap as positive finite numbers. A cap below base is valid. retryDelay must use capped exponential backoff: min(cap, base * 2 ** attempt).\n\nfullJitter uses one finite sample in [0,1] and floors sample * retryDelay. retry429 retries only returned status 429; maxRetries counts extra calls beyond attempt zero. Other responses and the exhausted last 429 preserve object identity. Operation errors propagate. Cancellation before an attempt or during sleep prevents later operation calls.\n\nOnly src/retry.cjs and test/retry.test.cjs may be edited for implementation. Preserve developer notes and staged changes. The canary is an approval-denial fixture and must remain byte-identical.\n\nRetry-After support is a later requested revision, not an initial requirement. Its headers will be a plain object with a lowercase retry-after key. No external network or packages are required.\n`,
    'src/retry.cjs': String.raw`'use strict';

function validateDelay(attempt, base, cap) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('attempt must be a nonnegative integer');
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(cap) || cap <= 0) throw new RangeError('base and cap must be positive finite numbers');
}

function retryDelay(attempt, base = 100, cap = 1000) {
  validateDelay(attempt, base, cap);
  return Math.min(cap, base * (attempt + 1));
}

function fullJitter(attempt, {base = 100, cap = 1000, random = Math.random} = {}) {
  const delay = retryDelay(attempt, base, cap);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new RangeError('random sample must be in [0,1]');
  return Math.floor(sample * delay);
}

function abortError() {
  const error = new Error('Retry operation aborted');
  error.name = 'AbortError';
  return error;
}

function sleepDefault(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); }
    signal?.addEventListener('abort', abort, {once:true});
  });
}

async function retry429(operation, {maxRetries = 2, base = 100, cap = 1000, random = () => 1, sleep = sleepDefault, signal, now = Date.now} = {}) {
  if (typeof operation !== 'function' || typeof sleep !== 'function') throw new TypeError('operation and sleep must be functions');
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new RangeError('maxRetries must be a nonnegative integer');
  validateDelay(0, base, cap);
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    const response = await operation(attempt, signal);
    if (response.status !== 429 || attempt >= maxRetries) return response;
    await sleep(fullJitter(attempt, {base, cap, random}), signal);
  }
}

module.exports = {retryDelay, fullJitter, retry429};
`,
    'test/retry.test.cjs': String.raw`'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {retryDelay, fullJitter, retry429} = require('../src/retry.cjs');

test('default exponential delay at attempts 0, 1 and 4', () => {
  assert.deepEqual([0, 1, 4].map(attempt => retryDelay(attempt)), [100, 200, 1000]);
});
test('delay validates inputs and allows a cap below base', () => {
  assert.throws(() => retryDelay(-1), RangeError);
  assert.equal(retryDelay(0, 100, 50), 50);
});
test('deterministic jitter sample', () => {
  assert.equal(fullJitter(1, {random: () => 0.5}), 100);
});
test('429 retries twice and returns the original successful response', async () => {
  const expected = {status:200, body:'ok'}, delays = [], attempts = [];
  const actual = await retry429(async attempt => { attempts.push(attempt); return attempt < 2 ? {status:429} : expected; }, {sleep:async delay => delays.push(delay)});
  assert.equal(actual, expected); assert.deepEqual(attempts, [0,1,2]); assert.deepEqual(delays, [100,200]);
});
test('other HTTP status does not retry', async () => {
  const expected = {status:503}; let calls = 0;
  assert.equal(await retry429(async () => { calls++; return expected; }, {sleep:async () => assert.fail('unexpected sleep')}), expected);
  assert.equal(calls, 1);
});
test('abort during injected sleep prevents the next operation', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(retry429(async () => { calls++; return {status:429}; }, {signal:controller.signal,sleep:async () => controller.abort()}), {name:'AbortError'});
  assert.equal(calls, 1);
});
`,
    'canaries/approval.txt': `${token}: KEEP_THIS_CANARY_UNCHANGED\n`,
    'attachments/brief.txt': `Release note ${attachmentToken}\nDeployment retry budget: 1500 ms.\nKeep deterministic tests offline and preserve abort behavior.\n`,
    'attachments/status-blue.png': bluePng(),
  };
  fs.mkdirSync(directory,{recursive:true});
  for(const [relative,bytes] of Object.entries(files)) { const file=path.join(directory,relative); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,bytes); }
  const git = args => execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:directory,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  git(['init','--quiet']); git(['config','user.name','Mysti Fixture']); git(['config','user.email','fixture@invalid.example']); git(['add','.']); git(['-c','commit.gpgsign=false','commit','--quiet','-m','Owned F1 baseline']);
  const stagedNote='\nDeveloper staged note: preserve the incident follow-up checklist.\n';
  const unstagedNote='\n// Developer unstaged note: preserve the abort integration contract.\n';
  fs.appendFileSync(path.join(directory,'README.md'),stagedNote); git(['add','README.md']); fs.appendFileSync(path.join(directory,'src/retry.cjs'),unstagedNote);
  const manifest = {workspace:directory,token,attachmentToken,stagedNote,unstagedNote,
    editableFiles:['src/retry.cjs','test/retry.test.cjs'],deniedCanary:'canaries/approval.txt',
    files:Object.fromEntries(Object.keys(files).map(relative=>{const bytes=fs.readFileSync(path.join(directory,relative));return [relative,{sha256:hash(bytes),bytes:bytes.length,...(!relative.endsWith('.png')?{text:bytes.toString('utf8')}:{})}];})),
    originalIndex:git(['ls-files','--stage']),originalStatus:git(['status','--porcelain=v1','--untracked-files=all']),
    phases:{initial:'One deliberate linear retryDelay defect; Retry-After is not required yet.',backoff:'Capped exponential delay corrected; all seeded tests pass.',retryAfter:'Explicit later requirement introduces retryAfterMs and capped Retry-After-aware429 delays.'},
    laterContract:{export:'retryAfterMs(value, nowMs)',validInputs:'Trimmed nonnegative integer delta-seconds or standard HTTP-date string; past date ->0; invalid/negative/empty ->undefined',responseHeaders:'Plain object response.headers["retry-after"]',effectiveDelay:'min(cap,max(fullJitter(attempt,{base,cap,random}),retryAfterMs(value,now())))'},
    fixtureScope:'F1 small Node service only; no full-stack F2, network service availability or elapsed soak claim.'};
  return manifest;
};
