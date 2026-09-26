#!/usr/bin/env bash
# Live mount-refusal + TRD-067 concurrency proof for @gremion/storage.
#
# Builds the package, bakes dist/ into a node:26-alpine image, then runs the
# SAME container twice:
#   1. WITHOUT a volume at the storage root  -> must exit non-zero with
#      "storage(local): /data/storage is not a mount point"
#   2. WITH a named volume at the storage root -> must exit 0 and pass the
#      concurrent two-tenant write check (scripts/mount-proof.mjs).
# Plain `docker build` / `docker run`, names unique to this run, torn down BY
# NAME (docker rm -f / docker volume rm / docker rmi). Never compose, never prune.
#
# Usage (from the repo root):  bash packages/storage/scripts/mount-proof.sh
set -euo pipefail

PKG="$(cd "$(dirname "$0")/.." && pwd)"
# T117_SHA overrides the name suffix where git is unavailable.
SHA="${T117_SHA:-$(git -C "$PKG" rev-parse --short HEAD)}"
IMAGE="t117-storage-proof:${SHA}"
CONTAINER="t117-mount-${SHA}"
VOLUME="t117-root-${SHA}"
ROOT_IN_CONTAINER=/data/storage

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

pnpm --dir "$PKG" build >/dev/null
docker build -q -t "$IMAGE" -f - "$PKG" >/dev/null <<'DOCKERFILE'
FROM node:26-alpine
WORKDIR /pkg
COPY package.json ./
COPY dist ./dist
COPY scripts/mount-proof.mjs ./scripts/
# The root exists as a plain directory on the container layer: exactly the
# case a stat() cannot tell from a mounted volume.
RUN mkdir -p /data/storage
CMD ["node", "scripts/mount-proof.mjs"]
DOCKERFILE

echo "== run 1: no volume at ${ROOT_IN_CONTAINER} (must be refused)"
set +e
out1="$(docker run --name "$CONTAINER" -e STORAGE_ROOT="$ROOT_IN_CONTAINER" "$IMAGE" 2>&1)"
code1=$?
set -e
docker rm -f "$CONTAINER" >/dev/null
echo "$out1"
echo "exit=$code1"
if [ "$code1" -eq 0 ] || ! grep -q "storage(local): ${ROOT_IN_CONTAINER} is not a mount point" <<<"$out1"; then
  echo "FAIL: the unmounted root was not refused" >&2
  exit 1
fi

echo "== run 2: named volume ${VOLUME} at ${ROOT_IN_CONTAINER} (must succeed)"
docker volume create "$VOLUME" >/dev/null
set +e
out2="$(docker run --name "$CONTAINER" -e STORAGE_ROOT="$ROOT_IN_CONTAINER" -v "${VOLUME}:${ROOT_IN_CONTAINER}" "$IMAGE" 2>&1)"
code2=$?
set -e
echo "$out2"
echo "exit=$code2"
if [ "$code2" -ne 0 ]; then
  echo "FAIL: the mounted root was refused or the concurrency check failed" >&2
  exit 1
fi
echo "PROOF OK: unmounted refused (exit $code1), mounted accepted + concurrent A/B writes distinct (exit 0)"
