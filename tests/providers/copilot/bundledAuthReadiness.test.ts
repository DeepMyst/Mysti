import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { runInNewContext } from 'vm';
import type { Configuration } from 'webpack';
import * as vscode from '../../helpers/mockVscode';

const requireLocal = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = requireLocal('webpack') as typeof import('webpack');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-bundled-copilot-auth-'));
let Provider: new (context: unknown) => { checkAuthentication(): Promise<{ authenticated: boolean; error?: string }>; dispose(): void };

beforeAll(async () => {
  // Reuse the production resolver and loaders: a source-only test misses the
  // different JSON5 exports chosen by webpack's module-field resolution.
  const base = requireLocal(path.join(process.cwd(), 'webpack.config.js'))[0] as Configuration;
  const config: Configuration = {
    ...base, mode: 'production', devtool: false,
    entry: path.join(process.cwd(), 'src/providers/copilot/CopilotProvider.ts'),
    output: { ...base.output, path: directory, filename: 'provider.cjs' },
    module: { ...base.module, rules: base.module!.rules!.map(rule => {
      if (!rule || typeof rule !== 'object' || !Array.isArray(rule.use)) { return rule; }
      return { ...rule, use: rule.use.map(loader => typeof loader === 'object'
        ? { ...loader, options: { ...(loader.options as object), transpileOnly: true } } : loader) };
    }) },
  };
  await new Promise<void>((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => compiler.close(closeError => {
      if (error || closeError || stats?.hasErrors()) reject(error || closeError || new Error(stats?.toString({ all: false, errors: true })));
      else resolve();
    }));
  });
  const module = { exports: {} as { CopilotProvider: typeof Provider } };
  runInNewContext(fs.readFileSync(path.join(directory, 'provider.cjs'), 'utf8'), {
    module, exports: module.exports, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id: string) => id === 'vscode' ? vscode : requireLocal(id),
  });
  Provider = module.exports.CopilotProvider;
}, 60_000);

afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

it('recognizes a commented current login in the production bundle', async () => {
  const home = path.join(directory, 'home'); fs.mkdirSync(home);
  vi.stubEnv('COPILOT_HOME', home); vi.stubEnv('GH_TOKEN', ''); vi.stubEnv('GITHUB_TOKEN', '');
  fs.writeFileSync(path.join(home, 'config.json'), '// Owned fixture\n{"lastLoggedInUser":{"login":"bundled-user"},}');
  const provider = new Provider({ subscriptions: [] });
  try {
    expect(await provider.checkAuthentication()).toMatchObject({ authenticated: true });
    fs.writeFileSync(path.join(home, 'config.json'), '// Not logged in\n{"askedSetupTerminals":true}');
    expect(await provider.checkAuthentication()).toMatchObject({ authenticated: false });
  } finally { provider.dispose(); }
});
