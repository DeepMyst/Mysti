# Autonomous Mode

Autonomous Mode can handle permission requests and routine questions that reach Mysti's autonomous controller, using classification, learned preferences and configured limits. It is not a universal sandbox or a promise that every provider operation passes through that controller.

[Documentation index](README.md) · [Provider compatibility](PROVIDERS.md#permissions-and-compatibility) · [Approval contracts](NATIVE_APPROVAL.md) · [Privacy and stored memory](PRIVACY.md)

## Overview

When Autonomous Mode is active:

- **Permissions** are automatically approved or denied based on safety classification
- **Routine questions** from the AI are auto-answered using learned preferences
- **Recognized blocked requests** are denied by the controller; unsupported provider permission modes remain unavailable
- **Controller decisions** enter a bounded in-memory audit log for the current session

## Enabling Autonomous Mode

Toggle via the `mysti.toggleAutonomous` command or the autonomous mode button in the chat interface. Activation is session-only and is not restored automatically after an extension restart. Start in a disposable workspace, choose a compatible provider, and keep normal version-control and backup practices.

## Safety System

The classifier evaluates permission requests passed to it. Native tools, subprocesses, hooks and external services still depend on the selected provider's [transport contract](NATIVE_APPROVAL.md). A blocked pattern cannot establish the absence of every equivalent destructive command.

### Safety Levels

| Level | Action | Description |
|-------|--------|-------------|
| **Safe** | Auto-approve at this controller | Recognized file reads, allowed creation/edit paths and allowlisted commands |
| **Caution** | Matching learned decision or user input | Operations needing review under the selected mode, including unknown action types |
| **Blocked** | Deny at this controller | File-delete requests and recognized blocked command patterns |

### Hardcoded Blocks

The classifier denies matching requests regardless of safety mode. Recognized patterns include:

- File-delete operations, `rm`, `rmdir`, and recognized recursive Windows deletion commands
- Git force operations (`git push --force`, `git reset --hard`)
- Database destructive operations (`DROP TABLE`, `DROP DATABASE`)
- System-level commands (`sudo`, `chmod 777`)
- Configured custom patterns matched against shell-command text

### Command matching is not a safety proof

Simple forms of commands such as `ls`, `cat`, `node --version` and `git status` can match the allowlist. Bare `find`, arbitrary `npx`, redirected commands and compound commands are not automatically safe merely because their first word looks harmless. Block checks run first; compound or unrecognized commands use the mode-specific policy.

The allowlist also includes test/build tools. Those can execute project code and can have side effects; the classification name is not a guarantee that a test command is read-only. The Mysti coordinator has additional command/sandbox restrictions separate from this shared classifier.

## Safety Modes

Configure how aggressive the auto-approval behavior is:

### Conservative

The most restrictive classification mode. Caution decisions can still use a matching learned permission preference; without one, Mysti asks the user.

- File reads: Auto-approve
- File creation: Auto-approve when `mysti.autonomous.allowFileCreation` is enabled
- Existing-file and multi-file edits: Caution; learned preference or user input
- Bash commands: Only safe-listed commands auto-approved
- Unknown action types: Caution; learned preference or user input

### Balanced (Default)

A moderate approach that auto-approves common development operations.

- File reads: Auto-approve
- File creation and single-file edits: Auto-approve when the respective allow setting is enabled
- Multi-file edits: Caution; learned preference or user input
- Safe bash commands: Auto-approve
- Some build/compile patterns are auto-approved; other unknown commands use caution and can require user input
- Destructive operations: Always blocked

### Aggressive

The most permissive shell/edit classification mode. Recognized blocks and explicit disabled operation settings still deny requests; delegation and unknown action types remain caution.

- File reads: Auto-approve
- File creates/edits: Auto-approve
- Bash commands: **Auto-approve** (unless blocked)
- Hardcoded/custom blocks and disabled operation classes remain denied

```json
{ "mysti.autonomous.safetyMode": "balanced" }
```

## Memory System

Autonomous Mode includes a learning memory system that improves over time.

### How It Learns

- **Permission decisions**: When you manually approve/deny a permission, Mysti remembers your preference
- **Question answers**: Routine questions you answer are remembered for future auto-responses
- **Project context**: Mysti records project-specific patterns and preferences

### Memory Storage

Memories are stored in two locations:
- **Fast cache**: VSCode's globalState (immediate access)
- **Long-term**: `~/.mysti/memory/preferences.json` (persists across workspaces)

### Confidence Decay

Memory queries weight recency using a factor of **0.95 per day since last access**. Pruning also adjusts stored confidence and ranks entries by confidence, recency and access count. This means:
- Recent decisions are weighted more heavily
- Old preferences gradually fade if not reinforced
- The system adapts as your preferences change

### Pruning

When memory reaches capacity (default 500 entries), low-confidence entries are automatically removed.

## Continuation Modes

Autonomous Mode supports two continuation modes for extended tasks:

### Goal Mode

Set a free-form goal and let the AI work toward it:

- AI works autonomously toward the stated goal
- Completion detected via keyword patterns (e.g., "done", "completed", "finished")
- Ideal for open-ended tasks like "refactor the authentication module"

### Task Queue Mode

Provide a sequential list of tasks:

- Tasks are executed in order
- Progress tracked with completion status
- Each task completes before the next begins
- Ideal for structured work like "run tests, fix failures, update docs"

## Session Management

### Session Limits

- **Max duration**: Configurable (default 24 hours)
- **Heartbeat**: Checked every 30 seconds to monitor session health
- Sessions automatically end when the duration limit is reached

### Audit Log

All autonomous decisions are recorded with:
- Decision type (permission-approve, permission-deny, question-answer, action-blocked)
- Safety level classification
- Description of the operation
- Reasoning for the decision
- Whether memory was used
- Timestamp

The in-memory audit log retains the latest **1,000 decisions**, set by an implementation constant rather than a contributed setting. It is not a durable, complete audit trail across extension restarts. See [Privacy](PRIVACY.md) for storage and retention boundaries.

### Session Stats

Track what happened during an autonomous session:
- Permissions approved / denied
- Questions auto-answered
- Actions blocked
- Tasks completed

## Custom Block Patterns

Add your own patterns to the block list:

```json
{
  "mysti.autonomous.blockPatterns": [
    "deploy",
    "production",
    "npm publish"
  ]
}
```

These patterns are matched against shell-command text seen by the classifier. They are not a universal filter for file paths, network requests, provider tools or external side effects.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.autonomous.safetyMode` | `balanced` | Safety mode: `conservative`, `balanced`, `aggressive` |
| `mysti.autonomous.maxSessionDuration` | `24` | Max session duration in hours |
| `mysti.autonomous.allowFileCreation` | `true` | Allow autonomous file creation |
| `mysti.autonomous.allowFileEdit` | `true` | Allow autonomous file editing |
| `mysti.autonomous.allowBashCommands` | `true` | Allow autonomous bash command execution |
| `mysti.autonomous.blockPatterns` | `[]` | Custom patterns to always block |

## Tips

1. **Start with Conservative** mode until you're comfortable with the system
2. **Review the audit log** after autonomous sessions to see what decisions were made
3. **Add project-specific block patterns** for sensitive operations (e.g., deploy commands)
4. **Use Task Queue mode** for predictable, structured work
5. **Review learned preferences** — a past approval can influence a later caution decision; matching text is not proof the actions are equivalent

## Source and scope

[AutonomousManager](../src/managers/AutonomousManager.ts) implements activation, learned decisions and session logging; [SafetyClassifier](../src/managers/SafetyClassifier.ts) defines request/command classification; [MemoryManager](../src/managers/MemoryManager.ts) defines preference storage and scoring. [Settings](SETTINGS.md) lists current defaults. [Production readiness](PRODUCTION_READINESS.md) tracks native permission and endurance acceptance; a long session-duration setting is not evidence that a long-duration test passed.
