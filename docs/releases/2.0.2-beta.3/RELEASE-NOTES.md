# Mysti 2.0.2 · Beta 3

**Claude's answers no longer look like they never arrived.**

Beta 3 is a small patch to [Beta 2](../2.0.1-beta.2/RELEASE-NOTES.md). If you
use Claude Code in Mysti, update: on Beta 2 a reply could sit as an empty
bubble for up to half a minute before any text appeared.

[Full changelog](../../../CHANGELOG.md) ·
[Production-readiness checklist](../../PRODUCTION_READINESS.md)

## What changed

### Claude replies show progress again

Current Claude models (Sonnet 5, Opus 5.5) keep their reasoning private. While
they think, Claude Code streams thinking events with no text in them. Beta 2
treated the first of those as the start of the answer: it removed the waiting
indicator and showed an empty reply bubble until the first word arrived. At the
maximum effort level that took around 20–25 seconds even for "hi", so it was
easy to press Stop on an answer that was on its way.

Mysti now keeps the waiting indicator until there is something to show. Thinking
that does carry text is still displayed as before.

### Also in this build

- **Windows:** CLI lookup settles on the system lookup's first complete match
  instead of waiting for every match on `PATH`.
- **Streaming:** long answers measure scroll position once per frame, so fast
  output stays smooth.

## Install

Install or update from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)
(pre-release channel), or download the VSIX from the
[GitHub release](https://github.com/DeepMyst/Mysti/releases/tag/v2.0.2-beta.3)
and run **Extensions: Install from VSIX…**. Conversations and settings carry
over from Beta 2; there is no data-format change.

Mysti remains beta. Known gaps are listed in
[production readiness](../../PRODUCTION_READINESS.md).
