## Description

<!-- What does this PR do? Why is it needed? -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Configuration change
- [ ] Documentation update
- [ ] Refactoring (no functional change)
- [ ] CI/CD update

## Kernel boundary

<!--
This repo is the GOVERNANCE KERNEL. Feature-module code (finance, elections,
newsletter, …) belongs in gremion-modules, not here. Consumers pin this repo as
a SHA-pinned git submodule, so anything below is a downstream break.
-->

- [ ] No feature-module vocabulary added to kernel code (`gremion-ui/src/lib/auth`, `.../lib/server`)
- [ ] No instance name, institution name, or domain hardcoded — unconfigured renders nothing
- [ ] `pnpm -C gremion-ui exec tsx scripts/boundary-lint.ts --all` clean
- [ ] Contract change? `boundary-lint.ts --contracts` clean and the OpenAPI/AsyncAPI doc updated
- [ ] Public API / env var / migration change called out under **Notes for Reviewers**

## Provenance

<!--
Inbound = outbound, DCO not CLA. `git commit -s` adds the trailer;
`git rebase --signoff <base>` adds it to commits already made.

What is CHECKED: the `DCO sign-off (external pull requests)` job walks every
commit in a pull request whose branch comes from another repository — a fork.
That is where the certification matters, because the contributor is not the
copyright holder.

What is NOT checked: a pull request from a branch inside this repository. Only
maintainers can push those, and no job judges them — CONTRIBUTING.md asks you
to sign off anyway. Please tick the box honestly rather than relying on CI to
catch it.
-->

- [ ] All commits signed off (`git commit -s`) — see CONTRIBUTING.md

## Testing

- [ ] `make lint` — no errors (shellcheck, yamllint, JSON, compose config, kernel hygiene)
- [ ] `make test` — BATS infra tests pass
- [ ] `pnpm -C gremion-ui test:unit` — passes
- [ ] `pnpm -C gremion-public test` — passes
- [ ] `pnpm -C gremion-ui check` and `pnpm -C gremion-public check` — clean
- [ ] Integration tests pass (`make test-integration`) — requires a running stack
- [ ] `kubectl kustomize k8s/base` still renders with no flags (if `k8s/` touched)

## Guards

<!-- The dominant failure class in this repo is guards that LIE. -->

- [ ] Every behavioural change has a guard asserting the POST-CONDITION, never an exit code
- [ ] I ran the new guard against the UNFIXED code and watched it fail

## Security Checklist

- [ ] No secrets or credentials committed
- [ ] `.env` not committed (only `.env.example` if changed)
- [ ] Input validation preserved for all scripts
- [ ] No hardcoded domain names added
- [ ] Container images pinned — no `:latest`, no untagged image

## Related Issues

<!-- Closes #123 -->

## Notes for Reviewers

<!-- Anything specific to look at, known limitations, follow-up work -->
