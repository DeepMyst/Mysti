# Owned OpenClaw execution guard

These static resources instrument an OpenClaw process started by Mysti. They do
not modify the installation on disk. Start the owned Node process with
`--import <absolute runtime-preload.mjs>`, `MYSTI_OPENCLAW_OWNED_RUNTIME=1`, and
`MYSTI_OPENCLAW_ROOT=<absolute installation root>`. Without that marker the
preload does nothing.

The preload accepts only OpenClaw 2026.6.34 and the source hashes in
`runtime-manifest.mjs`. It verifies before the application entrypoint, and the
ESM loader verifies again when each inspected module loads. The sole transform
wraps the stock tool wrapper's captured source `execute`; the guard therefore
runs after ordinary hooks, parameter reconciliation and tool finalization.

The trusted policy plugin imports `runtime-guard.mjs` from this same resource
directory. `getFinalExecutionGuardReceipt()` returns null until the transformed
module executes its readiness marker. A receipt contains protocol version 1,
installed root/version, target URL and source hash. The plugin must require this
receipt before admitting a Mysti run.

`installFinalExecutionPolicy(handler)` returns an identity-safe disposable.
The handler receives `{ protocolVersion, toolName, toolCallId, params, context,
signal }` and optional host-derived `toolKind` / `toolInputKind`. Context includes
available run, session, agent and working-directory identities; configuration
and credentials are not copied into it. To authorize, return
`{ allow: true, isCurrent: () => boolean, executionSignal: grantAbortSignal }`.
The grant signal is required in owned runtimes. The guard checks `isCurrent()` after
awaiting the decision. Missing/invalid decisions, cancellation, replacement and
disposal fail closed. The combined run, registration and grant abort signal
remains active through captured execution, including revocation after approval.
The original unbound `execute` calling convention is preserved.

Final action parameters are validated and frozen in place before policy awaits.
This prevents retained references from changing the authorized action while
preserving the object identity used by stock exec's prepared-environment
WeakMap. Optional undefined fields are accepted. Accessors, cycles, non-JSON
objects and oversized/deep structures fail closed. Tool implementations that
mutate their arguments require separate compatibility work.

The owned-process preload requires the guard for **every** final execution,
including missing or unexpected run/session identities and after policy
disposal. Outside an owned process, reserved `mysti-` run IDs and session keys
(including `agent:<id>:mysti-...`) still require the guard; unrelated calls retain
their original behavior. A trusted plugin can explicitly mark host-proven
descendants with `markOwnedExecutionContext({ runId?, sessionKey?, parentRunId? })`.
An optional parent must already be recognized as owned. These ownership
tombstones survive policy disposal. At 10,000 distinct identities the process
latches a failure and requires restart; it never evicts ownership into a
permissive state. Ownership does not grant authority: the policy must independently
match every context to a live lease.

This hook establishes the final boundary for tools that use the inspected
stock wrapper. It does not establish native Codex, ACP, delegation, asynchronous
job or Code Mode coverage. Run admission must independently reject unsupported
runtimes and tools. A native tool notification is not a blocking gate.

Validation: `tests/providers/openclaw/finalExecutionGuard.test.ts` uses isolated
Node processes. It covers argument mutation, immutable action identity,
WeakMap state, missing policy/readiness, pending deny/abort/replacement,
descendant tombstones, overflow, cross-run cancellation and source mismatch
before/after preflight. With the inspected installation available, it also runs
the actual transformed wrapper and real stock read/write/edit tools plus an
inert exec child in a temporary directory. No model or network call is made.
