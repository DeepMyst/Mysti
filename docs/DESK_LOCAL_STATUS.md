# Desk local status and workspace lookup

Desk can exchange signed availability between paired editor profiles on the
same computer, and can share exact workspace coordinates through a separate
explicit command. This is the loopback transport tier. Matching platform builds
also provide [cross-machine commands](DESK_CROSS_MACHINE.md), whose relay and
two-machine acceptance remain open. Consultation, review and task execution
are not integrated.

## Local status

1. In two disposable editor instances with independent user-data directories,
   enable `mysti.desk.enabled` and complete
   Desk pairing, including comparing the safety number. Grant `status` to the
   profile that will check your availability. Each instance must have a distinct
   Desk identity; windows sharing the same secret storage also share its device identity.
2. In the serving profile, trust the workspace and enable `mysti.desk.serve`.
3. Run **Mysti: Desk: Share local status**, choose the paired profile, and choose
   `available`, `busy`, `dnd` or `offline`. The temporary link is copied to the
   clipboard. The selected status becomes the status published to all that
   window's active local connections.
4. In the paired profile on the same computer, run **Mysti: Desk: Check local
   status** and paste the link. A result is displayed only after verifying the
   response against the already pinned device key.

The link expires within ten minutes, earlier if the peer or grant expires.
Creating a new link for the same recipient invalidates its previous link.
Disabling Desk or serving, closing the serving window, or revoking the peer
invalidates access. A new listener has a new port and fresh credentials. A
profile that receives a link still needs its own matching private key; the
link cannot substitute for pairing. Links are not saved in workspace data or
the peer book. Clipboard lifetime is controlled by the user and operating system.

A status link returns only the fixed availability value and `focus: null` are returned. Status sharing reads no workspace
files, discloses no source or paths, and calls no model.
Successful status requests consume the grant's lifetime call allowance at zero
dollar cost. Identical signed retries return the same cached result without
another debit; changed bytes under the same call ID are refused. A revoked or
expired peer cannot retrieve a cached result.

The listener binds to an ephemeral port on `127.0.0.1`. The client accepts only
that literal address and the `/desk` path; it does not resolve hostnames, use a
proxy, follow redirects, or dial another machine. Bodies, response reads,
deadlines, sessions and cached calls are bounded. Each recipient's channel
accepts at most 32 requests per minute, including malformed bodies and cached
retries; the peer grant also limits new calls. The extension owns the
listener's configuration, workspace-trust and disposal lifecycle. Signing uses
SecretStorage through `DeskIdentity`; the client never receives the private key.

`tests/services/deskLocalStatus.test.ts` exercises the real HTTP path with fresh
generated identities and in-memory stores, including signed replies, forged
requests, duplicate calls, limits, revocation, expiry, failed persistence and
configuration races. This is local protocol evidence. It does not establish
two-machine acceptance or replace testing both editor profiles manually.


## Scoped workspace lookup

1. Pair two independent editor profiles on the same computer, grant `locate`,
   and enable Desk and serving in the trusted serving workspace as above.
2. In the serving profile's **User Settings**, set `mysti.desk.shareCeiling`
   to workspace-relative prefixes, for example `["src/shared"]`. It defaults
   to `[]`. Repository settings cannot override this ceiling.
3. Create `.mysti/desk-share.json` in the workspace you intend to share:

   ```json
   { "allow": ["src/shared"] }
   ```

   The effective scope is the intersection of the machine ceiling, this file,
   and the recipient's paired grant. Prefixes select a file or directory; `*`
   selects all eligible paths within that intersection. An absent/malformed
   configuration or empty intersection prevents sharing.
4. Run **Mysti: Desk: Share local workspace lookup**. Choose the recipient and
   explicitly select a workspace folder, including in a multi-root window.
   The command prepares a coordinate snapshot and copies a temporary
   `desk://local-lookup/` link. It replaces that recipient's previous local link.
5. In the receiving profile, run **Mysti: Desk: Look up shared workspace**, paste
   the link, select `symbol` or `path`, and enter an exact literal. A symbol
   matches a supported declaration name. A path token matches a filename, stem,
   or whole path component; it is not a full-path search, pattern or substring.
   The command displays verified peer-relative paths and line numbers as text.
   It does not open a similarly named local file.

Lookup links authorize only `locate`; status links continue to authorize only
`status`, even if their recipient has both grants. Lookup returns at most twenty
coordinates, no source text or search totals. Misses return the same empty list.
Outbound coordinates pass the Desk egress scanner. No model is involved.
Successful unique lookups consume the peer's lifetime allowance at zero cost.
Retries, revocation, expiry, channel limits and signing use the same local
protocol as status.

Only the local sharing command reads eligible source files to build the index.
It retains coordinates in memory and discards source text. Requests verify the
snapshot's scope and file/directory metadata, including cached requests; they
never trigger source indexing. Scope or indexed-file changes, workspace removal,
Desk configuration changes, trust loss and revocation invalidate access. A new
link is required to publish a new snapshot. Unrelated directory changes can also
invalidate a snapshot; there is no automatic rebuild. Nothing is persisted.

The privileged reader excludes hidden paths, known credential/transcript names,
profile stores, generated/vendor directories, private-key/database/log files and
symbolic links. Hard-linked files and unsafe/raced paths are refused. The share
configuration is the sole explicitly allowed hidden-file read. Source reads use
regular-file descriptors with before/after identity checks and bounded buffers;
known source extensions are indexed for declarations, while other eligible
regular files supply path coordinates only. Binary files supply no symbols.
This is a trusted-workspace snapshot reader, not an OS sandbox for hostile local
processes with concurrent filesystem control.

Snapshot preparation refuses the entire operation above 1,024 eligible files,
4,096 encountered directory entries, depth 24, 16 MiB of source, 512 KiB per
source file, or ten seconds of checked build time. Share configuration is limited
to 16 KiB and each prefix list to 128 entries. Oversize/unreadable source does not
produce a silently partial index; choose a narrower scope. The pure index's
supported declaration forms and twenty-hit cap still apply.

`tests/services/deskWorkspaceLookup.test.ts` uses only fresh temporary workspaces
and synthetic private-file fixtures. It covers scope intersection before source
reads, exclusion, symlinks/junctions, hard links, descriptor/parent replacement,
limits and snapshot invalidation. `tests/services/deskLocalStatus.test.ts` also
exercises lookup over real signed loopback HTTP, including final-call retries,
cache invalidation and scope changes during response signing. These tests do not
establish manual two-editor or two-machine acceptance.
