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
- [ ] DEL-2: Create one conforming issue per work unit using the issue form; obtain protected `status:approved` labels through exact authorized workflow.
- [ ] DEL-3: Create and merge two under-400-line PRs to main after passing checks, and verify release publishes a new version and latest.
- [ ] DEL-4: Switch only Aries `ch09` runtime from immutable override to verified latest using base Compose, retain rollback, and verify pool and Watchtower.

## Acceptance and checks
- No CI/release for the bootstrap-only commit; forms visible on main and labels available.
- Issues and PRs meet repository skill policy, with links, type labels, and successful checks.
- Main contains both work units; release image digest and version are observed.
- Aries broker runs the published latest image; certbot and Watchtower are not restarted; rollback remains available.

## Progress
- Current main: 6b69dd5; current delivery branch: codex/broker-timings-payload at db56bc7. Local checkout has only pre-existing untracked .codegraph/.
- GitHub authenticated actor Dejavu75 has ADMIN permission; repository has no issues, PRs, type labels, or issue forms.
- Aries preflight: base Compose uses latest, active codex-aries-login-override.yaml pins codex-8fb8147; pool 10 ready, 0 errors, Watchtower active. No remote mutation yet.
- Bootstrap commit `04cf29c` added the YAML issue form and PR template to main with `[skip ci]`; GitHub read-back confirms the form exists, all seven required labels exist, and no CI/release run was created for `04cf29c` (last main runs remain at `6b69dd5`). Direct main bootstrap was needed because forms on feature branches are unavailable to new issues.
- Next step: bootstrap governance files and labels, then create issues; approval actions may require a separate explicit instruction with issue numbers.
