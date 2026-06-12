# DeepMyst 2.0 — MCP Connections, In-Chat Connect Prompts, Agent Management, Skills Discovery

Research report for Mysti planning. Source repo: `/Users/bahaabunojaim/Documents/GitHub/DeepMyst-2.0-connections-hub` (monorepo: `apps/dashboard` React + Vite, `apps/core-api` FastAPI/Python, `apps/worker` ARQ).

---

## 1. Where everything lives

| Concern | Frontend | Backend |
|---|---|---|
| Per-user MCP connections ("My Connections") | `apps/dashboard/src/features/mcp-connections/` (6 files, ~1.4k LOC) | `apps/core-api/src/domains/agents/mcp_connections_service.py`, `mcp_connections_routes.py`, `me_mcp_connections_routes.py`, `downstream_mcp_routes.py`, `smithery_client.py` |
| Dynamic agent tools (MCP tools at runtime + `request_connector` meta-tool) | — | `apps/core-api/src/domains/agents/dynamic_tools.py` |
| In-chat connect prompt (presentation agent) | `apps/dashboard/src/features/agents/presentation/ChatPanel.tsx`, `chatStreamTypes.ts` + `apps/dashboard/src/features/mcp-connections/ConnectMcpModal.tsx` | `apps/core-api/src/domains/agents/presentation_chat_service.py` (~line 1261), `presentation_prompt.py` (`_CONNECTOR_GUIDANCE`, ~line 384) |
| Inbound MCP (DeepMyst agents exposed AS MCP servers; built-in MCPs) | — | `apps/core-api/src/domains/mcp/` (`handler.py`, `routes.py`, `builtin_registry.py`, `builtin_knowledge.py`, `builtin_agents.py`, `builtin_org_data.py`) |
| Skills (attach, resolve, upload, registry) | `apps/dashboard/src/features/agents/components/SkillManager.tsx` (868 LOC) | `apps/core-api/src/domains/skills/` (`service.py`, `registry.py`, `builtin_registry.py`, `routes.py`, `models.py`) |
| Skills discovery / mining (drafts) | `apps/dashboard/src/features/skills/` (`SkillDraftsRoute.tsx` 963 LOC, `types.ts`, `skillDraftsService.ts`) | `apps/core-api/src/domains/skills/extraction.py` (1881 LOC), `drafts_routes.py` |
| Agent management UI | `apps/dashboard/src/features/agents/` (components/, types/, hooks/, per-frontend-type folders) | `apps/core-api/src/domains/agents/` |
| Build plans | — | `docs/build-plans/agent_workflow.md`, `agent_types_roadmap.md` (no dedicated skills-discovery or connection-management plan doc exists — those features are documented only in code) |

Important distinction: `domains/mcp/` is **inbound** MCP only (a JSON-RPC 2.0 handler so external clients like Claude Desktop can call a DeepMyst agent as a single MCP tool: `initialize`, `tools/list`, `tools/call`, `ping`; routes `GET /api/v1/mcp/builtin`, `POST /api/v1/mcp/builtin/{name}`, `POST /api/v1/mcp/{slug}`). All **outbound** connection management lives in the `agents` domain and is brokered through **Smithery** (smithery.ai) — DeepMyst never speaks raw MCP JSON-RPC to third-party servers itself (the workflow build plan flags "outbound MCP client does not exist today" as a known gap).

---

## 2. Data models

### 2.1 `McpUserConnection` (Postgres row, `agents/models.py` ~line 2534; mirrored in `mcp-connections/types.ts`)

```
id, user_id (FK users), organization_id, provider ("smithery"),
namespace, connection_id, mcp_url, display_name,
icon_url, description,           # cached from registry card at connect time (no 2nd round-trip)
status: pending | connected | failed | revoked,
setup_url,                       # Smithery's hosted OAuth page while pending
error_message, extra JSONB, connected_at, created_at, updated_at
```

Status flow: `pending → connected` (OAuth done) | `pending → failed` | `connected → revoked`. Connections are **per-user** (each org member brings their own Gmail/Slack credentials), keyed deterministically: `connection_id = f(user_id, mcp_url)`.

### 2.2 `McpRegistryCard` (catalog search result)

```
qualified_name, display_name, description, icon_url, homepage, use_count, mcp_url
```

### 2.3 `McpConnectionSlot` (per-agent "what does THIS agent need")

