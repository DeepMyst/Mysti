#!/usr/bin/env python3
"""Fail-closed, private APFS clones for new owned PB-02 fixtures."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import sys
import time

PB02_ROOT = Path(__file__).resolve().parents[2] / 'out-test/feature-tests/PB-02'
CLONE_NOFOLLOW = 1


def sha_file(file):
    value = hashlib.sha256()
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Hash input must be a regular file')
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def sha_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def beneath(root, value):
    return value != root and value.is_relative_to(root)


def exact_path(value, existing):
    raw = os.fspath(value)
    if not os.path.isabs(raw) or os.path.normpath(raw) != raw:
        raise ValueError('An absolute normalized path is required')
    file = Path(raw)
    if not beneath(PB02_ROOT, file):
        raise ValueError('Path must be strictly beneath the owned PB-02 root')
    checked = file if existing else file.parent
    if checked.resolve(strict=True) != checked or not checked.is_dir():
        raise ValueError('Existing root/parent must be an exact directory without symlink ancestors')
    return file


def reject_prepared_ancestors(directory):
    current = directory
    while current.is_relative_to(PB02_ROOT):
        if any(os.path.lexists(current / name) for name in ('prepared.json', 'campaign.json')):
            raise ValueError('Destination/report cannot be inside an existing prepared campaign')
        if current == PB02_ROOT:
            return
        current = current.parent


def file_identity(info):
    return dict(dev=info.st_dev, ino=info.st_ino, nlink=info.st_nlink,
                mode=stat.S_IMODE(info.st_mode), bytes=info.st_size,
                mtimeNs=info.st_mtime_ns, ctimeNs=info.st_ctime_ns)


def inspect_tree(root):
    """No symlink directory traversal; validate every entry before returning."""
    entries = []
    seen_files = set()

    def walk(file, relative):
        before = file.lstat()
        row = dict(relative=relative, identity=file_identity(before))
        if stat.S_ISLNK(before.st_mode):
            target = os.readlink(file)
            if before.st_nlink != 1 or os.path.isabs(target):
                raise ValueError('Only unlinked relative symbolic links are allowed')
            try:
                resolved = file.resolve(strict=True)
            except (RuntimeError, OSError) as error:
                raise ValueError('Dangling/cyclic symbolic link') from error
            if not beneath(root, resolved):
                raise ValueError('Symbolic link must resolve strictly inside its source tree')
            if resolved.is_dir() and file.parent.is_relative_to(resolved):
                raise ValueError('Cyclic ancestor directory link')
            row.update(kind='symlink', target=target)
        elif stat.S_ISREG(before.st_mode):
            inode = (before.st_dev, before.st_ino)
            if before.st_nlink != 1 or inode in seen_files:
                raise ValueError('Hardlinked regular files are forbidden')
            seen_files.add(inode)
            row.update(kind='file', sha256=sha_file(file))
        elif stat.S_ISDIR(before.st_mode):
            if file.resolve(strict=True) != file:
                raise ValueError('Directory became a symbolic link during inspection')
            row.update(kind='directory')
        else:
            raise ValueError('Special filesystem entries are forbidden')
        if file_identity(file.lstat()) != row['identity']:
            raise ValueError('Source changed while it was inspected')
        entries.append(row)
        if row['kind'] == 'directory':
            for name in sorted(os.listdir(file)):
                walk(file / name, name if not relative else relative + '/' + name)

    walk(root, '')
    return entries


def content_projection(entries):
    return [dict(relative=row['relative'], kind=row['kind'], mode=row['identity']['mode'],
                 **({'bytes': row['identity']['bytes'], 'sha256': row['sha256']} if row['kind'] == 'file' else {}),
                 **({'target': row['target']} if row['kind'] == 'symlink' else {})) for row in entries]


class CloneBackend:
    def __init__(self):
        if sys.platform != 'darwin':
            raise RuntimeError('Darwin clonefile is required; no fallback is permitted')
        self.library = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        self.function = self.library.clonefile
        self.function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
        self.function.restype = ctypes.c_int

    def copy(self, source, destination):
        ctypes.set_errno(0)
        returned = self.function(os.fsencode(source), os.fsencode(destination), CLONE_NOFOLLOW)
        error = ctypes.get_errno()
        if returned != 0:
            raise OSError(error, os.strerror(error), str(source), None, str(destination))


def clone_private(source, destination, report):
    """Return the recorded result. Only PASS_PRIVATE_CLONE establishes a clone."""
    report = exact_path(report, existing=False)
    reject_prepared_ancestors(report.parent)
    # Refuse a report within either tree before reserving it, even if a source
    # argument itself will later fail validation. Never add evidence to source.
    for candidate in (source, destination):
        tree = Path(os.path.abspath(os.fspath(candidate)))
        for resolved in (tree, tree.resolve(strict=False)):
            if report == resolved or report.is_relative_to(resolved):
                raise ValueError('Report must be outside both source and destination trees')
    # Reserve once before mutation; no replacing any previous report or symlink.
    report_fd = os.open(report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    report_identity = os.fstat(report_fd)
    started = time.time()
    result = dict(status='REJECTED_PREFLIGHT', source=os.fspath(source), destination=os.fspath(destination),
                  report=str(report), startedAt=started, copyMode='darwin-clonefile-no-fallback',
                  cloneFlags=CLONE_NOFOLLOW, successfulCloneCalls=0, destinationCreated=False)
    try:
        result.update(python=dict(executable=str(Path(sys.executable).resolve()), version=sys.version,
                                  executableSha256=sha_file(Path(sys.executable).resolve()), platform=platform.platform()),
                      helperSha256=sha_file(Path(__file__).resolve()))
        source = exact_path(source, existing=True)
        destination = exact_path(destination, existing=False)
        reject_prepared_ancestors(destination.parent)
        if source == destination or source.is_relative_to(destination) or destination.is_relative_to(source):
            raise ValueError('Source and destination must be disjoint')
        if report == source or report.is_relative_to(source) or report == destination or report.is_relative_to(destination):
            raise ValueError('Report must be outside both source and destination trees')
        if os.path.lexists(destination):
            raise FileExistsError('Destination must not already exist')
        before = inspect_tree(source)
        result.update(sourceEntries=len(before), sourceRegularFiles=sum(row['kind'] == 'file' for row in before),
                      sourceSymlinks=sum(row['kind'] == 'symlink' for row in before),
                      sourceLogicalBytes=sum(row['identity']['bytes'] for row in before if row['kind'] == 'file'),
                      sourceTreeSha256=sha_json(content_projection(before)), sourceMetadataSha256=sha_json(before))
        backend = CloneBackend()
        destination.mkdir(mode=0o700)
        result.update(destinationCreated=True, status='PARTIAL_PRIVATE_CLONE')
        for row in before[1:]:
            original, copied = source / row['relative'], destination / row['relative']
            if file_identity(original.lstat()) != row['identity']:
                raise ValueError('Source identity changed after preflight')
            if copied.parent.resolve(strict=True) != copied.parent:
                raise ValueError('Destination parent changed or became a symbolic link')
            if row['kind'] == 'directory':
                copied.mkdir(mode=0o700)
            else:
                result['activeEntry'] = row['relative']
                backend.copy(original, copied)
                result['successfulCloneCalls'] += 1
        for row in reversed(before):
            if row['kind'] == 'directory':
                os.chmod(destination / row['relative'], row['identity']['mode'])
        after_source = inspect_tree(source)
        if after_source != before:
            raise ValueError('Complete source tree changed during copying')
        after_target = inspect_tree(destination)
        if content_projection(after_target) != content_projection(before):
            raise ValueError('Target contents, modes or relative links differ from source')
        source_ids = {(row['identity']['dev'], row['identity']['ino']) for row in before}
        for row in after_target:
            if (row['identity']['dev'], row['identity']['ino']) in source_ids:
                raise ValueError('Target shares a source inode')
        result.pop('activeEntry', None)
        result.update(status='PASS_PRIVATE_CLONE', sourceUnchanged=True, distinctSourceTargetInodes=True,
                      regularFilesNlinkOne=True, exactRelativeSymlinks=True,
                      targetTreeSha256=sha_json(content_projection(after_target)),
                      targetMetadataSha256=sha_json(after_target), targetEntries=len(after_target))
    except Exception as error:
        result['error'] = dict(type=type(error).__name__, message=str(error), errno=getattr(error, 'errno', None))
        result['partialDestinationPreserved'] = result['destinationCreated']
    finally:
        result['endedAt'] = time.time()
        try:
            current = report.lstat()
            if report.resolve(strict=True) != report:
                raise RuntimeError('Reserved report path gained a symbolic link')
            if (current.st_dev, current.st_ino) != (report_identity.st_dev, report_identity.st_ino):
                raise RuntimeError('Reserved report pathname changed; refusing replacement')
            encoded = (json.dumps(result, indent=2) + '\n').encode()
            with os.fdopen(report_fd, 'wb') as stream:
                report_fd = None
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            if report_fd is not None:
                os.close(report_fd)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'destination', 'report'):
        parser.add_argument('--' + name, required=True)
    arguments = parser.parse_args()
    try:
        result = clone_private(arguments.source, arguments.destination, arguments.report)
        print(json.dumps(dict(status=result['status'], report=result['report'],
                              successfulCloneCalls=result['successfulCloneCalls'])))
        return 0 if result['status'] == 'PASS_PRIVATE_CLONE' else 1
    except Exception as error:
        print(json.dumps(dict(status='REJECTED_REPORT_PATH', error=str(error))), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
