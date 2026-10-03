# Mysti 2.0 BETA candidate validation

This report describes the release candidate in this branch. It is not a claim that the beta has been published to the Marketplace.

## Automated behavior checks

- **13,744 tests passed across 439 files**, excluding the separately scheduled frame-performance suite.
- **3 performance tests passed** in that separate suite. Total: **13,747 passing tests across 440 files**.
- TypeScript passes. ESLint reports **zero errors and 455 existing warnings**.
- Regression coverage exercises both providers starting before either completes, selected-provider inclusion, host resolution when the webview catalog has not loaded, dependency handoffs, blocked prerequisites, partial failure, serialized writers, role access, model isolation, native approval, cancellation and final attribution.
- Chromium exercises the actual chat assets: concurrent cards, independent text streams, failure rendering, stale-event rejection, safe Markdown, narrow layouts, final responses and collapsed activity cards.
- Conversation-store tests verify participant attribution through a fresh manager reload and reject invalid participant IDs.

An intermediate run concurrent with native/editor and media workloads hit two existing Canvas compiler test timeouts. The final broad run passed unchanged assertions without those competing workloads. No timeout threshold was relaxed.

## Live provider check

An opt-in test ran inside real VS Code **1.140.0 on macOS**, using installed **Claude Code 2.1.288** and **Codex CLI 0.153.4**. With Codex selected, one tagged prompt asked both providers for an independent TTL-cache opinion under read-only settings. Both returned their own responses, their cards completed, and the final combined response retained participant attribution. The native editor suite reported **11 passed**, including this live check.

That run caught a missing final-response render after collaborator-only output. The host now creates the final response stream before completion, with a browser regression test. The successful rerun verified the correction.

This is one platform/account combination, not certification of all providers or models. Native live checks are opt-in and are not silently run in public CI.

## Packaging and release gates

The release candidate is packaged as `mysti-2.0.0-beta.vsix` with the Marketplace pre-release flag. Required CI covers build/tests on Windows, macOS and Linux, minimum Node runtime, lint, package shape, native editor integration, and the verified VSIX in VS Code 1.86/stable. Final hosted check status is recorded on the release PR.

Marketing assets are excluded from the installed payload. The README uses PNG/GIF images and a linked MP4; no Marketplace support for embedded video or Mermaid is assumed.

## Remaining limitations

- Live authenticated Windows/Linux runs and broader provider/account coverage remain release-validation work.
- Explicit collaborator dispatch does not forward composer attachments; use Context or `@file`.
- Current assignment timelines are live UI; saved history retains attributed answer text and participant metadata, not every live card event.
- Proactive's broader cloud pilot, source coverage and mobile/phone roadmap remain as documented in plans 43–44.
- No Marketplace publication or new backend deployment is performed by this candidate's documentation/media update.

## Verified VSIX

The extracted final pre-release VSIX passed the same **11 native editor tests**, including the authenticated two-provider assignment test. [Live capture](README.md#live-provider-evidence) records the actual packaged run.

SHA-256: `812657132dfb9f77297f12e703ff712a88c551c99b90b247705f5d98d13bba50`.

Package shape passes: runtime dependencies and walkthrough assets are present, development source maps/types are excluded, and the new release media is not installed with the extension. The existing walkthrough screenshots remain intentionally bundled.
