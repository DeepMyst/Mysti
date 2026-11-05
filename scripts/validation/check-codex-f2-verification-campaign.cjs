'use strict';
const fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict');const c=require('./codex-f2-verification-campaign.cjs');
const repo=path.resolve(__dirname,'../..'),root=path.join(repo,'out-test/feature-tests/PB-02'),out=fs.mkdtempSync(path.join(root,'f2-verification-campaign-controls-')),checks=[];
function test(name,fn){try{fn();checks.push({name,status:'PASS'});}catch(error){checks.push({name,status:'FAIL',error:error.stack});}}
const b=path.join(root,'overnight-20261011'),catalog=JSON.parse(fs.readFileSync(c.CASE_CONTRACT.path)),cases=catalog.cases.filter(x=>x.kind==='seeded-bug');const paths=[...new Set(cases.map(x=>x.mutation.path))];const dirs=['baseline','seed','prior'].map(x=>path.join(out,x));dirs.forEach(x=>fs.mkdirSync(x));
const origins=[path.join(b,'f2-adapted-baseline/workspace'),path.join(b,'f2-workload-preparation/seeded-workspace'),path.join(b,'native-f2-final-pair-session/workspace')];for(let i=0;i<3;i++)for(const rel of paths){const p=path.join(dirs[i],rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.copyFileSync(path.join(origins[i],rel),p,fs.constants.COPYFILE_EXCL);}
const make=()=>c.buildRepairs(c.CASE_CONTRACT.path,...dirs),fixture={workspace:dirs[2],repairs:{},files:Object.fromEntries(paths.map(rel=>[rel,{sha256:c.identity(path.join(dirs[2],rel)).sha256}]))};
function changed(file,fn){const original=fs.readFileSync(file);try{fs.writeFileSync(file,Buffer.concat([original,Buffer.from('\n// unexpected mutation\n')]));fn();}finally{fs.writeFileSync(file,original);}}
test('All12 exact applied bytes verified against reconstructed original seed',()=>a.deepEqual(make(),{}));
test('Prior frontend mutation rejects instead of reapplying repairs',()=>changed(path.join(dirs[2],'client/src/models/List.js'),()=>a.throws(make)));
test('Prior backend mutation rejects instead of reapplying repairs',()=>changed(path.join(dirs[2],'server/api/helpers/utils/send-webhooks.js'),()=>a.throws(make)));
test('Changed original seed rejects',()=>changed(path.join(dirs[1],'client/src/models/List.js'),()=>a.throws(make)));
test('Changed baseline rejects',()=>changed(path.join(dirs[0],'client/src/models/List.js'),()=>a.throws(make)));
test('Existing all12 baseline accepts no repairs object',()=>{c.checkedRepairs(fixture);a.deepEqual(c.expectedSnapshotHashes(fixture),Object.fromEntries(paths.map(rel=>[rel,fixture.files[rel].sha256])));});
test('Fixture cannot smuggle a new repair',()=>a.throws(()=>c.checkedRepairs({...fixture,repairs:{'F2-B10':{}}})));
test('Recorded source hash cannot drop an applied correction',()=>{const f=JSON.parse(JSON.stringify(fixture));f.files['client/src/models/List.js'].sha256='0'.repeat(64);a.throws(()=>c.checkedRepairs(f));});
test('No selected or completed repair IDs exist',()=>{a.deepEqual(c.SELECTED,[]);a.throws(()=>c.expectedSnapshotHashes(fixture,['F2-B10']));});
test('Every old and new native patch purpose is refused',()=>{for(const id of [...c.INITIAL_CASES,'deny-notes','F2-F05_HELPER',undefined]){a.equal(c.patchScope([],fixture,id),false);a.equal(c.recordedPatchScope([],fixture,id),false);}});
const steps=c.buildSteps(dirs[2]);
test('Exactly6 useful unique tasks in3+3 with bounded inputs',()=>{a.deepEqual(steps.map(x=>x.ordinal),[1,2,3,4,5,6]);a.deepEqual(steps.map(x=>x.segment),[1,1,1,2,2,2]);a.equal(new Set(steps.map(x=>x.marker)).size,6);a.equal(c.MAIN_CAP,10);a.equal(c.HELPER_CAP,24);});
test('No patch or expected nonzero task',()=>a(steps.every(s=>s.patch===undefined&&s.expectedNonzero===undefined)));
test('Only task2 executes four exact native verification commands',()=>{a.equal(c.BUILD_ORDINAL,2);a.equal(steps[1].commands.length,4);a.equal(steps[1].requiresEscalation.length,4);a(steps.filter(s=>s.ordinal!==2).every(s=>s.requiresEscalation.length===0));});
test('Evidence gate order reflects actual baseline browser restart final',()=>a.deepEqual(steps.filter(s=>s.evidence).map(s=>[s.ordinal,s.evidence]),[[1,'checkpoint'],[4,'browser'],[5,'persistence'],[6,'final']]));
test('Checkpoint explicitly preserves API startup failure and constituent limits',()=>{a.match(steps[0].task,/HARNESS_ERROR and zero API cases/);a.match(steps[0].task,/no same-phase all-twelve pass/);a.match(steps[0].task,/Do not apply any repair again/);});
test('Browser task distinguishes fresh thread and API position setup',()=>{a.match(steps[3].task,/fresh native thread/);a.match(steps[3].task,/Do not claim a drag interaction/);a.match(steps[3].task,/not yet established/);});
test('Native commands require observed zero exit without seeded exception',()=>{for(const step of steps){c.assertCommandResult({step,result:{status:'completed',exitCode:0}});a.throws(()=>c.assertCommandResult({step,result:{status:'completed',exitCode:1}}));}});
test('Incomplete command rejected',()=>a.throws(()=>c.assertCommandResult({step:steps[1],result:{status:'inProgress',exitCode:0}})));
test('Changed authorized command prefix cannot be substituted',()=>a.throws(()=>c.promptFor(steps[0],['echo unrelated'])));
test('Prompt rejects supplied patch task',()=>a.throws(()=>c.promptFor({...steps[0],patch:'F2-B10'},steps[0].commands)));
test('Build prompt retains exact escalation and no retries',()=>{const p=c.promptFor(steps[1],steps[1].commands);a.match(p,/require_escalated/);a.match(p,/do not retry/);a.match(p,/No package installation/);});
test('All prompts end with distinct completion token',()=>steps.forEach(s=>a(c.promptFor(s,s.commands).includes('PB02_DONE:'+s.marker+'.'))));
test('Even 50minutes does not manufacture full session credit',()=>{const q=c.sessionQualification({startedAt:0,endedAt:50*60000,replies:steps.map(s=>({messageId:String(s.ordinal)})),restart:{editorExited:true,historyRestored:true,priorMessagesPreserved:true}});a.equal(q.status,'PARTIAL_S_SESSION');a(q.issues.includes('SIX_VERIFICATION_TASKS_DO_NOT_ESTABLISH_FULL_SESSION_ACCEPTANCE'));});
test('Duplicate assistant message IDs rejected',()=>a.throws(()=>c.sessionQualification({startedAt:0,endedAt:1,replies:steps.map(()=>({messageId:'same'})),restart:{}})));
test('Exact root and independent prior checkpoint pins unchanged',()=>{a.deepEqual(c.identity(c.PRIOR_ROOT_CHECKPOINT.path),c.PRIOR_ROOT_CHECKPOINT);a.deepEqual(c.identity(c.INDEPENDENT_CHECKPOINT.path),c.INDEPENDENT_CHECKPOINT);});
const report={status:checks.every(x=>x.status==='PASS')?'PASS_CONTROLS_NO_NATIVE_INFERENCE':'FAIL',checks,sources:[__filename,path.join(__dirname,'codex-f2-verification-campaign.cjs'),path.join(__dirname,'codex-f2-verification-steps.cjs')].map(c.identity),nativeInputs:0,applicationLaunches:0,scope:'Owned ten-file synthetic source copies plus pinned immutable prior source reads; no campaign preparation or repair application.'};const p=path.join(out,'checks.json');fs.writeFileSync(p,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:c.identity(p),checks:checks.length,failures:checks.filter(x=>x.status!=='PASS')}));process.exitCode=checks.every(x=>x.status==='PASS')?0:1;
