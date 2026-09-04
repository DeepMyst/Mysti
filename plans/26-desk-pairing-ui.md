# Plan 26 — Desk pairing UI: the ceremony, the roster, the invite

- **Date:** 2026-09-03
- **Status:** DRAFT — design settled, nothing built
- **Depends on:** `plans/21-desk-cross-machine-teamwork.md` (Phase 3). All the logic this plan
  drives already exists and is tested; see §1.
- **Blocks:** every manual test of Desk. `status` and `locate` need a pinned peer, and the only
  path to one is a ceremony that does not exist.

---

## 1. What exists, and what does not

The mechanism is complete and hardened. The surface is entirely absent.

| Built and tested | Missing |
|---|---|
| `DeskPairing.createInvite` — 10-min expiry, single-use, rate-limited (8 reviews/min, 512 tracked) | Any way for a human to trigger it |
| `buildInviteUrl` / `parseInviteUrl` — `desk://pair?…`, field-validated, drop-not-repair | An invite paste box, a copy button, a `desk://` UriHandler |
| `DeskPairing.review` — returns peerId + safety number; deliberately does not pin, does not consume | The modal that shows them |
| `safetyNumber(a, b)` — symmetric, grouped digits | Any rendering of it |
| `DeskPeerBook.addPeer` — pinning, alias validation, the `alice (2)` ordinal family | Alias + trustDomain entry |
| `DeskPeerBook.revoke` / `listPeers` / `isRevoked` | A roster panel |

`DeskPairing` and `DeskIdentity` are imported by nothing but their own tests. **Verified:**
`media/chat/desk.js` and `desk.css` do not exist; `package.json` contributes no `desk` command;
`index.html` and `chat.js` contain zero occurrences of "desk".

---

## 2. The ceremony is the design problem

Everything else here is plumbing. This section is the plan.

### 2.1 The failure mode we are designing against

A fingerprint modal that shows a number and a **Confirm** button does not produce verification.
It produces *the feeling* of verification, which is worse than nothing: it manufactures
confidence that no comparison actually happened. Signal and WhatsApp have shipped safety numbers
for a decade and the overwhelming majority of users have never compared one.

Plan 21 §13.1 already established the general rule from the consent literature — developers
approve 93–97% of permission prompts, and habituation begins at the *second* exposure. A prompt
people click through is not a control.

**But pairing is different from consulting, and the difference is the whole opportunity.**

### 2.2 Spend the friction budget where it is rare

| | `consult` card | Pairing ceremony |
|---|---|---|
| How often | many times a day | once per teammate, ever |
| Cost of friction | habituation → the card stops being read | a minute, once |
| Cost of getting it wrong | one disclosure | **every** future disclosure to that peer |

This is why Plan 21 pushed *toward* fewer, batched consult cards (§13.3 D2) and why this plan
pushes the opposite way for pairing. Pairing is the root of all subsequent trust and it happens
approximately never. **It should be deliberately effortful.** Any argument that begins "this is
too many steps" is answering the consult question, not this one.

### 2.3 Active comparison, not passive display

The design rule: **the human must not be able to complete the ceremony without having actually
read the number aloud to the other person.**

A Confirm button can be clicked while looking at nothing. So the confirm step is a challenge:

```
Your safety number with this peer:

   48213  90577  31264  88041
   67195  20338  54710  93826
   11459  78602  40157  25983

Read it aloud to them, on a different channel than the invite came through.
Then type groups  3, 7 and 12  to continue:

   [_____]  [_____]  [_____]
```

- Three groups of five digits ⇒ guessing is ~1 in 10¹⁵. Typing the whole number is
  disproportionate; picking from three candidate numbers is a 1-in-3 guess and shoulder-checks
  too easily.
- **Which three groups are demanded is derived from the safety number itself** (§6.1), so both
  machines highlight the same three and a user still cannot learn "it's always the first three" —
  the indices differ per peer.
- The digits are grouped in fives because that is what people read aloud accurately. A wall of
  hex is not read aloud; it is skimmed.

**Rejected alternative — QR scan.** Best UX by far, and correct for phone-to-phone. Wrong here:
Desk is desktop-to-desktop, so a QR means "point your phone at your colleague's monitor", which
is not obviously easier than reading digits and adds a camera dependency for a once-per-peer flow.
Worth revisiting if a mobile companion ever exists.

### 2.4 Out-of-band, by construction

If the invite link arrives in Slack and the safety number is compared in Slack, an attacker who
owns Slack owns both halves and the ceremony proves nothing.

The UI must say this in the words that make the failure concrete:

> Compare this on a **different channel** than the invite arrived on — a phone call, in person,
> a video call. If someone can read both, they can sit in the middle of both.

We cannot *enforce* out-of-band; we can refuse to pretend it does not matter. The copy is a
control, not decoration.

### 2.5 Both sides verify, and both sides are told so

