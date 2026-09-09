/** Actual module reevaluation and service ownership; no native model or external connection. */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const project = path.resolve(__dirname, '../../..');
const fixture = path.join(project, 'tests/fixtures/openclaw/policyRuntimeStateAgent.mjs');

describe('OpenClaw policy runtime singleton ownership', () => {
  it.each([
    ['identity', 3], ['services', 4], ['stop-startup', 1], ['failed-startup', 1],
  ] as const)('preserves %s ownership across repeated module registration', async (mode, caseCount) => {
    const { stdout } = await execute(process.execPath, [fixture, mode], {
      cwd: project, timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.mode).toBe(mode);
    expect(result.cases).toHaveLength(caseCount);
  });
});
