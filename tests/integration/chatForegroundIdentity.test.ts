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


const terminalTypes = new Set(['responseComplete','error','authError','requestCancelled']);
function messages(h: Harness): Array<WebviewMessage & {payload?: any}> { return h.sidebarMessages; }
async function dispatch(h: Harness, requestId: string, extra: Record<string,unknown> = {}) {
  return (h.provider as any)._handleMessage({type:'sendMessage', panelId:'sidebar',requestId,
    payload:{content:'REQUEST',context:[],settings:{...SETTINGS},...extra}});
}

describe('captured foreground wire identity',()=>{
  it.each(['done','error','auth_error'] as const)('tags admission, chunks, tools and exactly one %s terminal',async ending=>{
    const h=await createHarness();
    h.setStream([{type:'text',content:'ANSWER'},{type:'thinking',content:'REASON'},
      {type:'tool_use',toolCall:{id:'read-1',name:'Read',input:{path:'inert'},status:'running'}},
      {type:'tool_result',toolCall:{id:'read-1',name:'Read',input:{},output:'OK',status:'completed'}},
      ending==='done'?{type:'done'}:{type:ending,content:'EXPECTED'}]);
    try{
      await dispatch(h,'local-1');const out=messages(h);
      expect(out[0]).toMatchObject({type:'responsePending',requestId:'local-1',payload:{sequence:1}});
      const foreground=out.filter(m=>['messageAdded','responseStarted','responseChunk','toolUse','toolResult',...terminalTypes].includes(m.type));
      expect(foreground.length).toBeGreaterThanOrEqual(6);expect(foreground.every(m=>m.requestId==='local-1')).toBe(true);
      expect(foreground.filter(m=>terminalTypes.has(m.type))).toHaveLength(1);
    }finally{await h.dispose();vi.restoreAllMocks();clearMockConfig();}
  });

  it('correlates Stop during preparation before any start, and refuses an old Stop for a successor',async()=>{
    const h=await createHarness();const p=h.provider as any;const entered=deferred();const release=deferred<string>();let first=true;
    vi.spyOn(p,'_visualPromptSnippet').mockImplementation(async()=>{if(first){first=false;entered.resolve();return release.promise;}return '';});
    const waiting=deferred();const finish=deferred();h.setSource(async function*(){waiting.resolve();await finish.promise;yield {type:'done'};});
    let old:Promise<void>|undefined;let next:Promise<void>|undefined;
    try{
      old=dispatch(h,'old');await entered.promise;
      await p._handleMessage({type:'cancelRequest',panelId:'sidebar',requestId:'old'});
      expect(messages(h).filter(m=>m.type==='requestCancelled')).toEqual([expect.objectContaining({requestId:'old'})]);
      expect(p._runningPanels.has('sidebar')).toBe(false);
      p._cancelledPanels.delete('sidebar');next=dispatch(h,'new');await waiting.promise;
      const count=h.cancels.length;await p._handleMessage({type:'cancelRequest',panelId:'sidebar',requestId:'old'});
      expect(h.cancels).toHaveLength(count);expect(p._runningPanels.has('sidebar')).toBe(true);
      release.resolve('STALE');await old;finish.resolve();await next;
      expect(messages(h).filter(m=>m.type==='responseComplete')).toEqual([expect.objectContaining({requestId:'new'})]);
      expect(messages(h).filter(m=>m.type==='responsePending').map(m=>m.payload.sequence)).toEqual([1,2]);
    }finally{release.resolve('');finish.resolve();await Promise.allSettled([old,next]);await h.dispose();vi.restoreAllMocks();}
  });

  it('configured quick action and typed/menu native slash preserve their client identities',async()=>{
    const h=await createHarness();const p=h.provider as any;h.setStream([{type:'text',content:'OK'},{type:'done'}]);
    p._conversationManager.updateAgentConfig=vi.fn();p._engagementManager.trackSlashCommandUsed=()=>[];
    p._slashCommandManager={mapLegacyCommand:(name:string)=>name,isKnownCommand:()=>false,findNativeCommandId:()=>null,
      resolveNativeCommand:()=>({kind:'prompt',text:'NATIVE'})};
    try{
      await p._handleMessage({type:'quickActionWithConfig',requestId:'quick',panelId:'sidebar',payload:{content:'QUICK',context:[],settings:SETTINGS,suggestedPersona:'builder',suggestedSkills:[]}});
      await p._handleMessage({type:'executeSlashCommand',requestId:'typed',panelId:'sidebar',payload:{command:'inert-native',settings:SETTINGS,context:[]}});
      await p._handleMessage({type:'executeSlashCommand',requestId:'menu',panelId:'sidebar',payload:{commandId:'native:claude-code:inert',settings:SETTINGS,context:[]}});
      expect(messages(h).filter(m=>m.type==='responsePending').map(m=>m.requestId)).toEqual(['quick','typed','menu']);
      expect(messages(h).filter(m=>m.type==='responseComplete').map(m=>m.requestId)).toEqual(['quick','typed','menu']);
    }finally{await h.dispose();vi.restoreAllMocks();}
  });

  it('utility slash has no foreground admission and receiver failures remain neutral notices',async()=>{
    const h=await createHarness();const p=h.provider as any;const sender=p._panelStates.get('sidebar').webview;
    p._engagementManager.trackSlashCommandUsed=()=>[];
    p._slashCommandManager={mapLegacyCommand:()=> 'cmd:model',isKnownCommand:()=>true,executeCommand:async()=>{throw new Error('INERT_FAILURE');}};
    try{
      await p._receivePanelMessage({type:'executeSlashCommand',requestId:'utility',payload:{command:'model'}},'sidebar',sender);
      expect(messages(h).filter(m=>m.type==='responsePending'||terminalTypes.has(m.type))).toEqual([]);
      expect(messages(h)).toContainEqual(expect.objectContaining({type:'systemNotice'}));
    }finally{await h.dispose();vi.restoreAllMocks();}
  });

  it.each(['invalid-shape','few-agents','success'] as const)('session %s emits correlated early/final-only terminal',async mode=>{
    const h=await createHarness();const p=h.provider as any;
    p._providerManager.getAllProviderIds=()=>['claude-code','openai-codex'];
    p._sessionManager.run=async function*(){yield {type:'session_complete',markdown:'SESSION ANSWER'};};
    try{
      await p._handleMessage({type:'startSession',panelId:'sidebar',requestId:'session',payload:{shape:mode==='invalid-shape'?'missing':'review',agentIds:mode==='few-agents'?['claude-code']:['claude-code','openai-codex'],settings:SETTINGS,brief:'REVIEW'}});
      const out=messages(h);expect(out[0]).toMatchObject({type:'responsePending',requestId:'session'});
      expect(out.filter(m=>m.type==='responseComplete')).toEqual([expect.objectContaining({requestId:'session'})]);
      expect(out.filter(m=>['sessionError','sessionEvent','responseStarted'].includes(m.type)).every(m=>m.requestId==='session')).toBe(true);
      expect(out.some(m=>m.type==='responseChunk')).toBe(false);
      expect(h.persistedCalls.filter(args=>args[1]==='assistant')).toHaveLength(mode==='success'?1:0);
    }finally{await h.dispose();vi.restoreAllMocks();}
  });

  it.each(['session','role collaboration','orchestration'] as const)('a delayed %s cannot post/persist/idle after replacement',async lane=>{
    const h=await createHarness();const p=h.provider as any;const entered=deferred();const release=deferred();let old:Promise<void>|undefined;
    h.setStream([{type:'text',content:'NEW ANSWER'},{type:'done'}]);
    p._providerManager.getAllProviderIds=()=>['claude-code','openai-codex'];
    const source=async function*(){entered.resolve();await release.promise;yield {type:lane==='session'?'session_complete':'collab_text',markdown:'OLD',content:'OLD'};return {contextBlock:'OLD',synthesis:'OLD'};};
    if(lane==='session'){p._sessionManager.run=source;p._sessionManager.cancelPanel=vi.fn();}
    if(lane==='role collaboration'){p._collaborationManager.run=source;p._mentionRouter.stripMentions=(text:string)=>text;}
    if(lane==='orchestration'){p._mystiOrchestrator={run:source,cancelPanel:vi.fn()};}
    try{
      old=lane==='session'?p._handleMessage({type:'startSession',panelId:'sidebar',requestId:'old',payload:{shape:'review',agentIds:['claude-code','openai-codex'],settings:SETTINGS,brief:'OLD'}})
        :dispatch(h,'old',lane==='orchestration'?{content:'orchestrate OLD',settings:{...SETTINGS,provider:'mysti'}}:{mentions:[{type:'agent',value:'claude-code',role:'reviewer',displayName:'@claude:reviewer',startIndex:0,endIndex:16}]});
      await entered.promise;await dispatch(h,'new');const before={posts:messages(h).length,persisted:h.persistedCalls.length,lifecycle:h.lifecycle.length};
      release.resolve();await old;
      expect(messages(h).slice(before.posts)).toEqual([]);expect(h.persistedCalls.slice(before.persisted)).toEqual([]);expect(h.lifecycle.slice(before.lifecycle)).toEqual([]);
    }finally{release.resolve();await old;await h.dispose();vi.restoreAllMocks();}
  });

  it.each([true,false])('coordinator ready=%s keeps every initial foreground event correlated',async ready=>{
    const h=await createHarness();const p=h.provider as any;
    p._availableMystiBackends=()=>[];p._buildMystiProjectBrain=async()=>'';
    p._mystiCoordinator={status:()=>({ready}),credentialState:()=>({hasDeepMystKey:ready,usingOpenRouter:false}),resolveCoordinatorModel:async()=> 'inert',stream:async function*(){yield {text:'COORDINATOR',reasoning:'THINKING'};}};
    try{
      await dispatch(h,'coordinator',{settings:{...SETTINGS,provider:'mysti'}});
      const out=messages(h).filter(m=>['responsePending','responseStarted','responseChunk','responseComplete','mystiActionRequired'].includes(m.type));
      expect(out.length).toBeGreaterThan(2);expect(out.every(m=>m.requestId==='coordinator')).toBe(true);
      expect(h.lifecycle.filter(e=>e.kind==='idle')).toHaveLength(1);
      if(ready){expect(out.at(-1)?.type).toBe('responseComplete');}else{expect(out.at(-1)?.payload).toMatchObject({scope:'foreground',terminal:true});}
    }finally{await h.dispose();vi.restoreAllMocks();}
  });

  it('question acknowledgement after done retains original identity and cannot answer a successor question',async()=>{
    const h=await createHarness();const p=h.provider as any;p._memoryManager.learnFromQuestionAnswer=()=>{};
    h.setSource(async function*(content){yield {type:'ask_user_question',askUserQuestion:{toolCallId:content,questions:[]}};yield {type:'done'};});
    try{
      await dispatch(h,'old',{content:'Q1'});
      const followup=vi.spyOn(p,'_handleSendMessage').mockResolvedValue(undefined);
      await p._handleAskUserQuestionResponse({toolCallId:'Q1',answers:{}},'sidebar',{toolCallId:'Q1',questions:[]});
      expect(messages(h).filter(m=>m.type==='toolResult')).toEqual([expect.objectContaining({requestId:'old',scope:'accessory',payload:expect.objectContaining({id:'Q1'})})]);
      followup.mockRestore();await dispatch(h,'stale',{content:'Q-STALE'});await dispatch(h,'next',{content:'Q2'});
      const count=messages(h).length;await p._handleAskUserQuestionResponse({toolCallId:'Q-STALE',answers:{}},'sidebar',{toolCallId:'Q-STALE',questions:[]});
      expect(messages(h)).toHaveLength(count);expect(p._pendingAskUserQuestions.get('sidebar')).toBe('Q2');
    }finally{await h.dispose();vi.restoreAllMocks();}
  });

  it('separate brainstorm Stop token never cancels the last completed or successor foreground request',async()=>{
    const h=await createHarness();const p=h.provider as any;const entered=deferred();const release=deferred();let run:Promise<void>|undefined;
    h.setStream([{type:'done'}]);p._brainstormManager.getCurrentSession=()=>({agents:[],strategy:'quick'});const cancel=p._brainstormManager.cancelSession=vi.fn();
    p._brainstormManager.startBrainstormSession=async function*(){entered.resolve();await release.promise;yield {type:'synthesis_text',content:'LATE'};};
    try{
      await dispatch(h,'ordinary');run=p._handleMessage({type:'sendBrainstormMessage',panelId:'sidebar',payload:{brainstormId:'brain-1',content:'BRAIN',context:[],settings:SETTINGS}});await entered.promise;
      await p._handleMessage({type:'cancelRequest',panelId:'sidebar',payload:{scope:'brainstorm',brainstormId:'brain-1'}});
      expect(cancel).toHaveBeenCalledTimes(1);expect(messages(h).filter(m=>m.type==='brainstormCancelled')).toEqual([{type:'brainstormCancelled',payload:{brainstormId:'brain-1'}}]);
      expect(messages(h).filter(m=>m.type==='requestCancelled')).toEqual([]);
      await dispatch(h,'successor');await p._handleMessage({type:'cancelRequest',panelId:'sidebar',payload:{scope:'brainstorm',brainstormId:'brain-1'}});
      expect(cancel).toHaveBeenCalledTimes(1);release.resolve();await run;expect(messages(h).some(m=>m.type==='brainstormSynthesisChunk')).toBe(false);
    }finally{release.resolve();await run;await h.dispose();vi.restoreAllMocks();}
  });
});

