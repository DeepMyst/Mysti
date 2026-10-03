# Installer reliability validation

Reviewed 2026-10-01 on macOS arm64. Continues [review 35](35-menus-installers-signin-review.md). This is installation and setup evidence; a successful version command does not establish authenticated model inference.

## Fixed in this pass

- Open the install popup immediately, show loading failures with Retry, and ignore outdated replies, including older requests for the same provider. Completion/retry timers cannot alter a newly opened dialog.
- Keep Refresh detection pending until the extension reports actual completion; update installed/authenticated state and offer Continue setup for an installed CLI. Manual installation from the onboarding wizard now uses the same request path.
- Move authentication choices outside the hidden onboarding wizard. Dismiss the installer before authentication, provide keyboard buttons and cancellation, and show connection progress with an exit. Authentication errors always retain retry/close controls.
- Prompt securely when API Key is selected instead of falling through to OAuth. Explain the session lifetime of environment-based keys. Use the discovered absolute CLI path and its directory on PATH for terminal sign-in, including installations under Mysti's private prefix.
- Route OpenRouter and LocalAI connection setup to settings. Never execute OpenRouter's English configuration instructions as a shell command. Give Ollama and LocalAI explicit server/model prerequisites.
- Replace Gemini's unsupported `GOOGLE_GENAI_USE_GCA` mutation with the documented Gemini CLI route for Vertex AI. It requires Cloud credentials, project and location; it does not silently configure a Cloud account or modify shell profiles. [Official authentication instructions](https://geminicli.com/docs/get-started/authentication/).
- Require Node only when a missing CLI actually needs an npm install. Share duplicate automatic installation requests, refresh discovery after installation, and deduplicate/dispose manual-install watchers.
- Bound installer output and terminate the process tree on timeout before permitting retry. Keep missing-executable errors distinct from timeouts. Cancel authentication polling on skip, panel disposal and replacement; contain probe and setup exceptions and report actionable failures.

## Provider evidence

Every catalog provider below passed browser rendering/action checks with macOS, Linux and Windows installer selections (45 combinations). These run in real Chromium on macOS; they do **not** execute Windows commands or simulate a Windows kernel. Two additional browser cases cover wizard handoff and stale completion timers, alongside loading/retry, auth handoff, keyboard cancellation and detection completion.

| Provider | Actual installation/runtime evidence | Remaining installation coverage |
| --- | --- | --- |
| Claude | Fresh npm 2.1.286 install and version on macOS (review 35) and Linux arm64 | Windows native execution |
| Codex | Fresh npm 0.159.3 install/version on macOS and Linux arm64; macOS login help | Windows native execution |
| Gemini | Fresh npm 0.62.0 install/version on macOS and Linux arm64 | Windows; interactive sign-in/Vertex AI account |
| Cline | Fresh npm 3.0.67 global-layout install/version on macOS | Linux interrupted; Windows |
| GitHub Copilot | Fresh npm 1.0.90 install/version on macOS | Linux interrupted; Windows |
| OpenCode | Fresh npm 1.18.34 install/version on macOS | Linux interrupted; Windows |
| Qwen | Fresh npm 0.24.7 install/version on macOS | Linux interrupted; Windows |
| Continue | Fresh npm 1.5.47 install/version on macOS | Linux interrupted; Windows |
| OpenClaw | Fresh npm 2026.9.7 global-layout install/version on macOS with isolated Node 24.21.0 | Linux/Windows; installer-script and gateway onboarding end to end |
| Cursor | Fresh official 2026.09.28-64d2043 macOS arm64 archive extracted to a temporary directory; launcher/version passed | Full installer/profile modification; Linux/Windows |
| Kimi | Official macOS installer with temporary KIMI_INSTALL_DIR and KIMI_NO_MODIFY_PATH=1; 2.1.1 version passed | Linux/Windows; interactive sign-in |
| Ollama | Fresh official v0.35.0 macOS archive; local server started and answered version and model-list APIs, then stopped | Desktop app/Homebrew and Linux/Windows installs; model download/inference |
| LocalAI | Fresh official v4.10.0 macOS arm64 binary; version passed with child-process DEBUG=false | Server/model provisioning and Linux/Windows. Host DEBUG=release was rejected by upstream's boolean flag parser |
| Hermes | Official script endpoint and shell syntax checked in review 35; all OS popup actions validated | Full native install on all OSes. Its installer modifies user shell profiles/launcher; disposable Linux environment unavailable |
| OpenRouter | Configuration-only provider: API-key/settings and browser handoff validated; no CLI installation | Authenticated external API connection |
| Mysti | DeepMyst account connection, not a catalog CLI installer; existing account/setup regression suite retained | Reported live DeepMyst 403 remains subject to the undeployed dashboard changes in review 35 |

Machine-readable evidence: [Linux npm installs](36-linux-npm-installers.json), [OpenClaw](36-macos-openclaw.json), [Cursor](36-macos-cursor.json), [Kimi](36-macos-kimi.json), [Ollama](36-macos-ollama.json), [LocalAI](36-macos-localai.json), and [previous six npm installers](35-live-installs.json).

The Linux Docker daemon became unresponsive after Claude, Codex and Gemini completed. Later installs are **unverified**, not installer failures. Docker was not restarted because unrelated user containers were present. Removal requests for the task-owned containers also timed out; owned client processes were stopped. Once Docker responds, remove only `mysti-installer-validation`, `mysti-manual-cursor` and `mysti-manual-kimi` if they remain. No inference was attempted with the newly installed packages.

## Repeatable checks

- `npm run validate:installers` installs nine pinned npm packages into separate temporary global prefixes, checks their launcher files, and executes version commands. Per-provider results are saved progressively, including failures. Requires a supported Node version (24.21.0 used here). Use a disposable runner because upstream lifecycle scripts may have side effects outside their prefix.
- `.github/workflows/installers.yml` provides a manual macOS/Linux/Windows matrix for those actual npm installs and uploads JSON evidence. It has **not** been pushed or executed remotely in this session; it does not cover native manual installers or account authentication.
- `tests/providers/installerMatrix.test.ts` checks OS filtering, installer contracts and shell selection. `tests/webview/installerScreensBrowser.test.ts` exercises every catalog provider's popup plus error and authentication handoffs. Manager and integration regressions cover actual execution options, duplicate work, timeouts, API-key prompts, polling cancellation and discovery failures.

## Final verification

- Complete suite: **13,651 tests passed across 427 files**.
- Type checking: passed.
- Lint: **0 errors, 452 warnings** (no automatic broad lint rewrite).
- Release build, VSIX creation and every package-shape assertion: passed. Artifact: `/tmp/mysti-installers-validated.vsix` (7.38 MB). Not installed into the running editor or published.
- Fresh macOS validation install directories were removed after preserving the JSON evidence. Existing user CLIs were not replaced.

An initial full run caught a source-conformance test that requires setup to be rearmed immediately before its outgoing request. The new cancellable waiting UI was extracted into a helper to preserve that invariant; the subsequent complete run above passed.