```
mcp_url, display_name,
needs_oauth: boolean,            # true only for broker-hosted (Smithery) URLs → only those show Connect
connection: McpUserConnection | null
```

### 2.4 Agent (`agent.types.ts`)

Relevant fields: `mcp_servers: McpServer[]` (JSONB list: `{name, url?, builtin_name?, auth_type?, source?: "external"|"agent"|"registry"|"builtin", agent_slug?, ...}`), `skills: Skill[]` (JSONB list), `capabilities: string[]`, `frontend_type` (19 UI templates: chat, presentation, document, workflow, spreadsheet, notebook, site_studio, media_studio, …), `system_prompt`, `model`, `thinking_enabled/thinking_level`, tags/folders/saved-views for organization.

### 2.5 Skill attachment (one entry on `agent.skills`)

```
name, source: "builtin" | "registry" | "uploaded" | "agent",
builtin_name?,                       # source=builtin
registry_ref?: {namespace, slug},    # source=registry (Smithery skills registry)
upload_id?,                          # source=uploaded (org-private SkillUpload row)
agent_slug?,                         # source=agent (reserved, not wired)
description?, allowed_tools?, triggers?
```

### 2.6 Skills tables (`skills/models.py`)

- `SkillUpload` — org-scoped SKILL.md stored inline: `name, description, filename, body (Text), frontmatter JSONB, allowed_tools JSONB, triggers JSONB, size_bytes` (256 KB cap, .md only, UTF-8).
- `SkillDraft` — mined candidate awaiting admin review. Mirrors SkillUpload fields 1:1, plus: `skill_kind ("user_skill"|"agent_skill")`, `status (pending|approved|rejected)`, `confidence (0..1)`, `source_signals JSONB`, `source_hash` (SHA-256 over sorted source ids; UNIQUE partial index on pending rows = idempotent re-mining), review trail (`reviewed_by/at`, `review_reason`, `promoted_skill_id` FK → skill_uploads).
- `SkillScout` (`agent_run_skill_scouts`) — per-run Haiku verdict: `has_skill, topic, summary, confidence, embedding Vector(1024)`; PK = agent_run_id (re-scout is a no-op).

---

## 3. Connection lifecycle / OAuth flow (the "dance")

Backend (`mcp_connections_service.py`):

1. **initiate / connect_open** → `SmitheryClient.upsert_connection(namespace, cid, mcp_url, metadata={user_id, org_id, agent_slug})`. Smithery responds either `connected` immediately (no-auth servers) or `auth_required` with a hosted `setup_url`. Row upserted locally with that status.
   - `initiate(slug, mcp_url)` restricts to URLs on the agent's `mcp_servers` list.
   - `connect_open` accepts ANY Smithery-hosted URL from registry search (gated by strict host match `is_smithery_host` — explicitly not substring matching, to block `evilsmithery.ai` SSRF).
2. **OAuth** happens entirely on Smithery's hosted page (which redirects to the provider's real OAuth: accounts.google.com, slack.com, …). DeepMyst never holds provider tokens; Smithery does.
3. **refresh / refresh_by_id** → `SmitheryClient.get_connection` re-pull; local row status updated. Frontend polls this.
4. **disconnect** → `SmitheryClient.delete_connection` + local row delete; audit event written (`agent.mcp_connection_opened` / disconnect events via `_audit_connection`).

HTTP surface:
- Per-agent: `GET/POST /api/v1/agents/{slug}/mcp-connections`, `POST .../open`, `POST .../{id}/refresh`, `DELETE .../{id}`, `GET /agents/{slug}/mcp-registry?q=`
- Global ("My Connections" hub, no agent in scope): `GET/POST /api/v1/me/mcp-connections`, `POST .../{id}/refresh`, `DELETE .../{id}`, `GET /api/v1/me/mcp-registry?q=&page=&page_size=` (returns `{servers, has_more, total|null}` for a classic pager).
- Rate limits: connect 20 rpm, search 60 rpm, fixed-window Redis counter keyed `org:owner` (owner = embed end-user ref or user_id), fail-open on Redis errors.
- Embed/multi-tenant: when `auth.embed_end_user_ref` is set, the service binds to a per-end-user **shadow principal** so embedded end-users never share/leak each other's OAuth connections.

