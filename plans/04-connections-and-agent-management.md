# Plan 04 — Connections & Agent Management (MCP "My Connections", In-Chat Connect Flow, Agent/Skills Management & Discovery)

Date: undefined
Status: DRAFT — **superseded architecture below (2026-06-13): DeepMyst-brokered**

---

## ⭐ REVISED ARCHITECTURE — DeepMyst-brokered MCP (2026-06-13, decided with user)

The original plan below assumed Mysti has **no backend** and writes each CLI's own
MCP config locally (with local third-party keys). The user chose a **DeepMyst-brokered**
model instead: the user authenticates with DeepMyst (Clerk), and **DeepMyst holds all
third-party connection credentials** — nothing sensitive lives locally.

### How it works (grounded in the DeepMyst 2.0 backend)

- **Auth.** DeepMyst's core-api (`src/core/auth.py`) accepts two credentials:
  Clerk JWT (web users) **and** a machine-to-machine **API key with the `dm_` prefix**,
  sent as `Authorization: Bearer dm_…` (or `X-API-Key: dm_…`). A VSCode extension can't
  hold a short-lived Clerk JWT, so Mysti's credential is the `dm_` key, which the user
  mints from the DeepMyst dashboard after signing in with Clerk.
- **MCP brokering.** DeepMyst exposes each agent (and built-in servers) as a JSON-RPC MCP
  endpoint: `POST /api/v1/mcp/{slug}` (`initialize` / `tools/list` / `tools/call`), built-ins
  at `POST /api/v1/mcp/builtin/{name}`, listed via `GET /api/v1/mcp/builtin`. The user's
  connected third-party services (GitHub, Slack, …) surface as tools on a DeepMyst agent.
- **Wiring into the local CLIs.** Mysti writes the DeepMyst MCP endpoint URL +
  `Authorization: Bearer dm_…` into each backend CLI's own MCP config (`.mcp.json`, codex
  `config.toml`, gemini/qwen settings, …). The local CLIs (Claude Code, etc.) then reach
  the user's DeepMyst-brokered tools directly — **zero local third-party keys**.
- **Connection management.** The real OAuth to third parties happens in DeepMyst's web
  dashboard; Mysti links out (`openExternal`) to manage, and reads status via the API.

### Phasing (revised)

- **Phase 1 — Auth foundation (DONE 2026-06-13).** `DeepMystClient` (dm_ Bearer auth,
  MCP endpoint URL builder, `validateKey`, `listBuiltinMcps`) + `DeepMystAuthManager`
  (sign-in via `openExternal` + paste/deep-link `dm_` key, SecretStorage, sign-out,
  `onDidChangeAuth`). Commands `mysti.deepmyst.signIn`/`signOut`; settings
  `mysti.deepmyst.apiUrl`/`webUrl`; UriHandler `vscode://DeepMyst.mysti/deepmyst-auth?key=`.
  21 tests. Suite green.
- **Phase 2 — Connections UI.** A panel showing auth status + the user's connected
  services/agents (from the DeepMyst API) + "Manage connections" (openExternal to the
  dashboard) + per-backend "enable MCP" toggles.
- **Phase 3 — MCP config wiring.** Per-CLI adapters that write/remove the DeepMyst MCP
  endpoint in each backend's MCP config (idempotent, subtree-preserving) when the user
  enables a connection; keyed off `DeepMystAuthManager` state.
- **Phase 4 — In-chat connect flow.** Agent signals a needed connection mid-chat → inline
  connect card → `openExternal` to DeepMyst → resume on next turn.
- **Agent/skills management** (original Plan 04 §4–6) is unchanged and independent.

### DeepMyst-side requirements (other repo — for the user to confirm/implement)

1. **`dm_` key minting after Clerk sign-in.** The dashboard's API Keys page already
   creates `dm_` keys (`/api/v1/keys`). Best UX: a "Connect VS Code" page that, after
   Clerk sign-in, mints a Mysti-scoped `dm_` key and deep-links back to
   `vscode://DeepMyst.mysti/deepmyst-auth?key=dm_…`. Until that exists, the paste flow
   (copy key from dashboard → paste into Mysti) works today.
2. **MCP transport compatibility.** Backend CLIs expect MCP Streamable-HTTP for `type:http`
   servers. DeepMyst's `POST /api/v1/mcp/{slug}` returns JSON-RPC results directly — confirm
   each target CLI accepts a JSON-response (non-SSE) streamable-HTTP server, or add an SSE
   variant. (Verify during Phase 3 against Claude Code first.)
3. **Production URLs.** Confirm `mysti.deepmyst.apiUrl` (default `https://api.deepmyst.com`)
   and `webUrl` (default `https://app.deepmyst.com`).
4. **Connections list API.** An endpoint returning the user's connected services + available
   agents (slugs) so Mysti's Phase 2 UI can show status and Phase 3 can pick the agent slug
   to wire. (May already exist under datasources/agents domains — confirm.)

---

## Goal

Bring DeepMyst 2.0's connections and agent-management experience to Mysti, adapted to a VSCode extension with no backend and 12 CLI backends:

1. **My Connections** — a first-class UI for browsing an MCP server catalog, connecting/disconnecting servers, seeing per-server status, and handling auth (API keys, OAuth) within VSCode's constraints.
2. **In-chat connect flow** — the agent can signal mid-conversation that it needs an external connection; the chat renders an inline connect card; completing the connection lets the conversation resume with the new tools available (mirroring DeepMyst's `request_connector` → `connector_required` SSE → ConnectorBlock → implicit next-turn resume handshake, re-expressed in Mysti's `StreamChunk`/`WebviewMessage` protocol).
3. **Propagation** — one logical connection is written into each backend CLI's own MCP config file format (Claude Code `.mcp.json`, Codex `config.toml`, Gemini/Qwen `settings.json`, etc.), with Mysti acting as a *unified config writer + status reader* rather than an MCP broker.
4. **Agent management** — personas and skills become manageable entities (list, inspect, create, edit, delete, override) instead of read-only markdown dropped in directories, modeled on DeepMyst's agents feature.
5. **Skills discovery** — registry browse-and-install plus a scaled-down local skills-mining pipeline (draft → review → promote), adapted from DeepMyst's Haiku-scout/Opus-structuring miner to Mysti's three-tier `AgentLoader`.

Non-goals (v1): exposing Mysti itself as an MCP server (DeepMyst's inbound `domains/mcp/` equivalent); a raw outbound MCP JSON-RPC client inside the extension (the CLIs own the MCP runtime); multi-tenant/per-user scoping (Mysti's scope is machine + workspace).

---

## Current State

