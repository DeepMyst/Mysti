/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as nodePath from 'path';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { ContextManager } from './managers/ContextManager';
import { ConversationManager } from './managers/ConversationManager';
import { ProviderManager } from './managers/ProviderManager';
import { SuggestionManager } from './managers/SuggestionManager';
import { BrainstormManager } from './managers/BrainstormManager';
import { PermissionManager } from './managers/PermissionManager';
import { SetupManager } from './managers/SetupManager';
import { TelemetryManager } from './managers/TelemetryManager';
import { MemoryManager } from './managers/MemoryManager';
import { AutonomousManager } from './managers/AutonomousManager';
import { CompactionManager } from './managers/CompactionManager';
import { SmartCompactor } from './managers/SmartCompactor';
import { SavingsLedger } from './managers/SavingsLedger';
import { BoostManager } from './managers/BoostManager';
import { DeepMystGatewayClient } from './services/DeepMystGatewayClient';
import { OpenRouterClient } from './services/OpenRouterClient';
import { CoordinatorModelClient, MYSTI_DEFAULT_FREE_MODELS } from './services/CoordinatorModelClient';
import { AgentLifecycleManager } from './managers/AgentLifecycleManager';
import { SlashCommandManager } from './managers/SlashCommandManager';
import { NativeCommandDiscovery } from './services/NativeCommandDiscovery';
import { ActiveModeManager } from './managers/ActiveModeManager';
import { EngagementManager } from './managers/EngagementManager';
import { CommitSignatureManager } from './managers/CommitSignatureManager';
import { TeamPresenceManager } from './managers/TeamPresenceManager';
import { MystiFileDecorationProvider } from './providers/MystiFileDecorationProvider';
import { MystiCodeLensProvider } from './providers/MystiCodeLensProvider';
import { getProviderDisplayName } from './providers/base/ProviderManifest';
import { ProjectContextManager } from './managers/ProjectContextManager';
import { VisualTestManager } from './managers/VisualTestManager';
import { CheckpointManager } from './managers/CheckpointManager';
import { CanvasSecrets } from './services/CanvasSecrets';
import { CliDiscoveryService } from './services/CliDiscoveryService';
import { ModelRegistryService } from './services/ModelRegistryService';
import { ModelAnnouncementService } from './services/ModelAnnouncementService';
import { CliUpdateService } from './services/CliUpdateService';
import { DeepMystAuthManager } from './managers/DeepMystAuthManager';
import { AnnouncementManager } from './managers/AnnouncementManager';
import { ConnectionsPanelManager } from './managers/ConnectionsPanelManager';
import { McpConfigManager } from './services/McpConfigManager';
import { PerfTracker } from './utils/PerfTracker';
import { randomUUID } from 'crypto';
import { DeskIdentity } from './services/desk/DeskIdentity';
import { registerDeskLocalStatus } from './services/registerDeskLocalStatus';
import { DeskPairing } from './managers/DeskPairing';
import { DeskPeerBook } from './managers/DeskPeerBook';
import { DeskPairingFlow } from './managers/DeskPairingFlow';
import { MODEL_REFRESH_WARMUP_DELAY_MS } from './constants';
import type { Conversation } from './types';

let chatViewProvider: ChatViewProvider;
let contextManager: ContextManager;
let conversationManager: ConversationManager;
let providerManager: ProviderManager;
let suggestionManager: SuggestionManager;
let brainstormManager: BrainstormManager;
let permissionManager: PermissionManager;
let setupManager: SetupManager;
let cliDiscoveryService: CliDiscoveryService;
let modelRegistryService: ModelRegistryService;
let modelAnnouncementService: ModelAnnouncementService;
let cliUpdateService: CliUpdateService;
let telemetryManager: TelemetryManager;
let memoryManager: MemoryManager;
let autonomousManager: AutonomousManager;
let compactionManager: CompactionManager;
let lifecycleManager: AgentLifecycleManager;
let activeModeManager: ActiveModeManager;
let engagementManager: EngagementManager;
let commitSignatureManager: CommitSignatureManager;
let teamPresenceManager: TeamPresenceManager;
let fileDecorationProvider: MystiFileDecorationProvider;
let projectContextManager: ProjectContextManager;
let visualTestManager: VisualTestManager;
let checkpointManager: CheckpointManager;
let deepMystAuthManager: DeepMystAuthManager;
let connectionsPanelManager: ConnectionsPanelManager;

/**
 * Plan 27 §21.6c #11 (P-3). The `vscode://DeepMyst.mysti/import?data=…` deep
 * link is reachable by anyone who can get the editor to open a URI — a web page,
 * a chat message, an e-mail. Lane G bounded what the payload can contain; this
 * is the human gate in front of it: a MODAL prompt whose first (default) button
 * is Cancel and owns the close affordance (Escape / dismiss → Cancel), and whose
 * only importing outcome is the exact confirm item by identity. Anything else —
 * `undefined`, Cancel, a look-alike object — denies. Never rejects.
 */
export const SHAREABLE_IMPORT_CONFIRM: vscode.MessageItem = { title: 'Import conversation' };
const SHAREABLE_IMPORT_CANCEL: vscode.MessageItem = { title: 'Cancel', isCloseAffordance: true };

