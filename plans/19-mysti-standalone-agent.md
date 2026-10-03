# Plan 19 — Making @mysti a Standalone Coding Agent

**Goal:** give the Mysti coordinator (`settings.provider === 'mysti'`) its **own** file / edit / patch / bash / test / git capabilities so it is a powerful coding agent *by itself* — on par with Claude Code / Codex / Kimi Code — even when **no other backend is installed to delegate to**, and **without** weakening the security model that makes a free, possibly-weak, prompt-injectable coordinator model safe to run.

**One-line principle:** *the coordinator gains **capabilities**, never **authority**.* Every new local tool routes through the **same** stream-level permission gate, workspace-scoping, secret-blocking, safety-classification, and checkpointing substrate that already governs the 14 CLI backends. A local tool call is never more trusted than a delegated one.

Status: **Phases 0–6 IMPLEMENTED** (2026-07-19) — `MystiLocalExec` + gated `write`/`edit` (Phase 0), atomic `patch` (Phase 1), sandboxed `bash` via `MystiSandbox` (Phase 2, Seatbelt/bwrap, empirically validated), git/remote-effect modal (Phase 3), native tool-calling (Phase 4: `coordinatorTools` + `ToolCallAccumulator` + `tool_calls` SSE in both clients + coordinator-loop native branch, fail-safe alongside the text protocol), bounded-parallel read-only tool_call batching (Phase 5: `runBounded` cap-3, per-tool Stop), and **MCP-as-coordinator-tools + in-chat Connect (Phase 6)**: gated `mcptool` (call the user's DeepMyst-connected Gmail/Slack/… tools, always user-approved, `MystiSandbox`-independent) + a nonce-fenced `connect` directive that reuses the existing OAuth connect-card flow; both text + native encodings; `McpClient` hardened (timeouts, `inputSchema`). Off by default (`mysti.mysti.localExecution`, `mysti.mysti.mcpTools`). **2029 tests green, tsc clean.** The native loop + the MCP path need a **live-account F5 smoke test** (unverifiable in-suite). **Seven adversarial review rounds + a round-4 confirmation review = 46 findings, all fixed.** **Five adversarial review rounds + a round-4 confirmation review = 35 findings, all fixed.** Round-4 introduced a **cubic-ReDoS** in the force-push regex → fixed with tokenized `isForcePush` + a `MAX_SCREEN_COMMAND_LEN` fail-closed cap. Round-5 (10-agent review of the Phase 4 + ReDoS-fix surface, 9/9 confirmed) caught that the round-4 tokenizer only saw the FIRST git subcommand and anchored to end-of-string → `git status && git push -f` / `git push --force\n` bypassed the force-push + remote-effect hard blocks (auto-approve in aggressive mode); fixed with per-segment scanning (`shellSegments`/`gitSubcommandOf`/`gitSubcommands`), `+refspec` detection, native-toolcall precedence over the length-continuation branches, gateway `toolCalls` ownership (no post-emit failover), per-model tools gating, and the finalize scanner honoring exec kinds. Grounded in verified source on `feature/visual-testing`.

---

# Part A — Research: the 2026 coding-agent landscape

We support 15 backends; **12 are true agentic CLIs** (Ollama / LocalAI / OpenRouter are inference/gateway backends, not agents). Their current (mid-2026) capabilities:

| Agent | Open? | Model(s) | Native tool-calling | Local tools | Sandbox | Plan mode | MCP | Subagents | Standout |
|---|---|---|---|---|---|---|---|---|---|
| **Claude Code** | ✗ | Sonnet 5 (1M ctx), Opus 4.8, Haiku | ✓ | Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch/LSP/Monitor | ✗ local (gate+hooks); cloud VMs | ✓ (Plan mode + EnterPlanMode) | ✓ client (tool-search defers schemas) | ✓ Agent tool, Teams, Workflow | Non-git checkpoints (Esc·Esc); Skills/plugins marketplace; runs everywhere; PreToolUse hook enforcement |
| **OpenAI Codex** | ✓ | GPT-5.x-Codex | ✓ | read/write/`apply_patch`/shell | ✓ **Seatbelt / bwrap+seccomp / Win-native** | ✓ | ✓ client **+ server** | ✓ auto-review reviewer | OS-kernel sandbox × tunable approval policy (read-only/workspace-write/danger-full); atomic apply_patch |
| **Kimi Code** | ✓ | Kimi K2.7 Code / K3 (1M) | ✓ | read/edit/write/shell/grep/fetch | approval-gated (no OS sandbox noted) | ✓ | ✓ (conversational `/mcp-config`) | ✓ | **Video input** (watches screen recordings); plugin marketplace (Skills+MCP) |
| **Gemini CLI** | ✓ Apache-2.0 | Gemini 3 (1M ctx) | ✓ | read/write/edit/Shell/grep/glob/WebFetch/**WebSearch (Google-grounded)** | ✓ **Seatbelt + container** profiles | ✓ | ✓ | ✓ | Native Google-Search grounding in the loop; TOML Policy Engine; huge OSS lineage |
| **Qwen Code** | ✓ Apache-2.0 | Qwen3-Coder | ✓ | read/write/edit/**multi-edit/apply-patch**/shell/grep/glob/web | inherits Gemini-CLI sandbox | ✓ Plan Mode | ✓ | ✓ SubAgents/Teams | Most feature-complete free Gemini-lineage agent (~Claude-Code parity, 69.6% SWE-bench) |
| **Cursor CLI** | ✗ | Composer 2.5 (own frontier model) | ✓ | read/write/edit (word-diff)/shell/semantic-search/WebFetch/WebSearch | ✓ "Auto-Run in Sandbox" | ✓ (`/plan`) | ✓ | ✓ async nested | Composer 2.5 trained on real dev sandboxes; terminal↔web↔mobile cloud handoff; unified CLI==editor perms |
| **Cline** | ✓ Apache-2.0 | BYOK (any) | ◑ XML/text protocol | read_file/write_to_file/replace_in_file/execute_command/search/list/**browser_action** | workspace checkpoints | ✓ **Plan/Act** | ✓ | — | Radical transparency (per-step approval); Memory Bank; real Puppeteer browser automation |
| **GitHub Copilot CLI** | ✗ | GitHub-hosted (Claude/GPT/Gemini) | ✓ | read/modify/execute/shell(`!`)/Explore/web_fetch | trusted-dirs; per-tool scope | ✓ (Plan/Autopilot) | ✓ **built-in GitHub MCP** | ✓ Fleet-mode parallel | Best-in-class GitHub workflow (PR review/merge, cloud coding-agent) |
| **OpenCode** | ✓ MIT | model-agnostic | ✓ | read/write/edit/**apply_patch**/bash/grep/glob/LSP diagnostics | — | ✓ (persisted plan files) | ✓ | ✓ | Model-agnostic Go TUI + client/server; ACP; allow/ask/deny wildcard rules (`git *`:allow, `rm *`:deny) |
| **Continue (cn)** | ✓ | model-agnostic (shares IDE config) | ◑ | Read/Write/Edit/**MultiEdit**/Bash/Search/List/Fetch/Diff/Checklist/CheckBackgroundJob | — | ✓ (`--readonly`) | ✓ | — | Best headless Unix design (`cn -p`→stdout) for CI/CD/hooks/cron; config shared with IDE |
| **Hermes** | ✓ MIT | model-agnostic (Nous/OpenRouter/…) | ✓ (seq **or** concurrent, ≤8 workers) | read/write/patch/search/terminal/web/memory/todo/skills/**code-exec**/delegation/vision | ✓ **6 terminal backends** (local/sandboxed/remote) | — | ✓ | ✓ Mixture-of-Agents | Self-improving (autonomous skill creation, `/learn`); **evidence-based "done"** (file-mutation verifier) |
| **OpenClaw** | ✓ MIT | model-agnostic | ✓ (tool-router) | exec/browser/file/search/process/canvas/cron/webhooks/media | full-access **or** sandboxed | — | ✓ | ✓ orchestrate/attach | Omni-channel (WhatsApp/Telegram/Slack/…); fully self-hosted |

## Convergent patterns (what "on par" means in 2026)

1. **Native function-calling loop** over `read / write / edit / apply-patch / bash / grep / glob / web` — *every* modern agent. (Cline/Continue still use a text protocol; everyone else is native tool-calling.)
2. **A permission ladder**: `ask` (default) → `auto-edit` → `yolo/full`, plus **allowlists** (`Bash(npm run *)`, `git *`:allow / `rm *`:deny). Read-only ops run without prompting.
3. **OS-level sandboxing is the current frontier** for `bash`: Codex, Gemini, Cursor, Hermes ship it (Seatbelt on macOS, bwrap+seccomp on Linux, containers, Windows-native for Codex). Claude Code notably relies on **gate + hooks, no local OS sandbox**. **Windows has no clean primitive** → most treat it as allowlist-only.
4. **Plan mode** (read-only exploration → propose → approve before writing) is near-universal.
5. **Checkpoints / rewind** (Claude non-git, Cline workspace) to make approvals low-stakes.
6. **MCP client** everywhere; Codex also a server. **Subagents / parallel** increasingly standard.
7. **Evidence-based "done"** (Hermes' file-mutation verifier; Cursor's test/lint reward loop) — the loop *proves* completion, not keyword-matches.

## Where Mysti stands

Mysti's **governance substrate is already at or above reference-agent maturity** — a single stream-level permission gate, a `SafetyClassifier` (block-list + compound-operator reject + allow-list tiers), shadow-git `CheckpointManager`, workspace-scoping with secret-blocking, bounded orchestration (`CollaboratorPool`), and — newly — user-selectable coordinator models across the full OpenRouter catalog + gateway.

The **one thing it lacks is the local action surface itself**: `@mysti` is the *only* agent here that cannot write a byte or run a command on its own — by deliberate design, it delegates all mutation. Plan 19 closes exactly that gap by bolting a **gated execution front-end onto the existing gate**, not by loosening the gate.

---

# Part B — Design: a gated local execution layer

## B0. Current state (verified)

- Coordinator local tools are **read-only**: `read` / `ls` / `grep` / `diag` / `remember` (`MystiLocalTools.ts:18-20` states no write/bash counterpart by construction). Directive kinds: `ALL_MYSTI_KINDS` (`mystiDelegateParser.ts:63`).
- The ReAct loop `_runMystiAgentic` aborts the stream on the first complete directive, executes it, fences the result, and re-enters (`ChatViewProvider.ts:7103`, `:7199`).
- All mutation/execution is **delegated** through the gated `CollaboratorPool` (`CollaboratorPool.ts:547`), and the system prompt literally tells the model *"You CANNOT write files or run commands yourself"* (`ChatViewProvider.ts:7861`).
- If no backend is installed, standalone action is **impossible**, not just weak (`_availableMystiBackends`, `ChatViewProvider.ts:7644`; prompt `:7876`).

## B1. One chokepoint: `MystiLocalExec`

Introduce **`src/services/MystiLocalExec.ts`** — the single executor every local mutation/execution funnels through, whether it arrived as a text directive or a native function call. It is the local analogue of `CollaboratorPool._gateToolUse`: the *one place authority is checked*.

```
MystiLocalExec.dispatch(op, args, ctx) →
  1. resolve + fence  (MystiLocalTools._safeResolve — reused verbatim, MystiLocalTools.ts:100)
  2. secret-block     (looksLikeSecret — reject secret WRITE/exec targets identically to read, :67)
  3. classify         (classifyToolAction + SafetyClassifier for bash)
  4. GATE             (synthesize a toolCall → _shouldGateToolUse → requestPermissionInline)
  5. checkpoint       (CheckpointManager.snapshot BEFORE any write/patch/bash)
  6. execute          (in a sandbox for bash; direct fs for write/edit/patch)
  7. fence result     (_fenceLocalToolResult → UNTRUSTED, both nonces redacted)
```

Steps 1–5 and 7 are **existing, verified infra** (Part B7). Only step 6 (+ the sandbox) is genuinely new.

## B2. The new tools

Each is exposed **both** as a directive kind (text-protocol models) and a function schema (native tool-calling models, B4). Args identical.

| Tool | Directive form | Function form | Gate class | Notes |
|---|---|---|---|---|
| `write` | `<write:NONCE path="…">content</write>` | `write(path, content)` | `write` | Whole-file. `_safeResolve` + secret-target reject + checkpoint. |
| `edit` | `<edit:NONCE path="…">…</edit>` | `edit(path, old_string, new_string, replace_all?)` | `write` | Targeted string-replace (Claude `Edit` shape). Fails if `old_string` not unique unless `replace_all`. |
| `patch` | `<patch:NONCE>…envelope…</patch>` | `apply_patch(patch)` | `write` | Atomic multi-file add/update/delete/move (Codex/OpenCode shape). Every path `_safeResolve`'d + secret-checked; **reject the whole patch if any path escapes**; validate-before-apply. |
| `bash` | `<bash:NONCE>cmd</bash>` | `bash(command, cwd?)` | `bash-command` (high) | Through `SafetyClassifier` → OS sandbox → gate. Network-off by default. **Highest risk (B3.4).** |
| `git` | `<git:NONCE>subcommand</git>` | `git(args)` | mixed | read (`status`/`diff`/`log`/`branch`)=low; write (`commit`/`add`)=`write`; `push`/remote=**modal default-DENY**. |

`runtests` is **not** a separate tool — it's `bash` with the scanned test command (`ChatViewProvider.ts:7329`), inheriting the full bash gate+sandbox rather than a parallel less-guarded path.

## B3. Routing through the EXISTING gate (no second gate)

`MystiLocalExec` synthesizes the same `toolCall` shape a CLI backend emits and calls the exact same functions:

- Build `{ name: 'write'|'bash'|…, input }` → **`_shouldGateToolUse(settings, name)`** (`ChatViewProvider.ts:3078`). `classifyToolAction` is **fail-closed**: unknown/bash → high-risk → gated.
- If gating is required → **`requestPermissionInline(...)`** → `PermissionManager.requestPermission` → renders the **same permission card** and awaits approve/deny. **Panel-gone auto-DENY** applies unchanged (a local write in a closed/background panel fails closed).
- **Default-deny in ask modes**: `default` / `ask-before-edit` / read-only access → writes & bash gated (identical to CLI tool_use gating at `:3078`, `:3914`).
- **Read-only / plan-mode parity**: in a plan mode or `accessLevel === 'read-only'`, the executor hard-denies any non-read op locally — mirroring the delegation decision. `settingsClamp` guarantees a workspace `.vscode/settings.json` can only **lower** authority, never raise it.

## B3.4 The hard tension — prompt-injection → RCE (the crux)

The coordinator (a) may run a **weak free model** and (b) **feeds untrusted tool/file/delegation results back into it** (fenced, but influential). A local `bash` tool is exactly the **visual-test RCE** shape (a model-emitted command run via `spawn(cmd,{shell:true})` **ungated** — prompt-injectable). We must **not** reintroduce an ungated model→shell path. Defense in depth (no single layer trusted):

1. **Gate everything, always** — no local op auto-executes; `bash`/`write`/`patch` are `require-user`. The gate is the PreToolUse-equivalent hard enforcement point.
2. **Nonce-fence + UNTRUSTED-fence all results** (`_fenceLocalToolResult`, both the directive nonce and the UUID fence nonce stripped) so a live `<bash:…>` riding inside a file's contents or a sub-agent's output can never be echoed and fired. For native tool-calling the API provides channel separation structurally (B4); result-fencing still applies.
3. **SafetyClassifier pre-screen for bash**: `BLOCKED_BASH_PATTERNS` (`SafetyClassifier.ts:26` — `rm -rf`/`sudo`/`curl|sh`/`dd`/`DROP TABLE`) hard-deny; `COMPOUND_OPERATOR_PATTERN` (`:76`) rejects `&&`/`|`/`;`/backtick/redirect so a "safe" cmd can't smuggle a chained one; `SAFE_BASH_PATTERNS` (`:88`) is the only fast-path, tier-gated by `safetyMode`.
4. **Sandbox bash** (new): macOS **Seatbelt** (`sandbox-exec`), Linux **bwrap+seccomp**, workspace-write scope, **network off by default** (Codex model). **Windows has no primitive → allowlist-only, fail-closed** (deny anything not in `SAFE_BASH_PATTERNS`) — the sandbox absence is explicit, not silent.
5. **Workspace-trust gating** (closes a known open gap): local exec **disabled in untrusted VSCode workspaces** (`vscode.workspace.isTrusted`). Reading untrusted is fine; executing is not.
6. **Capable-model requirement, opt-in**: new setting **`mysti.mysti.localExecution` (default `"off"`)**. With the default free rotation, `bash` requires either a **pinned capable model** (`mysti.mysti.coordinatorModel`, the selection just shipped) or per-op approval every time (no fast-path). Free-by-default stays for *investigation*; standalone *action* nudges the capable pinned model.
7. **Autonomous caps**: local `bash` never auto-approves beyond `SAFE_BASH_PATTERNS` in the current `safetyMode`; secret targets denied regardless; a **hard per-run cap** on local writes+bash (new governor alongside `maxDelegations`/`maxTurns`, `ChatViewProvider.ts:6840`), ×2 on high effort.
8. **Checkpoint-before-every-write** (`CheckpointManager.snapshot`, `.ts:141`) → `rewindTo` (`.ts:152`) gives Claude-Code-style undo of the coordinator's own edits.
9. **settingsClamp**: a workspace file cannot enable local exec or raise access if user-scope policy forbids it.

**Net stance:** the coordinator's model can *request* a dangerous command but can only *land* one through the same human/policy gate a CLI backend faces, after a syntactic block-list, inside a sandbox, with a rewind point — and `bash` is off unless the user opted in and (for the fast path) pinned a capable model.

## B4. Native tool-calling (upgrade the text protocol; keep the fallback)

Deferred as Plan 16 P1.4b. The default free chain already contains function-calling-capable models (`gpt-oss-120b:free` "reasoning + function calling", `gemma-4-31b-it` "function calling" — `CoordinatorModelClient.ts:63-65`), so native tool-calling is viable *today*.

- **Two front-ends, one executor.** `MystiLocalExec.dispatch` is the shared back-end; the `MystiTagScanner` text path and a new native path both call it. Tool schemas and directive kinds are two encodings of the same op set.
- **Capability detection.** A `supportsToolCalls` map keyed by coordinator model id, consulted in `_runMystiAgentic`. Capable → send OpenAI-style `tools:[…]` through `CoordinatorModelClient.stream` and parse `tool_calls` deltas. Incapable/unknown → the existing text protocol, unchanged.
- **Security parity is explicit.** A native `tool_call` is **not** more trusted — it still passes `_shouldGateToolUse`. The nonce's job (unforgeable control channel) is now handled *structurally* by the API (tool_calls are a separate channel from content); result-fencing stays because results re-enter as content.
- **Serialize first.** One gate decision at a time (legible cards); bounded-parallel local tool_calls are a Phase-5 optimization.

## B5. Testing & deploy loops

**Test-loop (run → read failures → iterate):** `bash("npm test")` (or scanned test cmd `:7329`) → SafetyClassifier + sandbox + gate → capture stdout/stderr (capped) → `_fenceLocalToolResult` back as UNTRUSTED data → coordinator reads live ground truth via the **existing** `diag()` pulse (`:7320`) → `edit`/`patch` → re-run. `maxTurns` bounds iteration; the existing `verify` (`package.json:733`) and cross-review (`:723`) apply to local edits too.

**Git & deploy under gating:** read git = low-risk; write git (`add`/`commit`) = `write` gate + checkpoint; **remote-effect** (`push`, `gh pr create`, deploy) = **modal default-DENY showing the exact command** (reuse `_confirmModelDevServerCommand`, `:6418`/`:6437`) — a push/deploy can't be rewound, exactly like Claude Code's "checkpoints don't cover remote systems" rule. `git`-through-`bash` inherits `COMPOUND_OPERATOR_PATTERN` rejection.

## B6. Phased plan (MVP → parity)

Each phase ships behind `mysti.mysti.localExecution` (default `"off"`) and is independently revertable. Effort = eng-weeks (1 engineer, incl. Vitest + `tsc`).

| Phase | Scope | Security gate (must hold before merge) | Effort |
|---|---|---|---|
| **0 — Executor + write/edit** ✅ **DONE** | `MystiLocalExec`; `write`+`edit` kinds; wire to gate/checkpoint; capability flag + settings. | Writes gated (default-deny) + `_safeResolve` scoped + secret-target rejected + workspace-trust + plan/read-only excluded + checkpoint. Off by default (machine-scoped). | **shipped** |
| **1 — Apply-patch** ✅ **DONE** | `patch` atomic multi-file (Add/Update SEARCH-REPLACE/Delete/Move; validate-all-in-memory-first, reject-whole-on-escape). | Any path escape/secret voids the whole patch; gated once + checkpointed before the batch. | **shipped** |
| **2 — Bash + sandbox** ✅ **DONE** | `bash` through `screenBashCommand` → `MystiSandbox` (Seatbelt / bwrap `--unshare-net`), network-off; **no-sandbox platforms = allowlist-only fail-closed**; `bashNetwork` setting. | No ungated model→shell path; blocked patterns hard-deny; network off; fast-path needs pinned capable model; sandbox empirically validated (write-outside + network blocked in-suite). | **shipped** |
| **3 — Git/deploy** ✅ **DONE** | git runs through the Phase-2 `bash` tool (read-only git auto; writers carded; `.git/config`+`hooks` read-only in-sandbox). **Remote-effect/deploy** (push/publish/deploy/ssh/cloud) → `isRemoteEffectCommand` → **modal default-DENY**. | Remote-effect always modal-confirmed; not a redundant tool. | **shipped** |
| **4 — Native tool-calling** ✅ **DONE (needs F5 smoke test)** | ✅ `coordinatorTools.ts` (schemas + capability check + `tool_call→MystiDirective` converter); ✅ `ToolCallAccumulator` + `tool_calls` SSE parsing in **both** OpenRouter + DeepMyst gateway; ✅ `toolCalls` threaded through `CoordinatorModelClient` (both chains, done-on-toolcall-only-turn); ✅ coordinator-loop native branch in `_runMystiAgentic` — a native call converts to a directive and runs the SAME gated dispatch; tools offered ALONGSIDE the text scanner (fail-safe: `modelSupportsToolCalls` allowlist gates the `tools` field; unknown/free models keep the proven text protocol untouched). Unit-tested (SSE accumulation, forwarding, tools-body, tool-call-only completion). ⏳ Cannot be verified without a live capable model → **needs an F5 smoke test before trusting the native path**. | Native gated identically (converter→existing gate/checkpoint/fence/budget); UNTRUSTED-fenced; unknown models fall back to text. | **shipped (loop live-untested)** |
| **6 — MCP tools + in-chat Connect** ✅ **DONE (needs live F5)** | ✅ Gated `mcptool` directive + native `mcp__<name>` tools calling the user's DeepMyst-connected external tools (discovered via the `/api/v1/me/mcp` broker); ✅ nonce-fenced `connect` directive reusing the existing OAuth connect-card flow (agent DETECTS the gap → button). Every MCP call is a mandatory permission card (`forceInteractive`, now also auto-DENY on timeout), only discovered tools callable, results UNTRUSTED-fenced, budget `maxMcpCalls`, off by default + machine-scoped (`mysti.mysti.mcpTools`). Tool metadata sanitized (drop unsafe names, bound descriptions, cap 60); dm_ bearer host-guarded; tool list cached (no per-message re-handshake). DEFERRED: programmatic capability-gap detection (2.B) — agent-driven detection ships now. | No ungated network side effect (always a card, never auto-approved incl. on timeout); dm_ only to the DeepMyst broker host; untrusted results + tool metadata fenced/sanitized; coordinator can suggest a connection but never initiate `connectMcp`. | **shipped (live-untested)** |
| **5 — Parity polish** ◑ **mostly DONE** | ✅ Bounded-parallel tool_calls: an all-read-only native batch (read/ls/grep/diag) runs cap-3 in-order (`runBounded`), fed back in ONE turn; any mutating/gated call stays serial. Stop is honored per-tool (cancelled jobs short-circuit, matching the serial path — round-6 fix). ✅ Background local exec already works — the `bg` job path shares the loop and `requestPermissionInline` already **auto-denies when the owning panel is gone** (ChatViewProvider.ts:5587). ✅ Autonomous caps already settings-backed + effort-scaled (`_mystiGovernors`). ⏳ DEFERRED: MCP-as-coordinator-tools (optional, larger). | Background writes obey panel-gone auto-deny ✓; parallel bounded (cap 3) + read-only-only so no write race / no multi-card collision ✓; every batched result nonce+UNTRUSTED fenced ✓. | **shipped (MCP deferred)** |

**MVP = Phases 0–1** (local write/edit/patch, no bash) → already a standalone *editing* agent needing no backend, with the full gate. **Standalone parity = through Phase 3.** **Best-in-class ergonomics = Phase 4.** Free-by-default preserved throughout; execution nudges (and for the bash fast-path requires) a pinned capable model.

## B7. What to REUSE vs BUILD

**REUSE (verified):**

| Need | Reuse | Location |
|---|---|---|
| Workspace-scope writes/bash cwd | `MystiLocalTools._safeResolve` | `MystiLocalTools.ts:100` |
| Block secret write/exec targets | `looksLikeSecret` / `SECRET_FILE_RE` | `MystiLocalTools.ts:63,67` |
| Permission gate + cards (default-deny, panel-gone auto-deny) | `_shouldGateToolUse` → `requestPermissionInline` → `PermissionManager` | `ChatViewProvider.ts:3078`, gating |
| Bash risk brain | `BLOCKED_BASH_PATTERNS`/`COMPOUND_OPERATOR_PATTERN`/`SAFE_BASH_PATTERNS`/tiers | `SafetyClassifier.ts:26,76,88` |
| Suspend→await→approve state machine (template) | `CollaboratorPool._gateToolUse` | `CollaboratorPool.ts:547` |
| Fence untrusted results (both nonces) | `_fenceLocalToolResult` | `ChatViewProvider.ts:7199,7326` |
| Undo local edits | `CheckpointManager.snapshot`/`rewindTo` | `CheckpointManager.ts:141,152` |
| Modal default-DENY for shell/deploy | `_confirmModelDevServerCommand` | `ChatViewProvider.ts:6418,6437` |
| Directive protocol (fallback front-end) | `MystiTagScanner` | `mystiDelegateParser.ts` |
| Test-loop read side | `MystiLocalTools.diag` + post-action pulse | `ChatViewProvider.ts:7320` |
| Background/durable exec | `BackgroundJobManager` | — |
| Authority clamping | `settingsClamp` | `settingsClamp.ts` |
| Capable pinned model | `mysti.mysti.coordinatorModel` + QuickPick | `package.json`; `CoordinatorModelClient.ts` |
| Effort-scaled governors (add write/bash cap) | `gov` block | `ChatViewProvider.ts:6840` |

**BUILD (new):**
1. `src/services/MystiLocalExec.ts` — the executor chokepoint.
2. `src/services/MystiSandbox.ts` — Seatbelt / bwrap+seccomp / Windows allowlist-only. **The most expensive item.**
3. New directive kinds `write`/`edit`/`patch`/`bash`/`git` (extend `MystiDirectiveKind`/`ALL_MYSTI_KINDS`/`_kindRegex`/`_parse`, `mystiDelegateParser.ts:43,63`).
4. Patch engine (parse+validate+atomic apply).
5. Native tool-calling path (Phase 4).
6. `mysti.mysti.localExecution` setting (+ weak-model warning) and a local write/bash governor.
7. System-prompt rewrite: `_mystiAgenticSystemPrompt` currently states *"You CANNOT write files or run commands yourself"* (`ChatViewProvider.ts:7861`) → conditional on the capability flag, describing the new gated tools + UNTRUSTED-results reminder.

## B8. Risks & non-goals

**Risks:** the **sandbox is the linchpin and hardest part** (a broken profile is worse than none — ship `bash` last, network-off, capable-model-gated, Windows honestly allowlist-only). **Weak-model misuse** (block-list + compound-reject + gate + off-by-default). **Re-introducing an ungated model→shell path** (mitigate architecturally — *all* exec through `MystiLocalExec`; add a lint/test asserting no `spawn(…,{shell:true})` outside the sandbox wrapper + `DevServerManager`/`CheckpointManager` chokepoints). **Gate fatigue** (fast-path + checkpoint-undo + clear autonomous caps). **God-object growth** (all new logic in `MystiLocalExec`/`MystiSandbox`; `ChatViewProvider` only calls in).

**Non-goals:** web fetch/search as a coordinator-local tool (keep deferring to backends — widens injection surface for no parity gain); Mysti as an MCP *server*; removing delegation (local exec *complements* it — "investigator + local actor + orchestrator"); any "trusted coordinator" mode that skips the gate.

---

**Implementer TL;DR:** build `MystiLocalExec` as the single gated chokepoint; add `write`/`edit`/`patch`/`bash`/`git` as twin directive-kinds + function-schemas that reuse `_safeResolve` + `looksLikeSecret` + `SafetyClassifier` + `_shouldGateToolUse`/`requestPermissionInline` + `CheckpointManager` + `_fenceLocalToolResult` **verbatim**; sandbox `bash` (Seatbelt/bwrap; Windows allowlist-only); keep it off-by-default and tie the fast path to a pinned capable coordinator model — **capabilities up, authority unchanged.**
