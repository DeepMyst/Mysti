# Mysti 2.0 BETA media kit

These captures show the real shipped chat and Proactive webviews in Chromium, with deterministic sample responses and sample evidence supplied through the host message boundary. Every recording displays **INTERFACE DEMO · SAMPLE DATA**. They are interaction demonstrations, not live model benchmarks or proof of connected-account execution.

| Asset | Preview | Video |
| --- | --- | --- |
| Independent Claude Code/Codex opinions | [GIF](agent-opinions.gif) · [PNG](agent-opinions.png) | [MP4](agent-opinions.mp4) |
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

## Marketplace and GitHub

The README uses PNG/GIF images and a linked video rather than assuming embedded video or Mermaid support in the Marketplace renderer. `vsce` rewrites relative README links to the repository; merge the assets at the corresponding branch before publishing. Marketing media is excluded from the VSIX by `docs/**` in `.vscodeignore`, keeping installation size independent of the videos.

Before a public launch, additionally capture a redacted live-provider run of the same two-agent request using the reviewed VSIX and authenticated accounts. Label its CLI versions, access mode and platform separately. Do not relabel these fixture recordings as live-provider evidence.

## Live provider evidence

Separate from the sample-data walkthroughs, a [live GIF](live-agent-opinions.gif), [MP4](live-agent-opinions.mp4), and [final screenshot](live-agent-opinions.png) record actual authenticated Claude Code and Codex responses through the extracted 2.0.0 pre-release VSIX. The check ran in VS Code 1.140.0 on macOS with read-only access; both providers answered the same TTL-cache question independently, and their attributed final response rendered.

The clip samples real webview screenshots about every 750 ms; it is not a timing benchmark. The `OPINION_OK` prefix is a test marker requested in the prompt, not synthesized by Mysti. The disconnected optional OpenClaw indicator is not a participant in this test. Versions, package hash and scope are recorded in [live-capture.json](live-capture.json). No claim of live Windows/Linux parity follows from this capture.
