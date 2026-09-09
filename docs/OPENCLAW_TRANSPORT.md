# OpenClaw transport contract

The transport fixtures target the installed OpenClaw **2026.6.34** gateway
protocol 4. They exercise real loopback WebSockets and inert child processes.
They do not establish authenticated provider compatibility or native approval
coverage. The remaining authority gaps are tracked in [NATIVE_APPROVAL.md](NATIVE_APPROVAL.md).

## Ownership boundaries

- `OpenClawGateway` owns the connection, RPC requests and reconnection. Concurrent
  connection callers share one attempt. A retired socket cannot change the state
  of its replacement. Disconnect rejects waiting requests and releases timers.
- `OpenClawAgentRun` owns a single run's queue, deadline, stream normalization,
  tool identities and cancellation. Gateway RPC request IDs and agent run IDs
  are distinct: the caller's unique idempotency key is the run ID.
- `OpenClawProvider` owns submission across connection, prompt preparation and
  transport selection. Stop during preparation prevents submission; abandoning
  the gateway iterator also aborts its pending read. Once submitted, a failed
  gateway run is not replayed through the CLI.
- `BaseCliProvider` owns CLI spawning, process tracking and cleanup. OpenClaw's
  optional pre-spawn hook writes a complete private prompt file before the child
  can read it. `readCliStdout` keeps one pending read across stderr heartbeats
  and binds cancellation and inactivity termination to the captured child.

The logical OpenClaw session key is shared by both transports. It is separate
from the CLI's returned transcript UUID. Clearing a session rotates only that
panel's key. A gateway session indicator does not establish resumable history;
that state is saved after the matching accepted acknowledgement.

## Gateway frames

The client advertises protocols 3–4 and validates the negotiated hello. The
protocol 4 implementation is the version exercised by these fixtures. The
`tool-events` capability requests native tool observations; it does not advertise
or implement an approval client.

| Frame | Handling |
| --- | --- |
| `agent` request | Unique idempotency/run ID and explicit session key; attachment bytes use the native RPC attachment fields. |
| Accepted response | Must match the run ID before adopting the canonical session key. Retain the final-response subscription. |
| Agent event | Require the owned run ID. After acceptance, reject a conflicting session key when present. |
| Tool event | Preserve tool-call ID, concrete arguments, output and failure state. Partial output is retained until the result. |
| Assistant/chat text | Use native assistant deltas; retain chat snapshots as fallback and reconcile final text without replaying it. |
| Lifecycle end/error | Not authoritative completion: the runtime may retry after these events. |
| Final response | Read `payload.result.payloads`; inspect `payload.status` even when `ok` is true. |
| `in_flight` response | Report recovery required; this duplicate-request response has no later final response on the same RPC. |

Cancelling sends `sessions.abort` with the owned key and run ID, plus the
accepted agent ID when supplied. It never sends the nonexistent `agent.stop`,
and never issues an unscoped session abort. An abort before server reservation
can return `no-active-run`. A cancelled request therefore retains a bounded
acknowledgement watcher and repeats the targeted abort if acceptance arrives
late. The watcher expires after the remaining request budget, with a 30-second
minimum, and is released on acknowledgement, terminal response or disconnect.
A disconnected client cannot prove that remote work stopped; native run-policy
revocation remains part of the approval work.

The installed gateway rejects empty attachment bodies; Mysti reports that
specific limitation before submission. CLI attachments are materialized in
request-owned files and their paths are included in the prompt file. Cleanup of
an old turn cannot remove a replacement's files or process registration.

## Verification

Run the bounded adapter checks without credentials:

```sh
npx vitest run tests/providers/openclaw
npm run typecheck
```

`gatewayTransport.test.ts` uses real sockets for concurrent panels, pre-ack
noise, canonical aliases, cancellation before/after acceptance, paused consumers,
iterator return/throw, timeout, shutdown, failed handshake and socket replacement.
`gatewayProviderLifecycle.test.ts` exercises the actual provider boundary around
connection/prompt awaits, history, session clearing, attachments and final chunks.
`cliLifecycle.test.ts` runs inert Node children that immediately read the prompt
file, return NDJSON or formatted JSON, fail to start, or remain silent until Stop.
The run-owner tests check normalization, identity guards, deadlines and cleanup.

Version-specific implementation decisions were checked against these files in
the installed OpenClaw distribution, rather than inferred from `--help`:

- `dist/agent-FRfbCcij.js`: run ID assignment, accepted/final response contracts,
  and reservation before execution.
- `dist/sessions-CWuNzfod.js`: `sessions.abort` routing and ownership.
- `dist/selection-DopzNY3I.js`: native tool start/update/result events.
- `dist/attachment-normalize-C1345x-8.js`: RPC attachment normalization and empty
  payload rejection.
- `dist/register.agent-turn-CfOzQ9g2.js`: CLI parser registration.
- Bundled `docs/gateway/protocol.md` and gateway-protocol schema declarations.

## Remaining release work

The CLI parser still rejects Mysti's `--sandbox` and `--yolo` flags. They must be
replaced together with real native authority enforcement, not simply removed.
The gateway also lacks a bridge that enforces Mysti's mode/access settings before
all tool execution. Exec-only approvals do not cover file edits or arbitrary
plugin tools. A versioned policy/approval bridge, sentinel side-effect tests,
and an authenticated disposable-workspace smoke are still required. Transport
fixture passes must not be described as approval or release-readiness evidence.
