# Approval acceptance matrix

Reviewed 2026-09-11. Native acceptance uses an inert local model and isolated
state. No provider account or real model service was exercised. “Fixture” means
Mysti's protocol/lifecycle is tested, not that an installed CLI universally asks
for permission. Authenticated editor acceptance remains separate.

| Provider | Installed operation evidence | Unverified or unavailable scope |
| --- | --- | --- |
| Claude | Earlier pinned 2.1.266 file/shell allow, denial, restricted modes and Stop | Binary no longer at its recorded location; current rerun skips it. Account/editor acceptance pending. |
| Codex | App-server protocol and lifecycle fixtures; installed startup examined | Startup probe inconclusive; authenticated real operation acceptance pending. |
| Gemini | 0.58.0 native reads, writes/replacement, host veto, denied shell, Stop | Shell/delegation deliberately unavailable. |
| Qwen | 0.23.0 native read/edit/shell, denial, read-only, Stop, inherited allow-rule override | Broader tools/delegation unavailable. |
| Cline | 3.0.61 actual command/write, denial, read-only and Stop through public send | Saved-login, images, usage and broader native tools unavailable. |
| Copilot | 1.0.83 public read/search; forced shell/write rejected | Writable approval failed native tests; read/search only. Reads do not open host cards. |
| OpenCode | 1.18.29 public and native read/edit/fetch policies, denial, restricted modes, Stop | Shell/delegation removed from native executable tool map. |
| OpenClaw | 2026.6.34 actual stock read/write/edit/foreground exec; admission, denial, read-only, Stop, disconnect and gateway-crash descendant cleanup | macOS zombie-group EPERM is now handled by waiting for confirmed group absence; authenticated/editor and Windows acceptance pending. |
| Hermes, Kimi | Protocol fixture side effects occur only after a matching native allow; scoped routing, denial/cancel, concurrency, late answers and retry ownership | Neither CLI is installed. Native policy completeness and authenticated acceptance unverified. |
| Cursor, Continue | Every restricted mode/access combination rejected before discovery/prompt preparation | Restricted functionality unavailable. Continue is not installed; no native execution proof claimed. |
| Ollama, LocalAI | Proposal reporting and stream fixtures | Proposals are never locally executed by these providers. |
| OpenRouter | Chat HTTP fixtures | No local tool execution. |

The item-8 checkpoint ran 14 test files: 158 tests passed, one test/file skipped
(the unavailable Claude binary). The individual native cases include several
operations within one test. Evidence is retained in
`out-test/release-evidence/item8-native-matrix.log`. This checkpoint preceded the documented OpenClaw group-cleanup correction.
It does not establish authenticated acceptance.

Delegation coverage includes actual denial of unsupported native delegation,
plus Mysti child-run protocol fixtures covering captured parent authority,
independent cards, zero-argument requests, no retries after denial or a possible
side effect, and cancellation of the issuing child. A fixture does not establish
that every native provider emits all necessary requests. Do not advertise broad
native delegation until its full nested execution boundary is tested.

Supported operation identities, startup configuration exclusions and exact
provider limits are in [ACP](ACP_NATIVE_APPROVAL.md),
[Claude/Codex](NATIVE_CLI_APPROVAL.md), [OpenClaw](OPENCLAW_NATIVE_POLICY.md), and
[restricted transports](RESTRICTED_TRANSPORTS.md).
