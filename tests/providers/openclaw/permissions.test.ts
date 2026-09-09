import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { ACCESS_LEVELS, OPERATION_MODES } from '../../../src/utils/settingsClamp';
import type { Settings } from '../../../src/types';

describe('OpenClaw requires native approval enforcement', () => {
  let provider: TestableOpenClawProvider;
  beforeEach(() => { provider = new TestableOpenClawProvider(); });
  afterEach(() => provider.dispose());
  it('advertises native approval and configured model selection', () => {
    expect(provider.capabilities.supportsNativeApproval).toBe(true);
    expect(provider.capabilities.modelSelection).toBe('none');
  });
  it.each(OPERATION_MODES.flatMap(mode => ACCESS_LEVELS.map(accessLevel => ({ mode, accessLevel }))))(
    'cannot select a CLI bypass with $mode/$accessLevel', ({ mode, accessLevel }) => {
      const settings: Settings = { provider: 'openclaw', mode, accessLevel, thinkingLevel: 'none', contextMode: 'auto', model: '' };
      expect(() => provider.buildCliArgs(settings, createOpenClawSession())).toThrow('owned native approval runtime');
    },
  );
});
