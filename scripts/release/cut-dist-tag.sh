#!/usr/bin/env bash
#
# cut-dist-tag.sh -- turn a release-images run into a signed dist-vX.Y.Z tag.
# OPERATOR WORKSTATION ONLY. It needs the cosign key and the operator's tag
# signing key, neither of which CI ever holds (TRD-364): release-images.yml
# pushes the images and emits the pins, this script does everything that needs
# a key.
#
# USAGE
#   COSIGN_KEY_PATH=<cosign.key> COSIGN_PASSWORD=... \
#     scripts/release/cut-dist-tag.sh <X.Y.Z> --run-id <release-images run id> \
#       --overlap true|false --dist-manifest <gremion.dist.json>
#
#   --overlap        release.json's `overlap` has no default (spec B F.6): the
#                    operator states whether the old colour can keep serving
#                    against the migrated schema.
#   --dist-manifest  the assembler manifest this release was cut from; its
#                    sha256 becomes release.json's distManifestDigest.
#
# STEPS
#   1. download the run's release-pins-<sha> artefact (the pins layers);
#   2. check <sha> out detached, put the two pins layers and a release.json at
#      the repository root, lint them (lint-release.sh) and commit them: the
#      release commit;
#   3. make verify, then check-record.mjs (strict, no flags) on that commit;
#   4. sign and attest every pinned digest with the key at COSIGN_KEY_PATH
#      (sign-release.sh);
#   5. create the signed annotated tag dist-vX.Y.Z on the release commit,
#      run release-tag-check.sh on it and push the tag.
#
# REFUSALS (nothing is changed unless noted): a bad version or a missing
# argument; a missing gh, cosign, git, jq, node or make; COSIGN_KEY_PATH unset
# or not a readable file; a dirty working tree; a tag that already exists; a
# run that did not succeed; an artefact that is not exactly one
# release-pins-<40 hex>; a pins layer holding any image that is not
# `@sha256:<64 hex>`.
#
# THE HOST-SIDE DEPLOY IS NOT DONE HERE. Handing a registry token to the host
# is a manual operator step (docs/ops/runbook/upgrade.md); this script ends at
# the pushed tag.
#
# EXIT CODES  0 tag pushed · 1 refused/failed · 2 usage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK=""

die() { printf 'cut-dist-tag: %s\n' "$1" >&2; exit "${2:-1}"; }
usage() {
    printf 'usage: cut-dist-tag.sh <X.Y.Z> --run-id <id> --overlap true|false --dist-manifest <file>\n' >&2
    exit 2
}
cleanup() { if [[ -n "$WORK" ]]; then rm -rf -- "$WORK"; fi; }

