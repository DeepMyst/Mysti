#!/usr/bin/env python3
"""Passive, additive PB-02 process evidence. Never launches/signals a target."""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[2]
PB02 = REPO / 'out-test/feature-tests/PB-02'
WATCHER = Path(__file__).with_name('pb02-kqueue-watch.py')
MAX_FILE = 16 * 1024 * 1024


def check(condition, message):
    if not condition:
        raise ValueError(message)


def contained(root, path):
    check(path != root and root in path.parents, 'Path must be strictly within owned root')


def read_regular(path, limit=MAX_FILE):
    path = Path(path)
    check(path.is_absolute() and path.resolve(strict=True) == path, 'Exact real file required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        check(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit, 'Bounded private regular file required')
        data = b''
        while len(data) <= limit:
            block = os.read(fd, min(65536, limit + 1 - len(data)))
            if not block:
                break
            data += block
        check(len(data) <= limit, 'File grew beyond bound')
        return data, s
    finally:
        os.close(fd)


def file_identity(path):
    path = Path(path)
    check(path.is_absolute() and path.resolve(strict=True) == path and path.is_file(), 'Exact identity path required')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return {'path': str(path), 'sha256': h.hexdigest()}


def verify_pin(pin):
    check(file_identity(pin['path']) == pin, 'Pinned file changed')


def write_new(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def load_kernel():
    spec = importlib.util.spec_from_file_location('pb02_kqueue_watch', WATCHER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def birth_key(row):
    return (row['pid'], row['startSec'], row['startUsec'])


def ps_birth(row):
    value = time.localtime(row['startSec'])
    return time.strftime('%a %b', value) + ' ' + str(value.tm_mday) + time.strftime(' %H:%M:%S %Y', value)


def matches_ancestry(row, observed):
    return row['pid'] == observed['pid'] and ps_birth(row) == ' '.join(observed['startedAt'].split())


def validate_manifest(path, expected_sha):
    raw, _ = read_regular(path)
    check(hashlib.sha256(raw).hexdigest() == expected_sha, 'Exact prepared manifest hash required')
    m = json.loads(raw)
    check(m['case'] == 'PB-02' and m['stage'] == 'F2_SIGNED_WEBHOOKS', 'Only signed-webhook F2 stage supported')
    artifact = Path(m['artifactDir']); contained(PB02, artifact)
    check(artifact.resolve(strict=True) == artifact and Path(path) == artifact / 'prepared.json', 'Exact artifact/manifest relation required')
    check(m['preparedBeforeActivation'] is True and list(m['windows']) == ['A'], 'Prepared single ordinary window required')
    for name in ['launch-reservation.json', 'native-result.json']:
        check(not (artifact / name).exists(), 'Observer must start before this editor launch')
    owner = m['windows']['A']
    check(owner['id'] == 'A' and Path(owner['directory']) == artifact / 'window-A', 'Exact owned window required')
    cli = Path(owner['cliDirectory']); check(cli == Path(owner['directory']) / 'cli' and cli.resolve(strict=True) == cli, 'Exact private CLI directory required')
    check(not (Path(owner['directory']) / 'process-ancestry.json').exists(), 'No prior ancestry may exist')
    pins = m['wrapperIdentities'] + m['harnessDependencyIdentities'] + list(m['executableIdentities'].values()) + [m['nodeIdentity'], m['sourceIdentity'], m['packageIdentity']]
    for pin in pins:
        verify_pin(pin)
    wrappers = {pin['path']: pin for pin in m['wrapperIdentities']}
    for provider in ['openai-codex', 'claude-code']:
        check(owner['wrappers'][provider] in wrappers, 'Wrapper launcher must be pinned')
    paths = owner['receiptPaths'] + owner['auxiliaryReceiptPaths']
    check(len(paths) == 2 and len(set(paths)) == 2, 'Two exact receipt paths required')
    for p in paths:
        p = Path(p); check(p.parent == cli, 'Receipt must be in owned CLI directory')
        if p.exists() or p.is_symlink():
            data, _ = read_regular(p); check(not data, 'No preexisting receipt bytes permitted')
    executable_pins = [m['nodeIdentity'], m['executableIdentities']['codex-native'], m['executableIdentities']['claude-auxiliary-native']]
    for pin in executable_pins:
        verify_pin(pin)
    editor = REPO / '.vscode-test/vscode-darwin-arm64-1.141.0/Visual Studio Code.app/Contents/MacOS/Code'
    return m, executable_pins, file_identity(editor)


def validate_output(path, artifact):
    contained(PB02, path)
    check(path.parent.resolve(strict=True) == path.parent, 'Existing real output parent required')
    check(not path.exists() and not path.is_symlink(), 'Exclusive new observer output directory required')
    check(artifact not in path.parents and path not in artifact.parents, 'Separate sibling evidence required')
    for ancestor in path.parents:
        if ancestor == PB02:
            break
        check(not (ancestor / 'prepared.json').exists() and not (ancestor / 'campaign.json').exists(), 'Never write within a prepared run')


class ReceiptTail:
    def __init__(self, path):
        self.path = Path(path)
        self.offset = 0
        self.pending = b''
        self.inode = None
        self.digest = hashlib.sha256()

    def read(self):
        if not self.path.exists() and not self.path.is_symlink():
            return []
        check(self.path.resolve(strict=True) == self.path, 'Receipt path must remain real')
        fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            s = os.fstat(fd)
            check(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'Receipt must be private regular file')
            inode = (s.st_dev, s.st_ino)
            if self.inode is None:
                self.inode = inode
            check(inode == self.inode and s.st_size >= self.offset, 'Receipt replaced or truncated')
            check(s.st_size <= 64 * 1024 * 1024, 'Receipt size cap reached')
            os.lseek(fd, self.offset, os.SEEK_SET)
            data = os.read(fd, 2 * 1024 * 1024)
            self.offset += len(data); self.digest.update(data); self.pending += data
            check(len(self.pending) <= 4 * 1024 * 1024, 'Receipt line cap reached')
            rows = []
            while b'\n' in self.pending:
                line, self.pending = self.pending.split(b'\n', 1)
                start = self.offset - len(self.pending) - len(line) - 1
                value = json.loads(line)
                if value.get('event') in ['start', 'auxiliary-start', 'probe-start']:
                    check(value.get('window') == 'A', 'Receipt window mismatch')
                    check(all(isinstance(value.get(k), int) and value[k] > 0 for k in ['wrapperPid', 'childPid', 'at']), 'Malformed process receipt')
                    expected = 'claude-code' if 'auxiliary' in self.path.name else 'openai-codex'
                    check(value.get('provider') == expected, 'Receipt provider mismatch')
                    rows.append({'path': str(self.path), 'offset': start, 'bytes': len(line) + 1, 'sha256': hashlib.sha256(line + b'\n').hexdigest(),
                                 **{k: value[k] for k in ['event', 'wrapperPid', 'childPid', 'at', 'provider']}})
            return rows
        finally:
            os.close(fd)

    def report(self):
        pin = file_identity(self.path) if self.path.exists() else None
        return {'path': str(self.path), 'bytesRead': self.offset, 'sha256': self.digest.hexdigest(), 'partialLineBytes': len(self.pending), 'inode': self.inode,
                'finalIdentity': pin, 'completeUnchangedRead': (pin is None and self.offset == 0) or (pin is not None and pin['sha256'] == self.digest.hexdigest() and self.path.stat().st_size == self.offset and not self.pending)}


def owner_chain(wrapper, receipt, ancestry, kernel, editor_pin, own, started_ms):
    check(wrapper['uid'] == own['uid'], 'UID mismatch')
    check(wrapper['startSec'] * 1000 + wrapper['startUsec'] / 1000 >= started_ms - 1000, 'Wrapper predates observer')
    check(wrapper['startSec'] * 1000 + wrapper['startUsec'] / 1000 <= receipt['at'] + 10, 'Receipt PID reused after receipt')
    details = ancestry['processDetails']
    check(ancestry['window'] == 'A' and details and matches_ancestry(wrapper, next(row for row in details if row['pid'] == wrapper['pid'])), 'Wrapper birth absent from owned ancestry')
    root = details[0]; chain = [wrapper]; seen = {wrapper['pid']}
    while chain[-1]['pid'] != root['pid']:
        check(len(chain) < 24 and chain[-1]['ppid'] not in seen and chain[-1]['ppid'] > 1, 'No current owned editor ancestry')
        parent = kernel.identity(chain[-1]['ppid']); check(parent['uid'] == own['uid'], 'Ancestor UID mismatch')
        seen.add(parent['pid']); chain.append(parent)
    check(matches_ancestry(chain[-1], root) and chain[-1]['executablePath'] == editor_pin['path'], 'Editor root identity mismatch')
    verify_pin(editor_pin)
    check(all(row['pgid'] != own['pgid'] and row['pid'] != own['pid'] for row in chain), 'Observer must be outside target editor group')
    return chain


def child_pids(kernel, pid):
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    fn = library.proc_listchildpids
    fn.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]; fn.restype = ctypes.c_int
    buffer = (ctypes.c_int * 256)()
    count = fn(pid, buffer, ctypes.sizeof(buffer))
    check(0 <= count < 256, 'Child enumeration failed or exceeded bound')
    return [int(buffer[i]) for i in range(count) if buffer[i] > 0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True); parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--output', required=True); parser.add_argument('--max-seconds', type=int, default=4200)
    parser.add_argument('--drain-seconds', type=float, default=2)
    args = parser.parse_args()
    check(sys.platform == 'darwin', 'macOS kernel observer only')
    check(1 <= args.max_seconds <= 4200 and 0.2 <= args.drain_seconds <= 10, 'Bounded observer deadlines required')
    manifest_path = Path(args.manifest); output = Path(args.output)
    m, allowed, editor_pin = validate_manifest(manifest_path, args.manifest_sha256)
    validate_output(output, Path(m['artifactDir']))
    kernel = load_kernel(); own = kernel.identity(os.getpid()); started_ms = int(time.time() * 1000)
    output.mkdir(mode=0o700)
    event_file = output / 'discovery.jsonl'
    event_fd = os.open(event_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    seq = 0
    def record(event, **values):
        nonlocal seq
        seq += 1
        os.write(event_fd, (json.dumps({'seq': seq, 'at': time.time(), 'event': event, **values}) + '\n').encode())
    manifest_pin = {'path': str(manifest_path), 'sha256': args.manifest_sha256}
    config = {'schemaVersion': 1, 'controller': {k: own[k] for k in ['pid', 'startSec', 'startUsec']}, 'allowedExecutables': allowed,
              'manifestIdentity': manifest_pin, 'outputRoot': str(output)}
    write_new(output / 'watcher-config.json', config)
    stderr = (output / 'watcher-stderr.log').open('xb')
    watcher = subprocess.Popen([sys.executable, str(WATCHER), '--config', str(output / 'watcher-config.json'), '--output', str(output / 'kernel-events.jsonl')],
                               stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=stderr, start_new_session=True)
    tails = [ReceiptTail(p) for p in m['windows']['A']['receiptPaths'] + m['windows']['A']['auxiliaryReceiptPaths']]
    pending = []; roots = {}; watched = set(); candidate_count = 0; gaps = []; token = secrets.token_hex(24)
    stop_reason = 'maximum-duration'; end = time.monotonic() + args.max_seconds; drain_end = None
    allowed_map = {pin['path']: pin for pin in allowed}; node_path = m['nodeIdentity']['path']
    ancestry_file = Path(m['windows']['A']['directory']) / 'process-ancestry.json'
    def gap(reason, reference=None):
        value = {'reason': reason, 'reference': reference}; gaps.append(value); record('discovery-unknown', **value)
    def send_watch(target, reference, chain):
        nonlocal candidate_count
        key = birth_key(target)
        if key in watched:
            return
        check(target['executablePath'] in allowed_map and target['uid'] == own['uid'], 'Candidate executable/UID outside allowlist')
        verify_pin(allowed_map[target['executablePath']])
        candidate_count += 1; check(candidate_count <= 512, 'Candidate cap exceeded')
        request_id = 'p' + str(candidate_count)
        watch_target = {**{k: target[k] for k in ['pid', 'startSec', 'startUsec', 'ppid', 'pgid']},
                        'executablePath': target['executablePath'], 'executableSha256': allowed_map[target['executablePath']]['sha256']}
        record('watch-candidate', requestId=request_id, target=target, receipt=reference, ancestry=chain)
        watcher.stdin.write((json.dumps({'op': 'watch', 'requestId': request_id, 'target': watch_target}) + '\n').encode()); watcher.stdin.flush()
        watched.add(key)
    try:
        # Ready is published only after the kernel watcher has reported its own ready event.
        ready_deadline = time.monotonic() + 5
        while time.monotonic() < ready_deadline:
            check(watcher.poll() is None, 'Kernel watcher exited before ready')
            kernel_file = output / 'kernel-events.jsonl'
            if kernel_file.exists():
                raw, _ = read_regular(kernel_file)
                if any(json.loads(line).get('event') == 'ready' for line in raw.splitlines() if line):
                    break
            time.sleep(.02)
        else:
            raise TimeoutError('Kernel watcher readiness unavailable')
        write_new(output / 'ready.json', {'status': 'READY_PASSIVE_NO_TARGET_INPUTS', 'observer': own, 'watcherPid': watcher.pid, 'manifest': manifest_pin,
                  'stopContract': {'path': str(output / 'stop.json'), 'content': {'token': token, 'manifestSha256': args.manifest_sha256, 'reason': 'root-run-complete'}},
                  'observerSource': file_identity(Path(__file__).resolve()), 'watcherSource': file_identity(WATCHER), 'allowedExecutables': allowed, 'editorIdentity': editor_pin,
                  'pollIntervalMs': 100, 'maximumSeconds': args.max_seconds, 'drainSeconds': args.drain_seconds})
        while time.monotonic() < end:
            check(watcher.poll() is None, 'Kernel watcher exited while observing')
            for tail in tails:
                for row in tail.read():
                    record('receipt-start', reference=row); pending.append((row, time.monotonic())); check(len(pending) <= 512, 'Pending discovery cap exceeded')
            ancestry = None
            if ancestry_file.exists():
                try:
                    raw, _ = read_regular(ancestry_file); ancestry = json.loads(raw)
                except json.JSONDecodeError:
                    pass  # Frozen runner updates this live file non-atomically; next sample may complete it.
            for receipt, first_seen in pending[:]:
                try:
                    wrapper = kernel.identity(receipt['wrapperPid'])
                    check(wrapper['executablePath'] == node_path, 'Wrapper executable mismatch')
                    if ancestry is None:
                        continue
                    chain = owner_chain(wrapper, receipt, ancestry, kernel, editor_pin, own, started_ms)
                    record('owned-ancestry-join', receipt=receipt, source={'path': str(ancestry_file), 'sha256': hashlib.sha256(raw).hexdigest(), 'sampledAt': ancestry.get('sampledAt')},
                           wrapperRow=next(row for row in ancestry['processDetails'] if row['pid'] == wrapper['pid']), rootRow=ancestry['processDetails'][0], liveChain=chain)
                    child = kernel.identity(receipt['childPid'])
                    check(child['ppid'] == wrapper['pid'] and child['startSec'] * 1000 + child['startUsec'] / 1000 <= receipt['at'] + 10, 'Receipt child parent/birth mismatch')
                    send_watch(wrapper, receipt, chain)
                    send_watch(child, receipt, [child] + chain)
                    roots[birth_key(wrapper)] = (wrapper, receipt, chain)
                    roots[birth_key(child)] = (child, receipt, [child] + chain)
                    pending.remove((receipt, first_seen))
                except (ProcessLookupError, StopIteration):
                    if time.monotonic() - first_seen > 1:
                        gap('late-or-missing-live-owned-identity', receipt); pending.remove((receipt, first_seen))
                except ValueError as error:
                    gap(str(error), receipt); pending.remove((receipt, first_seen))
            for key, (parent, receipt, chain) in list(roots.items()):
                try:
                    current = kernel.identity(parent['pid'])
                    if birth_key(current) != key:
                        roots.pop(key); continue
                    for pid in child_pids(kernel, parent['pid']):
                        try:
                            child = kernel.identity(pid)
                            if child['ppid'] != parent['pid'] or child['executablePath'] not in allowed_map:
                                continue
                            send_watch(child, receipt, [child] + chain)
                            roots.setdefault(birth_key(child), (child, receipt, [child] + chain))
                        except ProcessLookupError:
                            gap('child-disappeared-before-owned-registration', {'parent': parent['pid'], 'pid': pid})
                except ProcessLookupError:
                    roots.pop(key)
            stop_path = output / 'stop.json'
            if stop_path.exists() or stop_path.is_symlink():
                stop_raw, _ = read_regular(stop_path, 4096); stop = json.loads(stop_raw)
                check(stop == {'token': token, 'manifestSha256': args.manifest_sha256, 'reason': 'root-run-complete'}, 'Invalid stop request')
                if drain_end is None:
                    stop_reason = 'explicit-root-stop'; drain_end = time.monotonic() + args.drain_seconds
                    record('stop-requested', stopSha256=hashlib.sha256(stop_raw).hexdigest())
                if time.monotonic() >= drain_end:
                    break
            time.sleep(.1)
    except Exception as error:
        stop_reason = 'observer-error'; gap(type(error).__name__ + ': ' + str(error))
    finally:
        for receipt, _ in pending:
            gap('pending-discovery-at-stop', receipt)
        try:
            watcher.stdin.write((json.dumps({'op': 'stop', 'reason': stop_reason}) + '\n').encode()); watcher.stdin.flush(); watcher.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            code = watcher.wait(timeout=5)
        except subprocess.TimeoutExpired:
            code = None; gap('watcher-did-not-exit-after-stop-no-signal-sent')
        stderr.close(); os.close(event_fd)
        pins_unchanged = file_identity(manifest_path) == manifest_pin
        kernel_path = output / 'kernel-events.jsonl'
        kernel_rows = [json.loads(line) for line in kernel_path.read_text().splitlines()] if kernel_path.exists() else []
        unknown_events = [row for row in kernel_rows if row.get('status') == 'UNKNOWN']
        receipt_reports = [tail.report() for tail in tails]
        complete = stop_reason == 'explicit-root-stop' and code == 0 and pins_unchanged and all(row['completeUnchangedRead'] for row in receipt_reports)
        status = 'RECORDED_PASSIVE_PROCESS_EVIDENCE' if complete and not gaps and not unknown_events else 'PARTIAL_PASSIVE_OBSERVER'
        write_new(output / 'result.json', {'status': status, 'stopReason': stop_reason, 'watcherExitCode': code, 'manifestUnchanged': pins_unchanged,
                  'collectionComplete': complete, 'candidateCount': candidate_count, 'observedKernelExits': sum(row.get('event') == 'process-exit' for row in kernel_rows),
                  'kernelUnknownEvents': len(unknown_events), 'discoveryGaps': gaps, 'receipts': receipt_reports,
                  'events': file_identity(event_file), 'kernelEvents': file_identity(output / 'kernel-events.jsonl') if (output / 'kernel-events.jsonl').exists() else None,
                  'scope': 'Kernel process statuses only. Registration errors, missing events and discovery gaps remain unknown. No target signals, inputs, reparenting or cancellation changes. Short-lived descendants between polls may be missed; no model/tool/helper completion or historical acceptance credit.'})
    return 0 if status == 'RECORDED_PASSIVE_PROCESS_EVIDENCE' else 1


if __name__ == '__main__':
    raise SystemExit(main())
