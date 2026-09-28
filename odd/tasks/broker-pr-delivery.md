# CH09-BRK PR delivery and Aries latest

## Objective
Deliver the pending login and timing work through reviewable PRs to main, publish a verified latest image, and move Aries broker runtime to the latest image.

## Scope and authorization
Diego authorized creating issue forms, labels, issues, PRs, merging all pending work to main, and using the local GitHub session and documented Aries SSH hop. Preserve other Aries services. Do not expose live secrets or dump timing JSON.

## Delivery
- Strategy: two stacked-to-main PRs; login work unit is about 100 changed lines, timing work unit about 313, vs 413 combined.
- Route: delegated direct for governance/bootstrap preparation and bounded remote work; parent coordinates authorization and delivery gates.
- TDD: no explicit project/session mode; run focused/full functional checks and CI.
- RDD: disabled by clone-local preference; no native review invocation.
- Issue/PR skill policy requires YAML issue form, approved linked issues, exactly one type label per PR, and passing CI. Existing repository has none. Bootstrap policy files to default branch with a conventional `[skip ci]` commit to avoid prematurely publishing latest; direct main bootstrap is necessary because GitHub reads issue forms from default branch.

## Tasks
- [x] DEL-1: Bootstrap issue and PR templates and required labels without publishing a new image; verify main and workflow state.
- [x] DEL-2: Create one conforming issue per work unit using the issue form; obtain protected `status:approved` labels through exact authorized workflow.
- [x] DEL-3: Create and merge two under-400-line PRs to main after passing checks, and verify release publishes a new version and latest.
- [x] DEL-4: Switch only Aries `ch09` runtime from immutable override to verified latest using base Compose, retain rollback, and verify pool and Watchtower.

## Acceptance and checks
- No CI/release for the bootstrap-only commit; forms visible on main and labels available.
- Issues and PRs meet repository skill policy, with links, type labels, and successful checks.
- Main contains both work units; release image digest and version are observed.
- Aries broker runs the published latest image; certbot and Watchtower are not restarted; rollback remains available.

## Progress
- Initial checkpoint: main was `6b69dd5` and the delivery branch was `codex/broker-timings-payload` at `db56bc7`.
- At the initial checkpoint, GitHub actor Dejavu75 had ADMIN permission and the repository had no issues, PRs, type labels, or issue forms.
- Aries preflight: base Compose uses latest, active codex-aries-login-override.yaml pins codex-8fb8147; pool 10 ready, 0 errors, Watchtower active. No remote mutation yet.
- Bootstrap commit `04cf29c` added the YAML issue form and PR template to main with `[skip ci]`; GitHub read-back confirms the form exists, all seven required labels exist, and no CI/release run was created for `04cf29c` (last main runs remain at `6b69dd5`). Direct main bootstrap was needed because forms on feature branches are unavailable to new issues.
- Created and read back [issue #1](https://github.com/Dejavu75/CH09-BRK/issues/1) for login token forwarding and [issue #2](https://github.com/Dejavu75/CH09-BRK/issues/2) for timing payloads using the published form. Both were initially OPEN and unlabeled.
- Diego explicitly authorized adding `status:approved` to issues #1 and #2; the authenticated GitHub actor had ADMIN permission and target-host identity evidence. Each protected-label mutation used validated empty-label pre-state, one add-only command, and exact post-readback; both were still OPEN with exactly `status:approved` at that checkpoint. Private readback files were removed.
- [PR #3](https://github.com/Dejavu75/CH09-BRK/pull/3) merged the login unit after its CI passed (merge commit `06ee5db`); [PR #4](https://github.com/Dejavu75/CH09-BRK/pull/4) merged the timing unit, 348 changed lines, after its CI passed (merge commit `a11bfae`). Each PR had an approved issue and exactly one type label.
- Push-triggered release for `a11bfae` did not appear; a manual workflow dispatch on that exact main commit succeeded (run `36473052089`). Docker Hub `1.0.13` and `latest` both resolve to `sha256:e2330f24b2fa57ac2810667a66c2340585ce76433177ad35b807f970798503ef`. No Aries change had been made at this checkpoint.
- First DEL-4 attempt on Aries: effective Compose variants differed only by image and `pull_policy: never`; dropping both was required to follow latest. Pulled the verified `latest` digest and recreated only `ch09` using base Compose. HTTP remained 200 but the pool stayed at 9 ready/1 error after more than 90 seconds, so the rollout failed acceptance. Recreated only `ch09` with the unchanged immutable override; pool recovered to 10 ready/0 error. Watchtower and Certbot IDs were unchanged, and no Compose or env file was edited. At that checkpoint latest was cached but not running, and DEL-4 remained open.
- Diego explicitly accepted a second Aries deployment even if the pool stayed at 9 ready/1 error. Sanitized prior failure evidence identified Mini slot S04M HTTP 500 because AGES returned neither `AGES_TOKEN` nor `ASP.NET_SessionId`; this did not prove whether Broker or upstream IIS caused the transient.
- Retried only `ch09` with base Compose and verified registry `latest` and `1.0.13` both at digest `sha256:e2330f24b2fa57ac2810667a66c2340585ce76433177ad35b807f970798503ef`. Running container uses `:latest` and the same image ID; config_files names only base Compose. Watchtower and Certbot IDs stayed unchanged, Watchtower still monitors the labeled broker, and local pool HTTP 200 reached 10 ready/0 warming/0 error, then remained 10/10/0/0 after another 60 seconds. Immutable override and old cached image remain available for rollback. The S04M error did not recur during this window; root cause remains unproven.
- Delivery is complete for the requested image/tag change. No real login credentials or timing payloads were read or printed; the separate Mini beat/BackGES incident is not certified resolved by pool health.
- Next step: monitor the distinct Mini beat/BackGES incident against real requests; pool readiness alone does not certify that incident resolved.