main() {
    local version="" run_id="" overlap="" manifest=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --run-id) [[ $# -ge 2 ]] || usage; run_id="$2"; shift 2 ;;
            --overlap) [[ $# -ge 2 ]] || usage; overlap="$2"; shift 2 ;;
            --dist-manifest) [[ $# -ge 2 ]] || usage; manifest="$2"; shift 2 ;;
            -h|--help) usage ;;
            -*) usage ;;
            *) [[ -z "$version" ]] || usage; version="$1"; shift ;;
        esac
    done
    [[ -n "$version" && -n "$run_id" && -n "$overlap" && -n "$manifest" ]] || usage
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a version (X.Y.Z): $version" 2
    [[ "$run_id" =~ ^[0-9]+$ ]] || die "--run-id is not a run id: $run_id" 2
    [[ "$overlap" == true || "$overlap" == false ]] || die "--overlap must be true or false, got: $overlap" 2

    local tool
    for tool in gh cosign git jq node make; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool not on PATH"
    done
    [[ -n "${COSIGN_KEY_PATH:-}" ]] || die "COSIGN_KEY_PATH is not set (the cosign key lives in the operator vault)"
    [[ -f "$COSIGN_KEY_PATH" && -r "$COSIGN_KEY_PATH" ]] || die "COSIGN_KEY_PATH is not a readable file: $COSIGN_KEY_PATH"
    [[ -f "$manifest" && -r "$manifest" ]] || die "--dist-manifest is not a readable file: $manifest"

    local root status tag
    root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)" || die "not inside a git checkout"
    tag="dist-v${version}"
    # Captured first: inside [[ -z "$(...)" ]] a failing `git status` would read as clean.
    status="$(git -C "$root" status --porcelain)" || die "git status failed"
    [[ -z "$status" ]] || die "working tree is not clean -- the release commit must be exactly the built sha plus the pins"
    if git -C "$root" rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
        die "tag ${tag} already exists"
    fi
    cd "$root"

    WORK="$(mktemp -d)"
    trap cleanup EXIT

    # 1. the run's pins artefact. The sha is read off the artefact's own name,
    # not off the run's headSha: a workflow_dispatch builds `release_ref`,
    # which need not be the commit the workflow file was dispatched from.
    local conclusion head_sha names sha
    conclusion="$(gh run view "$run_id" --json conclusion --jq '.conclusion')" || die "gh cannot read run ${run_id}"
    [[ "$conclusion" == success ]] || die "run ${run_id} did not succeed (conclusion: ${conclusion:-none})"
    head_sha="$(gh run view "$run_id" --json headSha --jq '.headSha')" || die "gh cannot read run ${run_id}"
    names="$(gh api "repos/{owner}/{repo}/actions/runs/${run_id}/artifacts" --paginate --jq '.artifacts[].name | select(startswith("release-pins-"))')" \
        || die "gh cannot list the artefacts of run ${run_id}"
    [[ "$(printf '%s\n' "$names" | grep -c .)" -eq 1 ]] || die "run ${run_id} must carry exactly one release-pins-<sha> artefact, found: $(printf '%s' "$names" | tr '\n' ' ')"
    [[ "$names" =~ ^release-pins-[0-9a-f]{40}$ ]] || die "artefact name is not release-pins-<40 hex>: $names"
    sha="${names#release-pins-}"
    [[ "$sha" == "$head_sha" ]] || printf 'cut-dist-tag: note: the run was dispatched from %s but built %s (release_ref)\n' "$head_sha" "$sha" >&2
    gh run download "$run_id" -n "$names" -D "$WORK/pins" || die "cannot download ${names}"

    # The layers are judged before anything in the clone changes: every image
    # of both must be a first-party digest reference.
    local layer refs=""
    for layer in docker-compose.pins.yml docker-compose.state-pins.yml; do
        [[ -f "$WORK/pins/$layer" ]] || die "the artefact has no $layer"
        refs+="$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$WORK/pins/$layer")"$'\n'
    done
    refs="$(printf '%s' "$refs" | sed '/^$/d' | sort -u)"
    [[ -n "$refs" ]] || die "the pins layers pin no images"
    local ref
    while IFS= read -r ref; do
        [[ "$ref" =~ ^ghcr\.io/hello-n00del/[a-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] || die "not a first-party digest reference: $ref"
    done <<< "$refs"
    [[ "$(tr -d '[:space:]' < "$WORK/pins/release-sha.txt")" == "$sha" ]] || die "release-sha.txt disagrees with the artefact name"

    # 2. the release commit
    git cat-file -e "${sha}^{commit}" 2>/dev/null || git fetch --quiet origin "$sha" || die "commit $sha is not available locally or on origin"
    git checkout --quiet --detach "$sha"
    cp "$WORK/pins/docker-compose.pins.yml" "$WORK/pins/docker-compose.state-pins.yml" .

    local digest cur prev prev_tag migrations
    digest="sha256:$(sha256sum "$manifest" | cut -d' ' -f1)"
    cur="$(jq -c '[.chains[].files | keys[]] | unique' scripts/migrations/applied.lock.json)"
    prev_tag="$(git tag --list 'dist-v*' --sort=-v:refname | head -n 1)"
    prev='[]'
    if [[ -n "$prev_tag" ]]; then
        prev="$(git show "${prev_tag}:scripts/migrations/applied.lock.json" | jq -c '[.chains[].files | keys[]] | unique')"
    fi
    migrations="$(jq -nc --argjson cur "$cur" --argjson prev "$prev" '$cur - $prev')"
    jq -n --arg tag "$tag" --argjson overlap "$overlap" --argjson migrations "$migrations" --arg digest "$digest" \
        '{tag: $tag, overlap: $overlap, migrations: $migrations, distManifestDigest: $digest}' > release.json

    bash scripts/release/lint-release.sh .
    # The pins layers are ignored at the root of main on purpose (they are
    # release outputs); the release commit is the one place they are tracked.
    git add -f release.json docker-compose.pins.yml docker-compose.state-pins.yml
    git commit -s -m "release: ${tag}" -m "Pins for the images built by release-images run ${run_id} at ${sha}."

    # 3. the gate, on the release commit itself
    make verify
    node scripts/verify/check-record.mjs

    # 4. sign and attest every pinned digest, by digest only
    local -a refs_arr
    mapfile -t refs_arr <<< "$refs"
    bash scripts/release/sign-release.sh --key "$COSIGN_KEY_PATH" "${refs_arr[@]}"

    # 5. the annotated, signed tag
    git -c gpg.format=ssh tag -s -a "$tag" -m "$tag"
    bash scripts/release/release-tag-check.sh "$tag"
    git push origin "$tag"

    printf 'cut-dist-tag: %s pushed (%d image(s) signed).\n' "$tag" "${#refs_arr[@]}"
    printf 'cut-dist-tag: the host-side deploy is a manual operator step; follow docs/ops/runbook/upgrade.md.\n'
    printf 'cut-dist-tag: this clone is on the detached release commit; check out a branch to continue working.\n'
}

main "$@"
