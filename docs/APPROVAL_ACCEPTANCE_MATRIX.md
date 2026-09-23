# Approval acceptance matrix

Reviewed 2026-09-14 (Codex startup follow-up). Native acceptance uses an inert local model and isolated
state. No provider account or real model service was exercised. “Fixture” means
Mysti's protocol/lifecycle is tested, not that an installed CLI universally asks
for permission. Authenticated editor acceptance remains separate.

| Provider | Installed operation evidence | Unverified or unavailable scope |
| --- | --- | --- |
| Claude | Earlier pinned 2.1.266 file/shell allow, denial, restricted modes and Stop | Binary no longer at its recorded location; current rerun skips it. Account/editor acceptance pending. |
| Codex | App-server protocol/lifecycle fixtures; installed 0.153.4 startup failure, Stop, independent-process cancellation and 30-second deadline cleanup | Successful native initialization/configuration still inconclusive under profile isolation; authenticated real operation acceptance pending. |
| Gemini | 0.58.0 (installed) and 0.60.0 (unpacked npm release, 2026-09-22) native reads, writes/replacement, host veto, denied shell, read-only, Stop; 0.60.0 declares only the three admitted tools | Shell/delegation deliberately unavailable. 0.60.0 skips the non-root system settings file; admin policy + startup refusal carry the policy. |
| Qwen | 0.23.0 (installed) and 0.24.4 (unpacked npm release, 2026-09-22) native read/edit/shell, denial, read-only, Stop, background refusal, inherited allow-rule override; model-facing tools exactly the four admitted | Broader tools/delegation unavailable. |
| Cline | 3.0.61 (installed) and 3.0.64 (unpacked platform binary, 2026-09-22) actual command/write, denial, read-only and Stop through public send | Saved-login, images, usage and broader native tools unavailable. |
| Copilot | 1.0.83 public turns: shell and apply_patch effects absent while the card is pending, one effect after allow, none after deny/Stop/redirect-only deny; async/detached shell denied without a card; read-only/plan expose no mutation tools | The earlier writable failure was Mysti's `COPILOT_ALLOW_ALL=false`. Reads do not open host cards; BYOK/fake-model only, no account. |
| OpenCode | 1.18.29 public and native read/edit/fetch policies, denial, restricted modes, Stop; macOS shell (2026-09-23): card before any effect, allow/deny, redirection-only command refused without a card, background job, Stop with a running, background and orphaned background job (no late effect), missing gate/extra plugin refuse the turn | Delegation unavailable. Shell only on macOS in unrestricted tiers; Linux/Windows keep shell removed pending native acceptance. |
| OpenClaw | 2026.6.34 actual stock read/write/edit/foreground exec; admission, denial, read-only, Stop, disconnect and gateway-crash descendant cleanup | macOS zombie-group EPERM is now handled by waiting for confirmed group absence; authenticated/editor and Windows acceptance pending. |
| Hermes, Kimi | Restricted tiers rejected before launch (native agents skip requests for most tools; source-verified v2026.9.21 / 2.0.2). Protocol fixture side effects occur only after a matching native allow; scoped routing, denial/cancel, concurrency, late answers and retry ownership | Neither CLI is installed. Native policy completeness and authenticated acceptance unverified. |
| Cursor, Continue | Every restricted mode/access combination rejected before discovery/prompt preparation | Restricted functionality unavailable. Continue is not installed; no native execution proof claimed. |
| Ollama, LocalAI | Proposal reporting and stream fixtures | Proposals are never locally executed by these providers. |
| OpenRouter | Chat HTTP fixtures | No local tool execution. |

The item-8 checkpoint ran 14 test files: 158 tests passed, one test/file skipped
(the unavailable Claude binary). The individual native cases include several
operations within one test. Evidence is retained in
`out-test/release-evidence/item8-native-matrix.log`. This checkpoint preceded the documented OpenClaw group-cleanup correction.
It does not establish authenticated acceptance.

The 2026-09-14 Codex follow-up preserves startup failure details instead of
replacing them with a generic closure error. All 175 focused tests pass, including
public-provider failure/recovery and Stop during initialization. Four installed
runtime cases used OS isolation with all networking and user-state access denied:
invalid configuration, cancellation of each of two independent processes, and
the unchanged 30-second initialization deadline. Every owned process group was
confirmed absent. No model turn was submitted; successful initialization and
account acceptance remain open. Evidence is retained in
`out-test/release-evidence/PROVIDER_ACCEPTANCE_20260914/`.

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
