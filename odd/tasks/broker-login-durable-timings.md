# Broker login and durable timings

## Objective and problem

Give CH09-BRK a BackGES-style interactive login, initialize it from the same
application user file used by BackGES, protect Broker endpoints, and preserve
timing records across process restarts and container recreation. The original
Broker timing ring discarded records after 500 entries; the user has now
requested that this arbitrary retention cap be removed.

## Authorized scope and constraints

- Local CH09-BRK implementation, tests, and deployment templates. The user
  authorized reviews and necessary fixes before publishing PRs toward `main`
  in `Dejavu75/CH09-BRK` using the saved GitHub session. No direct push to
  `main`, installation, deployment, or merge is authorized.
- Interactive routes require a browser session. Automated AGES and heartbeat
  consumers use a separate service credential. ACME HTTP-01 remains public.
- Use the BackGES htpasswd-format user source at installation through a
  configured read-only mount; never copy credential contents into Git.
- Persist records on guest-local storage, not a container layer or the
  physical Hyper-V host. Never put plaintext secrets in ordinary logs.
- Preserve existing AGES proxy semantics except for the authentication gate.
- Existing untracked `.atl/` and `.codegraph/` are outside this feature.

## Acceptance criteria

- Valid BackGES-file users can log in to Broker; invalid users cannot.
- Session cookie, origin/CSRF checks, rate limiting, logout, expiry, and
  server-side session validation follow the BackGES security model.
- Broker pages and admin endpoints require a human session; machine routes
  require an explicit service credential; unauthenticated calls fail closed.
- ACME challenge remains accessible without authentication.
- Timing records survive a process restart and container recreation using a
  configured persistent mount. No fixed record-count retention discards old
  records; durable clear remains available. Reads use bounded pages rather
  than loading unlimited history into process memory or the browser.
- Sensitive timing fields are redacted before display and persistence; no
  encryption key is required. Keep operational metadata and durations, but
  do not store request/response bodies, URL query values, or unapproved header
  values. This intentionally changes the current raw timing view.

## Tasks

- [x] **T1 — Auth foundation.** Add credential-file verification, session
  storage, cookie/CSRF/rate-limit behavior, and focused tests. Route: delegated
  direct. Trigger: multiple non-trivial files and write preparation.
  Checks: focused auth tests, `npm run tsc`, `npm test`, diff check. Runtime:
  synthetic local checks; remote runtime out of scope. Commit
  `f9bd5d30618197e4f4bf5b8f70b9174bae3663d4`. `npm run tsc`, 72/72
  `npm test`, and `git diff --check` passed. SHA512-crypt positive integration
  and Docker executable availability remain T4 checks. Review:
  disabled/unmanaged.
- [x] **T2 — Route gates and interactive login.** Add login endpoints/page,
  session gate for human routes, service-credential gate for machine routes,
  ACME exception, and route regression tests. Route: delegated direct.
  Trigger: multiple non-trivial files. Commit
  `6484aa6d8113cbf59486a4873644dcb2a018d441`. `npm run tsc`, 76/76
  `npm test`, route matrix tests, and diff check passed. Service credential
  and session cookie are stripped before AGES proxying/timing capture. Trusted
  proxy/rate-limit deployment policy remains T4. Review: disabled/unmanaged.
- [x] **T3 — Durable timing store.** Persist final traces and events, reload
  on startup, initially enforce bounded retention (superseded by T5) and
  durable clear, and protect
  sensitive fields at rest. Route: delegated direct. Trigger: multiple
  non-trivial files. Privacy policy: user chose redaction, not encryption.
  Checks: restart/recreation simulation, focused timing tests, `npm run tsc`,
  `npm test`. Commit `16c5f05b6ef35d3aee4fc3dbd5073fd8b07100f7`.
  Local SQLite reopen/clear/retention tests, TypeScript, 80/80 full tests,
  and diff check passed. Container recreation remains T4/runtime pending.
  Pre-existing AGES logger token/session/response preview risk is outside T3.
  Review: disabled/unmanaged.
- [x] **T4 — Installation contract and documentation.** Add read-only
  credential mount, guest-local state volume to all applicable Compose
  templates, fail-closed configuration, and operator documentation. Route:
  delegated direct. Trigger: multiple deployment templates. Checks: Compose
  config validation where available, full tests/build, diff check. Commit
  `8c8df64f8ee3822ceea5f40926187230dc80e439`. TypeScript, 85/85 tests,
  three Compose validations, local Docker image build, Alpine SQLite and
  SHA512-crypt htpasswd integration, and diff check passed. No remote
  installation or activation. Review: disabled/unmanaged.
