/* SPDX-License-Identifier: Apache-2.0
 * Records the shipped webviews with clearly labelled deterministic sample data.
 * No connected accounts, provider CLI calls or customer conversations are used.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const version = require('../package.json').version;
const releaseLabel = process.env.MYSTI_DEMO_LABEL || version + ' · Beta 2';
const output = path.resolve(root, process.env.MYSTI_DEMO_OUTPUT || 'docs/releases/2.0.1-beta.2/media');
const only = new Set((process.env.MYSTI_DEMO_SCENES || '').split(',').filter(Boolean));
const viewport = {width:1120,height:840};
const metadata = require('./release-demo-scenes.cjs').metadata;
const sourceFiles=['media/chat/chat.js','media/chat/chat.css','media/chat/index.html','media/chat/markdownRenderer.js','media/chat/subAgentCards.js','media/canvas/canvas.css','media/canvas/index.html','media/vt-dashboard/vt-dashboard.js','media/connections/connections.js','media/proactive/proactive.js','resources/dompurify.min.js','scripts/record-release-demos.cjs','scripts/release-demo-scenes.cjs'];
const hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceAssetHashes=Object.fromEntries(sourceFiles.map(file=>[file,hash(path.join(root,file))]));
const recorderSourceHashes=Object.fromEntries(Object.entries(sourceAssetHashes).filter(([file])=>file.startsWith('scripts/')));
for (const name of only) if (!metadata[name]) throw new Error('Unknown scene: '+name);
fs.mkdirSync(output, { recursive: true });
const fixtureFile = path.join(root, 'tests/webview/chatPageHtml.ts');
const fixture = new Module(fixtureFile, module);
fixture.filename = fixtureFile; fixture.paths = module.paths;
fixture._compile(ts.transpileModule(fs.readFileSync(fixtureFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, fixtureFile);
const { composeChatHtml, INITIAL_STATE } = fixture.exports;
const colors = `:root{--vscode-editor-background:#141b22;--vscode-sideBar-background:#141b22;--vscode-foreground:#e4eae9;--vscode-descriptionForeground:#96aaa9;--vscode-panel-border:#33434d;--vscode-font-family:Arial,sans-serif;--vscode-font-size:14px;--vscode-focusBorder:#71dfbc;--vscode-textLink-foreground:#71dfbc;--vscode-button-background:#266c63;--vscode-button-foreground:#fff;--vscode-input-background:#24303a;--vscode-input-foreground:#e4eae9;--vscode-input-border:#3b505b;--vscode-errorForeground:#f6a892;--vscode-list-hoverBackground:#243b43;--vscode-list-activeSelectionBackground:#254b51}body{font-family:Arial,sans-serif;background:#141b22;color:#e4eae9}#release-caption{position:fixed;top:0;left:0;right:0;height:64px;padding:11px 24px;background:#152b30;color:#a9e8d2;font:12px Arial,sans-serif;z-index:2147483646;letter-spacing:.05em;border-bottom:1px solid #43605c;box-sizing:border-box;width:100%;white-space:nowrap;overflow:hidden;text-align:left}body{padding-top:64px!important;box-sizing:border-box}#setup-wizard{top:64px}#app{height:calc(100vh - 64px)}#release-caption strong{display:block;color:#eff9f4;font-size:16px;letter-spacing:0;font-weight:500;margin-bottom:5px}#release-caption small{font-size:10px;letter-spacing:.12em}#release-pointer{position:fixed;z-index:2147483647;width:16px;height:16px;border:2px solid #9de9c9;border-radius:50%;background:#163c4099;pointer-events:none;transform:translate(-50%,-50%);left:-30px;top:-30px;box-shadow:0 0 0 3px #14242b80}`;
const opinionProviders = [
  { id: 'claude-code', icon:'icons/Claude.png', displayName: 'Claude Code', shortId: 'claude', color: '#e6aa86', models: [{ id: 'opus', name: 'Opus', description: 'Complex coding and reasoning' }], capabilities: { modelSelection: 'full', supportsReadOnly: true, supportsAskPermission: true, supportsUltracode: true, effortLevels: ['low','medium','high','xhigh','max'], effortDefault: 'high' } },
  { id: 'openai-codex', icon:'icons/openai_white.png', displayName: 'Codex', shortId: 'codex', color: '#7fe3c0', models: [{ id: 'codex', name: 'Codex', description: 'Coding and review' }], capabilities: { modelSelection: 'full', supportsReadOnly: true, supportsAskPermission: true, effortLevels: ['low','medium','high','xhigh'] } },
];
// Match registered adapters, not every experimental provider source file.
const extraProviders = [
 ['google-gemini','Gemini','gemini'], ['github-copilot','GitHub Copilot','copilot'],
 ['cline','Cline','cline'], ['cursor','Cursor','cursor'], ['openclaw','OpenClaw','openclaw'],
 ['opencode','OpenCode','opencode'], ['qwen-code','Qwen Code','qwen'], ['hermes','Hermes','hermes'],
 ['continue','Continue','continue'], ['kimi-code','Kimi Code','kimi'], ['ollama','Ollama','ollama'],
 ['localai','LocalAI','localai'], ['openrouter','OpenRouter','openrouter'], ['minimax','MiniMax','minimax'],
].map(([id,displayName,shortId]) => ({id,displayName,shortId,models:id==='ollama'?[{id:'local-model',name:'Local model'}]:[],capabilities:id==='ollama'?{supportsToolUse:true,toolCallsAreProposals:true,planMode:'detected',modelSelection:'custom-only'}:{}}));
const providers = [...opinionProviders, ...extraProviders];
const recordings = [];
const state = { ...INITIAL_STATE, brainstormAgents: ['claude-code','openai-codex'], providerAvailability: Object.fromEntries(providers.map(p=>[p.id,{available:true}])), settings: { ...INITIAL_STATE.settings, model: 'opus' },
  providers: providers.map(p => ({ name: p.id, displayName: p.displayName, models: p.models })),
  providerManifest: { schemaVersion: 1, providers },
};
const fire = (page, type, payload) => page.evaluate(m => window.dispatchEvent(new MessageEvent('message', {data:m})), {type,payload});
const pause = (page, ms = 700) => page.waitForTimeout(ms);
async function caption(page, text) {
  await page.evaluate(({text,releaseLabel}) => {
    let el=document.getElementById('release-caption');
    if(!el){el=document.createElement('div');el.id='release-caption';document.body.appendChild(el);}
    el.replaceChildren();const title=document.createElement('strong');title.textContent=text;el.appendChild(title);
    const detail=document.createElement('small');detail.textContent='MYSTI '+releaseLabel+'  /  INTERFACE DEMO · SAMPLE DATA';el.appendChild(detail);
    if(!document.getElementById('release-pointer')){
      const pointer=document.createElement('div');pointer.id='release-pointer';document.body.appendChild(pointer);
      document.addEventListener('mousemove',e=>{pointer.style.left=e.clientX+'px';pointer.style.top=e.clientY+'px';});
      document.addEventListener('mousedown',()=>{pointer.style.background='#9de9c9';});
      document.addEventListener('mouseup',()=>{pointer.style.background='#163c4099';});
    }
  }, {text,releaseLabel});
  if(page.__captureReady===undefined) page.__captureReady=Date.now();
}
const asset = (file, mime='image/png') => 'data:'+mime+';base64,'+fs.readFileSync(file).toString('base64');
/** The shipped chat page with icons inlined and the current package version. */
function composeDemoChatHtml() {
  return composeChatHtml().replaceAll('0.0.0-test',version).replace(/src="\/([^"]+)"/g, (match, relative) => {
    const file=path.join('resources',relative);
    if (!/\.(png|svg|webp|jpg|gif)$/i.test(file) || !fs.existsSync(file)) return match;
    const ext=path.extname(file).slice(1);
    return 'src="'+asset(file,ext==='svg'?'image/svg+xml':'image/'+ext)+'"';
  }).replace(/window\.__MYSTI_BOOT__ = (.*?);/, (_match, json) => {
    const boot=JSON.parse(json);boot.version=version;boot.logoUri=asset('resources/Mysti-Logo.png');
    for(const name of fs.readdirSync('resources/icons').filter(n=>n.endsWith('.png'))) {
      boot.iconUris[name.slice(0,-4)]=asset('resources/icons/'+name);
    }
    const logos={gemini:'gemini.png.webp',cline:'cline.png',copilot:'copilot.png',cursor:'cursor.png',
      openclaw:'openclaw.png',opencode:'opencode.png',ollama:'ollama.png',localai:'localai.png',
      qwen:'qwen.png',hermes:'hermes.png',continue:'continue.png',openrouter:'openrouter.png',kimi:'kimi.png',minimax:'minimax.svg'};
    for (const [key,file] of Object.entries(logos)) boot[key+'LogoUri']=asset('resources/icons/'+file,file.endsWith('.svg')?'image/svg+xml':file.endsWith('.webp')?'image/webp':'image/png');
    boot.claudeLogoUri=asset('resources/icons/Claude.png');
    boot.openaiLogoLightUri=asset('resources/icons/openai.svg','image/svg+xml');
    boot.openaiLogoDarkUri=asset('resources/icons/openai_white.png');
    return 'window.__MYSTI_BOOT__ = '+JSON.stringify(boot)+';';
  });
}
async function chat(page) {
  await page.setContent(composeDemoChatHtml()); await page.addStyleTag({content:colors}); await fire(page,'initialState',state);
  const footer=await page.locator('#agent-select-btn').boundingBox();
  if(!footer || footer.y+footer.height>viewport.height) throw new Error('Composer clipped by recording caption');
}
async function record(browser, name, action) {
  if(only.size && !only.has(name)) return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'mysti-demo-'));
  const context = await browser.newContext({viewport,recordVideo:{dir:scratch,size:viewport}});
  // Samples stay offline: requests from an accidental external image/link fail.
  await context.route(/^https?:/, route => route.abort());
  const startedAt=Date.now();
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const video = page.video();
  try {
    await action(page);await page.evaluate(()=>document.getElementById('release-pointer')?.style.setProperty('opacity','0'));await pause(page,1800);
    const broken=await page.evaluate(()=>Array.from(document.images).filter(img=>img.getBoundingClientRect().width>0 && img.getBoundingClientRect().height>0 && !img.naturalWidth).map(img=>img.getAttribute('src')));
    if(broken.length) throw new Error('Visible images failed to load: '+JSON.stringify(broken));
    if(!await page.evaluate(()=>!!document.elementFromPoint(30,20)?.closest('#release-caption'))) throw new Error('Sample-data caption is obscured');
    if(!page.__posterSaved) await page.screenshot({path:path.join(output,name+'.png')});
    if(errors.length) throw new Error(errors.join('\n'));
    await context.close();
    const source=await video.path();
    const trim=Math.max(0,((page.__captureReady || startedAt)-startedAt)/1000).toFixed(3);
    execFileSync('ffmpeg',['-y','-loglevel','error','-ss',trim,'-i',source,'-an','-c:v','libx264','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',path.join(output,name+'.mp4')]);
    if(name==='agent-workflow') execFileSync('ffmpeg',['-y','-loglevel','error','-ss',trim,'-i',source,'-vf','fps=8,scale=840:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer','-loop','0',path.join(output,name+'.gif')]);
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,size','-of','json',path.join(output,name+'.mp4')],{encoding:'utf8'}));
    recordings.push({name,...metadata[name],capturedAt:new Date().toISOString(),recorderSourceHashes,durationSeconds:Number(probe.format.duration),bytes:Number(probe.format.size),sha256:hash(path.join(output,name+'.mp4'))});
    console.log('Recorded '+name+' ('+probe.format.duration+'s)');
  } catch(error) {
    await page.screenshot({path:path.join(scratch,'failure.png')}).catch(()=>{});
    console.error('Scene failed; diagnostic screenshot: '+path.join(scratch,'failure.png'));
    throw error;
  } finally {
    await context.close();
    if(recordings.some(recording=>recording.name===name)) fs.rmSync(scratch,{recursive:true,force:true});
  }
}
module.exports = { composeDemoChatHtml, demoState: state, colors };
if (require.main === module) (async()=>{
 const browser=await chromium.launch();
 try {
  const helpers={record,chat,caption,fire,pause,state,colors,asset,output,composeDemoChatHtml};
  await require('./release-demo-scenes.cjs').recordBefore(browser,helpers);
  await record(browser,'agent-opinions',async page=>{
   await chat(page); await caption(page,'Two agents. Two independent opinions.');
   await page.fill('#message-input','@claude @codex What are your opinions on adding a cache to this API?'); await pause(page,1200);
   await fire(page,'messageAdded',{id:'demo-user',role:'user',content:'@claude @codex What are your opinions on adding a cache to this API?',timestamp:Date.now()});
   await page.fill('#message-input',''); await fire(page,'responseStarted',{provider:'mysti',participants:['claude-code','openai-codex']});
   await fire(page,'collaborationStarted',{runId:'demo-opinions',collaborators:opinionProviders.map(p=>({agentId:p.id}))});
   const event=async(id,type,extra={})=>fire(page,'collaborator',{runId:'demo-opinions',collaboratorId:id,agentId:id,label:providers.find(p=>p.id===id).displayName,type,...extra});
   await event('claude-code','collab_started'); await event('openai-codex','collab_started'); await pause(page,1400);
   await event('claude-code','collab_text',{content:'**Start with the consistency contract.**\n\nA cache is useful if brief staleness is acceptable. Define invalidation and tenant isolation before choosing a store.'}); await pause(page,900);
   await event('openai-codex','collab_text',{content:'**Measure the slow path first.**\n\nCheck repeated reads and p95 latency. I would prototype a bounded TTL cache, then compare hit rate and latency under load.'}); await pause(page,900);
   await event('claude-code','collab_complete'); await event('openai-codex','collab_complete'); await fire(page,'collaborationComplete',{runId:'demo-opinions'});await pause(page,1000);
   await fire(page,'responseChunk',{type:'text',content:'## Claude Code\n\nDefine consistency and invalidation before choosing a store.\n\n## Codex\n\nMeasure the slow path, then compare a bounded TTL cache under load.'});
   await fire(page,'responseComplete',{message:{id:'demo-results',role:'assistant',participants:['claude-code','openai-codex'],content:'## Claude Code\n\nDefine consistency and invalidation before choosing a store.\n\n## Codex\n\nMeasure the slow path, then compare a bounded TTL cache under load.',timestamp:Date.now()}});await pause(page,800);
  });
  await record(browser,'second-opinion',async page=>{
   await chat(page);await caption(page,'A fresh perspective, one click away.');
   const question='Should this API retry failed payments automatically?';
   await fire(page,'messageAdded',{id:'question',role:'user',content:question,timestamp:Date.now()});
   await fire(page,'responseStarted',{provider:'claude-code'});
   const answer='Retry transient failures with a bounded budget. Use an idempotency key so a retry cannot charge the customer twice.';
   await fire(page,'responseChunk',{type:'text',content:answer});
   await fire(page,'responseComplete',{usage:{input_tokens:42,output_tokens:30},message:{id:'answer',role:'assistant',provider:'claude-code',model:'opus',content:answer,timestamp:Date.now()}});
   await pause(page,1200);await page.locator('[data-second-opinion]').last().click();await pause(page,1400);
   if(await page.locator('.second-opinion-item[data-agent="claude-code"]').count()) throw new Error('Second opinion offered the original agent');
   await page.click('.second-opinion-item[data-agent="openai-codex"]');
   const request=await page.evaluate(()=>window.__posted.find(m=>m.type==='sendMessage'));
   if(request?.payload?.content!==question || request.payload.secondOpinion?.provider!=='openai-codex' || request.payload.secondOpinion?.messageId!=='question') throw new Error('Second opinion did not preserve the original question and explicit respondent');
   await fire(page,'messageAdded',{id:'second-question',role:'user',content:request.payload.content,timestamp:Date.now()});
   await fire(page,'responseStarted',{provider:'openai-codex'});await pause(page,900);
   const second='Also test the ambiguous outcome: the payment succeeded, but the response timed out. Reconcile with the payment provider before retrying.';
   await fire(page,'responseChunk',{type:'text',content:second});
   await fire(page,'responseComplete',{usage:{input_tokens:42,output_tokens:36},message:{id:'second-answer',role:'assistant',provider:'openai-codex',model:'codex',content:second,timestamp:Date.now()}});
   if(await page.locator('.message.assistant[data-provider="openai-codex"]').count()!==1) throw new Error('Missing Codex attribution');
  });
  await record(browser,'agent-workflow',async page=>{
   await chat(page);await caption(page,'Tag the specialist. Then hand off the result.');
   const prompt='@claude Design a retry policy, then @codex review it for edge cases';
   await page.fill('#message-input',prompt);await pause(page,1400);
   await page.click('#send-btn');
   const request=await page.evaluate(()=>window.__posted.find(m=>m.type==='sendMessage'));
   if(request?.payload?.content!==prompt) throw new Error('Workflow prompt changed on send');
   await fire(page,'messageAdded',{id:'workflow-question',role:'user',content:prompt,timestamp:Date.now()});
   await fire(page,'responseStarted',{provider:'mysti',participants:['claude-code','openai-codex']});
   const event=(runId,id,type,extra={})=>fire(page,'collaborator',{runId,collaboratorId:id,agentId:id,label:providers.find(p=>p.id===id).displayName,type,...extra});
   await fire(page,'collaborationStarted',{runId:'design',phaseIndex:0,phaseCount:2,nextAgents:['Codex'],nextDependsOnPrevious:true});
   await event('design','claude-code','collab_started');await pause(page,1200);
   await event('design','claude-code','collab_text',{content:'Use a capped exponential backoff with jitter. Retry only transient errors and require an idempotency key for payments.'});await pause(page,1200);
   if(!(await page.locator('.collaboration-next').textContent()).includes('Waits for this step to succeed')) throw new Error('Missing dependency status');
   await event('design','claude-code','collab_complete');await fire(page,'collaborationComplete',{runId:'design'});
   await fire(page,'collaborationStarted',{runId:'review',phaseIndex:1,phaseCount:2,dependsOnPrevious:true});
   await event('review','openai-codex','collab_started');await pause(page,1000);
   await event('review','openai-codex','collab_text',{content:'Review of Claude’s policy: add a total deadline and handle Retry-After. Test timeouts after a successful charge, exhausted budgets, and cancellation.'});await pause(page,1400);
   await event('review','openai-codex','collab_complete');await fire(page,'collaborationComplete',{runId:'review'});
   if(await page.locator('.collaboration-card [data-state="complete"]').count()!==2) throw new Error('Workflow steps did not both finish');
   const summary='## Claude Code\n\nUse bounded retries with idempotency.\n\n## Codex\n\nAdd deadline, Retry-After and ambiguous-outcome tests.';
   await fire(page,'responseChunk',{type:'text',content:summary});
   await fire(page,'responseComplete',{message:{id:'workflow-result',role:'assistant',participants:['claude-code','openai-codex'],content:summary,timestamp:Date.now()}});
   for(const card of await page.locator('.collaboration-card summary').all()) await card.click();
   await page.locator('.collaboration-group').first().scrollIntoViewIfNeeded();
  });
  await record(browser,'provider-switching',async page=>{
   await chat(page);await caption(page,'16 provider adapters. Your choice of agent.');
   for(const provider of providers) if(await page.locator('#agent-menu [data-agent="'+provider.id+'"]').count()!==1) throw new Error('Missing registered provider: '+provider.id);
   await page.fill('#message-input','Explain the main entry point of this project.');
   await page.click('#agent-select-btn');await pause(page,1700);
   for (const id of ['openai-codex','ollama','claude-code']) {
    const row=page.locator('#agent-menu .agent-menu-item[data-agent="'+id+'"]');
    await row.scrollIntoViewIfNeeded();await pause(page,1000);await row.click();
    await fire(page,'settingsSync',{provider:id,model:id==='claude-code'?'opus':id==='openai-codex'?'codex':'local-model'});await pause(page,1000);
    const selected=await page.evaluate(id=>window.__posted.some(m=>m.type==='updateSettings'&&m.payload?.provider===id),id);
    if(!selected) throw new Error('Provider selection did not reach host: '+id);
    if(await page.inputValue('#message-input')!=='Explain the main entry point of this project.') throw new Error('Switch discarded draft');
    if(id!=='claude-code') await page.click('#agent-select-btn');
   }
   await page.click('#agent-select-btn');await pause(page,1000);
  });
  await record(browser,'connected-tools',async page=>{
   const html=fs.readFileSync('media/connections/index.html','utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace(/<link[^>]+>/g,'').replace(/<script[^>]*><\/script>/g,'');
   await page.setContent(html);await page.addStyleTag({content:fs.readFileSync('media/connections/connections.css','utf8')+colors});
   await page.evaluate(()=>{window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});});
   await page.addScriptTag({content:fs.readFileSync('media/connections/connections.js','utf8')});
   await caption(page,'Connected apps. Shared tools for your agents.');
   const data={signedIn:true,connections:[],connectionsAvailable:true,useInLocalClis:false};
   await fire(page,'state',data);await pause(page,1200);await page.click('#btn-manage');
   if(!await page.evaluate(()=>window.__posted.some(m=>m.type==='manageConnections'))) throw new Error('Catalog action did not reach host');
   // Simulate the return from DeepMyst authorization; no account is connected here.
   data.connections=[['github','GitHub','Pull requests and code context'],['slack','Slack','Team discussions'],['gmail','Gmail','Email context'],['googlecalendar','Google Calendar','Meetings and schedules']].map(([id,displayName,description])=>({id,displayName,description,provider:'composio',status:'connected'}));
   await fire(page,'state',data);await pause(page,1700);await page.click('#btn-refresh');
   if(await page.locator('#connections-list .list-item').count()!==4) throw new Error('Connections missing');
   if(!await page.evaluate(()=>window.__posted.some(m=>m.type==='refresh'))) throw new Error('Refresh action did not reach host');
   await page.locator('#connections-list').scrollIntoViewIfNeeded();await pause(page,1200);
  });
  await record(browser,'brainstorm',async page=>{
   await chat(page);await caption(page,'Brainstorm: independent analysis, shared synthesis.');
   await page.click('#agent-select-btn');await page.click('#agent-menu [data-agent="brainstorm"]');
   const prompt='Should we cache checkout prices or compute them on each request?';
   await page.fill('#message-input',prompt);await pause(page,1400);await page.click('#send-btn');
   if(!await page.evaluate(()=>window.__posted.some(m=>m.type==='updateSettings'&&m.payload?.provider==='brainstorm'))) throw new Error('Brainstorm selection did not reach host');
   await fire(page,'messageAdded',{id:'brainstorm-question',role:'user',content:prompt,timestamp:Date.now()});
   await fire(page,'brainstormStarted',{sessionId:'demo-brainstorm',strategy:'quick'});await pause(page,1100);
   for(const [agentId,content] of [
    ['claude-code','**Keep the price authoritative.** Cache the product metadata, but calculate the payable total using current promotions and inventory.'],
    ['openai-codex','**Measure before adding a cache.** Benchmark checkout latency and test stale promotions. A short TTL alone does not guarantee the correct price.']]) {
    await fire(page,'brainstormAgentChunk',{agentId,content,type:'text'});await pause(page,1300);
    await fire(page,'brainstormAgentComplete',{agentId});
   }
   await fire(page,'brainstormPhaseChange',{phase:'synthesis',strategy:'quick'});await pause(page,700);
   const unifiedSolution='Cache stable metadata, compute the final price at checkout, and benchmark the uncached path first. Add tests for expired promotions and price changes before optimizing.';
   await fire(page,'brainstormSynthesisChunk',{content:unifiedSolution});await pause(page,1200);
   await fire(page,'brainstormComplete',{unifiedSolution,message:{id:'brainstorm-result'}});
   if(!(await page.locator('#message-input').getAttribute('placeholder')).includes('Ask anything')) throw new Error('Brainstorm composer still busy');
   if(!(await page.locator('[data-brainstorm-synthesis] .message-content').textContent()).includes('Cache stable metadata')) throw new Error('Brainstorm synthesis missing');
  });
  await record(browser,'composer-controls',async page=>{
   await chat(page); await caption(page,'Model, effort and Ultracode. One consistent choice.');
   await page.click('#model-menu-btn');await pause(page,1000);
   const slider=page.locator('#model-menu input[type="range"]');await slider.focus();await page.keyboard.press('ArrowRight');await pause(page,1000);
   await page.keyboard.press('Escape');await page.click('#tools-menu-btn');await pause(page,900);
   const ultra=page.locator('#tools-menu [role="switch"]');if(await ultra.count())await ultra.click();
   if (await page.locator('#model-menu-btn #model-menu-effort').textContent() !== 'Extra High · Ultracode') throw new Error('Composer footer is not synchronized with the menu controls');
   await pause(page,1000);
  });
  await record(browser,'proactive-inbox',async page=>{
   const html=fs.readFileSync('media/proactive/index.html','utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace(/<link[^>]+>/g,'').replace(/<script[^>]*><\/script>/g,'');
   await page.setContent(html);await page.addStyleTag({content:fs.readFileSync('media/proactive/proactive.css','utf8')+colors});
   await page.evaluate(()=>{window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});});await page.addScriptTag({content:fs.readFileSync('media/proactive/proactive.js','utf8')});
   await caption(page,'Before you start. Relevant evidence, with its source.');
   const data={type:'state',signedIn:true,busy:false,local:{watches:[],notifications:false},cloud:{available:true,read_only:false,connections:[{id:'demo',name:'Example connection',source:'github',supported:true}],responsibilities:[{id:'checkout',title:'Checkout API',state:'active',source:'github',resource:'example/checkout',health:'Checked',last_checked_at:new Date().toISOString()}],insights:[{id:'insight',responsibility_id:'checkout',title:'Retry behavior changed in checkout',summary:'A related pull request changes timeout handling. Review its assumptions before adding a retry layer.',state:'unread',created_at:new Date().toISOString(),evidence:{source:'github',resource:'example/checkout',excerpt:'Proposed change: make retry policy explicit at the service boundary.'}}]}};
   await page.evaluate(d=>window.dispatchEvent(new MessageEvent('message',{data:d})),data);await pause(page,1000);
   await page.selectOption('#task-responsibility','checkout');await page.fill('#task-summary','Review retry behavior before changing the checkout client');await pause(page,1300);await page.click('#task-check');await pause(page,700);
   const request=await page.evaluate(()=>window.__posted.find(m=>m.type==='taskBriefing'));
   data.briefing={requestId:request.requestId,responsibilityId:'checkout',title:'Checkout API · related evidence',checkedAt:new Date().toISOString(),notices:['Related evidence is not proof of task ownership.'],insights:data.cloud.insights};
   await page.evaluate(d=>window.dispatchEvent(new MessageEvent('message',{data:d})),data);
   await page.locator('#task-briefing').scrollIntoViewIfNeeded();await pause(page,1000);
  });
  await require('./release-demo-scenes.cjs').recordAfter(browser,helpers);
  if(only.size) {
    const previousPath=path.join(output,'capture.json');
    if(!fs.existsSync(previousPath)){console.log('Selected scenes saved; run all scenes to create the tour.');return;}
    const previous=JSON.parse(fs.readFileSync(previousPath,'utf8'));
    const compatible=previous.version===version && sourceFiles.filter(file=>!file.startsWith('scripts/')).every(file=>previous.sourceAssetHashes?.[file]===sourceAssetHashes[file]);
    if(!compatible){console.log('Selected scenes saved; source assets changed, so run all scenes to rebuild the tour.');return;}
    for(const name of Object.keys(metadata)) {
      if(recordings.some(recording=>recording.name===name))continue;
      const old=previous.recordings.find(recording=>recording.name===name);
      if(!old || !fs.existsSync(path.join(output,name+'.mp4')) || !fs.existsSync(path.join(output,name+'.png'))) throw new Error('Full capture required: missing '+name);
      if(old.sha256 && old.sha256!==hash(path.join(output,name+'.mp4')))throw new Error('Full capture required: existing clip changed: '+name);
      recordings.push({...old,capturedAt:old.capturedAt||previous.capturedAt,recorderSourceHashes:old.recorderSourceHashes||Object.fromEntries(Object.entries(previous.sourceAssetHashes).filter(([file])=>file.startsWith('scripts/'))),sha256:hash(path.join(output,name+'.mp4'))});
    }
  }
  const tourOrder=['getting-started','provider-switching','context-and-trust','composer-controls','agent-workflow','agent-opinions','second-opinion','brainstorm','stop-and-recovery','history-and-rewind','settings-and-help','canvas-design','visual-test','connected-tools','proactive-inbox'];
  recordings.sort((a,b)=>tourOrder.indexOf(a.name)-tourOrder.indexOf(b.name));
  const page=await browser.newPage({viewport:{width:1440,height:820},deviceScaleFactor:1});
  const logo='data:image/png;base64,'+fs.readFileSync('resources/Mysti-Logo.png').toString('base64');
  const screen='data:image/png;base64,'+fs.readFileSync(path.join(output,'agent-opinions.png')).toString('base64');
  await page.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;background:#101820;color:#f0f0e7;font-family:Arial,sans-serif;padding:64px}header{display:flex;align-items:center;gap:16px;letter-spacing:3px;font-size:18px}header img{width:52px}small{margin-left:auto;color:#a4d8c5;border:1px solid #4a665c;border-radius:30px;padding:12px 18px;font-size:13px;letter-spacing:2px}main{display:grid;grid-template-columns:1fr 1.1fr;gap:48px;align-items:center;height:560px}h1{font-size:76px;line-height:1.03;font-weight:500;letter-spacing:-4px;margin:0 0 28px}em{font-style:normal;color:#9bdfc2}p{font-size:23px;line-height:1.5;color:#b1c2c4;max-width:510px}main img{width:100%;border:1px solid #46545c;border-radius:18px;box-shadow:0 25px 100px #0008}footer{display:flex;gap:38px;border-top:1px solid #33434b;padding-top:25px;font-size:15px;letter-spacing:1px;color:#bbd0cc}</style><header><img src="${logo}">MYSTI<small>${releaseLabel}</small></header><main><div><h1>Your agents.<br><em>Working together.</em></h1><p>Assign the right work. Hear independent opinions. Keep the context in one workspace.</p></div><img src="${screen}"></main><footer><span>CLAUDE CODE + CODEX + MORE</span><span>IN YOUR VS CODE WORKSPACE</span><span>OPEN SOURCE · APACHE 2.0</span></footer></html>`);
  await page.screenshot({path:path.join(output,'hero.png')});
  await page.setViewportSize({width:1200,height:500});
  await page.setContent(`<html><style>body{margin:0;background:#101820;color:#edf4ee;font:18px Arial;padding:48px}h1{font-weight:400;font-size:32px}main{display:flex;align-items:center;gap:22px;margin-top:48px}.box{padding:28px;border:1px solid #47625b;border-radius:14px;background:#1c2c32;flex:1}.lanes{display:grid;gap:16px;flex:1.2}.lanes div{padding:18px;border-left:3px solid #89dbb8;background:#203139;border-radius:8px}small{display:block;margin-top:12px;color:#a9bfbd;line-height:1.5}.arrow{color:#9bdfc2;font-size:28px}footer{color:#a9bfbd;margin-top:34px;font-size:15px}</style><h1>Two opinions. Real assignments. Visible results.</h1><main><div class="box">Your request<small>@claude @codex<br>Review this design</small></div><span class="arrow">→</span><div class="lanes"><div>Claude Code<small>Independent, read-only opinion</small></div><div>Codex<small>Independent, read-only opinion</small></div></div><span class="arrow">→</span><div class="box">One conversation<small>Separate, attributable responses.<br>Failures stay visible.</small></div></main><footer>Explicit “then” creates a dependency. Work that may change files is serialized through permission gates.</footer></html>`);
  await page.screenshot({path:path.join(output,'routing.png')});
  await page.setViewportSize({width:1440,height:1940});
  const cards=recordings.map((recording,index)=>'<article><img src="'+asset(path.join(output,recording.name+'.png'))+'"><p><span>'+String(index+1).padStart(2,'0')+'</span> '+recording.title+'</p></article>').join('');
  await page.setContent('<html><style>*{box-sizing:border-box}body{margin:0;padding:40px;background:#101c20;color:#edf7f1;font:16px Arial}h1{font-size:34px;margin:0 0 10px;font-weight:500}header p{color:#a0bfb4;margin:0 0 26px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}article{margin:0;border:1px solid #355046;border-radius:10px;overflow:hidden;background:#17292c}article img{width:100%;display:block}article p{margin:0;padding:14px 16px;font-size:15px;line-height:1.5}article span{color:#86d9b7;margin-right:5px}</style><header><h1>Mysti · a tour of the essentials</h1><p>'+releaseLabel+' / 15 interface walkthroughs / Clearly labelled sample data</p></header><main>'+cards+'</main></html>');
  await page.screenshot({path:path.join(output,'contact-sheet.jpg'),quality:86,type:'jpeg',fullPage:true});await page.close();
  const concat=path.join(output,'.tour-inputs.txt');fs.writeFileSync(concat,recordings.map(r=>`file '${r.name}.mp4'`).join('\n'));
  const chapters=path.join(output,'.tour-chapters.txt');let elapsed=0;
  let chapterText=';FFMETADATA1\ntitle=Mysti feature tour\n';let captions='WEBVTT\n\n';
  const clock=ms=>new Date(ms).toISOString().slice(11,23);
  const chapterRows=[];
  for(const recording of recordings){
    const start=Math.round(elapsed*1000);elapsed+=recording.durationSeconds;const end=Math.round(elapsed*1000);
    chapterText+='[CHAPTER]\nTIMEBASE=1/1000\nSTART='+start+'\nEND='+end+'\ntitle='+recording.title+'\n';
    captions+=clock(start)+' --> '+clock(end)+'\n'+recording.title+'\nInterface demo · sample data\n\n';
    chapterRows.push('| '+clock(start).slice(3,8)+' | ['+recording.title+']('+recording.name+'.mp4) |');
    recording.startSeconds=start/1000;
  }
  fs.writeFileSync(chapters,chapterText);fs.writeFileSync(path.join(output,'mysti-feature-tour.vtt'),captions.trimEnd()+'\n');
  fs.writeFileSync(path.join(output,'CHAPTERS.md'),'# Mysti feature tour\n\nAll chapters use the shipped webviews with clearly labelled sample data.\n\n| Start | Scene |\n| --- | --- |\n'+chapterRows.join('\n')+'\n');
  try{execFileSync('ffmpeg',['-y','-loglevel','error','-f','concat','-safe','0','-i',concat,'-i',chapters,'-map_metadata','1','-map_chapters','1','-c','copy','-movflags','+faststart',path.join(output,'mysti-feature-tour.mp4')]);}finally{fs.unlinkSync(concat);fs.unlinkSync(chapters);}
  fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify({version,releaseLabel,capturedAt:new Date().toISOString(),sourceAssetHashes,source:'Shipped chat, Canvas, Visual Test, Connections and Proactive webviews',recordings,data:'Deterministic sample responses and evidence; no live agent or connected-account calls; HTTP(S) blocked',command:'npm run demo:record',viewport},null,2)+'\n');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
