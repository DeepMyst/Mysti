# Plan 39 — Manage Plugins

- **Date:** 2026-09-25
- **Status:** DRAFT — design approved in chat, no code written
- **Inputs:** Local `--help` / read-only `list` runs of every installed CLI; a latest-release survey of all 15 backends (npm, PyPI, GitHub releases, official docs); Claude Code's VS Code docs (<https://code.claude.com/docs/en/vs-code.md>, "Manage plugins").
- **Trigger:** User request for the Claude Code VS Code extension's "Manage plugins" functionality in Mysti, extended to every backend that has a plugin system.

---

## Goal

One editor tab where the user browses, installs, toggles, updates and removes plugins for **any** backend that has a plugin system, the way Claude Code's VS Code extension does it for Claude. Each backend shows exactly what its own CLI reports: never a merged catalog, and never a config file Mysti edited behind the CLI's back.

## Non-goals

- **A merged cross-backend catalog.** Default marketplaces barely overlap, and the same name does not mean the same plugin.
- **Writing other tools' config files** to fill gaps where a CLI has no command (Codex enable/disable, OpenCode uninstall). A missing command becomes a note in the UI.
- **Giving Claude plugins to the other 14 backends** through Mysti's persona/skill system. That is a new trust surface, and a separate plan if ever.
- **Kimi** (plugins can only be managed interactively in its `/plugins` TUI), **Continue** (no plugin system), **Ollama / LocalAI / OpenRouter** (HTTP APIs with nothing to install).
- **A model-reachable install path of any kind** (see §4).

---

## 1. What each backend offers (verified 2026-09-25)

| Backend | Latest checked | JSON installed | JSON catalog | Enable/disable | Marketplaces | Quirks the adapter owns |
|---|---|---|---|---|---|---|
| Claude Code | 2.1.282 | `plugin list --json` | `list --json --available` → `{installed, available}` | CLI, user/project/local | `marketplace add/list --json/remove/update` | Refuses to install non-interactively when the marketplace declares a command, unless `-y` or `--accept-command <sha256>` is passed. `details <id>` works only once a plugin is on disk. **A failed `install` exits 0** (verified 2026-10-01: `✘ Failed to install plugin …`, exit 0); with `--json` it returns `{"outcome":"failed","failureCode":"not_found","message":…}`, so the adapter reads `outcome`, never the exit code. |
| Copilot | 1.0.89 | `plugin list --json` (shape from docs) | `marketplace browse <m> --json` | CLI | Claude-compatible; defaults `copilot-plugins`, `awesome-copilot` | User scope only. |
| OpenClaw | 2026.9.6 | `plugins list --json` | `plugins search --json` (ClawHub), `marketplace entries --json` | CLI | Reads Claude marketplaces | Arbitrary sources and non-TTY uninstall need `--force`. |
| Hermes | 2026.9.24 | `plugins list --json` | `plugins search --json` with `capabilities.provides_hooks` … | CLI | Curated catalog, no add | Pass `--enable`/`--no-enable` to avoid the "Enable now?" prompt. |
| Codex | 0.157.0 | `plugin list --json` | `list --json --available` (4,777 entries) | **none** (config.toml / TUI) | `marketplace add/list/upgrade/remove --json` | A failed remote catalog fetch exits 0 with `installed: []` and a stderr warning. |
| Gemini | 0.61.0 | `extensions list -o json` — **written to stderr** | undocumented `geminicli.com/extensions.json` | CLI, user/workspace | none (installs from git URLs) | Needs `--consent` / `--skip-settings`. |
| Qwen | 0.24.5 | **text only** | none | CLI, user/project | `extensions sources` (Claude format), text only | Needs `--consent`. |
| Cline | 3.0.65 | none (read `~/.cline/plugins/`) | none | TUI only | none | Only `install`/`uninstall --json`. |
| OpenCode | 1.18.32 | `debug config` → `plugin[]` | none | none (edit config) | none (npm modules) | `opencode plugin <mod> [-g]` installs; there is no uninstall command. |
| Cursor | 2026-08-26 | none | none | TUI/IDE | `agent plugin marketplace add/list/update/remove` | No non-interactive install. JSON field names unverified. |

