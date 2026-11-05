/* SPDX-License-Identifier: Apache-2.0
 * Additional release walkthroughs. The shipped webviews run unchanged;
 * only their extension-host boundary receives deterministic sample data.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const metadata = {
  'getting-started': { title: 'Connect an agent and choose a mode', posterMoment: 'Permission mode choices', features: ['PC-01', 'PC-02', 'AR-21'] },
  'context-and-trust': { title: 'Give the agent the right context', features: ['EW-01', 'EW-02', 'EW-05', 'AR-21'] },
  'agent-opinions': { title: 'Compare independent agent opinions', features: ['AR-01'] },
  'second-opinion': { title: 'Ask another agent for a second opinion', features: ['PC-06'] },
  'agent-workflow': { title: 'Design, then review with another agent', features: ['AR-02'] },
  'provider-switching': { title: 'Switch providers without losing your draft', features: ['PC-04', 'PC-06'] },
  'connected-tools': { title: 'Browse connected tools', features: ['CI-22'] },
  'brainstorm': { title: 'Bring two perspectives into one answer', features: ['AR-05'] },
  'composer-controls': { title: 'Choose model, reasoning effort and Ultracode', features: ['PC-04'] },
  'proactive-inbox': { title: 'Review relevant evidence before starting', features: ['CI-30', 'CI-31'] },
  'history-and-rewind': { title: 'Revisit a conversation or branch an idea', features: ['PC-08', 'PC-10', 'AR-26'], scope: 'History, fork and rewind controls; host persistence and disk rewind are not executed.' },
  'stop-and-recovery': { title: 'Stop a response and start the next turn', features: ['PC-07'], scope: 'UI cancellation request and sampled recovery; not native process-cleanup evidence.' },
  'settings-and-help': { title: 'Find settings, personas and built-in help', features: ['EW-13', 'EW-22', 'EW-25'] },
  'canvas-design': { title: 'Explore a design across themes and devices', features: ['CI-01', 'CI-04', 'CI-11', 'CI-13'], scope: 'Real Canvas app and sandbox runtime; sampled artifact and host operations. Export request only.' },
  'visual-test': { title: 'Inspect a visual test report', features: ['CI-18'], scope: 'Real dashboard with a deterministic sample screenshot and sample findings; no live agent visual test.' },
};
const posted = (page, type) => page.evaluate(type => window.__posted.filter(message => message.type === type), type);
const stamp = '2026-11-05T07:00:00.000Z';

async function recordBefore(browser, h) {
  const { record, chat, caption, fire, pause } = h;
  await record(browser, 'getting-started', async page => {
    await chat(page); await caption(page, 'Connect the tools you already use.');
    await fire(page, 'showWizard', { panelId: 'demo', npmAvailable: true, anyReady: true, mystiReady: false,
      providers: [{providerId:'claude-code',installed:true,authenticated:true}, {providerId:'openai-codex',installed:true,authenticated:true}] });
    await pause(page, 1500);
    await page.click('#wizard-found-list [data-provider="claude-code"] .provider-action-btn');
    assert.equal((await posted(page,'selectProvider')).at(-1).payload.providerId, 'claude-code');
    await fire(page,'wizardComplete',{providerId:'claude-code'});
    await pause(page,800); await page.click('#wizard-next-btn');
    await caption(page, 'Choose how much the agent may do. Start with Ask.');
    await page.check('input[name="wizard-mode"][value="plan"]'); await pause(page,1500);
    await page.check('input[name="wizard-mode"][value="ask"]'); await pause(page,1500);
    await page.locator('#setup-wizard').evaluate(el=>{el.scrollTop=0;});await pause(page,300);
    await page.screenshot({path:path.join(h.output,'getting-started.png')});page.__posterSaved=true;
    await page.click('#wizard-next-btn');
    await caption(page, 'Start with a focused task.');
    await page.fill('#wizard-task-input', 'Explain how this project handles retries, then suggest a small improvement.');
    await pause(page,1500);
    assert.equal(await page.locator('.wizard-step[data-step="task"]').isVisible(),true);
  });
  await record(browser,'context-and-trust',async page => {
    await chat(page);await caption(page,'Keep the prompt focused with files and selections.');
    await fire(page,'conversationChanged',{id:'context-review',messages:[
      {id:'context-question',role:'user',content:'What should we verify before changing the checkout retry policy?'},
      {id:'context-answer',role:'assistant',provider:'claude-code',model:'opus',content:'## Start with the contract\n\nCheck which errors are retryable, how the deadline is enforced, and what happens when a request is cancelled.\n\nAttach the implementation and its tests so the review stays grounded in your code.'}]});
    const context=[{id:'retry-file',type:'file',path:'/demo/checkout/src/retry.ts',content:'export function retry() { /* bounded retry policy */ }\n'.repeat(12),enabled:true},
      {id:'retry-tests',type:'selection',path:'/demo/checkout/tests/retry.test.ts',startLine:11,endLine:28,endCharacter:0,content:'describe("retry policy", () => { /* tests */ });\n'.repeat(7),enabled:true}];
    await fire(page,'contextUpdated',context);
    await page.fill('#message-input','Review the retry policy against these tests. Keep the total deadline bounded.');
    await fire(page,'fileAttachmentSelected',{attachments:[{id:'contract',type:'file',fileName:'api-contract.md',filePath:'/demo/checkout/api-contract.md',size:842}]});
    await pause(page,1700);
    await page.click('.context-item-toggle[data-id="retry-tests"]');
    assert.deepEqual((await posted(page,'setContextItemEnabled')).at(-1).payload,{id:'retry-tests',enabled:false});
    context[1].enabled=false;await fire(page,'contextUpdated',context);
    await caption(page,'Exclude context without losing it. Then choose your permission mode.');await pause(page,1600);
    await page.click('#behavior-indicator');await pause(page,1200);
    await page.click('#behavior-popup .mode-option[data-mode="plan"]');
    assert.equal((await posted(page,'updateSettings')).at(-1).payload.accessLevel,'read-only');
    await pause(page,1000);await page.click('#behavior-indicator');await pause(page,1200);
  });
}

