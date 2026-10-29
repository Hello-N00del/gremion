#!/usr/bin/env bash
#
# release-tag-check.sh -- prove a tag is a real release tag whose tree carries
# its release artefacts. Moved verbatim from the `release-tag-check` block of
# the retired .github/workflows/deploy.yml (the logic is unchanged; only the
# diagnostics' prefix now names this script, since no deploy workflow exists).
#
# USAGE   scripts/release/release-tag-check.sh dist-vX.Y.Z      (or TAG=dist-vX.Y.Z)
# Run from inside the clone that holds the tag; it reads refs/tags/<tag> only.
#
# A release tag is:
#   - named dist-vX.Y.Z,
#   - present in this repository and ANNOTATED (a lightweight tag is refused),
#   - carrying release.json and docker-compose.pins.yml at its tree root, and
#   - release.json names that same tag, has a boolean `overlap`, an array
#     `migrations` and a `distManifestDigest` of the form sha256:<64 hex>.
#
# EXIT CODES  0 valid release tag · 2 refused
set -euo pipefail

TAG="${1:-${TAG:-}}"
: "${TAG:?TAG is required (argument 1 or the TAG environment variable)}"
export TAG

if ! printf '%s' "$TAG" | grep -Eq '^dist-v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "release-tag-check: refusing '${TAG}' — a release tag is dist-vX.Y.Z" >&2
  exit 2
fi

if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "release-tag-check: tag '${TAG}' does not exist in this repository" >&2
  exit 2
fi

if [ "$(git cat-file -t "refs/tags/${TAG}")" != tag ]; then
  echo "release-tag-check: tag '${TAG}' is lightweight; a release tag is annotated" >&2
  exit 2
fi

for f in release.json docker-compose.pins.yml; do
  if ! git cat-file -e "refs/tags/${TAG}^{tree}:${f}" 2>/dev/null; then
    echo "release-tag-check: tag '${TAG}' does not carry ${f} at its tree root" >&2
    exit 2
  fi
done

rel="$(mktemp)"
trap 'rm -f "$rel"' EXIT
git cat-file blob "refs/tags/${TAG}^{tree}:release.json" > "$rel"

REL_FILE="$rel" node -e '
const fs = require("fs");
const tag = process.env.TAG;
const fail = (m) => { console.error("release-tag-check: " + m); process.exit(2); };
let r = null;
try { r = JSON.parse(fs.readFileSync(process.env.REL_FILE, "utf8")); }
catch (e) { fail("release.json does not parse: " + e.message); }
if (r.tag !== tag) fail("release.json names tag " + r.tag + ", tag is " + tag);
if (typeof r.overlap !== "boolean") fail("release.json has no explicit boolean overlap");
if (!Array.isArray(r.migrations)) fail("release.json migrations is not an array");
if (!/^sha256:[0-9a-f]{64}$/.test(String(r.distManifestDigest))) fail("release.json distManifestDigest is not a sha256 digest");
console.log("release-tag-check: " + tag + " overlap=" + r.overlap + " migrations=" + r.migrations.length);
'
