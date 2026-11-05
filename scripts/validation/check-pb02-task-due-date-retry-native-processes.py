#!/usr/bin/env python3
"""Synthetic F02 observer ownership controls; no observer, watcher, editor or model launch."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
ROOT = REPO / 'out-test/feature-tests/PB-02'
SOURCE = Path(__file__).with_name('observe-pb02-task-due-date-retry-native-processes.py')
spec = importlib.util.spec_from_file_location('observer', SOURCE)
o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
DIRECTORY = Path(tempfile.mkdtemp(prefix='task-due-date-retry-native-observer-controls-', dir=ROOT))
checks = []
OLD_INPUTS = [
    Path(__file__).with_name('observe-pb02-csv-export-sequential-native-processes.py'),
    Path(__file__).with_name('check-pb02-csv-export-sequential-native-processes.py'),
    Path(__file__).with_name('check-pb02-csv-export-sequential-passive-review.py'),
    ROOT / 'overnight-20261011/root-review-csv-export-sequential-passive-processes.py',
]
predecessors = [o.file_identity(file) for file in OLD_INPUTS]


def test(name, function):
    try:
        function(); checks.append({'name': name, 'status': 'PASS'})
    except Exception as error:
        checks.append({'name': name, 'status': 'FAIL', 'error': repr(error)})


def rejects(function):
    try:
        function()
    except (ValueError, FileNotFoundError, StopIteration, ProcessLookupError, OSError):
        return
    raise AssertionError('Expected boundary rejection')


def make_fixture(name):
    artifact = DIRECTORY / name; artifact.mkdir(); owner = artifact / 'window-A'; owner.mkdir(); cli = owner / 'cli'; cli.mkdir()
    node = ROOT / 'readiness.json'; r = json.loads(node.read_text()); pin = o.file_identity(Path(r['node']))
    dummy = cli / 'pinned.cjs'; dummy.write_text('// Owned inert control bytes. Never executed.\n')
    dummy_pin = o.file_identity(dummy)
    m = {'case': 'PB-02', 'stage': 'F2_TASK_DUE_DATE_RETRY_SEQUENTIAL', 'artifactDir': str(artifact), 'preparedBeforeActivation': True,
         'windows': {'A': {'id': 'A', 'directory': str(owner), 'cliDirectory': str(cli), 'wrappers': {'openai-codex': str(dummy), 'claude-code': str(dummy)},
                           'receiptPaths': [str(cli / 'openai-codex-receipts.jsonl')], 'auxiliaryReceiptPaths': [str(cli / 'claude-auxiliary-receipts.jsonl')]}},
         'maxForwardedInputs': 24, 'auxiliary': {'maxInputs': 48},
         'wrapperIdentities': [dummy_pin], 'harnessDependencyIdentities': [], 'executableIdentities': {'codex-native': pin, 'claude-auxiliary-native': pin},
         'nodeIdentity': pin, 'sourceIdentity': dummy_pin, 'packageIdentity': dummy_pin}
    # Unique executable identities are mandatory in the watcher; use actual tiny system binaries as distinct inert allowlist entries.
    m['executableIdentities']['codex-native'] = o.file_identity(Path('/bin/cat'))
    m['executableIdentities']['claude-auxiliary-native'] = o.file_identity(Path('/bin/echo'))
    editor = REPO / '.vscode-test/vscode-darwin-arm64-1.141.0/Visual Studio Code.app/Contents/MacOS/Code'
    m['editorIdentity'] = o.file_identity(editor)
    directories = {str(index):str(ROOT / 'overnight-20261011' / ('task-due-date-retry-segment-' + str(index) + '-passive-processes')) for index in [1,2]}
    m['segment'] = {'index':1}
    m['passiveEvidenceDirectory'] = directories['1']
    m['campaign'] = {'editorIdentity':m['editorIdentity'].copy(),'passiveEvidenceDirectories':directories}
    p = artifact / 'prepared.json'; o.write_new(p, m)
    return p, m


manifest, fixture = make_fixture('prepared-control')
manifest_pin = o.file_identity(manifest)
test('exact fresh manifest is accepted without target startup', lambda: o.validate_manifest(manifest, manifest_pin['sha256']))
test('wrong manifest hash rejects', lambda: rejects(lambda: o.validate_manifest(manifest, '0' * 64)))


def unsupported_stage(stage, name):
    path, value = make_fixture(name)
    value['stage'] = stage
    path.write_text(json.dumps(value, indent=2) + '\n')
    pin = o.file_identity(path)
    rejects(lambda: o.validate_manifest(path, pin['sha256']))

test('frozen predecessor final-bugs stage is rejected by task-due-date-retry-only observer', lambda: unsupported_stage('F2_FINAL_BUGS', 'old-stage'))
test('earlier scoped stage is also rejected', lambda: unsupported_stage('F2_SCOPED_SHORT_SESSION', 'earlier-stage'))
test('unrelated stage is rejected even with exact document hash', lambda: unsupported_stage('ARBITRARY_STAGE', 'foreign-stage'))

def prior_launch():
    p = manifest.parent / 'launch-reservation.json'; p.write_text('{}')
    try: rejects(lambda: o.validate_manifest(manifest, manifest_pin['sha256']))
    finally: p.unlink()
test('prior launch rejects before observer creation', prior_launch)

def receipt_seed():
    p = Path(fixture['windows']['A']['receiptPaths'][0]); p.write_text('{}\n')
    try: rejects(lambda: o.validate_manifest(manifest, manifest_pin['sha256']))
    finally: p.unlink()
test('nonempty prior receipt rejects', receipt_seed)
test('output beneath prepared evidence rejects', lambda: rejects(lambda: o.validate_output(manifest.parent / 'observer', manifest.parent)))
test('existing output rejects', lambda: rejects(lambda: o.validate_output(DIRECTORY, manifest.parent)))

def symbolic_output():
    target = DIRECTORY / 'linked'; target.symlink_to(DIRECTORY, target_is_directory=True)
    try: rejects(lambda: o.validate_output(target / 'new', manifest.parent))
    finally: target.unlink()
test('symlink output parent rejects', symbolic_output)

receipt = DIRECTORY / 'openai-codex-receipts.jsonl'
first = {'window': 'A', 'provider': 'openai-codex', 'event': 'start', 'wrapperPid': 101, 'childPid': 102, 'at': 2000}
first_bytes = (json.dumps(first) + '\n').encode(); receipt.write_bytes(first_bytes[:12]); tail = o.ReceiptTail(receipt)
test('incomplete receipt line waits without inventing process', lambda: (None if tail.read() == [] else (_ for _ in ()).throw(AssertionError())))
with receipt.open('ab') as stream: stream.write(first_bytes[12:])

def completed_line():
    rows = tail.read(); assert len(rows) == 1 and rows[0]['offset'] == 0 and rows[0]['bytes'] == len(first_bytes)
    assert rows[0]['sha256'] == hashlib.sha256(first_bytes).hexdigest()
    assert tail.report()['completeUnchangedRead']
test('completed receipt retains exact offset/hash', completed_line)

def modified_prefix():
    original = receipt.read_bytes(); receipt.write_bytes(original.replace(b'2000', b'3000'))
    try: assert not tail.report()['completeUnchangedRead']
    finally: receipt.write_bytes(original)
test('same-inode consumed-prefix change is detected at final report', modified_prefix)

def truncation():
    original = receipt.read_bytes(); receipt.write_bytes(b'')
    try: rejects(tail.read)
    finally: receipt.write_bytes(original)
test('receipt truncation rejects', truncation)

def link_receipt():
    p = DIRECTORY / 'linked-receipt'; p.symlink_to(receipt)
    try: rejects(o.ReceiptTail(p).read)
    finally: p.unlink()
test('receipt symlink rejects', link_receipt)

def hardlink_receipt():
    p = DIRECTORY / 'hardlinked'; os.link(receipt, p)
    try: rejects(o.ReceiptTail(receipt).read)
    finally: p.unlink()
test('receipt hardlink rejects', hardlink_receipt)

start = int(time.time()); wrapper = {'pid': 10001, 'ppid': 10000, 'pgid': 10000, 'uid': os.getuid(), 'startSec': start, 'startUsec': 10, 'executablePath': fixture['nodeIdentity']['path']}
editor = {'pid': 10000, 'ppid': 9999, 'pgid': 10000, 'uid': os.getuid(), 'startSec': start - 2, 'startUsec': 30, 'executablePath': '/bin/cat'}
owner = {'pid': 9997, 'pgid': 9997, 'uid': os.getuid()}
reference = {'at': start * 1000 + 20}
ancestry = {'window': 'A', 'processDetails': [{'pid': editor['pid'], 'startedAt': o.ps_birth(editor)}, {'pid': wrapper['pid'], 'startedAt': o.ps_birth(wrapper)}]}
class Kernel:
    @staticmethod
    def identity(pid):
        assert pid == editor['pid']; return editor.copy()

def join(w=wrapper, a=ancestry, r=reference, own=owner):
    return o.owner_chain(w, r, a, Kernel, o.file_identity(Path('/bin/cat')), own, start * 1000)
test('current wrapper birth and editor parent chain join', lambda: (None if len(join()) == 2 else (_ for _ in ()).throw(AssertionError())))
test('PID reused after receipt rejects', lambda: rejects(lambda: join(w={**wrapper, 'startSec': start + 1})))
test('wrapper before observer rejects', lambda: rejects(lambda: o.owner_chain({**wrapper, 'startSec': start - 20}, reference, ancestry, Kernel, o.file_identity(Path('/bin/cat')), owner, start * 1000)))
test('same PID wrong ancestry birth rejects', lambda: rejects(lambda: join(a={**ancestry, 'processDetails': [ancestry['processDetails'][0], {'pid': wrapper['pid'], 'startedAt': 'wrong'}]})))
test('foreign UID rejects', lambda: rejects(lambda: join(w={**wrapper, 'uid': os.getuid() + 1})))
test('observer inside target process group rejects', lambda: rejects(lambda: join(own={**owner, 'pgid': wrapper['pgid']})))
test('ancestry cycle rejects', lambda: rejects(lambda: join(w={**wrapper, 'ppid': wrapper['pid']})))

def zero_hour():
    stamp = time.mktime((2026, 10, 3, 4, 5, 6, 0, 0, -1))
    assert 'Oct 3 04:05:06 2026' in o.ps_birth({'startSec': stamp})
test('PS birth preserves zero-padded hour and unpadded day', zero_hour)


# No invocation of observer main, kernel watcher, or zero-target live startup.


actual_manifest = ROOT / 'overnight-20261011/native-f2-csv-export-sequential-session/segment-1/prepared.json'
actual_pin = o.file_identity(actual_manifest)
def historical_stage_rejects():
    try: o.validate_manifest(actual_manifest, actual_pin['sha256'])
    except ValueError as error:
        assert str(error) == 'Only task-due-date-retry F2 stage supported'
        return
    raise AssertionError('Earlier csv-export-sequential stage must not be admitted')
test('actual stopped csv-export-sequential manifest is rejected by this new stage', historical_stage_rejects)
def actual_contract_stage():
    # Read the current contract's exact literals without importing or executing it.
    source = (REPO / 'scripts/validation/codex-f2-task-due-date-retry-campaign.cjs').read_text()
    assert "const STAGE = 'F2_TASK_DUE_DATE_RETRY_SEQUENTIAL', FEATURE_ID = 'F2-F02', MAIN_CAP = 24, HELPER_CAP = 48;" in source
    assert fixture['stage'] == 'F2_TASK_DUE_DATE_RETRY_SEQUENTIAL'
    assert fixture['maxForwardedInputs'] == 24 and fixture['auxiliary']['maxInputs'] == 48
    o.validate_manifest(manifest, manifest_pin['sha256'])
test('positive fixture matches current contract stage and caps24/48', actual_contract_stage)
test('immediate csv-export-sequential predecessor stage is rejected', lambda: unsupported_stage('F2_CSV_EXPORT_SEQUENTIAL', 'csv-export-sequential-stage'))
test('previous verification stage is rejected', lambda: unsupported_stage('F2_VERIFICATION', 'verification-stage'))

def wrong_binding(field):
    import copy
    p,value=make_fixture('bad-binding-'+field)
    if field=='manifest-editor': value['editorIdentity']['sha256']='0'*64
    elif field=='campaign-editor': value['campaign']['editorIdentity']['sha256']='0'*64
    elif field=='passive-directory': value['passiveEvidenceDirectory']=str(DIRECTORY/'other')
    elif field=='campaign-directory': value['campaign']['passiveEvidenceDirectories']['1']=str(DIRECTORY/'other')
    elif field=='segment-replay': value['segment']['index']=2
    p.write_text(json.dumps(value))
    rejects(lambda:o.validate_manifest(p,o.file_identity(p)['sha256']))
for field in ['manifest-editor','campaign-editor','passive-directory','campaign-directory','segment-replay']:
    test('prelaunch binding rejects '+field,lambda field=field:wrong_binding(field))

def originals_preserved():
    for identity in predecessors:
        assert o.file_identity(identity['path']) == identity
test('all four predecessor sources remain unchanged', originals_preserved)
snapshot_dir = DIRECTORY / 'source-snapshots'; snapshot_dir.mkdir()
for file in [SOURCE, Path(__file__).resolve(), *OLD_INPUTS]:
    (snapshot_dir / file.name).write_bytes(file.read_bytes())

report = {'status': 'PASS' if all(c['status'] == 'PASS' for c in checks) else 'FAIL', 'checks': checks, 'rejectedHistoricalManifest': actual_pin, 'observer': o.file_identity(SOURCE), 'checker': o.file_identity(Path(__file__).resolve()), 'nativeInputs': 0, 'editorLaunches': 0, 'targetProcessesLaunched': 0, 'observerLaunches': 0, 'watcherLaunches': 0, 'subprocessesLaunched': 0, 'predecessors': predecessors, 'scope': 'Synthetic ownership/receipt boundary controls only. Observer and watcher startup are deliberately not run; no actual native target ownership or process-exit credit.'}
o.write_new(DIRECTORY / 'checks.json', report)
print(json.dumps({'path': str(DIRECTORY / 'checks.json'), 'status': report['status'], 'sha256': o.file_identity(DIRECTORY / 'checks.json')['sha256'], 'checks': len(checks), 'failures': [r for r in checks if r['status'] != 'PASS']}))
raise SystemExit(0 if report['status'] == 'PASS' else 1)