it('browser answers reject consumed, unknown and reused-tool origins before touching successor or sibling questions',async()=>{
  const h=await createHarness();const p=h.provider as any;p._memoryManager.learnFromQuestionAnswer=vi.fn();
  vi.spyOn(p,'_isSemiAutonomousEnabled').mockReturnValue(true);vi.spyOn(p,'_getSemiAutonomousTimeout').mockReturnValue(60);
  h.setStream([{type:'ask_user_question',askUserQuestion:{toolCallId:'shared',questions:[]}},{type:'done'}]);
  p._panelStates.set('tab',{...p._panelStates.get('sidebar'),id:'tab',webview:{postMessage:()=>Promise.resolve(true)}});
  try{
    await dispatch(h,'old');await dispatch(h,'next');
    await p._handleSendMessage({content:'TAB',context:[],settings:SETTINGS},'tab','sibling');
    const siblingTimer=p._semiAutoQuestionTimeouts.get('tab\0shared');
    const currentTimer=p._semiAutoQuestionTimeouts.get('sidebar\0shared');
    const followup=vi.spyOn(p,'_handleSendMessage').mockResolvedValue(undefined);
    for(const requestId of ['old',undefined,'unknown']){
      await p._handleMessage({type:'askUserQuestionResponse',panelId:'sidebar',...(requestId?{requestId}:{}),payload:{toolCallId:'shared',answers:{}}});
      await p._handleMessage({type:'askUserQuestionSkipped',panelId:'sidebar',...(requestId?{requestId}:{}),payload:{toolCallId:'shared'}});
    }
    expect(followup).not.toHaveBeenCalled();expect(p._pendingAskUserQuestions.get('sidebar')).toBe('shared');
    expect(p._semiAutoQuestionTimeouts.get('sidebar\0shared')).toBe(currentTimer);expect(p._semiAutoQuestionTimeouts.get('tab\0shared')).toBe(siblingTimer);
    await p._handleMessage({type:'askUserQuestionResponse',panelId:'sidebar',requestId:'next',payload:{toolCallId:'shared',answers:{}}});
    expect(followup).toHaveBeenCalledTimes(1);expect(p._pendingAskUserQuestions.get('tab')).toBe('shared');
    expect(p._pendingQuestionData.has('tab\0shared')).toBe(true);expect(p._semiAutoQuestionTimeouts.get('tab\0shared')).toBe(siblingTimer);
    await p._handleMessage({type:'askUserQuestionResponse',panelId:'sidebar',requestId:'next',payload:{toolCallId:'shared',answers:{}}});
    expect(followup).toHaveBeenCalledTimes(1);
  }finally{await h.dispose();vi.restoreAllMocks();}
});

