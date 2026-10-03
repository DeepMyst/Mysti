# PR and issue review — 3 October 2026

## Pull requests

- #62: Mysti 2.0 BETA release, merged after the full validation matrix.
- #56–58: Actions updates integrated through #63.
- #59–61: dependency updates integrated through #64 with compatibility fixes:
  TypeScript 5.9, Mocha 10 and Playwright 1.58.2 retain the minimum editor;
  ESLint uses flat configuration; bundled Mermaid/sanitizer assets were rebuilt.
  Production dependency audit is clean. Development-only exceptions are in
  [MAINTENANCE.md](MAINTENANCE.md).
- #37, #52, #53: MiniMax, Russian localization and documentation contributions
  integrated through #65. The current chat architecture was preserved, MiniMax
  credentials use SecretStorage, and localization excludes conversation content.
  All required Linux/macOS/Windows, browser, runtime and editor checks passed.
- #66: subsequent upload-artifact update reviewed separately. Its default archive
  mode preserves the existing artifact name and packaged-editor download contract.

## Issue disposition

| Issue | Finding and evidence |
| --- | --- |
| #14, #27, #30 — Windows launch/PATH errors | Existing launch fixes covered by `cliPathResolution`, `windowsShellArgs`, installer and real editor suites. Windows CI passes. This establishes supported process paths, not every enterprise authentication environment. |
| #28 — editor/selection context | Existing `ContextManager` and context UI support active-file/selection context and enabled-state toggles. Persistence and rejection paths have regression coverage. |
| #31 — 90-second Brainstorm abort | Still reproducible in the code. Fixed by matching normal chat's 30-minute inactivity bound. A fake-clock regression lets an agent deliberate for 120 seconds and finish. Stop and finite timeout behavior remain tested. |
| #32 — Opus 4.6 1M | Already present as `claude-opus-4-6[1m]`; model validation, registry persistence and Windows bracket-argument tests cover it. Provider account access still determines model availability. |
| #33 — model reset on provider switch | Fixed: explicit model selections persist by provider and are restored on return. Custom-model writes now target the panel's provider instead of an unrelated global default. A Claude → Codex → Claude → Codex regression checks both choices. |
| #34 — missing OpenClaw identity | Existing persistent Ed25519 identity signs server nonce/token/scopes; cryptographic tests reject altered nonce and malformed keys. A server may still require legitimate device pairing; disabling device authentication is unnecessary. |
| #40 — OpenCode remote/HTTP | Added direct HTTP/SSE mode, machine-scoped endpoint/directory, SecretStorage password, connection/setup commands, model discovery and synchronous native approval. HTTP fixtures cover Allow/Deny, Stop, late approval, errors, streaming and cleanup; live OpenCode 1.18.29 accepts the permission handshake. See transport limitations in PROVIDERS.md. |
| #50 — Brainstorm stuck analyzing | Existing terminal-phase/error handling retained. Added parallel provider-readiness checks with a 30-second bound and cancellation; a hung discovery probe now ends with actionable errors and `done`. |
| #29 — Open VSX | Publication workflow prepared. Registry returned 404 and repository secret inventory was empty during review. Remains open until credentials/namespace setup and actual publication succeed. |
| #51 — “web pelatihan” | Empty issue body. No reproducible behavior or expected outcome; remains open awaiting details. |

## Validation scope

The merged integrations passed required hosted checks on all supported platforms,
including the packaged VSIX in VS Code stable and 1.86.0. The Canvas performance
driver now uses middle-button panning and asserts the board actually moved; it
previously measured marquee selection. Performance thresholds were preserved.

Issue fixes add focused regressions and use the same hosted gates before merge.
HTTP fixture success does not establish authenticated remote model completion,
MiniMax account access, enterprise SSO, or every user's OS configuration. No Open
VSX publication is claimed until the registry contains the tested artifact.

Focused verification during this pass: 117 tests for the older Windows/context/
Opus/OpenClaw reports; 377 tests across all suites affected by the interrupted
full local run, including remote setup and transport. TypeScript and lint pass
(467 existing warnings, zero errors); actionlint accepts the publication workflow.
A live model request through OpenCode 1.18.29 reached its upstream provider but
received HTTP 403: its free tier rejects external-client use. The adapter reported
an error and cleaned up the session. A paid/authenticated upstream completion
therefore remains unverified; no bypass of the free-tier restriction was attempted.

The final issue PR also fixes Canvas overhead exposed by macOS CI: pan deltas no
longer read viewport layout on each move, unchanged zoom labels are not rewritten,
and overview previews receive temporary compositor hints. The hint is released
above overview scale. Sixty-eight board tests and all three unchanged performance
assertions pass locally; the hosted matrix remains the merge gate.
