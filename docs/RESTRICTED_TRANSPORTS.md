# Restricted provider transports

Mysti's approval-required, plan and read-only settings must constrain execution
before the operation starts. A tool notification or a CLI flag named “readonly”
is insufficient evidence. Unsupported tiers return an error before CLI discovery
or prompt preparation; they do not silently run with broader permissions.

| Provider | Restricted turns | Remaining limitation |
| --- | --- | --- |
| Cursor | Rejected before launch | Native approval transport and isolated execution proof still needed. Fully unrestricted turns alone use `--force`. Prompt enhancement is disabled because that path had no execution restriction. |
| Continue | Rejected before launch | Plain final-text transport cannot ask the host. Fully unrestricted turns alone run, with every tool except the shell-injectable `Search`. |
| Hermes | Rejected before launch | v2026.9.21 asks only for denylisted shell commands and file edits; inherited `approvals.mode`/yolo can remove those. |
| Kimi Code | Rejected before launch | 2.0.2 auto-approves in-repository writes, FetchURL, Agent/AgentSwarm and Skill; plan mode does not cover fetch or subagents. |
| OpenCode | Fixed native agent removes mutations and shell in plan/read-only tiers | Delegation is unavailable in every mode. Shell is per-call approved in unrestricted tiers on macOS only. |
| Qwen | Fixed native tool subset plus immutable host mutation denial | Only the tools and runtime in the ACP contract are supported. |
| Copilot | Read/search subset in read-only and plan tiers; per-call approved shell/edits otherwise | Native reads have no host approval card; multi-file patches are approved per file. |

“Fully unrestricted” means `full-access` combined with `default` or
`edit-automatically`. `ask-before-edit` remains restricted even with full access.
These limits also apply to child turns; a read-only collaborator cannot use
Cursor or Continue. The [ACP contract](ACP_NATIVE_APPROVAL.md) records the exact
versions, native configuration boundaries and actual execution proofs for the
other providers. Rejecting unsupported turns fixes unsafe execution; it does
not complete their missing restricted-mode functionality or runtime acceptance.

## Continue evidence

The [official permission documentation](https://docs.continue.dev/cli/tool-permissions)
states that mode policies override CLI flags. The reviewed upstream implementation
at commit `5522c6f44ca0ac3528b37244818fbfa39b5af470` confirms this behavior:

- [Plan policies](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/permissions/defaultPolicies.ts)
  allow Bash, Fetch, UploadArtifact and a wildcard covering MCP tools.
- [Precedence resolution](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/permissions/precedenceResolver.ts)
  puts exclusions before allows within CLI policies. A wildcard exclusion with
  read allows therefore excludes the reads too.

Continue is not installed in the reviewed environment. No authenticated
acceptance is claimed.

2026-09-22 (latest `@continuedev/cli` 1.5.47, commit `d3f60ba9`, run from the
npm tarball under `sandbox-exec` with a private `CONTINUE_GLOBAL_DIR` and a fake
loopback model, no account):

- `tools/searchCode.ts` builds `rg ... "${pattern}" ... -g "!${gitignoreLine}"`
  as a shell string. With ripgrep on PATH, both a model `pattern` and a
  repository `.gitignore` line executed an injected `touch` under `--auto`.
  `--auto` overrides `--exclude`, so unrestricted turns now pass
  `--exclude Search --allow Edit --allow MultiEdit --allow Write` instead; Bash,
  Write, Read and Fetch still work and the injection no longer runs. The user's
  own `permissions.yaml` now applies after these flags (headless `ask` = deny).
- A read-only boundary does exist: an explicit private `CONTINUE_GLOBAL_DIR` whose
  `permissions.yaml` excludes `*`, plus `--allow Read --allow List`, advertised
  only Read and List; Bash, Write and Fetch had no effect, and a workspace `.env`
  or `.continue/` could not widen it. It is not wired because the private global
  directory also hides the user's `config.yaml` and its `.env` secrets, and no
  real configuration was available to prove model access still works.
- No per-call host approval exists: headless `ask` is denied before any callback,
  and the hidden `cn serve` permission endpoint is unauthenticated and headless.

## Cursor evidence

[Cursor's parameters](https://cursor.com/docs/cli/reference/parameters) describe
plan/ask modes. The locally installed `2026.02.13-41ac335` source contains these
modes and an ACP implementation, but native permission configuration can also
load project, user and managed sources before a model turn. Merely omitting
`--force` or adding `--mode ask` has not proved that every command waits for
Mysti's approval or that startup respects the selected restriction. A future
integration needs isolated configuration, final operation identity and actual
side-effect tests before enabling these tiers.

2026-09-22 review of the latest release, `2026.09.18-9a7762b` (install script
and shipped bundle; `--help` only, no login): restricted tiers stay rejected.
Every project `.cursor/cli.json` up to the Git root is deep-merged with array
replacement, so a repository can replace `allow`/`deny`; project hooks
(`.cursor/hooks.json`, `.claude/settings.json`) run commands and
`--disable-project-configs` does not disable them; allow rules also come from
team dashboard and server-side allowlists Mysti cannot pin; and read-only shell
confinement depends on a sandbox team settings can disable. The hidden `acp`
entry point does send `session/request_permission`, but already-allowlisted
operations and reads never reach the host. `--allowed-tools`/`--exclude-tools`
are internal-only and absent from older builds. Unrestricted turns keep
`--force`, which also satisfies the new print-mode workspace-trust check.
