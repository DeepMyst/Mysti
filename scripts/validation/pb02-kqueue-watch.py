#!/usr/bin/env python3
"""Passive, pinned Darwin process watcher. Never sends target inputs/signals."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import select
import stat
import sys
import time

NOTE_EXITSTATUS = 0x04000000
PROC_FLAGS = 0x80000000 | NOTE_EXITSTATUS
PB02_ROOT = Path(__file__).resolve().parents[2] / 'out-test/feature-tests/PB-02'


class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ('flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid', 'rgid', 'svuid', 'svgid', 'reserved')] + [
        ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ('nfiles', 'pgid', 'jobc', 'tdev', 'tpgid')] + [
        ('nice', ctypes.c_int32), ('startSec', ctypes.c_uint64), ('startUsec', ctypes.c_uint64)]


def identity(pid):
    if sys.platform != 'darwin':
        raise RuntimeError('Darwin kernel process identity is required')
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int
    library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    library.proc_pidpath.restype = ctypes.c_int
    info = BsdInfo()
    if library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        raise ProcessLookupError('Complete kernel identity unavailable')
    buffer = ctypes.create_string_buffer(4096)
    size = library.proc_pidpath(pid, buffer, len(buffer))
    return dict(pid=info.pid, ppid=info.ppid, pgid=info.pgid, uid=info.uid,
                startSec=info.startSec, startUsec=info.startUsec,
                executablePath=buffer.value.decode() if size > 0 else None)


def same_birth(actual, expected):
    return all(actual.get(key) == expected.get(key) and actual.get(key) is not None for key in ('pid', 'startSec', 'startUsec'))


def decode(raw):
    if not isinstance(raw, int) or raw < 0 or raw > 0xffffffff:
        raise ValueError('Invalid raw kernel wait status')
    return dict(rawWaitStatus=raw, exited=os.WIFEXITED(raw), signaled=os.WIFSIGNALED(raw),
                exitCode=os.WEXITSTATUS(raw) if os.WIFEXITED(raw) else None,
                signal=os.WTERMSIG(raw) if os.WIFSIGNALED(raw) else None)


def sha_file(file):
    value = hashlib.sha256()
    with os.fdopen(os.open(file, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Pinned bytes must be regular')
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def exact_owned(file, directory=False):
    raw = os.fspath(file)
    if not os.path.isabs(raw) or os.path.normpath(raw) != raw:
        raise ValueError('Exact absolute owned path required')
    value = Path(raw)
    if value == PB02_ROOT or not value.is_relative_to(PB02_ROOT) or value.resolve(strict=True) != value:
        raise ValueError('Canonical path beneath PB02 required')
    if directory and not value.is_dir() or not directory and not value.is_file():
        raise ValueError('Unexpected owned path type')
    return value


def pinned_file(value, owned=False):
    if set(value) != {'path', 'sha256'} or not isinstance(value['sha256'], str) or len(value['sha256']) != 64:
        raise ValueError('Exact file identity required')
    file = exact_owned(value['path']) if owned else Path(value['path'])
    if not file.is_absolute() or file.resolve(strict=True) != file or not file.is_file() or sha_file(file) != value['sha256']:
        raise ValueError('Pinned file identity changed')
    return file


class KernelWatcher:
    def __init__(self, config_path, output_path):
        if sys.platform != 'darwin':
            raise RuntimeError('Darwin kqueue required')
        config_path = exact_owned(config_path)
        self.config = json.loads(config_path.read_text())
        if set(self.config) != {'schemaVersion', 'controller', 'allowedExecutables', 'manifestIdentity', 'outputRoot'} or self.config['schemaVersion'] != 1:
            raise ValueError('Unexpected watcher schema')
        expected = self.config['controller']
        if set(expected) != {'pid', 'startSec', 'startUsec'} or expected['pid'] != os.getppid():
            raise ValueError('Controller must be the actual direct parent')
        self.controller = identity(expected['pid'])
        if not same_birth(self.controller, expected) or self.controller['uid'] != os.getuid():
            raise ValueError('Controller kernel birth/UID differs')
        self.own = identity(os.getpid())
        self.output_root = exact_owned(self.config['outputRoot'], directory=True)
        if not config_path.is_relative_to(self.output_root):
            raise ValueError('Config must belong to output root')
        pinned_file(self.config['manifestIdentity'], owned=True)
        self.allowed = {}
        for value in self.config['allowedExecutables']:
            file = pinned_file(value)
            if str(file) in self.allowed:
                raise ValueError('Duplicate executable identity')
            self.allowed[str(file)] = value['sha256']
        if not self.allowed:
            raise ValueError('At least one pinned executable is required')
        output = Path(output_path)
        if not output.is_absolute() or os.path.normpath(str(output)) != str(output) or not output.is_relative_to(self.output_root) or output == self.output_root:
            raise ValueError('Output must be an exact new file within its owned root')
        if output.parent.resolve(strict=True) != output.parent:
            raise ValueError('Output parent cannot be a symlink')
        self.output = output
        self.stream = os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w')
        self.queue = select.kqueue()
        self.seq = 0
        self.next_token = 1
        self.requests = set()
        self.pid_bindings = {}
        self.armed = {}
        self.stopping = None
        self.emit('ready', watcher=self.own, controller=self.controller, requestedFFlags=PROC_FLAGS,
                  configIdentity=dict(path=str(config_path), sha256=sha_file(config_path)),
                  manifestIdentity=self.config['manifestIdentity'], allowedExecutables=self.config['allowedExecutables'])

    def emit(self, event, **values):
        self.seq += 1
        self.stream.write(json.dumps(dict(seq=self.seq, at=time.time() * 1000, event=event, **values)) + '\n')
        self.stream.flush()

    def validate_target(self, expected):
        if set(expected) != {'pid', 'startSec', 'startUsec', 'ppid', 'pgid', 'executablePath', 'executableSha256'}:
            raise ValueError('Exact target metadata required')
        if not all(isinstance(expected[key], int) and not isinstance(expected[key], bool) and expected[key] >= 0 for key in ('pid', 'startSec', 'startUsec', 'ppid', 'pgid')) or expected['pid'] <= 1:
            raise ValueError('Invalid target identity numbers')
        if self.allowed.get(expected['executablePath']) != expected['executableSha256']:
            raise ValueError('Target executable is not allowed')
        actual = identity(expected['pid'])
        if not same_birth(actual, expected) or any(actual[key] != expected[key] for key in ('ppid', 'pgid', 'executablePath')):
            raise ValueError('Target kernel identity differs')
        if actual['uid'] != self.own['uid'] or actual['pgid'] == self.own['pgid'] or actual['pid'] in (self.own['pid'], self.controller['pid']):
            raise ValueError('Target UID/group/owner boundary rejected')
        if sha_file(actual['executablePath']) != expected['executableSha256']:
            raise ValueError('Target executable bytes changed')
        return actual

    def watch(self, request):
        request_id = request.get('requestId')
        token = None
        try:
            if set(request) != {'op', 'requestId', 'target'} or request['op'] != 'watch' or not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
                raise ValueError('Malformed watch request')
            if request_id in self.requests or len(self.requests) >= 1024:
                raise ValueError('Duplicate request or bounded subscription limit')
            self.requests.add(request_id)
            expected = request['target']
            before = self.validate_target(expected)
            if expected['pid'] in self.pid_bindings:
                raise ValueError('Recorded PID may never be rebound')
            token = self.next_token
            self.next_token += 1
            self.pid_bindings[expected['pid']] = dict(expected)
            self.queue.control([select.kevent(expected['pid'], filter=select.KQ_FILTER_PROC,
                flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_ONESHOT,
                fflags=PROC_FLAGS, udata=token)], 0, 0)
            after = self.validate_target(expected)
            self.armed[token] = dict(requestId=request_id, target=dict(expected))
            self.emit('watch-armed', requestId=request_id, token=token, target=expected,
                      before=before, after=after, requestedFFlags=PROC_FLAGS)
        except Exception as error:
            if token is not None:
                try:
                    self.queue.control([select.kevent(request['target']['pid'], filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_DELETE)], 0, 0)
                except OSError:
                    pass
            self.emit('watch-rejected', requestId=request_id if isinstance(request_id, str) else None,
                      token=token, status='UNKNOWN', reason=type(error).__name__, message=str(error), errno=getattr(error, 'errno', None),
                      exitCode=None, signal=None)

    def drain(self):
        for event in self.queue.control(None, 64, 0):
            raw = dict(ident=event.ident, filter=event.filter, flags=event.flags, fflags=event.fflags, data=event.data, udata=event.udata)
            registration = self.armed.pop(event.udata, None)
            valid = registration and event.ident == registration['target']['pid'] and event.filter == select.KQ_FILTER_PROC and not event.flags & select.KQ_EV_ERROR and event.fflags & select.KQ_NOTE_EXIT and event.fflags & NOTE_EXITSTATUS
            if valid:
                decoded = decode(event.data)
                if decoded['exited'] or decoded['signaled']:
                    self.emit('process-exit', **registration, token=event.udata, raw=raw, status='KERNEL_EXIT_STATUS_OBSERVED', **decoded)
                    continue
            self.emit('kernel-event-unattributed', raw=raw, requestId=registration['requestId'] if registration else None,
                      status='UNKNOWN', exitCode=None, signal=None, errno=event.data if event.flags & select.KQ_EV_ERROR else None)

    def command(self, value):
        if isinstance(value, dict) and value.get('op') == 'watch':
            self.watch(value)
        elif isinstance(value, dict) and set(value) == {'op', 'reason'} and value.get('op') == 'stop' and isinstance(value.get('reason'), str) and len(value['reason']) <= 200:
            self.stopping = value['reason']
        else:
            self.emit('command-rejected', status='UNKNOWN', reason='Malformed command')

    def run(self):
        buffer = b''
        total = 0
        deadline = time.monotonic() + 7200
        try:
            while self.stopping is None:
                self.drain()
                try:
                    if not same_birth(identity(self.controller['pid']), self.controller):
                        self.stopping = 'CONTROLLER_IDENTITY_CHANGED'
                except ProcessLookupError:
                    self.stopping = 'CONTROLLER_EXITED'
                if time.monotonic() >= deadline:
                    self.stopping = 'OBSERVATION_DEADLINE'
                if self.stopping is not None:
                    break
                if select.select([sys.stdin.fileno()], [], [], .05)[0]:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        self.stopping = 'CONTROLLER_STDIN_EOF'
                        if buffer:
                            self.emit('command-rejected', status='UNKNOWN', reason='Incomplete JSON at EOF')
                        break
                    total += len(data)
                    buffer += data
                    if total > 1024 * 1024 or len(buffer) > 65536:
                        self.stopping = 'BOUNDED_INPUT_LIMIT'
                        break
                    while b'\n' in buffer and self.stopping is None:
                        line, buffer = buffer.split(b'\n', 1)
                        try:
                            self.command(json.loads(line))
                        except (ValueError, UnicodeError):
                            self.emit('command-rejected', status='UNKNOWN', reason='Invalid JSON')
            self.drain()
            for token, registration in self.armed.items():
                self.emit('watch-unobserved', **registration, token=token, status='UNKNOWN', reason=self.stopping, exitCode=None, signal=None)
            self.emit('stopped', reason=self.stopping, armedWithoutExit=len(self.armed), watcher=self.own)
            os.fsync(self.stream.fileno())
            return 0
        finally:
            self.queue.close()
            self.stream.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    try:
        return KernelWatcher(arguments.config, arguments.output).run()
    except Exception as error:
        print(json.dumps(dict(status='WATCHER_FAILED', reason=type(error).__name__, message=str(error))), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
