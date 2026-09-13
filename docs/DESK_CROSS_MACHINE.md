# Desk cross-machine transport: implementation and acceptance

Desk platform builds provide explicit cross-machine status and workspace lookup
commands through the pinned native iroh binding. **Relay and two-machine
acceptance remain open.** The universal VSIX continues to provide local Desk;
it does not contain a native runtime. No model or remote task execution is enabled.

## Using the platform build

1. Build with `npm ci` and `npm run package:desk -- --out mysti-desk.vsix` on
   macOS ARM64, Linux x64 (glibc), or Windows x64. The archive declares its actual
   platform; `npm run check:package -- mysti-desk.vsix` verifies the native payload,
   worker, license, target and hash. Each target needs its own editor acceptance.
2. In disposable profiles on both machines, enable Desk and pair both directions
   with the existing safety-number check. Set `mysti.desk.relayUrl` in User
   Settings to the same self-hosted or paid HTTPS relay root, with a trailing
   slash. Empty is disabled; repository settings cannot select a relay.
3. On the serving machine, enable `mysti.desk.serve` and grant the paired recipient
   `status` or `locate`. Run **Desk: Share cross-machine status** or **Desk: Share
   cross-machine workspace lookup**. Lookup uses the same explicit folder and
   scope preparation described in [local Desk](DESK_LOCAL_STATUS.md).
4. Transfer the temporary link to that paired recipient. Run **Desk: Check
   cross-machine status** or **Desk: Look up cross-machine workspace** there.
   Both settings and a matching signed relay descriptor are required before
   dialing. A new local or cross-machine link replaces that recipient's old link.

Native endpoints start only after these explicit commands. Enabling a setting or
opening the editor does not contact a relay. Node below 20.3 and Intel macOS
refuse native access; the minimum VS Code contract and local commands remain.

## Implemented

- `DeskIrohTransport` carries the existing signed Desk envelopes over bounded
  bidirectional QUIC streams. It checks the native responder identity before
  sending the bearer or query. Each outbound call owns its endpoint, so abort
  and deadline handling can close a pending native dial.
- `DeskIrohServer` handles one request per connection, authenticates a fixed
  32-byte header before reading or parsing JSON, bounds bodies/replies at 64 KiB,
  admits at most four simultaneous requests and 32 connections per minute, and
  applies a shared ten-second handshake/request/delivery deadline. The native
  binding cannot cancel an accepting handshake separately; its deadline closes
  the channel endpoint. Shutdown discards late application responses.
- `DeskIrohLink` verifies a signed, expiring connection descriptor against an
  already pinned device key, recipient and operator-approved relay **before
  dialing**. Peer-controlled links cannot introduce a different relay URL.
- `bindDeskIroh` applies the minimal preset plus one explicitly configured HTTPS
  relay. It does not apply public relay/discovery defaults, load a native module,
  read environment-based library overrides, or start anything at import time.
- `DeskCrossMachine` owns at most four serving channels and four outbound calls
  per editor window. It verifies a signed descriptor before native creation,
  then carries requests into the existing local dispatcher. Configuration and
  folder changes stop channels and calls. Each request checks identity, scope,
  expiry and revocation; idle revoked/reset/rotated channels close within one
  second. A separate elapsed-time expiry bounds lifetime even on clock rollback.
- `DeskIrohProcess` forks the packaged worker with a small environment allowlist,
  without provider credentials, native-library overrides or Node startup flags.
  The child creates an ephemeral transport identity and receives bounded signed envelopes,
  never the device private key, vault, workspace reader or provider handles.
  Native startup has a five-second limit; outbound startup and I/O share the
  five-second call deadline. Abort, disposal or a stalled native bind/close can
  terminate the child process independently of the binding's promises.
- Native tests carry signed status and scoped workspace lookup through actual
  encrypted local streams into the existing production dispatcher and call
  ledger. Revocation and idle shutdown are exercised too. Protocol tests cover
  forgery, pin/recipient/relay substitution, expiry, malformed frames, limits,
  stalled dialing/handshakes, and disposal races.

