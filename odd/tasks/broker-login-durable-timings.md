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
  Broker-owned machine surface is the MS07 beat; true AGES passthrough is
  outside Broker authentication because AGES owns its API key and login.
  Broker-owned control aliases under `/ages` remain protected. All manually
  viewed routes use human login. ACME
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
- Broker pages and admin endpoints require a human session; Broker-owned
  machine routes require an explicit service credential and fail closed.
  True AGES passthrough is not gated by Broker login/key, remains HTTPS-only,
  and delegates API authorization to AGES.
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
  manually preparing each `ges01`. Route: direct inline after delegated
  read-only mapping; independent high-risk verification follows. The approved
  central validation contract removes the per-ges01 HMAC secret and the image
  now persists a generated service key when no override exists. MS07 HTTPS
  reachability, unchanged-Compose startup, and local origin/state fallbacks
  were validated against the Lecar guest.
  Checks: unchanged-Compose start, two human logins, Broker-owned machine 401 without
  authority and successful authorized calls, TLS/proxy/origin matrix,
  guest-local storage and restart/recreation durability, full tests and
  Docker build. Do not weaken other Broker controls or publish before the
  central endpoint is proven reachable and compatible. T11 implemented a
  local HMAC verifier; the production app now uses the approved central
  MS07 validator. Local client
  mapping found that CA04-GCO and CA05-GCC can use MS01-provided AGES URLs
  and send AGES user tokens or AGES API keys, but no Broker service key;
  whether their deployed URLs actually traverse CH09 is unverified. The
  former Broker gate would reject those clients if they did. The user has now
  clarified that AGES passthrough does not need a Broker key; T14 changes
  only that boundary. Live client routing remains unverified. Corrected CH09
  cumulative tip `47d5b17` was integrated through the feature chain into main
  merge commit `ddda15e` and deployed automatically by the existing labeled
  Watchtower as build `1.0.15`, image ID
  `sha256:e62e12e74fe103a793fce777fcf56835e003858783242dc8e98c4def5c89e945`.
  MS07 identity fix `4dc088e` is the
  clean local tip of `codex/ms07-broker-introspection`; its image was published
  as `dhzacur/se_ms07_doc:broker-introspection-4dc088e` with registry digest
  `sha256:678c9495b5f9d90d7432bb771b6073ad1371acbbdf917f046079e46b259e467f`.
  The first MS07-only deployment did not pass its runtime gate and restored
  the prior image and exact Compose bytes. A second instrumented attempt
  during scheduled downtime successfully deployed the corrected image.
  Independent verification confirmed the container is running with restart
  count zero, the effective Compose service references the new tag, an
  unauthenticated public validation POST returns 401 `{"valid":false}`, and a
  short-lived token generated inside MS07 returns 200 `{"valid":true}`. The
  deployed Compose SHA-256 is
  `d2656349301784b73d7af5bf749c08e2c9a6232105ade1e6e485e693a7e3ac6e`.
  The earlier failed gate remains unverified; an endpoint-readiness race is
  only an inference. Independent CH09 runtime verification confirmed the
  deployed revision, restart count zero, guest-local ext4 state with private
  permissions, valid public TLS, 401 for missing/invalid beat tokens, and 200
  for a valid token generated inside MS07. Both built-in human accounts then
  completed login, authenticated session, protected pool read, and logout over
  public HTTPS without exposing their credentials. The pool reported
  `ready=10`, `warming=0`, `error=0`, split A=5 and B=5. One authorized
  no-pull recreation of only `ch09-brk` preserved an authenticated session,
  the service-key identity, session/timing database inodes, Compose bytes, and
  Watchtower identity. The recreated container retained the expected image and
  restart count zero. One slot initially failed warmup with HTTP 500, producing
  a transient 9/0/1 pool; before any manual recycle the protected pool returned
  to 10/0/0 and A=5/B=5. The five-minute ping recycle path is consistent with
  that recovery, but causality was not independently proven. Independent
  verification passed the current image, container state, Compose hash,
  guest-local private state, and Watchtower state. T10 remains partial because
  live routed CA04/CA05 traffic and certificate renewal were not exercised.
  Review: disabled/unmanaged.