async function recordAfter(browser,h) {
  const {record,chat,caption,fire,pause,state,colors,composeDemoChatHtml}=h;
  await record(browser,'history-and-rewind',async page=>{
    await chat(page);await caption(page,'Return to earlier work. Keep every conversation distinct.');
    const conversation={id:'retry-review',title:'Checkout retry review',provider:'claude-code',model:'opus',messages:[
      {id:'retry-question',role:'user',content:'Add a bounded retry policy for checkout requests.',timestamp:Date.parse(stamp),checkpoint:{commit:'sample-checkpoint'}},
      {id:'retry-answer',role:'assistant',provider:'claude-code',model:'opus',content:'## Retry policy\n\n- Retry transient failures only.\n- Cap attempts and total elapsed time.\n- Preserve the idempotency key.\n\nThe next step is to review cancellation behavior.',timestamp:Date.parse(stamp)}]};
    await fire(page,'conversationChanged',conversation);
    await page.click('#history-btn');
    await fire(page,'conversationHistory',{conversations:[{id:'retry-review',title:'Checkout retry review',updatedAt:stamp},{id:'api-design',title:'API design alternatives',updatedAt:stamp},{id:'release-plan',title:'Release readiness checklist',updatedAt:stamp}],currentId:'api-design'});
    await pause(page,1600);await page.locator('.history-item-info').first().click();
    assert.equal((await posted(page,'switchConversation')).at(-1).payload.id,'retry-review');
    await fire(page,'conversationChanged',conversation);await pause(page,1300);
    await page.locator('.message-rewind-btn').first().click();
    await caption(page,'Branch the conversation, rewind code, or do both.');await pause(page,2000);
    await page.click('#rewind-menu [data-action="fork"]');
    assert.deepEqual((await posted(page,'forkConversation')).at(-1).payload,{conversationId:'retry-review',messageId:'retry-question'});
    await fire(page,'conversationChanged',{...conversation,id:'retry-branch',title:'Retry review — alternative approach',messages:conversation.messages.slice(0,1)});
    await page.fill('#message-input','Explore a queue-based alternative while keeping the original review.');
    await caption(page,'Explore a new direction from the selected turn.');await pause(page,1300);
    await page.click('#history-btn');
    await fire(page,'conversationHistory',{conversations:[{id:'retry-branch',title:'Retry review — alternative approach',updatedAt:stamp},{id:'retry-review',title:'Checkout retry review',updatedAt:stamp}],currentId:'retry-branch'});
    await pause(page,1200);await page.locator('.history-item-info').nth(1).click();
    await fire(page,'conversationChanged',conversation);
    await caption(page,'Return to the original conversation whenever you need it.');
    await page.locator('.message-rewind-btn').first().click();await pause(page,1300);
  });
  await record(browser,'stop-and-recovery',async page=>{
    await chat(page);await caption(page,'Stay in control while a response is running.');
    const question='Review the checkout retry implementation.';
    await fire(page,'messageAdded',{id:'stop-question',role:'user',content:question,timestamp:Date.parse(stamp)});
    await fire(page,'responseStarted',{provider:'claude-code'});
    await fire(page,'responseChunk',{type:'text',content:'I will check the retry budget, idempotency and cancellation boundaries.'});
    await pause(page,1500);await page.click('#stop-btn');assert.equal((await posted(page,'cancelRequest')).length,1);
    await fire(page,'requestCancelled');await caption(page,'Stop the current response, then give a narrower instruction.');
    await pause(page,1300);await page.fill('#message-input','Focus only on cancellation and the total deadline.');await pause(page,1000);await page.click('#send-btn');
    assert.equal((await posted(page,'sendMessage')).at(-1).payload.content,'Focus only on cancellation and the total deadline.');
    await fire(page,'messageAdded',{id:'recovery-question',role:'user',content:'Focus only on cancellation and the total deadline.',timestamp:Date.parse(stamp)});
    await fire(page,'responseStarted',{provider:'claude-code'});
    const content='## Focused review\n\n1. Check the abort signal before each retry.\n2. Cancel pending backoff when the user stops.\n3. Enforce one deadline across all attempts.';
    await fire(page,'responseChunk',{type:'text',content});await pause(page,1400);
    await fire(page,'responseComplete',{message:{id:'recovery-answer',role:'assistant',provider:'claude-code',model:'opus',content,timestamp:Date.parse(stamp)}});
    assert.equal(await page.locator('#stop-btn').isVisible(),false);
  });
  await record(browser,'settings-and-help',async page=>{
    await page.setContent(composeDemoChatHtml().replace(/<body>(?=\s*<div id="app")/,'<body class="view-hub">'));
    const catalog=(kind,ids)=>ids.map(id=>{
      const text=fs.readFileSync(path.join(root,'resources/agents/core',kind,id+'.md'),'utf8');
      const field=key=>text.match(new RegExp('^'+key+': (.+)$','m'))?.[1] || '';
      return {id,name:field('name'),description:field('description'),icon:field('icon'),source:'core',trusted:true};
    });
    await page.addStyleTag({content:colors});await fire(page,'initialState',{...state,
      availablePersonas:catalog('personas',['architect','mentor','security','performance']),
      availableSkills:catalog('skills',['test-driven','secure-coding','scope-discipline'])});
    await fire(page,'hubShow',{section:'settings',chatTitle:'Checkout retry review'});
    await caption(page,'One settings hub, bound to the conversation you choose.');await pause(page,1800);
    assert.equal(await page.locator('#hub-binding').textContent(),'Configuring: Checkout retry review');
    await page.click('.hub-nav-item[data-hub-section="agents"]');await pause(page,1600);
    assert.equal(await page.locator('#agent-config-panel').isVisible(),true);
    await page.click('#persona-grid [data-persona="architect"]');await pause(page,900);
    await page.click('#skills-list [data-skill="test-driven"]');await pause(page,1400);
    assert.deepEqual((await posted(page,'updateAgentConfig')).at(-1).payload,{personaId:'architect',enabledSkills:['test-driven']});
    await chat(page);await caption(page,'Find commands and shortcuts without leaving the conversation.');
    await fire(page,'conversationChanged',{id:'help-demo',provider:'claude-code',model:'opus',messages:[{id:'help-question',role:'user',content:'How do I branch a conversation or undo a turn?'}]});
    await fire(page,'showHelp');await pause(page,1500);await page.fill('.help-card .help-search','undo');await pause(page,1500);
    assert.match(await page.locator('.help-card').textContent(),/Rewind/);
    await page.locator('.help-card').scrollIntoViewIfNeeded();await pause(page,1500);
  });
  await record(browser,'canvas-design',page=>canvasScene(page,h));
  await record(browser,'visual-test',page=>visualScene(page,h));
}

