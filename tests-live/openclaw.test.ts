import { expect, it } from 'vitest';
import { TestableOpenClawProvider } from '../tests/helpers/providerFactory';
import type { OpenClawGateway } from '../src/providers/openclaw/OpenClawGateway';
it('installed OpenClaw gateway authenticates and completes a scoped no-tool stream', async () => {
  const provider = new TestableOpenClawProvider();
  const gateway = (provider as unknown as { _gateway: OpenClawGateway })._gateway;
  try {
    expect(await gateway.connect()).toBe(true);
    let text = '';
    for await (const chunk of gateway.sendAgentMessage('Do not use any tools. Reply exactly MYSTI_GATEWAY_OK.', {
      sessionKey: `mysti-review-${Date.now()}`, thinking: 'off',
    })) {
      expect(chunk.type, chunk.type === 'error' ? chunk.content : '').not.toBe('error');
      if (chunk.type === 'text') { text += chunk.content; }
    }
    expect(text).toContain('MYSTI_GATEWAY_OK');
  } finally { provider.dispose(); }
}, 90_000);
