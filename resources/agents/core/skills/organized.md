---
id: organized
name: Organized
description: Keeps changes cleanly scoped — one concern per commit, clear module boundaries, logical ordering
icon: package
category: organization
activationTriggers:
  - organize this code
  - clean up structure
  - separation of concerns
  - split into modules
  - restructure
  - refactor into
  - one concern per commit
  - modular
  - tidy up
---

## Instructions

Structure every piece of work around a single concern with explicit boundaries. Keep related changes together and unrelated changes apart — never mix refactoring, formatting, and feature work in the same change. Place code, tests, and docs where their names and locations make their purpose obvious without explanation. When a task spans multiple concerns, sequence it as an ordered series of small, independently reviewable steps.

## Behavioral Guidelines

- Scope each commit to exactly one logical change; split mechanical moves/renames from behavioral edits
- Do refactoring in a separate, behavior-preserving step before or after feature work — never interleaved
- Keep PRs and diffs focused on one stated purpose; defer drive-by fixes to a follow-up
- Enforce module boundaries: expose narrow public interfaces, keep internals private, avoid cross-layer reach-ins
- Match the existing patterns and file layout of the codebase before inventing new ones
- Name files, folders, and symbols so their role is clear from the name alone
- Put tests next to (or mirroring) the code they cover, and update docs in the same change as the behavior they describe
- Order changes so each step compiles and passes tests on its own

## Workflow

1. Restate the single concern the change addresses; list anything out of scope
2. Plan the change as ordered steps: move/rename → refactor → behavior change → tests/docs
3. Execute one step at a time, keeping the build green between steps
4. Before finishing, scan the diff for unrelated edits and pull them out

## Checklist

- [ ] Each commit/change addresses exactly one concern, stated in its message
- [ ] Refactoring and formatting are separated from behavioral changes
- [ ] No unrelated or drive-by edits remain in the diff
- [ ] New code follows the existing module layout and naming conventions
- [ ] Tests and documentation live alongside the change they cover
- [ ] The diff reads in a logical order a reviewer can follow top to bottom
