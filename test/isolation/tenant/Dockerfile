# test/isolation/tenant/Dockerfile -- the toolchain `gremion-isolation run` tests in.
#
# TOOLCHAIN ONLY, no repository content: node, corepack/pnpm and git. The release
# tree is mounted read-only at /src when the container runs; the program clones it
# (git clone --no-hardlinks, so an untracked file such as an in-tree secrets/
# directory is never copied in), checks the release tip out detached, installs
# with `pnpm install --frozen-lockfile` and runs
# `node scripts/verify/verify.mjs --only isolation:tenant` there.
#
# It is built from its own context (this directory, see Dockerfile.dockerignore):
# the root .dockerignore excludes scripts/ and test/, and nothing here needs them.
#
# The base is the kernel's own pin (services/kernel-api/Dockerfile): the tag names
# the version scripts/check-node-floor.mjs reads, the digest is the registry's
# multi-arch index of that tag.
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

# node:26-alpine bundles no corepack (dropped from core in Node 25+); the pnpm
# version is the one the root package.json pins in packageManager, prepared here
# so the run does not fetch it. The run is another uid with HOME=/tmp, so the
# prepared copy lives in a shared, world-readable COREPACK_HOME rather than under
# root's home. git: the clone and the verify dirty-tree checks.
ENV COREPACK_HOME=/opt/corepack
RUN apk add --no-cache git \
 && npm install -g corepack \
 && corepack enable pnpm \
 && corepack prepare pnpm@10.33.0 --activate \
 && chmod -R a+rX /opt/corepack

# The run uses the host user's uid (the bind-mounted output directory is 0700 and
# owned by that user), which has no passwd entry here: HOME is passed with -e and
# /work is world-writable (sticky) for the clone and node_modules.
RUN mkdir /work && chmod 1777 /work
WORKDIR /work