export async function handleShareableImportLink(
  data: string,
  deps: {
    importFromShareable: (data: string) => Conversation | null;
    onImported: (conversation: Conversation) => void;
  },
): Promise<void> {
  try {
    const choice = await vscode.window.showWarningMessage(
      'Someone sent you a Mysti conversation — import it?',
      {
        modal: true,
        detail: 'This link came from outside the editor. Importing adds the conversation to your history; its contents are shown as text and nothing in it is run.',
      },
      SHAREABLE_IMPORT_CANCEL,
      SHAREABLE_IMPORT_CONFIRM,
    );
    if (choice !== SHAREABLE_IMPORT_CONFIRM) {
      return;
    }
    const imported = deps.importFromShareable(data);
    if (imported) {
      deps.onImported(imported);
      vscode.window.showInformationMessage(`Conversation loaded: "${imported.title}"`);
    } else {
      vscode.window.showErrorMessage('Could not load this conversation. The link may be invalid or expired.');
    }
  } catch (err) {
    console.log('[Mysti] deep-link import prompt failed:', err);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  PerfTracker.mark('activation.start');
  const perfConfigListener = PerfTracker.init();
  if (perfConfigListener) {
    context.subscriptions.push(perfConfigListener);
  }

  console.log('Mysti extension is now active');
  // Build stamp — lets us confirm the running bundle is the freshly compiled dev
  // build (not a stale installed copy). Bump BUILD_STAMP on notable rebuilds.
  const BUILD_STAMP = 'plan17-full-review-fix-pass-43findings (2026-07-12)';
  console.log(`[Mysti] BUILD ${BUILD_STAMP} — extensionPath=${context.extensionPath}`);

  // Manager construction block (telemetry through ChatViewProvider).
  // Note: provider init below is fire-and-forget (Plan 03 Phase 2), so this
  // measure covers only synchronous construction work.
  PerfTracker.mark('activation.managerConstruction.start');

  // Initialize telemetry first
  telemetryManager = new TelemetryManager(context);
  const version = context.extension.packageJSON.version || '0.0.0';
  telemetryManager.trackActivation(version);

  // Initialize managers
  contextManager = new ContextManager(context);
  conversationManager = new ConversationManager(context);
  providerManager = new ProviderManager(context);

  // Plan 03 Phase 3a: cached CLI discovery. Constructed BEFORE the
  // background provider init below so it seeds from every onProviderReady
  // event — panel opens then read warm statuses instead of re-probing.
  cliDiscoveryService = new CliDiscoveryService(providerManager);
  context.subscriptions.push(cliDiscoveryService);

  // Plan 01: model registry — single authority for per-provider model lists +
  // context windows. Constructed after ProviderManager and wired both ways via
  // setters (avoids a construction-order/import cycle): the registry reads the
  // bundled curated config.models through the manager, and the manager's
  // getModels/getProviderDefaultModel/getModelContextWindow delegate back to
  // the registry's merged view. Phase 1 is behavior-neutral (refresh() is a
  // no-op; output is byte-identical to the bundled lists).
  modelRegistryService = new ModelRegistryService(context);
  modelRegistryService.setProviderSource(providerManager);
  providerManager.setModelRegistry(modelRegistryService);
  context.subscriptions.push(modelRegistryService);

  // Plan 04: DeepMyst-brokered MCP connections. The user signs in to DeepMyst
  // (Clerk) on the web and pastes a `dm_` API key; DeepMyst holds every
  // third-party connection credential, so nothing sensitive lives locally.
  // initialize() loads the stored key from SecretStorage (fire-and-forget so
  // it never blocks activation).
  deepMystAuthManager = new DeepMystAuthManager(context);

  // Plan 04: the Connections panel mirrors DeepMyst's "My Connections" hub
  // (the user's Smithery/Composio MCP connections). When the user enables "Use
  // in local CLIs", McpConfigManager writes the per-user MCP broker URL
  // (/api/v1/me/mcp) into each MCP-capable CLI's config so a local agent can
  // call those tools directly.
  const mcpConfigManager = new McpConfigManager(
    undefined, // default: os.homedir()
    nodePath.dirname(context.globalStorageUri.fsPath),
  );
  connectionsPanelManager = new ConnectionsPanelManager(
    context.extensionUri, deepMystAuthManager, mcpConfigManager,
  );
  context.subscriptions.push(connectionsPanelManager);

  // Load the stored key, then reconcile CLI MCP configs to the signed-in +
  // toggle state (writes the broker entry when on, strips any prior/legacy
  // `deepmyst-*` entry when off). Fire-and-forget so neither blocks activation.
  deepMystAuthManager.initialize()
    .then(() => connectionsPanelManager.reconcile())
    .catch(err => console.log('[Mysti] DeepMyst init/reconcile error:', err));
  context.subscriptions.push(deepMystAuthManager);

  // Dynamic in-app messages (feedback surveys, offers, banners) DeepMyst targets
  // at the signed-in user, shown as a card at the top of a session. A no-op when
  // signed out; fetches/records via the shared DeepMystClient.
  const announcementManager = new AnnouncementManager(deepMystAuthManager, context.globalState);

  suggestionManager = new SuggestionManager(context);

  // Get initial access level from configuration
  const config = vscode.workspace.getConfiguration('mysti');
  const initialAccessLevel = config.get<'read-only' | 'ask-permission' | 'full-access'>('accessLevel', 'ask-permission');
  permissionManager = new PermissionManager(initialAccessLevel);

  // Initialize providers in the background (Plan 03 Phase 2): activate() no
  // longer blocks on CLI discovery — webview/command registration below runs
  // immediately, and call paths that need discovery results await
  // providerManager.whenReady instead. The 'activation.providerInit' measure
  // now wraps the background promise (recorded via .finally when it settles)
  // so it reports the real discovery duration rather than an awaited ~0ms
  // span; 'activation.total' keeps measuring only the synchronous activate()
  // path.
  PerfTracker.mark('activation.providerInit.start');
  providerManager
    .initialize()
    .catch(err => console.error('[Mysti] Provider init failed:', err))
    .finally(() => {
      PerfTracker.measure('activation.providerInit', 'activation.providerInit.start');
    });

  // Initialize brainstorm manager
  brainstormManager = new BrainstormManager(context, providerManager);

  // Initialize setup manager for CLI auto-setup (reads CLI/auth status
  // through the discovery cache — Plan 03 Phase 3a)
  setupManager = new SetupManager(context, providerManager, cliDiscoveryService);

  // Update surfacing: "what's new" (models) and "what's stale" (CLIs). Both are
  // detect-and-report only — neither writes a setting nor installs anything.
  // CliUpdateService needs npm resolution, so it is built after SetupManager.
  modelAnnouncementService = new ModelAnnouncementService(context);
  cliUpdateService = new CliUpdateService(context, cliDiscoveryService, setupManager);
  context.subscriptions.push(modelAnnouncementService, cliUpdateService);

  // Initialize memory, autonomous, and compaction managers
  memoryManager = new MemoryManager(context);
  // Initialize per-project auto-memory (like ~/.claude/projects/<project>/memory/)
  if (vscode.workspace.workspaceFolders?.length) {
    memoryManager.initProjectMemory(vscode.workspace.workspaceFolders[0].uri.fsPath);
  }
  autonomousManager = new AutonomousManager(context, memoryManager);
  compactionManager = new CompactionManager(context);

  // Plan 08: smart compaction (DeepMyst-gated). The cheap compactor + retrieval
  // calls route through DeepMyst's OpenAI-compatible LLM gateway with the same
  // `dm_` key; the SavingsLedger tracks realized savings for the always-on UI.
  // Injected post-construction so CompactionManager keeps its standard behavior
  // until a signed-in + entitled user enables `mysti.compaction.smart.enabled`.
  const deepMystGatewayClient = new DeepMystGatewayClient(
    () => deepMystAuthManager.getApiKey(),
    () => deepMystAuthManager.getGatewayUrl(),
  );
  const savingsLedger = new SavingsLedger(context);
  context.subscriptions.push(savingsLedger);
  compactionManager.setSmartCompactor(
    new SmartCompactor(deepMystAuthManager, deepMystGatewayClient, savingsLedger),
  );

  // Plan 24: Boost mode — settings overlay (aggressive compaction defaults),
  // per-turn sensor ledger, and un-tiered delegation routing. Overlay only:
  // nothing is written to user settings, and explicit user values win.
  const boostManager = new BoostManager(context);
  context.subscriptions.push(boostManager);
  compactionManager.setBoostOverlay(boostManager);

  // OpenRouter client — used by the Mysti coordinator ONLY as a power-user opt-in
  // when the EXPLICIT `mysti.openrouter.apiKey` setting is present. An ambient
  // OPENROUTER_API_KEY env var must NOT silently override the DeepMyst-gateway
  // default, so it is intentionally not consulted here.
  const openRouterClient = new OpenRouterClient(() => {
    const fromSetting = vscode.workspace.getConfiguration('mysti').get<string>('openrouter.apiKey', '').trim();
    return fromSetting || undefined;
  });
  // Plan 16: the Mysti coordinator runs through the DeepMyst gateway by default,
  // using the signed-in account's dm_ key (a DeepMyst account is required — free
  // works; not gated on paid entitlement). OpenRouter is used instead only when a
  // key is explicitly configured.
  const coordinatorModelClient = new CoordinatorModelClient(
    deepMystGatewayClient,
    openRouterClient,
    () => deepMystAuthManager.isSignedIn(),
    () => {
      const cfg = vscode.workspace.getConfiguration('mysti');
      // A non-empty coordinatorModel PINS the coordinator to one model (no
      // rotation). Empty (default) ⇒ rotate the curated free-models list, which
      // rolls over to the next free model on a rate-limit before the paid fallback.
      const pinned = (cfg.get<string>('mysti.coordinatorModel', '') || '').trim();
      const freeModels = pinned
        ? [pinned]
        : cfg.get<string[]>('mysti.freeModels', MYSTI_DEFAULT_FREE_MODELS);
      return {
        freeModels: Array.isArray(freeModels) && freeModels.length > 0 ? freeModels : MYSTI_DEFAULT_FREE_MODELS,
        gatewayFallbackModel: cfg.get<string>('mysti.fallbackModel', 'claude-haiku-4-5'),
        openRouterModel: cfg.get<string>('openrouter.coordinatorModel', 'auto'),
      };
    },
  );
  lifecycleManager = new AgentLifecycleManager(context);
  // B16: let ProviderManager report child PIDs to the lifecycle manager as
  // processes are registered (enables idle/child-protection tracking).
  providerManager.setLifecycleSink(lifecycleManager);

  // Initialize engagement manager (badges, stats, review prompts)
  engagementManager = new EngagementManager(context);

  // Initialize viral growth managers (Phase 2)
  commitSignatureManager = new CommitSignatureManager(context);
  teamPresenceManager = new TeamPresenceManager(context); // Session action tracker
  fileDecorationProvider = new MystiFileDecorationProvider();

  // Initialize project context manager (reads mysti.md + .mysti/rules/)
  projectContextManager = new ProjectContextManager(context);
  projectContextManager.initialize().catch(err =>
    console.log('[Mysti] ProjectContextManager: initialization error:', err)
  );

  // Initialize active mode manager (provider-independent OpenClaw daemon connection)
  activeModeManager = new ActiveModeManager(context);
  // Non-blocking: detects CLI, connects to daemon if available
  activeModeManager.initialize().catch(err =>
    console.log('[Mysti] ActiveMode: initialization error:', err)
  );

  // Initialize visual test manager
  visualTestManager = new VisualTestManager(context);

  // Code-checkpoint engine (shadow git repo) backing "rewind code to here".
  checkpointManager = new CheckpointManager(context);

  // F-11: SecretStorage-backed canvas API keys. Construct once and share this
  // instance with the active generation services via ChatViewProvider. The
  // one-time settings→secrets migration runs before services read their keys.
  const canvasSecrets = new CanvasSecrets(context.secrets, context.globalState);

  // Initialize slash command manager
  // The user's own commands for each backend (.claude/commands, .gemini
  // commands, .cursor/commands, Claude skills, …). Reads are cached and
  // synchronous so opening the slash menu never waits on disk; the first
  // workspace folder is resolved lazily so a folder opened later still counts.
  const nativeCommandDiscovery = new NativeCommandDiscovery({
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  const slashCommandManager = new SlashCommandManager({
    providerManager,
    contextManager,
    conversationManager,
    compactionManager,
    memoryManager,
    brainstormManager,
    nativeCommandDiscovery,
  });


  // --------------------------------------------------------------------------
  // Desk (Plan 21 / Plan 26) — cross-machine teamwork, off by default.
  //
  // Pairing is lazy. Local status serving additionally requires desk.serve
  // and workspace trust, and its listener follows configuration and disposal.
  // --------------------------------------------------------------------------
  const deskIdentity = new DeskIdentity({
    // `vscode.SecretStorage` returns Thenable, which is not assignable to
    // Promise; adapting here keeps the vscode types out of the sealed Desk set.
    get: (key) => Promise.resolve(context.secrets.get(key)),
    store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
    delete: (key) => Promise.resolve(context.secrets.delete(key)),
  });
  const deskPeerBook = new DeskPeerBook(
    {
      get: <T,>(key: string) => context.globalState.get<T>(key),
      update: (key: string, value: unknown) => Promise.resolve(context.globalState.update(key, value)),
    },
    () => Date.now(),
    {
      servingBudgetUsdPerDay: vscode.workspace
        .getConfiguration('mysti').get<number>('desk.servingBudgetUsdPerDay', 0.5),
    },
  );
  const deskPairing = new DeskPairing({
    now: () => Date.now(),
    newId: () => randomUUID().replace(/-/g, ''),
  });
  registerDeskLocalStatus(context, deskIdentity, deskPeerBook);
  const deskFlow = new DeskPairingFlow({
    pairing: deskPairing,
    peerBook: deskPeerBook,
    // Filled on first use; `ensure()` is what actually mints or loads the key.
    ownPublicKey: '',
    now: () => Date.now(),
    newSessionId: () => randomUUID(),
  });

  // Initialize the chat view provider
  chatViewProvider = new ChatViewProvider({
    extensionUri: context.extensionUri,
    extensionContext: context,
    contextManager,
    conversationManager,
    providerManager,
    suggestionManager,
    brainstormManager,
    permissionManager,
    setupManager,
    telemetryManager,
    autonomousManager,
    memoryManager,
    compactionManager,
    lifecycleManager,
    slashCommandManager,
    activeModeManager,
    engagementManager,
    projectContextManager,
    visualTestManager,
    modelRegistry: modelRegistryService,
    checkpointManager,
    desk: {
      identity: deskIdentity,
      pairing: deskPairing,
      peerBook: deskPeerBook,
      flow: deskFlow,
      enabled: () => vscode.workspace.getConfiguration('mysti').get<boolean>('desk.enabled', false),
    }
  });

  // Update surfacing is optional and attached after the core chat dependencies.
  chatViewProvider.setUpdateServices(modelAnnouncementService, cliUpdateService);

  // F-11: run the one-time settings→secrets migration BEFORE any service reads
  // a key, then prime the image/video generation services via ChatViewProvider.
  canvasSecrets.migrate()
    .then(async migrated => {
      if (migrated.length > 0) {
        console.log(`[Mysti] CanvasSecrets: migrated ${migrated.join(', ')} from settings.`);
      }
      // setCanvasSecrets primes the image/video services via setKeys().
      chatViewProvider.setCanvasSecrets(canvasSecrets);
    })
    .catch(err => console.log('[Mysti] CanvasSecrets: migration/key load error:', err));

  // Plan 04 Phase 4: let the chat teach agents the in-chat connect convention
  // and resolve the connect URL when a `<<<MYSTI_CONNECT:slug>>>` marker fires.
  chatViewProvider.setDeepMystAuth(deepMystAuthManager);
  chatViewProvider.setSavingsLedger(savingsLedger);
  chatViewProvider.setBoostManager(boostManager);
  chatViewProvider.setAnnouncementManager(announcementManager);
  chatViewProvider.setMystiCoordinator(coordinatorModelClient);

  PerfTracker.measure('activation.managerConstruction', 'activation.managerConstruction.start');

  // Register the webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'mysti.chatView',
      chatViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Register chatViewProvider for proper disposal (prevents memory leaks)
  context.subscriptions.push({
    dispose: () => chatViewProvider.dispose()
  });

  // Wire file modification listeners (file decorations + commit tracking)
  chatViewProvider.onFileModified((filePath, provider) => {
    commitSignatureManager.markFileModified(filePath);
    fileDecorationProvider.markFileTouched(filePath, provider);
    teamPresenceManager.trackFileWritten(filePath);
  });

  // Wire tool_use listener (AI commit detection + session action tracking)
  chatViewProvider.onToolUseDetected((toolName, toolInput) => {
    // Track session actions (files read, commands run, etc.)
    teamPresenceManager.trackToolUse(toolName, toolInput);

    // Detect AI-initiated git commits for badge tracking
    if (commitSignatureManager.isAICommit(toolName, toolInput)) {
      engagementManager.trackCommitWithSignature();
      console.log('[Mysti] AI-initiated git commit detected');
    }
  });

  // Register file decoration provider (sparkle M badge in Explorer)
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider)
  );
  context.subscriptions.push(fileDecorationProvider);

  // Mysti branded status bar item (always visible)
  const mystiStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  mystiStatusBar.command = 'mysti.openChat';
  const defaultProvider = vscode.workspace.getConfiguration('mysti').get<string>('defaultProvider', 'claude-code');
  const providerLabel = _formatProviderLabel(defaultProvider);
  mystiStatusBar.text = `$(sparkle) Mysti: ${providerLabel}`;
  mystiStatusBar.tooltip = `You're Mysting with ${providerLabel} — click to open chat`;
  mystiStatusBar.show();
  context.subscriptions.push(mystiStatusBar);

  // Update status bar when provider changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mysti.defaultProvider')) {
        const provider = vscode.workspace.getConfiguration('mysti').get<string>('defaultProvider', 'claude-code');
        const label = _formatProviderLabel(provider);
        mystiStatusBar.text = `$(sparkle) Mysti: ${label}`;
        mystiStatusBar.tooltip = `You're Mysting with ${label} — click to open chat`;
      }
    })
  );

  // Plan 24: Boost status chip — visible only while Boost is enabled. Shows the
  // session ledger at a glance; clicking opens the summary command below.
  const boostStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 48);
  boostStatusBar.command = 'mysti.boostSummary';
  const renderBoostBar = () => {
    const snap = boostManager.snapshot();
    if (!snap.enabled) { boostStatusBar.hide(); return; }
    const meanK = snap.sessionMeanContextTokens > 0
      ? `${Math.round(snap.sessionMeanContextTokens / 1000)}k` : '—';
    boostStatusBar.text = `$(zap) Boost ${snap.profile} · ctx ${meanK}`;
    boostStatusBar.tooltip = `Boost ${snap.profile} — session: ${snap.session.turns} turns, `
      + `${snap.session.roundTrips} round-trips, ${snap.session.delegations} delegations. `
      + `Mean context/turn: ${meanK} tokens${snap.estimated ? ' (some figures estimated)' : ''}. Click for details.`;
    boostStatusBar.show();
  };
  renderBoostBar();
  context.subscriptions.push(boostStatusBar);
  context.subscriptions.push(boostManager.onDidChange(() => renderBoostBar()));
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.boostSummary', () => {
      const s = boostManager.snapshot();
      const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
      // The two estimate flags are scoped separately on purpose — a session of
      // clean provider-reported numbers must not inherit a "~" from a run
      // recorded weeks ago.
      const sessionEst = s.estimated ? ' (~ some estimated)' : '';
      const lifetimeEst = s.lifetimeEstimated ? ' (~ some estimated)' : '';
      vscode.window.showInformationMessage(
        `Boost ${s.enabled ? `ON · ${s.profile}` : 'off'} — session: ${s.session.turns} turns, `
        + `${s.session.roundTrips} round-trips, ${fmt(s.session.contextTokens)} context tokens, `
        + `${fmt(s.session.outputTokens)} output, ${s.session.delegations} delegations${sessionEst}. `
        + `Lifetime: ${s.lifetime.turns} turns, ${fmt(s.lifetime.contextTokens)} context tokens${lifetimeEst}.`,
      );
    })
  );

  // "What's New" notification and first-install walkthrough
  const currentVersion = context.extension.packageJSON.version as string;
  const previousVersion = context.globalState.get<string>('mysti.lastVersion');

  if (!previousVersion) {
    // First install — open walkthrough
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'DeepMyst.mysti#mysti.gettingStarted',
      false
    );
  } else if (previousVersion !== currentVersion) {
    // Extension updated — show What's New
    vscode.window.showInformationMessage(
      `Mysti updated to v${currentVersion}! See what's new.`,
      "What's New",
      'Rate Mysti'
    ).then((selection) => {
      if (selection === "What's New") {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/DeepMyst/Mysti/blob/main/CHANGELOG.md'));
      } else if (selection === 'Rate Mysti') {
        vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti&ssr=false#review-details'));
      }
    });
  }
  context.globalState.update('mysti.lastVersion', currentVersion);

  // Active Mode status bar item (provider-independent)
  const activeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  activeStatusBar.command = 'mysti.openChat';
  context.subscriptions.push(activeStatusBar);

  activeModeManager.onStatusChanged((status) => {
    if (!activeModeManager.isInstalled()) {
      activeStatusBar.hide();
    } else if (status?.running) {
      activeStatusBar.text = '$(radio-tower) Mysti: OpenClaw Active';
      activeStatusBar.tooltip = `Mysti \u00B7 OpenClaw daemon running \u00B7 ${status.channelCount} channel${status.channelCount !== 1 ? 's' : ''}`;
      activeStatusBar.show();
    } else {
      activeStatusBar.text = '$(radio-tower) Mysti: OpenClaw Offline';
      activeStatusBar.tooltip = 'Mysti \u00B7 OpenClaw daemon not running';
      activeStatusBar.show();
    }
  });

  // Session actions status bar item — shows what Mysti did this session
  const actionsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
  actionsStatusBar.command = 'mysti.openChat';
  context.subscriptions.push(actionsStatusBar);

  teamPresenceManager.onDidChange((summary) => {
    if (summary.totalActions > 0) {
      const parts: string[] = [];
      if (summary.filesWritten > 0) { parts.push(`${summary.filesWritten} file${summary.filesWritten !== 1 ? 's' : ''} edited`); }
      if (summary.filesRead > 0) { parts.push(`${summary.filesRead} read`); }
      if (summary.commandsRun > 0) { parts.push(`${summary.commandsRun} cmd${summary.commandsRun !== 1 ? 's' : ''}`); }
      actionsStatusBar.text = `$(tools) Mysti: ${parts.join(', ')}`;
      actionsStatusBar.tooltip = `Mysti session activity\n${summary.filesWritten} files edited, ${summary.filesRead} files read, ${summary.commandsRun} commands run`;
      actionsStatusBar.show();
    } else {
      actionsStatusBar.hide();
    }
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.openChat', () => {
      vscode.commands.executeCommand('mysti.chatView.focus');
    })
  );

  // Plan 26: pairing is a deliberate, human-initiated act, so it lives behind a
  // command as well as the rail button — a keyboard user must be able to reach
  // it without hunting for an affordance in a collapsed panel.
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.deskRoster', async () => {
      await vscode.commands.executeCommand('mysti.chatView.focus');
      chatViewProvider?.refreshDeskRoster();
    }),
    vscode.commands.registerCommand('mysti.deskPair', async () => {
      if (!vscode.workspace.getConfiguration('mysti').get<boolean>('desk.enabled', false)) {
        vscode.window.showInformationMessage(
          'Mysti Desk is off. Turn on "mysti.desk.enabled" to pair with a teammate.');
        return;
      }
      const url = await vscode.window.showInputBox({
        title: 'Pair with a teammate',
        prompt: 'Paste the desk://pair link they sent you',
        placeHolder: 'desk://pair?...',
        ignoreFocusOut: true,
      });
      if (!url) { return; }
      await vscode.commands.executeCommand('mysti.chatView.focus');
      chatViewProvider?.beginDeskPairing(url);
    }),
  );


  // Plan 04: DeepMyst sign-in / sign-out + Connections panel
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.deepmyst.signIn', () => deepMystAuthManager.signIn()),
    vscode.commands.registerCommand('mysti.deepmyst.signOut', () => deepMystAuthManager.signOut()),
    vscode.commands.registerCommand('mysti.openConnections', () => connectionsPanelManager.open()),
  );

  // Agent authoring: create/import/reload personas and skills
  const runAgentCommand = (label: string, run: () => Promise<void>) =>
    run().catch((error: Error) => {
      console.error(`[Mysti] ${label} failed:`, error);
      vscode.window.showErrorMessage(`Mysti: ${label} failed — ${error.message}`);
    });
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.createPersona', () => runAgentCommand('create persona', () => chatViewProvider.createAgentInteractive('persona'))),
    vscode.commands.registerCommand('mysti.createSkill', () => runAgentCommand('create skill', () => chatViewProvider.createAgentInteractive('skill'))),
    vscode.commands.registerCommand('mysti.createRole', () => runAgentCommand('create role', () => chatViewProvider.createAgentInteractive('role'))),
    vscode.commands.registerCommand('mysti.importSkills', () => runAgentCommand('skill import', () => chatViewProvider.importSkillsInteractive())),
    vscode.commands.registerCommand('mysti.reloadAgents', () => runAgentCommand('agent reload', () => chatViewProvider.reloadAgents())),
    // Plan 17 P1.4a: pick the Mysti coordinator's brain without editing settings.
    // Lists the FULL OpenRouter catalog (free + paid) plus the DeepMyst gateway
    // models, path-aware. Free by default; a paid pick is a deliberate,
    // confirmed opt-in that spends per turn (bounded by mysti.mysti.maxTurns /
    // maxDelegations). Written to a machine-scoped setting so a workspace can
    // never redirect the coordinator to an expensive model.
    vscode.commands.registerCommand('mysti.setCoordinatorModel', async () => {
      const cfg = vscode.workspace.getConfiguration('mysti');
      // Direct-key path is active when an OpenRouter key is configured; otherwise
      // the coordinator runs through the DeepMyst gateway.
      const useDirect = !!((cfg.get<string>('openrouter.apiKey', '') || '').trim());
      const settingKey = useDirect ? 'openrouter.coordinatorModel' : 'mysti.coordinatorModel';
      const autoValue = useDirect ? 'auto' : '';
      const current = (cfg.get<string>(settingKey, autoValue) || '').trim();

      type Item = vscode.QuickPickItem & { value: string | null; paid?: boolean };
      const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator, value: '' });
      // On the gateway path an OpenRouter model needs the litellm `openrouter/` prefix.
      const toValue = (slug: string): string => useDirect ? slug : `openrouter/${slug}`;
      const perMillion = (p?: { prompt: number; completion: number }): string =>
        p ? `$${(p.prompt * 1e6).toFixed(2)}/$${(p.completion * 1e6).toFixed(2)} per 1M` : 'paid';

      let models: Awaited<ReturnType<typeof openRouterClient.listAllModels>> = [];
      try {
        models = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Mysti: loading OpenRouter models…' },
          () => openRouterClient.listAllModels()
        );
      } catch { /* fall back to curated gateway options */ }

      const freeModels = models.filter(m => m.free).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
      const paidModels = models.filter(m => !m.free).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

      const items: Item[] = [];
      items.push({
        label: useDirect ? 'Auto — best free model' : 'Auto — strong free models (default)',
        description: useDirect ? 'first tool-capable free model, no spend' : 'gpt-oss-120b → nemotron → gemma, no spend',
        value: autoValue, picked: current === autoValue,
      });
      if (!useDirect) {
        items.push(sep('DeepMyst gateway (paid — free monthly credits)'));
        items.push({ label: 'claude-haiku-4-5', description: 'cheap, fast; covered by free DeepMyst credits', value: 'claude-haiku-4-5', paid: true });
        items.push({ label: 'claude-sonnet-4-6', description: 'strongest coordination; spends more credits', value: 'claude-sonnet-4-6', paid: true });
      }
      if (freeModels.length) {
        items.push(sep(`OpenRouter — free (${freeModels.length})`));
        for (const m of freeModels) { items.push({ label: m.name || m.id, description: m.id, value: toValue(m.id) }); }
      }
      if (paidModels.length) {
        items.push(sep(`OpenRouter — paid · spends credits (${paidModels.length})`));
        for (const m of paidModels) { items.push({ label: m.name || m.id, description: `${m.id} · ${perMillion(m.pricing)}`, value: toValue(m.id), paid: true }); }
      }
      items.push(sep('Advanced'));
      items.push({ label: 'Custom…', description: useDirect ? 'e.g. anthropic/claude-sonnet-4.6' : 'e.g. claude-opus-4-8, or openrouter/openai/gpt-oss-120b:free', value: null });

      const pick = await vscode.window.showQuickPick(items, {
        title: `Mysti coordinator model — ${useDirect ? 'OpenRouter (direct key)' : 'DeepMyst gateway'}`,
        placeHolder: current ? `Current: ${current}` : 'Current: Auto (free)',
        matchOnDescription: true,
      });
      if (!pick) { return; }

      let value = pick.value;
      let isPaid = !!pick.paid;
      if (value === null) {
        const entered = await vscode.window.showInputBox({
          title: 'Custom coordinator model id', value: current,
          prompt: useDirect ? 'e.g. anthropic/claude-sonnet-4.6' : 'e.g. claude-opus-4-8, or openrouter/openai/gpt-oss-120b:free',
        });
        if (entered === undefined) { return; }
        value = entered.trim();
        isPaid = value.length > 0 && value !== autoValue && !/:free$/.test(value);
      }

      // Free-by-default: a paid pick spends on EVERY turn, not just on fallback —
      // require an explicit, non-silent confirmation.
      if (isPaid) {
        const ok = await vscode.window.showWarningMessage(
          `"${value}" is a paid model. The Mysti coordinator will spend ${useDirect ? 'OpenRouter' : 'DeepMyst'} credits on every turn (spend is bounded by mysti.mysti.maxTurns / maxDelegations). Continue?`,
          { modal: true }, 'Use paid model'
        );
        if (ok !== 'Use paid model') { return; }
      }

      await cfg.update(settingKey, value, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Mysti coordinator model: ${value || 'Auto (free)'}${isPaid ? ' (paid)' : ''}`);
    }),
    // Plan 18 (F4): model-authored memory is a persistent cross-session bias
    // channel — give the user a way to SEE and PRUNE it. Multi-select deletes;
    // selecting everything is "clear all".
    vscode.commands.registerCommand('mysti.viewMystiMemory', async () => {
      const { MystiMemoryStore } = await import('./services/MystiMemoryStore');
      const store = new MystiMemoryStore(context.workspaceState, () => Date.now());
      const entries = store.list();
      if (entries.length === 0) {
        vscode.window.showInformationMessage('Mysti has no remembered facts for this workspace.');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        entries.map(e => ({
          label: e.text.length > 90 ? `${e.text.slice(0, 90)}…` : e.text,
          description: `${e.source === 'host' ? 'system' : 'model'} · used ${e.hits}×`,
          entryText: e.text,
        })),
        {
          title: `Mysti memory — ${entries.length} fact(s) for this workspace`,
          placeHolder: 'Select facts to FORGET (Esc keeps everything)',
          canPickMany: true,
        }
      );
      if (!picks || picks.length === 0) { return; }
      for (const p of picks) { store.forget(p.entryText); }
      vscode.window.showInformationMessage(`Forgot ${picks.length} fact(s). ${entries.length - picks.length} remain.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.newConversation', () => {
      conversationManager.createNewConversation();
      chatViewProvider.postMessage({ type: 'conversationChanged' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.addToContext', async (uri?: vscode.Uri) => {
      if (uri) {
        await contextManager.addFileToContext(uri.fsPath);
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const selection = editor.selection;
          if (!selection.isEmpty) {
            await contextManager.addSelectionToContext(
              editor.document.uri.fsPath,
              editor.document.getText(selection),
              selection.start.line,
              selection.end.line,
              editor.document.languageId
            );
          } else {
            await contextManager.addFileToContext(editor.document.uri.fsPath);
          }
        }
      }
      chatViewProvider.postMessage({
        type: 'contextUpdated',
        payload: contextManager.getContext()
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.clearContext', () => {
      contextManager.clearContext();
      chatViewProvider.postMessage({
        type: 'contextUpdated',
        payload: []
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.openInNewTab', () => {
      chatViewProvider.openInNewTab();
    })
  );

  // Open Visual Test Dashboard command
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.openVisualTestDashboard', () => {
      chatViewProvider.openVisualTestDashboard();
    })
  );

  // Open Canvas command
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.canvasAddScaffold', (scaffold?: string) => {
      // Also the command-palette route to a first artboard, so creating one
      // never depends solely on the empty state's buttons rendering.
      chatViewProvider.addCanvasScaffold(typeof scaffold === 'string' ? scaffold : undefined);
    }),
    vscode.commands.registerCommand('mysti.canvasDiagnostics', () => {
      // Returns the object (for integration tests) AND shows it, so a user can
      // answer "is the canvas working?" without opening devtools.
      const diag = chatViewProvider.canvasDiagnostics();
      console.log('[Mysti] canvas diagnostics:', JSON.stringify(diag, null, 2));
      const rendered = (diag as { rendered?: unknown }).rendered;
      void vscode.window.showInformationMessage(
        rendered
          ? `Mysti Canvas: rendering ${(diag as { pages: number }).pages} artboard(s).`
            + (typeof (rendered as { gestureP95?: number }).gestureP95 === 'number'
              ? ` Last gesture: p50 ${(rendered as { gestureP50?: number }).gestureP50}ms / p95 `
                + `${(rendered as { gestureP95?: number }).gestureP95}ms, `
                + `${(rendered as { gestureDropped?: number }).gestureDropped} dropped frame(s). `
                + '(16.7ms = 60fps; pan the board first if this is missing.)'
              : ' Pan the board once to measure smoothness.')
          : 'Mysti Canvas: the panel has NOT confirmed a render. See the Debug Console for details.',
      );
      return diag;
    }),
    vscode.commands.registerCommand('mysti.openCanvas', () => {
      chatViewProvider.openCanvas();
    }),
    vscode.commands.registerCommand('mysti.restoreCanvasRecovery', () => chatViewProvider.restoreCanvasRecovery())
  );

  // Toggle autonomous mode command
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.toggleAutonomous', () => {
      chatViewProvider.toggleAutonomousMode();
    })
  );

  // Debug commands for testing setup flow (not in package.json - use Command Palette)
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.revokeCapabilities', () => {
      void chatViewProvider.revokeCapabilities();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.reviewSkillProposals', () => {
      void chatViewProvider.reviewSkillProposals();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.skillReport', () => {
      void chatViewProvider.showSkillReport();
    })
  );

  context.subscriptions.push(
    /**
     * Update the installed CLI backends.
     *
     * Runs in the INTEGRATED TERMINAL rather than from the extension host, and
     * that is deliberate on two counts: `npm i -g` needs root wherever npm's
     * prefix is root-owned (the default on macOS), and an extension must not be
     * the thing that escalates privilege — the terminal lets sudo prompt the
     * user and shows them the exact command it is prompting for.
     *
     * Each provider is updated with its OWN command, one per line, so a package
     * that refuses to install cannot abort the others. That is not theoretical:
     * a single `npm i -g a b c` aborted entirely when one package's preinstall
     * rejected the running Node, and nothing at all was updated.
     */
    vscode.commands.registerCommand('mysti.updateClis', async () => {
      const config = vscode.workspace.getConfiguration('mysti');
      if (config.get<boolean>('updates.checkCliUpdates', true)) {
        await cliUpdateService.checkAll({ force: true });
      }

      const updates = cliUpdateService.getUpdates();
      if (updates.length === 0) {
        vscode.window.showInformationMessage('Mysti: every installed CLI is up to date.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        updates.map((u) => ({
          label: u.providerId,
          description: `${u.installed} → ${u.installable}`,
          // When the newest release is out of reach, say why rather than
          // quietly offering an older version than the one just advertised.
          detail: u.blockedByNodeEngine
            ? `${u.latest} requires Node ${u.requiredNode ?? 'newer'} (this machine runs ${process.versions.node})`
            : undefined,
          update: u,
          picked: true,
        })),
        {
          canPickMany: true,
          title: 'Update CLI backends',
          placeHolder: 'These run in a terminal; npm may ask for your password',
        }
      );
      if (!picked || picked.length === 0) { return; }

      const lines = picked
        .map((p) => cliUpdateService.getUpdateCommand(p.update.providerId))
        .filter((c): c is string => !!c);
      if (lines.length === 0) {
        vscode.window.showWarningMessage('Mysti: no update command is known for the selected backends.');
        return;
      }

      const terminal = vscode.window.createTerminal('Mysti: update CLIs');
      terminal.show();
      for (const line of lines) {
        terminal.sendText(line);
      }
      // The CLIs are about to change underneath the cached probe results.
      cliDiscoveryService.invalidate();
    }),

    vscode.commands.registerCommand('mysti.debugSetup', () => {
      chatViewProvider.debugForceSetup();
      vscode.window.showInformationMessage('Debug: Setup flow triggered');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.debugSetupFailure', () => {
      chatViewProvider.debugForceSetupFailure();
      vscode.window.showInformationMessage('Debug: Setup failure triggered');
    })
  );

  // Register CodeLens provider (Mysti: Explain | Refactor | Write Tests)
  const codeLensProvider = new MystiCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider)
  );
  context.subscriptions.push(codeLensProvider);

  // CodeLens action command — opens sidebar and pre-fills prompt
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.codeLensAction', (action: string, functionCode: string, filePath: string, functionName: string) => {
      const prompts: Record<string, string> = {
        explain: `Explain what the function \`${functionName}\` does:\n\n\`\`\`\n${functionCode}\n\`\`\``,
        refactor: `Refactor the function \`${functionName}\` for better readability and performance:\n\n\`\`\`\n${functionCode}\n\`\`\``,
        test: `Write comprehensive tests for the function \`${functionName}\`:\n\n\`\`\`\n${functionCode}\n\`\`\``
      };
      const prompt = prompts[action] || prompts['explain'];

      // Focus the sidebar, then send the message
      vscode.commands.executeCommand('mysti.chatView.focus').then(() => {
        chatViewProvider.postMessage({
          type: 'prefillPrompt',
          payload: { content: prompt, filePath }
        });
      });

      // Track in engagement
      engagementManager.trackMessageSent('codelens');
      telemetryManager.sendEvent('codelens.clicked', { action, functionName });
    })
  );

  // Register URI handler for conversation deep links (Feature 5)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        // Plan 04: DeepMyst sign-in deep-link callback
        // (vscode://DeepMyst.mysti/deepmyst-auth?key=dm_...&state=...)
        // Match leniently (startsWith) and read params from query OR fragment —
        // some editor hosts/protocol handlers route the params into the fragment.
        console.log(`[Mysti] UriHandler received: path=${uri.path} query.len=${uri.query.length} fragment.len=${uri.fragment.length}`);
        if (uri.path.startsWith('/deepmyst-auth')) {
          const params = new URLSearchParams(uri.query || uri.fragment || '');
          const key = params.get('key');
          const state = params.get('state') ?? undefined;
          const error = params.get('error');
          console.log(`[Mysti] DeepMyst link-back: hasKey=${!!key} hasState=${!!state} hasError=${!!error}`);
          if (error) {
            vscode.window.showErrorMessage(`DeepMyst sign-in failed: ${error}`);
          } else if (key) {
            deepMystAuthManager.completeSignIn(key, state).then(ok => {
              if (ok) {
                telemetryManager.sendEvent('deepmyst.signedIn', {});
              } else {
                vscode.window.showWarningMessage('DeepMyst sign-in link-back could not be matched to an active sign-in. Click "Sign in to DeepMyst" once and complete it in the newest browser tab, or use "Enter an API key manually".');
              }
            });
          } else {
            vscode.window.showErrorMessage('DeepMyst sign-in callback was missing the API key.');
          }
          return;
        }
        if (uri.path === '/import') {
          const params = new URLSearchParams(uri.query);
          const data = params.get('data');
          if (data) {
            // Plan 27 P-3: the link is unauthenticated — ask before the store
            // is touched (handleShareableImportLink never rejects).
            return handleShareableImportLink(data, {
              importFromShareable: (d) => conversationManager.importFromShareable(d),
              onImported: () => {
                vscode.commands.executeCommand('mysti.chatView.focus');
                chatViewProvider.postMessage({ type: 'conversationChanged' });
                telemetryManager.sendEvent('deeplink.imported', {});
              },
            });
          }
        }
      }
    })
  );

  // Project onboarding: detect .mysti/ or mysti.md in the workspace
  // Like how .claude/ or CLAUDE.md signal "this project uses Claude Code"
  const hasPromptedTeamOnboarding = context.workspaceState.get<boolean>('mysti.hasPromptedTeamOnboarding');
  if (!hasPromptedTeamOnboarding && vscode.workspace.workspaceFolders?.length) {
    const root = vscode.workspace.workspaceFolders[0].uri;
    const mystiMarkers = [
      vscode.Uri.joinPath(root, '.mysti', 'team.json'),
      vscode.Uri.joinPath(root, '.mysti', 'config.json'),
      vscode.Uri.joinPath(root, 'mysti.md'),
      vscode.Uri.joinPath(root, 'MYSTI.md'),
    ];

    // Check if any Mysti config file exists in the workspace
    Promise.any(mystiMarkers.map(uri => vscode.workspace.fs.stat(uri))).then(async () => {
      const hasSetup = context.globalState.get<boolean>('mysti.hasCompletedSetup');
      if (!hasSetup) {
        const choice = await vscode.window.showInformationMessage(
          'This project has a Mysti configuration. Open Mysti to get started?',
          'Open Mysti',
          'Dismiss'
        );
        if (choice === 'Open Mysti') {
          vscode.commands.executeCommand('mysti.chatView.focus');
        }
        context.workspaceState.update('mysti.hasPromptedTeamOnboarding', true);
      }
    }, () => { /* No Mysti config files found — skip */ });
  }

  // Workspace extension recommendation (Feature 13 — one-time prompt per workspace)
  const hasPromptedRec = context.workspaceState.get<boolean>('mysti.hasPromptedRecommendation');
  const hasCompletedSetup = context.globalState.get<boolean>('mysti.hasCompletedSetup');
  if (!hasPromptedRec && hasCompletedSetup) {
    // Defer to avoid blocking activation
    setTimeout(async () => {
      const choice = await vscode.window.showInformationMessage(
        'Would you like to recommend Mysti to other contributors on this project?',
        'Sure',
        'Not now'
      );
      if (choice === 'Sure') {
        await _addToWorkspaceRecommendations();
        engagementManager.trackWorkspaceRecommendation();
        telemetryManager.sendEvent('workspace.recommendation', { action: 'accepted' });
      } else {
        telemetryManager.sendEvent('workspace.recommendation', { action: 'declined' });
      }
      context.workspaceState.update('mysti.hasPromptedRecommendation', true);
    }, 30_000); // Wait 30s after activation to avoid overwhelming the user
  }

  // Listen for active editor changes for auto-context
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && contextManager.isAutoContextEnabled()) {
        chatViewProvider.postMessage({
          type: 'activeFileChanged',
          payload: {
            path: editor.document.uri.fsPath,
            language: editor.document.languageId
          }
        });
      }
    })
  );

  // Listen for selection changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (contextManager.isAutoContextEnabled() && !event.selections[0].isEmpty) {
        const editor = event.textEditor;
        chatViewProvider.postMessage({
          type: 'selectionChanged',
          payload: {
            path: editor.document.uri.fsPath,
            text: editor.document.getText(event.selections[0]),
            startLine: event.selections[0].start.line,
            endLine: event.selections[0].end.line,
            language: editor.document.languageId
          }
        });
      }
    })
  );

  // Post-activation model-list warm-up (Plan 01 Phase 3). Every load refreshes
  // each agent's model list automatically, and none of it is on the critical
  // path: scheduled MODEL_REFRESH_WARMUP_DELAY_MS after activate() returns via
  // setTimeout, never awaited here, gated by mysti.models.autoRefresh
  // (default true).
  //
  // Three things keep it off the startup budget:
  //  1. the timer floor puts it well after the window has painted;
  //  2. it additionally awaits providerManager.whenReady, so on a slow machine
  //     the probes never overlap the startup CLI-discovery burst (the timer
  //     alone was a guess that a slow box could lose);
  //  3. refreshAll() is TTL-aware and staggers what it does probe, so a second
  //     window minutes later spawns nothing at all.
  //
  // Failures are swallowed inside the registry (curated/cached lists keep
  // serving); a fresh list reaches open panels via ChatViewProvider's
  // onDidUpdateModels -> 'modelsUpdated' broadcast.
  if (config.get<boolean>('models.autoRefresh', true)) {
    const warmupTimer = setTimeout(() => {
      void (async () => {
        // whenReady rejects only if provider init blew up; either way the
        // discovery probes below are independently safe to run.
        await providerManager.whenReady.catch(() => undefined);
        await modelRegistryService.refreshAll();
      })().catch((err) => {
        console.warn(`[Mysti] Background model refresh failed: ${String(err)}`);
      });
    }, MODEL_REFRESH_WARMUP_DELAY_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(warmupTimer) });
  }

  // ---------------------------------------------------------------------------
  // New-model announcements
  //
  // Two triggers, because there are two ways a model becomes new to a user:
  //  1. a backend published one   -> discovery lands -> onDidUpdateModels;
  //  2. a Mysti upgrade added one -> the CURATED list grew, and for a provider
  //     with no discoverModels (Codex, Cline, Hermes, Continue, Kimi) nothing
  //     ever fires. Only the sweep below catches that case, which is exactly how
  //     GPT-6 Astra reaches a Codex user.
  //
  // Both are cheap: reconcile() reads the already-merged list with
  // revalidate:false (no probe) and no-ops unless an id is genuinely unseen.
  // ---------------------------------------------------------------------------
  const reconcileAnnouncements = (providerId: string): void => {
    if (!vscode.workspace.getConfiguration('mysti').get<boolean>('updates.notifyNewModels', true)) {
      return;
    }
    try {
      const { models } = modelRegistryService.getModels(providerId, { revalidate: false });
      modelAnnouncementService.reconcile(providerId, models);
    } catch (err) {
      console.warn(`[Mysti] Model announcement reconcile failed for ${providerId}: ${String(err)}`);
    }
  };

  context.subscriptions.push(
    modelRegistryService.onDidUpdateModels(({ providerId }) => reconcileAnnouncements(providerId))
  );

  // Curated sweep + CLI update check. Deliberately on their own timer rather
  // than inside the models.autoRefresh block: a user who turned off live model
  // discovery still wants to be told that the build they just installed added a
  // model, and still wants a stale-CLI warning.
  const updateSweepTimer = setTimeout(() => {
    void (async () => {
      await providerManager.whenReady.catch(() => undefined);

      for (const id of providerManager.getAllProviderIds()) {
        reconcileAnnouncements(id);
      }

      if (vscode.workspace.getConfiguration('mysti').get<boolean>('updates.checkCliUpdates', true)) {
        // TTL'd (24h) and staggered internally; swallows its own failures.
        await cliUpdateService.checkAll();
      }
    })().catch((err) => {
      console.warn(`[Mysti] Update sweep failed: ${String(err)}`);
    });
  }, MODEL_REFRESH_WARMUP_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(updateSweepTimer) });

  // Activation complete — coarse measure, always recorded and logged
  PerfTracker.measure('activation.total', 'activation.start');
  if (PerfTracker.isEnabled()) {
    PerfTracker.sample('heap.ext', process.memoryUsage().heapUsed);
  }
}