- [x] **T11 — Verify scoped MS07 Broker beats.** Accept an inter-MS Bearer
  token only on the Broker heartbeat beat route when its HMAC signature,
  expiry, issuer, exact `broker` audience, MS07 identity, and `broker:beat`
  scope are valid. Do not treat AGES credentials as Broker-beat authority.
  Do not embed a shared signing secret in the image or silently
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
  assertion. Local Docker build with `--pull=false` passed on retry and
  produced `ch09-brk:t11-local`; no container was deployed. Independent
  read-only challenge
  found no route escalation or logging bypass. Shared HMAC possession does not
  prove unique MS07 identity: any holder could mint an MS07-looking token.
  Actual MS07 `MSCODE=MS07` and shared-secret availability are unverified.
  The requirement to keep the AGES proxy on a Broker key gate was superseded
  by the user's later scope clarification; T14 changes it without weakening
  Broker-owned control endpoints.
- [x] **T12 — Bootstrap durable state on an existing guest mount.** When
  explicit database paths are absent, initialize private session and timing
  databases beneath the already-mounted `/etc/nages2/logdir` path. Reject an
  absent, symlinked, read-only, or non-local mount instead of writing to the
  container layer. Preserve explicit paths for configured installations and
  keep mount validation separate from claims about the host's physical
  backing. Route: delegated direct. Trigger: startup, both stores, mount
  validation, tests, and documentation span multiple non-trivial files;
  preparation was delegated. TDD: unset; runner `npm test` and `npm run tsc`.
  RDD: clone-local disabled/unmanaged. Checks: absent/disallowed mount and
  symlink rejection, private directory owner and permissions (including a
  foreign-owned preexisting child), restart/reopen and
  durable clear with SQLite sidecars, explicit override compatibility,
  Docker image build, diff check. A short-syntax Compose bind can silently
  create an empty host directory; image checks cannot prove guest-local host
  backing or prevent host log rotation from deleting state. Actual guest
  storage and recreation behavior were subsequently verified. Review
  found that chmod alone does not make a foreign-owned preexisting child
  private; reject it before accepting the fallback. Newer Compose templates
  still set both explicit DB paths and therefore never take this fallback.
  Local commits `462e74151d9390d8ebd68688b1b367a5087cbc33` and
  `575ad74c29bbeb47ea7ba2927b1e07d3cbad5d66` on
  `feat/broker-login-durable-timings-12-state` (184 authored changed lines,
  unpushed) implement the guarded fallback and review correction. TypeScript,
  focused 3/3 Windows tests, Docker build, and local container checks for a
  named volume (start) versus absent/tmpfs/foreign-owned mounts (reject)
  passed; diff and secret scans passed. Full Windows suite: 99 pass, one
  unrelated pre-existing IIS CRLF failure, one root-only ownership test
  skipped on Windows and covered by the Docker check. Runtime backing and
  unchanged ges01 recreation were verified later; rotation and backup remain
  operator responsibilities rather than image claims.
  Reopened on 2026-10-13: Lecar's verified guest-local log mount is owned by
  uid 1000 while the container runs as root, so the current owner-equality
  guard rejects the unchanged installation. The user accepted adapting the
  image to trust the existing mount owner without changing ges01. Keep the
  exact local writable mount, no group/world write, private root-owned child,
  and foreign-owned child rejection; cover the accepted owner mismatch and
  the previously rejected unsafe cases before closing this follow-up.
  Local follow-up commit `b66b530` on
  `feat/broker-login-durable-timings-15-root-state` accepts an operator-owned
  exact local mount when the container runs as root. A deterministic mocked-root
  test passed 1/1 after an observed RED; TypeScript passed and an independent
  verifier found no blocker within the accepted trusted-operator model. The
  full Windows suite reported 102 passed, 7 failed, 1 skipped in the restricted
  sandbox; symlink creation and certificate fixture access are unavailable.
  Docker and WSL are also denied locally. A later fresh verifier passed the
  Linux ownership/symlink/service-key checks 7/7, and the corrected cumulative
  Windows suite passed 112 with one platform-specific root-only skip. This
  task closed after unchanged-Compose recreation on the actual CH09 guest kept
  the same session/timing database inodes and private root-owned state. The
  runtime operation changed only the `ch09-brk` container; no remote files or
  Watchtower state were changed.
