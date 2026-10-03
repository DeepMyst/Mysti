# Dictation implementation and validation

Implemented 2026-10-01. User request: add dictation similar to other coding agents.

## Behavior

- A microphone button sits beside attachments and Send in every chat composer, independently of the agent/model selected.
- It opens an owned, temporary plaintext editor and starts the host's native editor dictation. Mysti previews committed transcript text; **Use text** inserts it at the original selection. Changed drafts receive an appended transcript instead of being overwritten.
- The editor status bar has **Use dictation in Mysti** and **Discard dictation** controls, so users can finish without first returning to chat. The originating chat is revealed on completion.
- Prompts are never automatically submitted. Clicking Send during dictation finishes dictation first. Escape inside Mysti cancels dictation without cancelling an agent turn.
- Request identities isolate delayed replies. Changing conversation, closing a chat, closing the scratch editor, or disposing the extension cancels the session. Concurrent tabs cannot steal the session. A five-minute session limit inserts the transcript without submitting it.
- The bridge only watches its owned document. Cleanup closes only its own untitled editor; saved documents are retained. Native stop/close failures retain a recoverable editor and show a warning.
- Missing editor support offers voice settings and installation of the fixed `ms-vscode.vscode-speech` extension. Marketplace failures surface an error. Native recording permission/model-download UI remains owned by the editor.

## Host support and deliberate limits

VS Code webviews block direct microphone access ([upstream issue](https://github.com/microsoft/vscode/issues/250568)). This implementation uses public `workbench.action.editorDictation.start` and `.stop` commands, verified in the local VS Code 1.136.2 bundle and real-host tests. It does not use a proposed speech API or transmit audio through Mysti providers.

This is an editor dictation bridge, not inline webview recording. Recent VS Code desktop versions provide native dictation on supported platforms; older hosts may require VS Code Speech. Recognition languages, OS permissions, speech models, remote/cloud behavior and optional transcript cleanup follow [VS Code voice settings](https://code.visualstudio.com/docs/configure/accessibility/voice). No offline-only privacy claim is made. Fork compatibility depends on those editor commands and speech support being present.

Actual microphone recognition, OS permission dialogs, first-use model downloads, Windows/Linux hosts, and installation from a fork's extension marketplace have **not** been exercised. Automated tests deliberately substitute speech commands to avoid recording ambient audio. A manual check is still required: click the microphone, permit native voice access if prompted, speak, finish via the status bar, and verify the transcript before sending.

## Validation

- Full Vitest regression: **13,698 tests passed, 432 files** (`npm test -- --maxWorkers=6`).
- Additional/final targeted dictation checks: **11 passed, 3 files**. Includes provider matrix browser interactions, draft selection/insertion, editing during speech, cancellation, stale replies, error/retry/setup, host routing, installation failures, document ownership, startup races, timeouts, and saved-file preservation.
- Real VS Code 1.136.2 on macOS arm64: **2 tests passed**, using real scratch documents and actual editor tab cleanup, with only speech commands substituted. Unrelated dirty drafts survive. Status bar finish/discard commands work. No save confirmation is required for the owned scratch editor.
- TypeScript typecheck passed. Lint passed with existing warnings; no new lint errors. Release build passed with existing webpack size warnings.
- Browser validation uses the real chat HTML/CSS/JS at 390px width. Native host behavior is separately tested in `tests-vscode/dictation.test.ts`.

Release package: `/tmp/mysti-dictation.vsix`. This review does not install or publish the package.
