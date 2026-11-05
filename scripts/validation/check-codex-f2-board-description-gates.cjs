/* Pure F04 gate-record controls. Retained qualification bodies are projected into
 * an explicitly synthetic owned record envelope; no application or native launch. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const c=require('./codex-f2-board-description-campaign.cjs'),g=require('./codex-f2-board-description-gates.cjs');
const compact=require('./codex-f2-compact-store.cjs');
const repo=path.resolve(__dirname,'../..'),root=path.join(repo,'out-test/feature-tests/PB-02'),base=path.join(root,'overnight-20261011'),local=path.join(base,'f04-board-description-validation');
const directory=fs.mkdtempSync(path.join(root,'f2-board-description-gate-controls-'));
const read=file=>compact.readJson(file),clone=value=>structuredClone(value),checks=[];
const check=(name,fn)=>{try{fn();checks.push({name,status:'PASS'});}catch(error){checks.push({name,status:'FAIL',error:error.stack});}};
const negative=(name,original,mutate,validate)=>check(name,()=>{const changed=clone(original);mutate(changed);assert.throws(()=>validate(changed));});
const retainedNames=['correct-artifact/result.json','absent-artifact/result.json','ui-layout-artifact/result.json','regressions/api/result.json','regressions/frontend.json','regressions/f05/result.json','ui-layout-execution.json','migration-existing-row-review.json'];
const retained=Object.fromEntries(retainedNames.map(name=>[name,{pin:c.identity(path.join(local,name)),value:read(path.join(local,name))}]));
const runtime=path.join(directory,'runtime'),workspace=path.join(directory,'workspace');fs.mkdirSync(runtime);fs.mkdirSync(workspace);
const ports={postgres:62001,http:62002,webhook:62003,smtp:62004};
const owner={purpose:'PB02-F2-owned-postgresql',runtimePath:runtime,dataDirectory:path.join(runtime,'postgres-data'),database:'f2_baseline',user:'f2_fixture',ports};
for(const[name,value]of Object.entries({'database-owner.json':owner,'ports.json':ports}))fs.writeFileSync(path.join(runtime,name),JSON.stringify(value),{flag:'wx'});
const runtimeIdentity={owner:c.identity(path.join(runtime,'database-owner.json')),ports:c.identity(path.join(runtime,'ports.json'))};
const checkpoint=c.pinned(c.PRIOR_NATIVE_CHECKPOINT),prior=c.pinned(checkpoint.campaign);
const seedRoot=path.join(base,'f2-workload-preparation'),fixture={...clone(prior.fixture),workspace,
 files:Object.fromEntries(Object.entries(checkpoint.sourceSnapshot.hashes).map(([name,sha256])=>[name,{sha256}])),
 repairs:c.buildRepairs(path.join(seedRoot,'contracts/case-contracts.json'),path.join(base,'f2-adapted-baseline/workspace'),path.join(seedRoot,'seeded-workspace'),checkpoint.workspace)};
const campaign={stage:c.STAGE,directory,workspace,fixture,evidenceDirectory:path.join(directory,'evidence')};
const project=original=>({...clone(original),workspace,runtime,runtimeOwnerSha256:runtimeIdentity.owner.sha256});
const api=project(retained['correct-artifact/result.json'].value),ui=project(retained['ui-layout-artifact/result.json'].value),regression=project(retained['regressions/api/result.json'].value);
const frontend={...clone(retained['regressions/frontend.json'].value),workspace},f05=project(retained['regressions/f05/result.json'].value);
check('qualified gate/controller dependencies have exact current pins',()=>{const d=g.dependencies();assert(d.pins.length>0);assert.equal(new Set(d.pins.map(pin=>pin.path)).size,d.pins.length);});
check('retained positive API assertions admitted in synthetic owned envelope',()=>g.assertF04Api(api,campaign,false));
negative('wrong API workspace rejected',api,r=>r.workspace='/foreign',r=>g.assertF04Api(r,campaign,false));
negative('wrong API runtime rejected',api,r=>r.runtime=local,r=>g.assertF04Api(r,campaign,false));
negative('wrong runtime owner hash rejected',api,r=>r.runtimeOwnerSha256='0'.repeat(64),r=>g.assertF04Api(r,campaign,false));
negative('missing source identity inventory rejected',api,r=>r.sourceHashes={},r=>g.assertF04Api(r,campaign,false));
negative('changed preserved F05 helper hash rejected',api,r=>r.sourceHashes['server/api/helpers/utils/send-webhooks.js']='0'.repeat(64),r=>g.assertF04Api(r,campaign,false));
negative('wrong API oracle rejected',api,r=>r.oracleSha256='0'.repeat(64),r=>g.assertF04Api(r,campaign,false));
negative('premature app signal rejected',api,r=>r.process.exit={code:null,signal:'SIGTERM'},r=>g.assertF04Api(r,campaign,false));
negative('not-ready app rejected',api,r=>r.readiness.status='NOT_READY',r=>g.assertF04Api(r,campaign,false));
negative('missing description schema rejected',api,r=>r.schemaBeforeCase=r.schemaBeforeCase.filter(x=>x!=='description'),r=>g.assertF04Api(r,campaign,false));
const absent=project(retained['absent-artifact/result.json'].value);
check('old absence oracle identity is not silently promoted',()=>assert.throws(()=>g.assertF04Api(absent,campaign,true)));
absent.oracleSha256=c.identity(g.ORACLES.api).sha256;
check('synthetic current-oracle absence projection admits exact retained assertion',()=>g.assertF04Api(absent,campaign,true));
negative('unrelated API failure cannot establish absence',absent,r=>r.cases[0].error='unrelated timeout',r=>g.assertF04Api(r,campaign,true));
negative('existing description column contradicts absence',absent,r=>r.schemaBeforeCase.push('description'),r=>g.assertF04Api(r,campaign,true));
negative('foreign baseline case rejected',absent,r=>r.cases[0].id='F2-F01',r=>g.assertF04Api(r,campaign,true));
check('retained actual UI and measured layout assertions admitted',()=>g.assertUI(ui,campaign));
negative('UI overlap rejected',ui,r=>r.layoutChecks[0].overlap=true,r=>g.assertUI(r,campaign));
negative('low contrast rejected',ui,r=>r.layoutChecks[0].contrast=4.49,r=>g.assertUI(r,campaign));
negative('forged nonoverlap claim fails actual box geometry',ui,r=>r.layoutChecks[0].descriptionBox.y=r.layoutChecks[0].settingsBox.y,r=>g.assertUI(r,campaign));
negative('browser exception rejected',ui,r=>r.browserErrors.push('actual error'),r=>g.assertUI(r,campaign));
negative('missing authenticated positive control rejected',ui,r=>r.positiveUIControls=[],r=>g.assertUI(r,campaign));
check('retained twelve bugs plus six raw F05 receipts admitted',()=>assert.equal(g.assertRegressions(regression,frontend,f05,campaign).length,12));
negative('frontend source omissions rejected',frontend,r=>r.sourceHashes={},r=>g.assertRegressions(regression,r,f05,campaign));
negative('duplicate frontend case cannot substitute for all12',frontend,r=>r.cases[1]=clone(r.cases[0]),r=>g.assertRegressions(regression,r,f05,campaign));
negative('failed preserved bug rejected',regression,r=>r.cases[0].status='FAIL',r=>g.assertRegressions(r,frontend,f05,campaign));
negative('missing signed webhook raw receipt rejected',f05,r=>r.events.pop(),r=>g.assertRegressions(regression,frontend,r,campaign));
negative('forced receiver cleanup rejected',f05,r=>r.receiver.cleanup.forcedConnections=true,r=>g.assertRegressions(regression,frontend,r,campaign));
const priorRow=retained['migration-existing-row-review.json'].value.row;
const before={kind:'BEFORE_F04_MIGRATION',runtimeIdentity,database:{name:'f2_baseline',user:'f2_fixture',postmasterStartedAt:'2026-10-11T21:00:00.000Z',port:ports.postgres},descriptionColumnAbsent:true,
 row:{id:priorRow.id,project_id:priorRow.project_id,name:priorRow.name},creationReceipt:clone(absent.boardReceipts[0])};
assert.equal(before.creationReceipt.response.item.id,priorRow.id);
const after={kind:'AFTER_F04_MIGRATION',runtimeIdentity,database:clone(before.database),descriptionColumnAbsent:false,row:clone(priorRow),beforeRecordSha256:c.hash(JSON.stringify(before))};
const migration={before,after,runtimeIdentity};
check('exact retained premigration row survives with null description',()=>g.assertMigrationRecords(before,after,runtimeIdentity));
for(const[field,value]of [['id','foreign-row'],['project_id','foreign-project'],['name','renamed'],['description','non-null']])negative('migration changed '+field+' rejected',migration,r=>r.after.row[field]=value,r=>g.assertMigrationRecords(r.before,r.after,r.runtimeIdentity));
negative('different database restart rejected',migration,r=>r.after.database.postmasterStartedAt='2026-10-11T21:01:00Z',r=>g.assertMigrationRecords(r.before,r.after,r.runtimeIdentity));
negative('foreign runtime rejected',migration,r=>r.after.runtimeIdentity.owner.sha256='0'.repeat(64),r=>g.assertMigrationRecords(r.before,r.after,r.runtimeIdentity));
negative('column already existed before migration rejected',migration,r=>r.before.descriptionColumnAbsent=false,r=>g.assertMigrationRecords(r.before,r.after,r.runtimeIdentity));
negative('forged original receipt row rejected',migration,r=>r.before.creationReceipt.response.item.id='foreign',r=>g.assertMigrationRecords(r.before,r.after,r.runtimeIdentity));
negative('wrong original board route rejected',migration,r=>r.before.creationReceipt.url='/api/projects/foreign/boards',r=>g.assertMigrationRecords(r.before,r.after,r.runtimeIdentity));
negative('wrong before-record digest rejected',migration,r=>r.after.beforeRecordSha256='0'.repeat(64),r=>g.assertMigrationRecords(r.before,r.after,r.runtimeIdentity));
const panelIds=['panel_control'],wanted=c.expectedSnapshotHashes(fixture,c.SELECTED);
const buildSnapshot={files:[{relative:'index.html',path:path.join(workspace,'client/build/index.html'),sha256:c.hash('synthetic build'),bytes:15}]};
const requestBoundary={files:{assetLinks:[]},buildSnapshot};
const captured={schemaVersion:1,purpose:'PB02_F05_SOURCE_RUNTIME_SCOPE',workspace,runtime,panelIds,runtimeIdentity,
 source:{files:{...Object.fromEntries(Object.entries(wanted).map(([name,sha256])=>[name,{kind:'file',sha256}])),'client/build/index.html':{kind:'file',sha256:buildSnapshot.files[0].sha256}},directories:['.git','client','client/build','server']},
 dependencyTrees:[{relative:'node_modules',files:3,treeSha256:c.hash('synthetic deps')},{relative:'client/node_modules',files:4,treeSha256:c.hash('synthetic client deps')},{relative:'server/node_modules',files:5,treeSha256:c.hash('synthetic server deps')}],captureTemporaryFiles:{}};
const initialScope=clone(captured),controller=g.dependencies().runner;
function record(name,kind='validation'){
 const spec=g.invocationSpec(campaign,kind,name),scopeRecord=clone(captured);
 if(kind==='checkpoint')scopeRecord.source.files=Object.fromEntries(Object.entries(c.expectedSnapshotHashes(fixture,[])).map(([name,sha256])=>[name,{kind:'file',sha256}]));
 if(kind==='checkpoint')scopeRecord.source.files['client/build/index.html']={kind:'file',sha256:buildSnapshot.files[0].sha256};
 if(name==='ui')for(const[relative,target]of Object.entries(c.ASSET_LINKS))scopeRecord.source.files[relative]={kind:'owned-asset-link',target:path.relative(path.dirname(path.join(workspace,relative)),path.join(workspace,target))};
 const execution=clone(retained['ui-layout-execution.json'].value);execution.command=spec.command;execution.cwd=repo;execution.deadlineMs=spec.deadlineMs;
 execution.exitCode=spec.expectedExit;execution.terminal.code=spec.expectedExit;execution.closed.code=spec.expectedExit;
 const row={name,command:spec.command,execution:{path:spec.executionFile,sha256:'a'.repeat(64)},report:{path:spec.reportFile,sha256:'b'.repeat(64)},scope:{path:spec.scopeFile,sha256:'c'.repeat(64)},
 sourceBoundaryAfter:{sourceFiles:Object.keys(scopeRecord.source.files).length,sourceSha256:c.hash(JSON.stringify(scopeRecord.source)),indexSha256:fixture.indexSha256,
 documentationSha256:scopeRecord.source.files['server/.env.sample'].sha256,dependencyFiles:12,panelIds,temporaryFiles:{}}};
 return{campaign,kind,row,captured:scopeRecord,execution,requestBoundary,panelIds,initialScope:kind==='checkpoint'?clone(scopeRecord):clone(initialScope),startedAt:Date.parse(execution.startedAt)-1,endedAt:Date.parse(execution.finishedAt)+1};
}
const validate=value=>g.assertInvocationRecords({...value,runner:controller});
for(const kind of ['checkpoint','validation','restored'])for(const name of kind==='checkpoint'?['api','regressions','frontend','f05']:['api','regressions','frontend','f05','ui'])check('exact '+kind+' '+name+' invocation and scope joined',()=>validate(record(name,kind)));
const invocation=record('api');
for(const[index,value]of [[0,'/foreign/node'],[1,'/foreign/oracle'],[2,'/foreign/workspace'],[3,'wrong-label'],[4,'/foreign/output'],[5,'/foreign/runtime'],[6,'F2-F01']])negative('changed jointly encoded command argv'+index+' rejected',invocation,r=>{r.row.command[index]=value;r.execution.command[index]=value;},validate);
negative('extra jointly encoded CLI argument rejected',invocation,r=>{r.row.command.push('extra');r.execution.command.push('extra');},validate);
for(const key of ['execution','report','scope'])negative('foreign '+key+' artifact path rejected',invocation,r=>r.row[key].path=path.join(directory,'foreign-'+key+'.json'),validate);
negative('missing original captured file rejected',invocation,r=>delete r.captured.source.files['server/.env.sample'],validate);
negative('additional captured source file rejected',invocation,r=>r.captured.source.files['foreign.txt']={kind:'file',sha256:'0'.repeat(64)},validate);
negative('changed original source rejected',invocation,r=>r.captured.source.files['server/.env.sample'].sha256='0'.repeat(64),validate);
negative('foreign build output path rejected',invocation,r=>r.requestBoundary.buildSnapshot.files[0].path='/foreign/index.html',validate);
negative('foreign panel history scope rejected',invocation,r=>r.captured.panelIds=['panel_foreign'],validate);
negative('changed dependency digest rejected',invocation,r=>r.captured.dependencyTrees[0].treeSha256='0'.repeat(64),validate);
negative('changed scope directory inventory rejected',invocation,r=>r.captured.source.directories.push('foreign-dir'),validate);
negative('wrong scope schema rejected',invocation,r=>r.captured.schemaVersion=2,validate);
negative('wrong scope purpose rejected',invocation,r=>r.captured.purpose='foreign',validate);
for(const key of ['sourceFiles','sourceSha256','indexSha256','documentationSha256','dependencyFiles'])negative('forged post-scope '+key+' rejected',invocation,r=>r.row.sourceBoundaryAfter[key]=typeof r.row.sourceBoundaryAfter[key]==='number'?0:'0'.repeat(64),validate);
negative('stale execution rejected',invocation,r=>r.startedAt=Date.parse(r.execution.startedAt)+1,validate);
negative('execution exceeding review interval rejected',invocation,r=>r.endedAt=Date.parse(r.execution.finishedAt)-1,validate);
negative('wrong deadline rejected',invocation,r=>r.execution.deadlineMs=999999,validate);
negative('timeout cannot become success',invocation,r=>r.execution.timedOut=true,validate);
negative('nonzero positive invocation rejected',invocation,r=>{r.execution.exitCode=1;r.execution.terminal.code=1;r.execution.closed.code=1;},validate);
negative('invocation signals rejected',invocation,r=>r.execution.signals.push({signal:'SIGTERM'}),validate);
negative('unapproved asset link rejected',invocation,r=>r.captured.source.files['server/public/foreign']={kind:'owned-asset-link',target:'../../../foreign'},validate);
negative('UI link targets must remain exact owned build',record('ui'),r=>r.captured.source.files['server/views/index.ejs'].target='../../../foreign',validate);
check('final gate cannot invent fresh invocation',()=>assert.throws(()=>g.invocationSpec(campaign,'final','api')));
check('checkpoint cannot run missing-feature UI',()=>assert.throws(()=>g.invocationSpec(campaign,'checkpoint','ui')));
check('unknown oracle rejected',()=>assert.throws(()=>g.invocationSpec(campaign,'validation','unknown')));
check('retained qualification files remain unchanged',()=>{for(const record of Object.values(retained))assert.deepEqual(c.identity(record.pin.path),record.pin);});
const report={status:checks.every(row=>row.status==='PASS')?'PASS_PURE_F04_GATE_CONTROLS':'FAIL',at:new Date().toISOString(),node:c.identity(process.execPath),gate:c.identity(require.resolve('./codex-f2-board-description-gates.cjs')),checker:c.identity(__filename),
 retained:Object.values(retained).map(record=>record.pin),syntheticRuntimeIdentity:runtimeIdentity,checks,appsLaunched:0,postgresLaunched:0,modelsLaunched:0,nativeInputs:0,
 limitations:['Retained functional bodies are projected into explicitly synthetic workspace/runtime envelopes. They do not establish a new application result.','Full executeGate/verifyGate native waiting-state integration is not launched. Controls cover exported assertions, exact command/artifact/scope admission and failure rejection.','No existing qualification or native tree is modified; synthetic controller records do not establish real new process exits.']};
const output=path.join(directory,'checks.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({report:c.identity(output),status:report.status,passed:checks.filter(row=>row.status==='PASS').length,total:checks.length,failures:checks.filter(row=>row.status!=='PASS')}));
if(report.status==='FAIL')process.exitCode=1;
