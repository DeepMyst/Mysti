/** Ordinary provider ownership across actual host sends; providers and catalogs are inert. */
import { describe, it, expect, vi } from 'vitest';
import { CanvasLiveness } from '../../src/canvas/CanvasLiveness';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';

// The real PlanOptionManager constructs a ResponseClassifier, which spawns
// warm Claude CLI processes — never acceptable in a unit test run.
vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class {
    async classifyResponse() {
      return { questions: [], planOptions: [], context: '' };
    }
  },
}));

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, Uri, window, workspace } from '../helpers/mockVscode';
import type { Settings, StreamChunk, WebviewMessage } from '../../src/types';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';

// Empty discovery roots and awaited initialization keep the actual host fixture isolated.
vi.mock('../../src/managers/AgentLoader', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/managers/AgentLoader')>();
  return { ...actual, AgentLoader: class extends actual.AgentLoader {
    constructor(context: ConstructorParameters<typeof actual.AgentLoader>[0]) { super(context, []); }
  } };
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const SETTINGS: Settings = {
  mode: 'edit-automatically',
  thinkingLevel: 'medium',
  accessLevel: 'full-access',
  contextMode: 'manual',
  model: 'claude-opus-4-6',
  provider: 'claude-code',
};

interface Harness {
  provider: ChatViewProvider;
  /** Args of every addMessageToConversation call. */
  persistedCalls: any[][];
  /** Messages posted to the sidebar panel's webview. */
  sidebarMessages: Array<{ type: string; payload?: any }>;
  /** Replace the chunks the provider stream yields. */
  setStream(chunks: StreamChunk[]): void;
  /** Override the capabilities reported by getProviderInstance. */
  setCapabilities(caps: Record<string, unknown> | undefined): void;
  dispose(): void;
}

async function createHarness(): Promise<Harness & { setSource(source: (content: string) => AsyncGenerator<StreamChunk>): void; cancels: string[]; lifecycle: Array<{kind: string; panelId: string}> }> {
  const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;
  const extensionContext = {
    globalState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async () => undefined,
    },
    workspaceState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async () => undefined,
    },
    subscriptions: [] as { dispose(): void }[],
    extensionPath: '/mock/extension-does-not-exist',
    extensionUri,
    extension: { packageJSON: { version: '0.0.0' } },
  } as any;

  const permissionManager = new PermissionManager('ask-permission');

  let streamChunks: StreamChunk[] = [];
  let source: ((content: string) => AsyncGenerator<StreamChunk>) | undefined;
  const cancels: string[] = [];
  const lifecycle: Array<{kind: string; panelId: string}> = [];
  let capabilities: Record<string, unknown> | undefined = {
    supportsImages: true,
    supportsFileAttachments: true,
    thinkingStyle: 'streamed',
  };

  const persistedCalls: any[][] = [];
  let messageCounter = 0;
  const conversationManager = {
    getCurrentConversation: () => null,
    getConversation: (id: string) => id === 'other-conversation' ? { id, messages: [] } : null,
    getAgentConfig: () => undefined,
    isFirstUserMessage: () => false,
    addMessageToConversation: vi.fn((...args: any[]) => {
      persistedCalls.push(args);
      const [, role, content, context, attachments, thinking, extras] = args;
      return {
        id: `msg-${++messageCounter}`,
        role,
        content,
        timestamp: Date.now(),
        context,
        attachments,
        thinking,
        ...(extras || {}),
      };
    }),
  } as any;

  const providerManager = {
    setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
    getProvider: () => undefined,
    getProviderInstance: () => (capabilities ? { capabilities, getEffectiveModelForSettings: (settings: Settings) => settings.model } : undefined),
    getModelContextWindow: () => 200000,
    setChannelSystemContext: () => undefined,
    cancelRequest: (panelId: string) => { cancels.push(panelId); },
    getAllProviderIds: () => [],
    dispose: () => undefined,
    sendMessage: vi.fn(async function* (content: string) {
      if (source) { yield* source(content); return; }
      for (const chunk of streamChunks) {
        yield chunk;
      }
    }),
  } as any;

  const setupManager = {
    getWizardStatus: async () => ({ anyReady: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
    getWizardStatusCached: () => ({ anyReady: true, complete: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
    ensureProviderStatusFresh: async () => undefined,
    refreshWizardStatus: async () => ({ anyReady: true }),
    invalidateProviderStatus: () => undefined,
    onWizardStatusUpdated: () => ({ dispose: () => {} }),
  } as any;

  const lifecycleManager = {
    onLifecycleEvent: () => undefined,
    touchSession: () => undefined,
    markBusy: (panelId: string) => { lifecycle.push({kind: 'busy', panelId}); },
    markIdle: (panelId: string) => { lifecycle.push({kind: 'idle', panelId}); },
    registerSession: () => undefined,
  } as any;

  const activeModeManager = {
    onStatusChanged: () => undefined,
    onChannelChanged: () => undefined,
    onActivity: () => undefined,
    subscribeToChannelEvents: () => () => undefined,
    isConnected: () => false,
    isInstalled: () => false,
    isIntegrationEnabled: () => false,
  } as any;

  const engagementManager = {
    trackCustomPersonaCreated: () => undefined,
    trackCustomSkillCreated: () => undefined,
    trackMessageSent: () => [],
    trackSuccessfulResponse: () => undefined,
  } as any;

  const memoryManager = {
    learnFromPermissionDecision: () => undefined,
    getProjectMemoryContent: () => '',
    recordProjectLearning: () => undefined,
  } as any;

  const projectContextManager = {
    readRules: () => '',
    getMystiMdContent: () => '',
    getCrossVendorInstructions: () => [],
  } as any;

  const suggestionManager = {
    generateSuggestions: async () => [],
  } as any;

  const autonomousManager = {
    isActive: () => false,
  } as any;

  const compactionManager = {
    shouldCompact: () => false,
    recordUsage: () => undefined,
    // Smart-compaction (Plan 08) additions the done-handler calls unconditionally.
    appendHistory: () => undefined,
    isSmartActive: () => false,
    evaluateCompaction: () => ({ act: false, smart: false }),
    getThreshold: () => 75,
  } as any;

  const contextManager = {
    getContext: () => [],
    setAutoContext: () => undefined,
    clearPanelContext: () => undefined,
  } as any;

  const noop = {} as any;

  const provider = new ChatViewProvider({
    extensionUri,
    extensionContext,
    contextManager,
    conversationManager,
    providerManager,
    suggestionManager,
    brainstormManager: { cancelSession: () => undefined },
    permissionManager,
    setupManager,
    telemetryManager: noop,
    autonomousManager,
    memoryManager,
    compactionManager,
    lifecycleManager,
    slashCommandManager: noop,
    activeModeManager,
    engagementManager,
    projectContextManager,
    visualTestManager: noop,
    modelRegistry: createModelRegistryStub() as any,
    checkpointManager: { snapshot: async () => null, isAvailable: async () => false, rewindTo: async () => null } as any
  });

  const sidebarMessages: Array<{ type: string; payload?: any }> = [];
  (provider as any)._panelStates.set('sidebar', {
    id: 'sidebar',
    webview: {
      postMessage: (message: WebviewMessage) => {
        sidebarMessages.push(message as any);
        return Promise.resolve(true);
      },
    },
    currentConversationId: 'conversation-fixture',
    isSidebar: true,
  });

  const initialization = (provider as any)._agentInitPromise;
  await initialization;
  return {
    cancels, lifecycle, setSource(value) { source = value; },
    provider,
    persistedCalls,
    sidebarMessages,
    setStream(chunks) { streamChunks = chunks; },
    setCapabilities(caps) { capabilities = caps; },
    async dispose() {
      (provider as any)._canvasLiveness?.dispose();
      provider.dispose();
      permissionManager.dispose();
      for (const subscription of extensionContext.subscriptions) { subscription.dispose(); }
      await initialization;
    },
  };
}



function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function send(h: Harness, content: string) {
  return (h.provider as any)._handleSendMessage({content, context: [], settings: {...SETTINGS}}, 'sidebar');
}

// Negative counterparts of the four preserved historical actual-host witnesses.
describe('ordinary provider captured request ownership', () => {
  it.each(['late-text-done', 'late-error-chunk', 'late-thrown-error', 'late-eof'] as const)('rejects %s without closing the replacement Canvas owner', async scenario => {
    clearMockConfig();
    const h = await createHarness();
    const oldWaiting = deferred(); const newWaiting = deferred();
    const releaseOld = deferred(); const releaseNew = deferred();
    let oldRun: Promise<void> | undefined; let newRun: Promise<void> | undefined;
    const p = h.provider as any;
    const events: Array<{type:string;jobId:string}> = [];
    const router = new CanvasJobRouter(event => events.push(event));
    p._canvasLiveness = new CanvasLiveness({router});
    const canvasEnd = vi.spyOn(p._canvasTurns, 'end');
    const returned: string[] = [];
    h.setSource(async function* (content) {
      try {
        if (content === 'OLD_REQUEST') {
          yield {type: 'text', content: 'OLD_PREFIX '};
          oldWaiting.resolve(); await releaseOld.promise;
          if (scenario === 'late-text-done') {
            yield {type: 'text', content: 'STALE_OLD_TAIL'}; yield {type: 'done'};
          } else if (scenario === 'late-error-chunk') {
            yield {type: 'error', content: 'STALE_OLD_ERROR_CHUNK'};
          } else if (scenario === 'late-thrown-error') { throw new Error('STALE_OLD_THROWN_ERROR'); }
        } else if (content === 'NEW_REQUEST') {
          yield {type: 'text', content: 'NEW_PREFIX '}; newWaiting.resolve(); await releaseNew.promise;
          yield {type: 'text', content: 'NEW_FINAL'}; yield {type: 'done'};
        } else { throw new Error('Unexpected inert fixture prompt'); }
      } finally { returned.push(content); }
    });
    try {
      oldRun = send(h, 'OLD_REQUEST'); await oldWaiting.promise;
      p._canvasTurns.open('sidebar', 'old request');
      const firstId = p._canvasLiveness.jobIds()[0];
      const firstJob = router.get(firstId); expect(firstJob).toBeDefined();
      newRun = send(h, 'NEW_REQUEST'); await newWaiting.promise;
      expect(h.cancels).toEqual(['sidebar']); expect(p._cancelledPanels.has('sidebar')).toBe(false);
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      p._canvasTurns.open('sidebar', 'replacement');
      const replacementId = p._canvasLiveness.jobIds()[0];
      const replacementJob = router.get(replacementId);
      expect(replacementJob).toBeDefined(); expect(replacementJob).not.toBe(firstJob);
      const before = {messages:h.sidebarMessages.length,persisted:h.persistedCalls.length,lifecycle:h.lifecycle.length,canvasEnd:canvasEnd.mock.calls.length};
      releaseOld.resolve(); await oldRun;
      expect(h.sidebarMessages.slice(before.messages)).toEqual([]);
      expect(h.persistedCalls.slice(before.persisted)).toEqual([]);
      expect(h.lifecycle.slice(before.lifecycle)).toEqual([]);
      expect(canvasEnd.mock.calls.slice(before.canvasEnd)).toEqual([]);
      expect(router.get(replacementId)).toBe(replacementJob);
      expect(events.filter(event => event.type === 'done' || event.type === 'error')).toHaveLength(1);
      expect(p._runningPanels.has('sidebar')).toBe(true); expect(returned).toEqual(['OLD_REQUEST']);
      releaseNew.resolve(); await newRun;
      expect(h.persistedCalls.filter(args => args[1] === 'assistant').map(args => args[2])).toEqual(['NEW_PREFIX NEW_FINAL']);
      expect(events.filter(event => event.type === 'done' || event.type === 'error')).toHaveLength(2);
      expect(router.activeCount()).toBe(0); expect(p._runningPanels.has('sidebar')).toBe(false);
    } finally {
      releaseOld.resolve(); releaseNew.resolve(); await Promise.allSettled([oldRun,newRun].filter(Boolean));
      await h.dispose(); vi.restoreAllMocks(); clearMockConfig();
    }
  });

  it.each(['Stop with cleared flag','Canvas Stop with cleared flag','conversation switch','same-id view replacement','dispose'] as const)('rejects a delayed tail after %s', async boundary => {
    clearMockConfig(); const h = await createHarness(); const p = h.provider as any;
    const waiting = deferred(); const release = deferred(); let run: Promise<void> | undefined;
    h.setSource(async function* () { yield {type:'text',content:'BEFORE'}; waiting.resolve(); await release.promise;
      yield {type:'text',content:'STALE'}; yield {type:'done'}; });
    try {
      run = send(h,'ORIGINAL'); await waiting.promise;
      if (boundary === 'Stop with cleared flag') {
        await p._handleMessage({type:'cancelRequest',panelId:'sidebar'}); p._cancelledPanels.delete('sidebar');
      } else if (boundary === 'Canvas Stop with cleared flag') {
        const router = new CanvasJobRouter(() => {}); p._canvasLiveness = new CanvasLiveness({ router });
        p._canvasTurns.open('sidebar', 'current request'); expect(router.activeCount()).toBe(1);
        p._canvasTurns.cancel(p._canvasLiveness.jobIds()[0]); p._cancelledPanels.delete('sidebar');
        expect(router.activeCount()).toBe(0);
      } else if (boundary === 'conversation switch') {
        await p._handleMessage({type:'switchConversation',panelId:'sidebar',payload:{id:'other-conversation'}});
      } else if (boundary === 'same-id view replacement') {
        const old=p._panelStates.get('sidebar');p._panelStates.set('sidebar',{...old});
      } else { p.dispose(); }
      if (boundary === 'Stop with cleared flag' || boundary === 'Canvas Stop with cleared flag' || boundary === 'dispose') {
        expect(p._runningPanels.has('sidebar')).toBe(false);
        expect(h.lifecycle.filter(event => event.kind === 'idle')).toHaveLength(1);
      }
      const before={messages:h.sidebarMessages.length,persisted:h.persistedCalls.length,lifecycle:h.lifecycle.length};
      release.resolve(); await run;
      expect(h.sidebarMessages.slice(before.messages)).toEqual([]);
      expect(h.persistedCalls.slice(before.persisted)).toEqual([]);
      expect(h.lifecycle.slice(before.lifecycle)).toEqual([]);
    } finally { release.resolve(); await run; await h.dispose(); vi.restoreAllMocks(); clearMockConfig(); }
  });

  it.each(['done','error','auth_error'] as const)('treats current %s as one-way and closes its iterator and running state', async terminal => {
    clearMockConfig(); const h = await createHarness(); let returned=0; let reachedLate=false;
    h.setSource(async function* () { try { yield {type:'text',content:'CURRENT'};
      yield terminal==='done'?{type:'done'}:{type:terminal,content:'EXPECTED_ERROR'};
      reachedLate=true; yield {type:'text',content:'AFTER_TERMINAL'}; yield {type:'done'};
    } finally {returned++;} });
    try {
      await send(h,'CURRENT_REQUEST');
      expect(returned).toBe(1);expect(reachedLate).toBe(false);
      expect(h.sidebarMessages.filter(message=>message.type==='responseChunk').map(message=>message.payload.content)).toEqual(['CURRENT']);
      expect(h.sidebarMessages.filter(message=>message.type==='responseComplete')).toHaveLength(terminal==='done'?1:0);
      expect(h.persistedCalls.filter(args=>args[1]==='assistant')).toHaveLength(terminal==='done'?1:0);
      expect((h.provider as any)._runningPanels.has('sidebar')).toBe(false);
      expect(h.lifecycle.filter(event=>event.kind==='idle')).toHaveLength(1);
    } finally {await h.dispose();vi.restoreAllMocks();clearMockConfig();}
  });

  it.each(['EOF','throw'] as const)('cleans up the current request on %s without inventing a successful completion', async ending => {
    clearMockConfig();const h=await createHarness();
    h.setSource(async function*(){yield {type:'text',content:'PARTIAL'};if(ending==='throw'){throw new Error('CURRENT_FAILURE');}});
    try {
      await send(h,'CURRENT');expect((h.provider as any)._runningPanels.has('sidebar')).toBe(false);
      expect(h.sidebarMessages.filter(message=>message.type==='responseComplete')).toEqual([]);
      expect(h.sidebarMessages.filter(message=>message.type==='error')).toHaveLength(ending==='throw'?1:0);
      expect(h.lifecycle.filter(event=>event.kind==='idle')).toHaveLength(1);
    } finally{await h.dispose();vi.restoreAllMocks();clearMockConfig();}
  });

  it.each(['visual preparation','retrieval'] as const)('refuses old preflight after deferred %s', async stage => {
    clearMockConfig();const h=await createHarness();const p=h.provider as any;
    const entered=deferred();const release=deferred<string>();const submitted:string[]=[];let first=true;
    if(stage==='visual preparation'){
      vi.spyOn(p,'_visualPromptSnippet').mockImplementation(async()=>{if(first){first=false;entered.resolve();return release.promise;}return 'NEW_CONTEXT';});
    }else{
      p._compactionManager.retrieveContext=async()=>{if(first){first=false;entered.resolve();return release.promise;}return '';};
    }
    const context=vi.spyOn(p._providerManager,'setChannelSystemContext');
    h.setSource(async function*(content){submitted.push(content);yield {type:'text',content:'NEW_RESULT'};yield {type:'done'};});
    let old:Promise<void>|undefined;
    try{
      old=send(h,'OLD_REQUEST');await entered.promise;await send(h,'NEW_REQUEST');const before=h.sidebarMessages.length;
      release.resolve('STALE_CONTEXT');await old;
      expect(submitted).toEqual(['NEW_REQUEST']);expect(h.sidebarMessages.slice(before)).toEqual([]);
      expect(context.mock.calls.some(args=>String(args[1]).includes('STALE_CONTEXT'))).toBe(false);
    }finally{release.resolve('');await old;await h.dispose();vi.restoreAllMocks();clearMockConfig();}
  });

  it('a stale channel approval cannot send after replacement even when it resolves allow', async()=>{
    clearMockConfig();const h=await createHarness();const p=h.provider as any;
    const gated=deferred();const allow=deferred<boolean>();const newWaiting=deferred();const releaseNew=deferred();
    let detect=true;vi.spyOn(p._channelBridge,'detectMarkers').mockImplementation(()=>detect?(detect=false,[{type:'send',channel:'inert',content:'INERT_MESSAGE'}]):[]);
    vi.spyOn(p,'requestPermissionInline').mockImplementation(()=>{gated.resolve();return allow.promise;});
    const execute=vi.spyOn(p._channelBridge,'executeSend').mockResolvedValue(true);
    h.setSource(async function*(content){yield {type:'text',content};if(content==='NEW_REQUEST'){newWaiting.resolve();await releaseNew.promise;}yield {type:'done'};});
    let old:Promise<void>|undefined;let next:Promise<void>|undefined;
    try{
      old=send(h,'OLD_REQUEST');await gated.promise;next=send(h,'NEW_REQUEST');await newWaiting.promise;
      const before=h.sidebarMessages.length;allow.resolve(true);await old;
      expect(execute).not.toHaveBeenCalled();expect(h.sidebarMessages.slice(before)).toEqual([]);
      expect((h.provider as any)._runningPanels.has('sidebar')).toBe(true);
      releaseNew.resolve();await next;
      expect(h.persistedCalls.filter(args=>args[1]==='assistant').map(args=>args[2])).toEqual(['NEW_REQUEST']);
    }finally{allow.resolve(false);releaseNew.resolve();await Promise.allSettled([old,next].filter(Boolean));await h.dispose();vi.restoreAllMocks();clearMockConfig();}
  });
});


it('a send superseded during its 50ms handoff cannot clear Stop or submit after a third send', async()=>{
  clearMockConfig();const h=await createHarness();const p=h.provider as any;
  const firstWaiting=deferred();const thirdWaiting=deferred();const release=deferred();const submitted:string[]=[];
  h.setSource(async function*(content){submitted.push(content);yield {type:'text',content};
    if(content==='FIRST'){firstWaiting.resolve();}else if(content==='THIRD'){thirdWaiting.resolve();}
    await release.promise;yield {type:'done'};
  });
  let first:Promise<void>|undefined;let second:Promise<void>|undefined;let third:Promise<void>|undefined;
  try{
    first=send(h,'FIRST');await firstWaiting.promise;
    second=send(h,'SECOND'); // waits after cancelling and releasing FIRST's running flag
    third=send(h,'THIRD');await thirdWaiting.promise;
    await p._handleMessage({type:'cancelRequest',panelId:'sidebar'});
    expect(p._cancelledPanels.has('sidebar')).toBe(true);
    await second;
    expect(p._cancelledPanels.has('sidebar')).toBe(true);
    expect(submitted).toEqual(['FIRST','THIRD']);
    expect(h.persistedCalls.filter(args=>args[1]==='user').map(args=>args[2])).toEqual(['FIRST','THIRD']);
    release.resolve();await Promise.all([first,third]);
    expect(p._runningPanels.has('sidebar')).toBe(false);
  }finally{release.resolve();await Promise.allSettled([first,second,third].filter(Boolean));await h.dispose();vi.restoreAllMocks();clearMockConfig();}
});

it('late iterator cleanup failure cannot replace an already accepted completion with an error', async()=>{
  clearMockConfig();const h=await createHarness();
  h.setSource(async function*(){try{yield {type:'text',content:'COMPLETE'};yield {type:'done'};}finally{throw new Error('LATE_RETURN_FAILURE');}});
  try{await send(h,'CURRENT');expect(h.sidebarMessages.filter(message=>message.type==='responseComplete')).toHaveLength(1);
    expect(h.sidebarMessages.filter(message=>message.type==='error')).toEqual([]);
    expect((h.provider as any)._runningPanels.has('sidebar')).toBe(false);
  }finally{await h.dispose();vi.restoreAllMocks();clearMockConfig();}
});

it('host compaction refuses explicit declined smart commits instead of invoking a fallback provider', async()=>{
  clearMockConfig();const h=await createHarness();const p=h.provider as any;
  p._compactionManager.getStrategy=()=> 'client-summarize';
  p._compactionManager.isSmartActive=()=>true;
  p._compactionManager.executeSmartSummarization=vi.fn(async()=>({success:false,error:'Input changed',beforeTokens:20,afterTokens:20}));
  const fallback=p._compactionManager.executeClientSummarization=vi.fn();
  try{await p._executeCompaction('sidebar',SETTINGS,{id:'conversation-fixture',messages:[]},{input_tokens:20,output_tokens:0},200000,()=>true);
    expect(fallback).not.toHaveBeenCalled();
    expect(h.sidebarMessages).toContainEqual(expect.objectContaining({type:'compactionStatus',payload:expect.objectContaining({status:'error',error:'Input changed'})}));
  }finally{await h.dispose();vi.restoreAllMocks();clearMockConfig();}
});

it('host compaction forwards its captured owner and suppresses reset/UI effects after a late result', async()=>{
  clearMockConfig();const h=await createHarness();const p=h.provider as any;
  const release=deferred<object>();const entered=deferred();let current=true;const owner=()=>current;
  p._compactionManager.getStrategy=()=> 'client-summarize';p._compactionManager.isSmartActive=()=>true;
  const summarize=p._compactionManager.executeSmartSummarization=vi.fn(()=>{entered.resolve();return release.promise;});
  const reset=p._providerManager.clearSessionForProvider=vi.fn();const dispose=p._providerManager.disposePersistentProcess=vi.fn();
  let run:Promise<void>|undefined;
  try{run=p._executeCompaction('sidebar',SETTINGS,{id:'conversation-fixture',messages:[]},{input_tokens:20,output_tokens:0},200000,owner);
    await entered.promise;expect(summarize.mock.calls[0][3]).toBe(owner);current=false;const before=h.sidebarMessages.length;
    release.resolve({success:true,beforeTokens:20,afterTokens:5,summary:'OLD'});await run;
    expect(reset).not.toHaveBeenCalled();expect(dispose).not.toHaveBeenCalled();expect(h.sidebarMessages.slice(before)).toEqual([]);
  }finally{release.resolve({success:false});await run;await h.dispose();vi.restoreAllMocks();clearMockConfig();}
});

it.each(['conversation switch','import','Stop with cleared flag','same-id view replacement','current','prior Stop'] as const)(
  'manual compaction preserves its captured conversation after %s', async boundary=>{
    clearMockConfig();const h=await createHarness();const p=h.provider as any;
    const entered=deferred();const release=deferred<object>();let run:Promise<void>|undefined;
    const original={id:'conversation-fixture',messages:[{id:'user',role:'user',content:'QUESTION'},{id:'assistant',role:'assistant',content:'ANSWER'}]};
    const snapshot=JSON.stringify(original);const replacement={id:'other-conversation',messages:[]};
    p._conversationManager.getConversation=(id:string)=>id===original.id?original:replacement;
    p._conversationManager.importFromContent=vi.fn(()=>replacement);
    p._compactionManager.getStrategy=()=> 'client-summarize';p._compactionManager.isSmartActive=()=>true;
    p._compactionManager.getLastFill=()=>({input_tokens:20,output_tokens:0});
    const summarize=p._compactionManager.executeSmartSummarization=vi.fn(()=>{entered.resolve();return release.promise;});
    const update=p._compactionManager.updateUsageAfterCompaction=vi.fn();
    const reset=p._providerManager.clearSessionForProvider=vi.fn();const dispose=p._providerManager.disposePersistentProcess=vi.fn();
    const oldDialog=(window as any).showOpenDialog;const oldFs=(workspace as any).fs;
    try{
      if(boundary==='prior Stop'){
        await p._handleMessage({type:'cancelRequest',panelId:'sidebar'});
        expect(p._cancelledPanels.has('sidebar')).toBe(true);
      }
      run=p._handleMessage({type:'manualCompact',panelId:'sidebar'});await entered.promise;
      const owner=summarize.mock.calls[0][3];expect(owner()).toBe(true);
      if(boundary==='conversation switch'){
        await p._handleMessage({type:'switchConversation',panelId:'sidebar',payload:{id:replacement.id}});
      }else if(boundary==='import'){
        (window as any).showOpenDialog=async()=>[Uri.file('/inert-fixture/conversation.json')];
        (workspace as any).fs={readFile:async()=>Buffer.from('{}')};
        await p._handleMessage({type:'importFromFile',panelId:'sidebar'});
        expect(p._conversationManager.importFromContent).toHaveBeenCalledTimes(1);
      }else if(boundary==='Stop with cleared flag'){
        await p._handleMessage({type:'cancelRequest',panelId:'sidebar'});p._cancelledPanels.delete('sidebar');
      }else if(boundary==='same-id view replacement'){
        p._panelStates.set('sidebar',{...p._panelStates.get('sidebar')});
      }
      const shouldComplete=boundary==='current'||boundary==='prior Stop';
      expect(JSON.stringify(original)).toBe(snapshot);expect(owner()).toBe(shouldComplete);
      const before=h.sidebarMessages.length;
      release.resolve({success:true,beforeTokens:20,afterTokens:5,summary:'SUMMARY'});await run;
      if(shouldComplete){
        expect(reset).toHaveBeenCalledTimes(1);expect(dispose).toHaveBeenCalledTimes(1);expect(update).toHaveBeenCalledWith('sidebar',5);
        expect(h.sidebarMessages.slice(before)).toContainEqual(expect.objectContaining({type:'compactionStatus',payload:expect.objectContaining({status:'complete'})}));
        if(boundary==='prior Stop'){expect(p._cancelledPanels.has('sidebar')).toBe(true);}
      }else{
        expect(reset).not.toHaveBeenCalled();expect(dispose).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();
        expect(h.sidebarMessages.slice(before)).toEqual([]);
      }
    }finally{
      release.resolve({success:false});await run;
      if(oldDialog===undefined){delete (window as any).showOpenDialog;}else{(window as any).showOpenDialog=oldDialog;}
      if(oldFs===undefined){delete (workspace as any).fs;}else{(workspace as any).fs=oldFs;}
      await h.dispose();vi.restoreAllMocks();clearMockConfig();
    }
  },
);


it('a deferred ordinary plan classifier cannot publish after the panel owner is replaced', async()=>{
  clearMockConfig();const h=await createHarness();const p=h.provider as any;
  const entered=deferred();const release=deferred<object>();
  const classifier=vi.spyOn(p._planOptionManager,'classifyResponse').mockImplementation(()=>{entered.resolve();return release.promise;});
  const planDispatch=vi.spyOn(p,'_handleDetectedPlanOptions').mockResolvedValue(undefined);
  h.setSource(async function*(){yield {type:'text',content:'PLAN_RESPONSE'};yield {type:'done'};});
  try{
    await send(h,'CURRENT');await entered.promise;expect(classifier).toHaveBeenCalledTimes(1);
    p._panelStates.set('sidebar',{...p._panelStates.get('sidebar')});
    const before=h.sidebarMessages.length;
    release.resolve({questions:[],planOptions:[{id:'plan',title:'Stale plan',description:'Must never dispatch'}],context:''});
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    expect(planDispatch).not.toHaveBeenCalled();expect(h.sidebarMessages.slice(before)).toEqual([]);
  }finally{release.resolve({questions:[],planOptions:[],context:''});await Promise.resolve();await h.dispose();vi.restoreAllMocks();clearMockConfig();}
});

it.each(['visual preparation','retrieval'] as const)('Stop retires lifecycle during deferred ordinary %s', async stage=>{
  clearMockConfig();const h=await createHarness();const p=h.provider as any;
  const entered=deferred();const release=deferred<string>();let submitted=0;
  if(stage==='visual preparation'){
    vi.spyOn(p,'_visualPromptSnippet').mockImplementation(()=>{entered.resolve();return release.promise;});
  }else{p._compactionManager.retrieveContext=()=>{entered.resolve();return release.promise;};}
  h.setSource(async function*(){submitted++;yield {type:'done'};});
  let run:Promise<void>|undefined;
  try{
    run=send(h,'CURRENT');await entered.promise;
    expect(h.lifecycle.filter(event=>event.kind==='busy')).toHaveLength(1);
    await p._handleMessage({type:'cancelRequest',panelId:'sidebar'});
    p._cancelledPanels.delete('sidebar');
    expect(p._runningPanels.has('sidebar')).toBe(false);
    expect(h.lifecycle.filter(event=>event.kind==='idle')).toHaveLength(1);
    const before=h.sidebarMessages.length;release.resolve('STALE');await run;
    expect(submitted).toBe(0);expect(h.sidebarMessages.slice(before)).toEqual([]);
    expect(h.lifecycle.filter(event=>event.kind==='idle')).toHaveLength(1);
  }finally{release.resolve('');await run;await h.dispose();vi.restoreAllMocks();clearMockConfig();}
});

it.each([true,false])('late linked-status lookup (%s) cannot publish a connection card into a replacement', async linked=>{
  clearMockConfig();const h=await createHarness();const p=h.provider as any;
  const entered=deferred();const release=deferred<boolean>();
  p._deepMystAuth={isSignedIn:()=>true};vi.spyOn(p,'_deepMystConnectSnippet').mockReturnValue('');
  vi.spyOn(p,'_isServiceLinked').mockImplementation(()=>{entered.resolve();return release.promise;});
  const card=vi.spyOn(p,'_emitConnectionCard');
  h.setSource(async function*(content){yield {type:'text',content:content==='OLD'?'<<<MYSTI_CONNECT:inert-service>>>':'NEW'};yield {type:'done'};});
  try{
    await send(h,'OLD');await entered.promise;await send(h,'NEW');const before=h.sidebarMessages.length;
    release.resolve(linked);await card.mock.results[0].value;
    expect(h.sidebarMessages.slice(before)).toEqual([]);
    expect(h.sidebarMessages.filter(message=>message.type==='connectionAlready'||message.type==='connectionRequired')).toEqual([]);
  }finally{release.resolve(false);await h.dispose();vi.restoreAllMocks();clearMockConfig();}
});

it('an old semi-autonomous question timer cannot answer its replacement question', async()=>{
  clearMockConfig();const h=await createHarness();const p=h.provider as any;vi.useFakeTimers();
  vi.spyOn(p,'_isSemiAutonomousEnabled').mockReturnValue(true);vi.spyOn(p,'_getSemiAutonomousTimeout').mockReturnValue(1);
  const answer=vi.spyOn(p,'_handleSemiAutonomousQuestionTimeout').mockResolvedValue(undefined);
  h.setSource(async function*(content){yield {type:'ask_user_question',askUserQuestion:{toolCallId:content,questions:[]}};yield {type:'done'};});
  try{
    await send(h,'Q1');await vi.advanceTimersByTimeAsync(500);await send(h,'Q2');
    expect(p._pendingAskUserQuestions.get('sidebar')).toBe('Q2');await vi.advanceTimersByTimeAsync(500);
    expect(answer).not.toHaveBeenCalled();expect(p._pendingAskUserQuestions.get('sidebar')).toBe('Q2');
    expect(p._semiAutoQuestionTimeouts.has('sidebar\0Q1')).toBe(false);expect(p._semiAutoQuestionTimeouts.has('sidebar\0Q2')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0][1]).toMatchObject({toolCallId:'Q2'});expect(p._semiAutoQuestionTimeouts.has('sidebar\0Q2')).toBe(false);
  }finally{vi.useRealTimers();await h.dispose();vi.restoreAllMocks();clearMockConfig();}
});
