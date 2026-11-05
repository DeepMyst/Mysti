# Mysti feature checklist

This source-grounded inventory contains **130 feature-level cases**, including 16 individual backends. All execution statuses are **NOT_RUN** for this plan. Reachability, conditional prerequisites and known contract gaps are stated in the linked case; inclusion is not a shipped-feature claim.

[Read the test strategy, profiles and acceptance gates](47-comprehensive-feature-test-plan.md). Each catalog contains the real-use steps, long-session load, injected faults, pass/fail oracle and evidence.

| Case | Feature | Detailed plan |
| --- | --- | --- |
| PC-01 | First-run setup, zero-install path and onboarding | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-02 | Provider discovery, installation, updates and diagnostics | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-03 | Backend authentication, expiration and recovery | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-04 | Provider/model selection, effort, thinking, profiles and Ultracode | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-05 | Streaming answers, rich rendering and message actions | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-06 | Composer, draft preservation, queued follow-ups and second opinions | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-07 | Stop, clear session, shutdown and next-turn recovery | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-08 | Conversation history, persistence, delete and recovery | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-09 | Multi-panel, multi-window and workspace isolation | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-10 | Conversation forks and branch history | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-11 | Export, import, share links and clipboard | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PC-12 | Capability truthfulness and unsupported backend controls | [Conversations/setup](47-feature-tests/providers-and-conversations.md) |
| PB-01 | Claude Code | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-02 | OpenAI Codex | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-03 | Google Gemini | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-04 | Cline | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-05 | GitHub Copilot | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-06 | Cursor | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-07 | OpenClaw | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-08 | OpenCode | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-09 | Qwen Code | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-10 | Hermes | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-11 | Kimi Code | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-12 | Continue | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-13 | Ollama | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-14 | LocalAI | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-15 | OpenRouter backend | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| PB-16 | MiniMax | [Individual backend](47-feature-tests/providers-and-conversations.md) |
| AR-01 | Explicit agent assignments and independent collaboration | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-02 | Ordered handoffs and dependency failure propagation | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-03 | Role-based collaboration, /consult, and role authority | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-04 | Child scheduling, cancellation, questions, authentication, and retry | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-05 | Legacy Brainstorm: quick strategy and synthesis fallback | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-06 | Legacy Brainstorm: debate and convergence | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-07 | Legacy Brainstorm: red-team challenge and defense | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-08 | Legacy Brainstorm: risk/opportunity perspectives | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-09 | Legacy Brainstorm: Delphi facilitation and refinement | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-10 | /review: independent diff review and merged findings | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-11 | /panel: multiple independent perspectives and promised synthesis | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-12 | /critique: proposer, attackers, and verdict semantics | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-13 | /race: competing candidate solutions and user selection | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-14 | /brainstorm: bounded multi-agent refinement session | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-15 | Mysti inline coordinator, model selection, and fallback | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-16 | Coordinator tool loop, output continuation, and run budgets | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-17 | Native Mysti subagents and bounded parallel delegation | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-18 | CLI delegation, advisor escalation, cross-review, and verification | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-19 | Explicit Mysti orchestration DAG and lane scheduling | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-20 | Plan modes, plan options, native exit-plan, and approval handoff | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-21 | Effective trust modes and permission lifecycle | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-22 | Autonomous goals, task queues, safety decisions, and continuation | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-23 | Semi-autonomous permission, question, and plan decisions | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-24 | Learned preferences, project auto-memory, and project context | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-25 | Coordinator cross-backend memory and user pruning | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-26 | Checkpoints, code rewind, conversation forks, and undo | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-27 | Manual and automatic compaction with provider-owned history | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-28 | Smart compaction, incremental summaries, and history retrieval | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-29 | Token/cache accounting, cost attribution, and paid-call consent | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-30 | Boost profiles, explicit-setting precedence, and savings ledger | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-31 | Detached background jobs, ownership, persistence, and recovery | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-32 | Agent lifecycle, idle shutdown, active-child protection, and restart | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-33 | Agent map, workflow activity, needs, and actionable ownership | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-34 | Executable skill publication, registered calls, integrity, and health | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-35 | Changes dock, real disk differences, attribution, and revert boundaries | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| AR-36 | Direct local reads, edits, multi-file patches, shell, and OS sandbox | [Agents/runtime](47-feature-tests/agents-and-runtime.md) |
| EW-01 | Add files, editor selections, and folders to context | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-02 | Context isolation, refresh, persistence, and cleanup | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-03 | Automatic active-file and selection context | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-04 | @file context resolution and referenced-file transport | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-05 | File/image attachment picker and capability handling | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-06 | Paste, drag/drop, URI drops, and attachment lifetime | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-07 | Agent, role, and workspace-file autocomplete | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-08 | Suggested follow-ups and quick actions | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-09 | Prompt enhancement and stale-draft protection | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-10 | Editor-backed dictation | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-11 | Actions menu, command palette, and built-in slash entry routes | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-12 | Provider-native slash discovery and pass-through | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-13 | Agent/persona/role catalog, precedence, selection, and prompt budget | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-14 | Create, edit, reload, and remove custom personas, skills, and roles | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-15 | GitHub skill discovery, provenance, import, and overwrite | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-16 | Skill search, category index, automatic suggestion, and retrieval quality | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-17 | Staged skill review, promotion, quarantine, and local skill report | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-18 | Project instructions, scoped rules, and team initialization | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-19 | Function CodeLens: explain, refactor, and write tests | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-20 | Explorer file modification decorations | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-21 | AI commit detection and commit-signature setting contract | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-22 | Settings hub binding, synchronization, and safe message routing | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-23 | Localization and language-safe rendering | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-24 | Keyboard access, screen readers, contrast, motion, and responsive layout | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-25 | Getting started, tips, searchable help, support, and workspace recommendation | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-26 | Badges, streaks, milestone prompts, and sharing engagement state | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-27 | Remote announcements and model/update notices | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-28 | Telemetry, privacy, opt-out, and exported diagnostic content | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-29 | Performance instrumentation, debug controls, and bounded resources | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| EW-30 | Packaged release, upgrade/recovery, and editor/platform compatibility | [Editor/workspace](47-feature-tests/editor-and-workspace.md) |
| CI-01 | Canvas opening, artifact switching, persistence, and recovery | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-02 | Canvas pages, scaffolds, board navigation, and rail | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-03 | Document editing, selection, text, properties, and structural changes | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-04 | Themes, tokens, device formats, and responsive preview | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-05 | Human ownership pins, concurrent edits, and pin release gap | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-06 | Staged Canvas changes and approval decisions | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-07 | Shared undo/redo, checkpoints, restore, and history integrity | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-08 | Design variants and compare/adopt reachability | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-09 | Canvas agent tools, chat linkage, MCP transport, and scope isolation | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-10 | Canvas comments, agent activity, job cancellation, and diagnostics | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-11 | Canvas compilation, legacy pages, sandbox rendering, and validation | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-12 | Assets, provenance, Figma payload import, and handoff consistency | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-13 | Present and self-contained HTML export | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-14 | Image generation, broker/local routing, and insertion | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-15 | Video generation and mixed media sessions | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-16 | Canvas capability claims: Stitch, Canva, code generation, vision QA, PNG/PDF | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-17 | Canvas credentials and legacy-setting migration | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-18 | Visual Test Dashboard observation and reporting | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-19 | Dev-server discovery, approval, ownership, stop, and restart | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-20 | Agent visual looks, browser interactions, and network policy | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-21 | DeepMyst sign-in, sign-out, URI callback, and account isolation | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-22 | Connections catalog, authorization completion, disconnect, and refresh | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-23 | “Use in local CLIs” MCP configuration reconciliation | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-24 | Brokered MCP discovery, schemas, pins, approval, and execution | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-25 | OpenClaw channels: connection, outbound approval, asks, replies, and queues | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-26 | Desk identity, manual pairing, local roster, and revocation | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-27 | Desk transport, remote status/locate, and presence boundary | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-28 | Desk served work, budgets, security, boards, standups, proposals, and audit | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-29 | Proactive local repository watch lifecycle | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-30 | Proactive cloud responsibilities and insight lifecycle | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-31 | Proactive task briefings and evidence freshness | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-32 | Proactive notifications, deduplication, restart, and quiet periods | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-33 | Proactive checkout and continued-work boundary | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-34 | Plugin catalog, backend capabilities, search, details, and scopes | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-35 | Plugin install/update/toggle/remove, marketplaces, and next-turn activation | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |
| CI-36 | Active Mode daemon lifecycle, status, integration gating, and polling | [Canvas/integrations](47-feature-tests/canvas-and-integrations.md) |

Coverage inventory: 35 commands, 199 settings, 141 chatActions, 16 providers, 18 canvasOperations, 5 sessionShapes, 24 slashAliases, 42 coreAssets.

Run `node scripts/validation/feature-plan.cjs` to check identifier traceability and local links against the current worktree. This check does not execute the product.
