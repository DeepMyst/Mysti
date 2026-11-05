#!/usr/bin/env python3
"""Tiny zero-model controls for the passive process watcher."""
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest import mock

sys.dont_write_bytecode = True
HELPER = Path(__file__).with_name('pb02-kqueue-watch.py').resolve()
spec = importlib.util.spec_from_file_location('pb02_watch', HELPER)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def write(file, value):
    with file.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def rows(file):
    if not file.exists():
        return []
    data = file.read_bytes()
    return [json.loads(line) for line in data.split(b'\n')[:-1] if line]


def wait_for(predicate, description):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.01)
    raise TimeoutError(description)


def target_request(actual, request_id='owned-target'):
    return dict(op='watch', requestId=request_id, target={**{key:actual[key] for key in ('pid','startSec','startUsec','ppid','pgid','executablePath')},
                                                      'executableSha256':w.sha_file(actual['executablePath'])})


class Harness:
    def __init__(self, directory, command=None, environment=None, cwd=None):
        self.directory = directory
        directory.mkdir()
        self.output = directory / 'kernel-events.jsonl'
        synthetic = command is None
        ready_file = directory / 'target-ready.json'
        command = command or [sys.executable, '-c',
            'import signal,sys,pathlib,os;signal.alarm(20);pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));sys.stdin.buffer.read();sys.exit(7)', str(ready_file)]
        self.target = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       start_new_session=True, env=environment, cwd=cwd)
        if synthetic:
            wait_for(lambda: ready_file.exists() and ready_file.read_text() == str(self.target.pid), 'target completed Python executable handoff')
        self.target_identity = w.identity(self.target.pid)
        self.watcher = None
        self.command = command
        controller = w.identity(os.getpid())
        self.manifest = directory/'manifest.json'
        write(self.manifest, dict(stage='OWNED_ZERO_MODEL_PROCESS_CONTROL', command=command,
              controller=controller, target=self.target_identity, targetStdinBytes=0))
        self.config = dict(schemaVersion=1, controller={key:controller[key] for key in ('pid','startSec','startUsec')},
                           allowedExecutables=[dict(path=self.target_identity['executablePath'], sha256=w.sha_file(self.target_identity['executablePath']))],
                           manifestIdentity=dict(path=str(self.manifest),sha256=w.sha_file(self.manifest)),outputRoot=str(directory))

    def start(self, mutate=None, output=None):
        if mutate:
            mutate(self.config)
        write(self.directory/'config.json', self.config)
        self.watcher = subprocess.Popen([sys.executable,str(HELPER),'--config',str(self.directory/'config.json'),'--output',str(output or self.output)],
                                        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        return self.watcher

    def ready(self):
        return wait_for(lambda:next((row for row in rows(self.output) if row['event']=='ready'),None),'watcher ready')

    def send(self, command):
        self.watcher.stdin.write((json.dumps(command)+'\n').encode());self.watcher.stdin.flush()

    def event(self, event):
        return wait_for(lambda:next((row for row in rows(self.output) if row['event']==event),None),event)

    def stop(self):
        self.send(dict(op='stop',reason='CONTROL_COMPLETE'))
        self.watcher.stdin.close()
        assert self.watcher.wait(timeout=5)==0
        return rows(self.output)

    def kill_owned_group(self):
        actual=w.identity(self.target.pid)
        assert self.target.poll() is None and w.same_birth(actual,self.target_identity)
        assert actual['ppid']==os.getpid() and actual['pgid']==actual['pid'] and actual['pgid']!=os.getpgrp()
        os.killpg(actual['pgid'],signal.SIGKILL)

    def finish(self):
        if self.target.poll() is None:
            self.target.stdin.close()
            try:self.target.wait(timeout=5)
            except subprocess.TimeoutExpired:self.kill_owned_group();self.target.wait(timeout=5)
        if self.watcher and self.watcher.poll() is None:
            self.watcher.stdin.close();self.watcher.wait(timeout=5)
        result=dict(targetCommand=self.command,targetStdinBytes=0,targetReturnCode=self.target.returncode,
                    targetStdoutSha256=w.hashlib.sha256(self.target.stdout.read()).hexdigest(),
                    targetStderrSha256=w.hashlib.sha256(self.target.stderr.read()).hexdigest())
        if self.watcher:
            result.update(watcherReturnCode=self.watcher.returncode,watcherStdout=self.watcher.stdout.read().decode(),watcherStderr=self.watcher.stderr.read().decode())
        write(self.directory/'process-results.json',result)
        return result


def qualify_actual(directory, command, environment, cwd, killed=False):
    h=Harness(directory,command,environment,cwd)
    try:
        h.start();ready=h.ready();assert ready['watcher']['pgid']!=h.target_identity['pgid']
        assert ready['watcher']['pid']!=h.target_identity['ppid']
        h.send(target_request(h.target_identity));armed=h.event('watch-armed')
        assert w.same_birth(armed['before'],h.target_identity) and w.same_birth(armed['after'],h.target_identity)
        if killed:h.kill_owned_group()
        else:h.target.stdin.close()
        returncode=h.target.wait(timeout=8);event=h.event('process-exit')
        assert event['status']=='KERNEL_EXIT_STATUS_OBSERVED'
        assert not event['raw']['flags']&select.KQ_EV_ERROR
        assert event['raw']['data']==event['rawWaitStatus']
        actual=os.waitstatus_to_exitcode(event['rawWaitStatus']);assert actual==returncode
        if killed:assert returncode==-signal.SIGKILL and event['signal']==signal.SIGKILL
        else:assert event['exited']
        output=h.stop();assert [row['seq'] for row in output]==list(range(1,len(output)+1))
        assert not any(row['event']=='watch-unobserved' for row in output)
        return dict(directory=str(directory),kernelEvent=event,targetReturnCode=returncode,targetStdinBytes=0,
                    observerOutsideGroup=True,observerNotParent=True)
    finally:h.finish()


def main():
    root=Path(tempfile.mkdtemp(prefix='kqueue-watch-controls-',dir=w.PB02_ROOT)).resolve()
    checks=[]
    def check(name,function):
        try:checks.append(dict(name=name,status='PASS',detail=function()))
        except Exception as error:checks.append(dict(name=name,status='FAIL',error=repr(error)))
    check('actual normal exit equals parent wait status',lambda:qualify_actual(root/'normal',None,None,None))
    check('actual owned group SIGKILL retains raw kernel status externally',lambda:qualify_actual(root/'killed',None,None,None,True))

    def rejected(name,mutate):
        h=Harness(root/name)
        try:
            h.start();h.ready();request=target_request(h.target_identity);mutate(h,request);h.send(request)
            event=h.event('watch-rejected');assert event['status']=='UNKNOWN' and event['exitCode'] is None and event['signal'] is None
            assert not any(row['event']=='process-exit' for row in h.stop());return event
        finally:h.finish()
    check('wrong birth rejected',lambda:rejected('wrong-birth',lambda h,r:r['target'].__setitem__('startUsec',r['target']['startUsec']+1)))
    check('wrong executable hash rejected',lambda:rejected('wrong-executable',lambda h,r:r['target'].__setitem__('executableSha256','0'*64)))
    check('wrong parent rejected',lambda:rejected('wrong-parent',lambda h,r:r['target'].__setitem__('ppid',1)))
    check('wrong process group rejected',lambda:rejected('wrong-group',lambda h,r:r['target'].__setitem__('pgid',1)))
    def target_watcher(h,request):request['target']=target_request(h.ready()['watcher'])['target']
    check('watcher own process/group rejected',lambda:rejected('self-target',target_watcher))
    def late(h,request):h.target.stdin.close();h.target.wait(timeout=5)
    check('late gone process stays unknown',lambda:rejected('late',late))

    def live_stop():
        h=Harness(root/'live-stop')
        try:
            h.start();h.ready();h.send(target_request(h.target_identity));h.event('watch-armed')
            result=h.stop();assert h.target.poll() is None
            unknown=next(row for row in result if row['event']=='watch-unobserved')
            assert unknown['exitCode'] is None and unknown['signal'] is None
            return dict(watcherDidNotSignalTarget=True,unknown=unknown)
        finally:h.finish()
    check('stop with live target preserves unknown without sending a signal',live_stop)

    def duplicate():
        h=Harness(root/'duplicate')
        try:
            h.start();h.ready();request=target_request(h.target_identity);h.send(request);h.event('watch-armed')
            h.send(target_request(h.target_identity,'another-request'));h.event('watch-rejected')
            h.target.stdin.close();h.target.wait(timeout=5);h.event('process-exit')
            result=h.stop();assert sum(row['event']=='process-exit' for row in result)==1
        finally:h.finish()
    check('same PID cannot acquire a second binding',duplicate)

    def bad_start(name,mutate):
        h=Harness(root/name)
        try:
            h.start(mutate);assert h.watcher.wait(timeout=5)==1;assert not h.output.exists();assert h.target.poll() is None
        finally:h.finish()
    check('wrong controller birth rejected before output creation',lambda:bad_start('controller',lambda cfg:cfg['controller'].__setitem__('startUsec',cfg['controller']['startUsec']+1)))
    check('changed manifest pin rejected before output creation',lambda:bad_start('manifest',lambda cfg:cfg['manifestIdentity'].__setitem__('sha256','0'*64)))
    check('changed allowed executable bytes rejected before output creation',lambda:bad_start('executable',lambda cfg:cfg['allowedExecutables'][0].__setitem__('sha256','0'*64)))

    def existing_output():
        h=Harness(root/'existing-output')
        try:
            h.output.write_bytes(b'preserve');h.start();assert h.watcher.wait(timeout=5)==1;assert h.output.read_bytes()==b'preserve'
        finally:h.finish()
    check('existing output bytes never overwritten',existing_output)

    def raw_error():
        instance=w.KernelWatcher.__new__(w.KernelWatcher);output=[]
        instance.armed={1:dict(requestId='bound',target=dict(pid=1234))}
        instance.queue=SimpleNamespace(control=lambda *args:[SimpleNamespace(ident=1234,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ERROR,fflags=w.PROC_FLAGS,data=3,udata=1)])
        instance.emit=lambda event,**values:output.append(dict(event=event,**values))
        instance.drain();assert output[0]['event']=='kernel-event-unattributed' and output[0]['errno']==3
        assert output[0]['exitCode'] is None and output[0]['signal'] is None and 'rawWaitStatus' not in output[0]
    check('EV_ERROR data is errno, never a fabricated wait status',raw_error)

    def post_arm_race():
        instance=w.KernelWatcher.__new__(w.KernelWatcher);output=[];calls=[]
        instance.requests=set();instance.pid_bindings={};instance.next_token=1;instance.armed={}
        instance.queue=SimpleNamespace(control=lambda *args:calls.append(args) or [])
        instance.emit=lambda event,**values:output.append(dict(event=event,**values))
        values=iter([dict(pid=1234),ProcessLookupError('controlled post-arm disappearance')])
        def validate(expected):
            value=next(values)
            if isinstance(value,Exception):raise value
            return value
        instance.validate_target=validate
        instance.watch(dict(op='watch',requestId='race',target=dict(pid=1234)))
        assert output[0]['event']=='watch-rejected' and output[0]['status']=='UNKNOWN'
        assert not instance.armed and len(calls)==2 and output[0]['exitCode'] is None
    check('post-arm identity gap stays unknown and removes subscription',post_arm_race)
    report=dict(status='PASS' if all(row['status']=='PASS' for row in checks) else 'FAIL',checks=checks,
                helper=dict(path=str(HELPER),sha256=w.sha_file(HELPER)),checker=dict(path=str(Path(__file__).resolve()),sha256=w.sha_file(Path(__file__).resolve())),
                realProviderInputs=0,nativeCliInvocations=0,scope='Tiny owned Python processes and pure failure controls; no actual CLI/model qualification inferred.')
    write(root/'checks.json',report)
    print(json.dumps(dict(path=str(root/'checks.json'),status=report['status'],passed=sum(row['status']=='PASS' for row in checks),total=len(checks),failures=[row for row in checks if row['status']!='PASS'])))
    return 0 if report['status']=='PASS' else 1


if __name__=='__main__':raise SystemExit(main())
