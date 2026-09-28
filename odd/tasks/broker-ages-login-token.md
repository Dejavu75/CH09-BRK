# Broker AGES login token forwarding

## Objective
Keep the Broker's slot `AGES_TOKEN` off AGES login requests while preserving normal slot authentication on other calls.

## Problem and scope
`AgesConnectionPool.buildSessionHeaders` injects the slot token on every proxied request, including `POST /ages/login/autorizar`. Limit the exception to that login endpoint, retaining client credential headers, other headers, cookies, warmup, beat, and all non-login routes.

## Delivery
- Authorized by Diego on 2026-09-28 for correction, tests, and deployment.
- Strategy: ask-on-risk; forecast under 150 authored changed lines.
- Route: delegated direct; Broker source and focused tests are two non-trivial files.
- TDD: no explicit project/session TDD mode found; run focused and full functional checks.
- RDD: disabled by clone-local preference (observed before source write).

## Tasks
- [x] BRK-LOGIN-1: Suppress slot token on the login endpoint only; prove credentials and normal headers survive, and non-login requests still carry the slot token.

## Acceptance and checks
- Login request has `AGES_USER` and `AGES_PASS` but no Broker-injected `AGES_TOKEN`.
- Other proxied and internal pool requests preserve token behavior.
- Run targeted Node tests, full `npm test`, and TypeScript compilation.
- Record a conventional work-unit commit and any unverified deployment checks.

## Progress
- Diagnosed: `buildSessionHeaders` assigns `AGES_TOKEN` unconditionally.
- Only normalized `ologin.autorizar.ages` (BigBoy and Mini) omits even a client-supplied `AGES_TOKEN`; other calls retain the slot token and session cookie.
- Focused `node --test Tests/dual_backend_routing.test.js`: 7/7 passed.
- `npm run tsc`: passed; `npm test`: 59/59 passed.
- Rollback boundary: revert the login-specific header option and its focused test; unrelated pool behavior remains unchanged.
- Work-unit commit: `3812981` (`fix(broker): omití AGES_TOKEN en login sin alterar otras llamadas`). RDD disabled by clone-local preference; delivery unmanaged by native review.
- Pending: remote deployment and post-deploy acceptance owned by parent agent.
