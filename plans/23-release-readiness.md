# 23 — Release Readiness (v0.5.0)

**Goal:** get the ~110-commit coordinator/canvas/agent-catalog line from a local branch into a release users can install, without shipping a fail-open permission gate.

**Status:** PLAN (2026-08-24). Written after auditing the actual tree, not the changelog.

---

## The reframe: finishing Plan 20 is not what blocks the release

The natural assumption is that the unbuilt pieces (the health dashboard, the `metadata:` migration) are the gap. They are not. Building them changes nothing about whether this can ship.

What actually blocks a release is three things, in this order:

1. **A permission gate that fails OPEN on values the settings UI itself offers.** Verified in the tree today.
2. **None of it has ever been run.** ~110 commits, 9,165 unit tests, and zero live executions.
3. **A 167k-line branch that has never been PR'd, with no CI of any kind.**

Everything else is scheduling.

---

## Part A — Blockers

### B1 — `shouldGateToolUse` falls through to ungated · **CRITICAL**

`shouldGateToolUse` (`src/utils/permissionClassifier.ts`) decides by matching literals, and its final statement is `return false`. Any `mode`/`accessLevel` combination it does not explicitly handle is **not gated**.

Two ways to reach that today:

| Path | Detail |
|---|---|
| **Enum drift (no attacker needed)** | `package.json` declares `mysti.defaultMode` as `['ask-before-edit','edit-automatically','plan']`. But `OperationMode` is `'default' \| 'ask-before-edit' \| 'edit-automatically' \| 'quick-plan' \| 'detailed-plan'`. **`'plan'` is offered in the settings dropdown and is not a value the code handles**; `'default'`, `'quick-plan'` and `'detailed-plan'` are handled but not offered. |
| **Non-enum value** | `mysti.accessLevel` is **window-scoped**, so a cloned repo's `.vscode/settings.json` can set it. VSCode does not enforce a declared enum at read time — `get()` returns whatever the JSON holds. `clampSettingsToUserPolicy` cannot help: `clampOne` early-returns on `!(ws in rank)`, so a *non-enum* workspace value is passed through unclamped rather than rejected. |

**Why the existing mitigation does not cover it.** The code comment says read-only/plan tiers are "enforced by the provider's CLI permission mode", which is true for the 15 CLI backends. It is **not** true for the `@mysti` coordinator: `MystiLocalExec`'s gate closure calls `this._shouldGateToolUse(...)` directly (`ChatViewProvider.ts:7258`) and there is no CLI underneath it. For coordinator write/edit/bash this is a **single-layer** control, and it fails open.

**Fix**
- Make `shouldGateToolUse` fail **closed**: replace the trailing `return false` with an explicit allowlist of the combinations that are genuinely ungated (`full-access` + `edit-automatically`, and the read-only/plan tiers), and `return true` for anything unrecognized.
- Normalize settings at the boundary: coerce `accessLevel`/`mode` to known enum members on read, falling back to the most restrictive value, and log once when coercion fires.
- Extend `clampOne` so a non-enum workspace value clamps to the user floor instead of passing through.
- Fix the `mysti.defaultMode` enum in `package.json` to match `OperationMode` exactly, and add a test asserting the declared enums equal the TS unions (this class of drift should not be able to recur silently).

**Accept:** a table-driven test over the full cross-product of `mode` × `accessLevel` — including junk values — asserts every unrecognized combination gates. A test asserts `package.json` enums match the type unions.

### B2 — Model output is rendered as unsanitized HTML · **HIGH**

Three `marked.parse` call sites; **no DOMPurify anywhere in the repo**. The only defense is the webview CSP. Model and tool output is attacker-influenceable (a poisoned repo file, an MCP result, a fetched page), so this is a UI-spoofing and content-injection surface in the one place the user makes trust decisions — the permission cards.

**Fix:** add DOMPurify (bundled locally, no CDN), sanitize at every `marked.parse` site, and tighten CSP `img-src`/`connect-src` to local schemes. This also closes the Plan 20 Phase 0 leftover (remote images / remote Mermaid refs).

**Accept:** a test feeds `<img src=x onerror=…>`, an `<iframe>`, and a `javascript:` href through the render path and asserts they are neutralized.

### B3 — Nothing has ever been run · **BLOCKER**

Not a bug, an absence of evidence. The 9,165 tests are unit-level; the classes of failure they structurally cannot reach are exactly where this code is new.

**Smoke matrix (F5 Extension Development Host, one session each):**

| # | Path | Watch for |
|---|---|---|
| 1 | Coordinator basic turn (`@mysti`, read tools) | streaming, nonce fencing, tool cards |
| 2 | **Plan 19 native tool-calling loop** | never smoke-tested — flagged as needing this since July |
| 3 | **Plan 19 MCP path** (live DeepMyst account) | same |
| 4 | Plan 20 `skill_find` / `skill_view` | index builds, results fenced, containment holds |
| 5 | Publish ladder end to end | **both** cards render; card 1 shows script bytes *before* anything runs |
| 6 | `skillrun` | args file survives the new read-only `.mysti` sandbox rule on real Seatbelt |
| 7 | Review queue + kill switch | quarantine moves rather than deletes |
| 8 | Windows / no-sandbox host | capability tier absent, not erroring |

