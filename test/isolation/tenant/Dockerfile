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
FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94

# node:26-alpine bundles no corepack (dropped from core in Node 25+); the pnpm
# version is the one the root package.json pins in packageManager, prepared here
# so the run does not fetch it. git: the clone and the verify dirty-tree checks.
RUN apk add --no-cache git \
 && npm install -g corepack \
 && corepack enable pnpm \
 && corepack prepare pnpm@10.33.0 --activate

# The run uses the host user's uid (the bind-mounted output directory is 0700 and
# owned by that user), which has no passwd entry here: HOME is passed with -e and
# /work is world-writable (sticky) for the clone and node_modules.
RUN mkdir /work && chmod 1777 /work
WORKDIR /work
