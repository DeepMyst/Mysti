import { afterEach, describe, expect, it } from 'vitest';
import { buildProviderManifest } from '../../../src/providers/base/ProviderManifest';
import type { Settings } from '../../../src/types';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { createClineSession } from '../../helpers/sessionFactory';
import { clearConfigurationListeners, clearMockConfig, fireConfigurationChange, getMockConfigUpdates, setMockConfig } from '../../helpers/mockVscode';

const providers: TestableClineProvider[] = [];
const settings = { mode: 'default', accessLevel: 'full-access', provider: 'cline', model: 'chosen/model' } as Settings;
function make(version: string | null) {
  const provider = new TestableClineProvider(); providers.push(provider);
  setVersion(provider, version);
  return provider;
}
function setVersion(provider: TestableClineProvider, version: string | null) {
  (provider as unknown as { _cachedCliVersion: string | null })._cachedCliVersion = version;
}
function entry(provider: TestableClineProvider) { return buildProviderManifest({ getAll: () => [provider] })[0]; }
function wireModel(provider: TestableClineProvider, chosen = settings) {
  const args = provider.buildCliArgs(chosen, createClineSession());
  const index = args.indexOf('--model');
  expect(args.filter(arg => arg === '--model')).toHaveLength(index < 0 ? 0 : 1);
  return index < 0 ? undefined : args[index + 1];
}
afterEach(() => { providers.splice(0).forEach(provider => provider.dispose()); clearMockConfig(); clearConfigurationListeners(); });

describe('Cline model capability matches its versioned request contract', () => {
  it.each([null, 'version unavailable', '2.0.0', 'Cline CLI 3.0.61'])('offers custom IDs for modern or provisionally modern version %s', version => {
    const provider = make(version);
    expect(entry(provider).capabilities.modelSelection).toBe('custom-only');
    expect(entry(provider).capabilities.supportsReadOnly).toBe(false);
    expect(entry(provider).capabilities.planMode).toBe('none');
    expect(entry(provider).customModelSettingKey).toBe('clineModel');
    expect(wireModel(provider)).toBe('chosen/model');
    expect(provider.getEffectiveModelForSettings(settings)).toBe('chosen/model');
    expect(getMockConfigUpdates()).toEqual({});
  });

  it('keeps known legacy models CLI-managed even when stored or routed choices exist', () => {
    const provider = make('1.0.8'); setMockConfig('clineModel', 'stored/model');
    const chosen = { ...settings, routedModel: 'routed/model' };
    expect(entry(provider).capabilities.modelSelection).toBe('none');
    expect(entry(provider).capabilities.supportsReadOnly).toBe(true);
    expect(entry(provider).capabilities.planMode).toBe('detected');
    expect(wireModel(provider, chosen)).toBeUndefined();
    expect(provider.getEffectiveModelForSettings(chosen)).toBeUndefined();
    expect(getMockConfigUpdates()).toEqual({});
  });

  it('sends the acknowledged custom ID, with routed requests taking explicit precedence', () => {
    const provider = make('3.0.61'); setMockConfig('clineModel', 'account/custom-model');
    expect(entry(provider).capabilities.modelSelection).toBe('custom-only');
    expect(wireModel(provider)).toBe('account/custom-model');
    expect(provider.getEffectiveModelForSettings(settings)).toBe('account/custom-model');
    const routed = { ...settings, routedModel: 'routing/override' };
    expect(wireModel(provider, routed)).toBe('routing/override');
    expect(provider.getEffectiveModelForSettings(routed)).toBe('routing/override');
    expect(getMockConfigUpdates()).toEqual({});
  });

  it('rebuilds manifests after an upgrade and downgrade without mutating older snapshots or stored choices', () => {
    const provider = make('1.0.8'); setMockConfig('clineModel', 'kept/custom-model');
    const legacy = entry(provider);
    setVersion(provider, '3.0.61'); const modern = entry(provider);
    expect(modern.capabilities.modelSelection).toBe('custom-only');
    expect(wireModel(provider)).toBe('kept/custom-model');
    setVersion(provider, '1.0.8');
    expect(entry(provider).capabilities.modelSelection).toBe('none');
    expect(wireModel(provider)).toBeUndefined();
    expect(legacy.capabilities.modelSelection).toBe('none');
    expect(modern.capabilities.modelSelection).toBe('custom-only');
    expect(getMockConfigUpdates()).toEqual({});
  });

  it('invalidates the legacy version on path change and uses the same provisional modern branch as argv', () => {
    const provider = make('1.0.8');
    setMockConfig('clinePath', '/fixture/new-cline'); fireConfigurationChange('mysti.clinePath');
    expect(provider.getCachedCliVersion()).toBeNull();
    expect(entry(provider).capabilities.modelSelection).toBe('custom-only');
    expect(wireModel(provider)).toBe('chosen/model');
    expect(getMockConfigUpdates()).toEqual({});
  });
});
