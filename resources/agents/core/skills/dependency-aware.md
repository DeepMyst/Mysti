---
id: dependency-aware
name: Dependency Aware
description: Vets every new dependency, reuses what the project already has, and keeps versions and lockfiles consistent
icon: chain
category: maintenance
activationTriggers:
  - dependency
  - add a package
  - npm install
  - which library
  - upgrade version
  - bundle size
  - lockfile
  - transitive dependencies
  - security audit
---

## Instructions

Treat every new dependency as a long-term liability that must earn its place. Before suggesting or installing a package, check whether the standard library, existing project dependencies, or a small amount of first-party code already covers the need. When a dependency is justified, verify maintenance health, license, size, and security posture, and pin it consistently with the project's existing version and lockfile conventions.

## Behavioral Guidelines

- Search the project's existing dependency manifest before proposing any new package — reuse what is already installed.
- Prefer a few dozen lines of first-party code over a new dependency for trivial utilities (padding, deep clone, simple date math).
- When a new package is genuinely needed, choose the actively maintained option: recent releases, responsive issue tracker, healthy download trends.
- State the cost of the addition explicitly: install size, bundle impact, and the transitive dependencies it pulls in.
- Match the project's version-range style (exact pin, caret, tilde) and keep versions of shared packages aligned across workspaces in a monorepo.
- Always update the lockfile through the project's package manager — never hand-edit it or mix package managers.
- Flag packages with known vulnerabilities, deprecation notices, or incompatible licenses before installing, not after.
- For upgrades, read the changelog for breaking changes and call out required migration steps instead of bumping blindly.

## Before Adding a Dependency

1. Can the standard library or an existing dependency do this?
2. Is a small first-party implementation cheaper to own than the package?
3. Is the package actively maintained and widely used?
4. What does it add in install size, bundle size, and transitive deps?
5. Any known CVEs, deprecation warnings, or install scripts of concern?
6. Is the license compatible with the project's distribution model?

## Checklist

- [ ] Confirmed the capability is not already covered by existing deps or the standard library
- [ ] Verified maintenance health (recent releases, active issue triage)
- [ ] Reported size and transitive-dependency impact to the user
- [ ] Checked for known vulnerabilities and license compatibility
- [ ] Version range matches project conventions and is consistent across the workspace
- [ ] Lockfile updated via the project's package manager, not by hand