/** Add Mysti to .vscode/extensions.json workspace recommendations */
async function _addToWorkspaceRecommendations(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) { return; }

  const vscodePath = vscode.Uri.joinPath(workspaceFolders[0].uri, '.vscode');
  const extensionsPath = vscode.Uri.joinPath(vscodePath, 'extensions.json');

  let existing: { recommendations?: string[] } = {};
  try {
    const content = await vscode.workspace.fs.readFile(extensionsPath);
    existing = JSON.parse(Buffer.from(content).toString('utf-8'));
  } catch {
    // File doesn't exist — create it
  }

  const recs = existing.recommendations || [];
  if (!recs.includes('DeepMyst.mysti')) {
    recs.push('DeepMyst.mysti');
    existing.recommendations = recs;

    // Ensure .vscode directory exists
    try { await vscode.workspace.fs.createDirectory(vscodePath); } catch { /* already exists */ }
    await vscode.workspace.fs.writeFile(
      extensionsPath,
      Buffer.from(JSON.stringify(existing, null, 2) + '\n', 'utf-8')
    );
    console.log('[Mysti] Added to workspace recommendations');
  }
}

/** Format provider ID to a human-readable label for the status bar */
function _formatProviderLabel(provider: string): string {
  // A few status-bar-specific overrides (shorter than the canonical names);
  // everything else falls back to the single source of truth in the manifest
  // so newly-added providers (kimi-code, continue, openrouter, …) never render
  // as a raw id.
  const labels: Record<string, string> = {
    'claude-code': 'Claude Code',
    'openai-codex': 'Codex',
    'google-gemini': 'Gemini',
    'cline': 'Cline',
    'github-copilot': 'Copilot',
    'cursor': 'Cursor',
    'openclaw': 'OpenClaw',
  };
  return labels[provider] || getProviderDisplayName(provider);
}