Grounded in the working tree (branch `feature/visual-testing`).

### MCP: essentially nonexistent in Mysti today

- The only MCP reference in the entire `src/` tree is Codex stream parsing: `src/providers/codex/CodexProvider.ts:534` documents `mcp_tool_call` events and `:755` routes them through generic tool-call handling. No other provider, manager, or setting mentions MCP.
- There are **zero** `mysti.*` settings for MCP in `package.json` (settings span lines 203–1260; nothing connection-related).
- No code reads or writes any CLI's MCP config file (`.mcp.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, …). Users must configure MCP per-CLI by hand, outside Mysti, per CLI format.
- `ProviderCapabilities` (`src/types.ts`) has flags like `supportsNativeCompact`/`supportsImages` but no MCP-related flag.

### Seams the connect flow can reuse (all confirmed)

- **StreamChunk union** — `src/types.ts:278-290`. Already includes `ask_user_question` with a structured payload (`AskUserQuestionData`, `src/types.ts:269-276`), proving the pattern "provider-agnostic structured chunk → inline interactive card → response routed back" exists end to end. A `connection_required` chunk is a sibling, not a new concept.
- **WebviewMessage** — `src/types.ts:185-188` is a loose `{type, payload}` envelope; new message types need no schema migration.
- **Inline interactive cards** — the permission pipeline: `PermissionManager.requestPermission` posts `type: 'permissionRequest'` (`src/managers/PermissionManager.ts:121`) and `permissionExpired` (`:202`); `ChatViewProvider.requestPermissionInline` (`src/providers/ChatViewProvider.ts:4194-4236`) wraps it with autonomous auto-decide. The gate intercepts `tool_use` chunks at `ChatViewProvider.ts:2540`, `:2871` (main), `:695` (mentions), via `_shouldGateToolUse` (`:4257`).
- **Text-marker protocol precedent** — ChannelBridge already injects prompt instructions and detects `<<<CHANNEL_SEND ...>>> ... <<<END_CHANNEL_SEND>>>` markers in the accumulated assistant text (`src/managers/ChannelBridge.ts:22-27`, `detectMarkers` at `:280`, invoked from `ChatViewProvider.ts:2802` on every text chunk). This is exactly the mechanism the connect signal needs, since Mysti cannot inject a custom `request_connector` tool into spawned CLIs. Known weakness to avoid copying: the snippet contains literal marker examples the model can echo, and there is no nonce (research `mysti-managers-collab.md` improvement #2).
- **Dedicated dashboard panel precedent** — visual testing ships a standalone webview panel (`src/webview/visualTestDashboardContent.ts`, command `mysti.openVisualTestDashboard`, `package.json:163`), the right template for a Connections hub that shouldn't live inside the chat sidebar.
- **Slash command system** — `SlashCommandManager` sections (`src/managers/SlashCommandManager.ts:61-68`: context/model/customize/commands/settings/support), legacy map (`:71-90`), `executeCommand` switch (`:150+`). Adding `/connections`, `/agents`, `/skills` is mechanical.

### Agent system: loadable but not manageable

- **AgentLoader** (`src/managers/AgentLoader.ts`) implements the three-tier system: source dirs in priority order core → plugin → user (`~/.mysti/agents`) → workspace (`.mysti/agents`) (`:92-123`); Tier 1 `loadAllMetadata` (`:129-170`); Tier 2 `loadInstructions` (`:176-208`); Tier 3 `loadFull` (`:214-242`); `reload()` (`:286-292`).
- Known defects that block a management UI (confirmed in `mysti-managers-collab.md` §8):
  - Duplicate ids across sources: `_metadataCache` dedupes (last source wins) but the **returned arrays push every file** (`AgentLoader.ts:144,160`), so any UI listing shows duplicates; and `_agentTypes` is keyed globally so a workspace *skill* reusing a core *persona* id reclassifies it and `getPersonas()` drops it (`:143,160` + `:304-313`).
  - Section extraction fragility: `sectionName` interpolated unescaped into a RegExp requiring exactly `## Name\n` (`:447-451`); first-paragraph fallback can return the literal `# Title` (`:426-442`).
  - `findMatchingAgents` name match inverted (`:272` — asks whether short name contains the whole query).
  - **No file watcher**: agents load once at activation (`ChatViewProvider.ts:306`, `_initializeAgents` `:312-331`); edits to `.mysti/agents/**` require a window reload.
- **AgentContextManager** (`src/managers/AgentContextManager.ts`) exposes `getAllPersonas` (`:237`), `getAllSkills` (`:244`), `getAgentDetails` (`:251`), `getRecommendations` (`:91`), `buildPromptContext` (`:158` — token-budgeted Tier-2 injection). This is Mysti's existing equivalent of DeepMyst's `render_skills_block` (concat skill bodies into the system prompt).
- **UI today**: personas/skills are flattened into the settings payload for the chat webview (`ChatViewProvider.ts:480-502`) and surfaced via dropdown-ish settings (per-provider `mysti.agents.<provider>Persona` enums, `package.json:666-963`) plus `agentRecommendations`/`getAgentDetails` messages (`ChatViewProvider.ts:1291-1297`, `:1318-1330`). There is no create/edit/delete, no source visibility, no skill picker with bodies.
- **Skills acquisition today**: `scripts/sync-agents.js` — a build-time/manual Node script with a hardcoded `CURATED_PLUGINS` list pulled from `wshobson/agents` into `resources/agents/plugins/` with a 24h cache. No in-product discovery, no registry search, no mining.

### What DeepMyst does that we are adapting (from `/tmp/mysti-planning/research/deepmyst-mcp-connections.md`)

- Connection rows `pending | connected | failed | revoked`, per-user, brokered via Smithery; 2s poll / 5min re-arm; per-card busy keys; "My connections" + "Browse catalog" two-tab hub; per-agent slots panel.
- In-chat: always-on `request_connector` meta-tool → side-effect-free sentinel → typed `connector_required` SSE + clean `{"status":"awaiting_user_connection"}` tool_result → inline ConnectorBlock → modal → poll → flip to connected → **implicit resume** (tools rebuilt from connected servers at the start of every turn).
- Skills: SKILL.md packs (builtin/registry/uploaded) concatenated into the system prompt; Smithery skills registry (search + body fetch, 1h TTL); mining pipeline producing `SkillDraft` rows (pending/approved/rejected, confidence, `source_hash` dedup) reviewed in an admin UI.
- Security rules to copy verbatim: model-derived strings are display-only and never auto-connect; sentinel never enters LLM history; strict host matching for broker URLs; https-only setup URLs; fault-tolerant tool building (one bad server contributes zero tools, never breaks chat).

### Relevant cross-cutting bugs that interact with this plan

- `ProviderManager.cancelRequest` resolves the global default provider, not the panel's (`src/managers/ProviderManager.ts:228-243`) — connect-card flows that cancel/restart a stream must not assume cancel works for per-panel overrides until the stabilization plan fixes it.
- Canvas precedent stores API keys in plaintext settings (`mysti.canvas.openaiApiKey`, `package.json:1209`) — flagged in `mysti-canvas-current.md`; this plan must use `SecretStorage` from day one.
- Cline `.clinerules` clobbering under concurrency (`mysti-providers.md`) — a cautionary tale for any feature that writes user-owned config files: all CLI-config writes here must be atomic with backups.

---

## Proposed Design

### D1. McpConnectionsManager + per-CLI config adapters (the substrate)

Mysti has no backend and no broker, so "connection management" = **writing MCP server entries into each CLI's own config + reading status back**. New manager `src/managers/McpConnectionsManager.ts` owning:

- **Logical connection registry** (persisted in `globalState` key `mysti.connections.v1`):

  ```ts
  interface McpConnection {
    id: string;                      // slug, unique
    displayName: string;
    description?: string;
    iconUrl?: string;                // cached from catalog at connect time (DeepMyst pattern)
    transport: 'stdio' | 'http' | 'sse';
    spec: { command: string; args: string[]; env?: Record<string,string> }   // stdio
         | { url: string; headers?: Record<string,string> };                 // http/sse
    secretKeys?: string[];           // names of env vars / headers whose values live in SecretStorage
    scope: 'global' | 'workspace';   // user-level vs project-level config files
    targets: ProviderType[];         // which CLIs this is propagated to
    status: Record<string /*ProviderType*/, McpTargetStatus>;
    source: 'catalog' | 'manual' | 'imported';  // imported = discovered in an existing CLI config
    createdAt: number; updatedAt: number;
  }
  type McpTargetStatus = 'configured' | 'needs-auth' | 'error' | 'unsupported' | 'not-configured';
  ```

  This adapts DeepMyst's `McpUserConnection` row (`pending|connected|failed|revoked`) to a per-CLI matrix: the per-target statuses replace the single broker status; `pending` becomes `needs-auth` (auth happens in the CLI or browser, not in Mysti).

- **Adapter interface** `src/services/mcp/IMcpConfigAdapter.ts`:

  ```ts
  interface IMcpConfigAdapter {
    providerType: ProviderType;
    supported: boolean;                          // Ollama/LocalAI/Manus → false
    configPath(scope: 'global'|'workspace'): string | null;
    read(scope): Promise<McpServerEntry[]>;      // parse existing entries (discovery/reconcile)
    upsert(conn: McpConnection, scope): Promise<void>;   // atomic write w/ backup
    remove(connId: string, scope): Promise<void>;
    verify(conn): Promise<McpTargetStatus>;      // re-read + optional CLI probe
    authHint(conn): { kind: 'none'|'terminal-command'|'external-url'; command?: string; url?: string };
  }
  ```

- **Per-CLI formats** (initial matrix; Phase 1 includes a verification task per row since CLI formats drift):

  | Provider | Global config | Workspace config | Format |
  |---|---|---|---|
  | claude-code | `~/.claude.json` (per-project `mcpServers`) | `.mcp.json` at repo root | JSON `{"mcpServers": {name: {command,args,env} \| {type:"http",url,headers}}}`; prefer writing `.mcp.json` + offering `claude mcp add` for user scope |
  | openai-codex | `~/.codex/config.toml` | — | TOML `[mcp_servers.<name>]` `command/args/env`; newer CLIs also `codex mcp add` |
  | google-gemini | `~/.gemini/settings.json` | `.gemini/settings.json` | JSON `mcpServers` key (`command/args/env` or `url`/`httpUrl`) |
  | qwen-code | `~/.qwen/settings.json` | `.qwen/settings.json` | Gemini-CLI fork; same `mcpServers` shape (verify) |
  | cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` | JSON `mcpServers` |
  | github-copilot | `~/.copilot/mcp-config.json` | — | JSON `mcpServers` (verify exact filename/shape) |
  | cline | `cline_mcp_settings.json` (extension globalStorage; CLI path TBD) | `.clinerules`-adjacent? | **verify before enabling**; default `unsupported` until confirmed |
  | opencode | `~/.config/opencode/opencode.json` | `opencode.json` | JSON `mcp` block `{name: {type:"local"|"remote", command/url}}` (verify) |
  | openclaw | TBD | TBD | research task; default `unsupported` |
  | ollama / localai | — | — | `unsupported` (raw HTTP chat APIs, no MCP client) |
  | manus | — | — | out of scope (unregistered provider) |

- **Write discipline** (Cline-clobber lesson): read-modify-write only the `mcpServers`-equivalent subtree, preserve unknown keys and comments where format allows (TOML: use a low-risk targeted edit strategy — parse with `@iarna/toml` or do section-scoped string splicing; never re-serialize the whole file if it loses comments), write to `<file>.tmp` + rename, keep one `.mysti-backup` per file per session, and diff-log every write to the output channel.
- **Secrets**: env values/headers marked secret are stored via `context.secrets` (`mysti-mcp:<connId>:<key>`); config files receive the literal value only for CLIs that can't do env indirection, and the UI warns when a plaintext write is unavoidable. Never store keys in `mysti.*` settings (explicitly diverging from the canvas precedent).
- **Reconcile on activation** (lazy, after startup — do not worsen the serial-discovery startup cost flagged in `mysti-performance.md`): read all adapter configs, import unknown entries as `source:'imported'` logical connections, recompute the status matrix. CLI config files remain the source of truth; `globalState` is a cache + metadata layer (DeepMyst translation §9: "Postgres rows → globalState with CLI config files as source of truth").

### D2. Catalog ("Browse")

Two catalog sources behind one interface (`src/services/mcp/McpCatalogService.ts`):

1. **Bundled curated catalog** — `resources/mcp/catalog.json` (~30–50 popular servers: GitHub, Filesystem, Postgres, Slack, Jira, Sentry, Playwright, Context7, …) with `{id, displayName, description, iconUrl, transport, specTemplate, requiredSecrets:[{key,label,help}], homepage}`. Works offline, no account needed. This is the default tab content.
2. **Smithery registry search** (optional) — `GET https://registry.smithery.ai/servers?q=` from the extension host with debounce + 1h TTL cache (mirrors DeepMyst's registry client), gated behind `mysti.connections.registry.enabled` and an optional `Smithery API key` in SecretStorage. Strict host check (`registry.smithery.ai` exact match, not substring — DeepMyst's `is_smithery_host` rule).

**Auth handling within VSCode's constraints** — three lanes, surfaced by `authHint()`:

- *API-key servers*: Mysti prompts via `vscode.window.showInputBox({password:true})`, stores in SecretStorage, injects as env/header. Status → `configured` immediately.
- *Remote OAuth servers where the CLI owns auth* (e.g., Claude Code remote MCP via `/mcp`): Mysti writes the config entry, then opens an integrated terminal running the CLI's auth path (e.g., `claude mcp list` / interactive `/mcp`) and polls `verify()` every 2s for up to 5min (DeepMyst's `POLL_INTERVAL_MS`/`POLL_TIMEOUT_MS` constants, ported to `src/constants.ts`). Status `needs-auth → configured`.
- *Smithery-hosted OAuth URLs*: `vscode.env.openExternal(setupUrl)` (https-only scheme check) + extension-host polling of the Smithery connection endpoint; the resulting hosted URL is written to the CLI configs as an `http` server. This is the closest port of DeepMyst's full dance and is optional (requires user's Smithery key).

