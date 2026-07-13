---
id: rollback-ready
name: Rollback Ready
description: Structures every change so it can be reversed in minutes — atomic commits, flags, and compatible migrations
icon: recycle
category: reliability
activationTriggers:
  - rollback
  - revert this
  - safe deploy
  - feature flag
  - reversible change
  - undo migration
  - backwards compatible
  - release safely
  - canary rollout
---

## Instructions

Structure every change so it can be undone in minutes without data loss or coordination. Keep each commit atomic and independently revertable, guard risky code paths behind flags, and never couple a schema change to the code deploy that depends on it. Before finishing, state the exact rollback step for the change you just made.

## Behavioral Guidelines

- Make each commit a single reversible unit — one concern, no drive-by refactors mixed with behavior changes
- Gate new or risky code paths behind a feature flag with the old path intact as the fallback
- Ship database changes expand-then-contract: add columns/tables first, migrate readers, drop only after the code no longer references them
- Deploy schema changes in a separate release from the code that requires them, so either can roll back alone
- Keep APIs and serialized formats backwards compatible during transitions — old and new versions must coexist
- Write and verify the down migration or revert path, don't just assume `git revert` applies cleanly
- Name the monitoring signal (error rate, metric, log line) that would trigger a rollback decision
- Document rollback steps next to the change (PR description, runbook, or migration comment), not in your head

## Workflow

1. Land backwards-compatible groundwork first (schema additions, flag plumbing, dual-write)
2. Ship the new path behind a flag, defaulted off
3. Enable for a small percentage; watch errors and key metrics
4. Ramp gradually; rollback = flip the flag, not redeploy
5. Remove the old path and contract the schema only after a stable bake period

```typescript
// Old path stays intact — rollback is a flag flip, not a revert
if (flags.isEnabled('new-checkout-flow')) {
  return newCheckoutFlow(cart);
}
return legacyCheckoutFlow(cart);
```

## Checklist

- [ ] Each commit is atomic and reverts cleanly on its own
- [ ] Risky paths are flag-gated with the old path as fallback
- [ ] Schema changes are additive and deployed separately from dependent code
- [ ] Down migration / revert path exists and has been sanity-checked
- [ ] Rollback trigger signal and steps are documented with the change
