# The Linux bats runner for the distribution-host suite (`make test-host-docker`).
#
# WHY IT EXISTS. The host suite asserts on real POSIX facts -- 0600/0700 modes,
# LF-only files, an executable bit, openssl, envsubst, jq. On a Windows
# development box none of those are answerable: NTFS reports every file 0755,
# `make test-unit` cannot start at all (the npm bats shim rejects the C:/ path
# the recipe's shell reports as its cwd), and a mode assertion would have to be
# skipped rather than run. This image is the local stand-in for the Debian host
# and the CI runner, so the mode and permission tests execute for real instead
# of skipping.
#
# It is NOT used by CI: ci.yml installs bats and its dependencies on
# ubuntu-latest directly and calls `make test-unit`. Pinning both the base image
# tag and the bats version keeps the local runner and CI on the same bats.
FROM node:22-bookworm-slim

# shellcheck        -- `make lint-sh` inside the container
# openssl           -- key/cert fixtures in the secrets and mail suites
# gettext-base      -- envsubst, the renderer's template engine
# jq                -- release.json / compose assertions
# git               -- the host-literal guard scans through `git grep`
# procps, dnsutils  -- pgrep and dig, shimmed by tests but probed for presence
# openssh-client    -- ssh/ssh-keygen fixtures
# rsync             -- the restore and deploy paths
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      shellcheck openssl gettext-base jq git ca-certificates procps \
      openssh-client dnsutils rsync \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g bats@1.13.0 \
 && bats --version

WORKDIR /wt
ENTRYPOINT ["bats"]
