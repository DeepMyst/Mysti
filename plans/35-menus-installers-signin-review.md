# Menus, installers and DeepMyst sign-in follow-up

Reviewed 2026-10-01 on macOS arm64 with Node 22.20.0. This supplements the full feature inventory and provider journeys in [review 34](34-feature-review.md).

## Implemented

- Visible `/` command button beside the actions menu.
- Ultracode switches in the model menu, actions menu and Settings, all backed by `mysti.claudeUltracode`. The switches share state, keyboard accessibility and blue/gray on/off styling. Model and effort selections use the same state and writers across surfaces. A requested effort above a provider's supported range now displays the same clamped level used by the backend.
- Claude receives Ultracode through a private temporary settings file, independently of `--effort`, in both one-shot and persistent sessions. Switching it restarts the persistent process on the next request. A detected CLI below 2.1.284 produces an actionable upgrade requirement. The switch is only exposed for providers declaring support; the selected Claude model/account must also support workflows.
- Installer popup sections now actually hide when their state changes. Stale provider replies cannot replace another provider's popup; missing npm disables automatic installation; retry clears prior error/progress; delayed completion cannot close another provider's popup.
- Windows installer snippets select PowerShell for PowerShell commands and cmd.exe for npm commands. Unix snippets use Bash. Removed an invalid cross-shell comment sent to terminals.
- The permission fallback retains a global npm layout under the writable user prefix. Cline 3.0.67 installed without a launcher using the old local layout; the global layout installed and launched successfully.
- Automatic installs use the discovered npm directory on PATH and enforce package Node engine requirements. Permission failures no longer falsely claim that a local installation succeeded.
- Codex authentication now uses `codex login`. Generic provider instructions include the actual authentication command. LocalAI links now open its release picker rather than requesting nonexistent binary filenames.
- Mysti explains generic DeepMyst 403 errors with organization/API-key recovery guidance.

## Validation

| Check | Result |
| --- | --- |
| Full Mysti suite | **13,581 passed, 424 files** |
| Focused regression run | 329 passed; subsequently added version and persistent Ultracode cases are covered in the full suite |
| Final permission-fallback correction | 66 focused installer/platform tests passed after the full-suite run; VSIX rebuilt and package shape rechecked |
| Dashboard connection service | 9 passed, using Mysti's installed Vitest runner with dashboard aliases |
| Type checking | Mysti passed |
| Lint | 0 errors; 445 warnings |
| Release build and VSIX package shape | Passed; `/tmp/mysti-menus-installers.vsix` |
| Installer catalog | All 15 providers checked for macOS, Linux and Windows: 45 cases |
| Browser popup | Real Chromium checks for automatic install routing, errors, retry, success, manual terminal actions, refresh, missing npm and stale replies |
| Browser menus | Model keyboard selection, effort synchronization and clamping, Ultracode synchronization and independence, slash commands, filtering, narrow layouts, theme colors and CLI-upgrade card states |
| Claude isolated npm install | 2.1.286 installed and `--version` passed |
| Codex isolated npm install | 0.159.3 installed; `--version` and `login --help` passed |
| Other automatic npm installers | Gemini 0.62.0, Cline 3.0.67, Copilot 1.0.90, OpenCode 1.18.34, Qwen 0.24.7 and Continue 1.5.47 installed and launched on macOS; Cline used the corrected global layout |
| Live Claude Ultracode | Enabled with `--effort low`, tools disabled; returned `OK`, no error; cost $0.136128 |
| Public installer endpoints | All 9 npm metadata endpoints and 11 installer/download/account URLs returned HTTP 200 |
| Installer scripts | Four Unix scripts downloaded and passed shell syntax checks; three PowerShell scripts downloaded as non-HTML content, not executed |

Evidence: [package and endpoint checks](35-installer-endpoints.json), [script checks](35-installer-script-checks.json), [additional isolated npm installs](35-live-installs.json). These are version-specific observations, not a promise that future upstream releases work.

The first full run exposed three constructor-bypassing test fixtures missing the new upgrade-state map and two browser-suite convention checks. Updated the fixtures and browser setup, then reran the complete suite successfully.

## DeepMyst 403: website fix prepared, live resolution unverified

The browser's `/connect/vscode` page previously attempted key creation directly and displayed Axios's generic status message. The backend can deny that request for an account without an active organization, a stale selected organization, or a role without `create_keys` permission. These are code-confirmed failure paths; the exact cause for the reported account has not been reproduced with an authenticated browser.

Prepared changes in the sibling `DeepMyst 2.0` repository:

- `apps/dashboard/src/features/auth/services/mystiConnection.ts`: read the current account before creating a user-scoped key; retry the identity read once without a stale organization hint after a 403; preserve server error details; explain onboarding and permission requirements.
- `apps/dashboard/src/features/auth/components/ConnectVSCodePage.tsx`: show useful errors and links to organization setup/account selection, with a retry action. Validate the exact editor callback path.
- `apps/dashboard/src/features/auth/services/mystiConnection.test.ts`: authorized roles, stale organization recovery, onboarding, read-only/member denial and error detail preservation.

No organization permissions were expanded. The public link page returned 200; an unauthenticated API request returned the expected 401. The dashboard changes have **not been deployed**, and live authenticated sign-in remains unverified. Dashboard dependencies are absent in this checkout, so its full typecheck/build could not run; changed TS/TSX syntax and the isolated service tests passed.

## Remaining release checks

- Execute native installation and first-run authentication on Windows and Linux. Local platform-selection tests do not establish native OS readiness. The existing CI already defines Windows, Linux and macOS jobs; those remote jobs were not triggered here.
- Complete the interactive/manual installation journeys for Cursor, OpenClaw, Ollama, LocalAI, Hermes and Kimi on each supported platform. OpenRouter uses account/API configuration; Mysti uses DeepMyst sign-in rather than a local CLI installer.
- OpenClaw's current npm metadata requires Node `>=24.16.0 <25 || >=26.1.0`; this Mac's Node 22 is insufficient for that release.
- Deploy and validate the dashboard changes using an authorized DeepMyst account before claiming the reported 403 is resolved.

## Reference checks

- [Claude model settings](https://code.claude.com/docs/en/model-config): independent Ultracode settings and CLI version requirement.
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference): supported login command.
- [LocalAI release assets](https://github.com/mudler/LocalAI/releases/tag/v4.10.0): actual versioned binary filenames.
