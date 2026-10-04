# Mysti 2.0 BETA media kit

These captures show the real shipped chat, Connections and Proactive webviews in Chromium, with deterministic sample responses and sample evidence supplied through the host message boundary. Every recording displays **INTERFACE DEMO · SAMPLE DATA**. They are interaction demonstrations, not live model benchmarks or proof of connected-account execution.

| Asset | Preview | Video |
| --- | --- | --- |
| Second opinion from a finished answer | [GIF](second-opinion.gif) · [PNG](second-opinion.png) | [MP4](second-opinion.mp4) |
| Dependent cross-agent workflow | [GIF](agent-workflow.gif) · [PNG](agent-workflow.png) | [MP4](agent-workflow.mp4) |
| Switching provider while retaining a draft | [GIF](provider-switching.gif) · [PNG](provider-switching.png) | [MP4](provider-switching.mp4) |
| DeepMyst connected tools | [GIF](connected-tools.gif) · [PNG](connected-tools.png) | [MP4](connected-tools.mp4) |
| Independent Claude Code/Codex opinions | [GIF](agent-opinions.gif) · [PNG](agent-opinions.png) | [MP4](agent-opinions.mp4) |
| Brainstorm analysis and synthesis | [GIF](brainstorm.gif) · [PNG](brainstorm.png) | [MP4](brainstorm.mp4) |
| Model, effort, and Ultracode controls | [GIF](composer-controls.gif) · [PNG](composer-controls.png) | [MP4](composer-controls.mp4) |
| Proactive task context | [GIF](proactive-inbox.gif) · [PNG](proactive-inbox.png) | [MP4](proactive-inbox.mp4) |
| Combined tour | [Hero image](hero.png) | [Product tour MP4](mysti-2-beta-tour.mp4) |
| Assignment flow | [PNG diagram](routing.png) | — |

## Reproduce

Install the locked development dependencies, Chromium and FFmpeg, then run:

```sh
npm ci
npm exec --no -- playwright install chromium
npm run demo:record
```

The script captures at 1000 × 760, generates 800-pixel GIFs and H.264 MP4s, and writes `capture.json`. It uses no provider credentials or connected accounts. The hero and flow diagram are code-rendered layouts; they make no comparative performance claims. Demo responses are scripted so recordings remain reproducible without publishing private data.

## What the recordings validate

The recorder checks that second opinion routes the original question to another agent, provider selection posts the chosen ID and preserves the draft, workflow cards reach completion, catalog/refresh buttons post host actions, sample connections render, Brainstorm produces a visible synthesis, and effort/Ultracode stay synchronized. Every scene fails on uncaught browser errors or broken visible images. The combined tour contains all eight scenes; `capture.json` records their order.

Responses, dependency events and authorization results are fixtures. These recordings do not test provider execution, OAuth, catalog availability, or backend orchestration. The connection scene checks the catalog launch action inside Mysti; it does not render or simulate the external catalog page. No local CLI configuration is written. The 16-adapter count excludes the Mysti coordinator and experimental, unregistered provider classes. We do not assert a fixed catalog size or imply that every connected app supports Proactive monitoring.

## Marketplace and GitHub

The README uses PNG/GIF images and a linked video rather than assuming embedded video or Mermaid support in the Marketplace renderer. `vsce` rewrites relative README links to the repository; merge the assets at the corresponding branch before publishing. Marketing media is excluded from the VSIX by `docs/**` in `.vscodeignore`, keeping installation size independent of the videos.

Before a public launch, additionally capture a redacted live-provider run of the same two-agent request using the reviewed VSIX and authenticated accounts. Label its CLI versions, access mode and platform separately. Do not relabel these fixture recordings as live-provider evidence.

## Live provider evidence

Separate from the sample-data walkthroughs, a [live GIF](live-agent-opinions.gif), [MP4](live-agent-opinions.mp4), and [final screenshot](live-agent-opinions.png) record actual authenticated Claude Code and Codex responses through the extracted 2.0.0 pre-release VSIX. The check ran in VS Code 1.140.0 on macOS with read-only access; both providers answered the same TTL-cache question independently, and their attributed final response rendered.

The clip samples real webview screenshots about every 750 ms; it is not a timing benchmark. The `OPINION_OK` prefix is a test marker requested in the prompt, not synthesized by Mysti. The disconnected optional OpenClaw indicator is not a participant in this test. Versions, package hash and scope are recorded in [live-capture.json](live-capture.json). No claim of live Windows/Linux parity follows from this capture.
