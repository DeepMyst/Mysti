/**
 * EgressScanner tests (Plan 21 Phase 0, invariant I5).
 *
 * Two halves, and the second matters as much as the first: a scanner that
 * blocks legitimate work gets switched off, and a switched-off scanner protects
 * nothing. So the false-positive suite is not padding — it is the thing that
 * decides whether this control survives contact with a real repository.
 */
import { describe, it, expect } from 'vitest';
import {
  scanEgress,
  blocksEgress,
  describeEgressVerdict,
} from '../../src/services/EgressScanner';

/** Assembled at runtime so this file never contains a literal key shape that
 *  a secret scanner (ours or a CI one) would flag on its own source. */
const j = (...p: string[]) => p.join('');

describe('EgressScanner — definite findings block', () => {
  const cases: [string, string][] = [
    ['AWS access key id',       j('AKIA', 'IOSFODNN7EXAMPLE')],
    ['GitHub token',            j('ghp_', 'a'.repeat(36))],
    ['GitHub fine-grained PAT', j('github_pat_', 'B'.repeat(30))],
    ['Slack token',             j('xoxb-', '123456789012-abcdefghijkl')],
    ['Stripe live key',         j('sk_live_', 'z'.repeat(24))],
    ['OpenAI key',              j('sk-', 'proj-', 'Q'.repeat(32))],
    ['Anthropic key',           j('sk-ant-', 'api03-', 'W'.repeat(30))],
    ['DeepMyst gateway key',    j('dm_', 'k'.repeat(32))],
    ['Google API key',          j('AIza', 'S'.repeat(35))],
    ['npm token',               j('npm_', 'n'.repeat(36))],
    ['Twilio account sid',      j('AC', '0123456789abcdef0123456789abcdef')],
  ];

  for (const [label, secret] of cases) {
    it(`detects and blocks: ${label}`, () => {
      const v = scanEgress(`here is the value ${secret} in some prose`);
      expect(blocksEgress(v), `${label} must block`).toBe(true);
      expect(v.clean).toBe(false);
    });
  }

  it('detects a PEM private key block', () => {
    const v = scanEgress('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----');
    expect(blocksEgress(v)).toBe(true);
    expect(v.findings.some(f => f.kind === 'private-key')).toBe(true);
  });

  it('detects an OPENSSH private key block', () => {
    const v = scanEgress('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz\n');
    expect(blocksEgress(v)).toBe(true);
  });

  it('detects a JWT', () => {
    const jwt = j('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dBjftJeZ4CVPmB92K27u');
    const v = scanEgress(`Authorization: Bearer ${jwt}`);
    expect(blocksEgress(v)).toBe(true);
    expect(v.findings.some(f => f.kind === 'jwt')).toBe(true);
  });

  it('detects a secret-shaped assignment with a real value', () => {
    const v = scanEgress('const config = { api_key: "8f3kd9sm2nfj4hd8sk20xk" };');
    expect(blocksEgress(v)).toBe(true);
    expect(v.findings.some(f => f.kind === 'assignment')).toBe(true);
  });

  it('finds every occurrence, not just the first', () => {
    const a = j('AKIA', 'IOSFODNN7EXAMPLE');
    const b = j('AKIA', 'JOSFODNN7EXAMPLB');
    const v = scanEgress(`${a} ... and later ... ${b}`);
    expect(v.findings.filter(f => f.label === 'AWS access key id')).toHaveLength(2);
  });
});