**Not verified:** Copilot's list JSON shape (nothing was installed locally, so it comes from the docs); Cursor's JSON field names; the exact stderr Claude prints when it needs `--accept-command`.

---

## 2. Architecture

New files follow the Connections panel pattern (`ConnectionsPanelManager` + `connectionsContent.ts` + `media/connections/`):

| File | Responsibility |
|---|---|
| `src/services/plugins/PluginAdapters.ts` | The contract, the `run` helper, and `PLUGIN_ADAPTERS: Record<ProviderType, PluginAdapter \| null>`. It is a total Record, the same convention as `NATIVE_COMMAND_SOURCES`, so a 16th provider without an entry fails `tsc`. |
| `src/managers/PluginsPanelManager.ts` | Opens and reveals the tab, handles messages from its own webview only, runs the install gate, serializes actions per backend, and re-lists after every action. |
| `src/webview/pluginsContent.ts` + `media/plugins/{index.html,plugins.js,plugins.css}` | The template loader (nonce, CSP, cached template) and the panel UI. |

### 2.1 Adapter contract

An operation is supported **if and only if its method exists**. There is no parallel capability flag that could drift out of sync.

```ts
type PluginScope = 'user' | 'project' | 'local';

interface PluginComponents {           // `unknown` when the backend cannot say before install
  hooks: number; mcpServers: number; lspServers: number;
  skills: number; agents: number; commands: number;
}

interface InstalledPlugin { id: string; name: string; version?: string; scope: PluginScope; enabled?: boolean; marketplace?: string; error?: string }
interface CatalogPlugin   { id: string; name: string; description?: string; marketplace?: string; installCount?: number }
interface PluginListing   { installed: InstalledPlugin[]; available?: CatalogPlugin[]; warning?: string }
interface Approval        { acceptCommandSha?: string; force?: boolean; consent?: boolean }  // only ever set by the §4 modal

interface PluginAdapter {
  scopes: PluginScope[];
  minVersion?: string;                  // compared against the CLI version Mysti already caches
  list(run: Run): Promise<PluginListing>;
  search?(run: Run, query: string): Promise<CatalogPlugin[]>;  // query-only catalogs: OpenClaw (ClawHub), Hermes
  install?(run: Run, id: string, scope: PluginScope, approved?: Approval): Promise<void>;
  uninstall?(run: Run, id: string, scope: PluginScope): Promise<void>;
  setEnabled?(run: Run, id: string, on: boolean, scope: PluginScope): Promise<void>;
  update?(run: Run, id: string, scope: PluginScope): Promise<void>;
  components?(run: Run, entry: CatalogPlugin): Promise<PluginComponents | 'unknown'>;
  marketplaces?: { list; add; remove; refresh };
  note?: string;                        // e.g. "Enable/disable: use /plugins inside Codex"
}

// A backend with no CLI surface but a plugin system elsewhere is just a note.
const PLUGIN_ADAPTERS: Record<ProviderType, PluginAdapter | { note: string } | null>;
```

- **`run`** is `execFile(cliPath, argv)` with **no shell**. It returns `{ code, stdout, stderr }`, applies a timeout (30s to list, 5 min to install/update) and SIGKILLs on expiry. `cliPath` comes from the provider's `getCliPath()`, so the CLI Mysti discovered is the one it runs. It differs from `BaseCliProvider._runCliForDiscovery` only in keeping stderr, which becomes the error text in the UI.
- **Which backend each adapter serves:** Phase 1 fills `claude-code`, `github-copilot`, `openclaw` and `hermes`. Every other entry is `null`, except `kimi-code`: `{ note: "Manage with /plugins inside Kimi" }`.

### 2.2 Data flow

