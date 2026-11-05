/* Read only the exact PC08-owned profile's Mysti/helper SQLite entries. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const artifactDir = path.resolve(process.env.MYSTI_PC08_ARTIFACT_DIR);
const stage = process.env.MYSTI_PC08_STAGE;
assert(['preflight-write', 'preflight-read', 'create', 'restart'].includes(stage));
const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'prepared.json')));
const marker = JSON.parse(fs.readFileSync(path.join(manifest.profile, '.mysti-test-owned.json')));
assert.equal(marker.case, 'PC-08'); assert.equal(marker.profile, fs.realpathSync(manifest.profile));
const database = path.join(manifest.profile, 'User/globalStorage/state.vscdb');
assert(fs.existsSync(database), 'Actual ordinary-editor profile must have a disk-backed state.vscdb');
const program = `
import sqlite3,json,sys,hashlib
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
result={}
for key,raw in db.execute("SELECT key,value FROM ItemTable WHERE lower(key) IN ('deepmyst.mysti','mystivalidation.pc08-disk-runner')"):
 value=json.loads(raw)
 if key.lower()=='deepmyst.mysti':
  blob=value.get('mysti.conversations',{})
  rows=blob.get('conversations',[]) if isinstance(blob,dict) else []
  normalized=[]
  for entry in rows:
   assert isinstance(entry,list) and len(entry)==2 and isinstance(entry[1],dict),'Expected stored [id,conversation] tuple'
   key,conversation=entry
   assert key==conversation.get('id'),'Stored tuple key must match conversation identity'
   normalized.append({'id':key,'messageCount':len(conversation.get('messages',[]))})
  result['mysti']={'schemaVersion':blob.get('schemaVersion') if isinstance(blob,dict) else None,'count':len(rows),'conversations':normalized}
 else:
  sentinel=value.get('pc08.diskSentinel')
  result['helper']={'sentinelHash':hashlib.sha256(sentinel.encode()).hexdigest() if isinstance(sentinel,str) else None}
print(json.dumps(result))
`;
const stored = JSON.parse(execFileSync('python3', ['-c', program, database], { encoding: 'utf8', timeout: 10000 }));
const expectedSentinelHash = require('node:crypto').createHash('sha256').update(manifest.diskRunner.sentinel).digest('hex');
assert.equal(stored.helper?.sentinelHash, expectedSentinelHash);
assert(stored.mysti?.count > 0, 'Actual Mysti conversation store must be present on disk');
if (stage === 'preflight-read') {
  const first = JSON.parse(fs.readFileSync(path.join(artifactDir, 'preflight-write/storage-audit.json')));
  const ids = new Set(stored.mysti.conversations.map(value => value.id));
  for (const previous of first.stored.mysti.conversations) assert(ids.has(previous.id), 'An actual Mysti initial conversation must survive the real restart');
}
const receiptFiles = Object.values(manifest.receiptsPathsByStage).flat();
const rows = receiptFiles.flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const conversations = rows.filter(value => value.event === 'request').length;
const auxiliaryInputs = rows.filter(value => value.event === 'auxiliary-input').length;
if (stage.startsWith('preflight')) { assert.equal(conversations, 0); assert.equal(auxiliaryInputs, 0); }
const evidence = { status: 'PASS_ACTUAL_DISK_STORAGE', stage, database, stored, conversations, auxiliaryInputs,
  scope: 'Exact owned Mysti/helper memento keys only; SQLite read-only; no storage injection or VS Code patch', checkedAt: new Date().toISOString() };
fs.writeFileSync(path.join(artifactDir, stage, 'storage-audit.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ status: evidence.status, stage, persistedMystiConversations: stored.mysti.count, conversations, auxiliaryInputs }));