it('an immediate autonomous question answer uses its explicit original port before a pending card exists',async()=>{
  const h=await createHarness();const p=h.provider as any;p._memoryManager.learnFromQuestionAnswer=()=>{};
  p._autonomousManager.isActive=()=>true;p._autonomousManager.generateAutoAnswer=()=>({answers:{q:'yes'},decision:{reasoning:'inert'}});
  h.setStream([{type:'ask_user_question',askUserQuestion:{toolCallId:'auto',questions:[]}}]);
  const original=p._handleSendMessage.bind(p);let admitted=false;
  vi.spyOn(p,'_handleSendMessage').mockImplementation((...args:any[])=>{if(!admitted){admitted=true;return original(...args);}return Promise.resolve();});
  try{
    await dispatch(h,'auto-run');
    expect(messages(h).filter(m=>m.type==='toolResult')).toEqual([expect.objectContaining({requestId:'auto-run',scope:'accessory'})]);
    expect(p._handleSendMessage).toHaveBeenCalledTimes(2);
  }finally{await h.dispose();vi.restoreAllMocks();}
});

it('invalid session admission cancels a suspended old provider before returning its own refusal',async()=>{
  const h=await createHarness();const p=h.provider as any;const entered=deferred();const release=deferred();let old:Promise<void>|undefined;
  h.setSource(async function*(){entered.resolve();await release.promise;yield {type:'text',content:'LATE'};yield {type:'done'};});
  try{
    old=dispatch(h,'old');await entered.promise;
    await p._handleMessage({type:'startSession',panelId:'sidebar',requestId:'invalid-session',payload:{shape:'missing',agentIds:[],settings:SETTINGS}});
    expect(h.cancels).toContain('sidebar');expect(p._runningPanels.has('sidebar')).toBe(false);
    expect(messages(h).filter(m=>m.type==='responseComplete')).toEqual([expect.objectContaining({requestId:'invalid-session'})]);
    release.resolve();await old;expect(messages(h).some(m=>m.payload?.content==='LATE')).toBe(false);
  }finally{release.resolve();await old;await h.dispose();vi.restoreAllMocks();}
});