- [x] **T13 — Resolve the human login origin from verified HTTPS requests.**
  Preserve the explicit `BROKER_PUBLIC_ORIGIN` policy when configured. When
  absent, use the exact request Host authority (including external port)
  only if the request is already considered HTTPS by the existing trusted
  transport policy and the hostname matches a configured local certificate
  identity. Never trust unanchored Host or `X-Forwarded-Host`, accept an
  arbitrary Origin, or infer the external port from the container listener.
  Fail closed if no trustworthy certificate/host is available. Route:
  delegated direct. Trigger: auth service, HTTP integration, certificate
  loading, tests, and docs span multiple non-trivial files; preparation was
  delegated. TDD: unset; runner `npm test` and `npm run tsc`. RDD:
  clone-local disabled/unmanaged. Checks: valid host with default/nondefault
  public ports, mismatched host/origin, spoofed forwarded headers, wildcard
  and unrelated certificates, TLS/proxy mode, explicit override regression,
  full tests, Docker build, and diff check. Live proxy Host preservation and
  certificate topology remain T10 runtime gates; this work unit must not
  silently weaken CSRF or production transport checks. Local commit
  `a2987a260e037aaf7128c091ebb236e49f37e67e` on
  `feat/broker-login-durable-timings-13-origin` (232 authored changed lines,
  unpushed; generated build and certificate fixtures excluded) passed focused
  18/18, TypeScript, Docker build, diff and secret scans. Full Windows suite:
  102 pass, one known unrelated IIS CRLF failure, one Linux-only skip.
  Independent read-only challenge found no concrete login/CSRF bypass.
  If TLS terminates only at a proxy with no readable local certificate and
  no explicit origin, human routes fail closed with 403. Actual proxy Host,
  TLS forwarding, browser form, and certificate renewal remain T10 gates.
- [x] **T14 — Exempt only AGES passthrough from Broker authentication.**
  True AGES proxy routes under both `/ages` and `/foreign/broker` must pass
  through without a Broker session or service key while retaining global
  HTTPS enforcement and forwarding AGES credentials. Explicit Broker-owned
  controls (`/pool`, `/iis`, `/ages-host`, `/health`, `/heartbeat`, including
  their aliases under `/ages`) keep their existing human or machine gates.
  Preserve the exact MS07 signed-beat exception. Route: delegated direct.
  Trigger: route classification, HTTP tests, and docs are multiple non-trivial
  files; exploration was delegated. TDD: unset; runner `npm test` and
  `npm run tsc`. RDD: clone-local disabled/unmanaged. Checks: both proxy
  mounts and catch-all routes without Broker credentials, AGES header/token
  forwarding, protected controls with/without authority, HTTPS enforcement,
  beat exception, full tests, Docker build, diff and secret scans. Do not
  claim AGES always demands a key: its own login endpoint may accept requests
  before issuing a token; AGES remains responsible for downstream auth.
  Local commits `f087bcb001e0e596f4e1be7a2d88fc7a0c32c602` and
  `2018a722c707c5542e75ff1b766da388593b62d7` on
  `feat/broker-login-durable-timings-14-ages-proxy` (201 authored changed
  lines, generated build excluded; unpushed) implement and correct the route
  boundary. Independent read-only review found that prefix-based control
  classification also blocked AGES catch-all paths such as `health/status`;
  the follow-up matches the registered routes and methods, including optional
  trailing slash, while preserving the signed MS07 exception and CSRF on
  state-changing IIS GET. Focused 26/26, TypeScript, Docker build, and diff
  check passed. Full Windows suite: 105 pass, one pre-existing unrelated IIS
  CRLF assertion failure, one Windows ownership test skipped. No remote
  runtime, upstream AGES authorization, or deployment claimed. Review:
  disabled/unmanaged. Follow-up local test-only commit `3c7d14a` makes the
  IIS assertion accept LF and CRLF; focused IIS tests passed 6/6 and the full
  Windows suite now passes 106/107 with one root-only test skipped.