`safetyNumber(a, b)` is symmetric — deliberately, so that whoever initiated is irrelevant and
both people see the same string. The ceremony therefore runs **independently on both machines**,
and each side's modal states plainly that pairing is not complete until the *other* person has
done it too. A one-sided ceremony verifies nothing: the unverified side is exactly where an
interceptor sits.

### 2.6 Name the failure, not the action

Not "Verify identity" (an abstraction nobody models) but:

> If these numbers differ, **someone is intercepting this pairing**. Stop and tell them.

And on the grant step, the consequence rather than the mechanism:

> `alice` will be able to ask what symbols exist in `src/billing` and get file paths and line
> numbers back. She will **not** be able to read file contents, write anything, or run anything.

### 2.7 Cancel is the easy path

Escape, click-outside and Cancel all abandon; only typing the challenge digits pins. There is no
"skip verification" affordance, no "remind me later", and no keyboard path that reaches Pin
without passing the challenge. If a user genuinely wants to pair without verifying, the honest
answer is that they should not, and the UI does not offer to help.

---

## 3. Phases

Each phase ends green and useful on its own.

### Phase A — Identity + roster, read-only (~half a day)

The smallest thing that proves the wiring, with no pairing yet.

**Create**
- `media/chat/desk.js` — the Desk rail: renders identity and roster, posts messages, no state of
  its own beyond what the extension sends.
- `media/chat/desk.css` — scoped to `.desk-*`, using `var(--vscode-*)` tokens throughout.

**Modify**
- `media/chat/index.html` — a `<section id="desk-rail" class="desk-rail hidden">` inside the
  existing sidebar, plus the `desk.js` / `desk.css` tags (nonce'd; CSP is
  `script-src 'nonce-…'`, so **no inline handlers** — `addEventListener` only).
- `src/webview/webviewContent.ts` — `deskCssUri` / `deskJsUri` beside the existing
  `chatCssUri` / `chatJsUri`, same cache-busting query.
- `src/providers/ChatViewProvider.ts` — `deskRosterUpdated` outbound message; `deskRequestRoster`
  inbound. Modelled on the existing `providerAvailability` broadcast.
- `package.json` — command `mysti.deskRoster` ("Desk: Show teammates").

**Shows:** my own device fingerprint (from `DeskIdentity.ensure()`), and each peer's alias,
trust domain, granted verbs, expiry, and a **Revoke** button.

**Done when:** the rail renders with zero peers and does not appear at all when
`mysti.desk.enabled` is false.

### Phase B — The invite side (~half a day)

**Modify:** `desk.js`, `index.html`, `ChatViewProvider.ts`, `package.json`
(`mysti.deskPair`).

- "Invite a teammate" → `DeskPairing.createInvite(ownPublicKey)` → a copyable
  `desk://pair?…` link with a visible countdown ("expires in 9:47").
- The link is **not a credential** — it carries a public key and a nonce. The UI says so, because
  every reader will assume otherwise and either over-protect it or under-protect the ceremony.
- Expiry is shown live, and an expired invite renders as expired rather than silently failing on
  use.

### Phase C — The ceremony (~1 day, the phase that matters)

**Create:** `src/managers/DeskPairingFlow.ts` — orchestrates review → challenge → alias/grant →
pin. Extension-side, because it must touch `DeskPeerBook` and `SecretStorage`; the webview only
renders and reports.

**Modify:** `desk.js` (the modal), `index.html` (a `desk-pair-overlay` modelled on the existing
`autonomous-confirm-overlay`), `ChatViewProvider.ts` (message plumbing).

Flow, in order:

1. Paste an invite → `parseInviteUrl` → `DeskPairing.review(url, ownPublicKey)`.
2. **Challenge modal** (§2.3): grouped safety number, out-of-band instruction, three randomly
   chosen groups to type. Wrong digits → refuse, re-randomise which groups are demanded, and do
   **not** say which group was wrong.
3. **Grant step**: alias (validated by `DeskContract.validateAlias`, with the `alice (2)` ordinal
   surfaced if the base is taken), `trustDomain`, and the verb set — defaulting to
   `status` + `locate` only, which are the two that need no model turn and disclose no content.
4. `DeskPairing.consume(inviteId, publicKey)` → **only if it returns true** →
   `DeskPeerBook.addPeer`. Pinning before consuming re-introduces multi-use; the call order is
   the invariant.

**Done when:** two VS Code windows on one machine pair with each other and both rosters show the
other, with mismatched digits refusing.

### Phase D — Polish and the sharp edges (~half a day)

- `desk://` UriHandler in `extension.ts` + `package.json`, so a clicked link opens Mysti. Paste
  keeps working; this is an accelerator, not the path.
- **Key rotation renders as what it is**: `alice (2) — unverified, different key from the alice
  you trust`, per I13. A rotated key inherits no pin and no history, and the roster must not let
  it look like a continuation.
- Revoke: modal confirm, and the roster shows revoked peers as revoked rather than removing the
  row — a disappearing row is indistinguishable from a bug.