### D3. Connections UI

A dedicated webview panel (visual-testing-dashboard pattern), `src/webview/connectionsContent.ts`, opened via command `mysti.openConnections` and slash command `/connections`:

- **Tab 1 "My connections"**: cards (icon, name, description), per-CLI status chip row (the 12-column matrix collapsed to "Configured in: Claude, Gemini · Not in: Codex [+ Add]"), status filter, name search, actions: Disconnect (per-target or all), Re-run auth, Edit env/secrets, Copy to <CLI> (the per-provider-slots idea from research §9 — sync one logical connection across CLI formats, Mysti's genuinely novel feature).
- **Tab 2 "Browse catalog"**: curated grid + registry search (350ms debounce, paged), Connect button per card → target-CLI multi-select (defaults to the panel's active provider + global default) → secrets prompt → write → status chip flips. Per-card busy keyed by catalog id so parallel connects don't dead-click each other (DeepMyst §8.7).
- Status badge vocabulary and the 2s/5min poll loop copied from DeepMyst; "Re-open setup" affordance for `needs-auth`.
- A compact **per-panel slots strip** in the chat settings drawer ("This conversation's provider has N MCP servers configured · Manage"), reusing the existing settings payload plumbing at `ChatViewProvider.ts:480-510`.

### D4. In-chat connect flow (the DeepMyst handshake, re-substrated)

Mysti cannot inject a `request_connector` tool into spawned CLIs, so the **signal** changes; everything downstream mirrors DeepMyst.

- **Signal lane A — prompt marker (provider-agnostic, primary)**: a new system-prompt snippet (injected by `AgentContextManager.buildPromptContext` alongside personas) instructs the agent: *"If fulfilling the request requires an external service you have no tool for, emit exactly: `<<<MYSTI_CONNECT nonce="{nonce}" label="Jira" query="jira issues">>>reason text<<<END_MYSTI_CONNECT>>>` and then tell the user a Connect button is ready."* A per-request nonce (generated in `ChatViewProvider._handleSendMessage`, threaded into the snippet) prevents the model-echoes-the-example false positive documented for ChannelBridge. Detection runs in the same accumulated-text pass as `ChannelBridge.detectMarkers` (`ChatViewProvider.ts:~2802`); the marker is stripped from displayed/persisted text exactly like `MARKER_STRIP_REGEX` does. **Bounded-scan contract (must match Plan 03 Phase 4.2):** the detector is invoked only when the latest delta contains a marker sigil (`<<<` or `MYSTI_CONNECT`), and scans only the unscanned tail of the accumulated text from a tracked `scannedUpTo` offset minus a 64-char overlap window — never the full accumulated response per delta. Plan 03 Phase 4.2 applies exactly this discipline to the ChannelBridge/visual-test scans in this same hot path; adding an unbounded third scan here would reintroduce the O(n²) per-delta cost that plan removes.
- **Signal lane B — failed MCP tool detection (passive)**: when a `tool_use`/`tool_result` pair shows an `mcp__<server>__<tool>` name failing with not-configured/auth errors (Codex `mcp_tool_call` events at `CodexProvider.ts:755` and Claude's `mcp__` tool naming), synthesize the same event with `label = server name`. Covers the "server was disconnected/expired" case DeepMyst handles via expired-connection tool errors (§8.4).
- **New chunk + messages** (exact DeepMyst-suggested protocol from research §9):

  ```ts
  // src/types.ts — StreamChunk union gains:
  type: ... | 'connection_required'
  connectionRequired?: { callId: string; label: string; searchQuery: string; reason: string; providerType: ProviderType };

  // WebviewMessage types:
  // ext→web 'connectionRequired'  {panelId, callId, label, searchQuery, reason}
  // web→ext 'openConnectFlow'     {callId, searchQuery}        — opens Connections panel pre-searched, or inline quick-pick
  // web→ext 'connectServer'       {callId, catalogId|manualSpec, targets: ProviderType[]}
  // ext→web 'connectionStatus'    {callId, status: 'needs-auth'|'configured'|'failed', errorMessage?}
  ```

- **Card** (webview, `src/webview/webviewContent.ts`): an inline ConnectorBlock between prose segments — plug icon, reason text, primary `Connect {label}` button; flips to a green "`{label} connected` — send a message to continue" chip on `connectionStatus: configured`. Renders from the same segment pipeline as permission cards. **Model-derived `label`/`searchQuery`/`reason` are display-only; nothing auto-connects; a human click is always required** (DeepMyst §8.2, copied verbatim). All three strings are HTML-escaped (the webview-chat research flagged unescaped sinks in the permission card — do not repeat that).
- **Resume contract — none needed (implicit)**: the turn ends normally (the marker is informational; the model was instructed to wrap up after emitting it). When the user sends the next message, the CLI process is spawned/resumed and re-reads its MCP config, so the new server's tools exist — *cleaner than DeepMyst*, which has to rebuild tools per turn server-side (§5.5 / §9 "Maps directly"). The flipped card's "send a message to continue" copy encodes this. Optional sugar: an "Ask the agent to continue" button that sends a canned `"Connected {label} — please continue."` user message.
- **Persistence**: the connect card is stored on the `Message` (new optional `connectionCards` field beside the existing tool-call persistence) so restored transcripts keep it — addressing the state-restoration losses cataloged in `mysti-webview-chat.md`.

### D5. Agent management (personas/skills as manageable entities)

Evolve the existing read-only agent system into DeepMyst-style managed entities, keeping markdown files as the storage format (no DB):

- **Agents panel** — new tab in the same dedicated webview as Connections (two top-level sections: Connections / Agents & Skills), or its own panel `mysti.openAgents`; lists personas and skills with Tier-1 metadata + source badge (core/plugin/user/workspace), category filter, search.
- **CRUD**: View (Tier 3 via existing `getAgentDetails`), Create (template-scaffolded markdown into `~/.mysti/agents/<type>s/` or `.mysti/agents/<type>s/` — user picks scope), Edit (opens the markdown file in the editor — VSCode *is* the editor; no in-webview editor needed), Duplicate-to-workspace (the override workflow), Delete (user/workspace sources only; core/plugin show "Override instead").
- **Attachment model**: today personas are per-provider settings enums frozen in `package.json` (`mysti.agents.<provider>Persona`, lines 666–963) that cannot list dynamic agents. Add `mysti.agents.activePersona` / `mysti.agents.activeSkills` (string / string[]; free-form ids validated at runtime against `AgentLoader`) consumed by `AgentContextManager.buildPromptContext`, with the legacy enums kept as fallback. The panel and a `/persona` `/skills` slash command set these.
- **Loader hardening (prerequisite)**: fix the duplicate-id/array/type-clobber bugs (research §8.1), escape `sectionName` in `_extractSection`, fix `findMatchingAgents`, and add a `FileSystemWatcher` over user/workspace agent dirs feeding debounced `reload()` + a `agentsReloaded` webview message (research improvement #9).

### D6. Skills discovery (registry + mining)

- **Registry browse-and-install**: a "Discover" tab in the Agents panel backed by `src/services/SkillRegistryService.ts` with two sources: (a) the existing `wshobson/agents` sync, promoted from build script to runtime service (reuse `scripts/sync-agents.js` logic, target `~/.mysti/agents/` instead of bundled `resources/`); (b) Smithery skills registry (`GET https://registry.smithery.ai/skills?q=` for metadata, `GET /skills/{ns}/{slug}` for body — DeepMyst §6.1) with 1h TTL caches. Install = write SKILL.md (frontmatter normalized to Mysti's `id/name/description/category/activationTriggers` schema) into `~/.mysti/agents/skills/`; the file watcher picks it up.
- **Skills mining (scaled-down DeepMyst pipeline, opt-in)**: `src/managers/SkillMiningManager.ts`:
  1. *Scout*: on conversation completion (or a manual "Mine skills" action), run a single cheap classification over recent `ConversationManager` history — "does this conversation contain a transferable METHOD? answer JSON `{has_skill, topic, summary, confidence}`" — executed through the user's selected provider CLI in non-interactive mode (NOT a hardcoded warm `claude` pool; the ResponseClassifier always-on-Claude pattern is an explicit anti-pattern per `mysti-managers-collab.md` §7.1). Verdicts cached per conversation id (re-scout is a no-op, like `SkillScout` PK).
  2. *Structure*: positives above a confidence floor get a second call producing a full SKILL.md draft, written to `~/.mysti/agents/skills/drafts/<id>.md` with frontmatter `status: pending`, `confidence`, `source_hash` (sha256 over sorted source conversation ids — DeepMyst's idempotent dedup), `source_signals`.
  3. *Review*: a "Drafts" sub-tab (pending/approved/rejected filters, full-body view, confidence, approve/reject with reason). Approve = move file into `~/.mysti/agents/skills/` and strip draft frontmatter; reject = `status: rejected` retained for dedup. Caps: ≤ 3 drafts per mining run, ≤ 5 LLM calls (DeepMyst's cost-cap discipline at desktop scale).
  - Gated by `mysti.skills.mining.enabled` (default **false** — it sends conversation content to an LLM; consent-first, learning from the ResponseClassifier privacy complaint).

### D7. Settings & constants

New settings (all `mysti.connections.*` / `mysti.skills.*` namespaces): `connections.enabled` (default true), `connections.registry.enabled` (default false), `connections.defaultScope` (`global`|`workspace`), `connections.inChatPrompts` (`marker+detect`|`detect-only`|`off`), `skills.registry.enabled`, `skills.mining.enabled`, `skills.mining.confidenceThreshold`. New constants in `src/constants.ts`: `MCP_POLL_INTERVAL_MS = 2_000`, `MCP_POLL_TIMEOUT_MS = 300_000`, `MCP_REGISTRY_CACHE_TTL_MS = 3_600_000`, `MCP_CONNECT_MARKER`/regexes, `SKILL_MINING_MAX_DRAFTS = 3`.

---

## Implementation Phases

### Phase 1 — Connection substrate: McpConnectionsManager + config adapters (read/write/verify)

1. Create `src/services/mcp/IMcpConfigAdapter.ts`: the adapter interface, `McpServerEntry`, `McpTargetStatus` types; create `src/types.ts` additions: `McpConnection`, `McpTargetStatus`, extend `ProviderCapabilities` with `supportsMcpConfig: boolean`.
2. Create `src/services/mcp/adapters/ClaudeCodeMcpAdapter.ts` (`.mcp.json` workspace + `~/.claude.json` global; JSON read-modify-write of `mcpServers` subtree only), `CodexMcpAdapter.ts` (`~/.codex/config.toml`, `[mcp_servers.*]` section-scoped edit), `GeminiMcpAdapter.ts` + `QwenMcpAdapter.ts` (shared base over `settings.json` `mcpServers`), `CursorMcpAdapter.ts` (`mcp.json`), `CopilotMcpAdapter.ts`, `OpenCodeMcpAdapter.ts`. Stub `UnsupportedMcpAdapter` for ollama/localai/cline/openclaw (returns `supported:false`).
3. **Verification subtask (do first, per adapter)**: for each installed CLI, empirically confirm config path + schema on this machine (`claude mcp add` round-trip, `codex config` docs, etc.); record findings in a `src/services/mcp/FORMATS.md` table with CLI version stamps. Adjust adapters; flip cline/openclaw to real adapters only if confirmed.
4. Implement shared atomic-write helper `src/services/mcp/configWrite.ts`: tmp-file + rename, single per-session `.mysti-backup`, subtree-preserving merge, diff logging to the `[Mysti]` output channel.
5. Create `src/managers/McpConnectionsManager.ts`: registry CRUD over `globalState` (`mysti.connections.v1`), SecretStorage integration (`mysti-mcp:<connId>:<key>`), `propagate(conn, targets)`, `disconnect(connId, targets?)`, `verifyAll()`, `reconcile()` (import `source:'imported'` entries from adapter reads; lazy — first invoked on first Connections UI open or first connect-card, not during `activate()`).
6. Modify `src/extension.ts`: instantiate `McpConnectionsManager` (after provider registry, ~line 88 block), pass to `ChatViewProvider` (extend the constructor params; document the new ordering in CLAUDE.md/MEMORY.md).
7. Add constants to `src/constants.ts` (`MCP_POLL_INTERVAL_MS`, `MCP_POLL_TIMEOUT_MS`, `MCP_REGISTRY_CACHE_TTL_MS`).
8. Unit tests: adapter round-trip on fixture config files (including "preserve unrelated keys/comments" assertions), atomic-write crash simulation, reconcile import.

### Phase 2 — Catalog service + Connections UI panel

1. Create `resources/mcp/catalog.json` (curated ~30 servers with spec templates + `requiredSecrets`) and `src/services/mcp/McpCatalogService.ts` (bundled load + optional Smithery search with exact-host check, debounce handled UI-side, 1h TTL memory cache).
2. Create `src/webview/connectionsContent.ts` modeled on `src/webview/visualTestDashboardContent.ts`: two tabs (My connections / Browse catalog), card grid, per-CLI status chips, status filter + search, per-card busy state keyed by catalog id, secrets prompt handoff (input collection happens extension-side via `showInputBox`, never in the webview), strict HTML-escaping of all catalog/registry strings.
3. Create `src/providers/ConnectionsViewProvider.ts` (or a panel-managing module in `extension.ts` mirroring the visual-test dashboard wiring): owns the panel, routes `WebviewMessage`s (`listConnections`, `searchCatalog`, `connectServer`, `disconnectServer`, `refreshStatus`, `copyToCli`, `editSecrets`, `reopenAuth`), drives the 2s/5min poll loop for `needs-auth` connections, `vscode.env.openExternal` for https-only setup URLs, integrated-terminal launch for CLI-owned auth (`authHint.kind === 'terminal-command'`).
4. Modify `package.json`: command `mysti.openConnections` (+ menu/activity placement), settings `mysti.connections.enabled`, `mysti.connections.registry.enabled`, `mysti.connections.defaultScope`.
5. Modify `src/managers/SlashCommandManager.ts`: add `connections` to `_legacyCommandMap` (`:71-90`), new `cmd:connections` case in `executeCommand` (`:150+`) executing `vscode.commands.executeCommand('mysti.openConnections')`, command definition under the `commands` section.
6. Modify `src/providers/ChatViewProvider.ts` settings payload (`:480-510` region): add `mcpStatus` summary for the active panel provider (count of configured servers) so the chat settings drawer can render the slots strip; add the strip markup in `src/webview/webviewContent.ts`.

### Phase 3 — In-chat connect flow

1. Modify `src/types.ts`: add `'connection_required'` to the `StreamChunk` union (`:279`) + `connectionRequired` payload field; add the four `WebviewMessage` payload interfaces (`connectionRequired`, `openConnectFlow`, `connectServer`, `connectionStatus`); extend `Message` with optional `connectionCards: ConnectionCardRecord[]`.
2. Create `src/managers/ConnectPromptDetector.ts`: (a) nonce-bearing marker regexes (`MYSTI_CONNECT`) + `detect(panelId, accumulatedText, delta, nonce)` returning parsed signals and strip ranges, modeled on `ChannelBridge.detectMarkers` (`ChannelBridge.ts:280`) but nonce-validated **and bounded per the Plan 03 Phase 4.2 contract**: return immediately unless `delta` contains a marker sigil (`<<<` or `MYSTI_CONNECT`), and scan only from a per-panel `scannedUpTo` offset minus a 64-char overlap window (markers have bounded length), never the full accumulated text. If Plan 03 Phase 4.2 has landed, build on its shared bounded-scan helper instead of re-implementing the offset/overlap tracking; if this plan lands first, extract the helper here so Plan 03 can adopt it (whichever lands first defines the shared helper). (b) `detectFailedMcpTool(toolCall, toolResult)` recognizing `mcp__<server>__` names with not-configured/auth-failure result text. Unit-test marker splitting across chunk boundaries (including a marker straddling the overlap window), nonce rejection, and that no scan occurs when the delta lacks the sigil.
3. Modify `src/managers/AgentContextManager.ts` (`buildPromptContext`, `:158`): when `mysti.connections.inChatPrompts` includes marker mode, append the connector-guidance snippet (with the per-request nonce passed in via the existing config object) — mirroring DeepMyst's `_CONNECTOR_GUIDANCE` ("after emitting, briefly tell the user a Connect button is ready; never use it for capabilities you already have").
4. Modify `src/providers/ChatViewProvider.ts`:
   - Generate the nonce in `_handleSendMessage`; run `ConnectPromptDetector.detect` in the same accumulated-text pass that calls `_channelBridge.detectMarkers` (`:~2800-2805`), **gated and bounded identically** (Plan 03 Phase 4.2): invoke only when the latest delta contains `<<<` or `MYSTI_CONNECT`, scan only the unscanned tail + 64-char overlap via the shared `scannedUpTo` tracking — do not add another full-`assistantContent` scan per delta to this hot path; strip markers from displayed and persisted text.
   - On detection: post `connectionRequired` to the panel, record the card on the in-flight assistant message, and **do not interrupt the stream** (turn ends naturally — implicit-resume contract).
   - Handle `openConnectFlow` (open Connections panel pre-seeded with `searchQuery`, or run an inline quick-pick over catalog matches) and `connectServer` (delegate to `McpConnectionsManager.propagate` targeting the panel's effective provider from `_getPanelProvider`, `:336-346`); post `connectionStatus` updates as the manager's poll progresses.
   - Wire lane B: where `tool_result` chunks are processed in the main stream loop, call `detectFailedMcpTool` and synthesize the same `connectionRequired` event (dedup per server per turn).
5. Modify `src/webview/webviewContent.ts`: render the ConnectorBlock card from `connectionRequired` (escaped label/reason, Connect button → `openConnectFlow`), flip on `connectionStatus` (`needs-auth` spinner state → green connected chip with "send a message to continue" + optional "Ask the agent to continue" button that submits a canned user message); render persisted `connectionCards` on history restore.
6. Modify `package.json`: setting `mysti.connections.inChatPrompts` (enum `marker+detect` | `detect-only` | `off`, default `marker+detect`).
7. Tests: detector unit tests; an integration-style test of the chunk→message→card→status round-trip with a scripted provider stream.

### Phase 4 — AgentLoader hardening + agent management backend

1. Modify `src/managers/AgentLoader.ts`:
   - Dedupe returned arrays by id with highest-priority source winning, and warn on cross-type id collisions instead of clobbering `_agentTypes` (`:129-170`, research §8.1).
   - Escape `sectionName` in `_extractSection` (`:447-451`) and tolerate `##`/`###` + trailing whitespace; fix the first-paragraph fallback in `_extractInstructions` (`:426-442`).
   - Fix `findMatchingAgents` name matching (`:272`) to token-overlap in both directions.
   - Add `listSources()`, `createAgent(type, scope, template)`, `deleteAgent(id)` (user/workspace only), `overrideAgent(id, scope)` (copy file to higher-priority dir), `getAgentFilePath(id)`.
   - Add `vscode.FileSystemWatcher` over `~/.mysti/agents/**` and `.mysti/agents/**` with debounced `reload()` and an `onDidReload` event.
2. Modify `src/providers/ChatViewProvider.ts`: subscribe to `onDidReload` → re-post the settings payload (personas/skills lists at `:480-502`) and a new `agentsReloaded` webview message.
3. Modify `src/types.ts` + `package.json`: add `mysti.agents.activePersona` (string) and `mysti.agents.activeSkills` (string[]) settings; modify `src/managers/AgentContextManager.ts` to prefer them over the legacy per-provider enums (which remain as fallback).
4. Add `resources/agents/templates/persona.md` and `skill.md` scaffolds matching the CLAUDE.md frontmatter format.

### Phase 5 — Agents & Skills management UI

1. Extend the dedicated panel (`src/webview/connectionsContent.ts` → rename to `src/webview/hubContent.ts` or add `agentsContent.ts` as a sibling tab set): Personas / Skills lists with source badges, category filter, search; detail drawer rendering Tier-3 content (`getAgentDetails` path already exists, `ChatViewProvider.ts:1318-1330`).
2. Wire actions through the panel's message router: `createAgent` (quick-pick scope + name → scaffold → `vscode.window.showTextDocument`), `editAgent` (open file), `duplicateToWorkspace`, `deleteAgent` (confirm modal; user/workspace only), `setActivePersona`, `toggleActiveSkill`.
3. Modify `src/managers/SlashCommandManager.ts`: `/agents` (open panel), `/persona <id>` and `/skill <id>` (set active, with id completion from `AgentLoader.getAllMetadata()` via `_resolveDynamicValues`, `:138`).
4. Modify `src/webview/webviewContent.ts`: active persona/skills chips in the chat settings drawer reflecting the new settings, replacing the static enum dropdown when the dynamic system is loaded.
5. Telemetry (`TelemetryManager`): agent created/edited/activated events (anonymous counts only).

### Phase 6 — Skills discovery: registry install + mining drafts

1. Create `src/services/SkillRegistryService.ts`: source A = runtime port of `scripts/sync-agents.js` (same `CURATED_PLUGINS`, cache moved to `globalStorageUri`, target `~/.mysti/agents/`); source B = Smithery skills registry client (search + body fetch, 1h TTL, exact-host check, optional API key from SecretStorage); `install(skillRef)` normalizes frontmatter to Mysti's schema and writes into `~/.mysti/agents/skills/`.
2. Add "Discover" tab to the Agents panel: search across both sources, Install button per card (busy per card), installed-state dedup against `AgentLoader` ids.
3. Create `src/managers/SkillMiningManager.ts`: scout call (selected-provider CLI, non-interactive, lazy — no warm pools), per-conversation verdict cache in `globalState`, draft structuring call, draft files in `~/.mysti/agents/skills/drafts/` with `status/confidence/source_hash/source_signals` frontmatter, `approve(id)` / `reject(id, reason)`; caps `SKILL_MINING_MAX_DRAFTS`/max-LLM-calls.
4. Add "Drafts" sub-tab: pending/approved/rejected filters, body preview, confidence display, approve/reject actions; badge count on the tab when pending drafts exist.
5. Modify `package.json`: `mysti.skills.registry.enabled` (default true), `mysti.skills.mining.enabled` (default false), `mysti.skills.mining.confidenceThreshold` (default 0.7). Document the privacy implication in the setting description ("sends conversation content to your selected AI provider").
6. Modify `src/managers/SlashCommandManager.ts`: `/skills` → Agents panel Discover tab; `/mine-skills` → manual mining run on the current conversation.

### Phase 7 — Hardening, docs, and cross-feature polish

1. Reconcile-on-activation scheduling audit: ensure all McpConnectionsManager I/O is post-startup and debounced; add a `mysti.debugConnections` command dumping the status matrix + last config diffs.
2. Persistence audit: connect cards and agent chips survive webview reload (restore path in `webviewContent.ts`); `connectionCards` included in conversation export/import.
3. Failure-mode pass per DeepMyst §8: one broken adapter/config never blocks the panel (per-adapter try/catch, `error` status surfaced on the card); pending/needs-auth connections contribute nothing and never break chat.
4. Update `CLAUDE.md` (managers list, new settings, new commands), `MEMORY.md` notes, and README feature section; add the new constructor params ordering.
5. End-to-end manual test matrix: connect GitHub MCP (API key lane) to Claude Code + Gemini; connect a remote OAuth server to Claude Code (terminal lane); trigger in-chat connect via marker (Claude) and via failed `mcp__` tool (Codex); create/override a persona; install a registry skill; run mining on a real conversation.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **CLI config formats drift or were mis-remembered** (paths/schemas per CLI version) | Writes corrupt user configs or land in ignored files | Phase 1.3 empirical verification per CLI before enabling each adapter; `FORMATS.md` with version stamps; adapters default `unsupported` until verified; subtree-only merges; atomic write + backup + diff log (Cline `.clinerules` clobber lesson) |
| **Marker protocol false positives / prompt injection** (model echoes examples; hostile context fabricates a connect card) | Fake connect cards steer users to malicious servers | Per-request nonce required in marker; model strings display-only; **no auto-connect ever** — human click + catalog-mediated specs only; lane-A card never carries a raw URL/command from the model, only a search query; HTML-escape all card strings (webview-chat research showed the permission card itself has unescaped sinks — don't inherit that) |
| **Marker never emitted by weaker models** (Copilot/Cursor plain-text streams, small local models) | In-chat flow silently dead on some providers | Lane B (failed `mcp__` tool detection) as a provider-independent fallback; `inChatPrompts: detect-only` mode; feature still fully usable via the Connections panel |
| **Secrets leakage** | API keys in sync'd settings or world-readable configs | SecretStorage only; explicit warning when a CLI format forces plaintext env values into its config file; never log secret values in diff logs (redact by key name) |
| **OAuth UX dead-ends in VSCode** (no popup observability, CLI-owned auth flows vary) | Users stuck in `needs-auth` | 2s/5min poll + "Re-open setup" re-arm (DeepMyst §8.6); terminal-lane shows the exact command being run; status matrix always shows per-CLI truth from `verify()` re-reads, not optimistic state |
| **Cancel routing is broken for per-panel provider overrides** (`ProviderManager.ts:228-243`) | Connect-flow cancel/cleanup paths no-op on non-default providers | This plan never relies on cancelling a stream (implicit-resume design ends turns naturally); deeper fix belongs to the stabilization plan — noted as a dependency |
| **Startup/perf regression** (mysti-performance: activation already blocks on serial CLI discovery) | Slower activation | All reconcile/registry I/O is lazy (first panel open / first card), TTL-cached, and time-boxed; zero adapter reads during `activate()` |
| **Streaming hot-path regression** (lane-A detector adds a third per-delta scan to the same loop Plan 03 Phase 4.2 is bounding) | Reintroduces O(n²) per-delta scanning on long responses, undoing Plan 03's streaming-render win | `ConnectPromptDetector.detect` adopts the Plan 03 Phase 4.2 bounded-scan contract: sigil-gated on the delta (`<<<` / `MYSTI_CONNECT`), `scannedUpTo` offset + 64-char overlap, never the full accumulated text; shared helper with ChannelBridge/visual-test scans (whichever plan lands first defines it); unit test asserts no scan without sigil |
| **AgentLoader changes destabilize prompt building** | Personas/skills silently dropped from prompts | Phase 4 fixes land behind unit tests on fixture agent dirs (duplicate ids, cross-type ids, odd headers) before any UI depends on them |
| **Mining privacy/cost surprise** | User conversations sent to an LLM without clear consent | Default off; consent text in the setting; runs through the user's already-chosen provider; hard caps on drafts/calls; per-conversation scout cache |
| **Registry dependency (Smithery) availability/terms** | Browse tab degraded | Bundled curated catalog is the default path and fully offline; registry behind a setting + key; exact-host check; graceful empty-state |

---

## Dependencies

- **Plan 00/stabilization (providers & core managers)** — soft dependency: the `ProviderManager.cancelRequest` wrong-provider bug and the permission-gate allowlist holes are fixed there; this plan is designed to not *require* those fixes (implicit resume, no stream cancellation), but the in-chat flow's quality on non-default providers improves once they land. The `Copilot --allow-all-tools` / fail-open gate findings make it more important that connect cards never auto-execute anything.
- **Plan 01/unified chat UX** — medium dependency for Phase 3 polish: the capability-manifest model (webview learns `ProviderCapabilities`) is the right vehicle for `supportsMcpConfig` so the connect card can say "Ollama doesn't support MCP — connect for Claude instead?" If plan 01 lands first, reuse its manifest; otherwise ship a minimal `mcpSupport` flag in the settings payload and migrate later.
- **Plan 02/model updates** — none functionally; shares the "runtime fetch + TTL cache + bundled fallback" service pattern, so align cache helper implementations if it lands first.
- **Plan 03/performance — Phase 4.2 (bounded marker scans)**: coordination dependency for Phase 3. Plan 03 Phase 4.2 bounds the ChannelBridge/visual-test scans in the `_handleSendMessage` stream loop (sigil gating on the delta + `scannedUpTo` offset + 64-char overlap); the lane-A connect detector lives in that same pass and must follow the same contract. Whichever plan lands first defines the shared bounded-scan helper; the other adopts it. Not a blocking dependency — the contract is fully specified in Phase 3.2/3.4 here and can be implemented standalone.
- **Plan 05/canvas** — none known. (Canvas's plaintext-API-key precedent is explicitly *not* followed here.)
- External: Smithery registry endpoints (optional features only); per-CLI MCP support maturity (Cline CLI / OpenClaw unverified).

---

## Effort Estimate

| Phase | Scope | Estimate |
|---|---|---|
| 1 | Substrate: manager + 7 adapters + verification + atomic writes | **L** |
| 2 | Catalog service + Connections panel UI | **M** |
| 3 | In-chat connect flow (detector, chunk, card, resume) | **M** |
| 4 | AgentLoader hardening + management backend | **M** |
| 5 | Agents & Skills management UI | **M** |
| 6 | Skills discovery: registry install + mining drafts | **L** |
| 7 | Hardening, docs, E2E matrix | **S** |

Sequencing: 1 → 2 → 3 is the connections track; 4 → 5 → 6 is the agents track and can proceed in parallel after Phase 1 starts (no shared files except `SlashCommandManager`, `types.ts`, `package.json` — coordinate those edits). Phase 7 last.

---

## Open Questions

1. **Cline CLI / OpenClaw MCP support** — does the Cline *CLI* (vs the Cline VSCode extension) read `cline_mcp_settings.json`, and does OpenClaw have any MCP client at all? Phase 1.3 verification decides whether they get real adapters or stay `unsupported` in v1.
2. **Smithery integration depth** — registry-search-only (anonymous or user key), or also Smithery-hosted connections (their hosted URL + OAuth dance) as a third connect lane? Hosted connections give the smoothest OAuth but add an account dependency and per-user key management.
3. **Workspace vs global default scope** — should `connections.defaultScope` default to `workspace` (project-local `.mcp.json`, shareable with a team, but pollutes repos) or `global` (clean repos, but connections follow the machine)? Leaning `global` with an explicit per-connect toggle.
4. **Where does the hub live** — one combined "Mysti Hub" panel (Connections + Agents + Skills tabs) vs three commands/panels? Combined reduces webview boilerplate but grows another large embedded-HTML file (`webviewContent.ts` is already ~950KB of template strings per the performance research). Consider splitting hub content into lazily-required modules from the start.
5. **Marker vs detect-only default** — should `inChatPrompts` default to `marker+detect` for all providers, or marker only for providers with reliable instruction-following (claude-code, codex, gemini) and detect-only elsewhere? A per-provider capability flag could express this if plan 01's manifest lands first.
6. **Active persona/skills scoping** — `mysti.agents.activePersona` as a global setting (consistent with today's settings model) or per-panel override via `_panelStates.settingsOverrides` (consistent with per-panel isolation)? Per-panel is more correct but multiplies UI state; proposal: global setting + per-panel override field, like provider/model today.
7. **Mining trigger** — automatic on conversation completion (background, capped) vs manual-only `/mine-skills` in v1? Manual-only is the safer first ship given the privacy posture.
8. **`.mcp.json` team sharing** — when writing workspace-scope Claude Code config, should Mysti also offer to add the file to `.gitignore` or, conversely, generate a secrets-free variant (env-var indirection) so it's safe to commit? Affects the Phase 1 adapter's env-handling design.
