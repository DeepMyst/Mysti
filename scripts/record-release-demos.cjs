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
const output = path.join(root, 'docs/releases/2.0-beta');
fs.mkdirSync(output, { recursive: true });
const fixtureFile = path.join(root, 'tests/webview/chatPageHtml.ts');
const fixture = new Module(fixtureFile, module);
fixture.filename = fixtureFile; fixture.paths = module.paths;
fixture._compile(ts.transpileModule(fs.readFileSync(fixtureFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, fixtureFile);
const { composeChatHtml, INITIAL_STATE } = fixture.exports;
const colors = `:root{--vscode-editor-background:#141b22;--vscode-sideBar-background:#141b22;--vscode-foreground:#e4eae9;--vscode-descriptionForeground:#96aaa9;--vscode-panel-border:#33434d;--vscode-font-family:Arial,sans-serif;--vscode-font-size:14px;--vscode-focusBorder:#71dfbc;--vscode-textLink-foreground:#71dfbc;--vscode-button-background:#266c63;--vscode-button-foreground:#fff;--vscode-input-background:#24303a;--vscode-input-foreground:#e4eae9;--vscode-input-border:#3b505b;--vscode-errorForeground:#f6a892;--vscode-list-hoverBackground:#243b43;--vscode-list-activeSelectionBackground:#254b51}body{font-family:Arial,sans-serif;background:#141b22;color:#e4eae9}#release-caption{position:fixed;top:0;left:0;right:0;padding:12px 24px;background:#22343c;color:#a9e8d2;font:12px Arial,sans-serif;z-index:99999;letter-spacing:.05em;border-bottom:1px solid #43605c;box-sizing:border-box;width:100%;white-space:nowrap;overflow:hidden;text-align:left}body{padding-top:40px!important;box-sizing:border-box}`;
const providers = [
  { id: 'claude-code', displayName: 'Claude Code', shortId: 'claude', color: '#e6aa86', models: [{ id: 'opus', name: 'Opus', description: 'Complex coding and reasoning' }], capabilities: { supportsUltracode: true, effortLevels: ['low','medium','high','xhigh','max'], effortDefault: 'high' } },
  { id: 'openai-codex', displayName: 'Codex', shortId: 'codex', color: '#7fe3c0', models: [{ id: 'codex', name: 'Codex', description: 'Coding and review' }], capabilities: { effortLevels: ['low','medium','high','xhigh'] } },
];
const state = { ...INITIAL_STATE, settings: { ...INITIAL_STATE.settings, model: 'opus' },
  providers: providers.map(p => ({ name: p.id, displayName: p.displayName, models: p.models })),
  providerManifest: { schemaVersion: 1, providers },
};
const fire = (page, type, payload) => page.evaluate(m => window.dispatchEvent(new MessageEvent('message', {data:m})), {type,payload});
const pause = (page, ms = 700) => page.waitForTimeout(ms);
async function caption(page, text) {
  await page.evaluate(text => { let el=document.getElementById('release-caption'); if(!el){el=document.createElement('div');el.id='release-caption';document.body.appendChild(el);}el.textContent=text; }, 'MYSTI 2.0 BETA  /  ' + text + '  /  INTERFACE DEMO · SAMPLE DATA');
}
const asset = (file, mime='image/png') => 'data:'+mime+';base64,'+fs.readFileSync(file).toString('base64');
async function chat(page) {
  const html=composeChatHtml().replace(/src="\/([^"]+)"/g, (match, relative) => {
    const file=path.join('resources',relative);
    if (!/\.(png|svg|webp|jpg|gif)$/i.test(file) || !fs.existsSync(file)) return match;
    const ext=path.extname(file).slice(1);
    return 'src="'+asset(file,ext==='svg'?'image/svg+xml':'image/'+ext)+'"';
  }).replace(/window\.__MYSTI_BOOT__ = (.*?);/, (_match, json) => {
    const boot=JSON.parse(json);boot.version='2.0.0';boot.logoUri=asset('resources/Mysti-Logo.png');
    for(const name of fs.readdirSync('resources/icons').filter(n=>n.endsWith('.png'))) {
      boot.iconUris[name.slice(0,-4)]=asset('resources/icons/'+name);
    }
    boot.claudeLogoUri=asset('resources/icons/Claude.png');
    boot.openaiLogoLightUri=asset('resources/icons/openai.svg','image/svg+xml');
    boot.openaiLogoDarkUri=boot.openaiLogoLightUri;
    return 'window.__MYSTI_BOOT__ = '+JSON.stringify(boot)+';';
  });
  await page.setContent(html); await page.addStyleTag({content:colors}); await fire(page,'initialState',state);
}
async function record(browser, name, action) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'mysti-demo-'));
  const context = await browser.newContext({viewport:{width:1000,height:760},recordVideo:{dir:scratch,size:{width:1000,height:760}}});
  const page = await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const video = page.video();
  try { await action(page); await pause(page,1500); const broken=await page.evaluate(()=>Array.from(document.images).filter(img=>img.getBoundingClientRect().width>0 && img.getBoundingClientRect().height>0 && !img.naturalWidth).map(img=>img.getAttribute('src'))); if(broken.length) throw new Error('Visible images failed to load: '+JSON.stringify(broken)); await page.screenshot({path:path.join(output,name+'.png')}); }
  finally { await context.close(); }
  if(errors.length) throw new Error(errors.join('\n'));
  const source=await video.path();
  execFileSync('ffmpeg',['-y','-loglevel','error','-i',source,'-vf','fps=10,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer','-loop','0',path.join(output,name+'.gif')]);
  execFileSync('ffmpeg',['-y','-loglevel','error','-i',source,'-an','-c:v','libx264','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart',path.join(output,name+'.mp4')]);
  fs.rmSync(scratch,{recursive:true,force:true});
  console.log('Recorded '+name);
}
(async()=>{
 const browser=await chromium.launch();
 try {
  await record(browser,'agent-opinions',async page=>{
   await chat(page); await caption(page,'Two agents. Two independent opinions.');
   await page.fill('#message-input','@claude @codex What are your opinions on adding a cache to this API?'); await pause(page,1200);
   await fire(page,'messageAdded',{id:'demo-user',role:'user',content:'@claude @codex What are your opinions on adding a cache to this API?',timestamp:Date.now()});
   await page.fill('#message-input',''); await fire(page,'responseStarted',{provider:'mysti',participants:['claude-code','openai-codex']});
   await fire(page,'collaborationStarted',{runId:'demo-opinions',collaborators:providers.map(p=>({agentId:p.id}))});
   const event=async(id,type,extra={})=>fire(page,'collaborator',{runId:'demo-opinions',collaboratorId:id,agentId:id,label:providers.find(p=>p.id===id).displayName,type,...extra});
   await event('claude-code','collab_started'); await event('openai-codex','collab_started'); await pause(page,1400);
   await event('claude-code','collab_text',{content:'**Start with the consistency contract.**\n\nA cache is useful if brief staleness is acceptable. Define invalidation and tenant isolation before choosing a store.'}); await pause(page,900);
   await event('openai-codex','collab_text',{content:'**Measure the slow path first.**\n\nCheck repeated reads and p95 latency. I would prototype a bounded TTL cache, then compare hit rate and latency under load.'}); await pause(page,900);
   await event('claude-code','collab_complete'); await event('openai-codex','collab_complete'); await fire(page,'collaborationComplete',{runId:'demo-opinions'});await pause(page,1000);
   await fire(page,'responseChunk',{type:'text',content:'## Claude Code\n\nDefine consistency and invalidation before choosing a store.\n\n## Codex\n\nMeasure the slow path, then compare a bounded TTL cache under load.'});
   await fire(page,'responseComplete',{message:{id:'demo-results',role:'assistant',participants:['claude-code','openai-codex'],content:'## Claude Code\n\nDefine consistency and invalidation before choosing a store.\n\n## Codex\n\nMeasure the slow path, then compare a bounded TTL cache under load.',timestamp:Date.now()}});await pause(page,800);
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
  const page=await browser.newPage({viewport:{width:1440,height:820},deviceScaleFactor:1});
  const logo='data:image/png;base64,'+fs.readFileSync('resources/Mysti-Logo.png').toString('base64');
  const screen='data:image/png;base64,'+fs.readFileSync(path.join(output,'agent-opinions.png')).toString('base64');
  await page.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;background:#101820;color:#f0f0e7;font-family:Arial,sans-serif;padding:64px}header{display:flex;align-items:center;gap:16px;letter-spacing:3px;font-size:18px}header img{width:52px}small{margin-left:auto;color:#a4d8c5;border:1px solid #4a665c;border-radius:30px;padding:12px 18px;font-size:13px;letter-spacing:2px}main{display:grid;grid-template-columns:1fr 1.1fr;gap:48px;align-items:center;height:560px}h1{font-size:76px;line-height:1.03;font-weight:500;letter-spacing:-4px;margin:0 0 28px}em{font-style:normal;color:#9bdfc2}p{font-size:23px;line-height:1.5;color:#b1c2c4;max-width:510px}main img{width:100%;border:1px solid #46545c;border-radius:18px;box-shadow:0 25px 100px #0008}footer{display:flex;gap:38px;border-top:1px solid #33434b;padding-top:25px;font-size:15px;letter-spacing:1px;color:#bbd0cc}</style><header><img src="${logo}">MYSTI<small>2.0 BETA</small></header><main><div><h1>Your agents.<br><em>Working together.</em></h1><p>Assign the right work. Hear independent opinions. Keep the context in one workspace.</p></div><img src="${screen}"></main><footer><span>CLAUDE CODE + CODEX + MORE</span><span>IN YOUR VS CODE WORKSPACE</span><span>OPEN SOURCE · APACHE 2.0</span></footer></html>`);
  await page.screenshot({path:path.join(output,'hero.png')});
  await page.setViewportSize({width:1200,height:500});
  await page.setContent(`<html><style>body{margin:0;background:#101820;color:#edf4ee;font:18px Arial;padding:48px}h1{font-weight:400;font-size:32px}main{display:flex;align-items:center;gap:22px;margin-top:48px}.box{padding:28px;border:1px solid #47625b;border-radius:14px;background:#1c2c32;flex:1}.lanes{display:grid;gap:16px;flex:1.2}.lanes div{padding:18px;border-left:3px solid #89dbb8;background:#203139;border-radius:8px}small{display:block;margin-top:12px;color:#a9bfbd;line-height:1.5}.arrow{color:#9bdfc2;font-size:28px}footer{color:#a9bfbd;margin-top:34px;font-size:15px}</style><h1>Two opinions. Real assignments. Visible results.</h1><main><div class="box">Your request<small>@claude @codex<br>Review this design</small></div><span class="arrow">→</span><div class="lanes"><div>Claude Code<small>Independent, read-only opinion</small></div><div>Codex<small>Independent, read-only opinion</small></div></div><span class="arrow">→</span><div class="box">One conversation<small>Separate, attributable responses.<br>Failures stay visible.</small></div></main><footer>Explicit “then” creates a dependency. Work that may change files is serialized through permission gates.</footer></html>`);
  await page.screenshot({path:path.join(output,'routing.png')});await page.close();
  const concat=path.join(output,'.tour-inputs.txt');fs.writeFileSync(concat,['agent-opinions','composer-controls','proactive-inbox'].map(n=>`file '${n}.mp4'`).join('\n'));
  try{execFileSync('ffmpeg',['-y','-loglevel','error','-f','concat','-safe','0','-i',concat,'-c','copy','-movflags','+faststart',path.join(output,'mysti-2-beta-tour.mp4')]);}finally{fs.unlinkSync(concat);}
  fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify({version:'2.0.0',capturedAt:new Date().toISOString(),source:'Shipped chat and Proactive webviews',data:'Deterministic sample responses and evidence; no live agent or connected-account calls',command:'npm run demo:record',viewport:{width:1000,height:760}},null,2)+'\n');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
