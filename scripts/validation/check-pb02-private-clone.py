#!/usr/bin/env python3
"""Tiny real clonefile controls and explicit fail-closed synthetic boundaries."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import mock

sys.dont_write_bytecode = True
HELPER = Path(__file__).with_name('pb02-private-clone.py').resolve()
spec = importlib.util.spec_from_file_location('pb02_private_clone', HELPER)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
ROOT = Path(tempfile.mkdtemp(prefix='private-clone-controls-', dir=h.PB02_ROOT)).resolve()
checks = []


def fixture(name):
    case = ROOT / name
    source = case / 'source'
    (source / 'package').mkdir(parents=True)
    (source / '.bin').mkdir()
    (source / 'empty').mkdir()
    (source / 'package/tool').write_bytes(b'#!/bin/sh\necho owned\n')
    (source / 'package/tool').chmod(0o751)
    (source / 'data').write_bytes(bytes(range(256)) * 4)
    (source / '.bin/tool').symlink_to('../package/tool')
    return case, source, case / 'destination', case / 'report.json'


def check(name, function):
    try:
        detail = function()
        checks.append(dict(name=name, status='PASS', detail=detail))
    except Exception as error:
        checks.append(dict(name=name, status='FAIL', error=repr(error)))


def positive():
    case, source, destination, report = fixture('actual-clone')
    result = h.clone_private(source, destination, report)
    assert result['status'] == 'PASS_PRIVATE_CLONE', result
    assert result['successfulCloneCalls'] == 3
    assert result['sourceTreeSha256'] == result['targetTreeSha256']
    assert result['sourceMetadataSha256'] != result['targetMetadataSha256']
    assert result['python']['executableSha256'] == h.sha_file(Path(sys.executable).resolve())
    assert (destination/'package/tool').stat().st_mode & 0o777 == 0o751
    assert os.readlink(destination/'.bin/tool') == '../package/tool'
    original = (destination/'data').read_bytes()
    (source/'data').write_bytes(b'original changed')
    assert (destination/'data').read_bytes() == original
    (destination/'data').write_bytes(b'copy changed')
    assert (source/'data').read_bytes() == b'original changed'
    for tree in (source, destination):
        assert (tree/'data').stat().st_nlink == 1
    return dict(report=str(report), twoWayIsolation=True, executableModePreserved=True)


def cli_positive():
    case, source, destination, report = fixture('actual-cli')
    result = subprocess.run([sys.executable, str(HELPER), '--source', str(source), '--destination',
                             str(destination), '--report', str(report)], capture_output=True, text=True)
    (case/'stdout.txt').write_text(result.stdout)
    (case/'stderr.txt').write_text(result.stderr)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['status'] == 'PASS_PRIVATE_CLONE'
    return dict(report=str(report), exitCode=result.returncode)


def reject(name, mutate, expect_raise=False):
    case, source, destination, report = fixture(name)
    source, destination, report = mutate(case, source, destination, report)
    if expect_raise:
        try:
            h.clone_private(source, destination, report)
        except (ValueError, FileExistsError, FileNotFoundError):
            assert not os.path.lexists(destination)
            return dict(rejectedBeforeReportReservation=True)
        raise AssertionError('Expected a boundary exception')
    result = h.clone_private(source, destination, report)
    assert result['status'] == 'REJECTED_PREFLIGHT', result
    assert result['destinationCreated'] is False
    assert result['successfulCloneCalls'] == 0
    return dict(report=str(report), error=result['error'])


def source_link(kind):
    def mutate(case, source, destination, report):
        link = source/'unsafe'
        if kind == 'absolute-internal': link.symlink_to(source/'data')
        elif kind == 'external-relative':
            (case/'outside').write_bytes(b'untouched')
            link.symlink_to('../outside')
        elif kind == 'dangling': link.symlink_to('missing')
        elif kind == 'cyclic':
            link.symlink_to('cycle'); (source/'cycle').symlink_to('unsafe')
        elif kind == 'directory-ancestor':
            (source/'package/up').symlink_to('.')
        elif kind == 'hardlink': os.link(source/'data', link)
        elif kind == 'fifo': os.mkfifo(link)
        return source,destination,report
    return mutate


def nested(case, source, destination, report):
    return source,source/'destination',report


def source_symlink(case, source, destination, report):
    alias = case/'source-alias'; alias.symlink_to('source')
    return alias,destination,report


def target_parent_symlink(case, source, destination, report):
    (case/'real-parent').mkdir(); (case/'alias-parent').symlink_to('real-parent')
    return source,case/'alias-parent/destination',report


def existing_destination():
    case,source,destination,report=fixture('existing-destination')
    destination.mkdir(); (destination/'sentinel').write_bytes(b'keep')
    result=h.clone_private(source,destination,report)
    assert result['status']=='REJECTED_PREFLIGHT'
    assert list(destination.iterdir())==[destination/'sentinel']
    assert (destination/'sentinel').read_bytes()==b'keep'
    return dict(report=str(report),existingBytesPreserved=True)


def existing_report():
    case,source,destination,report=fixture('existing-report')
    report.write_bytes(b'existing evidence')
    try: h.clone_private(source,destination,report)
    except FileExistsError: pass
    else: raise AssertionError('Existing report overwritten')
    assert report.read_bytes()==b'existing evidence' and not destination.exists()


def report_inside_source():
    case,source,destination,report=fixture('report-in-source')
    before=h.inspect_tree(source)
    try: h.clone_private(source,destination,source/'report.json')
    except ValueError: pass
    else: raise AssertionError('Source report accepted')
    assert h.inspect_tree(source)==before and not destination.exists()


def report_inside_aliased_source():
    case,source,destination,report=fixture('report-in-aliased-source')
    alias=case/'source-alias';alias.symlink_to('source')
    before=h.inspect_tree(source)
    try: h.clone_private(alias,destination,source/'report.json')
    except ValueError: pass
    else: raise AssertionError('Aliased source report accepted')
    assert h.inspect_tree(source)==before and not destination.exists()


def report_parent_link():
    case,source,destination,report=fixture('report-parent-link')
    target=case/'report-target';target.mkdir();alias=case/'report-alias';alias.symlink_to('report-target')
    try: h.clone_private(source,destination,alias/'report.json')
    except ValueError: pass
    else: raise AssertionError('Symlink report parent accepted')
    assert not list(target.iterdir()) and not destination.exists()


def prepared_guard(name, marker, for_report=False):
    case,source,destination,report=fixture(name)
    owned=case/'previous-run'; owned.mkdir(); (owned/marker).write_text('{}')
    target=owned/'nested'; target.mkdir()
    before=h.inspect_tree(owned)
    if for_report:
        try: h.clone_private(source,destination,target/'report.json')
        except ValueError: pass
        else: raise AssertionError('Prior report tree mutated')
    else:
        result=h.clone_private(source,target/'destination',report)
        assert result['status']=='REJECTED_PREFLIGHT'
    assert h.inspect_tree(owned)==before


def absent_backend():
    case,source,destination,report=fixture('unavailable-backend')
    with mock.patch.object(h, 'CloneBackend', side_effect=RuntimeError('controlled unavailable clonefile')):
        result=h.clone_private(source,destination,report)
    assert result['status']=='REJECTED_PREFLIGHT' and not destination.exists()
    return dict(report=str(report),noFallback=True)


def backend_failure():
    case,source,destination,report=fixture('backend-failure')
    actual=h.CloneBackend.copy
    calls=[]
    def fail_second(self, original, copied):
        calls.append(str(original))
        if len(calls)==2: raise OSError(errno.ENOSYS,'controlled unavailable clonefile')
        return actual(self,original,copied)
    before=h.inspect_tree(source)
    with mock.patch.object(h.CloneBackend,'copy',fail_second):
        result=h.clone_private(source,destination,report)
    assert result['status']=='PARTIAL_PRIVATE_CLONE' and destination.is_dir()
    assert result['successfulCloneCalls']==1 and result['partialDestinationPreserved'] is True
    assert result['error']['errno']==errno.ENOSYS and h.inspect_tree(source)==before
    assert (destination/'.bin/tool').is_symlink() and not (destination/'data').exists()
    return dict(report=str(report),partialPreserved=True,noFallback=True)


def source_race():
    case,source,destination,report=fixture('source-race')
    actual=h.CloneBackend.copy
    def change_source(self,original,copied):
        actual(self,original,copied)
        if original.name=='tool' and not original.is_symlink():
            original.write_bytes(b'controlled concurrent source mutation')
    with mock.patch.object(h.CloneBackend,'copy',change_source):
        result=h.clone_private(source,destination,report)
    assert result['status']=='PARTIAL_PRIVATE_CLONE' and result['partialDestinationPreserved']
    assert 'changed during copying' in result['error']['message']
    return dict(report=str(report),sourceRaceRejected=True)


def external_directory_link():
    case,source,destination,report=fixture('external-directory-link')
    external=case/'external'; external.mkdir(); os.mkfifo(external/'not-traversed')
    (source/'alias').symlink_to('../external')
    result=h.clone_private(source,destination,report)
    assert result['status']=='REJECTED_PREFLIGHT'
    assert 'Symbolic link must resolve' in result['error']['message']


def directory_link():
    case,source,destination,report=fixture('internal-directory-link')
    (source/'alias').symlink_to('package')
    result=h.clone_private(source,destination,report)
    assert result['status']=='PASS_PRIVATE_CLONE'
    assert os.readlink(destination/'alias')=='package'
    assert result['sourceRegularFiles']==2 and result['sourceSymlinks']==2


check('actual syscall clones preserve modes, links, distinct inodes and two-way mutation isolation',positive)
check('actual CLI writes exclusive PASS report and exits zero',cli_positive)
for kind in ('absolute-internal','external-relative','dangling','cyclic','directory-ancestor','hardlink','fifo'):
    check('source rejects '+kind,lambda kind=kind:reject('reject-'+kind,source_link(kind)))
check('source and target must be disjoint',lambda:reject('nested-destination',nested))
check('source root cannot be a symlink',lambda:reject('symlink-source',source_symlink))
check('target parent cannot be a symlink',lambda:reject('symlink-parent',target_parent_symlink))
check('existing destination bytes are never overwritten',existing_destination)
check('existing report bytes are never overwritten',existing_report)
check('report inside source rejected before reserving or changing source',report_inside_source)
check('report inside aliased source rejected before source mutation',report_inside_aliased_source)
check('report parent symlink rejected without mutation',report_parent_link)
for marker in ('prepared.json','campaign.json'):
    check('target rejects ancestor '+marker,lambda marker=marker:prepared_guard('target-'+marker,marker))
    check('report rejects ancestor '+marker,lambda marker=marker:prepared_guard('report-'+marker,marker,True))
check('missing clone backend rejected before destination creation',absent_backend)
check('backend failure preserves partial tree and actual error, no fallback',backend_failure)
check('full source metadata recheck rejects concurrent mutation',source_race)
check('external directory symlink rejected without walking target',external_directory_link)
check('internal directory symlink retained without double-counting its target',directory_link)
check('source outside PB02 rejected',lambda:reject('outside-source',lambda case,source,destination,report:(Path('/tmp'),destination,report)))
check('target outside PB02 rejected',lambda:reject('outside-target',lambda case,source,destination,report:(source,Path('/tmp/pb02-clone-disallowed'),report)))
check('relative source rejected',lambda:reject('relative-source',lambda case,source,destination,report:('relative-source',destination,report)))

report=dict(status='PASS' if all(row['status']=='PASS' for row in checks) else 'FAIL',checks=checks,
            realProviderInputs=0,fullDependencyCopies=0,helper=dict(path=str(HELPER),sha256=h.sha_file(HELPER)),
            checker=dict(path=str(Path(__file__).resolve()),sha256=h.sha_file(Path(__file__).resolve())),
            scope='Tiny actual clonefile/CLI and synthetic boundary/failure controls; no inference, full fixture copy or measured large-tree savings.')
target=ROOT/'checks.json'
with target.open('x') as stream: json.dump(report,stream,indent=2);stream.write('\n')
print(json.dumps(dict(path=str(target),status=report['status'],passed=sum(row['status']=='PASS' for row in checks),
                     total=len(checks),failures=[row for row in checks if row['status']!='PASS'])))
raise SystemExit(0 if report['status']=='PASS' else 1)
