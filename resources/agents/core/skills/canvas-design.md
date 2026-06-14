---
id: canvas-design
name: Canvas Design Workflow
description: The tool-driven workflow for building and refining canvas artifacts with self-QA
icon: designer.png
category: design
activationTriggers:
  - canvas
  - deck
  - slide
  - design system
  - render preview
---

# Instructions

Build and refine canvas artifacts through the `mysti-canvas` tools and the enabled generation connections, with a render-and-critique pass before any page is "done". The artifact in storage is the source of truth — the canvas is derived from it.

## Workflow

1. **Orient.** Call `get_artifact_index` and `read_page` on anything you'll touch. Note each page's `version` (your `baseVersion`).
2. **Set the system.** Establish or confirm the theme (`set_theme`) and format (`set_format`) before laying out pages, so every page is coherent.
3. **Compose.** Author pages with `write_page_jsx` (a single `function Page()` using the preloaded `UI.*` primitives and theme tokens) or `insert_page`/`edit_page`. Use `page_coordinates` for exact placement.
4. **Bring in media.** Generate imagery/video through the capability connections; generate with negative space, then place text in the best safe zone. Import brand frames from Figma/Canva when available.
5. **Self-QA.** Render each new or changed page and critique it: overflow, clipping, contrast, empty charts, weak hierarchy. Fix before continuing.
6. **Refine.** Honor inline comments, slider adjustments, and accept/reject decisions from the human; carry `baseVersion` so concurrent human edits are never clobbered.

## Behavioral Guidelines

- Never describe an edit in past tense unless a WRITE tool ran this turn.
- One idea, one focal point per page; let whitespace do the work.
- Theme tokens only — no raw hex or ad-hoc spacing.
- When intent is open, stage a few distinct directions instead of guessing.
- Keep the human steering in the main chat; surface a thumbnail + one line, not narration.

## Checklist (before declaring a page done)

- [ ] Read the page first; edits carry the correct `baseVersion`
- [ ] Layout fits the active format's safe area; no overflow or clipping
- [ ] Hierarchy reads at a glance; a single clear focal point
- [ ] Color/type/spacing come from theme tokens
- [ ] Contrast meets accessibility; text is legible at format size
- [ ] Rendered preview reviewed; issues fixed
- [ ] Any generated asset is recorded with provenance (`add_asset`)
