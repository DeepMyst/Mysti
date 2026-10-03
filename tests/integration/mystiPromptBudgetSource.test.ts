import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'providers', 'ChatViewProvider.ts'), 'utf-8');

describe('coordinator prompt budgets (Plan 30 §4.4)', () => {
  it('clamps an MCP tool result before fencing it back', () => {
    expect(SRC).toMatch(/clampHeadTail\(res\.output, 8_000, 4_000/);
  });
});
