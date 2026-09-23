# Persistence recovery and downgrade review

The reviewed candidate retains conversation and Canvas schema version 1.
Unversioned supported data still migrates on load. A future schema is refused;
do not edit its version field to force an older extension to accept it.

| Store | Recovery behavior |
| --- | --- |
| Conversations, editor global state `mysti.conversations` | Invalid data is copied to a unique `mysti.conversations.corrupt.<timestamp>.<uuid>` key before replacement. A failed recovery copy disables persistence. A newer schema disables persistence without replacing the original. |
| Workspace `.mysti/canvas/<id>/artifact.json` | Valid previous data is backed up as `artifact.json.bak`. Restore validates that backup, preserves the current primary in `artifact.json.corrupt` (or a unique suffixed copy), then promotes the backup atomically. A failed recovery copy or promotion leaves the primary intact. |
| Failed Canvas close, `<globalStorage>/canvas-recovery/<id>-<time>.json` | A never-overwriting `artifact.json`-format copy records its workspace root and the on-disk design it would replace. `Mysti: Restore Canvas Recovery Copy` (also offered when the Canvas opens) lists only this workspace's copies and validates the chosen one with the load validator. It restores in place only when that design is unchanged and not open; the check and write share the design's save queue. Otherwise it restores a new "(recovered)" design and copies surviving assets. A design deleted after the copy asks first. Success moves the copy to `restored/`; a rejected or failed restore leaves it in place. Copies without workspace identity are never offered. |
| Workspace `.mysti/compaction/<panel>/history.jsonl` | Invalid lines are retained on disk and skipped on read. An incomplete final line is separated before the next append. Appends and clears serialize per journal within one store instance; this is not cross-process locking. |

Canvas saves use a temporary file followed by an atomic rename. On Windows,
`EPERM`, `EACCES` and `EBUSY` at that rename are retried up to five times, with
775 ms total scheduled delay. The previous file stays intact while retrying;
there is no unlink or copy fallback. Persistent errors still fail the save and
remove only the temporary file. Fault-injection tests cover temporary locks,
permanent locks, preservation of both primary and backup, and errors that
must not be retried. This does not provide locking between separate writers.

Before changing extension versions, close all editor windows using these stores
and preserve the complete workspace `.mysti` directory plus the editor profile's
extension global state. Keep recovery copies private: transcripts and tool
output can contain sensitive material. Git ignore rules exclude ordinary adds,
but do not prevent an explicit force-add.

For a damaged Canvas design, use its offered backup restore only after reviewing
the backup timestamp. Repeated restores retain earlier recovery copies. A
missing or invalid backup requires recovering a saved copy; starting a fresh
design does not repair the damaged file. Preserve the complete design directory,
including assets, when moving a recovered artifact.

For a downgrade, retain the exact prior VSIX and restore only a matching data
snapshot while the editor is closed. Schema version 1 alone does not prove every
older release preserves every optional field. Exercise the intended prior
release against copies first. The 2026-09-14 synthetic review executed the actual
`v0.4.0` conversation manager against in-memory fixtures. Direct load/save retained
the tested message fields but removed the container's `schemaVersion`. Importing
an exported conversation dropped `segments`, `provider`, `model` and `checkpoint`. That
release also accepted a synthetic future schema and rewrote it on a title change;
it predates the current refusal guard. Do not point v0.4.0 at newer live state.
Use its matching saved snapshot in a separate profile. These three source-level
cases do not establish old-renderer behavior, Canvas/journal compatibility or a
real-editor downgrade. No normal user profile or production data was read or changed,
and real-profile downgrade acceptance remains open.

The local persistence gate covers journal append/clear ordering, incomplete
tails, symlink refusal, schema migration, newer-schema refusal, corrupt-data
preservation, recovery-copy failures and restore-promotion failures: 179 tests
in seven files passed. Filesystem path checks reject existing links; they are
not a sandbox against another process replacing paths during an operation.
