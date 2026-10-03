---
id: repo-hygiene
name: Repo Hygiene
description: Keeps the repo clean — consistent structure, no dead code, tidy dependencies, correct ignores
icon: brush
category: organization
activationTriggers:
  - clean up the repo
  - remove dead code
  - unused imports
  - organize files
  - project structure
  - naming conventions
  - tidy dependencies
  - update gitignore
  - refactor structure
  - repo cleanup
---

## Instructions

Treat repository cleanliness as part of every change, not a separate task. Match the project's existing structure, naming, and formatting conventions before inventing new ones. Within the footprint of the requested change, remove dead code, unused imports, and stray artifacts you touch; when the task is scope-constrained, list cleanups as follow-ups instead of applying them. Never mix broad cleanup with functional changes — keep hygiene edits separable and easy to review.

## Behavioral Guidelines

- Infer conventions from the codebase itself (file naming, directory layout, import ordering) and follow them exactly; flag inconsistencies instead of silently adding a third style
- Place new files where their closest existing peers live; do not create new top-level directories without stating why
- Delete unused imports, unreferenced variables, commented-out blocks, and dead branches within the code your change already touches — do not leave "just in case" code; when the task is scope-constrained, list them as follow-ups instead of applying them
- Keep dependency manifests minimal: add a dependency only when used, remove ones that no longer are, and put dev-only tooling in dev dependencies
- Ensure generated output, caches, logs, and local env files are ignored by version control before they can be committed
- Prefer small, mechanical, obviously-safe cleanups; call out anything riskier (renames, moves, large deletions) and confirm before doing it
- When moving or renaming files, update every reference — imports, build configs, scripts, and docs — in the same change
- Keep documentation entry points (README, contributing notes) consistent with the structure after any reorganization

## Workflow

1. Scan the affected area: stray files, dead code, naming drift, unignored artifacts.
2. Propose the cleanup scope in one short list; separate safe-mechanical from risky-structural items.
3. Apply safe items; for structural changes, do one move/rename per logical step with all references updated.
4. Verify the build and existing checks still pass after cleanup.

## Checklist

- [ ] New and moved files sit in directories consistent with existing peers
- [ ] Names follow the dominant project convention with no new variants introduced
- [ ] No unused imports, dead code, or commented-out blocks remain within the change footprint (or they are listed as follow-ups when the task is scope-constrained)
- [ ] Dependency manifests contain only what is actually used, in the right section
- [ ] Build artifacts, caches, and local env files are ignored by version control
- [ ] All references (imports, configs, scripts, docs) updated for any move or rename
