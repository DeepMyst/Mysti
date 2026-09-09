## What this changes

<!-- One paragraph. What is different after this merges, and why. -->

## Gates

Run these locally before requesting review. Report any unavailable environment
or skipped browser tests; fix failures rather than retrying until green.

- [ ] `npm run typecheck` — clean (exit 0)
- [ ] `npm test` — green, with Chromium installed for browser coverage
- [ ] `npm run lint` — zero errors
- [ ] `npm run compile:release` — both production bundles build
- [ ] `npm run package && node scripts/check-package-shape.js <the .vsix>` —
      all assertions pass (for changes affecting the packaged extension)
- [ ] `node scripts/generate-core-agent-manifest.js --check` — passes, and I did
      not get there by re-running the generator in write mode. If you changed a
      file under `resources/agents/core/`, re-signing is correct and expected;
      say so below.

## Trust boundaries

**A second reviewer is required here even when time is short** if this PR
touches any of:

- [ ] the permission gate (`src/utils/permissionClassifier.ts`,
      `src/utils/toolNames.ts`)
- [ ] the fencing helpers — anything that nonce-redacts or UNTRUSTED-fences a
      result before it re-enters the coordinator
- [ ] `src/utils/settingsClamp.ts`, or any setting's `scope`
- [ ] the agent trust root (`src/managers/agentMarkdown.ts`,
      `src/managers/AgentLoader.ts`, `resources/agents/core/`,
      `src/generated/coreAgentManifest.ts`)

These are the places where a change that reads as a simplification is a change
in authority. The reviewer is not checking style; they are checking that
nothing here fails open, that no default-off gate became default-on, and that
no setting scope widened.

If you ticked any box above, say in one sentence what the authority change is —
or write "none" and mean it:

> 

## Verification

<!--
How you know this works, beyond "tests pass". Name the test you added and what
it would have caught. If the change is not testable in the vitest harness (real
process trees, real Windows, a live CLI), say so and say what you did instead.
-->