- [x] **T15 — Reload renewed TLS credentials without container restart.**
  Detect changes to the configured certificate/key bytes and replace the live
  HTTPS server secure context without touching Watchtower or requiring Docker
  access from Certbot. Keep the last valid context when a partial or invalid
  renewal is observed, retry later, and avoid logging certificate/key content.
  Route: direct inline. Trigger: none; one bounded runtime behavior with tests.
  TDD: applicable; observe a failing deterministic reload test, then GREEN and
  refactor. Checks: focused TLS reload tests, TypeScript, full suite, Docker
  build, and an isolated runtime certificate-rotation smoke. Independent
  verification follows because this changes production TLS behavior. RDD:
  clone-local disabled/unmanaged.
  RED: the focused test initially failed because the reload module did not
  exist. GREEN: TypeScript passed; focused TLS/proxy tests passed 19/19; the
  full suite passed 113 with one platform-specific skip; Docker image
  `sha256:c8fce242234dbcbfd635a1befd5504252bc07373f737934c41005b5c5b7a3956`
  built successfully. An isolated real HTTPS smoke preserved the prior
  certificate for a partial cert/key pair and activated the complete renewed
  pair without restarting the server. Work-unit commit `7c0cdc7`. Independent
  verification passed TypeScript, focused 19/19, full suite 113 pass with one
  platform-specific skip, Docker build, diff checks, and a fresh real HTTPS
  rotation probe. Review: disabled/unmanaged.

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
  count: 3,224 (T1 398, T2 375, T3 317, T4 280, T5 309, T6 217, T7 54,
  T8 101, T9 101, T11 122, T12 184, T13 232, T14 203, root-state 52,
  central MS07 validation and correction 279; generated `build` and certificate
  fixtures excluded). The published chain has draft tracker PR #8
  (`feat/broker-login-durable-timings`) against `main` and fifteen cumulative
  child branches, each with one focused work-unit commit. The tracker contains
  this ODD document; child diffs exclude its repeated progress edits. Slices:
  T1 PR #9 `907e60e` (398 authored lines), T2 PR #10 `6c1a20a` (375),
  T3 PR #11 `00bbb35` (317), T4 PR #12 `78b121c` (280),
  T5 PR #13 `a1ca563` (309), T6 PR #14 `5fcfa81` (217),
  T7 PR #15 `64f31d9` (54), T8 PR #16 `484e9d8` (101),
  T9 PR #17 `209d0e4` (101), T11 PR #18 `05eb9c0` (122),
  T12 PR #19 `575ad74` (184), T13 PR #20 `a2987a2` (232),
  T14 PR #21 `3c7d14a` (203), root-state PR #22 `7b47394` (52), and
  central MS07 validation PR #23 `47d5b17` (279). Each child targets
  its immediate predecessor; the first targets the draft tracker. Generated
  `build/` files raise visible diff totals above 400 for T1/T2/T3/T5 but
  are excluded from authored budget. No size-only code reduction was made.
  Each PR links an approved issue and has exactly one matching `type:*` label.
  All sixteen GitHub CI checks passed after moving the native dependency build
  toolchain into T1; the resulting Dockerfile is unchanged at the final tip.
- Progress: all implementation units and the root-state and central-validation
  follow-ups are committed, merged through PR #8 as `ddda15e`, published, and active on Lecar
  `ges01`. CI, Docker publication, public TLS, human login/session/logout,
  protected pool access, central MS07 beat validation, guest-local state, and
  one unchanged-Compose recreation were observed. The final runtime is the
  expected image with restart count zero and pool 10/0/0 (A=5/B=5). Watchtower
  was not modified. T10 remains partial only for live routed CA04/CA05 traffic
  and certificate-renewal evidence. NAGES remains the MS07 target, not the CH09 runtime target.
  Unlimited on-disk timing history still requires operator disk monitoring and
  backup; clearing remains manual.

## Log

- 2026-10-13 implementation: CH09 `3c32257` adds fail-closed central beat
  validation and a private persistent fallback service key; MS07 `8404963`
  adds the exact-token validation endpoint. Both are local work-unit commits.
  Focused tests and typechecks passed. Independent read-only verification
  kept T10 open pending NAGES deployment and unchanged-Compose guest runtime.
- 2026-10-13 user approval: "si" to the proposal "¿Autorizás cambiar el
  contrato para que el Broker valide el beat consultando a MS07 en NAGES por
  HTTPS, sin secreto en cada ges01 y fallando cerrado si NAGES no responde?"
  T10 now includes a central validation endpoint in MS07 and a fail-closed
  Broker client. No CH09 deployment or weakening of other machine gates is
  authorized by this approval.
