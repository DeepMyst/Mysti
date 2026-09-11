import { expect, it, vi } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';

it('does not execute an unisolated native discovery process for BYOK models', async () => {
  const provider = new TestableCopilotProvider();
  const run = vi.fn(async () => 'untrusted CLI output');
  (provider as unknown as { _runCliForDiscovery: unknown })._runCliForDiscovery = run;
  expect(await provider.discoverModels(5000)).toBeNull();
  expect(run).not.toHaveBeenCalled();
});
