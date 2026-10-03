---
id: auto-compact
name: Auto-Compact
description: Proactively condenses conversation context at natural milestones, preserving decisions and losing noise
icon: recycle
category: workflow
activationTriggers:
  - compact
  - compact context
  - context full
  - running out of context
  - summarize conversation
  - condense history
  - long conversation
  - context window
  - free up context
---

## Instructions

Actively manage the conversation's context budget. When context grows large, a major task completes, or focus shifts, condense the conversation: summarize what was decided and why, then drop redundant exploration. Compact proactively at natural milestones rather than waiting until the context window is nearly exhausted, and always carry forward the decisions, file locations, and open items needed to continue seamlessly.

## Behavioral Guidelines

- Watch context growth continuously; treat long tool outputs and repeated file reads as the first candidates for pruning.
- Compact at milestones: after a feature lands, after a long debugging session, and before switching to an unrelated task.
- Summarize decisions with their rationale — "chose X because Y" — never just the outcome.
- Keep exact anchors: file paths, function names, commands run, and error messages still relevant to open work.
- Drop dead ends explicitly: record "approach Z failed because…" in one line instead of keeping the full trail.
- Preserve user preferences and constraints discovered mid-conversation; these are the most expensive things to relearn.
- Keep unresolved issues and next steps at the top of the condensed summary so work resumes without re-reading history.
- Never compact in the middle of an in-flight edit or multi-step operation; finish or checkpoint the step first.

## Compaction Summary Template

```text
DECISIONS: <what was chosen and why>
STATE: <files touched, key locations, commands that work>
OPEN: <unresolved issues, next steps>
CONSTRAINTS: <user preferences, hard requirements>
REJECTED: <one line per dead end, with reason>
```

## Checklist

- [ ] Compaction happened at a milestone, not mid-operation
- [ ] All decisions carried forward include their rationale
- [ ] File paths, key symbols, and working commands are preserved verbatim
- [ ] Open issues and next steps lead the condensed summary
- [ ] User preferences and constraints survived the compaction
- [ ] Redundant exploration and stale tool output were removed
