/* Shipped browser controls, with a synthetic host only. No editor or provider launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const Module = require('node:module'), ts = require('typescript'), { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const compiledDirectory = fs.realpathSync(process.argv[2]); assert(compiledDirectory.startsWith(fs.realpathSync(root) + path.sep));
const directory = fs.mkdtempSync(path.join(root, 'helper-quality-ui-controls-'));
const read = file => JSON.parse(fs.readFileSync(file)), hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert(process.env.MYSTI_PB02_HELPER_QUALITY_PACKAGE_IDENTITY, 'Explicit package identity required');
const packageIdentity = read(path.resolve(process.env.MYSTI_PB02_HELPER_QUALITY_PACKAGE_IDENTITY));
assert.equal(hash(path.join(repo, 'media/chat/chat.js')), packageIdentity.chatSha256);
const composePath = path.join(repo, 'tests/webview/chatPageHtml.ts'), composed = new Module(composePath);
composed.filename = composePath; composed.paths = Module._nodeModulePaths(path.dirname(composePath));
composed._compile(ts.transpileModule(fs.readFileSync(composePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, composePath);
const { composeChatHtml, INITIAL_STATE } = composed.exports;
const { effortDom, assertLowEffort, selectLowEffort } = require(path.join(compiledDirectory, 'codex-profile-compatibility-explicit-effort.js'));
const { installCodexHelperQualityObserver, captureHelperQualityDom } = require(path.join(compiledDirectory, 'codex-helper-quality-observer.js'));
const priorEvents = read(path.join(root, 'resume-20261011/native-profile-compatibility/window-A/events-main.json'));
const providerManifest = priorEvents.find(value => value.type === 'initialState').payload.providerManifest;
const checks = [], identity = file => ({ path: fs.realpathSync(file), sha256: hash(file) });
let browser, page;
(async () => {
  browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1024, height: 980 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent(composeChatHtml()); await page.evaluate(installCodexHelperQualityObserver);
  const receive = (type, payload) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = () => page.evaluate(() => window.__posted);
  const events = () => page.evaluate(() => window.__pb02HelperQualityEvents);
  const panelId = 'explicit-effort-control-owner';
  await receive('initialState', { ...INITIAL_STATE, panelId, providerManifest,
    providerAvailability: Object.fromEntries(providerManifest.providers.map(provider => [provider.id, { available: true }])),
    providers: providerManifest.providers.map(provider => ({ name: provider.id, displayName: provider.displayName, defaultModel: provider.defaultModel, models: provider.models })),
    providerSettings: { customModel: 'gpt-5.6-sol', codexProfile: '' },
    settings: { ...INITIAL_STATE.settings, provider: 'openai-codex', model: 'gpt-5.6-sol', effortLevel: 'high', contextMode: 'manual', hiddenPrivateField: 'SYNTHETIC_SECRET' } });
  const before = await effortDom(page); assert.equal(before.settingsSelect, 'high'); assert.equal(before.inlineSelect, 'high'); assert.equal(before.label, 'High');
  const initial = (await events()).find(value => value.type === 'initialState'); assert.equal(initial.payload.settings.effortLevel, 'high'); assert(!JSON.stringify(initial).includes('SYNTHETIC_SECRET'));
  checks.push({ name: 'Actual High startup DOM and safe settings evidence retained before selection', status: 'PASS' });
  const offset = (await posted()).length, selected = await selectLowEffort(page);
  assertLowEffort(selected.after); assert.equal(selected.after.sliderValue, String(selected.levels.indexOf('low')));
  const updates = (await posted()).slice(offset).filter(value => value.type === 'updateSettings');
  assert.equal(updates.length, 1); assert.equal(updates[0].panelId, panelId); assert.deepEqual(updates[0].payload, { effortLevel: 'low' });
  checks.push({ name: 'Shared real composer keyboard path selects Low and emits exactly one owned public settings update', status: 'PASS' });
  await receive('modelChanged', { provider: 'openai-codex', model: 'gpt-5.6-sol', customModel: 'gpt-5.6-sol' });
  assertLowEffort(await effortDom(page)); checks.push({ name: 'Actual model acknowledgement preserves explicit Low', status: 'PASS' });
  await receive('settingsSync', { effortLevel: 'high', hiddenPrivateField: 'SYNTHETIC_SYNC_SECRET' });
  const changed = await effortDom(page); assert.equal(changed.inlineSelect, 'high'); assert.throws(() => assertLowEffort(changed));
  const sync = (await events()).filter(value => value.type === 'settingsSync'); assert.equal(sync.length, 1); assert.deepEqual(sync[0].payload, { effortLevel: 'high' });
  checks.push({ name: 'Unexpected real settings synchronization changes DOM and is rejected before any send', status: 'PASS' });
  const restored = await selectLowEffort(page); assertLowEffort(restored.after);
  for (const key of ['settingsSelect', 'inlineSelect', 'label', 'sliderValueText']) {
    const wrong = { ...restored.after, [key]: 'high' }; assert.throws(() => assertLowEffort(wrong));
  }
  checks.push({ name: 'Each mismatched selector/label/accessible effort state independently fails the Low precondition', status: 'PASS' });
  await receive('conversationChanged', { id: 'helper-owned', title: 'Initial', messages: [] });
  await page.locator('#history-btn').click();
  const rows = title => [{ id: 'helper-owned', title, provider: 'openai-codex', model: 'gpt-5.6-sol', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }];
  await receive('conversationHistory', { conversations: rows('Initial'), currentId: 'helper-owned' });
  await page.locator('.history-item[data-conversation-id="helper-owned"] .history-item-title').waitFor({state:'visible'});
  await receive('titleUpdated', { conversationId: 'helper-owned', title: 'Café مرحبا € 😀' });
  await receive('conversationHistory', { conversations: rows('Café مرحبا € 😀'), currentId: 'helper-owned' });
  await page.waitForFunction(() => (window.__pb02HelperQualityTitleObservations || []).some(value => value.conversationId === 'helper-owned' && value.title === 'Café مرحبا € 😀' && value.visible));
  const titles = await page.evaluate(() => window.__pb02HelperQualityTitleObservations);
  const update = (await events()).find(value => value.type === 'titleUpdated');
  assert(titles.some(value => value.title === update.payload.title && value.at >= update.at));
  assert((await events()).some(value => value.type === 'conversationHistory' && value.payload.conversations[0].title === 'Café مرحبا € 😀'));
  await page.locator('#history-btn').click();
  checks.push({name:'Passive visible history title joins actual titleUpdated and public history without private state',status:'PASS'});
  await receive('messageAdded', { id: 'helper-answer', role: 'assistant', content: 'Owned response long enough for cards.', timestamp: Date.now() });
  const suggestions = [{ id:'suggestion-1-0', title:'Inspect cache', description:'Owned description', message:'Owned action',icon:'💡',color:'blue' }];
  await receive('suggestionsReady', { suggestions });
  let dom = await captureHelperQualityDom(page);
  assert.deepEqual(dom.suggestions,[{title:'Inspect cache',tooltip:'Owned description',color:'blue',icon:'💡'}]);
  await receive('clearSuggestions', {}); dom = await captureHelperQualityDom(page); assert.deepEqual(dom.suggestions,[]);
  checks.push({name:'Actual suggestion cards and subsequent clear project exact visible fields',status:'PASS'});
  const options = [{id:'owned-plan-one',title:'Keep validation local',summary:'Use local checks',approach:'Local validation',pros:['Simple'],cons:['Repeated'],complexity:'low',icon:'1️⃣',color:'blue'},
    {id:'owned-plan-two',title:'Extract validation',summary:'Share checks',approach:'Shared helper',pros:['Consistent'],cons:['Indirect'],complexity:'medium',icon:'2️⃣',color:'green'}];
  await receive('planOptions', { messageId:'helper-answer',conversationId:'helper-owned',syntheticPlanId:'owned-synthetic-plan',options,originalQuery:'Owned synthetic query' });
  dom = await captureHelperQualityDom(page); assert.equal(dom.plans.length,2);
  for (const [index,card] of dom.plans.entries()) { assert.equal(card.optionId,options[index].id); assert.equal(card.messageId,'helper-answer'); for(const key of ['title','summary','complexity']) assert.equal(card[key],options[index][key]); }
  checks.push({name:'Actual plan cards expose exact unique IDs, owner message and projected labels',status:'PASS'});
  await receive('askUserQuestion', { toolCallId:'actual-delivery-uuid', source:'detected', messageId:'helper-answer', questions:[{question:'Which format?',header:'Which format?',options:[{label:'JSON',description:'Structured'},{label:'CSV',description:'Spreadsheet'}],multiSelect:false}] });
  dom = await captureHelperQualityDom(page); assert.equal(dom.questions.length,1); assert.equal(dom.questions[0].toolCallId,'actual-delivery-uuid');
  assert.deepEqual(dom.questions[0].questionTexts,['Which format?']); assert.deepEqual(dom.questions[0].optionLabels,['JSON','CSV']);
  checks.push({name:'Actual question cards preserve delivery UUID and both labels without answer or skip',status:'PASS'});
  const beforeTimers = (await events()).length;
  await receive('semiAutonomousPlanTimer', {syntheticPlanId:'owned-timer',remainingMs:100});
  await receive('semiAutonomousQuestionTimer', {toolCallId:'owned-timer',remainingMs:100});
  assert.deepEqual((await events()).slice(beforeTimers).map(value=>value.type),['semiAutonomousPlanTimer','semiAutonomousQuestionTimer']);
  checks.push({name:'Observer retains actual semi-autonomous timer events so manual scope can reject them',status:'PASS'});
  assert.deepEqual(errors, []);
  const report = { status: 'PASS', directory, compiledDirectory, checks, selected, restored,
    packageIdentity: { sha256: packageIdentity.sha256, chatSha256: packageIdentity.chatSha256 },
    sourceIdentities: [identity(composePath), identity(path.join(repo, 'media/chat/chat.js')),
      identity(path.join(compiledDirectory, 'codex-profile-compatibility-explicit-effort.js')), identity(path.join(compiledDirectory, 'codex-helper-quality-observer.js'))],
    realProviderInputs: 0, nativeEditorLaunches: 0, browserLaunches: 1, scope: 'Actual shipped renderer and shared keyboard selector with synthetic host messages only.' };
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify({ directory, status: report.status, checks: checks.length }));
})().catch(error => { fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'FAIL', checks, error: { name: error.name, message: error.message } }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1; }).finally(async () => { await page?.close(); await browser?.close(); });