- **Identity reset** surfaces the consequence: every peer must re-pair. `DeskIdentity.reset()`
  cannot see the roster, so the UI owns that sentence.
- Empty, error and expired states for every panel.

---

## 4. Files

**New**
```
media/chat/desk.js
media/chat/desk.css
src/managers/DeskPairingFlow.ts
tests/managers/deskPairingFlow.test.ts
tests/webview/deskEscaping.test.ts
```

**Modified**
```
media/chat/index.html          rail markup + pair overlay + asset tags
src/webview/webviewContent.ts  desk asset URIs
src/providers/ChatViewProvider.ts  message plumbing (5 message types)
src/extension.ts               DeskPairingFlow construction, UriHandler
package.json                   mysti.deskPair, mysti.deskRoster
```

**Contention note.** `index.html`, `chat.js`, `package.json`, `extension.ts` and
`ChatViewProvider.ts` were held by a concurrent session throughout the Plan 21 overnight build.
Phase A cannot start until that lands, or it will either clobber that work or fold it into these
commits.

---

## 5. Tests

- `tests/managers/deskPairingFlow.test.ts` — the call order is the invariant: pinning without a
  successful `consume` must be impossible; a wrong challenge never pins; re-randomisation happens
  on failure; a self-invite is refused.
- `tests/webview/deskEscaping.test.ts` — **no unescaped interpolation of any peer-supplied
  string.** Render a roster whose alias, trust domain and title are
  `</script><img src=x onerror=…>`, a bidi override, and a 10 KB string; assert escaped output and
  no layout escape. Plan 21 §13.5 I37 also forbids auto-fetching any remote resource referenced by
  peer content — the roster renders no images from peer data at all.
- Extend `tests/utils/settingsScopeHardening.test.ts` if any `mysti.desk.*` setting is added.

---

## 6. The three judgment calls, decided

Left open in the first draft, then decided on the instruction "do whatever you feel best for
developers". Each is a product judgment, so the reasoning is recorded rather than just the answer.

### 6.1 Three groups — and both sides are shown the SAME three

**Decided: three groups, with the indices derived deterministically from the safety number.**

Three groups of five digits is ~1-in-10^15 to guess and takes about fifteen seconds to read
aloud. One group (1-in-100 000) is guessable by someone who gets a few attempts at a ceremony
they can re-trigger; typing all twelve is disproportionate for something whose whole job is to be
completed honestly.

The refinement that matters for the developer experience: the demanded indices are derived from
`sha256(safetyNumber)`, so **both machines highlight the same three groups**. Without that, the
call goes "which ones do you need? …no, mine says 4, 9 and 2" — a coordination step that adds
nothing and gives people a reason to give up. With it: both screens say *groups 3, 7 and 12*, one
person reads fifteen digits, the other types them.

Deriving rather than randomising also means a retry shows the same groups, so a typo is
correctable. Brute force is not the threat at 10^15; a person who mistyped is. Attempts are capped
at three, after which the session is destroyed and the invite must be re-issued.

### 6.2 Grant at pairing, with `consult` unchecked and its cost stated

**Decided: all grantable verbs appear at pairing. `status` and `locate` default on; `consult` and
`review` default off with the consequence written next to them.**

The grant is written by the RECEIVER, so what is actually being decided is "may this person spend
my tokens and my attention". That is a real decision and it should be visible at the moment trust
is established, not buried in a roster nobody revisits.

But making it a *second trip* would backfire. If every real use of Desk needs `consult`, then a
safe default that forces a second navigation reads as an obstacle, and the reliable human response
to an obstacle is to grant everything up front next time to avoid it. One screen, honest defaults,
the cost stated inline:

> ☐ **consult** — alice may ask your agent questions about your code. Each question costs you a
> model turn, and you approve the answer before it is sent.

### 6.3 The rail is visible when the feature is on, and collapses when empty

**Decided: no rail at all when `mysti.desk.enabled` is false; a single collapsed line when
enabled with no peers; expanded when peers exist. Commands exist as well, for keyboard users.**

Command-only is the wrong default for a feature someone deliberately turned on — it gets
forgotten, and a forgotten Desk is a Desk that never gets tested. But an empty panel eating
sidebar space in a window with no teammates is the standard way features earn resentment.

Collapsed-when-empty gets both: one line reading `Desk — no teammates yet · Invite`, which is
discoverable and costs nothing.

---

## 7. What this plan does not cover

The remaining Plan 21 integration — `_deskEnabled()`, `scanKinds` registration, the dispatch
branch, `_runMystiDeskTool`, `_fenceDeskResult`, the `extension.ts` options bag, and adding
`consult`/`review` to `DeskDispatch.IMPLEMENTED`. That is tracked in plan 21 §16.5 and is a
separate piece of work; **this plan only makes pairing possible**, which is the prerequisite for
testing any of it by hand.
