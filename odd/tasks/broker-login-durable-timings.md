# Broker login and durable timings

## Objective and problem

Give CH09-BRK a BackGES-style interactive login with exactly two Broker-owned
general accounts created by the image, protect Broker endpoints, and preserve
timing records across process restarts and container recreation. The original
Broker timing ring discarded records after 500 entries; the user has now
requested that this arbitrary retention cap be removed.

## Authorized scope and constraints

- Local CH09-BRK implementation, tests, and deployment templates. The user
  authorized reviews and necessary fixes before publishing PRs toward `main`
  in `Dejavu75/CH09-BRK` using the saved GitHub session. No direct push to
  `main`, installation, deployment, or merge is authorized.
- Interactive routes require a browser session. The user clarified that the
  machine surface is MS07 Broker beats (intended inter-MS authentication) and
  AGES proxy endpoints; all manually viewed routes use human login. ACME
  HTTP-01 remains public. Do not assume the current MS07 beat already sends
  a key: local source shows it currently sends empty headers.
- T1-T8 used the BackGES htpasswd-format source. The user has superseded that
  source requirement: BackGES remains unchanged, and the Broker image must
  provide exactly two general accounts without a preinstalled user file.
  Store only password hashes in source/image; never plaintext credentials.
- Persist records on guest-local storage, not a container layer or the
  physical Hyper-V host. Never put plaintext secrets in ordinary logs.
- Preserve existing AGES proxy semantics except for the authentication gate.
- The user confirmed that the image itself must initialize the Broker on an
  existing `ges01` without preparatory edits to its Compose or runtime env.
  BackGES remains unchanged. Do not weaken machine-route authentication or
  claim this is complete merely because the credential file is removed.
- Existing untracked `.atl/` and `.codegraph/` are outside this feature.

## Acceptance criteria

- The two specified Broker general accounts can log in without a host
  htpasswd file; other users cannot. No plaintext password is committed or
  emitted by tests, build logs, runtime logs, or documentation.
- Session cookie, origin/CSRF checks, rate limiting, logout, expiry, and
  server-side session validation follow the BackGES security model.
- Broker pages and admin endpoints require a human session; machine routes
  require an explicit service credential; unauthenticated calls fail closed.
- ACME challenge remains accessible without authentication.
- An unchanged existing `ges01` Compose/runtime can start the new image and
  serve the two general accounts, authenticated machine requests, and durable
  timing/session state. Verify this at the actual runtime boundary before
  claiming zero-preparation deployment.
- Timing records survive a process restart and container recreation using a
  configured persistent mount. No fixed record-count retention discards old
  records; durable clear remains available. Reads use bounded pages rather
  than loading unlimited history into process memory or the browser.
- Sensitive timing fields are redacted before display and persistence; no
  encryption key is required. Keep operational metadata and durations, but
  do not store request/response bodies, URL query values, or unapproved header
  values. This intentionally changes the current raw timing view.

## Tasks

- [x] **T9 — Bootstrap Broker-owned general accounts.** Replace the required
  BackGES credential-file source with exactly two built-in password hashes,
  remove the htpasswd host-mount prerequisite from deployment templates, and
  cover valid/invalid login and first-start behavior. BackGES is unchanged.
  Route: delegated direct. Trigger: auth implementation, deployment templates,
  tests, and documentation span multiple non-trivial files; writing preparation
  is delegated. Checks: focused auth/route tests, `npm run tsc`, `npm test`,
  local Docker build, Compose validation, secret scan, and diff check. No
  production deployment or merge is authorized. Existing origin, machine-key,
  and durable-state release gates remain explicit rather than silently waived.
  Commit `209d0e4fe66fbbbd81723eaf9f27cfd06fb881ee` on local branch
  `feat/broker-login-durable-timings-09-default-users` (101 authored changed
  lines; not pushed). TypeScript, focused
  auth/routes 13/13, Docker build, three Compose validations, ephemeral
  positive logins for both requested credentials, secret scan, and diff check
  passed. Full suite is 94/95 in the default Windows CRLF checkout because
  of the pre-existing IIS literal-LF assertion; it passed 95/95 with temporary
  LF normalization, then the script was restored. Independent read-only
  review found that unchanged ges01 Compose/runtime still requires public
  origin, service key, and persistent state path; image-only zero-preparation
  deployment is therefore not met. Positive credential matching is not in CI
  because plaintext secrets must not be committed. T10 tracks the remaining
  image-only startup requirement; no runtime acceptance or publication
  claimed. Review: disabled/unmanaged.
- [ ] **T10 — Complete image-only first-start bootstrap.** Reuse only proven
  existing guest-local persistent storage, derive or validate the HTTPS
  browser origin without accepting untrusted host/proxy data, and preserve a
  working authenticated contract for existing machine consumers without
  manually preparing each `ges01`. Route: delegated direct. Trigger:
  cross-cutting startup, security gate, deployment, and tests across multiple
  non-trivial files. Current blocker: an image-generated service key cannot be
  known to MS/AGES clients, and the public HTTPS origin may include an
  external port/proxy not derivable from the certificate domain alone.
  Checks: unchanged-Compose start, two human logins, machine 401 without
  authority and successful authorized calls, TLS/proxy/origin matrix,
  guest-local storage and restart/recreation durability, full tests and
  Docker build. Do not implement a weaker gate or publish before the machine
  credential contract is resolved. Local contract mapping: MS07 currently
  calls the Broker heartbeat with no headers, while its AGES beat has an
  inter-MS token. CH09 currently validates neither inter-MS token and has no
  inter-MS verification secret in its deployment templates; its new service
  gate expects a different header. Verify the AGES authorization boundary and
  coordinate the separately authorized MS07 change before implementation.