- 2026-10-13 user clarification: "Aceptado" after the proposal to adapt the
  image for Lecar's uid-1000-owned guest-local log volume without changing
  ges01. The root container may trust the volume owner, but the owner can
  replace entries in that parent directory; this is an explicit trust boundary.
- 2026-10-13 implementation: `b66b530` changes only the root-run mount owner
  policy and its tests. The primary checkout cannot switch branches because
  its restricted sandbox denies stat of two changed certificate fixtures;
  this tracker update used an isolated sparse documentation worktree.
- 2026-10-13 MS07 runtime attempt: source archive for clean commit `4dc088e`
  matched SHA-256 before and after transfer to NAGES. Image
  `dhzacur/se_ms07_doc:broker-introspection-4dc088e` was built and published at
  registry digest
  `sha256:678c9495b5f9d90d7432bb771b6073ad1371acbbdf917f046079e46b259e467f`.
  The service-scoped MS07 deployment failed before a successful HTTPS token
  proof and automatically restored the prior image and exact Compose bytes.
  Independent read-only checks confirmed the rollback image, image ID,
  Compose SHA-256, running state, restart count zero, and public endpoint 404.
  The precise failed gate was not captured; no CH09 deployment is claimed.
- 2026-10-13 MS07 instrumented retry: during scheduled downtime the user
  explicitly disabled automatic rollback so a failure could remain available
  for diagnosis. The service-scoped retry instead passed every named gate:
  expected image and revision, running container with restart count zero,
  public POST 401 `{"valid":false}` without a token, and public POST 200
  `{"valid":true}` with a short-lived token generated inside MS07. Independent
  read-only verification repeated those results and confirmed effective
  Compose SHA-256
  `d2656349301784b73d7af5bf749c08e2c9a6232105ade1e6e485e693a7e3ac6e`.
  The first attempt's failure cause remains unknown; readiness timing is an
  inference only. CH09 was not deployed and T10 remains open.
- 2026-10-13 CH09 publication preflight: the user explicitly authorized
  read-only `ssh nages`. Current inspection confirmed MS07 still runs
  `broker-introspection-4dc088e` with restart count zero and the verified
  Compose SHA-256. NAGES has no CH09-BRK container or image, only CH09-COU,
  and `/srv/solinges` is absent. No remote file, container, or Watchtower
  mutation occurred.
- 2026-10-13 correction and publication: independent verification found that
  `3c32257` had not updated the production-wiring VM dependency map and loaded
  the generated Broker service key before the session store privatized a fresh
  explicit state directory. Commit `47d5b17` adds the missing harness bindings,
  asserts startup order, and initializes auth state before loading the key.
  RED reproduced 18/18 proxy failures; GREEN passed focused 22/22, the full
  Windows suite 112/112 with one platform skip, Docker build, and independent
  blocker recheck. Chained PRs #17-#23 are open, mergeable, each has one
  matching `type:*` label, and every GitHub CI check passed. No CH09 merge or
  deployment occurred.
- 2026-10-13 Lecar CH09 runtime preflight: the user explicitly authorized
  read-only SSH through saved alias `lec` to guest `ges01`. Compose project
  `lecar-ch09` runs `ch09-brk` from `dhzacur/ha_ch09_brk:latest`, image ID
  `sha256:f9c7fd91bf415ec886c200af7a1ee4eaf8d8ce39b4e71c28cdde7307ef295033`,
  with restart count zero and no Docker healthcheck. Compose SHA-256 is
  `0e5f657c28456f99f2e8da45297125ad452f2aac8e7307e284722f8c71e98f6f`.
  `/srv/solinges` is guest-local ext4 storage. Unauthenticated local HTTPS
  returned 200 for `/foreign/broker/health` and `/foreign/broker/pool`, and
  404 for `/pool`. No remote mutation occurred, no secret values were read,
  Watchtower was not touched, and the temporary SSH tunnel was terminated.
  A second read-only inspection confirmed the Broker opt-in label is `true`
  and the healthy Watchtower uses `--label-enable`; a changed published
  `:latest` may therefore activate without a manual Compose operation.
