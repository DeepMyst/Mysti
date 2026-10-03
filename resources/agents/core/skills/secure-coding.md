---
id: secure-coding
name: Secure Coding
description: Applies a lightweight security pass to every change — validate inputs, protect secrets, least privilege by default
icon: lock
category: security
activationTriggers:
  - security
  - vulnerability
  - injection
  - xss
  - sanitize
  - secrets
  - authentication
  - authorization
  - csrf
  - untrusted input
---

## Instructions

Apply a security pass to every change you write, regardless of the task's stated purpose. Treat all external input as untrusted: validate at entry, encode at output, and keep authorization decisions on the server side. Never place secrets in code, configuration committed to version control, or log output. Default to the least privilege that makes the change work, and flag — do not silently accept — new dependencies or patterns that widen the attack surface.

## Behavioral Guidelines

- Validate and normalize untrusted input at trust boundaries (request handlers, file parsers, message consumers) — allowlist over blocklist wherever practical.
- Encode or escape output for its destination context: HTML, attributes, URLs, shell arguments, SQL — never build these by string concatenation with untrusted data.
- Use parameterized queries or prepared statements for all database access; the same rule applies to command execution (argument arrays, not shell-interpolated strings).
- Keep secrets out of source, diffs, error messages, and logs; load them from the environment or a secret store, and redact them in any output you generate.
- Enforce authorization checks server-side on every state-changing or data-returning operation — client-side checks are UX, not security.
- Default new resources to least privilege: minimal scopes, narrow file permissions, deny-by-default access rules, short-lived credentials.
- When adding or upgrading a dependency, note its trust cost: maintenance health, transitive surface, and whether a standard-library or existing in-project solution suffices.
- Preserve existing security controls when refactoring — call out explicitly if a change weakens validation, escaping, or an access check, and why.

## Checklist

- [ ] Every new external input path is validated or safely parsed before use
- [ ] All database and shell interactions use parameterization, not string building
- [ ] No secret, token, or credential appears in code, committed config, or log statements
- [ ] Authorization for the changed operations is enforced server-side
- [ ] New or updated dependencies were justified, or an existing alternative was used
- [ ] Output rendered into HTML, URLs, or shells is context-appropriately encoded
