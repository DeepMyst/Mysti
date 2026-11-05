import { expect, it, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';

it.each(['FailoverError: 401 rejected', '  FailoverError:401 rejected', 'Error: FailoverError: 401 rejected',
  'FallbackSummaryError: All models failed (1): owned/fixture: Provider owned has auth issue (skipping all models) (auth)',
  'Error: FallbackSummaryError: All models failed (1): owned/fixture: Provider owned has auth_permanent issue (skipping all models) (auth_permanent)',
  'FallbackSummaryError: All models failed (2): owned/fixture: Provider owned has auth issue (skipping all models) (auth) | other/model: quota (rate_limit)',
  '[diagnostic] model attempt finished\nFailoverError: 401 rejected\n',
  '[model-fallback/decision] reason=auth\r\nFallbackSummaryError: All models failed (1): owned/fixture: Provider owned has auth issue (skipping all models) (auth)\r\n',
])('classifies native wrapped authentication failure %s', message => {
  const provider = new TestableOpenClawProvider();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((provider as any).handleError(message)).toMatchObject({ type: 'auth_error', content: message,
      authCommand: 'openclaw onboard', providerName: 'OpenClaw' });
  } finally { provider.dispose(); log.mockRestore(); }
});

it.each(['FailoverError: 429 rate limit', 'FailoverError: 500 server failed', 'FailoverError: 4010 unrelated',
  'Read failed at line 401', 'Tool result contains FailoverError: 401', 'Recovered 401 items',
  'FallbackSummaryError: All models failed (1): owned/fixture: Provider owned has billing issue (skipping all models) (billing)',
  'FallbackSummaryError: All models failed (1): owned/fixture: Provider owned has auth issue (skipping all models) (rate_limit)',
  'Tool result contains FallbackSummaryError: All models failed (1): owned/fixture: Provider owned has auth issue (skipping all models) (auth)',
  'Provider owned has auth issue (skipping all models) (auth)',
  'FallbackSummaryError: All models failed (1): owned/fixture: rate limited (rate_limit)',
  '[diagnostic] candidate failed\nFallbackSummaryError: All models failed (1): owned/fixture: quota (rate_limit)\n',
  'FallbackSummaryError: All models failed (1): owned/fixture: rate limited (rate_limit)\nProvider owned has auth issue (skipping all models) (auth)',
])('keeps non-authentication context as a regular error: %s', message => {
  const provider = new TestableOpenClawProvider();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { expect((provider as any).handleError(message)).toMatchObject({ type: 'error', content: message }); }
  finally { provider.dispose(); log.mockRestore(); }
});