export function deactivate(): Promise<void> | undefined {
  console.log('Mysti extension is now deactivated');
  // VS Code awaits (bounded) a returned promise before exiting the host; the
  // open Canvas's final save must not race process exit.
  const canvasClosed = chatViewProvider?.closeCanvasForShutdown();
  // Cleanup is handled automatically via context.subscriptions
  // Additional cleanup for managers not in subscriptions
  if (permissionManager) {
    permissionManager.dispose();
  }
  if (autonomousManager) {
    autonomousManager.dispose();
  }
  if (memoryManager) {
    memoryManager.dispose();
  }
  if (compactionManager) {
    compactionManager.dispose();
  }
  if (lifecycleManager) {
    lifecycleManager.dispose();
  }
  if (activeModeManager) {
    activeModeManager.dispose();
  }
  if (engagementManager) {
    engagementManager.dispose();
  }
  if (commitSignatureManager) {
    commitSignatureManager.dispose();
  }
  if (teamPresenceManager) {
    teamPresenceManager.dispose();
  }
  if (fileDecorationProvider) {
    fileDecorationProvider.dispose();
  }
  if (projectContextManager) {
    projectContextManager.dispose();
  }
  if (visualTestManager) {
    visualTestManager.dispose();
  }
  if (checkpointManager) {
    checkpointManager.dispose();
  }
  return canvasClosed;
}
