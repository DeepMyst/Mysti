import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { readOpenClawToken } from '../../../src/utils/platform';
vi.mock('fs', async original => ({ ...await original<typeof import('fs')>(), existsSync: vi.fn(), readFileSync: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
describe('OpenClaw JSON5 token configuration', () => {
  it('preserves URL strings, single quotes, comments and trailing commas', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`{ // local config\n gateway: { auth: { token: 'fixture-token', }, }, endpoint: 'https://example.invalid/v1', }`);
    expect(readOpenClawToken()).toBe('fixture-token');
  });
});
