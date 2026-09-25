# TASK-045 (brief S4): the container `verify`'s unit suite uses to run
# test/*.bats + test/host/*.bats on a Windows dev box, where the npm bats
# shim rejects the C:/ path the recipe's own shell reports as its cwd (see
# the Makefile's test-host-docker comment) and native bats runs about 200x
# slower even when it does start.
#
# Built FROM gremion-bats:local (test/host/runner/Dockerfile, the same image
# `make test-host-docker` builds) plus python3, because the KERNEL suite
# under test/*.bats needs it too (test/configure-keycloak.bats validates
# realm-export.base.json with `python3 -m json.tool`) -- test/host/runner's
# own image only ever needed to satisfy test/host/*.bats, which does not.
#
# Based on the vault's session-2026-09-15-spec-b-d/plan/tooling/
# Dockerfile.bats-py (brief S4), which added only python3. yamllint is added
# here too: without it, test/host/deploy-workflow.bats's own
# `command -v yamllint >/dev/null || skip "yamllint not installed (CI
# installs it)"` self-skips one test every run through this image (found by
# actually running the suite through it -- 813 collected, 1 skipped, before
# this line existed). CI installs yamllint separately and so never sees that
# skip; the guard is only genuinely fail-closed here if this image doesn't
# need it to skip either.
#
# Run against a REAL CLONE, never this worktree: a linked worktree's .git is
# a FILE whose gitdir line is a host-absolute path the container cannot
# resolve (the same constraint test-host-docker's own comment states) --
# suites/unit.mjs clones to a scratch temp directory before mounting it in.
FROM gremion-bats:local
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && pip install --no-cache-dir --break-system-packages yamllint \
 && rm -rf /var/lib/apt/lists/* \
 && python3 --version \
 && yamllint --version
