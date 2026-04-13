---
id: mmx-cli
name: mmx-cli (MiniMax AI)
description: Generate text, images, video, speech, and music via MiniMax AI platform
icon: lab.png
category: ai-tools
activationTriggers:
  - image generation
  - video generation
  - speech synthesis
  - music generation
  - text generation
  - minimax
  - mmx
  - generate image
  - generate video
  - generate audio
---

# Instructions

Use `mmx` CLI to generate media content via MiniMax AI. Install with `npm install -g @minimax-ai/cli`, then run `mmx auth` to configure your API key.

## Capabilities

- **Text**: `mmx text generate "prompt"` — uses MiniMax-M2.7 model
- **Image**: `mmx image generate "prompt"` — uses image-01 model
- **Video**: `mmx video generate "prompt"` — uses Hailuo-2.3 model
- **Speech**: `mmx speech generate "text"` — uses speech-2.8-hd, 300+ voices
- **Music**: `mmx music generate "prompt"` — uses music-2.6 with lyrics and cover
- **Search**: `mmx search "query"` — web search via MiniMax

## Agent Flags

When invoked by an agent, prefer non-interactive mode:

```bash
mmx image generate "a sunset over mountains" --non-interactive --output json
mmx speech generate "Hello world" --voice friendly-person --quiet
mmx music generate "upbeat jazz instrumental" --non-interactive
```

## Skill Reference

Source: [MiniMax-AI/cli](https://github.com/MiniMax-AI/cli) — `skill/SKILL.md`
