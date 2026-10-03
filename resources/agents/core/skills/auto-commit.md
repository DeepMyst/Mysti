---
id: auto-commit
name: Auto-Commit
description: Commits work incrementally on a feature branch with atomic, conventional commit messages
icon: check
category: workflow
activationTriggers:
  - commit
  - commit this
  - auto commit
  - feature branch
  - new branch
  - checkpoint
  - save my work
  - git workflow
  - conventional commits
---

## Instructions

Commit work incrementally as you complete each logical unit of change — never batch an entire task into one commit. Before the first edit, verify you are on a feature branch; if on main/master, create one named for the work (e.g., `feature/<short-slug>` or `fix/<short-slug>`). Write conventional commit messages that state what changed and why, and keep every commit atomic so it can be reverted independently.

## Behavioral Guidelines

- Create or switch to a feature branch before making changes; never commit directly to main/master
- Commit after each self-contained change (one fix, one feature slice, one refactor) — not per file, not per session
- Use `git add -p` or explicit file paths to stage only related changes; never `git add -A` blindly
- Follow conventional commit format: `<type>(<scope>): <subject>` with an imperative, lowercase subject under 72 chars
- Ensure the code compiles and existing tests pass before each commit — a commit is a checkpoint, not a scratch save
- Separate mechanical changes (formatting, renames) from behavioral changes into distinct commits
- Push the branch after a meaningful milestone or before ending a session, so remote serves as backup
- Never commit secrets, credentials, or generated build artifacts; check the diff before committing

## Commit Message Format

```
<type>(<scope>): <subject>

<body: what changed and why, wrapped at 72 chars — optional for trivial changes>

<footer: issue refs, breaking-change notes — optional>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`

## Example Workflow

```bash
git checkout -b feature/add-user-auth
# Implement one unit of work...
git add -p                                  # stage only related hunks
git commit -m "feat(auth): add login endpoint"
# Next unit...
git commit -m "feat(auth): validate JWT on protected routes"
git push -u origin feature/add-user-auth    # backup at milestone
```

## Checklist

- [ ] Work is on a feature branch, not main/master
- [ ] Each commit contains exactly one logical change
- [ ] Every commit message follows conventional format with a clear subject
- [ ] Only intentionally staged files are in each commit (diff reviewed)
- [ ] Code builds and tests pass at every commit point
- [ ] Branch pushed to remote after milestones
