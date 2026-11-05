#!/usr/bin/env python3
"""Synthetic signed-webhook-stage passive review controls; launches no processes."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import select
import sys
import tempfile

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
ROOT = REPO / 'out-test/feature-tests/PB-02'
BASE = ROOT / 'overnight-20261011'
SOURCE = BASE / 'root-review-signed-webhook-passive-processes.py'
PREVIOUS = BASE / 'root-review-verification-passive-processes.py'
OBSERVER = REPO / 'scripts/validation/observe-pb02-signed-webhook-native-processes.py'
OLD_OBSERVER = REPO / 'scripts/validation/observe-pb02-verification-native-processes.py'
DIRECTORY = Path(tempfile.mkdtemp(prefix='signed-webhook-passive-review-controls-', dir=ROOT))
source = SOURCE.read_bytes()
checks = []
index = 0


def pin(file):
    return {'path': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}


predecessors = [pin(PREVIOUS), pin(OLD_OBSERVER)]


def save(file, value):
    with file.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def test(name, run):
    try:
        run()
        checks.append({'name': name, 'status': 'PASS'})
    except Exception as error:
        checks.append({'name': name, 'status': 'FAIL', 'error': repr(error)})


def fixture():
    global index
    index += 1
    base = DIRECTORY / f'fixture-{index:02}'
    base.mkdir()
    directory = base / 'signed-webhook-segment-1-passive-processes'
    directory.mkdir()
    inert = {}
    for name in ['manifest', 'observer', 'watcher', 'editor', 'node', 'native']:
        file = base / (name + '.inert')
        file.write_text('Inert synthetic qualification bytes: ' + name + '\n')
        inert[name] = pin(file)
    uid = os.getuid()
    editor = {'pid': 1010, 'ppid': 1000, 'pgid': 1010, 'uid': uid, 'startSec': 99, 'startUsec': 1, 'executablePath': inert['editor']['path']}
    wrapper = {'pid': 1011, 'ppid': 1010, 'pgid': 1010, 'uid': uid, 'startSec': 100, 'startUsec': 1, 'executablePath': inert['node']['path']}
    child = {'pid': 1012, 'ppid': 1011, 'pgid': 1010, 'uid': uid, 'startSec': 100, 'startUsec': 2, 'executablePath': inert['native']['path']}
    receipt = {'window': 'A', 'provider': 'openai-codex', 'event': 'start', 'wrapperPid': 1011, 'childPid': 1012, 'at': 100100}
    raw = (json.dumps(receipt) + '\n').encode()
    file = base / 'openai-codex-receipts.jsonl'
    file.write_bytes(raw)
    reference = {'path': str(file), 'offset': 0, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                 **{key: receipt[key] for key in ['event', 'wrapperPid', 'childPid', 'at', 'provider']}}
    discovery = [{'seq': 1, 'at': 200, 'event': 'watch-candidate', 'requestId': 'p1', 'target': child.copy(),
                  'receipt': reference, 'ancestry': [child.copy(), wrapper.copy(), editor.copy()]}]
    target = {key: child[key] for key in ['pid', 'startSec', 'startUsec', 'ppid', 'pgid', 'executablePath']}
    target['executableSha256'] = inert['native']['sha256']
    kernel = [{'seq': 1, 'at': 200001, 'event': 'watch-armed', 'requestId': 'p1', 'target': target.copy(),
               'before': child.copy(), 'after': child.copy(), 'token': 991},
              {'seq': 2, 'at': 200005, 'event': 'process-exit', 'requestId': 'p1', 'target': target.copy(), 'token': 991,
               'raw': {'ident': 1012, 'filter': select.KQ_FILTER_PROC, 'flags': 0, 'fflags': select.KQ_NOTE_EXIT | 0x04000000, 'data': 0, 'udata': 991},
               'rawWaitStatus': 0, 'exited': True, 'signaled': False, 'exitCode': 0, 'signal': None}]
    ready = {'manifest': inert['manifest'], 'observerSource': inert['observer'], 'watcherSource': inert['watcher'],
             'editorIdentity': inert['editor'], 'allowedExecutables': [inert['node'], inert['native']],
             'observer': {'pid': 2000, 'pgid': 2000, 'uid': uid}}
    result = {'collectionComplete': True, 'stopReason': 'explicit-root-stop', 'watcherExitCode': 0, 'manifestUnchanged': True,
              'candidateCount': 1, 'observedKernelExits': 1, 'kernelUnknownEvents': 0, 'discoveryGaps': [],
              'receipts': [{'path': str(file), 'completeUnchangedRead': True, 'partialLineBytes': 0, 'bytesRead': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}]}
    return {'base': base, 'directory': directory, 'ready': ready, 'result': result, 'discovery': discovery, 'kernel': kernel,
            'receiptFile': file, 'destination': base / 'signed-webhook-segment-1-passive-root-review.json'}


def execute(f, reject=False, segment=1, existing=False):
    for name, rows in [('discovery.jsonl', f['discovery']), ('kernel-events.jsonl', f['kernel'])]:
        file = f['directory'] / name
        file.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        f['result']['events' if name == 'discovery.jsonl' else 'kernelEvents'] = pin(file)
    if f.get('badEventPin'):
        f['result']['events']['sha256'] = '0' * 64
    save(f['directory'] / 'ready.json', f['ready'])
    save(f['directory'] / 'result.json', f['result'])
    before = f['destination'].read_bytes() if existing else None
    previous = sys.argv
    sys.argv = [str(SOURCE), str(segment)]
    error = None
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            # Exact source bytes execute in-process, with only __file__'s base
            # redirected to a new synthetic evidence directory.
            exec(compile(source, str(SOURCE), 'exec'), {'__file__': str(f['base'] / SOURCE.name), '__name__': '__qualification__'})
    except (AssertionError, KeyError, FileNotFoundError, ValueError) as failure:
        error = failure
    finally:
        sys.argv = previous
    if reject:
        assert error is not None, 'Expected invalid evidence to be rejected'
        if existing:
            assert f['destination'].read_bytes() == before, 'Existing output changed'
        else:
            assert not f['destination'].exists(), 'Rejected evidence published a review'
        return
    assert error is None, repr(error)
    return json.loads(f['destination'].read_text())


def prefix_only():
    previous = PREVIOUS.read_bytes()
    assert previous.count(b'verification-segment-') == 2
    assert source == previous.replace(b'verification-segment-', b'signed-webhook-segment-')
    compile(source, str(SOURCE), 'exec')


test('root reviewer is exactly two prefix substitutions from frozen verification helper', prefix_only)


def observer_stage_only():
    expected = OLD_OBSERVER.read_bytes().replace(b'F2_FINAL_PAIR', b'F2_VERIFICATION')
    expected = expected.replace(b'Only verification F2 stage supported', b'Only signed-webhook F2 stage supported')
    assert OBSERVER.read_bytes() == expected
    compile(expected, str(OBSERVER), 'exec')


test('observer differs only in exact supported stage and diagnostic', observer_stage_only)


def valid_join():
    report = execute(fixture())
    assert report['status'] == 'PASS_JOINED_PROSPECTIVE_EXITS'
    assert len(report['verifiedKernelExits']) == 1
    assert report['verifiedKernelExits'][0]['exitCode'] == 0


test('synthetic exact receipt and kernel exit join passes', valid_join)


def gaps_preserved():
    f = fixture()
    f['kernel'].append({'seq': 3, 'at': 200006, 'event': 'watch-error', 'status': 'UNKNOWN'})
    f['result']['kernelUnknownEvents'] = 1
    f['result']['discoveryGaps'] = [{'reason': 'synthetic unobserved short-lived process'}]
    report = execute(f)
    assert report['status'] == 'PASS_JOINED_PROSPECTIVE_EXITS_WITH_GAPS'
    assert len(report['unknownKernelEvents']) == 1 and len(report['discoveryGaps']) == 1


test('unknown kernel events and discovery gaps remain explicit', gaps_preserved)


def mutation(name, change):
    def run():
        f = fixture()
        change(f)
        execute(f, reject=True)
    test(name, run)


mutation('receipt offset cannot select different byte range', lambda f: f['discovery'][0]['receipt'].update(offset=1))
mutation('receipt provider must match exact hashed receipt bytes', lambda f: f['discovery'][0]['receipt'].update(provider='foreign-provider'))
mutation('foreign ancestor UID is rejected', lambda f: f['discovery'][0]['ancestry'][1].update(uid=os.getuid() + 1))
mutation('observer sharing target process group is rejected', lambda f: f['ready']['observer'].update(pgid=1010))
mutation('broken live parent chain is rejected', lambda f: f['discovery'][0]['ancestry'][1].update(ppid=5555))
mutation('editor executable identity must match ancestry root', lambda f: f['discovery'][0]['ancestry'][-1].update(executablePath='/synthetic/foreign-editor'))
mutation('kernel target executable hash must match allowlist', lambda f: [row['target'].update(executableSha256='0' * 64) for row in f['kernel']])
mutation('registration before/after microsecond birth mismatch is rejected', lambda f: f['kernel'][0]['after'].update(startUsec=999))
mutation('kernel raw process ID must match watched target', lambda f: f['kernel'][1]['raw'].update(ident=9999))
mutation('kernel error flag cannot masquerade as process exit', lambda f: f['kernel'][1]['raw'].update(flags=select.KQ_EV_ERROR))
mutation('required kernel exit-status flag cannot be omitted', lambda f: f['kernel'][1]['raw'].update(fflags=select.KQ_NOTE_EXIT))
mutation('registration token must match raw kernel udata', lambda f: f['kernel'][1]['raw'].update(udata=333))
mutation('false decoded exit code is rejected', lambda f: [f['kernel'][1]['raw'].update(data=256), f['kernel'][1].update(rawWaitStatus=256)])
mutation('discovery after registration is rejected after seconds/milliseconds normalization', lambda f: f['discovery'][0].update(at=201))
mutation('incomplete receipt tail cannot qualify', lambda f: f['result']['receipts'][0].update(completeUnchangedRead=False))
mutation('changed pinned event bytes are rejected', lambda f: f.update(badEventPin=True))
mutation('nonsequential event sequence numbers are rejected', lambda f: f['kernel'][1].update(seq=5))


def wrong_prefix():
    f = fixture()
    moved = f['base'] / 'verification-segment-1-passive-processes'
    f['directory'].rename(moved)
    f['directory'] = moved
    execute(f, reject=True)


test('signed-webhook reviewer never falls back to verification-prefix evidence', wrong_prefix)


def existing_output():
    f = fixture()
    f['destination'].write_text('PRESERVE_EXISTING_REVIEW\n')
    execute(f, reject=True, existing=True)


test('preexisting review output is never overwritten', existing_output)
test('invalid segment rejected before review output', lambda: execute(fixture(), reject=True, segment=3))


def originals_preserved():
    for identity in predecessors:
        assert pin(Path(identity['path'])) == identity


test('both verification predecessor source hashes remain unchanged', originals_preserved)
snapshot_dir = DIRECTORY / 'source-snapshots'
snapshot_dir.mkdir()
for file in [SOURCE, PREVIOUS, OBSERVER, OLD_OBSERVER, Path(__file__).resolve()]:
    (snapshot_dir / file.name).write_bytes(file.read_bytes())
report = {'status': 'PASS' if all(row['status'] == 'PASS' for row in checks) else 'FAIL', 'checks': checks,
          'helper': pin(SOURCE), 'checker': pin(Path(__file__).resolve()), 'observer': pin(OBSERVER), 'predecessors': predecessors,
          'syntheticExecution': 'Exact helper source compiled in-process; __file__ base points at each owned synthetic fixture. No subprocess, watcher, editor, model or application launch.',
          'nativeInputs': 0, 'editorLaunches': 0, 'targetProcessesLaunched': 0,
          'limits': ['Synthetic consistency and failure controls only; no real process-exit acceptance credit.',
                     'The root reviewer retains predecessor semantics and delegates manifest-stage and output-path admission to the qualified observer/prelaunch. No independent OS ownership re-observation is claimed.',
                     'The separate signed-webhook observer checker includes an explicitly disclosed zero-target live observer/watch-service startup. This root-review checker does not.']}
save(DIRECTORY / 'checks.json', report)
print(json.dumps({'path': str(DIRECTORY / 'checks.json'), 'sha256': pin(DIRECTORY / 'checks.json')['sha256'], 'status': report['status'],
                  'checks': len(checks), 'failures': [row for row in checks if row['status'] != 'PASS']}))
raise SystemExit(0 if report['status'] == 'PASS' else 1)
