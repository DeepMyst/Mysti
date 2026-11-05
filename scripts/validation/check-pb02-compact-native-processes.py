#!/usr/bin/env python3
"""Small observer ownership controls; no editor or model launch."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
ROOT = REPO / 'out-test/feature-tests/PB-02'
SOURCE = Path(__file__).with_name('observe-pb02-compact-native-processes.py')
spec = importlib.util.spec_from_file_location('observer', SOURCE)
o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
DIRECTORY = Path(tempfile.mkdtemp(prefix='compact-native-observer-controls-', dir=ROOT))
checks = []


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
    m = {'case': 'PB-02', 'stage': 'F2_SCOPED_COMPACT_SHORT_SESSION', 'artifactDir': str(artifact), 'preparedBeforeActivation': True,
         'windows': {'A': {'id': 'A', 'directory': str(owner), 'cliDirectory': str(cli), 'wrappers': {'openai-codex': str(dummy), 'claude-code': str(dummy)},
                           'receiptPaths': [str(cli / 'openai-codex-receipts.jsonl')], 'auxiliaryReceiptPaths': [str(cli / 'claude-auxiliary-receipts.jsonl')]}},
         'wrapperIdentities': [dummy_pin], 'harnessDependencyIdentities': [], 'executableIdentities': {'codex-native': pin, 'claude-auxiliary-native': pin},
         'nodeIdentity': pin, 'sourceIdentity': dummy_pin, 'packageIdentity': dummy_pin}
    # Unique executable identities are mandatory in the watcher; use actual tiny system binaries as distinct inert allowlist entries.
    m['executableIdentities']['codex-native'] = o.file_identity(Path('/bin/cat'))
    m['executableIdentities']['claude-auxiliary-native'] = o.file_identity(Path('/bin/echo'))
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

test('frozen predecessor scoped stage is rejected by compact-only observer', lambda: unsupported_stage('F2_SCOPED_SHORT_SESSION', 'old-stage'))
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


def empty_live_observer():
    output = DIRECTORY / 'empty-passive-session'
    process = subprocess.Popen([sys.executable, str(SOURCE), '--manifest', str(manifest), '--manifest-sha256', manifest_pin['sha256'], '--output', str(output), '--max-seconds', '10', '--drain-seconds', '.2'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + 7
    while time.monotonic() < deadline and not (output / 'ready.json').exists() and process.poll() is None: time.sleep(.02)
    assert (output / 'ready.json').exists(), process.communicate(timeout=5)
    ready = json.loads((output / 'ready.json').read_text()); o.write_new(Path(ready['stopContract']['path']), ready['stopContract']['content'])
    stdout, stderr = process.communicate(timeout=8)
    result = json.loads((output / 'result.json').read_text())
    assert process.returncode == 0, (stdout, stderr, result)
    assert result['candidateCount'] == 0 and result['observedKernelExits'] == 0 and result['collectionComplete']
    assert result['status'] == 'RECORDED_PASSIVE_PROCESS_EVIDENCE'
    assert o.file_identity(manifest) == manifest_pin
    assert all(not Path(p).exists() for p in fixture['windows']['A']['receiptPaths'] + fixture['windows']['A']['auxiliaryReceiptPaths'])
test('actual passive startup and explicit stop launch no target or receipt writes', empty_live_observer)

report = {'status': 'PASS' if all(c['status'] == 'PASS' for c in checks) else 'FAIL', 'checks': checks, 'observer': o.file_identity(SOURCE), 'checker': o.file_identity(Path(__file__).resolve()), 'nativeInputs': 0, 'editorLaunches': 0, 'targetProcessesLaunched': 0, 'scope': 'Synthetic ownership/receipt boundary controls plus real empty external observer start/stop. No actual native target ownership claim from this control.'}
o.write_new(DIRECTORY / 'checks.json', report)
print(json.dumps({'path': str(DIRECTORY / 'checks.json'), 'status': report['status'], 'checks': len(checks), 'failures': [r for r in checks if r['status'] != 'PASS']}))
raise SystemExit(0 if report['status'] == 'PASS' else 1)
