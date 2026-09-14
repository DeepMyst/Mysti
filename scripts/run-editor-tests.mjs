import config from '../.vscode-test.mjs';
import launcher from './editor-test-launcher.cjs';

try {
  await launcher.launchEditor(config);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
