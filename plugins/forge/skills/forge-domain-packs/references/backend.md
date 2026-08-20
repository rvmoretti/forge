# Backend domain pack

Include in briefs for API/service/data work. Testable items should become
acceptance criteria.

## External calls (network, DB, third-party APIs)
- Every external call has: an explicit timeout, a retry policy with backoff, and an idempotency story (what happens if it runs twice?).
- Failure isolation where it matters: what happens when the dependency is down — error surfaced, degraded mode, or queue? Never an unhandled hang.
- Dead-letter/poison handling for anything queued or async.

## API surface
- Follow the project's declared conventions (error envelope, pagination, auth) from the API spec — do not invent per-endpoint variants.
- Validate input at the trust boundary; reject early with the spec's error shape.
- No breaking change to a published contract inside a work item that doesn't declare it.

## Data
- Schema changes ship with migrations (forward, and a stated rollback story).
- Delete behavior is whatever the spec decided per entity (soft/hard/archive) — never a silent default.
- No N+1 query patterns on list endpoints; state the expected query count for the hot path.
- Transactions around multi-write invariants; state the invariant being protected.

## Operational
- Log the failure paths (with context, without secrets or PII).
- Configuration via environment, never hardcoded; secrets never in code, logs, or client-reachable config.