Frontend polling constants (used in all three connect surfaces — `useMcpConnections.ts`, `ConnectMcpModal.tsx`):
- `POLL_INTERVAL_MS = 2_000`, `POLL_TIMEOUT_MS = 5 * 60_000` (then give up; user clicks Connect again to "re-arm").
- `window.open(setup_url, "_blank", "noopener,noreferrer")` — only after `isSafeSetupUrl` (https-only scheme check; deliberately no host allowlist since setup_url legitimately lands on arbitrary provider OAuth domains, and it comes from Smithery's authenticated response, not model/user input).
- On `connected`: cancel poller, invalidate react-query caches (`["mcpConnections", ...]` + `["workflow", slug, "mcp-tools"]`), toast, callback.
- Per-card connecting state keyed by `mcp_url` so one abandoned OAuth never blocks another card.

---

## 4. "My Connections" UI composition

- **`McpConnectionsSettingsPage.tsx`** (`/settings/connections`) — two tabs over one per-user pool:
  - *My connections*: list of `McpUserConnection` cards (provider logo cached on row, name, StatusBadge, status filter all/connected/pending/failed/revoked, name search, Disconnect, "Re-open setup" link when pending).
  - *Browse catalog*: debounced (350 ms) search over Smithery registry, 24-card pages, Prev/Next pager (uses registry `total` when present, `has_more` fallback), Connect button per card running the full OAuth dance in-page; de-dupes results by `mcp_url`; `keepPreviousData` so paging never flashes empty.
- **`McpConnectionPanel.tsx`** — per-agent slot list ("this agent needs Gmail → your status"). Filters to `needs_oauth` slots only; `compact` mode for embedding in the workflow editor's left rail; full-card mode for agent detail pages. Copy: "Connect once and we'll reuse the same authorization across every agent."
- **`ConnectMcpModal.tsx`** — the in-chat modal (see §5). Search input seeded from the agent-derived query so results appear with zero typing.
- **`useMcpConnections.ts`** — three hooks: `useAgentMcpConnections(slug)` (slots + initiate/disconnect + poll), `useAllMcpConnections()` (global list), `useMcpCatalog()` (debounced search + pager + per-URL connect/poll).

---

## 5. Connect-from-chat handshake (the key flow to copy)

This is the presentation agent's (and workflow agent's) mid-conversation "you need to connect Jira" flow. Four layers:

### 5.1 Model-side: `request_connector` meta-tool (`dynamic_tools.py` `_REQUEST_CONNECTOR_TOOL`)

Always appended to every agent's dynamic tool list. Anthropic tool schema:

```json
{ "name": "request_connector",
  "input_schema": { "properties": {
      "label":        "Short human label, e.g. 'Gmail'",
      "search_query": "registry search terms derived from the ask, e.g. 'jira issues'",
      "reason":       "one sentence why connecting fulfils the request" },
    "required": ["label", "search_query"] } }
```

Description text teaches the model: call ONLY when the user asks for something needing an external service you have no tool for; never for capabilities you already have. The system prompt reinforces it (`presentation_prompt.py` `_CONNECTOR_GUIDANCE`): "After calling it, briefly tell the user a Connect button is ready."

### 5.2 Executor: sentinel, no side effects

`DynamicToolExecutor._run_request_connector` performs NO network/DB work — it just echoes `{connector_requested: true, label, search_query, reason}`. The actual search + connect happens client-side after the user clicks.

### 5.3 Chat service: sentinel → typed SSE event + clean tool_result (`presentation_chat_service.py` ~1261)

```python
if result.get("connector_requested"):
    yield sse({ "type": "connector_required", "tool_use_id": tool_id,
                "label": ..., "search_query": ..., "reason": ...,
                "agent_slug": agent.slug })
    result = {"status": "awaiting_user_connection"}   # fed back to the LLM
```

Critical design points:
- The raw sentinel **never enters LLM history**; the model sees a well-formed `tool_result` of `{"status": "awaiting_user_connection"}`, so the agentic loop stays valid and the model naturally wraps up its turn ("I've put a Connect button in the chat…").
- label/search_query flow from model output that may be influenced by untrusted content → frontend treats them as **display-only and never auto-connects** (explicit comment in code).
- tool_call + tool_result rows are persisted (with `tool_use_id`) so next-turn history replays correctly.

### 5.4 Frontend: ConnectorBlock → modal → flip to connected (`chatStreamTypes.ts`, `ChatPanel.tsx`)

