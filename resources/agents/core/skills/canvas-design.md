---
id: canvas-design
name: Canvas Design Workflow
description: The tool-driven workflow for building app screens and websites with self-QA
icon: designer.png
category: design
activationTriggers:
  - canvas
  - app
  - website
  - screen
  - design system
  - render preview
---

# Instructions

Build and refine **app screens and websites** through the `mysti-canvas` tools and the enabled generation/import connections, with a render-and-critique pass before any screen is "done". The artifact in storage is the source of truth — the canvas is derived from it.

## Workflow

1. **Frame.** Pick the target device with `set_format` (`mobile` / `tablet` / `desktop` / `web`) and design at its real size. For multi-device work, build the screen per device.
2. **Orient.** Call `get_artifact_index` and `read_page` on anything you'll touch. Note each page's `version` (your `baseVersion`).
3. **System.** Establish or confirm the theme/design tokens (`set_theme`) so every screen is consistent before laying out pages.
4. **Compose.** Author screens with `write_page_jsx` (a single `function Page()` using the preloaded `UI.*` primitives and theme tokens). Build real navigation, controls, and the empty/loading/error states — not just the happy path. Use `page_coordinates` for placement.
5. **Source assets.** Generate imagery/icons via the capability connections; **import real frames from Figma/Canva** with `import_design` when a source is connected, rather than re-drawing them.
6. **Self-QA.** Render each new or changed screen and critique it at its device size: overflow, clipping, contrast, broken layout, missing states. Fix before continuing.
7. **Refine.** Honor inline comments, slider adjustments, and accept/reject decisions; carry `baseVersion` so concurrent human edits are never clobbered.

## Behavioral Guidelines

- Never describe an edit in past tense unless a WRITE tool ran this turn.
- Match the device/platform (mobile native patterns vs desktop app shell vs web sections).
- Reuse components and design tokens — no raw hex, no one-off spacing.
- Cover real states (content/empty/loading/error), not lorem-only mockups.
- When intent is open, stage a few distinct directions instead of guessing.
- Keep the human steering in the main chat; surface a thumbnail + one line, not narration.

## Checklist (before declaring a screen done)

- [ ] Frame set to the right device; designed at real size
- [ ] Read the page first; edits carry the correct `baseVersion`
- [ ] Layout fits the device with no overflow/clipping; responsive where relevant
- [ ] Navigation + real controls present; empty/loading/error states handled
- [ ] Color/type/spacing from theme tokens; components reused for consistency
- [ ] Contrast + touch targets meet accessibility
- [ ] Rendered preview reviewed at device size; issues fixed
- [ ] Imported from Figma where a frame existed; generated assets recorded with provenance (`add_asset`)