async function canvasScene(page,h) {
  const {caption,pause,colors}=h;
  const {build}=require('esbuild');
  const bundle=await build({stdin:{contents:`
    import { CanvasApp } from './src/webview/canvas/app';
    import { realEnv } from './src/webview/canvas/dom';
    export function start(boot,files){
      const env={...realEnv(),fetchText:u=>Object.hasOwn(files,u)?Promise.resolve(files[u]):Promise.reject(new Error('Missing fixture runtime'))};
      window.__posted=[];
      const app=new CanvasApp({boot,env,post:m=>window.__posted.push(m)});app.start();return app;
    }`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'iife',globalName:'MystiCanvasDemo',platform:'browser',target:'es2020',logLevel:'silent'});
  const html=fs.readFileSync(path.join(root,'media/canvas/index.html'),'utf8').replace('{{cspMeta}}','')
    .replace('<link rel="stylesheet" href="{{cssUri}}">',()=>'<style>'+fs.readFileSync(path.join(root,'media/canvas/canvas.css'),'utf8')+'</style>')
    .replace('{{boot}}','').replace(/<script[^>]*src="\{\{jsUri\}\}"[^>]*><\/script>/,'').replace(/\{\{nonce\}\}/g,'demo');
  await page.setContent(html);await page.addStyleTag({content:colors});await page.addScriptTag({content:bundle.outputFiles[0].text});
  const runtime={};for(const [id,file] of [['react','react.production.min.js'],['react-dom','react-dom.production.min.js'],['ui','ui-primitives.js'],['harness','harness.js']])runtime['runtime://'+id]=fs.readFileSync(path.join(root,'resources/canvas-sandbox',file),'utf8');
  const token='aaaaaaaabbbbbbbbccccccccdddddddd';
  const desktop={formatId:'desktop',width:1440,height:900,kind:'screen'};const mobile={formatId:'mobile',width:390,height:844,kind:'screen'};
  const base={typography:{fontFamily:'system-ui, sans-serif',scale:[12,14,16,20,24,32,48],lineHeight:1.5,weights:{regular:400,medium:500,bold:700}},spacing:{unit:4,scale:[1,2,3,4,6,8,12,16]},radii:{sm:4,md:8,lg:16,full:9999},shadows:{sm:'none',md:'none',lg:'none'}};
  const light={...base,colors:{primary:'#167d68',secondary:'#356b61',accent:'#24ad8b',background:'#f6f9f7',surface:'#ffffff',text:'#172e29',textSecondary:'#637d75',border:'#dce9e3',error:'#c54b40',success:'#17876c'}};
  const dark={...base,colors:{primary:'#77e4bf',secondary:'#55bfa6',accent:'#a0ebcf',background:'#11221f',surface:'#1b302b',text:'#effaf5',textSecondary:'#a0bcb1',border:'#34564a',error:'#f49b8e',success:'#77e4bf'}};
  const boot={viewToken:token,frameNonce:token,runtimeUris:['runtime://react','runtime://react-dom','runtime://ui'],harnessUri:'runtime://harness',babelUri:'',innerCsp:'',devices:[{...desktop,label:'Desktop'},{...mobile,label:'Mobile'}],themes:[{id:'demo-light',name:'Fresh green',theme:light},{id:'demo-dark',name:'Evening green',theme:dark}],scaffolds:[]};
  await page.evaluate(({boot,runtime})=>{window.__canvasApp=window.MystiCanvasDemo.start(boot,runtime);},{boot,runtime});
  const doc={mid:'root000000',tag:'UI.Screen',children:[{mid:'stack00001',tag:'UI.Stack',props:{gap:26,padding:48},children:[
    {mid:'label00001',tag:'UI.Text',text:'FIELDNOTES / TEAM WORKSPACE',style:{fontSize:14,letterSpacing:3}},
    {mid:'heading001',tag:'UI.Heading',text:'A calmer way to move work forward.',style:{fontSize:44}},
    {mid:'summary001',tag:'UI.Text',text:'One place for the decisions, milestones and small details that make a good launch.',style:{fontSize:19}},
    {mid:'card000001',tag:'UI.Card',props:{padding:24},children:[{mid:'cardhead01',tag:'UI.Heading',text:'Release preparation',props:{level:2}},{mid:'cardtext01',tag:'UI.Text',text:'Review the changes. Verify the essentials. Share the next version with confidence.'},{mid:'button0001',tag:'UI.Button',text:'Open checklist'}]},
    {mid:'footer0001',tag:'UI.Text',text:'DESIGN REVIEW  •  NOVEMBER 2026',style:{fontSize:13,letterSpacing:2}}
  ]}]};
  const artifact={id:'fieldnotes',version:1,kind:'screens',name:'Fieldnotes · launch workspace',format:desktop,theme:light,pages:[{id:'overview',version:1,boardPos:{x:0,y:0},actionTitle:'Overview',doc}],assets:[],updatedAt:0,approvalMode:'auto'};
  await page.evaluate(({artifact,token})=>window.postMessage({t:'canvas/hello',artifactId:artifact.id,artifact,viewToken:token,caps:[]},'*'),{artifact,token});
  await caption(page,'A live design surface, with themes and device previews.');
  await page.waitForSelector('#page-stage iframe');await pause(page,1800);
  await page.selectOption('#theme-select','demo-dark');await pause(page,700);
  const postedOps=await page.evaluate(()=>window.__posted);assert(postedOps.some(message=>JSON.stringify(message).includes('theme')));
  const sendOp=async(op,version)=>page.evaluate(({op,version})=>window.postMessage({t:'canvas/ops',records:[{opId:'demo-'+version,txnId:'demo',runId:'demo',author:'human',actorId:'demo',op,status:'applied',ts:0}],artifactVersion:version},'*'),{op,version});
  await sendOp({op:'theme.set',theme:dark},2);await pause(page,1500);
  await caption(page,'Change the device and keep the design in one workspace.');
  await page.selectOption('#device-select','mobile');await sendOp({op:'page.setMeta',pageId:'overview',patch:{format:mobile}},3);await pause(page,1300);
  assert.equal(await page.frameLocator('#page-stage iframe').first().locator('#__mysti_page').evaluate(el=>getComputedStyle(el).width),'390px');
  await page.click('#btn-zoom-fit');await pause(page,1500);
  await page.selectOption('#device-select','desktop');await sendOp({op:'page.setMeta',pageId:'overview',patch:{format:desktop}},4);await pause(page,800);await page.click('#btn-zoom-fit');await pause(page,1300);
  assert.equal(await page.frameLocator('#page-stage iframe').first().locator('#__mysti_page').evaluate(el=>getComputedStyle(el).width),'1440px');
  await page.click('#btn-export');await pause(page,1200);
  assert((await page.evaluate(()=>window.__posted)).some(message=>JSON.stringify(message).toLowerCase().includes('export')));
}

async function visualScene(page,h) {
  const {caption,pause,colors,fire}=h;
  // A local sample app supplies the screenshot. The report below is still
  // deliberately labelled sample data, not a claim of an executed agent test.
  await page.setContent('<html><body style="margin:0;background:#f5f8f6;color:#1d352d;font:18px system-ui;padding:60px"><small style="letter-spacing:3px;color:#658779">FIELDNOTES</small><h1 style="font-size:46px;max-width:550px;margin:28px 0">Make room for your next good idea.</h1><p style="color:#668278;max-width:550px;line-height:1.7">Keep decisions, milestones and project notes together.</p><button style="background:#21785f;color:white;border:0;padding:16px 24px;border-radius:8px;font:inherit;margin-top:25px">Create workspace</button></body></html>');
  const screenshot=(await page.screenshot()).toString('base64');
  let html=fs.readFileSync(path.join(root,'media/vt-dashboard/index.html'),'utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace(/<link[^>]+>/g,'').replace(/<script[\s\S]*?<\/script>/g,'');
  await page.setContent(html);await page.addStyleTag({content:fs.readFileSync(path.join(root,'media/vt-dashboard/vt-dashboard.css'),'utf8')+colors});
  await page.evaluate(()=>{window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:message=>window.__posted.push(message)});});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'media/vt-dashboard/vt-dashboard.js'),'utf8')});
  await caption(page,'Describe what to check in the Visual Test dashboard.');
  await page.fill('#cfg-url','http://localhost:3000');await page.fill('#cfg-requirements','Check the landing page on desktop. Confirm the primary action is visible and inspect layout overflow.');
  await page.fill('#cfg-max-iter','2');await page.uncheck('#cfg-interactions');await pause(page,1700);
  await page.click('#vt-start');assert.equal((await posted(page,'dashboardStartVisualTest')).length,1);
  await fire(page,'visualTestDashboardUpdate',{type:'visual_test_started',message:'Inspecting sample landing page'});await pause(page,900);
  await fire(page,'visualTestDashboardUpdate',{type:'visual_test_screenshot',screenshot:{base64Data:screenshot,iteration:1}});
  await pause(page,1400);await fire(page,'visualTestDashboardUpdate',{type:'visual_test_issue',issue:{severity:'minor',description:'Sample finding: secondary text needs a contrast review.'}});
  await fire(page,'visualTestDashboardUpdate',{type:'visual_test_iteration',iteration:{number:1,issues:[{}],duration:3000}});
  await fire(page,'visualTestDashboardUpdate',{type:'visual_test_complete',report:{summary:{verdict:'partial',totalIterations:1,maxIterations:2,totalIssuesFound:1,totalIssuesFixed:0,totalDuration:3000}}});
  await caption(page,'Review the screenshot, findings and outcome together.');await pause(page,1700);
  assert.equal(await page.locator('#vt-verdict').textContent(),'PARTIAL');
}

module.exports={metadata,recordBefore,recordAfter};
