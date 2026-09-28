# Broker timing request and JSON response capture

## Objective
Expose the received request headers and body, plus JSON responses truncated to 1 KiB, in the Broker timing JSON.

## Problem and scope
The timing trace currently stores status and durations but not the request/response data needed to diagnose missing credentials across FD03 and CH09-BRK. Diego explicitly authorized unsanitized credentials and API keys in the public timing JSON for this investigation. Preserve existing timing routes and visibility; do not add access control, sanitize, deploy, push, or create a PR in this task.

## Delivery
- Authorized by Diego on 2026-09-28; he confirmed timing JSON may remain public for now.
- Strategy: ask-on-risk; forecast about 220 authored changed lines, below 400.
- Route: delegated direct; two non-trivial source files plus focused tests, and reading prepares a write.
- TDD: no explicit project/session TDD mode found in prior Broker task; run focused and full functional checks using `node --test Tests/*.test.js` and `npm run tsc`.
- RDD: disabled by clone-local preference, checked before source write.

## Tasks
- [x] BRK-TIMING-1: Add unsanitized received header array and request body to proxied timing traces; capture JSON response text up to 1024 UTF-8 bytes without changing responses sent to clients. Add synthetic regression tests.

## Acceptance and checks
- The JSON timing endpoint includes each received request header in order, preserving original casing and duplicates, and the request body without sanitization.
- JSON responses are captured as text up to 1024 UTF-8 bytes; non-JSON responses are not captured. Forwarded responses remain unchanged.
- Existing internal timing entries remain valid; no live secrets appear in tests, source, or reports.
- Run focused Node tests, full `npm test`, and `npm run tsc`; record failures or skipped checks honestly.
- Commit the coherent work unit with a Conventional Commit message. RDD remains disabled/unmanaged.

## Progress
- `req.rawHeaders` is stored as ordered name/value pairs, retaining original casing and duplicates. Parsed request body text is stored without sanitization.
- Valid JSON responses are captured regardless of `Content-Type` and truncated on a UTF-8 character boundary at 1024 bytes. Non-JSON responses have no `responseJson` field.
- Focused `node --test Tests/timing_payload.test.js`: 2/2 passed; full `npm test`: 61/61 passed; `npm run tsc`: passed; `git diff --cached --check`: passed.
- Runtime harness: a synthetic local HTTP request proved ingress capture and response byte preservation; no production request, deployment, or remote verification was run.
- Binary request bodies are represented as UTF-8 text, not reversible original bytes. The target login and JSON/text diagnostics are preserved.
- Work-unit commit: `c585ed6` (`feat(broker): registrá encabezados y cuerpos en timings`). Authored additions plus deletions: 307, below the 400-line forecast threshold. RDD disabled by clone-local preference; delivery unmanaged by native review.
- Rollback boundary: revert `c585ed6`; this removes the new trace fields, route capture, and focused tests without touching earlier login fixes.
- Next step: deployment requires separate authorization; the public timing routes intentionally remain unauthenticated.
