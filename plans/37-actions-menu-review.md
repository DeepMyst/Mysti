# Actions menu: provider review and validation

Reviewed 2026-10-01 against the user's 1:18 PM screenshot. Scope: Attach file, Export conversation, Enhance prompt, Visual test, Canvas, persona selection/clear, Switch model, effort, Ultracode, and their shared composer controls. Prior full feature inventory remains in [review 34](34-feature-review.md); installer evidence is in [review 36](36-installer-reliability-review.md).

## Repairs

- Prompt enhancement now resolves the provider selected in the originating tab, instead of the global default. Responses carry request identities. Edited drafts, provider changes, conversation switches, timed-out requests and retries cannot receive a stale replacement. Empty prompts receive an explanation. An installed fallback remains attributed in the UI; absence/failure does not masquerade as an enhancement.
- Six CLI backends advertised images and wrote their bytes but omitted their paths from the actual prompt. The shared prompt builder now includes attachment references. Claude, Codex, Gemini, OpenCode, Qwen, Hermes and Kimi accept file attachments through the same verified transport. Temporary files use unique names, clean up on partial failure, and cannot overwrite or delete another turn's copy.
- The picker reports oversized, unreadable and unsupported files. SVG/ICO MIME values are corrected. Attach controls are disabled with a Context alternative when a provider has no attachment transport; paste/send still retains the existing unsupported-attachment warnings. Mysti/brainstorm now warn explicitly on an unsupported attachment send instead of silently dropping it.
- Export always reports an outcome, including an empty conversation and clipboard failure, and uses the originating tab's conversation.
- Cline, OpenClaw and Hermes previously showed selectable menu models despite declaring that their model is configured by the CLI. Their menu now explains this limitation. Supported providers get a direct Custom model action; native input validation and the shared settings writer preserve consistency. Changing providers while that input is open prevents writing to the wrong provider.
- Persona selection opens the catalog immediately even with a draft present; it no longer depends on an asynchronous recommendations request. Persona choices are keyboard buttons, including No persona.
- Effort remains driven by the provider's supported tiers and shared with Settings and the model menu. Ultracode remains an independent Claude capability, synchronized across its three controls. Blue fill/check marks and accessible state convey selected values; unsupported controls are hidden.

## Behavior by provider

All rows passed real Chromium menu interactions using the runtime provider registry/manifest. “Fallback” means an installed enhancement-capable provider is used and identified, otherwise enhancement is unavailable. “Context” means direct attachments are unavailable; adding file content through Context is the offered alternative. These are Mysti adapter capabilities, not claims about everything the upstream product might support.

| Provider | Attach file/image | Model control | Effort | Prompt enhancement | Ultracode |
| --- | --- | --- | --- | --- | --- |
| Claude | Both | Catalog + custom ID | Supported tiers | Native | Yes, subject to CLI/model/account support |
| Codex | Both | Catalog + custom ID | Supported tiers | Fallback | No |
| Gemini | Both | Catalog + custom ID | Hidden | Fallback | No |
| Cline | Context | CLI configuration | Hidden | Native | No |
| GitHub Copilot | Context | Catalog + custom ID | Supported tiers | Fallback | No |
| Cursor | Context | Catalog + custom ID | Hidden | Native | No |
| OpenClaw | Context | CLI configuration | Hidden | Native | No |
| OpenCode | Both | Custom ID | Hidden | Fallback | No |
| Ollama | Context | Custom ID | Supported tiers | Fallback | No |
| LocalAI | Context | Custom ID | Supported tiers | Fallback | No |
| Qwen | Both | Catalog + custom ID | Hidden | Fallback | No |
| Hermes | Both | CLI configuration | Hidden | Fallback | No |
| Continue | Context | Custom ID | Hidden | Fallback | No |
| OpenRouter | Context | Catalog + custom ID | Supported tiers | Fallback | No |
| Kimi | Both | Custom ID | Hidden | Fallback | No |
| Mysti | Context | Coordinator picker | Coordinator tiers | Resolved backend/fallback | No |

Export, persona selection, Visual test and Canvas are host features available independently of which provider is selected. Visual test opens its dashboard bound to the originating chat; observation uses the shared browser service. A running app/configured URL and installed browser are still required. Canvas opens/focuses its shared editor; existing binding, permission and execution tests remain part of the full suite. Opening either screen does not establish that every external model can autonomously fix a website or edit a canvas.

## Evidence

- `tests/webview/actionsProviderMatrixBrowser.test.ts`: all 15 catalog providers, Mysti coordinator picker, keyboard persona selection, attachment controls/previews/removal/send payloads, export feedback, Visual test/Canvas handoff, capability-aware models, custom model requests, effort, Ultracode and enhancement ownership.
- `tests/integration/actionsMenuReliability.test.ts`: host routing, correlated enhancement failure, export/clipboard outcomes, custom-model cancellation across provider changes, file picker data/MIME and rejection feedback.
- `tests/providers/attachmentPromptTransport.test.ts`: seven actual provider implementations write attachment bytes, include each path exactly once with persona guidance, and independently clean up concurrent copies.
- `tests/providers/promptEnhancement.test.ts`: explicit tab-provider resolution alongside installed-fallback, no-capability and no-change handling.
- Existing composer, model/effort, native approval, persona, Visual test policy/browser, Canvas and provider suites ran together with these regressions.
- **Live Claude and Codex passed** using Mysti's real provider transport and existing CLI accounts: each read a random token from an attached temporary text file and identified a generated blue PNG. Both used read-only access; no user files were used. [Machine-readable results](37-live-attachment-results.json). Explicit runner: `npx vitest run --config vitest.live.config.ts tests-live/menuAttachments.test.ts`.

## Verification and limits

- Complete suite: **13,686 passed across 430 files**, with no unhandled errors (`npm test -- --maxWorkers=6`).
- Separate account-backed attachment tests: **2 passed** (Claude and Codex).
- Type checking: passed.
- Lint: **0 errors, 455 warnings**; no broad automatic formatting rewrite.
- Release build and every VSIX package-shape assertion: passed. Artifact: `/tmp/mysti-actions-validated.vsix` (7.38 MB). Built, not installed into the running editor or published.

The first complete run exposed an extra model chip before catalog loading and a browser-test convention mismatch; both were fixed. A timer-dependent installer test was made deterministic with the browser's fake clock. Another run passed all assertions but reported a child-process console callback after test teardown; the Codex fixture now waits for child close handlers before ending.

Native Windows/Linux execution and authenticated inference for the other 13 providers were not repeated in this menu review. Browser tests ran on macOS. Model availability, vision support and account permissions remain provider/model dependent. This review does not resolve the undeployed DeepMyst website sign-in fix described in review 35.