- [x] **T5 — Unbounded durable history with paged reads.** Remove the 500-row
  SQLite deletion and in-memory ring limit, keep only live/in-flight traces
  in memory, provide stable paged API and UI history reads, preserve final
  trace updates and durable clear without resurrection, and update tests/docs.
  Route: delegated direct. Trigger: coordinated store, pool, API/UI, tests.
  Checks: pagination/order/restart/clear tests, `npm run tsc`, `npm test`,
  Docker build if affected, diff check. Commit
  `4b6fac58609937529720abb7938ce320b973301e`. Focused 8/8 and full
  87/87 tests, TypeScript, local Docker build, and diff check passed. No
  remote runtime. Review: disabled/unmanaged.
- [x] **T6 — Review security corrections.** Reject and delete persisted sessions
  for users no longer present in the current BackGES credential file, remove
  credential/response/query leakage from ordinary AGES pool and route logs,
  and update vulnerable
  `proxy-addr` to the patched release without a broad dependency upgrade.
  Route: delegated direct. Trigger: multiple non-trivial auth/pool/dependency
  files. Commit `bd2fba669b5e208e4930b08d6f05eeac35c6a504`.
  Focused auth 6/6 and route 17/17, TypeScript, full 91/91 tests, local Docker
  build, and diff check passed. `proxy-addr` is 2.0.8 and its critical audit
  advisory is gone; 7 high and 3 moderate unrelated/transitive advisories
  remain. Runtime: local synthetic tests and image build, no remote activation.
  Review: disabled/unmanaged; independent read-only security follow-up closed
  the revocation/log findings after the route-log correction.
- [x] **T7 — Restore live timing visibility.** Show in-flight traces in the
  Timings view while retaining durable paged history for completed calls.
  Route: delegated direct. Trigger: pool/API/UI/tests across multiple
  non-trivial files. Commit `957820cb14ad2691597a6393689650c47a86e816`.
  Focused 9/9, TypeScript, full 92/92 tests, and diff check passed. A
  read-only follow-up review found no blocker. Live rows are bounded to 100
  on the first page, separate from the 100-row SQLite cursor page; README
  documents this. Runtime: local synthetic tests; no remote activation.
  Review: disabled/unmanaged.

## Mode, delivery, and progress

- Branch: `codex/broker-login-durable-timings` from
  `a8a07ffb5a2f25f3bf098146e762036048470f3f`.
- TDD: no explicit project/session setting found; do not infer it from tests.
  Use ordinary functional checks. Runner: `npm test` (`node --test
  Tests/*.test.js`), `npm run tsc`; focused Node tests per task.
- RDD: `disabled/unmanaged`, decided by clone-local OFF. No native review.
- Delivery strategy: `ask-on-risk` (default). Forecast at least 1,700
  authored changed lines across the original five work units, plus review
  corrections. User selected `feature-branch-chain`; publishing chained PRs
  toward `main` is authorized using saved GitHub credentials after reviews
  and corrections. Issue #6 covers login/authentication and issue #7 covers
  durable redacted timings. Both were created from the repository issue form,
  remain open, and have confirmed `status:approved` labels. Running authored committed
  count: 1,982 (T1 391, T2 375, T3 317, T4 283, T5 309, T6 253, T7 54;
  generated `build` excluded). Proposed first
  review slice ends at T1. The local, unpublished chain has tracker branch
  `feat/broker-login-durable-timings` from `origin/main` and seven cumulative
  child branches, each with one focused work-unit commit. The tracker contains
  this ODD document; child diffs exclude its repeated progress edits. Slices:
  T1 `aaa903b` (391 authored lines), T2 `afd7d24` (375), T3 `bccbca0`
  (317), T4 `0586d13` (283), T5 `f582d0a` (309), T6 `8727efd`
  (217), T7 `a7d0ce0` (54). Each child targets its immediate predecessor;
  the first targets the tracker, which will be a draft PR to `main`. Generated
  `build/` files raise visible diff totals above 400 for T1/T2/T3/T5 but
  are excluded from authored budget. No size-only code reduction was made.
- Progress: T1-T7 committed and locally checked. Two independent read-only
  reviews found a session-revocation bug, secret-bearing ordinary pool/route
  logs, and a live-timing regression. A local production dependency audit found the
  critical `proxy-addr` advisory, now patched. Next: push the prepared
  feature-branch-chain, create linked and labeled PRs, and verify CI.
  Unlimited on-disk history
  requires operator disk monitoring and backup; clearing remains manual.
  Activation still requires verifying the actual BackGES htpasswd host path,
  guest-local storage, machine clients, TLS proxy settings, and existing
  Watchtower topology. No deployment or remote runtime acceptance claimed.