Plan 21 section 13.3 D1 specifies the iroh tier. This implementation refines its
identity binding: the existing pinned device signs a short-lived transport key,
so its long-term private signing key is not exported into the native binding.
The connection descriptor has to be verified against the existing pin, and the
native connection has to match the descriptor's endpoint key. A ticket by itself
does not establish a new device pin or grant. There is no new pairing ceremony.

## Native packaging and compatibility

The exact build/test dependency is `@number0/iroh@1.1.0`. Its published manifest
requires Node >=20.3.0 and provides no Intel macOS native target. The extension's
minimum editor embeds Node 18.17.1. The new minimum-runtime fixture proves refusal
before touching a native binding; local Desk remains available on that editor.

The npm tarball puts `index.js` and `index.d.ts` at its root while its manifest
points to `iroh-js/index.js` and `iroh-js/index.d.ts`. Its generated loader also
supports an environment override and a Linux `ldd` subprocess fallback. Native
tests load the pinned platform package directly, avoiding those paths. The binding
actually emits 64-character hexadecimal endpoint IDs; the generated declaration
comments describing those strings as base32 do not match the observed API.

The JS SDK remains a development dependency. `package:desk` copies only the
host's lockfile-pinned native binary into `resources/desk-native`, records its
SHA-256, includes the upstream MIT license, and selects the matching VSIX target.
The worker verifies its target, version and binary hash before direct loading.
It bypasses the upstream JS loader entirely. The native package's own manifest
omits a version, so the integrity-verified npm lock entry supplies that version.
`npm run package` removes any prepared native payload before building the
universal archive. Merely copying one platform's binary into a universal VSIX
fails the package-shape gate.

The editor CI jobs build and install their actual platform archive. Their native
probe uses the editor's embedded runtime and an explicitly local, unserved relay
address to check binding and process teardown. The minimum Linux editor must
refuse the same packaged payload before native initialization. This establishes
packaging/runtime behavior, not relay or cross-machine operation. Linux ARM,
Windows ARM, musl Linux and Intel macOS have no accepted build in this workflow.

Remaining external acceptance:

1. Configure a self-hosted or paid relay. No relay was supplied or deployed in
   this work; no public relay or discovery service is used by the fixtures.
2. Complete two-editor and two-machine acceptance using disposable identities,
   synthetic workspaces and no real model/provider calls.

The local probe revealed that `bindAddr('127.0.0.1:0')` still leaves an IPv6
wildcard socket in this binding. The local acceptance probe therefore blocks
off-machine networking at the OS boundary. Its result is encrypted local
protocol evidence, not proof of a loopback-only native bind, relay behavior,
hole punching, direct-path upgrade, or two-machine operation.

## Two-machine acceptance record

Record each machine's OS/architecture, editor and embedded Node versions, native
package integrity, VSIX hash, approved relay URL and paired-key fingerprints.
Use fresh private profiles and temporary workspaces. Verify:

1. Pair both directions with the existing safety-number check; verify the signed
   connection descriptor before sending any query.
2. Serve signed status and exact scoped coordinates. Prove that out-of-scope,
   private and linked files are not read or disclosed.
3. Try a forged/replayed descriptor, wrong recipient, different relay, expired
   grant, exhausted allowance, revoked peer and a scope change during a call.
4. Interrupt the caller, disconnect the network, stop serving, close the editor
   and restart. Confirm bounded failure and that stale endpoints/links never
   regain authority.
5. Exercise the approved relay and separately record any direct-path upgrade.
   A local fixture or two processes on one host cannot close these checks.

Primary references: [published package metadata](https://registry.npmjs.org/@number0/iroh/1.1.0),
[binding source](https://github.com/n0-computer/iroh-ffi/tree/main/iroh-js),
[iroh transport overview](https://github.com/n0-computer/iroh), and
[relay documentation](https://docs.iroh.computer/concepts/relays).
