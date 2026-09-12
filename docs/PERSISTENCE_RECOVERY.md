# Persistence recovery and downgrade review

The 2026-09-12 candidate retains conversation and Canvas schema version 1.
Unversioned supported data still migrates on load. A future schema is refused;
do not edit its version field to force an older extension to accept it.

| Store | Recovery behavior |
| --- | --- |
| Conversations, editor global state `mysti.conversations` | Invalid data is copied to a unique `mysti.conversations.corrupt.<timestamp>.<uuid>` key before replacement. A failed recovery copy disables persistence. A newer schema disables persistence without replacing the original. |
| Workspace `.mysti/canvas/<id>/artifact.json` | Valid previous data is backed up as `artifact.json.bak`. Restore validates that backup, preserves the current primary in `artifact.json.corrupt` (or a unique suffixed copy), then promotes the backup atomically. A failed recovery copy or promotion leaves the primary intact. |
| Workspace `.mysti/compaction/<panel>/history.jsonl` | Invalid lines are retained on disk and skipped on read. An incomplete final line is separated before the next append. Appends and clears serialize per journal within one store instance; this is not cross-process locking. |

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
release against copies first. No user profile or production data was changed
for this review, and a real-profile downgrade has not been demonstrated.

The local persistence gate covers journal append/clear ordering, incomplete
tails, symlink refusal, schema migration, newer-schema refusal, corrupt-data
preservation, recovery-copy failures and restore-promotion failures: 179 tests
in seven files passed. Filesystem path checks reject existing links; they are
not a sandbox against another process replacing paths during an operation.
