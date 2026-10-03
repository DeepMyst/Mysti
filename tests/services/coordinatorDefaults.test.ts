/**
 * Plan 30 §1 — the coordinator's shipped defaults. The constant and the
 * package.json default are two copies of one list; nothing checked they agree.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { MYSTI_DEFAULT_FREE_MODELS } from '../../src/services/CoordinatorModelClient';

const ROOT = path.join(__dirname, '..', '..');
const props = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).contributes.configuration.properties;
const EXT = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf-8');

describe('coordinator model defaults', () => {
  it('puts Space Bunny Alpha first, then the proven free models', () => {
    expect(MYSTI_DEFAULT_FREE_MODELS).toEqual([
      'openrouter/stealth/space-bunny-alpha',
      'openrouter/openai/gpt-oss-120b:free',
      'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/google/gemma-4-31b-it:free',
    ]);
  });

  it('keeps the package.json default identical to the constant', () => {
    expect(props['mysti.mysti.freeModels'].default).toEqual(MYSTI_DEFAULT_FREE_MODELS);
  });

  it('ships a free-only chain: no paid fallback by default', () => {
    expect(props['mysti.mysti.fallbackModel'].default).toBe('');
    expect(EXT).toContain("cfg.get<string>('mysti.fallbackModel', '')");
  });
});
