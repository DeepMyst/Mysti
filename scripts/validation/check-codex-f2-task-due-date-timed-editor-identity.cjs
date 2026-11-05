#!/usr/bin/env node
'use strict';
// Synthetic prospective-proof controls only. Import exports fixture helpers and has no writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const helper=require('./codex-f2-task-due-date-timed-editor-identity.cjs');
const ROOT=path.resolve(__dirname,'../../out-test/feature-tests/PB-02');
const hash=helper.hash, pin=file=>({path:file,sha256:hash(fs.readFileSync(file))});
function clone(value){if(Buffer.isBuffer(value))return Buffer.from(value);if(Array.isArray(value))return value.map(clone);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clone(v)]));return value;}
function fixture(i=1,base=path.join(ROOT,'synthetic-editor-proof')) {
 const second=1791756276+(i-1)*600,pid=22001+(i-1)*1000,wrapper=pid+1;
 const iso=seconds=>new Date(seconds*1000).toISOString();
 const birth=seconds=>new Date((seconds+10800)*1000).toUTCString().replace(/,/, '').replace(/^(\w+) (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4');
 const campaignDirectory=path.join(base,'native-campaign'),seg=path.join(campaignDirectory,`segment-${i}`),window=path.join(seg,'window-A');
 const editorIdentity={path:path.join(base,'editor','Code'),sha256:hash('synthetic editor bytes\n')};
 const passive=path.join(base,`task-due-date-timed-segment-${i}-passive-processes`),receiptPaths=[path.join(window,'cli/main.jsonl')],auxiliaryReceiptPaths=[path.join(window,'cli/aux.jsonl')];
 const implementationNames=['observe-pb02-task-due-date-timed-native-processes.py','pb02-kqueue-watch.py'];
 const implementationPins=implementationNames.map(name=>{const file=path.join(__dirname,name);return fs.existsSync(file)?pin(file):{path:file,sha256:hash('synthetic-'+name)};});
 const campaign={stage:'F2_TASK_DUE_DATE_TIMED_SEQUENTIAL',directory:campaignDirectory,editorIdentity,passiveEvidenceDirectories:{'1':path.join(base,'task-due-date-timed-segment-1-passive-processes'),'2':path.join(base,'task-due-date-timed-segment-2-passive-processes')}};
 const campaignBytes=JSON.stringify(campaign,null,2)+'\n';
 const manifest={stage:'F2_TASK_DUE_DATE_TIMED_SEQUENTIAL',artifactDir:seg,segment:{index:i},editorIdentity,passiveEvidenceDirectory:passive,campaign:{...campaign,identity:{path:path.join(campaignDirectory,'campaign.json'),sha256:hash(campaignBytes)}},harnessDependencyIdentities:implementationPins,windows:{A:{directory:window,workspace:path.join(campaignDirectory,'workspace'),profile:path.join(base,'profile'),installedExtension:path.join(window,'installed-extension'),extensionsDir:path.join(window,'extensions'),receiptPaths,auxiliaryReceiptPaths}}};
 const root={pid,parentPid:21000,startedAt:birth(second),parentStartedAt:birth(second-20),firstObservedAt:iso(second+.25),lastObservedAt:iso(second+10),executableBasename:'(Code)'};
 const wr={pid:wrapper,parentPid:pid,startedAt:birth(second+1),parentStartedAt:birth(second),firstObservedAt:iso(second+1.5),lastObservedAt:iso(second+9),executableBasename:'node'};
 const ancestry={sampledAt:iso(second+20),processDetails:[root,wr],processIdentities:[root,wr].map(row=>({pid:row.pid,startedAt:row.startedAt}))};
 const manifestIdentity={path:path.join(seg,'prepared.json'),sha256:hash(JSON.stringify(manifest,null,2)+'\n')},ancestryIdentity={path:path.join(window,'process-ancestry.json'),sha256:hash(JSON.stringify(ancestry,null,2)+'\n')};
 const receipt={event:'start',wrapperPid:wrapper,childPid:wrapper+1,at:(second+2)*1000,provider:'openai-codex'};
 const bytes=Buffer.from(JSON.stringify(receipt)+'\n');
 const reference={path:receiptPaths[0],offset:0,bytes:bytes.length,sha256:hash(bytes),...receipt};
 const uid=process.getuid();
 const joins=[3,4].map((offset,index)=>({event:'owned-ancestry-join',seq:index+1,at:second+offset,source:{...ancestryIdentity,sha256:hash('interim-'+index),sampledAt:iso(second+offset-.1)},receipt:reference,rootRow:{...root,executableBasename:'Code',lastObservedAt:iso(second+offset-.2)},wrapperRow:wr,liveChain:[{pid:wrapper,ppid:pid,pgid:pid,uid,startSec:second+1,startUsec:234567,executablePath:path.join(base,'node')},{pid,ppid:root.parentPid,pgid:pid,uid,startSec:second,startUsec:123456,executablePath:editorIdentity.path}]}));
 const discoveryBytes=Buffer.from(joins.map(row=>JSON.stringify(row)).join('\n')+'\n'),discoveryIdentity={path:path.join(passive,'discovery.jsonl'),sha256:hash(discoveryBytes)};
 const ready={status:'READY_PASSIVE_NO_TARGET_INPUTS',observer:{uid,startSec:second-5,startUsec:0},manifest:{...manifestIdentity},editorIdentity:{...editorIdentity},observerSource:implementationPins[0],watcherSource:implementationPins[1]};
 const receiptBytes={[receiptPaths[0]]:bytes,[auxiliaryReceiptPaths[0]]:Buffer.alloc(0)};
 const result={status:'PARTIAL_PASSIVE_OBSERVER',collectionComplete:true,manifestUnchanged:true,stopReason:'explicit-root-stop',watcherExitCode:0,events:{...discoveryIdentity},receipts:Object.entries(receiptBytes).map(([file,data])=>({path:file,bytesRead:data.length,partialLineBytes:0,completeUnchangedRead:true,sha256:hash(data),finalIdentity:{path:file,sha256:hash(data)}})),observedKernelExits:1,kernelUnknownEvents:1,discoveryGaps:[{reason:'synthetic preserved coverage gap'}]};
 const launch={window:'A',profile:manifest.windows.A.profile,installedExtension:manifest.windows.A.installedExtension,extensionTestsPathUsed:false,args:[manifest.windows.A.workspace,`--user-data-dir=${manifest.windows.A.profile}`,`--extensions-dir=${manifest.windows.A.extensionsDir}`]};
 return {segment:{manifest,ancestry,exit:{code:0,signal:null,timedOut:false},cleanup:{status:'PASS_OBSERVED_IDENTITIES_EXITED',remaining:[]}},proof:{manifestIdentity,ancestryIdentity,discoveryIdentity,editorIdentity,uid,ready,result,joins,receiptBytes,launch},campaign,campaignBytes,discoveryBytes};
}
function materialize(value) {
 const write=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});};
 const json=(file,value)=>write(file,JSON.stringify(value,null,2)+'\n');
 write(value.segment.manifest.campaign.identity.path,value.campaignBytes);
 json(value.proof.manifestIdentity.path,value.segment.manifest);json(value.proof.ancestryIdentity.path,value.segment.ancestry);
 json(path.join(value.segment.manifest.windows.A.directory,'launch.json'),value.proof.launch);
 json(path.join(value.segment.manifest.passiveEvidenceDirectory,'ready.json'),value.proof.ready);json(path.join(value.segment.manifest.passiveEvidenceDirectory,'result.json'),value.proof.result);
 write(value.proof.discoveryIdentity.path,value.discoveryBytes);write(value.proof.editorIdentity.path,'synthetic editor bytes\n');
 for(const [file,bytes]of Object.entries(value.proof.receiptBytes))write(file,bytes);
 return value;
}
function main(){
 const output=fs.mkdtempSync(path.join(ROOT,'f2-task-due-date-timed-editor-identity-controls-'));const checks=[];
 const test=(name,fn)=>{try{fn();checks.push({name,status:'PASS'});}catch(error){checks.push({name,status:'FAIL',error:error.stack});}};
 const reject=(name,mutate)=>test(name,()=>{const f=fixture();helper.verifyRootIdentity(f.segment,f.proof);mutate(f);assert.throws(()=>helper.verifyRootIdentity(f.segment,f.proof));});
 test('Canonical synthetic (Code) accepts only joined prospective proof; input unchanged',()=>{const f=fixture(),before=JSON.stringify(f);const r=helper.verifyRootIdentity(f.segment,f.proof);assert.equal(r.status,'VERIFIED_PRELAUNCH_BOUND_EDITOR_ROOT_IDENTITY');assert.equal(r.root.pid,22001);assert.equal(r.witnessCount,2);assert.equal(r.preciseIdentity.startUsec,123456);assert.equal(JSON.stringify(f),before);});
 test('Second synthetic prospective root has a distinct birth',()=>{const f=fixture(2);assert.equal(helper.verifyRootIdentity(f.segment,f.proof).root.pid,23001);});
 test('Literal Code still requires identical canonical witnesses',()=>{const f=fixture();f.segment.ancestry.processDetails[0].executableBasename='Code';assert.equal(helper.selectRoot(f.segment,f.proof).pid,22001);});
 test('Recorded ps seconds use explicit Amman offset independent of host timezone',()=>assert.equal(helper.secondsAtAmman('Mon Oct 12 01:04:36 2026'),1791756276));
reject('No passive proof rejects',f=>{f.proof=null;});
reject('No root rejects',f=>{f.segment.ancestry.processDetails=f.segment.ancestry.processDetails.filter(x=>x.pid!==22001);});
reject('Second parentless root rejects ambiguity',f=>{f.segment.ancestry.processDetails.push({...f.segment.ancestry.processDetails[0],pid:999999});f.segment.ancestry.processIdentities.push({pid:999999,startedAt:f.segment.ancestry.processDetails[0].startedAt});});
reject('Arbitrary parenthesized name is not normalized',f=>{f.segment.ancestry.processDetails[0].executableBasename='(Other)';});
reject('Code helper is not an editor root',f=>{f.segment.ancestry.processDetails[0].executableBasename='Code Helper';});
reject('Whitespace variant is not normalized',f=>{f.segment.ancestry.processDetails[0].executableBasename=' (Code) ';});
reject('Missing root birth membership rejects',f=>{f.segment.ancestry.processIdentities=f.segment.ancestry.processIdentities.filter(x=>x.pid!==22001);});
reject('Root PID reuse with changed ps birth rejects',f=>{f.segment.ancestry.processDetails[0].startedAt='Mon Oct 12 01:04:37 2026';});
reject('Reparented final root without matching original parent rejects',f=>{f.segment.ancestry.processDetails[0].parentPid=1;});
reject('Root final parent birth mismatch rejects',f=>{f.segment.ancestry.processDetails[0].parentStartedAt='Mon Oct 12 01:04:33 2026';});
reject('Missing witnesses rejects',f=>{f.proof.joins=[];});
reject('Two same-time witnesses are not independent observations',f=>{f.proof.joins=f.proof.joins.slice(0,2);f.proof.joins[1].at=f.proof.joins[0].at;});
reject('Single witness does not prove repeated precise birth',f=>{f.proof.joins=f.proof.joins.slice(0,1);});
reject('Witness event kind mismatch rejects',f=>{f.proof.joins[0].event='watch-candidate';});
reject('Witness root PID mismatch rejects',f=>{f.proof.joins[0].rootRow.pid++;});
reject('Witness root ps birth mismatch rejects',f=>{f.proof.joins[0].rootRow.startedAt='Mon Oct 12 01:04:37 2026';});
reject('Witness root name mismatch rejects',f=>{f.proof.joins[0].rootRow.executableBasename='Other';});
reject('Witness source path belongs to another segment',f=>{f.proof.joins[0].source.path=f.proof.joins[0].source.path.replace('segment-1','segment-2');});
reject('Kernel root PID mismatch rejects',f=>{f.proof.joins[0].liveChain.at(-1).pid++;});
reject('Kernel root start second mismatch rejects',f=>{f.proof.joins[0].liveChain.at(-1).startSec++;});
reject('Kernel same-second microsecond mismatch between witnesses rejects',f=>{f.proof.joins[1].liveChain.at(-1).startUsec++;});
reject('Kernel microsecond outside range rejects',f=>{f.proof.joins[0].liveChain.at(-1).startUsec=1000000;});
reject('Kernel root parent mismatch rejects',f=>{f.proof.joins[0].liveChain.at(-1).ppid=1;});
reject('Kernel foreign same basename executable rejects',f=>{f.proof.joins[0].liveChain.at(-1).executablePath='/tmp/Code';});
reject('Broken intermediate ancestry link rejects',f=>{f.proof.joins[0].liveChain[0].ppid=1;});
reject('Repeated PID ancestry cycle rejects',f=>{f.proof.joins[0].liveChain[1].pid=f.proof.joins[0].liveChain[0].pid;});
reject('Ancestor UID mismatch rejects',f=>{f.proof.joins[0].liveChain[1].uid++;});
reject('Root UID mismatch rejects',f=>{f.proof.joins[0].liveChain.at(-1).uid++;});
reject('Foreign ready manifest rejects',f=>{f.proof.ready.manifest.path=f.proof.ready.manifest.path.replace('segment-1','segment-2');});
reject('Ready manifest hash mismatch rejects',f=>{f.proof.ready.manifest.sha256='0'.repeat(64);});
reject('Ready executable hash mismatch rejects',f=>{f.proof.ready.editorIdentity={...f.proof.ready.editorIdentity,sha256:'0'.repeat(64)};});
reject('Result discovery identity mismatch rejects',f=>{f.proof.result.events.sha256='0'.repeat(64);});
reject('Receipt file path escape rejects',f=>{f.proof.joins[0].receipt.path='/tmp/other-receipts.jsonl';});
reject('Receipt byte offset mismatch rejects',f=>{f.proof.joins[0].receipt.offset++;});
reject('Receipt byte count mismatch rejects',f=>{f.proof.joins[0].receipt.bytes--;});
reject('Receipt range hash mismatch rejects',f=>{f.proof.joins[0].receipt.sha256='0'.repeat(64);});
reject('Receipt wrapper PID mismatch rejects',f=>{f.proof.joins[0].receipt.wrapperPid++;});
reject('Full receipt hash mismatch rejects',f=>{f.proof.result.receipts[0].sha256='0'.repeat(64);});
reject('Incomplete unchanged receipt read rejects',f=>{f.proof.result.receipts[0].completeUnchangedRead=false;});
reject('Launch profile mismatch rejects',f=>{f.proof.launch.profile='/tmp/foreign-profile';});
reject('Launch workspace argument mismatch rejects',f=>{f.proof.launch.args=f.proof.launch.args.filter(a=>a!==f.segment.manifest.windows.A.workspace);});
reject('Exit failure remains rejected',f=>{f.segment.exit.code=1;});
reject('Timed-out editor is not successful restart proof',f=>{f.segment.exit.timedOut=true;});
reject('Remaining owned process prevents successful restart proof',f=>{f.segment.cleanup.remaining=[{pid:22001,startedAt:f.segment.ancestry.processDetails[0].startedAt}];});

 const regular=path.join(output,'regular.json');fs.writeFileSync(regular,'{"owned":true}\n',{flag:'wx'});const regularPin=pin(regular);
 test('Private canonical pinned file accepted',()=>helper.readPinnedFile(regularPin));
 test('Wrong proof SHA rejected',()=>assert.throws(()=>helper.readPinnedFile({...regularPin,sha256:'0'.repeat(64)})));
 test('Symlink proof rejected',()=>{const file=path.join(output,'alias.json');fs.symlinkSync(regular,file);assert.throws(()=>helper.readPinnedFile({...regularPin,path:file}));});
 test('Hardlink proof rejected',()=>{const file=path.join(output,'hardlink.json');fs.linkSync(regular,file);assert.throws(()=>helper.readPinnedFile({...regularPin,path:file}));});
 for(const [name,mutate]of [
  ['wrong stage',f=>{f.segment.manifest.stage='F2_BOARD_DESCRIPTION';}],
  ['foreign passive path',f=>{f.segment.manifest.passiveEvidenceDirectory+='/other';}],
  ['both arbitrary passive paths',f=>{f.segment.manifest.passiveEvidenceDirectory='/tmp/foreign';f.segment.manifest.campaign.passiveEvidenceDirectories['1']='/tmp/foreign';}],
  ['same-basename changed manifest editor',f=>{f.segment.manifest.editorIdentity={path:'/foreign/Code',sha256:hash('foreign')};}],
  ['foreign editor hash',f=>{f.segment.manifest.editorIdentity={...f.segment.manifest.editorIdentity,sha256:hash('foreign')};}],
  ['wrong window owner',f=>{f.segment.manifest.windows.A.directory+='/other';}],
 ])test(`Prelaunch binding rejects ${name}`,()=>{const f=fixture();helper.validateBindings(f.segment);mutate(f);assert.throws(()=>helper.validateBindings(f.segment));});
 test('Generic loader joins actual fresh synthetic files and prelaunch implementation pins',()=>{
  const f=materialize(fixture(1,path.join(output,'loader-positive')));const r=helper.reviewSegment(f.segment);assert.equal(r.witnessCount,2);assert.equal(r.passiveCollection.kernelUnknownEvents,1);assert.equal(r.passiveCollection.discoveryGaps.length,1);
 });
 for(const [name,mutate]of [
  ['foreign executable altered consistently in ready and witness but not frozen campaign',f=>{const other={path:path.join(output,'foreign','Code'),sha256:hash('foreign')};f.proof.ready.editorIdentity=other;f.proof.editorIdentity=other;for(const j of f.proof.joins)j.liveChain.at(-1).executablePath=other.path;}],
  ['unfrozen observer source',f=>{f.proof.ready.observerSource.sha256=hash('foreign');}],
  ['altered campaign binding',f=>{f.campaign.editorIdentity={path:'/foreign/Code',sha256:hash('foreign')};f.campaignBytes=JSON.stringify(f.campaign,null,2)+'\n';}],
 ])test(`Generic loader rejects ${name}`,()=>{
   const f=fixture(1,path.join(output,'loader-negative-'+checks.length));mutate(f);
   // Re-encode discovery where a test changes its in-memory witnesses, never old evidence.
   f.discoveryBytes=Buffer.from(f.proof.joins.map(row=>JSON.stringify(row)).join('\n')+'\n');
   materialize(f);assert.throws(()=>helper.reviewSegment(f.segment));
 });
 const report={schemaVersion:1,status:checks.every(x=>x.status==='PASS')?'PASS':'FAIL',createdAt:new Date().toISOString(),passed:checks.filter(x=>x.status==='PASS').length,failed:checks.filter(x=>x.status==='FAIL').length,checks,identities:[pin(__filename),pin(require.resolve('./codex-f2-task-due-date-timed-editor-identity.cjs'))],scope:'Pure joined synthetic root/receipt/manifest/ancestry controls and isolated fake executable bytes. No actual campaign, historical proof reuse, live process probes, app/editor/model or oracle launch.',nativeLaunches:0,providerInputs:0};
 const file=path.join(output,'checks.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({report:pin(file),status:report.status,passed:report.passed,failed:report.failed,failures:checks.filter(x=>x.status==='FAIL')}));if(report.failed)process.exitCode=1;return report;
}
module.exports={fixture,materialize,clone,main};
if(require.main===module)main();