- [ ] **T11 — Verify scoped MS07 Broker beats.** Accept an inter-MS Bearer
  token only on the Broker heartbeat beat route when its HMAC signature,
  expiry, issuer, exact `broker` audience, MS07 identity, and `broker:beat`
  scope are valid. Keep AGES proxy routes on their existing fail-closed
  machine gate; never treat their forwarded AGES credential as inbound Broker
  authority. Do not embed a shared signing secret in the image or silently
  accept unsigned beats. Route: delegated direct. Trigger: auth gate,
  verifier, tests, and documentation span multiple non-trivial files;
  preparation was delegated. TDD: unset, ordinary focused tests plus
  `npm test` and `npm run tsc`. RDD: clone-local disabled/unmanaged.
  Checks: positive token from current signer, wrong audience/scope/issuer,
  expiry, tampering, missing secret and unsigned beat; no token or secret in
  logs/timings; Docker build and diff check. This is a safe interoperability
  slice, not proof of zero-preparation deployment: the existing Broker image
  lacks a verified shared secret source and T10 remains open. Local commit
  `05eb9c0f352436edad53b78088107427735f8697` on
  `feat/broker-login-durable-timings-11-interms` (122 authored changed lines,
  unpushed) implements the scoped GET exception. TypeScript, focused route
  tests 6/6, diff check, and secret scan passed. Full suite is 96/97 in the
  Windows CRLF checkout due the previously identified unrelated IIS LF
  assertion. Docker build could not run because Docker Desktop did not start;
  keep this check pending before closing T11. Independent read-only challenge
  found no route escalation or logging bypass. Shared HMAC possession does not
  prove unique MS07 identity: any holder could mint an MS07-looking token.
  Actual MS07 `MSCODE=MS07` and shared-secret availability are unverified.

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
- [x] **T8 — Reclaim expired auth state.** Schedule bounded cleanup of
  expired login-attempt entries and persisted sessions without affecting
  active sessions or requests. Route: delegated direct. Trigger: auth
  lifecycle and deterministic tests require multiple non-trivial files.
  Checks: focused cleanup/expiry tests, `npm run tsc`, `npm test`, Docker
  build, and diff check. Commit `484e9d8fa0ea827504b263d00dc1e85a97d0ad20`
  on PR #16 after #15, linked to approved login issue #6. Focused 8/8,
  full 94/94 in an LF-preserving checkout, TypeScript, Docker build, diff
  check, and GitHub CI passed. Independent read-only review found no code
  blocker. The default Windows CRLF checkout fails one unrelated IIS script
  literal-LF assertion; the exact #15 parent passes 92/92 in the same
  LF-preserving setup. Runtime remains unverified. Review:
  disabled/unmanaged.

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
  count: 2,274 (T1 398, T2 375, T3 317, T4 280, T5 309, T6 217, T7 54,
  T8 101, T9 101, T11 122; generated `build` excluded). The published chain has draft tracker PR #8
  (`feat/broker-login-durable-timings`) against `main` and eight cumulative
  child branches, each with one focused work-unit commit. The tracker contains
  this ODD document; child diffs exclude its repeated progress edits. Slices:
  T1 PR #9 `907e60e` (398 authored lines), T2 PR #10 `6c1a20a` (375),
  T3 PR #11 `00bbb35` (317), T4 PR #12 `78b121c` (280),
  T5 PR #13 `a1ca563` (309), T6 PR #14 `5fcfa81` (217),
  T7 PR #15 `64f31d9` (54), T8 PR #16 `484e9d8` (101). Each child targets
  its immediate predecessor; the first targets the draft tracker. Generated
  `build/` files raise visible diff totals above 400 for T1/T2/T3/T5 but
  are excluded from authored budget. No size-only code reduction was made.
  Each PR links an approved issue and has exactly one matching `type:*` label.
  All nine GitHub CI checks passed after moving the native dependency build
  toolchain into T1; the resulting Dockerfile is unchanged at the final tip.
- Progress: T1-T8 committed and locally checked. Two independent read-only
  reviews found a session-revocation bug, secret-bearing ordinary pool/route
  logs, and a live-timing regression. A local production dependency audit found the
  critical `proxy-addr` advisory, now patched. The feature-branch-chain is
  pushed and linked PRs #8-#16 are open; the tracker remains draft. A further
  read-only review found that expired login attempts and session rows had no
  scheduled cleanup; T8 corrected this in bounded sweeps. T9 is committed
  locally but not published; T11 is committed locally with Docker build pending;
  T10 remains open for image-only initialization.
  Next: resolve the machine-client authentication contract and external
  origin before claiming automatic deployment; keep the tracker unmerged until
  release readiness is proven. Pushing to `main` publishes Docker Hub
  `:latest`, which may be
  activated by Watchtower; live consumer HTTPS/service-key compatibility and
  Watchtower scope are unverified.
  Unlimited on-disk history
  requires operator disk monitoring and backup; clearing remains manual.
  Activation still requires verifying the actual BackGES htpasswd host path,
  guest-local storage, machine clients, TLS proxy settings, and existing
  Watchtower topology. No deployment or remote runtime acceptance claimed.
