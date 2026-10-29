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
#       --overlap true|false --dist-manifest <gremion.dist.json> [--first-release]
#
#   --overlap        release.json's `overlap` has no default (spec B F.6): the
#                    operator states whether the old colour can keep serving
#                    against the migrated schema.
#   --dist-manifest  the assembler manifest this release was cut from; its
#                    sha256 becomes release.json's distManifestDigest.
#   --first-release  this is the first dist-v* tag. Without it the script
#                    refuses when origin has no earlier dist tag, because
#                    release.json's `migrations` is the set the previous tag
#                    did not have: a missing tag would silently list every
#                    migration as new. With it, an existing dist tag refuses.
#
# STEPS
#   0. fetch origin's tags and main (the tag check, the previous tag and the
#      provenance check all read origin, not whatever this clone last saw);
#   1. judge the run (release-images.yml of this repository, succeeded, built
#      and dispatched from a commit that is on origin/main or a v* / rc-v* tag)
#      and download its release-pins-<sha> artefact (the pins layers);
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
# or not a readable file; a dirty working tree; origin unreachable; a tag that
# already exists (locally or on origin); no previous dist tag without
# --first-release, or one with it; a run of any other workflow, from a fork, or
# that did not succeed; a built or dispatching commit that is neither on
# origin/main nor the commit of a v* / rc-v* tag; an artefact that is not
# exactly one release-pins-<40 hex>; a pins layer that is not EXACTLY what
# emit-pins.mjs writes (a services: map, each service a `build: !reset null`
# and an `image:` that is a first-party `<name>@sha256:<64 hex>`, nothing else) or
# that check-pins.mjs refuses for the built commit.
#
# CREDENTIALS. COSIGN_KEY_PATH and COSIGN_PASSWORD are taken off the
# environment as soon as they are read: gh, git, node, make verify and the
# lint run without them, and only sign-release.sh gets them back.
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
    printf 'usage: cut-dist-tag.sh <X.Y.Z> --run-id <id> --overlap true|false --dist-manifest <file> [--first-release]\n' >&2
    exit 2
}
cleanup() { if [[ -n "$WORK" ]]; then rm -rf -- "$WORK"; fi; }

# layer_problem <file> -- prints the first reason a pins layer is not exactly
# the shape emit-pins.mjs writes, nothing when it is. The layer comes out of a
# CI run, so it is parsed line by line, not trusted: a `volumes:`, `command:` or
# `privileged:` key under a service would otherwise ride into the release
# commit that gets signed.
layer_problem() {
    local file="$1" line ref state=top n=0 svc="" seen=" "
    local service_re='^  ([A-Za-z0-9][A-Za-z0-9_.-]*):$'
    local image_re='^    image: (.*)$'
    local ref_re='^ghcr\.io/hello-n00del/[a-z0-9._-]+@sha256:[0-9a-f]{64}$'
    while IFS= read -r line || [[ -n "$line" ]]; do
        n=$((n + 1))
        # full-line comments only (emit-pins.mjs writes a two-line header)
        if [[ "$line" == '#'* ]]; then continue; fi
        case "$state" in
            top)
                [[ "$line" == 'services:' ]] || { printf '%s:%d: expected "services:", got: %s' "$file" "$n" "$line"; return; }
                state=service ;;
            service)
                if [[ ! "$line" =~ $service_re ]]; then
                    printf '%s:%d: expected a service name at two-space indent, got: %s' "$file" "$n" "$line"; return
                fi
                svc="${BASH_REMATCH[1]}"
                if [[ "$seen" == *" $svc "* ]]; then printf '%s:%d: service %s is pinned twice' "$file" "$n" "$svc"; return; fi
                seen+="$svc "
                state=build ;;
            build)
                [[ "$line" == '    build: !reset null' ]] || { printf '%s:%d: service %s: expected "build: !reset null", got: %s' "$file" "$n" "$svc" "$line"; return; }
                state=image ;;
            image)
                if [[ ! "$line" =~ $image_re ]]; then
                    printf '%s:%d: service %s: expected an image: line, got: %s' "$file" "$n" "$svc" "$line"; return
                fi
                ref="${BASH_REMATCH[1]}"
                if [[ ! "$ref" =~ $ref_re ]]; then
                    printf 'not a first-party digest reference: %s' "$ref"; return
                fi
                state=service ;;
        esac
    done < "$file"
    # `service` is the resting state: top means no services: key, build/image a
    # service cut off half way, and an empty seen-list a layer pinning nothing.
    [[ "$state" == service && "$seen" != " " ]] || printf '%s: no services, or a service cut off after %s' "$file" "${svc:-the header}"
}

