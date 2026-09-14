import * as QUnit from 'qunit';

/** Node assert throws are reported by QUnit; the completion assertion also detects a stalled body. */
export function test(name: string, body: () => void | Promise<void>): void {
  QUnit.test(name, async result => {
    await body();
    result.ok(true, 'All acceptance assertions completed');
  });
}

export function timeout(hooks: NestedHooks, milliseconds: number): void {
  hooks.before(result => result.timeout(milliseconds));
  hooks.beforeEach(result => result.timeout(milliseconds));
}
