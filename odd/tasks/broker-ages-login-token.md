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
- Initial remote deployment was pending at the time of this local work unit; see the deployment evidence below.

## Deployment evidence reported by parent agent (2026-09-28)

- Guest-local backup: `/srv/solinges/backups/aries-login-proxy/20260928T170055Z`.
- Broker image `codex-8fb8147` is running; its pool reports size 10, ready 10, warming 0, error 0 (`10/10/0/0`).
- FD03's first image `codex-0793a60` failed startup and was rolled back; corrected image `codex-ff97508` is running healthy with valid active Nginx configuration.
- A synthetic public login returned HTTP 401 with TLS verification result 0. No real credentials were used, and no AGES/IIS header dump was verified; the remote login-header contract is still unproven.
- CH09 Mini beat timings still show HTTP 403. Broker pool health does not establish AGES beat authorization or BackGES recovery. The conditional PR, merge, and branch close remain pending.

## Publication and controlled redeployment reported by parent agent (2026-09-28)

- Published immutable Broker tag `dhzacur/ha_ch09_brk:codex-8fb8147` to Docker Hub with digest `sha256:8e241f88323d27c39d9c078ceb73e3b6ecbb1523656cb9214aba78f6f7e8e423`, using Diego's explicitly authorized local Docker Hub session.
- The Aries guest pulled both Broker and FD03 immutable tags; only Broker and FD03 were controlled-recreated. Running image IDs matched their pulled tags.
- Broker pool remains size 10, ready 10, warming 0, error 0. FD03 is healthy and active `nginx -t` passes.
- Watchtower's 17:33:30 UTC scan reported `Failed=0`, `Scanned=3`, `Updated=0`; the prior registry 404 was eliminated. Watchtower and Certbot container IDs were preserved.
- CH09 Mini beat still returns HTTP 403. SRI SRI was unchanged; the original BackGES-down incident remains open, with no conditional PR, merge, or branch close.