Chat turns are `ChatTurn { role, blocks: ContentBlock[] }` where `ContentBlock = TextBlock | ToolBlock | ConnectorBlock | FormBlock`. The SSE reducer (`applyStreamEvent`, pure function shared by component and module-level stream manager):
- `tool_start` for `request_connector` is **skipped** (no generic tool row).
- `connector_required` appends `{kind:"connector", callId, label, searchQuery, reason, status:"needed"}`.
- Connector block renders inline between prose segments: plug icon + reason text ("Connect Jira to continue") + primary `Connect {label}` button; when `status==="connected"` it becomes a green "`{label} connected`" chip.
- Click → `setConnectorModal({searchQuery, turnId, callId})` → `<ConnectMcpModal agentSlug initialQuery={searchQuery}>` opens, auto-searches Smithery, user clicks Connect on a card → `connectOpen` → OAuth popup → 2s poll → `onConnected` → parent flips that exact block (by turnId+callId) to `status:"connected"`, closes modal.

### 5.5 Resume: tools appear on the NEXT user message (no push resume)

There is **no automatic agent resume**. The turn ended normally after the connector event. Resumption is implicit: `build_dynamic_tools` runs at the start of EVERY turn and unions (a) servers on `agent.mcp_servers` the caller has connected, and (b) **all of the caller's personal `connected` McpUserConnection rows** (made via the in-chat flow; deliberately not written to the org-shared agent config). So the user just sends their next message ("ok, connected — go ahead") and the model now has `mcp__<server>__<tool>` tools resolved live via `SmitheryClient.list_tools` per connection. Tool names sanitized to Anthropic's `^[a-zA-Z0-9_-]{1,64}$` with collision suffixes; null/partial inputSchemas normalized to `{type:"object"}`; one flaky server logs a warning and contributes zero tools (never breaks the chat).

### 5.6 Sibling pattern: `ask_user` dynamic forms

Identical lifecycle, used for structured input instead of connections (`presentation_tools.py` `_ask_user`, ~9722): tool returns `{ask_user_requested: true, title, fields}` sentinel (max 4 fields, 12 field types: text/textarea/select/multiselect/number/email/url/toggle/date/slider/color/file, validated server-side) → chat service emits `{"type":"ask_user", fields, title}` SSE + feeds model `{"status":"awaiting_user_response"}` → UI renders an inline `ChatFormCard` → submission is sent **as the next user message** (formatted answers), which resumes the agent; card flips to a read-only answered summary. This confirms the general pattern: *meta-tool → sentinel → typed stream event → inline interactive card → turn ends → user's next message resumes with new context*.

---

## 6. Skills system

### 6.1 Sources and resolution (`skills/service.py`)

Agent's `skills` JSONB resolves at chat time via `resolve_skill_bodies` → `render_skills_block` which concatenates bodies under a `# Skills attached to this agent` header **appended to the system prompt** (skills are pure-prompt capability packs — no runtime tools of their own):
- `builtin` → in-code `BUILTIN_SKILLS` dict (`builtin_registry.py`): name/description/icon/allowed_tools/triggers/body (e.g. pdf-extractor, web-research, sql-helper). Mirrors `domains/mcp/builtin_registry.py` symmetry.
- `registry` → **Smithery skills registry** (`registry.py`): `GET https://registry.smithery.ai/skills?q=` (metadata: namespace/slug/displayName/description/categories/gitUrl/verified, no body) + `GET /skills/{namespace}/{slug}` (body in `prompt` field). Same `SMITHERY_API_KEY`. In-process TTL caches (1 h) for index and bodies. Was previously a GitHub-walk over `anthropics/skills`.
- `uploaded` → `skill_uploads` row body (org-private SKILL.md, frontmatter parsed by a small regex YAML-lite parser `parse_skill_md` → `{name, description, allowed-tools, triggers}`).
- `agent` → reserved, not wired.
- Every failure path logs at debug and **drops the skill** — a stale reference must never break chat.

HTTP: `GET /api/v1/skills/builtin`, `GET /api/v1/skills/registry/search?q=&limit=`, `GET/POST/DELETE /api/v1/skills/uploads`, `GET /api/v1/skills/mined`.

### 6.2 Skill picker UI (`SkillManager.tsx`, used by AgentBuilderWizard + AgentDetailPage)

