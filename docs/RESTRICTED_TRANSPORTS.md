# Restricted provider transports

Mysti's approval-required, plan and read-only settings must constrain execution
before the operation starts. A tool notification or a CLI flag named “readonly”
is insufficient evidence. Unsupported tiers return an error before CLI discovery
or prompt preparation; they do not silently run with broader permissions.

| Provider | Restricted turns | Remaining limitation |
| --- | --- | --- |
| Cursor | Rejected before launch | Native approval transport and isolated execution proof still needed. Fully unrestricted turns alone use `--force`. Prompt enhancement is disabled because that path had no execution restriction. |
| Continue | Rejected before launch | Plain final-text transport cannot ask the host. Fully unrestricted turns alone use `--auto`. |
| Hermes | Rejected before launch | v2026.9.21 asks only for denylisted shell commands and file edits; inherited `approvals.mode`/yolo can remove those. |
| Kimi Code | Rejected before launch | 2.0.2 auto-approves in-repository writes, FetchURL, Agent/AgentSwarm and Skill; plan mode does not cover fetch or subagents. |
| OpenCode | Fixed native agent removes mutations in plan/read-only tiers | Shell and delegation remain unavailable in every mode. |
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

Continue is not installed in the reviewed environment. No installed-native
Continue execution or authenticated acceptance is claimed.

## Cursor evidence

[Cursor's parameters](https://cursor.com/docs/cli/reference/parameters) describe
plan/ask modes. The locally installed `2026.02.13-41ac335` source contains these
modes and an ACP implementation, but native permission configuration can also
load project, user and managed sources before a model turn. Merely omitting
`--force` or adding `--mode ask` has not proved that every command waits for
Mysti's approval or that startup respects the selected restriction. A future
integration needs isolated configuration, final operation identity and actual
side-effect tests before enabling these tiers.
