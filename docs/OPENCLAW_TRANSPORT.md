# OpenClaw transport contract

The transport fixtures target the installed OpenClaw **2026.6.34** gateway
protocol 4. They exercise real loopback WebSockets and inert child processes.
They do not establish authenticated provider compatibility. Native execution
authority is covered separately by [the owned policy contract](OPENCLAW_NATIVE_POLICY.md).

## Ownership boundaries

- `OpenClawGateway` owns the connection, RPC requests and reconnection. Concurrent
  connection callers share one attempt. A retired socket cannot change the state
  of its replacement. Disconnect rejects waiting requests and releases timers.
- `OpenClawAgentRun` owns a single run's queue, deadline, stream normalization,
  tool identities and cancellation. Gateway RPC request IDs and agent run IDs
  are distinct: the caller's unique idempotency key is the run ID.
- `OpenClawProvider` owns submission across connection, prompt preparation and
  native runtime admission. Stop during preparation prevents submission; abandoning
  the gateway iterator also aborts its pending read. Agent sends require a live
  policy lease, and no failure is replayed through an unguarded CLI.
- `BaseCliProvider` owns CLI spawning, process tracking and cleanup. OpenClaw's
  optional pre-spawn hook writes a complete private prompt file before the child
  can read it. `readCliStdout` keeps one pending read across stderr heartbeats
  and binds cancellation and inactivity termination to the captured child.

The logical OpenClaw session key identifies the panel within its owned runtime.
It is separate from a native transcript UUID. Clearing a session rotates only that
panel's key. A gateway session indicator does not establish resumable history;
that state is saved after the matching accepted acknowledgement.

## Gateway frames

The client advertises protocols 3–4 and validates the negotiated hello. The
protocol 4 implementation is the version exercised by these fixtures. The
`tool-events` capability requests native tool observations; it does not advertise
or implement an approval client.

The owned loopback runtime uses OpenClaw's authenticated backend client identity
and requires granted `operator.write` authority and the agent/abort methods in
its hello response. A successful CLI-style hello can have no granted scopes;
it is insufficient as an agent readiness check. Fresh run IDs are single-use
within the gateway client, with a bounded history that fails closed on overflow.
Time awaiting a native permission card pauses the remaining execution budget.

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
Transport cancellation alone cannot prove that remote work stopped. The owned
native policy also revokes the run grant and its execution abort signal.

The installed gateway rejects empty attachment bodies; Mysti reports that
specific limitation before submission. The legacy private CLI prompt-file
helpers remain regression-tested, but public agent execution has no CLI fallback.

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
`cliLifecycle.test.ts` checks explicit configuration, discovery and startup
failure without executing an unguarded agent. `messageDelivery.test.ts` retains
historical private-file helper coverage. `managedRuntime.test.ts` checks private
provisioning and process cleanup. The run-owner tests check normalization,
identity guards, deadlines and cleanup; `nativePolicyIntegration.test.ts`
exercises the actual installed gateway and native tools against a local fake model.

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

## Native policy and remaining acceptance

Agent execution uses the [owned native policy runtime](OPENCLAW_NATIVE_POLICY.md),
with a per-turn immutable policy, exact final-action digest and revocable grant.
Only its verified embedded tool path is admitted. The former unsupported
`--sandbox`/`--yolo` fallback and shared `chat.send` agent delegation are disabled.
Channel markers use direct delivery to configured targets or exact international
phone numbers; fuzzy contact resolution cannot start an unowned agent.

Transport passes and local fake-model fixtures do not establish authenticated
account compatibility, alternate harness support or cross-platform editor
release readiness. Those remain separate acceptance requirements.