Controlled component `(skills, onChange)`. Add-mode chooser with 5 tabs: **Built-in** (fetched metadata cards), **Registry** (debounced 400 ms Smithery search), **Upload** (file input → POST, lists org uploads, dedups already-attached upload_ids), **From Agents** (= `GET /skills/mined`, SkillUpload rows promoted from approved drafts — same shape/dedup as uploads), **Manual**. Attached list with expand/edit/delete. `McpServerManager.tsx` is the symmetric picker for `agent.mcp_servers` with tabs: other-DeepMyst-agent-as-MCP (URL `{origin}/api/v1/mcp/{slug}`, bearer auth), external URL + auth_type (none/api_key/bearer/oauth), Smithery registry search, built-in MCPs.

### 6.3 Skills discovery / mining (`extraction.py` + drafts)

Nightly per-org ARQ job (also on-demand from admin UI, optionally scoped to specific agents). Five signal gatherers over a 30-day window:
1. **Recurring tool sequences** — same tool_name sequence across ≥3 runs (≥2 when per-agent), success_rate ≥ 0.7.
2. **Reasoning trajectories** — (input intent bucket, ordered tool+arg-key chain) shapes that repeat; captures *when/why*, not just steps.
3. **Memory subject_entity clusters** (e.g. `customer:acme`).
4. **Memory reference connected components** — chains of ≥3 cited memories = thematic playbook.
5. **Scouted skills, two-tier LLM**: per-run Haiku "scout" classifies whether the conversation contains a transferable METHOD (positives stored with topic/summary/1024-dim embedding in `agent_run_skill_scouts`); gather clusters positives by cosine similarity; **Opus** structures each cluster into a SKILL.md (Opus chosen specifically for distilling reasoning into a playbook; cheaper Haiku for everything else).

Synthesis prompt is enriched with 2–3 real run transcripts so the model extracts strategy (when to fire, what to verify, where to branch) instead of listing tool names. Cost caps: ≤12 drafts/run, ≤20 LLM calls/run. Dedup via `source_hash`. Output = `SkillDraft` rows → admin reviews in `SkillDraftsRoute.tsx` (pending/approved/rejected tabs, full-body detail, confidence, source_signals, per-source diagnostics explaining "0 candidates", deep links to created drafts, live job-status polling: `ExtractionStatusResponse`) → approve promotes to `skill_uploads` (audit trail via `promoted_skill_id`) → appears in the picker's "From Agents" tab. Rejection reasons are captured (planned: anti-signals for the miner).

---

## 7. Build-plan doc takeaways

- **`agent_workflow.md`** (workflow agent type, 12-week plan): MCP servers on the agent become the workflow **action library** for free ("we are not in the integration-catalog business"). Resolution at 3 points: library load (`tools/list` flattened), proposal validation (pair still reachable), runtime dispatch (`tools/call`, errors into run trace). Confirms outbound raw-MCP client is a known gap (Smithery brokers everything today; plan = official `mcp` Python SDK over streamable-http). Staged-proposal pattern (`{kind, anchor, proposed_value, previous_value, status}` + ghost rendering + accept/reject + stale detection via version-on-anchor) is the platform's universal agent-edit pattern. Agent never publishes/deploys; cost estimate + mandatory dry-run before publish; allowlist guardrail `allowed_action_namespaces`.
- **`agent_types_roadmap.md`**: cross-cutting conventions for every agent type — staged proposals, reactive triggers (`{id, type, event, debounce_ms, on_fire.prompt_template, rate_limit}`), builder-prompt router entries, public-access allowlist, session serializers, per-org feature flags (`feat.agent.<type>`), hard budget caps.
- No skills-discovery or connection-management build-plan docs exist in `docs/build-plans/` (verified by grep); those systems are documented in code comments only. The 12 docs there cover agent types (image/media/workflow/canvas), canvas formats, knowledge graph, launches, librechat, living presentations, ai-native company builder.

---

## 8. Security/robustness patterns worth copying verbatim

