# 23 — Smoke checklist (Gate 3)

**Why this exists:** ~112 commits and **zero live executions**. The 9,215 unit tests are all unit-level; the failures they structurally cannot reach are exactly where this code is newest — webview rendering, real permission cards, a real OS sandbox, a real DeepMyst account.

**How to run:** press `F5` in VSCode to launch the Extension Development Host, then work through the rows in order. Filter the Debug Console with `[Mysti]`. Each row says what to do, what should happen, and **what failure looks like** — so a wrong result is recognizable rather than merely disappointing.

Rows 1–3 need no new settings. Rows 4–8 each turn one thing on.

---

## 1 · Coordinator basic turn — does any of this run at all?

**Setup:** provider `mysti`. **Do:** ask `@mysti what does src/extension.ts do?`

- [ ] Text streams token by token, not in one lump at the end
- [ ] A `read` tool card appears and completes
- [ ] The answer references real file content

**Failure looks like:** nothing streams (client/model wiring), or the model narrates reading a file with no card (the directive never parsed — check the nonce in the Debug Console).

> Everything below assumes this row passes. If it does not, stop: nothing else is meaningful.

---

## 2 · Native tool-calling loop — *never smoke-tested, flagged since July*

**Setup:** pin a capable model in `mysti.mysti.coordinatorModel` (e.g. `claude-haiku-4-5`).
**Do:** the same question as row 1.

- [ ] Tools still execute and cards still render
- [ ] Console shows tool_calls being accumulated, not text directives
- [ ] Falling back: clear the pin, re-ask — the text protocol still works

**Failure looks like:** the model emits JSON as visible prose (schemas not sent), or tools fire twice (both encodings dispatching).

---

## 3 · MCP path — *also never smoke-tested*

**Setup:** signed-in DeepMyst account, `mysti.mysti.mcpTools: on`, at least one connected service.
**Do:** ask `@mysti` to do something needing that service.

- [ ] A **forced** approval card appears with the full arguments visible
- [ ] Denying it stops the call
- [ ] The tool is called with **correct argument names** — this is the Phase 5 fix; if it invents names, the schema is not reaching the model
- [ ] Approve, then re-run: no drift warning on the second call

**Bonus (rug-pull):** if you can edit a connected tool's description server-side, do so and re-run — the card should show *previously / now* side by side.

---

## 4 · Agent catalog retrieval

**Setup:** `mysti.mysti.skills: prose`. **Do:** `@mysti I'm about to add a feature — any conventions I should follow?`

- [ ] A `skill` card appears; results are wrapped in an UNTRUSTED block
- [ ] `Mysti: Agent Catalog Report` opens and says **"Not enough data to decide"** (correct at low run counts — a verdict here would be the bug)
- [ ] With the setting `off`, `<skill:…>` is *not recognized* — it should appear as visible text, not error

**Failure looks like:** the catalog is injected wholesale into the prompt (check the header is a category line, not a list of names).

---

## 5 · Publish ladder — the ordering is the whole point

**Setup:** `mysti.mysti.skills: full`, `mysti.mysti.localExecution: on`, trusted workspace, macOS/Linux-with-bwrap.
**Do:** ask `@mysti` to package a repeated procedure as a capability.

- [ ] **Card 1 shows the full script bytes** — read them; this is the control
- [ ] **Card 1 appears BEFORE anything executes.** If any script output appears first, stop and report it — that is the RCE-shaped ordering the ladder exists to prevent
- [ ] Card 2 states the evidence, and says plainly it does **not** prove correctness
- [ ] Denying either card leaves nothing registered
- [ ] A manifest listing commands never actually run → card says **"NEVER OBSERVED SUCCEEDING"**

---

## 6 · `skillrun` — ⚠︎ the row most likely to fail

The read-only `.mysti` sandbox rule and the args-file path were written in the same session and **have never run together**. The args file is written by the host *outside* the sandbox and only read inside it, so it should work — but that is reasoning, not evidence.

**Do:** invoke the capability published in row 5.

- [ ] An approval card appears showing the resolved argument values
- [ ] The script runs and returns output
- [ ] **No "permission denied" reading the args file** ← the predicted failure
- [ ] `.mysti/run/*.json` is cleaned up afterwards
- [ ] Pass a shell metacharacter (`'; echo pwned #`) as an argument — it must arrive as **literal data**

**If it fails:** the fix is to move the args directory outside `.mysti/` (e.g. `globalStorage`), not to loosen the sandbox rule.

---

## 7 · Review queue and kill switch

- [ ] `Mysti: Review Agent Proposals` lists staged artifacts and opens the file before asking
- [ ] Installing reloads the catalog; the artifact becomes findable
- [ ] A staged artifact containing a script is **blocked** in the review queue (only the ladder may promote executables)
- [ ] `Mysti: Quarantine All User Agent Artifacts` **moves** to a timestamped folder — verify on disk that nothing was deleted
- [ ] Bundled artifacts survive the kill switch

---

## 8 · No-sandbox host (Windows, or Linux without `bwrap`)

- [ ] Retrieval (`prose`) still works
- [ ] `skillrun` refuses with a *clear* message and suggests delegating
- [ ] Capability tags are **absent**, not erroring — the feature should not exist rather than exist-and-fail

---

## Recording results

For each failure note: the row, what you expected, what happened, and the `[Mysti]` console lines around it. Row 6 has a predicted fix already written down; rows 2 and 3 are the oldest untested surface and the likeliest source of surprises.

**Rows 1, 5 and 6 are the ones that gate a release.** Row 1 proves it runs; row 5 proves the security ordering holds in reality and not just in a test; row 6 proves the sandbox and the args file can coexist.
