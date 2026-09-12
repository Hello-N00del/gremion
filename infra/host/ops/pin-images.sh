#!/usr/bin/env bash
# Rewrite every `image: <ref>` without a digest in the given compose files to
# `<ref>@sha256:<digest>`. Third-party images in this distribution are pinned by
# digest and never auto-updated (spec A §K); the ops project's test refuses an
# unpinned reference, so this script is how a version bump lands.
#
# usage: pin-images.sh [FILE...]   (default: infra/host/ops/docker-compose.yml)
# exit 0 pinned · 1 resolver returned a malformed digest · 2 tool or tag missing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

need_cmd docker awk sed

# The digest of the reference AS PUBLISHED: for a multi-arch tag that is the
# index digest, which is what `image: ref@sha256:…` must carry so every
# architecture keeps resolving. `docker manifest inspect -v` reports it as
# .Descriptor.digest; `buildx imagetools inspect` reports the same value as
# .Manifest.Digest and needs no experimental flag, so it is tried first.
resolve() {
    local ref="$1" digest
    if ! digest="$(docker buildx imagetools inspect --format '{{ .Manifest.Digest }}' "$ref" 2>&1)"; then
        bad "cannot resolve ${ref}: ${digest}"
        bad "list the published tags with:"
        bad "  curl -s \"https://registry.hub.docker.com/v2/repositories/${ref%%:*}/tags?page_size=100\" | grep -o '\"name\":\"[^\"]*\"'"
        die "unresolved image reference: ${ref}" 2
    fi
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "resolver returned '${digest}' for ${ref}" 1
    printf '%s@%s\n' "$ref" "$digest"
}

pin_file() {
    local file="$1" ref pinned count=0 pinned_total
    [[ -f "$file" ]] || die "no such file: ${file}" 2
    while IFS= read -r ref; do
        [[ "$ref" == *"@sha256:"* ]] && continue
        pinned="$(resolve "$ref")"
        info "pinning ${ref}"
        sed -i "s|image: ${ref}\$|image: ${pinned}|" "$file"
        count=$((count + 1))
    done < <(awk '/^[[:space:]]+image:/ {print $2}' "$file")
    # grep -c prints 0 AND exits 1 when nothing matches, so the count is taken
    # with `|| true` and defaulted rather than through a second `echo`.
    pinned_total="$(grep -cE 'image: [^[:space:]]+@sha256:[0-9a-f]{64}$' "$file" || true)"
    ok "${file}: pinned ${count} reference(s), ${pinned_total:-0} now digest-pinned"
}

main() {
    local file
    if [[ $# -eq 0 ]]; then
        set -- "$SCRIPT_DIR/docker-compose.yml"
    fi
    for file in "$@"; do
        pin_file "$file"
    done
}

main "$@"