1. **Open.** The panel opens via `mysti.managePlugins`, `/plugins` (`cmd:plugins` in `SlashCommandManager`; Mysti's name wins when typed, per the existing rule), or the agent menu.
2. **Pick a backend.** It defaults to the active agent. A backend with no adapter, or whose CLI is not found, is greyed out with the reason.
3. **List.** `list()` runs and the result is rendered. **The CLI is the source of truth:** after every action the panel re-lists. Nothing is updated optimistically, and nothing is cached across panel opens.
4. **Serialize.** Each backend has a promise chain, because two `claude plugin install` runs write the same `installed_plugins.json`. Different backends run in parallel.
5. **Apply to open chats.** After any successful change, `PluginsPanelManager` calls `provider.markPluginsChanged()`, which increments a per-provider `pluginGeneration`.
   - `BaseCliProvider` records that number in `session.persistentSettings` at spawn, and `_persistentSettingsMatch` compares it.
   - The existing check before each turn ([BaseCliProvider.ts:990](../src/providers/base/BaseCliProvider.ts)) then respawns the persistent process on the **next message**, never mid-turn.
   - Claude reattaches with `--resume`. Hermes and Kimi override `_persistentSettingsMatch` by calling `super`, so they inherit the behaviour.
   - Providers that spawn a new process each turn need nothing.
   - The panel shows "Applies from your next message." The one respawn is also a cold prompt cache, the same cost as Claude's own `/reload-plugins`.

---

## 3. UI

Claude's dialog, laid out as a tab.

- **Header:** a backend dropdown and a refresh button.
- **Plugins tab:** one search box filters both lists.
  - **Installed:** name, marketplace, version, a scope badge, the on/off toggle (only if `setEnabled` exists), and a ⋯ menu with Update, Uninstall and Details. CLI-reported load errors (Claude's `errorDetails`) show as a warning badge.
  - **Available:** name, description, marketplace, and install count when the backend provides one. **Install** opens an inline scope chooser (*For you / This project / Just me, this repo*) when `scopes.length > 1`.
  - **Render cap:** 100 matching rows, then "N more — refine your search". Codex's catalog has 4,777 entries.
- **Marketplaces tab** (only if `marketplaces` exists): an add field (`owner/repo`, git URL or path), and a refresh icon and a remove icon on each row.
- **Row state:** a spinner while an action runs. On failure the CLI's stderr appears inline under that row, which then re-enables.
- **Notes:** an adapter `note` renders as one quiet line under the header.

---

## 4. Trust and safety

A plugin is not just prompt text:
- **Hooks** run shell commands on CLI events, inside the CLI, **outside Mysti's stream-level permission gate**. `read-only` access does not stop them.
- **MCP and LSP servers** are local processes.

### 4.1 Install gate: confirm when a plugin runs code, and fail closed

`needsConfirmation(c) = c === 'unknown' || c.hooks > 0 || c.mcpServers > 0 || c.lspServers > 0`.

- **Hermes, OpenClaw and Gemini** report capabilities in their catalog.
- **Claude, Copilot and Codex** don't report components before install. `components()` reads the plugin's manifest **read-only** from the marketplace copy already on disk (the `installLocation` from `marketplace list --json`):
  - `plugin.json` keys `hooks` / `mcpServers` / `lspServers`;
  - the default files `hooks/hooks.json`, `.mcp.json`, `.lsp.json`.
  - A remote source (`git-subdir`, `url`) and anything else not on disk is `'unknown'`. Reading is allowed under the "CLI commands only" rule, which governs **writes**.
- **The modal** lists the executable components and says: *"Hooks run shell commands on Claude Code events, outside Mysti's per-tool approval — even in read-only mode."*
- **After install**, when `details` is available (Claude), the panel shows the real inventory.

### 4.2 No silent consent flags

- **Claude's `-y` is never passed.** When the CLI refuses because a marketplace declares an install-time command, the modal shows **that exact command**, and approval reruns with `--accept-command <sha256>`, pinned to what the user saw.
  - If the stderr gives no hash, the panel shows the error and does not offer the override.
  - This follows the `_confirmModelDevServerCommand` precedent.
- **OpenClaw's `--force`**, and Gemini's and Qwen's `--consent`, are passed only after the same modal.

### 4.3 Other confirmations

- **Adding a marketplace** is confirmed, because it expands what the user trusts.
- **Removing a marketplace** is confirmed, because on Claude it also uninstalls every plugin from it.
- **Uninstall and toggles** are not confirmed.

### 4.4 Invariants

- **Only a human can install.** No directive, native tool, slash expansion or chat message reaches an adapter mutation. `/plugins` opens the panel and does nothing else. `PluginsPanelManager` handles messages only from its own webview.
- **Workspace trust:** `project` and `local` scopes require `vscode.workspace.isTrusted`. In Restricted Mode those choices are disabled, and user scope still works.
- **Nothing else is written:** Mysti writes no plugin state itself. Every mutation is the backend's own CLI command, with argv built by the adapter and no shell.

---

## 5. Errors — unknown is not zero

| Situation | Behaviour |
|---|---|
| Non-zero exit, or a JSON `outcome` other than success | The CLI's message inline under the row; the row re-enables; the panel re-lists. Exit 0 is never taken as success on its own (Claude exits 0 on a failed install). |
| Output doesn't parse | "Couldn't read Codex's plugin list (0.157.0)" plus a link to the raw output in the Mysti output channel. **Never** rendered as an empty list. |
| Codex catalog failure (`installed: []` + stderr warning) | `listing.warning`: "Codex couldn't reach its catalog; the installed list may be incomplete" |
| Gemini writes JSON to stderr | The adapter parses stderr |
| Timeout | Process killed; the row shows "timed out" |
| CLI older than `minVersion` | "Update Copilot to 1.0+ to manage plugins", linking to `/update` |
| Panel closed mid-action | The action completes; nothing renders |

---

## 6. Testing

Run `npm test` and `npm run typecheck` before and after (CLAUDE.md).

- **Adapter parsing:** each Phase-1 adapter's `list()` against **real captured CLI output**, trimmed into `tests/fixtures/plugins/` (Claude `list --available`, OpenClaw `list`, Copilot `marketplace browse`; Hermes from its source's JSON output).
- **argv:** each mutation builds the exact argv expected. Scope flags are right; `-y` and `--force` **never** appear without an `Approval`; no shell is used.
- **Gate:** a truth table where `'unknown'`, hooks, MCP or LSP mean confirm, and skills, commands or agents alone mean no confirm. Also `components()` against a fixture marketplace directory: a relative source with and without `hooks/hooks.json`, and a remote source returning `'unknown'`.
- **Manager, with a fake `run` and a mocked `showWarningMessage`:**
  - declining means the CLI is never called;
  - Restricted Mode refuses project scope;
  - messages from another webview are ignored;
  - two installs on the same backend run in sequence;
  - `markPluginsChanged` is called only after a successful mutation.
- **Respawn:** with `pluginGeneration` bumped, `_persistentSettingsMatch` returns `false`, so the next send respawns. Unchanged, it returns `true`.
- **Exhaustiveness:** `PLUGIN_ADAPTERS` keys equal `ProviderType` (tsc, plus a line in `providerManifest.test.ts`).
- **Browser suite:** the panel renders a listing, search filters it, and the 100-row cap holds.
- **Manual F5 check:** install, toggle and uninstall one skills-only plugin on real Claude Code; install one with hooks and confirm the modal appears; send a message and confirm the persistent process respawned.

---

## 7. Phases

- **Phase 1 — panel + four full-support backends.** Everything above, with adapters for Claude Code (full parity with its VS Code panel, including marketplaces), Copilot, OpenClaw and Hermes. Kimi gets its note. Adds the `mysti.managePlugins` command, the `/plugins` slash entry, the agent-menu item, and `pluginGeneration` in `BaseCliProvider`.
- **Phase 2 — the six partial backends**, each limited to what its CLI allows:
  - **Codex:** list, install, remove and marketplaces; enable/disable becomes a note; the catalog-failure warning.
  - **Gemini:** JSON from stderr, `--consent`; the catalog is install-by-URL only, since the web feed is undocumented.
  - **Qwen:** installed list parsed from text, or skipped if too brittle.
  - **Cline:** install/uninstall plus a read-only list from `~/.cline/plugins/`.
  - **OpenCode:** list via `debug config` plus install; uninstall becomes a note.
  - **Cursor:** marketplaces only.
- **Before Phase 2:** re-verify each of these CLIs' latest release. When the provider-native commands catalog was built (2026-09-06), every installed CLI had drifted from its latest release.
