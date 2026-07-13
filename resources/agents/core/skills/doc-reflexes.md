---
id: doc-reflexes
name: Doc Reflexes
description: Documents the "why" behind non-obvious decisions, API changes, and setup steps as you code
icon: notes
category: documentation
activationTriggers:
  - document this
  - add comments
  - update the readme
  - write docs
  - explain why
  - jsdoc
  - docstring
  - changelog
  - api docs
---

## Instructions

Document non-obvious decisions, API contracts, and setup requirements as a reflex — in the same change, not as a follow-up. Capture the "why" (constraints, trade-offs, rejected alternatives), never restate what the code already says. When behavior, configuration, or public interfaces change, update every doc that describes them in the same edit.

## Behavioral Guidelines

- Explain intent and trade-offs, not mechanics; delete comments that merely paraphrase the code
- Add doc comments (JSDoc, docstrings, or the language's idiom) to every public API you create or change, including parameters, return values, and thrown errors
- Update the README whenever setup, configuration, environment variables, or run commands change
- Include a minimal runnable example wherever usage is not self-evident
- Flag breaking changes explicitly: what broke, why, and the migration path
- Record known limitations, workarounds, and surprising performance or security characteristics where a future reader will hit them
- Keep documentation next to the code it describes; prefer a doc comment over a distant wiki page
- Treat stale docs as bugs — fix those that describe the behavior you are changing; flag other stale docs you notice as follow-ups

## What to Document

- Non-obvious design decisions and rejected alternatives
- API contracts, invariants, and breaking changes
- Setup, configuration, and environment requirements
- Known limitations, workarounds, and failure modes
- Performance characteristics and security considerations

## Example

```typescript
/**
 * Retries a failed operation with exponential backoff.
 *
 * @remarks
 * Adds jitter to prevent thundering herd in distributed callers.
 * Delay is capped at 30s so a stuck dependency cannot block indefinitely.
 *
 * @param operation - Async function to retry
 * @param maxRetries - Maximum retry attempts (default: 3)
 * @returns Result of the first successful attempt
 * @throws The last error once all retries are exhausted
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3
): Promise<T>
```

## Checklist

- [ ] Every new or changed public API has a doc comment covering params, returns, and errors
- [ ] Non-obvious decisions carry a "why" comment with the constraint or trade-off
- [ ] README updated for any change to setup, configuration, or commands
- [ ] Breaking changes are called out with a migration path
- [ ] No comment merely restates the code; stale docs touched by this change are fixed or removed
