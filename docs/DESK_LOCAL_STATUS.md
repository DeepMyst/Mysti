# Desk local status

Desk can exchange signed availability between paired editor profiles on the
same computer. This is the loopback transport tier. Cross-machine transport,
workspace lookup, consultation, review and task execution are not integrated.

1. In two disposable editor profiles, enable `mysti.desk.enabled` and complete
   Desk pairing, including comparing the safety number. Grant `status` to the
   profile that will check your availability. Each profile must have a distinct
   Desk identity; windows sharing one profile also share its device identity.
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

Only the fixed availability value and `focus: null` are returned. No workspace
files are read, no source or paths are disclosed, and no model is called.
Successful status requests consume the grant's lifetime call allowance at zero
dollar cost. Identical signed retries return the same cached result without
another debit; changed bytes under the same call ID are refused. A revoked or
expired peer cannot retrieve a cached result.

The listener binds to an ephemeral port on `127.0.0.1`. The client accepts only
that literal address and the `/desk` path; it does not resolve hostnames, use a
proxy, follow redirects, or dial another machine. Bodies, response reads,
deadlines, sessions and cached calls are bounded. The extension owns the
listener's configuration, workspace-trust and disposal lifecycle. Signing uses
SecretStorage through `DeskIdentity`; the client never receives the private key.

`tests/services/deskLocalStatus.test.ts` exercises the real HTTP path with fresh
generated identities and in-memory stores, including signed replies, forged
requests, duplicate calls, limits, revocation, expiry, failed persistence and
configuration races. This is local protocol evidence. It does not establish
two-machine acceptance or replace testing both editor profiles manually.
