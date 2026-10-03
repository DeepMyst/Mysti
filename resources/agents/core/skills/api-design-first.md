---
id: api-design-first
name: API Design First
description: Designs and states the API contract before implementation — shapes, errors, naming, versioning
icon: globe
category: design
activationTriggers:
  - api design
  - endpoint
  - rest api
  - restful
  - graphql
  - contract
  - openapi
  - schema design
  - versioning
  - breaking change
---

## Instructions

Before writing any implementation code for an API surface, design and state the contract first: request/response shapes, error model, naming, and versioning/compatibility impact. When the contract is user-facing or externally consumed, present it and ask for confirmation before implementing. Treat any breaking change as an explicit decision that must be called out, never an incidental side effect of implementation.

## Behavioral Guidelines

- Lead with the contract: spell out endpoints/operations, request and response shapes (fields, types, optionality, nullability) before touching handler or resolver code.
- Define the error model up front — status codes or error types, a consistent error body shape, and which failures are client vs. server faults.
- Enforce naming consistency with the existing API surface: casing, pluralization, resource nouns, verb conventions, and field naming must match what is already there.
- Assess versioning and compatibility impact for every change: additive (safe), tightening (risky), or breaking — and say which it is; propose additive alternatives to breaking changes where possible.
- Apply the project's pagination, filtering, and sorting conventions to any collection endpoint; if none exist, propose one convention and use it consistently.
- For user-facing or externally consumed contracts, present the proposed contract (e.g., as an OpenAPI/GraphQL snippet or a concise shape listing) and wait for confirmation before implementing.
- Keep the stated contract and the implementation in lockstep — if implementation forces a contract change, surface the revised contract explicitly rather than silently diverging.
- Document semantics, not just shapes: idempotency, side effects, default values, and units where they are not obvious from the types.

## Workflow

1. Restate the capability needed and identify who consumes it (internal, external, UI).
2. Draft the contract: operations, request/response shapes, error model, pagination, auth expectations.
3. Classify compatibility impact: additive / tightening / breaking, and flag breaking changes for an explicit decision.
4. Confirm the contract if user-facing; then implement to match it exactly.
5. Verify the final implementation against the stated contract before finishing.

## Checklist

- [ ] Contract (shapes, operations, error model) was stated before implementation began
- [ ] Naming and conventions match the existing API surface
- [ ] Compatibility impact classified; any breaking change called out as an explicit decision
- [ ] Collection endpoints follow the pagination/filter/sort convention in use
- [ ] User-facing contracts were presented for confirmation before implementing
- [ ] Final implementation matches the stated contract exactly
