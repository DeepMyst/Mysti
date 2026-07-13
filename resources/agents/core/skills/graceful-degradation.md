---
id: graceful-degradation
name: Graceful Degradation
description: Designs code that survives failures — fallbacks, partial results, and clear degraded-state behavior
icon: gear
category: reliability
activationTriggers:
  - error handling
  - fallback
  - graceful degradation
  - resilient
  - fault tolerance
  - edge case
  - retry
  - timeout
  - circuit breaker
---

## Instructions

Write every code path assuming its dependencies can fail: networks drop, files vanish, inputs arrive malformed, and services time out. Catch failures at the boundary where you can still do something useful — return a fallback, a cached value, or a clearly degraded partial result — and never let one failing component take down the whole system. Log every failure with enough context to diagnose it, surface actionable messages to users, and make the degraded state explicit rather than silent.

## Behavioral Guidelines

- Enumerate failure modes before writing the happy path: unavailable dependency, timeout, malformed input, empty result, partial success
- Handle errors at the boundary that has a meaningful recovery option — do not catch where you can only rethrow or swallow
- Prefer degraded-but-working over all-or-nothing: serve stale cache, reduced features, or partial data, and label it as degraded
- Never swallow exceptions silently — every catch either recovers with a fallback, or logs with context (operation, inputs, cause) and propagates
- Set explicit timeouts on all external calls; add bounded retries with backoff only for transient, idempotent operations
- Use circuit breakers or health flags around repeatedly failing dependencies so retries do not amplify an outage
- Fail fast on unrecoverable states (bad config, missing credentials) with a clear startup error instead of limping into undefined behavior
- Keep user-facing error messages actionable (what failed, what to try) while keeping stack traces and internals in the logs

## Error Handling Patterns

```typescript
// Fallback to a degraded source, with the degradation logged and visible
async function fetchUserData(userId: string): Promise<UserData> {
  try {
    return await withTimeout(api.getUser(userId), 5000);
  } catch (error) {
    logger.warn('user API unavailable, serving cached copy', { userId, error });
    const cached = await cache.getUser(userId);
    if (cached) return { ...cached, stale: true };
    throw new UserFacingError('Profile is temporarily unavailable. Please retry shortly.');
  }
}

// Fail fast on unrecoverable configuration — no silent limp mode
if (!config.apiKey) {
  throw new StartupError('API key missing: set SERVICE_API_KEY before starting.');
}
```

## Checklist

- [ ] Every external call (network, disk, subprocess) has explicit error handling and a timeout
- [ ] Each dependency has a defined fallback, or a deliberate fail-fast decision documented
- [ ] No empty or silent catch blocks — every failure is logged with operation context
- [ ] Degraded states are explicit (flags, labels, warnings), not silently faked as success
- [ ] Retries are bounded, backed off, and limited to transient idempotent operations
- [ ] Users see actionable error messages; internals stay in logs
