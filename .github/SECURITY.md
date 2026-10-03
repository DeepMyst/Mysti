# Security Policy

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through GitHub's [Report a vulnerability][advisory] form on
this repository, or by email to **baha@deepmyst.com**.

[advisory]: https://github.com/DeepMyst/Mysti/security/advisories/new

Please include what you did, what happened, and what you expected. A minimal
reproduction — a workspace, a setting, a prompt — is worth more than a
description. If a proof of concept executes anything, say so plainly and say
what it does.

You will get an acknowledgement within 3 working days. This is a small project;
that is a commitment to answer, not a service-level agreement on a fix.

## Supported versions

The latest published release only. There is no backport line.

## What is in scope

Mysti runs AI models against your code and, when you turn the relevant gates on,
lets them act. The interesting boundary is between what a *model* can cause and
what a *user* has approved. In scope:

- **Permission-gate bypass** — any path where a tool call that should have shown
  a permission card runs without one, including through an unhandled operation
  mode or access level.
- **Prompt injection reaching authority** — content from a file, a web page, a
  tool result, an imported skill, or another agent that is treated as
  instructions rather than as fenced, untrusted data, and that thereby causes an
  action the user did not approve.
- **Model-to-shell paths** — any route by which model output selects or
  influences a command that is executed. There is deliberately no `url` or
  `command` attribute anywhere in the visual-observation grammar and no
  model-controlled dev-server command; a way around that is a vulnerability.
- **Agent trust-root forgery** — getting unverified content into the
  system-prompt tier, e.g. by defeating the SHA-256 integrity manifest for
  bundled agents, or by smuggling authority-granting frontmatter past the
  denylist.
- **Authority escalation via settings** — a workspace setting that *raises*
  authority (workspace settings may only lower it), or a setting whose scope is
  wider than machine where machine is required.
- **Credential exposure** — the DeepMyst `dm_` gateway key reaching any host
  other than `*.deepmyst.com`, or any provider credential reaching a log, a
  webview, a telemetry payload, or a workspace file.
- **Sandbox escape** — writes outside the workspace, or reads of credential
  paths, from the coordinator's local-execution sandbox.

## What is out of scope

- Anything that requires the user to first enable a default-off authority gate
  **and then** approve the action. Those gates
  (`mysti.mysti.localExecution`, `mysti.mysti.mcpTools`,
  `mysti.mysti.visualTools`, `mysti.mysti.skills`, `mysti.boost.enabled`,
  `mysti.desk.enabled`) are off by default precisely because they grant
  authority; using them as designed is not a vulnerability.
- Vulnerabilities in the third-party CLIs Mysti drives (Claude Code, Codex,
  Gemini, Copilot, Cursor, and the rest). Report those to their vendors. If
  Mysti's *invocation* of one is what makes it exploitable, that is in scope.
- Findings from automated scanners with no demonstrated path to impact.
- Denial of service against the user's own machine.

## Disclosure

Coordinated. We will agree a date with you, and credit you in the advisory and
changelog unless you would rather we did not.