describe('EgressScanner — never leaks the value it found', () => {
  it('a finding carries no fragment of the secret', () => {
    const secret = j('AKIA', 'IOSFODNN7EXAMPLE');
    const v = scanEgress(`key=${secret}`);
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('IOSFODNN7EXAMPLE');
  });

  it('the human-readable summary carries no fragment of the secret', () => {
    const secret = j('ghp_', 'S'.repeat(36));
    const text = describeEgressVerdict(scanEgress(`token: ${secret}`));
    expect(text).not.toContain(secret);
    expect(text).toContain('BLOCKED');
  });

  it('fingerprints are stable and distinguish different secrets', () => {
    const a = scanEgress(j('AKIA', 'IOSFODNN7EXAMPLE')).findings[0];
    const b = scanEgress(j('AKIA', 'IOSFODNN7EXAMPLE')).findings[0];
    const c = scanEgress(j('AKIA', 'JOSFODNN7EXAMPLB')).findings[0];
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('EgressScanner — false-positive resistance', () => {
  const benign: [string, string][] = [
    ['ordinary prose',        'The API key is stored in Vault and rotated quarterly.'],
    ['a git SHA',             'Fixed in commit 8cbd656a1f2e3d4c5b6a7988990a1b2c3d4e5f60 last week.'],
    ['a UUID',                'panelId: "550e8400-e29b-41d4-a716-446655440000"'],
    ['an npm integrity hash', '"integrity": "sha512-abcDEF123+/xyzABC456defGHI789jklMNO012pqrSTU345vwxYZ=="'],
    ['a sha256 digest',       'checksum: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
    ['normal TypeScript',     'export function computeSomething(input: string): number { return input.length * 42; }'],
    ['a documented env var',  'Set MYSTI_API_KEY in your shell profile before running.'],
    ['a placeholder value',   'api_key: "your-api-key-here"'],
    ['an angle placeholder',  'token = "<YOUR_TOKEN_HERE>"'],
    ['a template var',        'password: "${DB_PASSWORD}"'],
    ['an xxx redaction',      'secret: "xxxxxxxxxxxxxxxx"'],
    ['a file path',           'Credentials live in ~/.aws/credentials on this machine.'],
    ['a long English word',   'Antidisestablishmentarianism appears in the corpus twice.'],
  ];

  for (const [label, text] of benign) {
    it(`does not block: ${label}`, () => {
      const v = scanEgress(text);
      expect(blocksEgress(v), `"${label}" must not block — ${describeEgressVerdict(v)}`).toBe(false);
    });
  }

  it('reports a placeholder assignment as advisory, not blocking', () => {
    const v = scanEgress('api_key: "your-api-key-here"');
    expect(blocksEgress(v)).toBe(false);
    expect(v.suspected.some(f => f.kind === 'assignment')).toBe(true);
  });
});

describe('EgressScanner — entropy is advisory, never blocking', () => {
  it('flags a high-entropy token without blocking on it', () => {
    // A base64-ish blob with no vendor prefix and no assignment context —
    // exactly the shape a minified asset produces.
    const blob = 'aG7Kd9Xm2Qp4Rt6Yv8Zb1Nc3Vf5Hj7Lk9Ws0Ex2Ug4Iy6Oa8Pd';
    const v = scanEgress(`payload = ${blob}`);
    expect(blocksEgress(v)).toBe(false);
    expect(v.suspected.some(f => f.kind === 'high-entropy')).toBe(true);
  });

  it('does not double-report a vendor token as high-entropy', () => {
    const v = scanEgress(j('AKIA', 'IOSFODNN7EXAMPLE'));
    expect(v.findings).toHaveLength(1);
    expect(v.suspected.filter(f => f.kind === 'high-entropy')).toHaveLength(0);
  });

  it('clean means no DEFINITE findings, even when suspicions exist', () => {
    const v = scanEgress('blob = aG7Kd9Xm2Qp4Rt6Yv8Zb1Nc3Vf5Hj7Lk9Ws0Ex2Ug4Iy6Oa8Pd');
    expect(v.suspected.length).toBeGreaterThan(0);
    expect(v.clean).toBe(true);
  });
});

describe('EgressScanner — operational safety', () => {
  it('is stable across repeated scans (global regex lastIndex must not leak)', () => {
    const text = `first ${j('AKIA', 'IOSFODNN7EXAMPLE')} second`;
    const a = scanEgress(text);
    const b = scanEgress(text);
    const c = scanEgress(text);
    expect(a.findings).toHaveLength(1);
    expect(b.findings).toHaveLength(a.findings.length);
    expect(c.findings).toHaveLength(a.findings.length);
    expect(b.findings[0].offset).toBe(a.findings[0].offset);
  });

  it('handles empty and whitespace input', () => {
    expect(scanEgress('').clean).toBe(true);
    expect(scanEgress('   \n\t ').clean).toBe(true);
    expect(scanEgress('').scannedBytes).toBe(0);
  });

  it('reports scanned byte count in UTF-8, not UTF-16 units', () => {
    // "é" is 2 bytes in UTF-8 but one JS string unit.
    expect(scanEgress('é').scannedBytes).toBe(2);
  });

  it('completes quickly on adversarial input (no catastrophic backtracking)', () => {
    const pathological = [
      'a'.repeat(60_000),
      ('api_key: "' + 'x'.repeat(500)).repeat(200),
      ('-----BEGIN ').repeat(5_000),
      ('eyJ' + 'A'.repeat(200) + '.').repeat(500),
      ('sk-' + '-'.repeat(300)).repeat(200),
    ].join('\n');
    const started = Date.now();
    const v = scanEgress(pathological);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(v.scannedBytes).toBeGreaterThan(0);
  }, 10_000);

  it('scales linearly enough for a multi-megabyte payload', () => {
    const big = 'const x = 1; // ordinary source line\n'.repeat(40_000); // ~1.5MB
    const started = Date.now();
    const v = scanEgress(big);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(blocksEgress(v)).toBe(false);
  }, 15_000);

  it('finds a secret buried deep inside a large benign payload', () => {
    const filler = 'const x = 1; // ordinary source line\n'.repeat(20_000);
    const v = scanEgress(`${filler}${j('ghp_', 'z'.repeat(36))}\n${filler}`);
    expect(blocksEgress(v)).toBe(true);
  }, 15_000);
});
