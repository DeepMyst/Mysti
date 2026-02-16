# Autonomous Mode

Autonomous Mode allows your AI agent to work independently with minimal intervention, automatically handling permissions and answering routine questions based on learned preferences and safety rules.

## Overview

When Autonomous Mode is active:

- **Permissions** are automatically approved or denied based on safety classification
- **Routine questions** from the AI are auto-answered using learned preferences
- **Dangerous operations** are always blocked regardless of settings
- **All decisions** are logged to an audit trail for review

## Enabling Autonomous Mode

Toggle via the `mysti.toggleAutonomous` command or the autonomous mode button in the chat interface.

## Safety System

At the core of Autonomous Mode is a three-level safety classifier that evaluates every operation before it's auto-approved.

### Safety Levels

| Level | Action | Description |
|-------|--------|-------------|
| **Safe** | Auto-approve | Read-only operations, test commands, version checks |
| **Caution** | Depends on mode | File creation/editing, non-destructive bash commands |
| **Blocked** | Always deny | File deletion, force push, hard reset, sudo, chmod 777 |

### Hardcoded Blocks

These operations are **always blocked** regardless of safety mode:

- File deletion (`rm`, `del`, recursive delete)
- Git force operations (`git push --force`, `git reset --hard`)
- Database destructive operations (`DROP TABLE`, `DROP DATABASE`)
- System-level commands (`sudo`, `chmod 777`)
- Custom patterns you configure

### Always Safe

These operations are **always auto-approved**:

- Read-only commands (`ls`, `cat`, `grep`, `find`, `head`, `tail`)
- Test commands (`npm test`, `pytest`, `jest`, `cargo test`)
- Version checks (`node -v`, `npm -v`, `git --version`)
- Git status commands (`git status`, `git log`, `git diff`)

## Safety Modes

Configure how aggressive the auto-approval behavior is:

### Conservative

The most restrictive mode — only clearly safe operations are auto-approved.

- File reads: Auto-approve
- File creates/edits: **Require user approval**
- Bash commands: Only safe-listed commands auto-approved
- Everything else: Require user approval

### Balanced (Default)

A moderate approach that auto-approves common development operations.

- File reads: Auto-approve
- File creates/edits: **Auto-approve**
- Safe bash commands: Auto-approve
- Unknown bash commands: Require user approval
- Destructive operations: Always blocked

### Aggressive

The most permissive mode — auto-approves everything except hardcoded blocks.

- File reads: Auto-approve
- File creates/edits: Auto-approve
- Bash commands: **Auto-approve** (unless blocked)
- Only hardcoded blocks are denied

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

Memories lose confidence over time (decay factor: 0.95 per day). This means:
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

The audit log is capped at a configurable maximum (default 100 entries).

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

Any operation matching these patterns will be blocked in autonomous mode.

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
5. **Memory learns from you** — the more you use Mysti, the better it understands your preferences