it('session Stop emits its captured terminal and releases lifecycle while the source remains suspended',async()=>{
  const h=await createHarness();const p=h.provider as any;const entered=deferred();const release=deferred();let run:Promise<void>|undefined;
  p._providerManager.getAllProviderIds=()=>['claude-code','openai-codex'];p._sessionManager.cancelPanel=vi.fn();
  p._sessionManager.run=async function*(){entered.resolve();await release.promise;yield {type:'session_complete',markdown:'LATE'};};
  try{
    run=p._handleMessage({type:'startSession',panelId:'sidebar',requestId:'session',payload:{shape:'review',agentIds:['claude-code','openai-codex'],settings:SETTINGS}});await entered.promise;
    await p._handleMessage({type:'cancelRequest',panelId:'sidebar',requestId:'session'});
    expect(p._runningPanels.has('sidebar')).toBe(false);expect(h.lifecycle.filter(e=>e.kind==='idle')).toHaveLength(1);
    expect(messages(h).filter(m=>terminalTypes.has(m.type))).toEqual([{type:'requestCancelled',requestId:'session'}]);
    p._cancelledPanels.delete('sidebar');release.resolve();await run;
    expect(h.lifecycle.filter(e=>e.kind==='idle')).toHaveLength(1);expect(h.persistedCalls.filter(a=>a[1]==='assistant')).toEqual([]);
  }finally{release.resolve();await run;await h.dispose();vi.restoreAllMocks();}
});