1. Sentinel-tool pattern keeps the LLM loop well-formed: model never sees raw control payloads; UI events are typed and separate from tool_result content.
2. Model-derived strings (label, search_query, form field labels) are display-only; the UI **never auto-connects** — a human click is always between "agent wants X" and any OAuth.
3. https-only scheme check on setup URLs; strict host match (not substring) for broker URLs.
4. Pending connections yield zero tools (model would just fail calls); expired connections produce a tool error telling the model to ask the user to reconnect.
5. Everything in the tool-build path is fault-tolerant: one bad server/skill logs and is skipped.
6. Poll-with-timeout (2 s / 5 min) instead of OAuth redirect callbacks — works even when popup result is unobservable (`noopener` makes `window.open` return null).
7. Per-resource busy state (per mcp_url) so parallel connects don't dead-click each other.
8. Audit events on connect/disconnect; rate limits keyed to the true principal.

---

## 9. Translation to Mysti (VSCode extension, 12 CLI backends)

### Maps directly (adopt as-is)

- **The connect-from-chat handshake shape.** Mysti already has the exact seams: `StreamChunk` union (`src/types.ts:279`) already includes `ask_user_question` — add a `connection_required` chunk type carrying `{label, searchQuery, reason, toolUseId}`; webview already renders interactive cards mid-stream (permission cards via `ChatViewProvider._shouldGateToolUse()`); completion flips the card via `postMessage`, and "agent gains tools on next message" matches Mysti's CLI model perfectly (next CLI spawn picks up updated MCP config — even cleaner than DeepMyst since Claude Code/Gemini/Codex re-read MCP config per session/spawn).
- **ConnectorBlock / FormBlock content-block modeling** — Mysti's webview message rendering can adopt the segments model (text / tools-grouped / connector / form) for inline cards.
- **Status model + polling constants**: `pending | connected | failed | revoked`, 2 s poll, 5 min re-arm timeout, per-item busy keys. For OAuth-style flows use `vscode.env.openExternal(setup_url)` instead of `window.open`; poll from the extension host, not the webview.
- **Catalog UI composition**: two-tab "My connections / Browse catalog", debounced search, cards with icon+description+Connect/Connected/Disconnect, status badges, per-agent "slots" panel. Renders fine in `webviewContent.ts` patterns Mysti already uses; could also live in a dedicated tab panel like the visual-testing dashboard.
- **Skills attachment + resolution**: DeepMyst's `render_skills_block` (concat SKILL.md bodies into system prompt) is what Mysti's `AgentLoader`/`AgentContextManager` already do with tier-2 instructions. The `Skill` attachment shape (`source: builtin|registry|uploaded`) maps to Mysti's three tiers (core bundled / user home / workspace) plus a new `registry` source.
- **Skills registry browse**: Smithery's skills registry (`https://registry.smithery.ai/skills`, search + body fetch, 1 h TTL cache) can be called directly from the extension host (simple fetch + API key or anonymous) to power a skill-discovery picker that writes SKILL.md files into `~/.mysti/agents/skills/` — a natural upgrade of `npm run sync-agents`.
- **Fault tolerance + display-only-model-strings rules** (§8) — copy wholesale.

### Needs rethinking (different substrate)

