import { expect, it } from 'vitest';
import { openClawBackendRedactor } from '../../../src/providers/openclaw/OpenClawBackendDiagnostics';

const key = 'owned-backend-key-🔑-private';
const config = (apiKey: unknown) => ({ models: { providers: { owned: { apiKey } } } });
it.each([
  ['literal', key, {}],
  ['dollar reference', '$OWNED_BACKEND', { OWNED_BACKEND: key }],
  ['interpolated reference', '${OWNED_BACKEND}', { OWNED_BACKEND: key }],
  ['native environment marker', 'OPENAI_API_KEY', { OPENAI_API_KEY: key }],
  ['object reference', { source: 'env', id: 'OWNED_BACKEND' }, { OWNED_BACKEND: key }],
  ['secretref marker', 'secretref-env:OWNED_BACKEND', { OWNED_BACKEND: key }],
  ['internal marker', '__env__:OWNED_BACKEND', { OWNED_BACKEND: key }],
] as const)('redacts a %s backend credential and its native/encoded form', (_name, value, env) => {
  const redact = openClawBackendRedactor(config(value), env);
  for (const secret of [key, key.replace(/[^\x20-\x7e\xa0-\xff]/g, ''), encodeURIComponent(key)]) {
    expect(redact(`Backend rejected ${secret}`)).toBe('Backend rejected [REDACTED]');
  }
});

it('snapshots configured and environment values before rotation', () => {
  const cfg = config(key), env = { OWNED_API_KEY: 'owned-old-environment-key' };
  const redact = openClawBackendRedactor(cfg, env);
  cfg.models.providers.owned.apiKey = 'owned-new-key'; env.OWNED_API_KEY = 'owned-new-environment-key';
  expect(redact(`Failure ${key}; owned-old-environment-key`)).toBe('Failure [REDACTED]; [REDACTED]');
});

it('covers credential headers and URL credentials without hiding unrelated diagnostic context', () => {
  const redact = openClawBackendRedactor({ models: { providers: { owned: {
    headers: { Authorization: 'Bearer owned-header-secret', 'X-API-Key': 'owned-custom-secret', 'User-Agent': 'owned-public-version' },
    baseUrl: 'https://owned-user:owned-password@example.invalid/v1?api_key=owned-query-secret&model=fixture',
  } } } }, {});
  expect(redact('owned-header-secret owned-custom-secret owned-user owned-password owned-query-secret owned-public-version fixture'))
    .toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] owned-public-version fixture');
});

it.each([undefined, null, [], 'invalid', { models: null }, { models: { providers: [] } }])('keeps environment redaction with unavailable configuration %j', cfg => {
  expect(openClawBackendRedactor(cfg, { OPENAI_API_KEY: key })(`Rejected ${key}`)).toBe('Rejected [REDACTED]');
});

it('does not resolve file/exec references or treat their paths as credential values', () => {
  for (const source of ['file', 'exec']) {
    expect(openClawBackendRedactor(config({ source, id: '/owned/must-not-run' }), {})('Failed /owned/must-not-run'))
      .toBe('Failed /owned/must-not-run');
  }
});

it('honors env reference allowlists and captures short explicit credentials', () => {
  const cfg = { ...config({ source: 'env', provider: 'restricted', id: 'OWNED_VALUE' }), secrets: { providers: { restricted: { source: 'env', allowlist: [] } } } };
  expect(openClawBackendRedactor(cfg, { OWNED_VALUE: key })(key)).toBe(key);
  expect(openClawBackendRedactor(config('abc'), {})('Rejected abc')).toBe('Rejected [REDACTED]');
});