**Accept:** each row passes or files a bug. Row 6 is the one I most expect to fail.

### B4 — No CI · **BLOCKER for a reviewable merge**

There is no `.github/workflows` at all. A 167k-line PR with no automated verification is not reviewable, and the merge gate would be one person's word.

**Fix:** a minimal workflow — `tsc --noEmit`, `vitest run`, and `node scripts/generate-core-agent-manifest.js --check`. Deliberately **not** `eslint` yet (86 pre-existing errors would make it red on day one and train everyone to ignore it).

**Accept:** green on a trivial PR before the big one opens.

### B5 — The branch has to land · **DECISION**

`main` is frozen at v0.4.0 (2026-03-11) plus 3 small commits. `feature/visual-testing` is the de-facto mainline: 95 commits, 514 files, +167k lines, never PR'd, and **16 of those commits exist only on this machine**. Plan 20 adds ~11 more on top.

Verified: `main` merges into it **cleanly**, `tsc` clean, full suite green (the 3 main-only commits touch `MemoryManager`/`ChannelBridge`, which the branch never touched).

**Recommendation: land it whole; do not retroactively split.** Re-deriving five months of interleaved work into stacked branches means re-resolving conflicts repeatedly, and the tests only pass on the integrated whole — manufacturing real risk to make review easier for work that has already been through adversarial passes.

**Sequence:** push the 16 local commits first (they exist nowhere else) → merge `main` in → open the PR → review **by commit**, not by diff → merge with a **merge commit, not a squash** (squashing destroys the audit trail on the RCE fix, Plan 18's hardening waves, and Plan 19's seven adversarial rounds).

---

## Part B — Release posture for Plan 20

The evidence does not support switching this on. SkillsBench measured *self-generated* skills at **+0.0pp**, and the go/no-go instrument has not reported.

| Tier | v0.5.0 posture |
|---|---|
| Retrieval (`skills: prose`) | **Off by default.** Documented as opt-in; the release notes point at `mysti.skillReport`. |
| Authoring/execution (`skills: full`) | **Experimental.** Off, machine-scoped, behind three further gates. Release notes say plainly that the ladder proves conformance and host-observed corroboration, **not correctness**. |
| T3 background auto-proposal | Not shipped. |

The honest framing for the changelog: *"the coordinator can now find and read the project's reusable practices; authoring them is experimental and gated."*

---

## Part C — The unbuilt pieces (explicitly NOT blockers)

| Piece | Call |
|---|---|
| **Phase 6 health dashboard** | Build it — small, and it is what makes the ledger legible. `CapabilityLedger.health()` is already tested; this is a rendering surface plus a command. Fold it into `mysti.skillReport` rather than adding a second report. |
| **Phase 7 `metadata:` migration** | **Defer.** Needs nested-object support in the flat frontmatter parser, plus migrating all 42 bundled files and the loader, for a claude.ai-upload benefit that is speculative here. Revisit only if someone actually wants to export skills. |
| **`ApprovedCapabilityStore` for prose artifacts** | **Drop as a gate; keep as detection.** Non-core content is already fenced, so blocking its load buys less than it costs in re-approval friction. Surface "changed since first seen" in the review queue instead. |
| **MCP rug-pull pinning** | Build with the dashboard — it needs the same durable-approval surface. |

---

## Part D — Sequence

```
Gate 1  B1 + B2                      security fixes, with tests        ← nothing ships before this
Gate 2  B4                           CI green on a trivial PR
Gate 3  B3                           smoke matrix; fix what it finds
Gate 4  B5                           push, merge main in, PR, merge
Gate 5  dashboard + rug-pull pin     the worthwhile unbuilt pieces
Gate 6  CHANGELOG, version, package  vsce, marketplace
```

Gates 1–4 are the release. Gate 5 is polish that can slip to v0.5.1 without anyone noticing.

---

## Part E — Out of scope for v0.5.0

1. The 86 pre-existing lint errors. Worth doing, not worth blocking on; add `eslint` to CI only once it is green.
2. Splitting `ChatViewProvider` (now ~11k lines). A known problem and a separate plan.
3. The `metadata:` frontmatter migration (Part C).
4. Acting on the go/no-go — it needs ~4 weeks of real use *after* release.

---

## Appendix — audit notes

Findings verified directly against the tree on 2026-08-24, not inherited from earlier notes:

- `classifyToolAction` **is** fail-closed now (unknown → `bash-command`). An older note claiming otherwise is stale; the fail-open is one level up, in `shouldGateToolUse`.
- `clampOne` handles ordinal enums only and skips non-enum workspace values — it is not a defense against B1.
- `"scope": "machine"` is the real enforcement for the `mysti.mysti.*` booleans; the clamp is not, and should not be extended to them.
- No DOMPurify is present anywhere in the repo.
- The Plan 20 publish ladder does **not** execute a trial. An earlier comment claimed a "determinism smoke test" that was never implemented; corrected in `a00579e`.
