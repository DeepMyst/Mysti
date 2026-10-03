/**
 * Plan 23 B1 — the settings UI must never offer a value the code cannot handle.
 *
 * This is the guard for the bug rather than the bug itself. `package.json`
 * declared `mysti.defaultMode` as `['ask-before-edit','edit-automatically',
 * 'plan']` while `OperationMode` was `'default' | 'ask-before-edit' |
 * 'edit-automatically' | 'quick-plan' | 'detailed-plan'`. `"plan"` was
 * selectable in the settings dropdown and matched no branch of
 * `shouldGateToolUse`, and three real modes were not offered at all.
 *
 * Nothing failed loudly, because VSCode does not validate a declared enum at
 * read time and `config.get(...) as any` casts whatever is there. A drift like
 * that can only be caught by comparing the two lists directly.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { ACCESS_LEVELS, OPERATION_MODES } from '../../src/utils/settingsClamp';

const ROOT = path.resolve(__dirname, '..', '..');

function declaredEnum(key: string): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cfg = pkg.contributes.configuration;
  const props: Record<string, { enum?: string[]; default?: unknown; enumDescriptions?: string[] }> =
    Array.isArray(cfg)
      ? Object.assign({}, ...cfg.map((c: { properties: object }) => c.properties))
      : cfg.properties;
  const prop = props[key];
  expect(prop, `${key} must be declared in package.json`).toBeDefined();
  expect(prop.enum, `${key} must declare an enum`).toBeDefined();
  return prop.enum!;
}

function declaredDefault(key: string): unknown {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cfg = pkg.contributes.configuration;
  const props: Record<string, { default?: unknown }> = Array.isArray(cfg)
    ? Object.assign({}, ...cfg.map((c: { properties: object }) => c.properties))
    : cfg.properties;
  return props[key]?.default;
}

describe('declared setting enums match the runtime membership lists', () => {
  it('mysti.accessLevel', () => {
    expect([...declaredEnum('mysti.accessLevel')].sort()).toEqual([...ACCESS_LEVELS].sort());
  });

  it('mysti.defaultMode', () => {
    expect([...declaredEnum('mysti.defaultMode')].sort()).toEqual([...OPERATION_MODES].sort());
  });

  it('every declared default is itself a member of its enum', () => {
    // A default outside the enum is the same failure with an even shorter path
    // to it: no user action required at all.
    for (const key of ['mysti.accessLevel', 'mysti.defaultMode']) {
      expect(declaredEnum(key), `${key} default must be in its own enum`).toContain(declaredDefault(key));
    }
  });

  it('enumDescriptions, when present, line up one-to-one with the enum', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const cfg = pkg.contributes.configuration;
    const props: Record<string, { enum?: string[]; enumDescriptions?: string[] }> = Array.isArray(cfg)
      ? Object.assign({}, ...cfg.map((c: { properties: object }) => c.properties))
      : cfg.properties;
    for (const [key, prop] of Object.entries(props)) {
      if (!prop.enum || !prop.enumDescriptions) { continue; }
      expect(prop.enumDescriptions.length, `${key} description count`).toBe(prop.enum.length);
    }
  });
});

describe('the runtime lists match the TypeScript unions', () => {
  it('reads the unions out of types.ts and compares', () => {
    // Deliberately parsed from source rather than restated here: a copy in the
    // test would drift alongside the code it is supposed to police.
    const types = fs.readFileSync(path.join(ROOT, 'src', 'types.ts'), 'utf8');

    const parse = (name: string): string[] => {
      const m = new RegExp(`export type ${name} =([^;]+);`).exec(types);
      expect(m, `${name} must be a string-literal union in types.ts`).toBeTruthy();
      return (m![1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
    };

    expect(parse('AccessLevel').sort()).toEqual([...ACCESS_LEVELS].sort());
    expect(parse('OperationMode').sort()).toEqual([...OPERATION_MODES].sort());
  });
});