it.each(['unchanged','flag-cleared','ordinary','session','brainstorm','same-id-view','sibling','closed'] as const)('stopped coordinator audit obeys exact latest admission (%s)',async replacement=>{
  const h=await createHarness();const p=h.provider as any;const entered=deferred();const release=deferred();let run:Promise<void>|undefined;
  p._availableMystiBackends=()=>[];p._buildMystiProjectBrain=async()=>'';
  p._mystiCoordinator={status:()=>({ready:true}),resolveCoordinatorModel:async()=> 'inert',stream:async function*(){yield {text:'PARTIAL'};entered.resolve();await release.promise;}};
  h.setStream([{type:'text',content:'NEW'},{type:'done'}]);
  try{
    run=dispatch(h,'coordinator',{settings:{...SETTINGS,provider:'mysti'}});await entered.promise;
    await p._handleMessage({type:'cancelRequest',panelId:'sidebar',requestId:'coordinator'});
    if(replacement!=='unchanged'){p._cancelledPanels.delete('sidebar');}
    if(replacement==='ordinary'){await dispatch(h,'successor');}
    if(replacement==='session'){
      await p._handleMessage({type:'startSession',panelId:'sidebar',requestId:'new-session',payload:{shape:'missing',agentIds:[],settings:SETTINGS}});
    }
    if(replacement==='brainstorm'){
      p._brainstormManager.getCurrentSession=()=>undefined;
      p._brainstormManager.startBrainstormSession=async function*(){};
      p._brainstormManager.cancelSession=vi.fn();
      await p._handleBrainstormMessage({brainstormId:'new-brainstorm',content:'B',context:[],settings:SETTINGS},'sidebar');
      const count=h.cancels.length;
      await p._handleMessage({type:'cancelRequest',panelId:'sidebar',requestId:'coordinator'});
      expect(h.cancels).toHaveLength(count);expect(p._brainstormManager.cancelSession).not.toHaveBeenCalled();
    }
    if(replacement==='same-id-view'){p._panelStates.set('sidebar',{...p._panelStates.get('sidebar')});}
    if(replacement==='sibling'){
      p._panelStates.set('tab',{...p._panelStates.get('sidebar'),webview:{postMessage:vi.fn()},currentConversationId:'other-conversation'});
      p._admitForegroundRequest('tab','sibling');
    }
    if(replacement==='closed'){
      p._cancelQueuedChannelTurn('sidebar');p._panelStates.delete('sidebar');expect(p._foregroundRequests.has('sidebar')).toBe(false);
    }
    const count=h.cancels.length;
    await p._handleMessage({type:'cancelRequest',panelId:'sidebar',requestId:'coordinator'});
    expect(h.cancels).toHaveLength(count);
    release.resolve();await run;
    const assistant=h.persistedCalls.filter(args=>args[1]==='assistant').map(args=>args[2]);
    if(replacement==='ordinary'){expect(assistant).toEqual(['NEW']);}
    else if(['unchanged','flag-cleared','sibling'].includes(replacement)){expect(assistant).toHaveLength(1);expect(assistant[0]).toContain('PARTIAL');expect(assistant[0]).toContain('Stopped');}
    else{expect(assistant).toEqual([]);}
    expect(messages(h).filter(m=>m.type==='responseComplete'&&m.requestId==='coordinator')).toEqual([]);
    expect(messages(h).filter(m=>m.type==='requestCancelled'&&m.requestId==='coordinator')).toHaveLength(1);
  }finally{release.resolve();await run;await h.dispose();vi.restoreAllMocks();}
});

