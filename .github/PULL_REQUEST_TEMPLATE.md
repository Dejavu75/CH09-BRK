## Linked issue

Closes #<issue-number>

The linked issue must have the `status:approved` label before this PR is merged.

## PR type

Check exactly one and add its matching `type:*` label to the PR.

- [ ] Bug fix (`type:bug`)
- [ ] New feature (`type:feature`)
- [ ] Documentation only (`type:docs`)
- [ ] Code refactoring (`type:refactor`)
- [ ] Maintenance/tooling (`type:chore`)
- [ ] Breaking change (`type:breaking-change`)

## Summary

- Describe the purpose and outcome of this PR.

## Changes

| File | Change |
|------|--------|
| `path/to/file` | Describe the change. |

## Test plan

- [ ] Relevant automated tests pass.
- [ ] Affected behavior was verified manually, if applicable.
- [ ] Modified shell scripts pass `shellcheck`, if applicable.

## Contributor checklist

- [ ] Linked an issue labeled `status:approved`.
- [ ] Added exactly one matching `type:*` label.
- [ ] Ran `shellcheck` on modified scripts, or no shell scripts changed.
- [ ] Tested affected skills in at least one agent, or no skills changed.
- [ ] Updated documentation if behavior changed.
- [ ] Used a Conventional Commit message.
- [ ] Confirmed no `Co-Authored-By` trailer was added.
