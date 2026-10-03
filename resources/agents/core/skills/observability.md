---
id: observability
name: Observability
description: Builds meaningful logging, metrics, and error reporting into code as it is written
icon: flash
category: reliability
activationTriggers:
  - logging
  - log output
  - metrics
  - tracing
  - telemetry
  - monitor
  - alert
  - debug output
  - instrument
---

## Instructions

Instrument code as you write it: emit structured logs with contextual identifiers, apply log levels correctly, and add counters and timings on critical paths. Write error messages that state what failed, why, and what to do next. Never log secrets, credentials, tokens, or PII, and reference entities by id rather than dumping payloads.

## Behavioral Guidelines

- Emit structured log entries (key-value fields or JSON) rather than free-form string concatenation, so logs are searchable and machine-parseable.
- Include correlation context in every log line: request/job/entity ids, operation name, and outcome — never full payloads or object dumps.
- Use levels with intent: `error` for actionable failures, `warn` for degraded-but-handled conditions, `info` for significant state changes, `debug` for diagnostic detail; avoid `info`-level noise in hot loops.
- Make error messages actionable: what operation failed, the relevant id, the underlying cause, and the retry/remediation hint — not just "operation failed".
- Add counters for success/failure outcomes and duration timings around critical paths: external calls, queue handoffs, cache hits/misses, and business-significant operations.
- Redact or omit secrets, API keys, tokens, passwords, and PII (emails, names, addresses) before anything reaches a log sink; log key names or hashes, never values.
- Log at boundaries — entry/exit of external calls, retries with attempt counts, and timeouts — so failures can be localized without a debugger.
- Preserve the original error (cause/stack) when wrapping or rethrowing, so root causes are not lost in translation layers.

## Checklist

- [ ] Every new failure path logs at an appropriate level with an actionable message and context ids
- [ ] Logs are structured and contain identifiers, not payload or object dumps
- [ ] Critical paths (external calls, retries, long operations) have counters and/or duration timings
- [ ] No secrets, credentials, tokens, or PII appear in any log statement
- [ ] Log levels match severity — no errors logged as info, no routine flow logged as error
- [ ] Wrapped/rethrown errors retain the original cause and stack
