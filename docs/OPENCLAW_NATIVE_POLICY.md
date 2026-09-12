# OpenClaw native approval boundary

Mysti uses an owned local OpenClaw runtime for agent execution. It accepts the
inspected **2026.6.34** installation and verifies the relevant source hashes
before startup and when the modules load. It does not patch installed files or
reconfigure an existing gateway. A failed version, startup, policy registration
or connection check prevents submission; there is no unrestricted CLI fallback.

## Supported execution

The supported harness is embedded OpenClaw/Pi, with the stock `read`, `write`,
`edit` and local foreground `exec` tools on POSIX. Windows requires an owned Job
Object supervisor before this runtime can be admitted. PTY, elevated and remote
exec requests are rejected. Delegated agents, native Codex, ACP, Code Mode,
background processes, browser, messaging, scheduled jobs and arbitrary plugin
tools are not admitted. These routes need separate execution and lifetime
verification. In particular, allowing the stock `process` tool also enables
background exec behavior that can outlive its original run's cancellation.

An owned runtime requires an explicit provider-qualified model in OpenClaw's
configuration and inline or process-environment credentials. Nonempty `config.env`
is rejected with an explicit configuration error. It does not import an
external OAuth/auth-profile store, executable credential provider, custom agent
configuration or alternate harness. These compatibility limits must remain
visible; this bridge does not establish authenticated provider acceptance.
Channel message markers retain direct delivery to configured targets or exact
international phone numbers. Resolving a contact name through a shared agent is
disabled because that agent has no owned execution grant.

## Authority and action identity

Each turn captures its original panel handler, mode and access level. The host
creates a random run grant over an authenticated loopback connection and waits
for the native acknowledgement before submitting the matching gateway run.
The native endpoint can consume host decisions but cannot create grants, change
settings or approve its own requests. Logical session keys and run IDs must both
match exactly. Concurrent panels have separate runtime/session ownership.
The plugin also shares its exact owner across OpenClaw's repeated registry
activations. Starting a turn must not replace the live service connection with
an uninitialized hook closure. A changed owner tuple or stopped service requires
a fresh owned runtime; an obsolete registration cannot stop another service owner.

The early trusted tool policy only checks admission. OpenClaw permits ordinary
hooks and tool finalization to change parameters after that hook runs, so it is
insufficient as the final authority boundary. A narrow, source-verified ESM
transform wraps the stock wrapper's captured raw `execute`. Immediately before
that execution, final arguments are validated and frozen in place. Preserving
their identity matters because stock exec keeps prepared state in a WeakMap.

The host snapshots the final tool name, arguments, tool-call ID, run ID, session
key and unique permission-request ID. A SHA-256 digest of canonical JSON binds
the response to this complete action. No side effect starts while a required
decision is pending. Native plan/read-only policy denies non-read actions before
calling the host; a host callback can further restrict an automatic allowance.
Missing interactive authority denies the request. Tool progress events remain
display observations and do not grant authority.

Pending duplicate permission IDs share a decision only for the identical
payload. Conflicting reuse revokes the run; settled IDs cannot replay a previous
allowance. Action history, payload size, nesting, active runs and outstanding
requests have explicit limits. Overflow fails closed instead of evicting
security state into a permissive default.

## Cancellation and failure

Stop, session disposal, replacement, socket loss and runtime shutdown revoke
the matching grants and pending cards. Heartbeats renew short native leases;
lost liveness expires them. Late decisions must still match the live grant,
connection and immutable action. The final execution guard checks these again
after awaiting approval and passes a combined run/registration/grant abort
signal into the captured tool execution. Revocation therefore also reaches an
already-started foreground command.
Expired authority cannot be renewed back into life, even when a delayed frame
arrives before periodic cleanup. A conflicting permission-request ID revokes
the native execution signal as well as the host's pending request state.

Native foreground commands stay in the managed gateway's POSIX process group;
the host reaps that group even if its leader crashes first. Detached shell
snapshot helpers are disabled. The service marker is applied during plugin
service startup, after the CLI's unrelated stale-gateway cleanup stage. Ordinary
shell initialization can still run after approval. These controls cover tool
admission and process-group ownership. An approved program that deliberately
starts a separate session can escape group cleanup; stronger containment needs
an operating-system sandbox.

Every final call in the owned process requires the guard, including calls with
missing or unexpected context and calls after policy disposal. Unsupported
descendants never inherit authority from a session-name resemblance. The
version-specific implementation and its invariants are documented in
[the runtime guard contract](../resources/openclaw-policy/RUNTIME_GUARD.md).

## Verification boundaries

The pure policy and real loopback transport fixtures cover settings, card
ownership, exact action digests, replay, cancellation, lost connections,
unsupported tools and lease expiration. The installed runtime fixtures execute
the actual transformed wrapper and stock read/write/edit/exec implementations
in temporary workspaces, including argument mutation after the early hook and
revocation of a running command before a delayed marker write.

Run the adapter suite with `npx vitest run tests/providers/openclaw` and run
`npm run typecheck`. Installed-native cases require the inspected OpenClaw
installation; `MYSTI_TEST_OPENCLAW_ROOT` selects its path. A fixture that skips
because that installation is absent is not native execution evidence. Local
fake-model checks do not replace authenticated account/provider testing or
cross-platform editor acceptance.


## Owned process cleanup (2026-09-12)

Cleanup now waits for the process group to disappear before removing its private
state. A successful SIGKILL is only a termination attempt. `ESRCH` confirms group
absence; a persistent live/inaccessible group fails the bounded cleanup and keeps
the private state for diagnosis. Exit and disposal share one cleanup operation.

An inert local C probe reproduced the macOS failure: a same-user detached child
exited, group signalling returned `EPERM` while it remained a zombie, and returned
`ESRCH` after its parent reaped it. Apple's
[killpg1 implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
excludes zombies during group iteration and can return EPERM when the group exists
but no eligible member is found. This explains why treating every intermediate
EPERM as a permanent cleanup failure was incorrect. The implementation still
requires confirmed absence; it does not suppress failures for surviving groups.

Regression coverage includes transient and persistent EPERM, no signals after
confirmed absence, retention of state on failed cleanup, and actual descendants
that ignore SIGTERM and must not produce delayed effects after Stop/gateway crash.