- 2026-10-13 CH09 main rollout: PRs #23 through #9 were merged in dependency
  order into the tracker branch after each updated parent passed CI. Tracker
  PR #8 then passed CI, left draft state, and merged to main as `ddda15e`.
  GitHub CI and Docker publication run `38497667519` succeeded. Watchtower
  activated image
  `sha256:e62e12e74fe103a793fce777fcf56835e003858783242dc8e98c4def5c89e945`
  without a manual container or Watchtower change. Independent runtime checks
  found build `1.0.15`, revision `ddda15e21f71`, `gitDirty=false`, running with
  restart count zero. The state bind is guest-local ext4; `broker-state` is
  0700/root and its databases, sidecars, and generated key are 0600/root,
  without reading secret values. Public TLS for `lecar.gotdns.org` validated;
  login UI returned 200; missing and invalid beat tokens returned 401; a
  short-lived token generated inside live MS07 passed the CH09 central gate
  with 200. MS07 remained on `broker-introspection-4dc088e`, running with zero
  restarts. At that checkpoint, pool 10/0/0, two real logins, and
  restart/recreation durability remained unverified; no rollback occurred.
- 2026-10-13 authorized human runtime acceptance: credentials supplied by the
  user were held only in process environment for stdin-fed probes and were not
  printed, persisted, or added to the tracker. Both `guillermo.negrete` and
  `diego.zacur` returned login 200, a secure session cookie, session 200 with
  the expected username, protected pool 200, and logout 200. The pool reported
  `ready=10`, `warming=0`, `error=0`, with backend A ready=5 and backend B
  ready=5. Restart/recreation durability remains the final unverified T10
  runtime gate.
- 2026-10-13 authorized recreation durability: during scheduled downtime, one
  `docker compose up -d --no-deps --force-recreate --pull never broker` was run
  on Lecar `ges01`, limited to `ch09-brk`. The active authenticated session
  survived; the service-key identity and session/timing database inodes were
  unchanged; Compose bytes and Watchtower identity were unchanged; the new
  container used the same expected image with restart count zero. The first
  post-recreation pool check reached 9 ready and 1 error because slot 2 warmup
  returned HTTP 500. No rollback was performed. Before any manual recycle, a
  later protected pool read returned 10/0/0 with A=5/B=5, so no additional
  mutation was made. The source's five-minute ping recycle is consistent with
  automatic recovery, but the cause was not proven from correlated runtime
  events. Independent read-only verification confirmed the current image,
  running/restart state, Compose hash, guest-local ext4 backing, private state,
  and healthy Watchtower; historical Watchtower identity comparison remained
  parent-observed because the verifier lacked the prior exact values.
- 2026-10-13 user authorization: "Si si" authorized validating the two remaining
  T10 points: live routed CA04/CA05 traffic and certificate-renewal evidence.
  Read-only Lecar inspection found no CA04/CA05 containers and the protected
  durable timing store contained zero records, so no client traversal can be
  attributed. The certificate file currently mounted read-only into CH09
  exactly matches the certificate served by its HTTPS listener and is valid
  from 2026-10-10 through 2027-01-08. Certbot is running with zero restarts and
  a periodic `certbot renew` command, but no renewal hook exists. Source
  inspection confirms CH09 loads TLS credentials only at process startup, so a
  future renewal would not be consumed until a separate restart. T15 tracks
  the authorized correction; no certificate, container, Compose, or Watchtower
  mutation occurred during validation.
- 2026-10-13 T15 implementation: added a one-minute TLS credential watcher that
  applies changed certificate/key bytes through the running HTTPS server's
  secure context. A partial or invalid pair leaves the last valid context
  active and is retried later; logs contain only the error class. The focused
  test first failed because the module did not exist, then passed. TypeScript,
  focused TLS/proxy tests (19/19), the full suite (113 pass, one Windows skip),
  Docker build, and an isolated real HTTPS certificate-rotation smoke passed.
  The smoke confirmed the process kept serving the prior certificate during a
  partial renewal and served the complete replacement without restart. No
  production certificate, container, Compose, or Watchtower state was changed.
- 2026-10-13 T15 independent verification: candidate `7c0cdc7` against baseline
  `ddda15e` passed TypeScript, focused TLS/proxy tests 19/19, full suite 113
  pass with one platform-specific skip, diff checks, Docker build, and a fresh
  real HTTPS rotation probe. Missing, malformed, and partial replacement keys
  preserved the last valid certificate; a complete matching pair became active
  on the same process, listener, and port. Captured messages contained only
  generic status or error-class text. The verifier made no workspace or remote
  changes. Production Certbot renewal remains a separate runtime observation.