- **No backend / no Smithery broker.** DeepMyst's whole connection layer rides Smithery's per-user OAuth hosting. Mysti has no server. Options: (a) lean on each CLI's native MCP management — Claude Code (`claude mcp add`, `.mcp.json`/`~/.claude.json`, including its own OAuth for remote MCP servers via `/mcp`), Gemini (`settings.json mcpServers`), Codex (`config.toml mcp_servers`) — Mysti becomes a *unified config writer + status reader* over those files; (b) integrate Smithery directly from the extension (Smithery exposes the same registry + hosted-connect APIs; would need the user's own Smithery key); (c) hybrid: registry browse via Smithery, connect via per-CLI config. For most Mysti users (a) is the truthful model: "connection management" = writing MCP server entries into the right CLI config + optionally launching the CLI's own auth flow in a terminal.
- **`request_connector` can't be injected as a tool.** DeepMyst controls the Anthropic tool list; Mysti spawns CLIs and cannot add custom tools to Claude Code/Gemini/Codex. Equivalents: (1) system-prompt instruction telling the agent to emit a structured marker (e.g. a fenced ```mysti:connect {label, search_query, reason}``` block) that Mysti parses out of the text stream into a `connection_required` chunk — same pattern Mysti presumably uses for plan options/suggestions; (2) detect failing `tool_use` events on `mcp__*` tools (server not configured/expired) and synthesize the connect card; (3) for Claude Code specifically, an `AskUserQuestion`/MCP-permission interception. Route (1) is provider-agnostic across all 12 backends.
- **Per-user vs per-machine scoping.** DeepMyst's multi-tenant per-user/shadow-principal machinery is irrelevant; Mysti's scope is machine + workspace. But the *per-agent slots* idea translates to per-provider slots: "Claude Code has Jira configured; Gemini does not — copy connection to Gemini?" — a genuinely valuable Mysti-only feature (sync one logical connection across CLI config formats).
- **Storage**: Postgres rows → `globalState` (connection registry metadata: display_name, icon_url, status, which CLIs have it) with the CLIs' own config files as source of truth; reconcile on activation like `SetupManager` does for CLI auth.
- **Skill mining**: DeepMyst mines server-side agent_runs with Haiku scout + Opus structuring + pgvector clustering. Mysti has no run database or embeddings store, but has `ConversationManager` history + `MemoryManager` precedent. A scaled-down port: periodic local scan of recent conversations → single cheap-model call ("does this contain a transferable method?") via an available CLI in non-interactive mode → draft SKILL.md files into `.mysti/agents/skills/drafts/` → review UI (webview list with approve/reject, approve = move into skills dir). Keep the SkillDraft state machine (pending/approved/rejected + source_hash dedup + confidence) — it's storage-agnostic.
- **OAuth popup + poll** → `vscode.env.openExternal` + extension-host polling; or, where the CLI owns auth (Claude Code remote MCP), spawn the CLI's auth command in a terminal and poll its config/status — same UX contract (card: needed → awaiting authorization → connected, with "Re-open setup" affordance).
- **Inbound MCP (`domains/mcp/handler.py`)** — exposing agents as MCP servers — is out of scope for Mysti v1, but the JSON-RPC handler is a ~180-line reference if Mysti ever exposes itself as an MCP server to the CLIs.

### Suggested Mysti event protocol (mirroring DeepMyst's)

```
StreamChunk additions:
  { type: 'connection_required', connection: { label, searchQuery, reason, providerId } }
WebviewMessage additions:
  ext→web: 'showConnectionCard' {panelId, turnId, callId, label, searchQuery, reason}
  web→ext: 'openConnectModal' {callId, searchQuery} / 'connectServer' {mcpUrl|registryId, targetClis[]}
  ext→web: 'connectionStatus' {callId, status: pending|connected|failed, errorMessage?}
Resume contract: none needed — user sends next message; provider session rebuild
  (or new spawn) picks up updated MCP config, matching DeepMyst's next-turn union.
```

---

## 10. Key file index (for the plan author)

- Connect modal: `apps/dashboard/src/features/mcp-connections/ConnectMcpModal.tsx`
- Hub page: `.../McpConnectionsSettingsPage.tsx`; per-agent panel: `.../McpConnectionPanel.tsx`; hooks: `.../useMcpConnections.ts`; API client: `.../mcpConnectionsService.ts`; types: `.../types.ts`
- Stream event reducer + block types: `apps/dashboard/src/features/agents/presentation/chatStreamTypes.ts` (`applyStreamEvent`, `ConnectorBlock`, `FormBlock`)
- Chat rendering + modal wiring: `apps/dashboard/src/features/agents/presentation/ChatPanel.tsx` (~325, ~1211, ~1357, ~1497)
- Meta-tool + dynamic tool builder: `apps/core-api/src/domains/agents/dynamic_tools.py` (`_REQUEST_CONNECTOR_TOOL` ~135, `_run_request_connector` ~275, `build_dynamic_tools` ~476)
- Sentinel→SSE conversion: `apps/core-api/src/domains/agents/presentation_chat_service.py` ~1261; prompt guidance: `presentation_prompt.py` ~384
- Connection service/routes: `apps/core-api/src/domains/agents/mcp_connections_service.py`, `mcp_connections_routes.py`, `me_mcp_connections_routes.py`; broker client: `smithery_client.py`; model: `agents/models.py` ~2534
- Skills: `apps/core-api/src/domains/skills/{service,registry,builtin_registry,models,routes,drafts_routes,extraction}.py`; pickers: `apps/dashboard/src/features/agents/components/{SkillManager,McpServerManager}.tsx`; drafts UI: `apps/dashboard/src/features/skills/`
- Agent shapes: `apps/dashboard/src/features/agents/types/agent.types.ts`
- Build plans: `docs/build-plans/agent_workflow.md`, `docs/build-plans/agent_types_roadmap.md`
