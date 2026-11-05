# Mysti in action

Watch your agents share context, compare ideas and move a task forward inside VS Code. Start with the complete tour, or jump straight to the workflow you need.

**Complete tour · 3 minutes 19 seconds · Captioned walkthrough**

https://github.com/user-attachments/assets/edb4beb3-08e1-4790-be3a-6550b2afd227

[Download the complete video kit](https://github.com/DeepMyst/Mysti/releases/download/v2.0.1-beta.2/mysti-2.0.1-beta.2-feature-demos.zip) · [Tour chapters](releases/2.0.1-beta.2/media/CHAPTERS.md) · [Chapter captions](releases/2.0.1-beta.2/media/mysti-feature-tour.vtt) · [Install Beta 2](https://github.com/DeepMyst/Mysti/releases/download/v2.0.1-beta.2/mysti-2.0.1-beta.2.vsix)

*These recordings use clearly labelled sample data in the shipped interface. They explain the workflows; native-provider validation and remaining beta limits are tracked in [production readiness](PRODUCTION_READINESS.md).*

## Choose a workflow

| What you want to do | Watch |
| --- | --- |
| Connect and get started | [11 sec](#getting-started) |
| Choose your provider | [21 sec](#provider-switching) |
| Control context and permissions | [12 sec](#context-and-trust) |
| Tune the response | [7 sec](#composer-controls) |
| Design, then review | [17 sec](#agent-workflow) |
| Compare independent opinions | [10 sec](#agent-opinions) |
| Ask for another perspective | [6 sec](#second-opinion) |
| Brainstorm a decision | [12 sec](#brainstorm) |
| Stop and refocus | [11 sec](#stop-and-recovery) |
| Return, branch or rewind | [21 sec](#history-and-rewind) |
| Find settings and help | [25 sec](#settings-and-help) |
| Explore a design in Canvas | [15 sec](#canvas-design) |
| Read a visual report | [15 sec](#visual-test) |
| Manage connected tools | [7 sec](#connected-tools) |
| Check relevant evidence | [8 sec](#proactive-inbox) |

## Start with a focused task

### Getting started

**Connect and get started · 11 seconds**

Select an available agent, compare Plan and Ask, then write a first task.

https://github.com/user-attachments/assets/bb6b7569-6d92-45d8-9c0a-b94aac68ec25

### Provider switching

**Choose your provider · 21 seconds**

Move between agent adapters while keeping your draft. Availability depends on your installed tools and accounts.

https://github.com/user-attachments/assets/52244e69-68b3-43f8-811d-ef341e23947a

### Context and trust

**Control context and permissions · 12 seconds**

Include files and selected lines, attach a document, temporarily exclude context, and choose Plan.

https://github.com/user-attachments/assets/d12f8617-0aac-45c1-98f4-68079b50f443

### Composer controls

**Tune the response · 7 seconds**

Choose model and effort, with Ultracode synchronized across the composer controls. Supported controls vary by provider.

https://github.com/user-attachments/assets/6e9daa9c-55a0-405f-a8d0-3df27d54257e

## Bring agents together

### Agent workflow

**Design, then review · 17 seconds**

An explicit “then” makes the second assignment depend on the first. Follow each agent's progress and attribution.

https://github.com/user-attachments/assets/c453b15b-39a0-41c3-98b8-7ad8709a6785

### Agent opinions

**Compare independent opinions · 10 seconds**

Address two agents in one message and read their separate answers.

https://github.com/user-attachments/assets/be0e0534-901a-49cc-a049-d155505aeaed

### Second opinion

**Ask for another perspective · 6 seconds**

Use Second opinion on a finished answer to send the original question to another agent.

https://github.com/user-attachments/assets/57ba8dd3-5f84-48a9-aa5e-b7278057df3a

### Brainstorm

**Brainstorm a decision · 12 seconds**

Watch the Quick strategy gather independent analysis and produce a shared synthesis.

https://github.com/user-attachments/assets/d43b6f0e-276a-4214-9303-f95824585fe4

## Keep control of your work

### Stop and recovery

**Stop and refocus · 11 seconds**

Stop a running response and start a narrower follow-up. This scene demonstrates the interface; native subprocess cleanup has separate regression evidence.

https://github.com/user-attachments/assets/a0eb2824-d9af-4f5e-9f27-854fa823b555

### History and rewind

**Return, branch or rewind · 21 seconds**

Open earlier work and find the message-level fork and code-rewind actions. The demo branches sampled history; it does not modify files on disk.

https://github.com/user-attachments/assets/daa6adf2-c763-4c8b-9bca-b6d38b9acf5b

### Settings and help

**Find settings and help · 25 seconds**

Open the conversation-bound settings hub, choose a persona and a skill, and search built-in help.

https://github.com/user-attachments/assets/8bda6b7b-1a3a-468b-9bef-ba6870e2ee93

## Design and inspect visually

### Canvas design

**Explore a design in Canvas · 15 seconds**

See the actual sandbox runtime render a sample design, change its theme and device format, and find Export. The host operations are fixtures; no export file is produced.

https://github.com/user-attachments/assets/475aa1dd-4024-40dd-87f4-6def1a75778f

### Visual test

**Read a visual report · 15 seconds**

Configure a check and review a screenshot, issue list and result together. Findings and the report are sample data.

https://github.com/user-attachments/assets/c1c6aefa-fe50-4d76-aa56-243e2a010a1e

## Work with connected context

### Connected tools

**Manage connected tools · 7 seconds**

Find the catalog action and refresh a sample connection list. No OAuth flow or external application is executed.

https://github.com/user-attachments/assets/12e3f14e-6279-449d-9670-a1a7b5b89468

### Proactive inbox

**Check relevant evidence · 8 seconds**

Create a task briefing and inspect its cited context before starting work. The remote evidence is a fixture.

https://github.com/user-attachments/assets/cc4cc4c4-beef-4d8c-a9fe-0ba0cc607184

## Recording and validation details

<details>
<summary>Coverage, limitations and how to reproduce these recordings</summary>

### Scope and coverage

The 15 scenes cover the main product surfaces. The [capture manifest](releases/2.0.1-beta.2/media/capture.json) maps each scene to the [feature inventory](../plans/47-feature-inventory.md), records durations and output sizes, and states its evidence boundary. A recorded control is not proof that every provider supports it.

Not covered by this tour: all five Brainstorm strategies; full autonomous or unattended runs; Desk cross-machine pairing; live plugin installation; remote channel messaging; image/video generation; every Canvas editing and approval operation; real OAuth; paid model execution; sustained-load tests; Windows and Linux parity. These require separate, appropriately scoped validation and, where useful, additional recordings.

Historical [live Claude Code and Codex footage](releases/2.0-beta/README.md#live-provider-evidence) remains available with its original package hash and version. It is evidence for that earlier build, not a live test of this release.

### Reproduce the recordings

Use the repository's pinned development Node version, install the locked dependencies, and install FFmpeg on your machine. Then run:

```sh
npm ci
npm exec --no -- playwright install chromium
npm run demo:record
```

The recorder loads shipped UI assets locally and blocks HTTP(S). It uses no provider credentials and writes only release media and temporary recording files. Each scene checks its key interactions, rejects uncaught browser errors and broken visible images, and records a PNG poster plus an H.264 MP4 at 1120 × 840. One focused GIF is generated for the README; the combined tour includes chapter metadata and a separate WebVTT file with chapter captions.

To regenerate selected scenes during editing:

```sh
MYSTI_DEMO_SCENES=canvas-design,visual-test npm run demo:record
```

When a complete prior capture exists for the same version and the checked UI source assets are unchanged, selected-scene runs also rebuild the tour, chapter list and manifest. Existing clip hashes are checked before reuse, and each scene retains its capture time and recorder-source hashes. If source assets changed or there is no complete capture, run without `MYSTI_DEMO_SCENES` before publishing. `MYSTI_DEMO_OUTPUT` and `MYSTI_DEMO_LABEL` can select the destination and release caption for a future version.

Before publishing, watch the tour, inspect its posters at README size, and check that sample-data labels stay visible. Upload the recordings as native GitHub attachments, then verify actual playback on the rendered README, gallery and release page. A repository MP4 link is a file link, not an inline player. Follow the [media publishing guide](media/README.md); retain source hashes and canonical attachment URLs in the [hosting manifest](media/github-videos.json). Keep promotional recordings outside the VSIX.

</details>