# reviewed_commit <sha> -- is <sha> a commit that reached review: on origin/main
# (as just fetched) or the commit of a v* / rc-v* tag? The release-images
# workflow can be dispatched on any ref, so the run id alone proves nothing
# about WHAT was built.
reviewed_commit() {
    local sha="$1"
    if git merge-base --is-ancestor "$sha" refs/remotes/origin/main 2>/dev/null; then return 0; fi
    [[ -n "$(git tag --points-at "$sha" 'v*' 'rc-v*')" ]]
}

main() {
    local version="" run_id="" overlap="" manifest="" first_release=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --run-id) [[ $# -ge 2 ]] || usage; run_id="$2"; shift 2 ;;
            --overlap) [[ $# -ge 2 ]] || usage; overlap="$2"; shift 2 ;;
            --dist-manifest) [[ $# -ge 2 ]] || usage; manifest="$2"; shift 2 ;;
            --first-release) first_release=1; shift ;;
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

    # Only sign-release.sh needs the key and its password. Everything else this
    # script starts (gh, git, node, make verify, the lint) is project code at
    # the built commit, so neither stays in the environment it inherits.
    local sign_key="$COSIGN_KEY_PATH" sign_password="" sign_password_set=0
    if [[ -v COSIGN_PASSWORD ]]; then
        sign_password="$COSIGN_PASSWORD"
        sign_password_set=1
    fi
    unset COSIGN_KEY_PATH COSIGN_PASSWORD

    local root status tag prev_tag
    root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)" || die "not inside a git checkout"
    tag="dist-v${version}"
    # Captured first: inside [[ -z "$(...)" ]] a failing `git status` would read as clean.
    status="$(git -C "$root" status --porcelain)" || die "git status failed"
    [[ -z "$status" ]] || die "working tree is not clean -- the release commit must be exactly the built sha plus the pins"
    cd "$root"

    # Origin is the record of what has been released, not this clone's tag
    # list: a dist tag cut from another workstation is not here until fetched.
    git fetch --quiet --tags origin '+refs/heads/main:refs/remotes/origin/main' || die "cannot fetch tags and main from origin"
    if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
        die "tag ${tag} already exists"
    fi
    prev_tag="$(git tag --list 'dist-v*' --sort=-v:refname | head -n 1)"
    if [[ -z "$prev_tag" && "$first_release" -eq 0 ]]; then
        die "origin has no dist-v* tag: pass --first-release if ${tag} is the first, otherwise something is wrong with the fetch"
    fi
    if [[ -n "$prev_tag" && "$first_release" -eq 1 ]]; then
        die "--first-release, but ${prev_tag} already exists"
    fi

    WORK="$(mktemp -d)"
    trap cleanup EXIT

    # 1. the run's pins artefact. The sha is read off the artefact's own name,
    # not off the run's headSha: a workflow_dispatch builds `release_ref`,
    # which need not be the commit the workflow file was dispatched from.
    # The run id is operator input, so the run is judged before anything it
    # names is trusted: which workflow, whose repository, how it ended. (Null
    # fields print as "none" so a tab-separated read cannot shift.)
    local run_info run_path conclusion head_sha head_repo run_repo names sha
    run_info="$(gh api "repos/{owner}/{repo}/actions/runs/${run_id}" \
        --jq '[.path // "none", .conclusion // "none", .head_sha // "none", .head_repository.full_name // "none", .repository.full_name // "none"] | @tsv')" \
        || die "gh cannot read run ${run_id}"
    IFS=$'\t' read -r run_path conclusion head_sha head_repo run_repo <<< "$run_info"
    [[ "$run_path" =~ ^\.github/workflows/release-images\.yml(@.*)?$ ]] || die "run ${run_id} is a run of ${run_path}, not of release-images.yml"
    [[ "$head_repo" == "$run_repo" ]] || die "run ${run_id} was dispatched from ${head_repo}, not from ${run_repo}"
    [[ "$conclusion" == success ]] || die "run ${run_id} did not succeed (conclusion: ${conclusion:-none})"
    names="$(gh api "repos/{owner}/{repo}/actions/runs/${run_id}/artifacts" --paginate --jq '.artifacts[].name | select(startswith("release-pins-"))')" \
        || die "gh cannot list the artefacts of run ${run_id}"
    [[ "$(printf '%s\n' "$names" | grep -c .)" -eq 1 ]] || die "run ${run_id} must carry exactly one release-pins-<sha> artefact, found: $(printf '%s' "$names" | tr '\n' ' ')"
    [[ "$names" =~ ^release-pins-[0-9a-f]{40}$ ]] || die "artefact name is not release-pins-<40 hex>: $names"
    sha="${names#release-pins-}"
    [[ "$sha" == "$head_sha" ]] || printf 'cut-dist-tag: note: the run was dispatched from %s but built %s (release_ref)\n' "$head_sha" "$sha" >&2

    # Both the commit the workflow definition came from and the commit it built
    # must have reached review: a run of an unmerged branch's copy of the
    # workflow, or of an unmerged branch's tree, is not a release.
    local c
    for c in "$sha" "$head_sha"; do
        git cat-file -e "${c}^{commit}" 2>/dev/null || git fetch --quiet origin "$c" || die "commit $c is not available locally or on origin"
        reviewed_commit "$c" || die "commit $c is neither on origin/main nor the commit of a v*/rc-v* tag"
    done
    gh run download "$run_id" -n "$names" -D "$WORK/pins" || die "cannot download ${names}"

    # The layers are judged before anything in the clone changes: the whole of
    # both must be the shape emit-pins.mjs writes, every image a first-party
    # digest reference.
    local layer problem refs=""
    for layer in docker-compose.pins.yml docker-compose.state-pins.yml; do
        [[ -f "$WORK/pins/$layer" ]] || die "the artefact has no $layer"
        problem="$(layer_problem "$WORK/pins/$layer")"
        [[ -z "$problem" ]] || die "$problem"
        refs+="$(sed -n 's/^    image: //p' "$WORK/pins/$layer")"$'\n'
    done
    refs="$(printf '%s' "$refs" | sed '/^$/d' | sort -u)"
    [[ -n "$refs" ]] || die "the pins layers pin no images"
    [[ "$(tr -d '[:space:]' < "$WORK/pins/release-sha.txt")" == "$sha" ]] || die "release-sha.txt disagrees with the artefact name"

    # 2. the release commit
    git checkout --quiet --detach "$sha"
    # The expected service set is derived from the built commit's own compose
    # files, so a layer that adds or drops a service is refused before it is
    # committed.
    node scripts/release/check-pins.mjs "$WORK/pins/docker-compose.pins.yml" --project app || die "the app pins layer is refused by check-pins"
    node scripts/release/check-pins.mjs "$WORK/pins/docker-compose.state-pins.yml" --project state || die "the state pins layer is refused by check-pins"
    cp "$WORK/pins/docker-compose.pins.yml" "$WORK/pins/docker-compose.state-pins.yml" .

    local digest cur prev migrations
    digest="sha256:$(sha256sum "$manifest" | cut -d' ' -f1)"
    cur="$(jq -c '[.chains[].files | keys[]] | unique' scripts/migrations/applied.lock.json)"
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
    # The one place the key and its password come back, for this child only.
    (
        if [[ "$sign_password_set" -eq 1 ]]; then export COSIGN_PASSWORD="$sign_password"; fi
        bash scripts/release/sign-release.sh --key "$sign_key" "${refs_arr[@]}"
    )

    # 5. the annotated, signed tag
    git -c gpg.format=ssh tag -s -a "$tag" -m "$tag"
    bash scripts/release/release-tag-check.sh "$tag"
    git push origin "$tag"

    printf 'cut-dist-tag: %s pushed (%d image(s) signed).\n' "$tag" "${#refs_arr[@]}"
    printf 'cut-dist-tag: the host-side deploy is a manual operator step; follow docs/ops/runbook/upgrade.md.\n'
    printf 'cut-dist-tag: this clone is on the detached release commit; check out a branch to continue working.\n'
}

main "$@"
