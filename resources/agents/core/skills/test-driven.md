---
id: test-driven
name: Test-Driven
description: Drives every change with tests — write the failing test first, then make it pass
icon: lab
category: quality
activationTriggers:
  - tdd
  - write tests
  - add tests
  - unit test
  - integration test
  - test coverage
  - failing test
  - regression test
  - test first
---

## Instructions

Treat tests as the definition of done: no behavior change ships without a test that proves it. Before implementing, write or identify a failing test that captures the requirement; then write the minimal code to make it pass, and refactor with tests green. When fixing a bug, first reproduce it with a failing test so the fix is verifiable and the regression is locked out. Run the relevant test suite before declaring any task complete and report the results.

## Behavioral Guidelines

- Write the failing test before the implementation whenever feasible; if code came first, add the test in the same change — never defer it.
- Mirror the project's existing test framework, file layout, and naming conventions instead of introducing new ones.
- Test observable behavior through public interfaces, not private internals — tests should survive refactors.
- Cover the unhappy paths: invalid input, empty/boundary values, error propagation, and concurrency or ordering hazards where relevant.
- Keep each test focused on one behavior with a name that states the expectation, so a failure reads as a spec violation.
- Prefer fast, isolated unit tests for logic; reserve integration tests for wiring, I/O, and cross-module workflows.
- Stub or fake external dependencies (network, clock, filesystem) so tests are deterministic and runnable anywhere.
- When changing existing behavior, update the affected tests deliberately — a deleted or loosened assertion needs a stated reason.

## Workflow

1. **Red** — write a test expressing the desired behavior; run it and confirm it fails for the expected reason.
2. **Green** — write the minimal implementation that makes it pass; resist speculative generality.
3. **Refactor** — clean up code and tests while the suite stays green; commit in small, verified steps.

## Test Structure

```typescript
describe('UserService.createUser', () => {
  it('creates a user from valid input', async () => {
    const user = await service.createUser(validData);
    expect(user.id).toBeDefined();
  });

  it('rejects a duplicate email', async () => {
    await service.createUser(validData);
    await expect(service.createUser(validData))
      .rejects.toThrow('Email already exists');
  });
});
```

## Checklist

- [ ] Every new or changed behavior has a corresponding test
- [ ] Bug fixes include a test that failed before the fix
- [ ] Edge cases and error paths are asserted, not just the happy path
- [ ] Tests are deterministic — no reliance on real time, network, or run order
- [ ] The relevant test suite was run and passes locally
- [ ] No assertions were weakened or removed without an explicit reason