it.each(['success','refused','credential-failure'] as const)('orchestration %s settles the matching request without false persistence',async mode=>{
  const h=await createHarness();const p=h.provider as any;
  p._availableMystiBackends=()=>[];p._buildMystiProjectBrain=async()=>'';
  p._mystiCoordinator={status:()=>({ready:true}),credentialState:()=>({hasDeepMystKey:false,usingOpenRouter:false}),resolveCoordinatorModel:async()=> 'inert',stream:async function*(){yield {text:'INLINE'};}};
  p._mystiOrchestrator={cancelPanel:vi.fn(),run:async function*(){
    if(mode==='credential-failure'){throw new Error('HTTP 401: No auth credentials');}
    yield {type:'planning'};
    return mode==='refused'?{refused:'single-lane'}:{synthesis:'ORCHESTRATED',outcomes:[]};
  }};
  try{
    await dispatch(h,'orchestration',{content:'orchestrate TASK',settings:{...SETTINGS,provider:'mysti'}});
    expect(p._runningPanels.has('sidebar')).toBe(false);
    expect(h.lifecycle.filter(e=>e.kind==='idle')).toHaveLength(1);
    expect(p._mystiOrchestrator.cancelPanel).not.toHaveBeenCalled();
    const assistant=h.persistedCalls.filter(a=>a[1]==='assistant').map(a=>a[2]);
    expect(assistant).toEqual(mode==='credential-failure'?[]:[mode==='refused'?'INLINE':'ORCHESTRATED']);
    const out=messages(h);expect(out.filter(m=>m.type==='responseComplete')).toHaveLength(mode==='credential-failure'?0:1);
    if(mode==='credential-failure'){
      expect(out.filter(m=>m.type==='mystiActionRequired')).toEqual([expect.objectContaining({requestId:'orchestration',payload:expect.objectContaining({terminal:true,scope:'foreground'})})]);
    }
  }finally{await h.dispose();vi.restoreAllMocks();}
});
