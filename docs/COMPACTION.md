# Context compaction

Compaction helps manage a long conversation's context by summarizing older material or requesting the provider's native compaction. It can omit details and does not guarantee that every request fits a model's context window.

[Documentation index](README.md) · [Provider capabilities](PROVIDERS.md#provider-capabilities) · [Privacy](PRIVACY.md) · [Backup and recovery](BACKUP-AND-RECOVERY.md)

## What is measured

Mysti distinguishes **current context fill** from **cumulative usage**. The current fill uses the latest normalized input, cache-read and cache-creation token buckets. Lifetime input/output totals describe work and cost; adding them across a conversation does not measure the current context window.

A provider that supplies no usable context measurement is **unknown**, not 0% full. Standard automatic threshold checks do not run from an unknown measurement. Provider token conventions and model-window declarations also affect the displayed estimate.

## When automatic compaction can run

The standard path requires all of the following:

1. Compaction is enabled and the provider's history ownership permits it.
2. A usable current-context measurement reaches the configured threshold, normally **75%**.
3. At least four messages are present and the **30-second cooldown** has elapsed.
4. The chosen strategy has enough material to compact. Client summarization needs older messages beyond the four it preserves.

These controls do not force a native-session provider to surrender its own history. The manager only permits automatic compaction for a provider with native compact support, or one to which Mysti sends the full history.

## Strategies and provider support

| Provider / transport | History owner | Standard automatic path |
| --- | --- | --- |
| Claude Code | Native CLI session | Native `/compact` through the existing session |
| Codex, Gemini, OpenClaw, OpenCode local CLI, Qwen Code, Hermes, Kimi Code | Native session | Native session owns its context; Mysti does not replace it with a client summary or restart it to compact |
| Cline, Copilot, Continue, OpenCode remote HTTP/SSE | Mysti sends recent conversation history | Not the full-history automatic client-compaction path |
| Ollama, LocalAI, OpenRouter, MiniMax | Mysti sends full conversation history | Client summarization when measurement and threshold conditions allow it |
| Cursor | This adapter sends no prior conversation history | Nothing is automatically compacted for the provider |

Transport capability declarations determine these categories. Native model/context management and account restrictions remain provider-specific; see [provider setup](PROVIDERS.md).

### Native compaction

Claude Code declares native compact support. Mysti sends `/compact` through the provider rather than reconstructing the CLI's tool and file-read history from chat text. The native response and errors still belong to the active request.

### Client summarization

For the client path, Mysti sends older messages to the configured provider for summarization, then replaces those messages in the active conversation with a summary while keeping the **last four messages** intact. An empty summary or request failure is reported instead of being treated as a useful summary. This summarization request can consume provider quota and sends that older content to the configured backend.

If you need the original text, [export or back up the conversation](BACKUP-AND-RECOVERY.md) before relying on a summary. A compacted summary is not a verbatim archive or a rollback mechanism.

### Optional smart compaction

Smart compaction additionally requires its opt-in setting, DeepMyst sign-in and the required entitlement. Its evaluation considers cache/economic information as well as context. When active, summarization can use the configured gateway model; unavailable smart summarization falls back to the ordinary client path. Read [Privacy](PRIVACY.md) before enabling a feature that sends conversation content to another service.

The smart toggle alone does not establish that the feature is active. See [all settings](SETTINGS.md) for its current configuration and defaults.

## Status and recovery

| Status | Meaning |
| --- | --- |
| `idle` | No compaction is running |
| `evaluating` | Checking whether a compaction can run |
| `compacting` | The selected compaction request is active |
| `complete` | That compaction finished successfully |
| `error` | The request failed; inspect the reported provider/setup error |

If a long chat fails, inspect provider errors and context availability before increasing limits. Save the important decisions, export what you need, and start a new focused conversation when appropriate. Do not assume a threshold change can enable compaction on an ineligible transport.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `mysti.compaction.enabled` | `true` | Enable eligible automatic context compaction |
| `mysti.compaction.threshold` | `75` | Standard current-context threshold percentage |

The full [settings reference](SETTINGS.md) describes smart-compaction controls. [CompactionManager](../src/managers/CompactionManager.ts), [token accounting](../src/services/TokenAccounting.ts), provider capability declarations and [constants](../src/constants.ts) define the behavior above.
