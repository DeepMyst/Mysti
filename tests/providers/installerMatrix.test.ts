import { afterAll, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { filterInstallMethodsForOS } from '../../src/utils/platform';
import { installerShell } from '../../src/utils/installerShell';
import { PROVIDER_NPM_PACKAGES } from '../../src/providers/base/ProviderManifest';
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
afterAll(() => registry.dispose());
describe.each(['darwin', 'linux', 'win32'] as const)('installer catalog on %s', platform => {
  for (const provider of registry.getAll()) {
    it(`${provider.id} has an applicable install route and matching shell`, () => {
      const methods = filterInstallMethodsForOS(provider.getInstallMethods?.() ?? [{ command: provider.getInstallCommand(), platform: 'all' as const }], platform);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        expect(method.command.trim()).not.toBe('');
        if (/^https?:/.test(method.command)) {
          expect(new URL(method.command).protocol).toBe('https:');
        } else if (platform === 'win32') {
          expect(method.command).not.toMatch(/\|\s*(?:ba)?sh\b|\$\(uname/);
          if (/\b(?:irm|iex)\b/.test(method.command)) expect(installerShell(method.command, platform)).toBe('powershell.exe');
          else expect(installerShell(method.command, platform)).toBe('cmd.exe');
        } else {
          expect(installerShell(method.command, platform)).toBe('/bin/bash');
          expect(method.command).not.toMatch(/\b(?:irm|iex)\b/);
        }
      }
      if (provider.capabilities.supportsAutoInstall) {
        expect(PROVIDER_NPM_PACKAGES[provider.id]).toBeTruthy();
        expect(methods.some(method => /npm (?:install|i) -g /.test(method.command))).toBe(true);
      }
    });
  }
});
