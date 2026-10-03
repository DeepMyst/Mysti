# Plan 22 — Canvas: the document is the canvas, the agent is a cursor

- **Date:** 2026-08-19
- **Status:** PHASES 0–6 BUILT (2026-08-19) — see the execution log at the end. Uncommitted on `feature/visual-testing`.
- **Supersedes:** the open items of `plans/05-canvas-overhaul.md` (§11 Build Spec v1 and the 2026-06-20 review's open list)
- **Depends on:** the Plan 19 coordinator substrate (`MystiTagScanner`, `coordinatorTools.ts`, `_fenceLocalToolResult`, `CollaboratorPool`) — all shipped
- **Method:** 13-agent audit → adversarial verification (64 of 73 findings confirmed, 9 refuted) → 3 independent architectures → judged synthesis. Every claim below is grounded in a file:line read of the working tree at `88f1f2b`.
- **Goal (verbatim):** *"Review Canvas, we would like to make it as good as claude design, think of how you can let the main Mysti agent communicate and update the canvas instead of canvas being a silo, also showing realtime design updates. Think from the ground up and using first principles."*

## 1. Verdict on the canvas today

The canvas subsystem is **8,112 LOC** (measured: `src/managers/Canvas*.ts` + `ArtifactStore.ts` + `FigmaImport.ts` + `src/services/Canvas*.ts` + `canvasContent.ts` + `media/canvas/canvas.js` + `resources/canvas-sandbox/*.js`), of which `CanvasManager.ts` alone is 3,182. It is backed by **22 test files / ~250 assertions**.

### What genuinely works and must be kept

- **`ArtifactStore.ts` (362)** — per-artifact directory, atomic tmp+rename, content-addressed `assets/<sha>.<ext>` with dedupe. `resolveAssetPath` (:329-342) is a correct traversal guard.
- **`CanvasOpExecutor.ts` (426)** — the whole submit → validate → stale-check → lock → stage|apply pipeline, supersession, `previousValue` capture. Well-built.
- **`CanvasFormats.ts` (236)** — device-px format catalog, `computeAnchors`, `buildFormatPersona`.
- **`CanvasScaffolds.ts` (206)** — five production-grade `function Page()` scaffolds on the `UI.*` primitives.
- **`CanvasThemePresets.ts` (167)**, **`CanvasValidator.ts` (97)**, **`CanvasCapabilityRegistry.ts` (155)**, **`CanvasSandbox.ts` (226)**.
- **`CanvasJobRouter.ts` (153)** — abort-aware `pipe()` with an exactly-one-terminal-event guarantee.
- **`CanvasToolServer.ts` / `CanvasMcpHttpServer.ts` / `CanvasSessionLinker.ts`** — the MCP lane; the loopback/Host/Origin checks and the 24-byte token and the 0600 temp config are all correct.
- **`resources/canvas-sandbox/ui-primitives.js`** — 22 primitives on `window.UI` (:230-234): `Screen, Stack, Row, AppShell, Sidebar, SidebarItem, TopBar, StatusBar, TabBar, Card, Section, Hero, Button, Field, Badge, Avatar, ListRow, StatCard, EmptyState, Chart, Heading, Text`.

### What is broken, verified

**The engine's best half has no callers.**
- `_router.emit` has exactly 11 sites, all in `CanvasOpExecutor.ts` (:112, :120, :128, :140, :157, :169, :177, :179, :190, :206, :208), emitting only `op_error`/`op_staged`/`op_applied`/`page_updated`/`op_rejected`. `CanvasJobEvent` also declares `started`, `progress`, `heartbeat`, `asset_ready` — **no producer exists for any of them**.
- `_canvasJobRouter` appears 4 times in `src/`: field (`ChatViewProvider.ts:222`), construction (:6671), pass-through (:6679), null-on-dispose (:6770). `create()`, `pipe()`, `cancel()`, `signal()` are **never called**.
- `submit()` defaults to `mode = 'staged'` (`CanvasOpExecutor.ts:92`); all three production call sites hardcode `'auto'` (:9018, :9147, and the prompt at :9121). `applyOp`/`rejectOp`/`undoLastApplied`/`setPageEditing` have **zero production callers**. There is no undo, no accept/reject, no page lock — while `CanvasPromptBuilder.ts:68` tells the model *"AUTO — your edits apply immediately (audited). Work confidently; the user can undo."*

**Element editing is a structural no-op.** `grep -rn elementOverrides src media resources tests` returns 7 hits: `types.ts:2303` (declaration), `ArtifactStore.ts:191` (copy-through), `CanvasOpExecutor.ts:341,344,393,396` (apply/revert), one test. **Zero renderers.** `media/canvas/canvas.js:82-87` and `CanvasSandbox.ts:116-145` both read only `jsxSource`/`htmlSource`; `_postCanvasArtifact` (:9162) doesn't even put the field on the wire. `harness.js:33` writes `data-el` DOM-index paths that nothing anywhere reads.

**The sandbox is one-way and reloads 3.14 MB per change.** `harness.js` has **no `message` listener** (grep: only `DOMContentLoaded` at :106). It Babel-compiles on mount (:92) and returns. The runtime is 3,144,476 bytes — `babel.min.js` alone is **2,983,904** (95%) — and `canvas.js:165-177` builds a fresh `<iframe>` and re-escapes the whole runtime into a new `srcdoc` on every render, including `window.addEventListener('resize', renderBoard)` (:246).

**The flagship agent cannot touch it.** `settings.provider === 'mysti'` reaches `await this._runMystiAgentic(...); return;` at `ChatViewProvider.ts:3344-3345` — ~375 lines *before* the canvas prompt snippet (:3719) and ~540 before the op-parser hook (:3884). `grep -c canvas src/services/coordinatorTools.ts` → **0**.

**Everything else** in the audit stands as written: two competing `ArtifactStore` instances that both write `.mysti/canvas/` (`CanvasManager.ts:83`, `ChatViewProvider.ts:6669`, plus a third in `canvasContent.ts:38`); the fenced path teaching `scaffold_page`, a kind `CanvasOpParser.VALID_KINDS` rejects; write-only ops with no receipts; a global canvas link that fails *open* (`_canvasChatOrigin === null` ⇒ every panel); `mcp__mysti-canvas__list_pages` classifying as `bash-command`; an unsandboxed export viewer; prose-mined SSRF in the media fetch; attribute injection in `FigmaImport`; workspace-scoped API keys.

### The single root cause

**The smallest addressable unit is a page-sized string.** Because a page is `jsxSource: string`:
- element edits have nowhere to live → `elementOverrides` became a side-band nobody rendered;
- "change this button" is a whole-page rewrite → human tweaks are destroyed;
- there is no partial state → streaming is impossible, so realtime degenerates into re-posting the artifact;
- undo costs a 30 KB snapshot per edit;
- an artboard cannot fit in a 4096-token tool call;
- conflict detection can only be page-scoped, so read-once-then-three-edits self-stales.

Every parity gap is downstream of that one decision. So we change that one decision.

---

## 2. First principles

1. **A design tool is a document editor, not a renderer.** Element identity is the primitive that selection, properties, comments, overrides, conflict and undo are all built on. It is decided first.
2. **Identity must be authored, not inferred.** DOM-index paths are a function of tree shape and retarget the moment an agent inserts a wrapper. Ids live *in* the document, round-trip through everything the model reads and writes, and have a defined recovery path.
3. **One op algebra, N producers.** The set of ops the agent can perform is exactly the set the UI performs. A human drag, a properties slider, an MCP `tools/call`, and a `<canvas:NONCE>` directive produce the identical record.
4. **`ok` means the document changed** — and the receipt carries the new version plus everything the writer missed.
5. **Human intent outranks agent intent, and the agent must be told when it loses.** Pinned cells are excluded from agent diffs; locked subtrees park agent ops; the parking is reported back into the run.
6. **Realtime is a delta protocol over a persistent renderer.** The wire unit is the op, the render unit is the artboard, and the frame outlives the edit so React reconciliation preserves scroll/focus/hover.
7. **Capabilities up, authority unchanged.** Canvas ops get their own authority class — `.mysti/canvas/<id>/` only, no shell, no network, fully invertible. Anything crossing that boundary uses the existing `forceInteractive` gate.
8. **Untrusted is a property of the data, not the transport.** Page source is model-authored; Figma payloads are third-party; canvas comments are human text arriving through a webview. All re-enter a model only through `_fenceLocalToolResult`, clamped.
9. **One implementation per seam.** Every divergence in this subsystem exists because a second implementation was allowed (`canvas.js`'s hand-mirror of `CanvasSandbox.ts` has already drifted three ways: no `asset://` resolution, missing `--theme-space-unit`, dropped `page_size`).

---

## 3. Target architecture

```
   human pointer ─┐
   properties ────┤
   inline text ───┤
                  ├──▶ CanvasOp[] ──▶ CanvasOpExecutor.submit()  ← THE chokepoint
   @mysti ────────┤                        │  validate · pin-check · rebase · lock · stage|apply
   Claude Code ───┤                        ▼
   CLI fenced ────┘                   ArtifactStore (.mysti/canvas/<id>/)
                                           ▼
                                   CanvasHistory (txn cursor, versions)
                                           │
                     CanvasOpRecord deltas + receipts + job events
                                           ▼
                     canvas webview (compiled TS, dist/canvasWebview.js)
                       board (pan/zoom world) · N artboards · parent-drawn selection
                       ├─ live frame  ──MessageChannel──▶ harness (doc interpreter)
                       └─ static preview (parent-rendered, no iframe, no scripts)
```

### 3.1 Data model — `src/canvas/doc/`

```ts
// src/canvas/doc/DocNode.ts
export type Mid = string;                   // 10-char base32, minted host-side

export interface DocNode {
  mid: Mid;
  tag: string;                              // 'div'|'h1'|'img' (HTML allowlist) | 'UI.Card' (22 primitives)
  props?: Record<string, JsonValue>;        // literal props: gap={20}, variant="secondary", data={[…]}
  style?: Record<string, string>;           // filtered CSS subset, theme tokens preferred
  text?: string;                            // leaf content — mutually exclusive with children
  children?: DocNode[];
  slots?: Record<string, DocNode[]>;        // JSX-valued props: trailing={<UI.Text/>}, actions={[…]}
  pins?: Record<string, PinRecord>;         // 'style.background' | 'props.label' | 'text'  ← GRAFT: Weave
  by?: 'agent' | 'user';
  frame?: { x: number; y: number; w?: number; h?: number };
}
export interface PinRecord { at: number; opId: string; }
```

`ArtifactPage` (replacing `src/types.ts:2286-2313`):

```ts
export interface ArtifactPage {
  id: string;
  version: number;
  doc: DocNode;                             // ← SOURCE OF TRUTH
  jsxCache?: string;                        // derived by DocEmitter; what read_page returns
  legacy?: { mode: 'jsx' | 'html'; source: string };   // uncompilable escape hatch
  compileError?: string;
  actionTitle?: string;
  format?: CanvasFormatSpec;                // per-artboard device override
  boardPos: { x: number; y: number };
  variantGroupId?: string;
  notes?: string;
}
```

**Deleted from the type:** `elementOverrides`, `droppedAssets`, `previewAsset`, `nodes`, `stitchRef`, `mode`, `htmlSource`, `jsxSource`. `elementOverrides` is not wired up — it is *removed as a concept*, because when the doc is the truth a human's element edit is a first-class op, not a shadow layer.

#### The JSX subset — verified, not assumed

`PageCompiler` (`src/canvas/doc/PageCompiler.ts`) uses **`@babel/parser`** (new `dependencies` entry; parser only, no transform) and is a *static evaluator*, not a bundler. It folds: JSX elements → `DocNode`; literal props; `style={{…}}` camelCase→kebab; object/array literal props; JSX-valued props → `slots`; local `const x = (<JSX/>)` bindings inlined at use; string/`{'literal'}` children → `text`.

I verified this subset covers **all five shipped scaffolds** with zero authoring changes:
- `LOGIN`, `SETTINGS`, `LANDING` — plain nested JSX with literal + style props.
- `MOBILE_HOME` — JSX-in-prop (`leading={<UI.Avatar…/>}`, `trailing={<UI.Badge…>}`), array-of-object prop (`items={[{label:'Home',…}]}`).
- `DASHBOARD` — local const JSX bindings (`const sidebar = (<UI.Sidebar…>)` at :89-96, `const topBar = <UI.TopBar actions={[<UI.Button key="n"…/>, <UI.Avatar key="a"…/>]}/>` at :97), array-of-JSX prop, object-array literal prop (`data={[{label:'Jan',value:22},…]}` at :110-113).

**No `.map`, no ternaries, no hooks, no runtime logic anywhere.** Anything outside the subset fails compilation, is stored as `legacy`, still renders (Babel lazily injected into *that one frame*), and is badged in the rail as **"code page — not directly editable"**. Honest, visible degradation.

`DocEmitter` (doc → JSX) is the exact inverse. Round-trip test: `compile(emit(doc)) ≡ doc` for all five scaffolds and every fixture.

#### Mid stability — three tiers

1. **Echoed.** `read_page` / `get_page_jsx` return `DocEmitter` output with `mid="k7f2xq9b1m"` on every element; the tool description says *keep the mids you were given; omit them only on genuinely new elements*. Models preserve attributes they don't understand, so unchanged nodes keep exact identity for free.
2. **Reconciled.** `src/canvas/doc/Reconciler.ts` (~180 LOC, pure): for nodes with no mid or an unknown mid, keyed tree diff per parent — exact matches (same `tag` + same `props.key` or identical `text`) form an LCS backbone, gaps filled greedily by `0.5·tagEqual + 0.3·dice(text) + 0.2·propOverlap` above 0.55. Matched nodes inherit the previous mid.
3. **Minted.** Unmatched → fresh id. The receipt returns `newMids`.

**Security note (graft from Weave, resolved):** an incoming mid from a model is a *matching hint*, never an authority. The host verifies it exists and is structurally compatible; otherwise it is discarded and re-minted. Pin enforcement is on the **target cell**, not on the claimed identity, so forging a mid gains an attacker nothing.

#### Persistence — `.mysti/canvas/<artifactId>/`

| file | contents | why |
|---|---|---|
| `artifact.json` | `schemaVersion`, `version`, name/kind/theme/format, `pages[]`, `assets[]`, `versions[]` — **no op log** | small, cheap, CAS-saveable |
| `oplog.jsonl` | append-only `CanvasOpRecord`; `inverse` instead of full-page clones | one `appendFile` per op instead of a whole-file rewrite |
| `versions/<sha>.json` | content-addressed page snapshots for named checkpoints | O(1) restore + side-by-side compare |
| `index.json` | `{id,name,kind,pageCount,updatedAt,thumb}` | `list()` becomes N small reads (today it fully parses every design's page sources) |
| `assets/<sha>.<ext>` | unchanged | already correct |

`load()` distinguishes **absent** (→ `null`) from **corrupt** (→ `ArtifactCorruptError` → modal: *open the file / restore backup / start fresh*). `.bak` before every overwrite. `save()` is compare-and-swap on `artifact.version` — a stale copy fails loudly instead of last-writer-wins across two VS Code windows. `artifact.json` persists on a 2 s debounce; `oplog.jsonl` appends immediately, so a crash between the two replays cleanly.

### 3.2 Op protocol — `src/canvas/CanvasOps.ts`

```ts
export type CanvasOp =
  // artboard / board scope
  | { op:'page.add';       page: NewPageSpec; index?: number }
  | { op:'page.remove';    pageId: string }
  | { op:'page.duplicate'; pageId: string; variantOf?: string }
  | { op:'page.setMeta';   pageId: string; patch: { actionTitle?: string; notes?: string; format?: CanvasFormatSpec } }
  | { op:'page.move';      pageId: string; boardPos: { x:number; y:number } }
  | { op:'page.reorder';   orderedIds: string[] }
  | { op:'page.setDoc';    pageId: string; doc: DocNode }          // whole-artboard write (coarse)
  // element scope — the direct-manipulation set
  | { op:'el.setText';     pageId: string; mid: Mid; text: string }
  | { op:'el.setStyle';    pageId: string; mid: Mid; style: Record<string, string|null> }
  | { op:'el.setProp';     pageId: string; mid: Mid; name: string; value: JsonValue|null }
  | { op:'el.insert';      pageId: string; parentMid: Mid; before: Mid|'end'; node: DocNodeInput }
  | { op:'el.remove';      pageId: string; mid: Mid }
  | { op:'el.move';        pageId: string; mid: Mid; newParentMid: Mid; before: Mid|'end' }
  | { op:'el.replace';     pageId: string; mid: Mid; node: DocNodeInput }
  // artifact scope
  | { op:'theme.set';      theme: DesignTheme }
  | { op:'theme.setToken'; path: string; value: string }
  | { op:'artifact.setFormat'; format: CanvasFormatSpec }
  | { op:'asset.add';      asset: CanvasAssetRecord };
```

**Anchor-relative insertion** (`before: Mid | 'end'`) rather than an integer index. This is a synthesis improvement over both runners-up: under a single-process sequencer, fractional indices are more machinery than needed, but a stale *integer* index silently retargets when a human inserts a sibling. An anchor mid rebases correctly by construction. (Fractional indices remain the documented upgrade path if we ever go multi-writer.)

```ts
export interface CanvasOpRecord {
  opId: string;
  txnId: string;                 // one human drag = 1 txn; one agent turn = 1 txn
  runId: string;                 // REAL chat turn / job id — not the literal 'mcp'
  author: 'user' | 'agent';      // STAMPED HOST-SIDE from the arriving channel, never from payload
  actorId: string;
  op: CanvasOp;
  baseVersion?: number;
  inverse?: CanvasOp;            // computed at apply — undo without snapshots
  status: 'applied'|'staged'|'rejected'|'stale'|'superseded'|'undone';
  ts: number;
}

export interface CanvasOpReceipt {
  opId: string;
  status: CanvasOpRecord['status'];
  pageId?: string;
  pageVersion?: number;
  artifactVersion: number;
  rebased?: boolean;             // stale, but the target mid survived → re-applied
  pinned?: string[];             // cells refused because the human owns them   ← GRAFT: Weave
  newMids?: Record<string, Mid>;
  since?: CanvasOpRecord[];      // what the writer missed → ONE read per chain  ← GRAFT: Weave
  issues?: PageValidationIssue[];
  error?: string;
}
```

`inverse` replaces `previousValue`'s deep clone of whole page sources (`CanvasOpExecutor.ts:413-425`).

**Executor changes** (`src/managers/CanvasOpExecutor.ts` — shape kept, internals rewritten):
1. `_apply`/`_revert` rewritten over `src/canvas/doc/DocPatch.ts`: pure `applyOp(doc, op) → {doc, inverse, newMids}`.
2. **Scope-correct staleness.** Page ops check `page.version`; artifact-scope ops (`theme.*`, `artifact.setFormat`, `page.reorder`) check `artifact.version` — the field `_touch` maintains (`ArtifactStore.ts:348-351`) and nothing reads today.
3. **Semantic rebase.** A stale element op whose `mid` still exists is re-applied against the current doc; the receipt says `rebased: true`. Only a vanished mid returns `stale`.
4. **Pin enforcement.** An agent op targeting a cell with a `PinRecord` is rejected with `pinned:[cell]` unless `force` names it. A `force` shows an *"agent overrode your change · undo"* chip on that node.
5. **Subtree locks.** `_lockedPages: Set<string>` → `_lockedSubtrees: Map<pageId, Set<Mid>>`. Agent ops inside a locked subtree park as staged suggestions; ops elsewhere on the same page apply immediately. Page-level locking could never be this permissive — mid addressing is what buys it.
6. **Approval mode is derived.** `resolveCanvasApproval(settings): 'staged'|'auto'` — one exported, unit-tested function called by every transport and fed to `buildCanvasContextBlock`, so the prompt can never contradict the UI.

`src/canvas/CanvasHistory.ts` — undo is a **cursor**, not a status mutation (`undoLastApplied` sets `status='rejected'` at :205, conflating "undone" with "user rejected" and making redo impossible):

```ts
class CanvasHistory {
  undo(): CanvasOpReceipt[];       // revert to the previous txn boundary
  redo(): CanvasOpReceipt[];
  checkpoint(label: string): VersionRef;
  restore(ref: VersionRef): void;  // emitted AS OPS → itself undoable
  opsForRun(runId: string): CanvasOpRecord[];   // "undo this whole design pass"
}
```

### 3.3 Agent tool surface — `src/canvas/CanvasToolSurface.ts`

**One generator, three transports.** Tool descriptors are derived from the op algebra plus a read set; `dispatchCanvasTool` is the sole executor entry for all of them.

```
reads:   get_artifact_index · list_pages · get_page_jsx (mid-annotated) · get_node · find_nodes
         page_coordinates · validate_page · list_scaffolds · list_theme_presets
writes:  open_canvas · add_page · remove_page · duplicate_page · set_page_meta · move_page
         reorder_pages · write_page · set_text · set_style · set_prop · insert_element
         remove_element · move_element · replace_element · set_theme · set_theme_token
         set_format · checkpoint
gated:   generate_visual · generate_video · import_design · export_artifact
```

A conformance test asserts, for every `CanvasOp` variant, that (a) a tool produces it, (b) a UI gesture produces it, and (c) **every example in the system prompt round-trips to a valid op** — which is what prevents today's failure where the only worked example teaches `scaffold_page`, a kind the parser rejects, and the rejection surfaces as a `console.warn`.

#### Transport A — the @mysti coordinator, in-process

Four surgical additions, following the pattern Plan 19 already proved twice:

1. **`src/utils/mystiDelegateParser.ts`** — `MYSTI_CANVAS_KINDS = ['canvas','canvaspage']` alongside `MYSTI_EXEC_KINDS` (:89) / `MYSTI_MCP_KINDS` (:104), with directive variants:
   ```
   <canvas:NONCE tool="set_text">{"pageId":"p1","mid":"k7f2xq9b1m","text":"Get started"}</canvas>
   <canvaspage:NONCE page="p1" title="Login">function Page(){ … }</canvaspage>
   ```
   Nonce-fenced and fence-aware for free. The bare ```` ```canvas-op ```` fence (`CanvasOpParser.ts:40`) is deleted — it is forgeable by any README the model reads back.

2. **`src/services/coordinatorTools.ts`** — `coordinatorToolSchemas(execEnabled, mcpTools, connectEnabled, canvasBound)` appends canvas schemas; `toolCallToDirective` maps `canvas_*` → `{kind:'canvas', tool, args}`, so a native call is converted into the identical directive the text path produces and is never more trusted.

3. **`_runMystiAgentic`** — `scanKinds` (:7370) gains `...MYSTI_CANVAS_KINDS` (always, so `open_canvas` is reachable from zero). Dispatch is a branch modelled verbatim on the `mcptool` branch at **:7647-7681**: `postToolUse` → `dispatchCanvasTool(...)` in-process → `postToolResult` → `recordLocalCard` → `messages.push(assistant)` → `messages.push(user: _fenceLocalToolResult(...))` → `continue`.

4. **`_mystiAgenticSystemPrompt`** — a canvas block present only when bound, generated from the same catalog.

**GRAFT — two encodings split on payload size.** Verified constraints: `maxTokens: 4096` (`ChatViewProvider.ts:7399`), both length-continuation branches explicitly excluded on tool-call turns (`if (!directive && !(turnToolCalls && turnToolCalls.length) && finishReason === 'length' …)` at :7441 and :7454), and `parseToolArgs` returning `{}` on truncation with no signal (`toolCallAccumulator.ts:62-70`). A native tool call **cannot** carry an artboard today; the model would burn its 24-turn budget re-truncating. Therefore:
- **structured small ops → native `tool_calls`** (`set_text`, `set_style`, `insert_element`, `set_theme_token`, `reorder_pages`, `validate_page` — all fit comfortably);
- **verbatim whole-artboard JSX → `<canvaspage:NONCE>` TEXT directive**, where `carryScanner = true` (:7442) already reassembles a payload split by a length cut;
- `maxTokens` becomes `canvasBound ? 8192 : 4096`;
- `parseToolArgs` returns `{ args, truncated }` so the loop reports *truncated*, not *wrong arguments*.

**Never route the coordinator through `McpClient`.** `isDeepMystHost` treats `localhost`/`127.0.0.1` as DeepMyst (`DeepMystClient.ts:149-156`), so routing the loopback canvas MCP server through `_mystiMcpToolset` would hand the `dm_` bearer to a local HTTP server. In-process dispatch is cheaper and strictly safer.

#### Transport B — CLI providers over MCP

`ProviderCapabilities` gains `canvasTransport: 'mcp' | 'text' | 'none'`. `CanvasSessionLinker` emits per-transport config: Claude Code `--mcp-config` (today the only reader, `ClaudeCodeProvider.ts:384-385`), marker-tagged persistent entries for Gemini/Qwen/Codex/OpenCode, ACP session MCP for Hermes/Kimi. Registration switches from **push at canvas-open** to **pull at spawn** (`buildCliArgs` asks `CanvasWorkspace.cliArgsFor(panelId, providerId)`), which fixes `setCanvasMcpConfig` resolving to `mysti.defaultProvider` instead of the panel's effective provider, and fixes provider switches and late opens by construction.

#### Transport C — nonce-fenced tool calls in text

`CanvasCallParser` replaces `CanvasOpParser`: nonce-triggered, fence-aware (today `:82` closes on the first backtick run, truncating any body with a nested fence), **per-panel-session state** (today one shared instance on the provider singleton, re-created mid-flight by any other panel's send at :3763), carrying `{tool, args}` into the *same* `dispatchCanvasTool`. Receipts inject into the next turn. The block is **stripped from `assistantContent`** and replaced with a `tool`-kind `MessageSegment` ("Canvas · set text on Login (v4)") — today a 30 KB JSX page is rendered into chat *and* persisted into history *and* re-sent as context.

Providers whose `sendMessage` overrides drop `channelSystemContext` (`OpenRouterProvider.ts:216`, `OllamaProvider.ts:356`, `LocalAIProvider.ts:363`) get the block prepended to the user turn, or an honest top-bar chip: *"this backend can't edit the canvas."*

#### Ownership — `src/canvas/CanvasWorkspace.ts`

```ts
class CanvasWorkspace {
  private _store = new ArtifactStore();                      // ONE (three exist today)
  private _sessions = new Map<ArtifactId, CanvasSession>();  // artifact + executor + history + jobRouter + panel
  private _bindings = new Map<BindingKey, ArtifactId>();     // panelId | runId | collabPanelId
  open(artifactId?: string, opts?: { origin?: BindingKey }): Promise<CanvasSession>;
  bind(key: BindingKey, artifactId: ArtifactId): void;
  resolve(key: BindingKey): CanvasSession | null;            // null = UNBOUND (fail CLOSED)
}
```

Registered in `extension.ts` like every other manager. Panels keyed `Map<artifactId, panel>` so multiple designs open side by side. **`null` means unbound**, inverting today's fail-open polarity where `_canvasChatOrigin === null` links every panel. `CollaboratorPool` spawn options carry the binding so `-collab-` derived panels (`CollaboratorPool.ts:790`) inherit access. Boot splits: artifact + webview shell resolve **synchronously**; capability probing (up to four `listMcpConnections()` calls that currently gate `panel.webview.html`) patches chips in later.

`open_canvas(name, format)` is an agent tool — today every opener is human (`extension.ts:694`, `chat.js:5170`, `SlashCommandManager.ts:336`) and `CanvasToolServer.ts:126-128` refuses when none is open, so *"design me a login screen"* produces prose.

### 3.4 Realtime protocol

**Shared discriminated union, `src/canvas/protocol.ts`, exhaustively switched on both ends** — so an orphaned handler or a handler-less button fails `tsc` (today `_handleCanvasMessage` has 14 cases, the shell sends 3, `#btn-present` posts a message with no handler, and the host answers `canvasReady` with a `canvasLoad` the shell ignores).

```ts
// host → webview
| { t:'canvas/hello';       artifactId: string; artifact: WireArtifact; viewToken: string; caps: CapChip[] }
| { t:'canvas/ops';         records: CanvasOpRecord[]; artifactVersion: number }   // STEADY STATE
| { t:'canvas/staged';      records: CanvasOpRecord[] }
| { t:'canvas/receipt';     receipt: CanvasOpReceipt }
| { t:'canvas/job';         event: CanvasJobEvent }                                 // started/heartbeat/progress
| { t:'canvas/agentCursor'; pageId: string; mid?: Mid; label: string }
| { t:'canvas/resync';      artifact: WireArtifact; artifactVersion: number }
| { t:'canvas/artifacts';   summaries: ArtifactSummary[] }

// webview → host   (all carry viewToken)
| { t:'canvas/ready';       artifactId?: string; haveVersion?: number }
| { t:'canvas/submit';      txnId: string; ops: CanvasOp[]; baseVersions: Record<string,number>; force?: string[] }
| { t:'canvas/selection';   pageId: string; mids: Mid[] }
| { t:'canvas/editing';     pageId: string; mids: Mid[]; editing: boolean }
| { t:'canvas/decide';      opIds: string[]; accept: boolean }
| { t:'canvas/undo' } | { t:'canvas/redo' }
| { t:'canvas/checkpoint';  label: string } | { t:'canvas/restore'; ref: string }
| { t:'canvas/comment';     pageId: string; mid?: Mid; text: string }
| { t:'canvas/cancelJob';   jobId: string }
| { t:'canvas/frameError';  pageId: string; mid?: Mid; message: string }
| { t:'canvas/export' | 'canvas/present' | 'canvas/newArtifact' | 'canvas/openArtifact' | 'canvas/renameArtifact'; … }
```

`canvas/ready` is the **single authoritative state transfer** (fixes stale-boot-on-reload: the artifact is baked into the HTML once at :6726 and never refreshed). The client tracks `artifactVersion` and requests `canvas/resync` on a gap. `author` is stamped host-side; the sandboxed frame cannot reach `canvas/submit`, so a model-authored page cannot forge a human op.

**Frame channel.** A dedicated `MessageChannel` port posted into each iframe on load. Down: `mount {doc,theme,format}`, `patch {ops}`, `select {mids}`, `beginTextEdit {mid}`, `measure`. Up: `ready`, `rects {mid→DOMRect}`, `size {w,h}`, `hit {mid,rect,modifiers}`, `textCommit {mid,text}`, `error {message,stack,mid}`. This deletes the `ev.source !== window` heuristic (`canvas.js:264`) that the code itself flags as unverified — page traffic and host traffic become structurally different channels.

**Rendering — three tiers of liveness:**

- **Tier 0 — deltas (steady state).** `canvas/ops` carries records; mounted artboards get `patch {ops}` over their port; the harness applies them and re-renders the **existing** React root. React reconciliation preserves scroll, focus, hover, input values, CSS animation. A `set_text` on a 20-artboard design goes from ~600 KB of clone traffic + two 3 MB frame rebuilds to a ~200-byte message and a text-node update. Exactly one terminal event per op (`page_updated` subsumes `op_applied` for rendering; the sink dispatches on `event.pageId`, which the type has always carried and nothing reads).

- **Tier 1 — liveness, zero model cooperation.** `CanvasJobRouter.create()` mints a real job when a canvas directive/fence/tool-call **opens**; `started {label}` → a dashed **ghost artboard** with a shimmer at the target `boardPos`; `heartbeat {elapsedSeconds}` every 2 s → live elapsed timer + working **Cancel** wired to `router.cancel(jobId)`; `canvas/agentCursor` → a labelled ghost highlight on the node being edited, drawn by the same parent overlay that draws human selection.

- **Tier 2 — structural + token-level streaming.** The designer prompt instructs shell-then-sections, so a page materialises in ~5 visible steps **on every transport**. Additionally, for coordinator turns: `PageCompiler.compilePartial(src)` parses the syntactically-complete prefix; on a ~150 ms throttle we **diff the new partial doc against the previous partial doc and push the resulting ops** as a speculative patch (graft from Weave — streaming produces ops, not documents — but via Artboard's far simpler prefix compiler rather than an incremental open-tag tokenizer). Speculative ops never enter the journal; on close, the authoritative doc replaces them with the same mids via reconciliation, so nothing jumps.

**Parent-side static previews** (`src/webview/canvas/preview.ts`) — because the *parent* holds the DocNode tree, it can render any artboard directly into the webview DOM with **no iframe and no scripts**: an allowlist interpreter that sets `textContent` (never `innerHTML`), applies a filtered style subset, and resolves `img` only from `asset://` → webview URI. One renderer gives rail thumbnails, offscreen board tiles, zoomed-out views, and staged before/after previews — always fresh, no rasterization needed. (Rasterization was never available: `sandbox="allow-scripts"` without `allow-same-origin` denies the parent pixel access.) Live frames mount only for artboards intersecting the viewport above a zoom threshold, via `IntersectionObserver` — cost is O(visible), not O(pages).

### 3.5 Co-edit rules

**Artifact state vs view state:**

| Artifact state (shared, persisted, op-mediated) | View state (local, sovereign, never overwritten) |
|---|---|
| theme, tokens, per-artboard format, docs, board positions, page order | selection, hover, zoom, pan, focused artboard, *previewed* device, inspector tab |

Today `format` is artifact state edited as if it were view state (`canvas.js:212-219` mutates locally and posts nothing; `:274` `Object.assign`s it away) — which is why it is both lost and destructive. Under this split, "switch to mobile to check a layout" is a *preview*; "this artboard is a mobile screen" is `page.setMeta.format`.

**Pins (graft from Weave) — the mechanism, not a policy:**
1. Any committed op with `author:'user'` writes `pins['style.background'] = {at, opId}` on the target cell.
2. `TreeDiffer` **excludes pinned cells** from a whole-page rewrite diff — the human's change is not even a candidate for reversion.
3. `submit()` rejects an unforced agent write to a pinned cell with `pinned:[cell]` in the receipt.
4. **The model can see pins.** `get_page_jsx` renders them: `<UI.Button mid="k7f2xq9b1m" /* ⟂user-set: style.background, props.label */ …>`, and the prompt says: *never overwrite a `⟂user-set` cell unless the user's message asks for that specific change; pass it in `force` if they did.*
5. Unpinning is a human act — a dot in the inspector, plus a bulk "let the agent restyle everything".

**Whole-page rewrites.** `write_page` → compile → **reconcile** (matched nodes inherit mids) → **diff with pinned cells excluded** → element ops. Anything that could not be honored because its node vanished is reported as `{applied, dropped}` and rendered as dismissible cards on the artboard, with the previous version one click away.

**Conflict ladder:** `baseVersion` matches → apply. Mismatch + mid survives → **rebase**, `rebased:true`. Mismatch + mid gone → `stale` naming the page and version. Artifact-scope ops check `artifact.version`.

**Undo/redo.** One shared stack — a design tool must make Cmd+Z mean "undo the last thing that happened", whoever did it. Txn grouping: one human drag = 1 txn (slider drags coalesce on pointer-up); one agent turn = 1 txn keyed by `runId`, so Cmd+Z after a bad design pass reverts the whole pass. Exposed three ways: Cmd+Z in the canvas, an `undo_canvas` chat tool, and per-suggestion reject. **The agent is deliberately given no undo tool** — an agent that can revert the human's work is a hazard; it corrects by editing forward.

**Steering — a per-run inbox.** `_runMystiAgentic` builds `messages` turn by turn (:7247-7254) with no injection point. Add a queue drained at the **top of each `while` iteration, before `stream()` starts** — never mid-stream, or it races the abort-on-directive logic at :7408-7418. Producers: `canvas/comment` (click an element, type "make this lighter"), accept/reject outcomes, parked/stale/pinned notices, frame render errors. All folded into **one** `_fenceLocalToolResult` user turn — comments are human text arriving through a webview, therefore data.

### 3.6 Security invariants

| Invariant | Implementation |
|---|---|
| Control channel unforgeable | `<canvas:NONCE>` / `<canvaspage:NONCE>` through `MystiTagScanner` (nonce + fence-aware + fail-open). CLI text lane uses ```` ```canvas-call:NONCE ````. The bare ```` ```canvas-op ```` fence is deleted. |
| Untrusted results | Every canvas read re-enters via `_fenceLocalToolResult` (:8563-8576) **plus the delegate fencer's clamp** (`CLAMP_HEAD 9_000 / CLAMP_TAIL 3_000`, :8455) which it currently lacks. `get_artifact_index` is the default orientation tool; `get_node` reads one subtree. |
| Permission class | New `canvas-read` (never gated) and `canvas-edit` (gated only in `staged` mode, and then as an in-canvas card, not a modal) in `PermissionActionType` + `ACTION_TOOLS`/`READ_ONLY_TOOLS`. `normalizeToolName` strips `mcp__<server>__` so `mcp__mysti-canvas__list_pages` stops classifying as `bash-command`. |
| Boundary tools | `generate_visual`, `generate_video`, `import_design`, `export_artifact` → `requestPermissionInline(…, forceInteractive: true)` — the only construction surviving both autonomous-aggressive (:5611) and a permission TIMEOUT under `timeoutBehavior:'auto-accept'` (`PermissionManager.ts:211`). |
| `dm_` key confined | Coordinator dispatches **in-process**, never through `McpClient`. |
| Sandbox is a property of content | One builder emits the frame element **and** the document: `sandbox="allow-scripts"` everywhere including the export viewer (today `CanvasExportService.ts:128` emits a bare `<iframe>` then offers `openExternal`); CSP `img-src data: blob: <cspSource>` (drops `https:` — assets are content-addressed, so remote images aren't load-bearing and the GET-beacon exfil channel closes), `form-action 'none'`, `base-uri 'none'`. |
| Importers are transcoders | `FigmaImport` builds `DocNode` trees with `Number()`-coerced + clamped numerics and font families matched against `/^[\w \-]+$/` — never string-concatenated into `style="…"` (:100, :133-152). |
| Host fetches constrained | Media URLs from a typed field, not `res.text.match(/https?:\/\/[^\s"')]+/)` (:9086-9088); then `new URL` + `https:` only + reject loopback/RFC1918/link-local + `Content-Length` cap + content-type allowlist. Wire `resolveAssetPath` (zero callers today). |
| MCP token | Minted **per artifact**, `resolveContext` captured at construction (today it closes over the provider, so a token follows the user into their next design); `stop()` idempotent via a `_stopped` flag checked after `listen` resolves; disposal registered before the async startup. |
| Secrets | `mysti.canvas.*ApiKey` and `mysti.canvas.capabilities.*` declared `"scope": "machine"`; `CanvasSecrets.migrate()` adopts only `config.inspect(key).globalValue` and warns-and-clears workspace values. |
| No new shell path | `DevServerManager.start` remains the sole `shell:true` chokepoint. Design→code export is **not** a canvas op — it goes through gated `MystiLocalExec`. |

---

## 4. Claude-Design parity gap table

| # | Bar | Today (verified) | Mechanism | Phase |
|---|---|---|---|---|
| 1 | Multiple artboards | One `<iframe>` for the selected page in a single `#page-stage`, fit-to-width, capped at 1× (`canvas.js:152-178`); 20 pages = 19 text rows | One transformed world, per-artboard `boardPos` + `format`, wheel-zoom / space-pan / zoom-to-fit; `IntersectionObserver` swaps live frames ⟷ parent static previews | 3 |
| 2 | Click-to-select any element | Impossible: 12 listeners, none element-level; harness has **no message listener**; `data-el` read by nothing | Harness `hit {mid,rect}` over the port; parent-drawn overlay from reported rects × board transform (survives repaints, works over static previews); marquee, shift-click, Tab, arrow-nudge | 3 |
| 3 | Properties panel | Five static `<span>` rows + nine inert swatches (`canvas.js:181-206`); zero `<input>` in the shell; the op it would write (`edit_element`→`elementOverrides`) has **zero renderers** | `src/canvas/UiSchema.ts` declares editable props/styles per primitive (22 verified) and per role; every control emits `el.setProp`/`el.setStyle` — the *identical* op an agent tool produces | 3 |
| 4 | Inline text editing | Nonexistent | `beginTextEdit {mid}` → `contenteditable` on that node → `textCommit` → `el.setText`. Text lives in `DocNode.text`, so no source-splice ambiguity | 3 |
| 5 | Undo/redo | No keybinding, no button, no tool; `undoLastApplied`/`rejectOp` have **zero production callers**; prompt promises undo that doesn't exist | `CanvasHistory` cursor + txn grouping; Cmd+Z / Cmd+Shift+Z; `undo_canvas` chat tool; one agent turn = one restore point | 3 (cursor lands in 2) |
| 6 | Versioned save | Incrementing `version` read nowhere; unbounded op log with full-page clones; whole file rewritten every 800 ms | Named content-addressed checkpoints in `versions/<sha>.json` + `versions[]` index; history timeline with parent-rendered thumbnails; op log to `oplog.jsonl` sidecar | 6 |
| 7 | Export | HTML bundle in an **unsandboxed** viewer iframe; `exportPng` tested with no caller; Present posts a message with no handler | One frame builder for board / thumbnail / PNG / PDF / viewer, all with `sandbox` + hardened CSP; Present = viewer fullscreen with arrow paging | 6 |
| 8 | Agent authors live | Under `provider==='mysti'` **structurally impossible** (early return :3344, zero canvas refs in `coordinatorTools.ts`); 12 providers get a blind write-only channel; 3 see nothing; collaborators excluded | One tool surface, three transports; ghost artboards + agent cursor + heartbeats + Cancel; op-level deltas; speculative streaming for the coordinator | 1 (blob) → 4 (ops) → 5 (streaming) |
| 9 | Human edits survive | Zero-for-two: both human affordances are local-only and `Object.assign`ed away; view jumps to the newest page | Stable mids + reconciler + **pins excluded from agent diffs** + subtree locks + rebase-before-stale + reported drops | 2–4 |
| 10 | Steering | One-way; canvas sends 4 message types, none reaching a run | Per-run inbox: comments, accept/reject, parked/stale/pinned notices, frame errors → one fenced turn | 5 |

**Beyond parity:** variants are near-free (N artboards sharing `variantGroupId`, "use this" = `page.remove` on the losers — one field, no subsystem); and design ⇄ code round-trip, since `DocEmitter` already emits real JSX, so "export this artboard as a component" is a gated `MystiLocalExec` write into `src/` — which a hosted design tool structurally cannot do.

---

## 5. Phased build order

Each phase ships something runnable. Phase 0 is the explicit hedge: after it, everything else is optional rather than urgent.

### Phase 0 — One owner, honest wiring, closed holes (~1 week)

*Ships:* today's canvas, trustworthy. No silent op failures, no stale view after reload, no orphan artifacts, no phantom buttons, no over-gating, every audited security finding closed.

- **Ownership:** `src/canvas/CanvasWorkspace.ts` (one `ArtifactStore`, sessions map, bindings map, fail-closed `resolve`), registered in `extension.ts`; route `ChatViewProvider`'s nine `_canvas*` fields through it. **Delete** `CanvasManager.ts` (3,182), `CanvasSession`/`canvasJson`, the 11 unreachable `_handleCanvasMessage` cases, the `canvasReady`→`canvasLoad` round-trip that also mints a junk "Untitled Canvas" session. Salvage `buildProjectContext` + media generators into services.
- **Protocol:** `src/canvas/protocol.ts` shared union, exhaustive on both ends. `canvas/ready` becomes the authoritative state transfer. Wire `canvas/present` or remove the button.
- **Honesty:** receipts on every write (`ok` = artifact changed); non-applied ops render as dismissible cards, not `console.warn`; fix the prompt's `scaffold_page` example + add the round-trip conformance test; nonce the fenced channel; parser state onto `PanelSessionState`; strip fenced blocks from `assistantContent` into a tool segment.
- **Permissions:** `canvas-read`/`canvas-edit` action types + `toolNames.ts` registration + `mcp__<server>__` prefix stripping; `resolveCanvasApproval(settings)` replaces the three `'auto'` literals.
- **Security:** the full §3.6 table (secrets scope, export sandbox, FigmaImport transcoder, media SSRF guard, MCP token per-artifact + idempotent `stop()`, `_fenceLocalToolResult` clamp, `resolveAssetPath` wired).
- **Store:** `schemaVersion`, validating parse (absent vs corrupt), `.bak`, `index.json`.

### Phase 1 — @mysti drives the canvas (on today's engine) (~1 week) — **GRAFT: pulled forward from Phase 3**

*Ships:* the user's verbatim ask. `@mysti` — with no canvas open, no CLI backend, no MCP — answers *"design me a login screen"* by materialising a canvas and writing real pages, with receipts it self-corrects from.

Still the blob engine and the old renderer (it will flicker — stated honestly). But the directive protocol, the tool names, the dispatch branch and the prompt block are **exactly** what Phase 4 re-points at the element ops, so nothing here is throwaway.

- `MYSTI_CANVAS_KINDS` + `canvas`/`canvaspage` directives in `mystiDelegateParser.ts`.
- Canvas schemas in `coordinatorToolSchemas` + `toolCallToDirective` cases.
- Dispatch branch in `_runMystiAgentic` modelled on `mcptool` (:7647-7681), in-process, with `recordLocalCard` for reload-safe replay.
- `open_canvas` + split synchronous boot from capability probing.
- `maxTokens: canvasBound ? 8192 : 4096`; `parseToolArgs` truncation signal; whole-page writes routed to the TEXT directive.
- `canvas_checkpoint` + `undo_canvas` chat tools, backed by a minimal `CanvasHistory` cursor over the existing op log — so agent ops are reversible **from day one**, before any undo UI exists.
- Binding through `CollaboratorPool` spawn options.

### Phase 2 — The document model and a renderer that doesn't reload (~2.5 weeks)

*Ships:* the same features, transformed in feel. Edits appear instantly with no flicker; scroll/hover/focus survive an agent edit; the rail shows real live thumbnails; 2.98 MB of Babel leaves every frame.

- `src/canvas/doc/{DocNode,PageCompiler,DocEmitter,Reconciler,DocPatch}.ts`; `@babel/parser` added to `dependencies`. Round-trip test over all five scaffolds.
- `ArtifactPage` → `{doc, jsxCache, legacy?, boardPos, format?, variantGroupId?}`; migration compiles existing pages, `legacy` for the rest with a rail badge.
- Executor internals over `DocPatch`; artifact-scope staleness; semantic rebase; **pins** written and enforced; subtree locks; receipts with `since[]`.
- Second webpack entry (`target:'web'`) → `dist/canvasWebview.js`; port `media/canvas/canvas.js` into `src/webview/canvas/*.ts` and **delete the JS mirror** of `CanvasSandbox`.
- Rewrite `harness.js`: doc interpreter over the 22 `UI.*` primitives, `MessageChannel` port, **no Babel** (lazily injected only into `legacy` frames).
- `preview.ts` parent-side static renderer.
- Delta protocol `canvas/ops`; one terminal event per op; `ResizeObserver` + rAF for scale-only refits.

### Phase 3 — The editor, usable with no agent at all (~2.5 weeks)

*Ships:* a real design editor. Pan/zoom a board of artboards, click any element, edit text in place, change properties, drag/duplicate/delete, Cmd+Z, save a named version, export. **A designer completes a session without sending a single chat message** — the proof that the surface, not the agent, is the product, and the forcing function that validates the op algebra before the agent depends on it.

Board world + virtualization; selection model + parent overlay; `UiSchema.ts` + generated inspector; inline text edit; drag/resize/duplicate/delete; rail drag-reorder + thumbnails; `CanvasHistory` full (txn grouping, checkpoints, timeline); capability-gated chrome; export wired.

### Phase 4 — The agent as one more editor (~1.5 weeks)

*Ships:* @mysti and every other backend drive the exact editor the human drives, at element granularity, and every edit is undoable by the same Cmd+Z.

`CanvasToolSurface` generated from the op algebra + conformance test; Phase 1's dispatch re-pointed at element ops (no prompt-shape change); `ProviderCapabilities.canvasTransport` + per-transport linker emitters + pull-model `cliArgsFor`; `CanvasCallParser` replacing `CanvasOpParser`; honest chips for `'none'` backends.

### Phase 5 — Watch and steer (~1.5 weeks)

Ghost artboards, agent cursor, heartbeats, per-job Cancel via `CanvasJobRouter.create/pipe/cancel`; `compilePartial` + partial-doc diffing → speculative patches; staged suggestions with parent-rendered before/after; the per-run inbox; on-artboard error cards with **Fix with AI**; `size {w,h}` finally feeding `validate_page`'s `reportedContentHeight`.

### Phase 6 — Many designs, variants, handoff (~2 weeks)

Artifact picker + new/duplicate/rename + `Map<artifactId, panel>`; per-run bindings so concurrent background runs can't collide; `variantGroupId` rows + one-click adopt; PNG/PDF/present through the one builder; `export_component` via gated `MystiLocalExec`; capability chips wired to the registry; Figma import as a real affordance with `<<<MYSTI_CONNECT:figma>>>` when absent.

**Total ≈ 12 weeks.** Defensible stop-points: after Phase 1 (the user's ask is met, on a flickering renderer); after Phase 3 (a real editor with a blob-transport agent); after Phase 5 (everything but multi-design and handoff).

---

## 6. What we keep / replace / delete

### Keep (extend in place) — most of the 6.6k-LOC engine
`ArtifactStore.ts` (+schemaVersion, validating parse, `.bak`, CAS, `index.json`, `versions/`, `oplog.jsonl`; `resolveAssetPath` finally *called*) · `CanvasOpExecutor.ts` (shape kept; internals over `DocPatch`; `inverse` replaces `previousValue`; pins, subtree locks, rebase) · `CanvasJobRouter.ts` (verbatim — `create`/`pipe`/`cancel` finally used) · `CanvasFormats.ts` · `CanvasThemePresets.ts` · `CanvasScaffolds.ts` (all five compile unchanged) · `CanvasValidator.ts` (fed a real height at last) · `CanvasCapabilityRegistry.ts` · `CanvasPromptBuilder.ts` (regenerated from the catalog) · `CanvasSandbox.ts` (**the** single builder, imported by the compiled webview) · `CanvasToolDispatch.ts` (sole executor entry; `cleanJsx` becomes the compiler's front door so the fenced path can no longer bypass it) · `CanvasToolServer/McpHttpServer/SessionLinker/ExportService/MediaService/PreviewService/Secrets/McpBridge` · `ui-primitives.js` (+ a TS-side `UiSchema.ts` sibling) · ~250 canvas tests, most retargeted rather than deleted · the whole Plan 19 coordinator substrate reused verbatim in shape.

### Replace
`media/canvas/canvas.js` (297 LOC untyped, drifted mirror) → `src/webview/canvas/*.ts` · `harness.js` → doc interpreter + port · `CanvasOpParser.ts` → `CanvasCallParser.ts` (nonce'd, fence-aware, per-session, carrying tool calls) · `canvasContent.ts` → shell loader only (no baked state, no `babel.min.js`) · `FigmaImport.ts` → `DocNode` whitelist transcoder · `ArtifactPage`/`CanvasOp`/`CanvasOpKind` in `types.ts`.

### Delete
`CanvasManager.ts` (3,182 — a latent *competing writer*: `recordHtmlPage` at :175, called :1087/:1159, inserts pages into a second artifact the canvas never renders) · `CanvasSession`/`canvasJson`/the `@deprecated` legacy chunk union · the 11 unreachable message cases · `elementOverrides`/`ElementOverride`/`DroppedAsset`/`previewAsset`/`stitchRef`/`nodes` · `resources/canvas-sandbox/babel.min.js` (2,983,904 B) · the 2nd and 3rd `ArtifactStore` instances · the `ev.source !== window` heuristic · `data-el` DOM-index tagging.

---

## 7. Risks

1. **The doc model constrains authoring — deliberately.** Runtime-logic JSX doesn't compile. All five scaffolds do, verified. The escape hatch is real but visibly degraded. If the uncompilable fraction proves large, the fix is widening the evaluator (fold `.map` over literal arrays, ternaries on literal conditions), not abandoning the tree — a page with no addressable nodes has no selection, no properties panel, no element undo, and no surviving human edits.
2. **Mid stability is best-effort.** Tier 1 depends on models preserving attributes. Tier 2 is a heuristic: a genuine restructure *should* lose mids, and will — with pins on those cells reported as dropped rather than silently retargeted. **A node matched only positionally (tier-3 similarity below threshold) may never inherit a pin.** That rule is non-negotiable; a mis-inherited pin is the worst failure mode because it is invisible.
3. **Two renderers must agree.** The parent static preview and the in-frame React renderer will drift on anything the preview approximates. Mitigation: the preview emits the *same* style objects the primitives do, plus a snapshot test comparing preview geometry against frame-reported `rects` for every scaffold.
4. **Speculative streaming can look jumpy** — a nav bar momentarily full-width before its sibling arrives. Render behind a "writing" treatment until top-level structure seals; snap on finalize.
5. **Persistent live iframes cost memory.** Virtualization with static-preview fallback is required, not an optimization.
6. **CAS save produces user-visible conflicts** where today there is silent last-writer-wins. Strictly more correct, strictly more annoying; needs a decent reload affordance.
7. **`canvas-edit` is ungated by default.** A prompt-injected agent *can* trash a design in `read-only` mode with no card. Compensating controls: undo shipped in Phase 1 (before any UI), staged mode from `AccessLevel` in Phase 5, the op log throughout.
8. **New dependency.** `@babel/parser` in a project with seven runtime deps. Net payload strongly positive (−2.98 MB × N frames × every repaint), but it is a real addition and it puts model-authored source through a host-process parser — cap source size, cache by hash, keep it off the streaming hot path.
9. **Phase 0 ships no new capability.** A week of work whose visible result is "things stop lying". Justified because every later phase multiplies inherited ownership confusion.

---

## 8. Open questions

1. **Should `page.setDoc`/`write_page` remain in the agent's tool surface after Phase 4**, or should the agent be pushed toward composed element ops for everything but a brand-new page? Composed ops stream better and pin better; whole-page is what models are fluent at. Current call: keep both, prompt toward composed.
2. **Default approval mode.** `staged` is safest and matches the executor's own default, but "the agent designs live while you watch" reads badly if every artboard needs an accept. Current call: derive from `OperationMode`/`AccessLevel`, auto-with-undo in permissive modes. Needs real-usage validation.
3. **Pin friction.** A user who has tweaked forty cells then asks for a rebrand gets forty rejections. Bulk-unpin plus a "restyle everything" flow that clears style pins with confirmation. Expect the default to be wrong the first time.
4. **How much of `CanvasManager`'s Stitch/website/SVG pipeline is commercially load-bearing?** The plan deletes it (10 of 13 handlers are unreachable). If it matters, it returns as a `canvas_import_screens` tool producing `legacy` pages — one tool, not a parallel writer.
5. **Does the reconciler need per-artboard tuning?** Marketing pages (long, flat) and app screens (deep, keyed) may want different similarity thresholds.
6. **Multi-window.** CAS + `doc.lock` fails the second window loudly and opens it read-only. Is that acceptable, or does someone actually run two windows on one design?
7. **Do we ever want a freeform layer** (sticky notes, arrows over a mock)? It does not fit the doc model. Current call: element-anchored comments instead, because the agent can read those.

---

## Execution log — 2026-08-19

Built in four waves (spine written by hand, then three parallel agent workflows), verified after each.

| Wave | Scope | Result |
|---|---|---|
| Phase 0+1 | ownership, protocol, history, approval, coordinator canvas lane, store + security hardening | tsc 0 · 163 files / 2566 tests |
| Spine | `doc/DocNode.ts`, `CanvasOps.ts` — the contract every later module compiles against | tsc 0 |
| Phase 2 | `PageCompiler` / `DocEmitter` / `Reconciler` / `DocPatch` / `TreeDiffer`, executor migration, delta renderer, harness rewrite, parent-side previews | tsc 0 · 177 files / 7714 tests |
| Phases 3–6 | board + selection, inspector + inline text, rail + history UI, tool surface + conformance, liveness + streaming, variants + handoff | tsc 0 · 186 files / 8036 tests |

### What changed in the plan as it met the code

- **`NewPageSpec.id?`** added. `page.remove`'s inverse is a `page.add`, and restoring an artboard under a fresh id would orphan every pin, comment, selection and staged op addressing it.
- **`write_page_jsx` is the `<canvaspage:>` target**, not a hand-rolled `insert_page`/`edit_page` split: it is create-or-edit in one tool *and* runs `cleanJsx`, so the text lane cannot bypass the validation the tool lane gets. It stays in `CANVAS_NATIVE_EXCLUDED` — an artboard does not fit a 4096-token tool call.
- **The JSX subset accepts computed keys only when the key is a string literal.** Required for the round-trip to close, since `{ ['__proto__']: … }` is the only spelling that writes that cell as data rather than as a prototype directive. Genuinely computed keys still fail.
- **A systemic `__proto__` defect**, found independently in three of the modules that handle model-authored key strings (`cloneNode`'s slot loop, the compiler/emitter, and `DocPatch`'s clone helpers). Plain `obj[k] = v` with `k === '__proto__'` invokes the prototype setter, so the cell vanishes from `Object.keys`/`JSON.stringify` while `for…in` still sees it — silent data loss, and a node in a `__proto__`-named slot became unreachable to `walk`, hence un-addressable and un-undoable. Fixed with an exported `putOwn` helper and `Object.defineProperty` at every dynamic-key write.
- **Export ships Babel only when a `legacy` page exists.** The harness interprets a `DocNode` tree, so its 2,983,904 bytes are dead weight for a compiled design.


### Adversarial review + remediation — 2026-08-19

A 5-lens hunt with an independent refute pass over the whole subsystem: **27 candidates → 25 confirmed, 2 refuted**. All 25 are now fixed, each with a regression test demonstrated to fail before its fix (a green suite proved nothing here — the same agents wrote the code and its tests).

**The two criticals were both invisible to 8,387 passing tests:**

- **`P5` — the canvas rendered blank in a real VS Code host.** VS Code loads webview HTML inside a nested `active-frame` iframe and the outer `vscode-webview://` document relays extension messages via `contentWindow.postMessage`, so `ev.source === window.parent` — truthy, and not self. The client's source allowlist accepted only null-or-self, so `canvas/hello` was dropped before the shape guard: no artifact, no render, no retry, no diagnostic. The guard was inherited from `media/canvas/canvas.js`, which shipped it with a comment reading *"F5-verify: if host messages ever arrive with a different source in a future VS Code build, canvas live-updates stop."* That verification never happened on either implementation. **Every unit test in the suite fabricated `source: null`.**
- **`OPLOG-1` — redo silently corrupted the design.** `_mirrorToOpLog` stores a V2 op as `proposedValue` under a lossy legacy `kind`; redo replayed it through the legacy apply switch, which read the op envelope as its own payload. `theme.set` overwrote `artifact.theme` with `{op:'theme.set', theme:{…}}` — persisted by the next autosave, so every colour read goes undefined and the design renders unstyled forever. `page.add` redid as a blank artboard; element ops threw. Undo was always correct (it prefers `record.inverse`), so only redo was wrong — and the history suite never drove the V2 submit surface at all.

**The `__proto__` class was systemic.** Found independently in `cloneNode`, the compiler/emitter, `DocPatch`, `Reconciler`, `TreeDiffer` and `parseToolName` — six modules. Two lessons the sweep added: the **read** side is the nastier half (`record['__proto__']` returns `Object.prototype`, not `undefined`, so every "is this cell absent?" check silently succeeds and one path handed a non-iterable to a `for…of`), and a `null` value in a style patch is *accepted* by the setter, turning the patch object itself prototype-less.

**Also fixed:** raw theme-token interpolation into the frame `<style>` (a `</style><script>` breakout reachable via `theme.setToken` and Figma import); a model-authored legacy page able to forge `author:'user'` through its own MessagePort; an asset resolver that rejected the only `asset://` shape `ArtifactStore` produces (no image could ever load); staged ops unreachable by any wire message under the *shipped default* approval mode; suggestion cards that could never be removed; and a text-lane livelock where `<canvas:N tool="canvas_open">` was compared against the bare literal `'open'`, so the refusal message told the model to call the exact spelling the lane could not express — burning entire runs for any model without native function calling.

**Carried forward, not closed:** the legacy fenced `canvas-op` lane was hardened (nonce + resolved approval) rather than deleted, so it remains a second path that bypasses `cleanJsx`; `theme.set`/`theme.setToken` still lack write-boundary validation (the fix is at the render boundary); `artifact.opLog` is persisted and unbounded, so undecided `pending` ops now survive a reload as suggestion cards; and the identity-preserving-replace pin hole needs a `pins` field on `DocNodeInput`.


### UI overhaul + three more review rounds — 2026-08-19/20

The panel was rebuilt for the brief *"responsive, functional, great UI/UX, professional and fully synced with the main Mysti agent"*, then reviewed three more times. **74 confirmed defects fixed** across the rounds; `tsc` 0, **217 files / 8904 tests**, both bundles emit, eslint clean.

**Every critical was found by MEASUREMENT, never by reasoning**, and each had a green test that mocked away the thing that was broken:

| Round | Critical | Why the suite was blind |
|---|---|---|
| 1 | The webview dropped **every** host message in a real VS Code host — `ev.source === window.parent` inside the nested `active-frame`. Permanently blank board. | Every unit test fabricated `source: null`. The rule was inherited from `canvas.js`, which shipped it with an explicit *"F5-verify"* caveat that was never carried out. |
| 2 | The shell grid declared three tracks and placed no children, so `main.board` auto-placed into the rail's `0px` track — **board 0px wide at every width ≤639px and at any width with a pane hidden**. | A guard test existed and PASSED by substring-matching the `minmax()` rule in the stylesheet text. |
| 3 | **Every live artboard was blank in production**: a `srcdoc` frame inherits the panel CSP (`script-src 'nonce-…'`), so its un-nonced React / primitives / `harness.js` were all refused. Found twice, independently. | All five browser tests stripped the CSP before loading the shell — they removed the exact thing that broke. |
| 3 | `.inspector { grid-column: 3 }` — **round 2's own fix** — gave the abs-pos overlay a zero-width containing block: a 1px sliver below 960px, while its scrim still swallowed every click. | The suite measured `#board` and the scrim's `display`, never the overlay pane's width. |

**The durable lesson:** `tests/webview/canvasFakeDom.ts` has no cascade, grid, box model or focus model, so it can assert a rule EXISTS but never that it does what it says. Two browser harnesses now exist and are where layout/computed-style/focus/geometry regressions belong: `canvasLayoutBrowser.test.ts`, and `canvasFrameCspBrowser.test.ts` — **the only test that keeps the real CSP**, and which asserts the blocked case too so the file demonstrates the bug rather than merely guarding it.

**Second lesson: remediation rounds introduce regressions** — roughly one in ten fixes. Round 2's remediation produced `R3-1`…`R3-4`. Budget a regression-focused pass after every batch of fixes.

Also landed: a deliberate responsive ladder (container queries at 480/640/960 with a `@media` fallback, breakpoint decided from `#app` — collapsing a pane widens the board and would otherwise oscillate — with 48px hysteresis); theme correctness across light/dark/high-contrast (23 hardcoded literals → 0, 11 → 42 VS Code tokens, contrast measured rather than asserted); a persistent agent-status surface with elapsed time and a working Cancel, replacing a 1.8s toast; `write_page` force scoped to `<mid>:<cell>` so one forced cell can no longer revert a whole artboard; and clamped canvas reads with a visible marker that `containsClampMarker` refuses to accept back as a rewrite.


### Round 4 (regression pass) — 2026-08-20

Run because rounds 2 and 3 proved that *remediation itself introduces defects* (round 2's own fix produced round 3's `R3-1`). **13 candidates → 12 confirmed → all 12 fixed. No criticals — the first round without one.**

The two that mattered were both things a first F5 would have hit:
- **Legacy JSX artboards were still blank.** The nonce fix restored `doc` frames only; the shell ships no `'unsafe-eval'`, a `srcdoc` frame inherits that and cannot widen it, so the in-frame compiler threw. Present mode rendered the identical page correctly, which is what isolated the cause to the shell policy. Fixed WITHOUT weakening the panel CSP: `buildPageDocument` now decides whether a frame can compile at all, and an uncompilable page ships an honest "Code page — open Present to view it" notice **with the model-authored source dropped entirely**, rather than a blank frame pretending to work.
- **Every `asset://` image was blocked in live artboards on desktop.** `assetCspSource` returned `https://file+.vscode-resource.vscode-cdn.net` — and `+` is not a legal CSP host character, so Chromium discarded it regardless of the repo's own regex guard. Fixed by emitting a legal expression (illegal leading label → `*`, never widening past two remaining labels). Because the parent-side preview allows `https:`, the image appeared in the thumbnail and vanished on going live — reading as a flicker, not a policy block.

Also fixed: a `canvas/ops` batch carrying an element op *and* a theme/format op painted the element **twice** (`_pushTheme` posted a mount with the post-op doc, then the patch applied on top) — durable corruption, since a later edit reached only the first copy. Root fix: only `_openPort` may send a document; theme/format re-mounts carry tokens only. That also fixed an agent theme change silently discarding the human's in-flight inline text edit.

**Trend across four rounds:** 2 criticals → 2 → 3 → 0. 86 defects fixed in total.


### The missing test layer — VS Code integration harness (2026-08-20)

Added because four review rounds and ~9,000 passing tests could not see a single one of the panel's production failures. Every one was a VS Code **host** behaviour, and the three existing layers each mock the host away: vitest mocks `vscode`, `canvasFakeDom` has no cascade/grid/box/focus model, and the Playwright harness runs the markup in bare Chromium.

`npm run test:vscode` downloads a real VS Code, activates the extension, opens the canvas panel and asserts against it. **7 passing.**

The load-bearing assertion is `rendered !== null`. The webview reports a render only after it has actually painted an artifact, so it is positive proof that the whole boot completed **in the real host** — shell HTML, CSP, bundle, boot payload, `canvas/ready`, `canvas/hello`, token check, first paint. Both "Loading your designs…" failures were exactly `rendered === null`, and were invisible precisely because nothing ever reported *success* — only some failures, and not always.

Supporting changes, each useful beyond the test:
- **`mysti.canvasDiagnostics`** (the Canvas Doctor): panel/token/store/bridge/artifact state plus the render report, shown to the user and returned to callers.
- **`mysti.canvasAddScaffold`**: a command-palette route to a first artboard, so creating one never depends solely on the empty state rendering.
- **`canvas/diag`** client message, re-sent whenever the painted page count, live-frame count or layout mode changes — a diagnostic whose answer is permanently stale is worse than none.

**Authentication moved from provenance to content.** The client used to authenticate host messages by inspecting `ev.source`; that failed closed and silently twice, and cannot be made sound (a frame nested inside a sandboxed artboard can post to `window.top`, so no window allowlist or denylist covers it). The host now stamps the per-view token on every message and the client checks that instead. The page cannot read this document, so it cannot learn the token. The handshake also self-heals — `canvas/ready` is retried twice — and after that the spinner is replaced with a stated failure rather than spinning forever.

**Known limit, not asserted:** `liveFrames` is 0 in the harness even with an artboard present. A frame mounts only when an artboard intersects the viewport above a zoom threshold, and a panel never brought to the foreground may never satisfy that — so 0 does not yet distinguish "not visible" from "frames never mount". The test says so in a comment rather than asserting something that could pass for the wrong reason. **Resolving this is the next task**, since the frame path is where the CSP failures lived.


### Performance: measured, and my diagnosis was wrong (2026-08-20)

User report: slow, poor zoomed-out rendering, "should be as smooth as Figma". I read the code and diagnosed a **layout thrash** — `_localPoint()` calls `getBoundingClientRect()` on every `pointermove` while `_applyTransform()` has just written `style.transform`, which is a textbook read-after-write forced reflow.

**Measurement refuted it.** `tests/webview/canvasPerfBrowser.test.ts` drives the real app bundle over the real shell in Chromium:

| measurement | result |
|---|---|
| per-`pointermove` scripting, 24 artboards | **0.085 ms**, zero long tasks |
| paced pan @100% zoom, 48 real scaffolds (1,898 DOM nodes) | p50 **16.7 ms**, p95 17.6 ms, 1 dropped |
| paced pan @15% zoom, same board | p50 **16.7 ms**, p95 17.6 ms, 1 dropped |
| cost scaling, 6 → 48 artboards | 2.5–3.5× for 8× artboards |

There is no per-event reflow: `will-change: transform` already promotes `.page-stage`, so transform writes are compositor-only and never dirty layout — which makes the rect read free. The DOM-preview path holds 60 fps at both zoom levels with realistic documents.

**`contain: layout paint` on `.artboard` was tried and reverted.** It produced no measurable gain (0.127 → 0.122 ms, inside noise) AND would have broken the UI: `.artboard-label` is positioned at `top: -20px`, outside the artboard box, and `contain: paint` clips descendants to the padding box — every artboard label would have vanished. Measuring first is what stopped a plausible-sounding change from shipping a visible regression.

**What the harness does NOT yet reproduce**, and therefore where the real cost almost certainly lives:
1. **Live iframes.** The harness fails every runtime fetch, so all artboards stay static previews and no frame is ever mounted. Each live frame is a React app in an iframe, and transforming a container full of iframes forces re-rasterization — the one thing Figma never does. The VS Code integration harness independently reports `liveFrames: 0`, so the frame path is unmeasured on both sides.
2. **The VS Code webview itself** — Electron compositing, not bare Chromium.

**Next step is to measure the frame path, not to optimize speculatively.** The standing hypotheses — freeze/swap live frames during a gesture, and a canvas LOD tier for low zoom — remain plausible and unproven, and should stay unbuilt until the harness can mount frames and show the cost.


### Live-frame performance: the second hypothesis was refuted too (2026-08-20)

`tests/webview/canvasLivePerfBrowser.test.ts` serves the REAL sandbox runtime so frames actually mount, and drives the REAL 9-artboard design from `Mysti-Test-Project`:

| | frames | p50 | p95 | dropped |
|---|---|---|---|---|
| **8 LIVE React iframes** | 8 | **16.7 ms** | 17.5 ms | **0 / 60** |
| static previews (same board) | 0 | 16.7 ms | 17.6 ms | 0 / 60 |

Transforming eight live iframes costs **nothing measurable** — identical to static previews. So the "never transform live content" hypothesis, which was the main argument for a freeze-during-gesture pass, does not hold here either.

Both structural hypotheses are now dead:
- **DOM volume** — the real design is 9 artboards / 177 nodes, *smaller* than a synthetic 48-artboard board (1,898 nodes) that also held 60 fps.
- **Live iframes** — measured above.

The canvas code is smooth in Chromium under the user's actual conditions, which points the remaining cost at the **VS Code webview environment** (Electron compositing, GPU config, a busy extension host, machine load) — the one place no harness can reach.

**So the panel now measures itself there.** `board.ts` samples frame deltas for the duration of a gesture only (smoothness matters while dragging, and an always-on sampler would itself cost something), and reports p50/p95/dropped through `canvas/diag`. `Mysti: Canvas Diagnostics` shows them: *"rendering 9 artboard(s). Last gesture: p50 16.7ms / p95 18.2ms, 0 dropped frame(s)."*

That is the missing number. If the real editor reports ~16.7 ms the bottleneck is not the canvas; if it reports 40 ms+, we finally know where to look — and either way it is measured rather than guessed.


### Interaction fixes — the actual complaint (2026-08-20)

Frame rate was never the problem. Three interaction defects were, and only the last was reported as a bug:

1. **Input died over an artboard.** With the cursor over any live frame, zoom and pan stopped entirely. An iframe receives wheel and pointer events in ITS OWN document — a sandboxed, opaque origin the parent cannot listen inside — and the harness forwarded only `click`. Fixed by forwarding `wheel` over the frame port (`FrameUpMessage` gains a validated, clamped `wheel` variant) and by dropping `pointer-events` on the world while space is held, so a space-drag begun over a frame reaches the board. The forwarded wheel is anchored through the artboard's world position, so zooming over a frame still zooms under the cursor rather than drifting to the viewport centre.
2. **No cursor affordance anywhere on the board.** Every `cursor:` rule in the stylesheet was on a button. Holding space gave no signal that pan was available; dragging gave no confirmation it had registered. That reads as unresponsive *at 60fps*, which is exactly why the report and the measurements disagreed. Now `grab` / `grabbing` / arrow-while-marqueeing.
3. **Discrete zoom snapped.** The +/- buttons, Cmd +/- and Fit jumped in one frame. Now eased over 140-180ms (`easeOutCubic`). Wheel and pinch are deliberately NOT eased — they are already continuous, and easing them would add lag to the path where lag is felt most. Any new gesture cancels a running animation, and auto-fit (first artboard, breakpoint change) stays instant so the layout never appears to wobble on its own.

**The perf scaling assertion is now informational.** It measured 2.5-3.6x standalone but swings under full-suite parallelism; a gate that moves with unrelated load is flaky, and flaky is worse than absent. The absolute per-move guard (0.085ms measured, 1.0ms bound) is the stable one and is what actually catches a reflow-per-event regression.

### Known gaps

- `CanvasWorkspace` is built, tested and is **not yet the live owner** — `ChatViewProvider`'s `_canvas*` fields still hold the store/executor directly, and `CanvasManager.ts` (3,182 LOC) is not yet deleted. This is the residual Phase 0 ownership work.
- The PNG/PDF renderer is unit-tested against a fake Playwright only; it needs an F5 smoke test with real Chromium.
- Present-mode CSP inheritance for legacy (Babel) artboards is reasoned from spec and covered by tests on the emitted policy, but not verified in a real Electron webview.
- No live-account F5 pass has been run on any of this.
