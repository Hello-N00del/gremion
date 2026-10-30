#!/usr/bin/env bash
#
# cut-dist-tag.sh -- turn a release-images run into a signed dist-vX.Y.Z tag.
# OPERATOR WORKSTATION ONLY. It needs the cosign key and the operator's tag
# signing key, neither of which CI ever holds (TRD-364): release-images.yml
# pushes the images and emits the pins, this script does everything that needs
# a key.
#
# USAGE
#   COSIGN_KEY_PATH=<cosign.key> COSIGN_PASSWORD_FILE=<password file> \
#     scripts/release/cut-dist-tag.sh <X.Y.Z> --run-id <release-images run id> \
#       --overlap true|false --dist-manifest <gremion.dist.json> [--first-release]
#
#   The key's password comes from the file named by COSIGN_PASSWORD_FILE, and
#   only from there: never from COSIGN_PASSWORD (see CREDENTIALS), and never
#   from a prompt. sign-release.sh runs cosign once per image and step with its
#   stderr captured, so a cosign prompt could be neither seen nor answered.
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
#   0. fetch origin's tags and main, and list origin's tags (git ls-remote):
#      the tag check, the previous tag and the provenance check read that
#      list, not this clone's tags, which keep whatever a failed run left;
#   1. judge the run (release-images.yml of this repository, succeeded, built
#      and dispatched from a commit that is on origin/main or a v* / rc-v* tag)
#      and download its release-pins-<sha> artefact (the pins layers);
#   2. check <sha> out detached, put the two pins layers and a release.json at
#      the repository root, lint them (lint-release.sh) and commit them: the
#      release commit;
#   3. make verify, then check-record.mjs (strict, no flags) on that commit;
#   4. sign and attest every pinned digest with the key at COSIGN_KEY_PATH
#      (the sign-release.sh that sat next to this script at start-up, not the
#      built commit's copy);
#   5. create the signed annotated tag dist-vX.Y.Z on the release commit,
#      run release-tag-check.sh on it and push the tag.
#
# REFUSALS (nothing is changed unless noted): COSIGN_PASSWORD in the
# environment; a bad version or a missing argument; a missing gh, cosign, git,
# jq, node or make; COSIGN_KEY_PATH unset or not a readable file;
# COSIGN_PASSWORD_FILE unset or not a readable file; a dirty working tree;
# origin unreachable; a tag that already exists on origin, or only in this
# clone (a failed run's leftover), or in both with different targets (the
# fetch of origin's tags refuses to overwrite a clone tag, for any tag name,
# not only the one being cut). The refusal names the tag, where it exists
# and the exact git commands to inspect and to remove it; nothing is deleted
# for you; no previous dist tag without
# --first-release, or one with it; a run of any other workflow, from a fork, or
# that did not succeed; a built or dispatching commit that is neither on
# origin/main nor the commit of a v* / rc-v* tag; an artefact that is not
# exactly one release-pins-<40 hex>; a pins layer that is not EXACTLY what
# emit-pins.mjs writes (a services: map, each service a `build: !reset null`
# and an `image:` that is a first-party `<name>@sha256:<64 hex>`, nothing else) or
# that check-pins.mjs refuses for the built commit.
#
# CREDENTIALS. What is and is not protected, plainly. gh, git, node, make
# verify and the lint run project code at the built commit. The control that
# keeps unreviewed code out of this session is the provenance check (step 1: a
# release-images.yml run of this repository, built and dispatched from a commit
# on origin/main or a v* / rc-v* tag), nothing below it. What the handling
# below does is narrower: it keeps the secrets out of those children's
# ENVIRONMENTS.
#   - The password is never in this script's environment at all, because an
#     `unset` leaves the environment the script was started with readable at
#     /proc/<pid>/environ; the script refuses to start when COSIGN_PASSWORD is.
#     It comes from COSIGN_PASSWORD_FILE (a path is no secret; the content is
#     read inside the signing subshell and exported to the signer alone).
#   - COSIGN_KEY_PATH and COSIGN_PASSWORD_FILE are paths too: the first is
#     handed over by --key, both are taken off the environment once read.
#   - The signer is the sign-release.sh that sat next to this script at
#     start-up, copied (mode 0500) into this script's private temp directory
#     before the detached checkout; the built commit's own copy never runs.
# What it does NOT do: stop code running as the same user during `make verify`
# from reaching key material on disk (the key file, the password file, and the
# /proc entries of the signer while it runs). The workstation must be trusted.
# The follow-up is to run `make verify` in an isolated container or as a
# separate user.
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

# clobbering_tags -- the names of tags that are in this clone AND on origin but
# name different objects. `git fetch --tags` refuses to overwrite a local tag,
# fails as a whole and (under --quiet) prints nothing, so those names are found
# here, by comparing what origin lists with what this clone has.
clobbering_tags() {
    local listing sha ref name here
    listing="$(git ls-remote --tags origin)" || return 0
    while read -r sha ref; do
        [[ "$ref" == refs/tags/* && "$ref" != *'^{}' ]] || continue
        name="${ref#refs/tags/}"
        here="$(git rev-parse -q --verify "refs/tags/${name}" 2>/dev/null)" || continue
        if [[ "$here" != "$sha" ]]; then printf '%s\n' "$name"; fi
    done <<< "$listing"
}

# fetch_failed <git's output> -- the fetch of origin's tags and main failed.
# The usual cause is a tag of this clone that differs from origin's tag of the
# same name: say which, where, and how to look at it and clear it. Nothing is
# deleted for the operator: origin's tag is the record, this clone's the suspect.
fetch_failed() {
    local names name msg=""
    names="$(clobbering_tags)"
    while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        msg+="tag ${name} exists in this clone AND on origin, and the two are different tags; git fetch will not overwrite a local tag. Inspect this clone's: git show ${name}; inspect origin's: git ls-remote --tags origin refs/tags/${name}. Origin's is the record. If this clone's is a leftover of a failed run, remove it yourself with: git tag -d ${name}; then run again. "
    done <<< "$names"
    if [[ -n "$msg" ]]; then die "fetching origin's tags was refused. ${msg%' '}"; fi
    die "cannot fetch tags and main from origin: ${1:-git fetch printed nothing}"
}

# ORIGIN_TAGS holds "<commit> <tag name>" per tag on origin, read once by
# git ls-remote (annotated tags peeled to their commit). This clone's own tags
# are not the record: a tag a failed run created and never pushed stays here
# after any fetch, and must count neither as released nor as provenance.
ORIGIN_TAGS=""
read_origin_tags() {
    local listing sha ref name
    listing="$(git ls-remote --tags origin)" || return 1
    ORIGIN_TAGS="$(
        while read -r sha ref; do
            [[ "$ref" == refs/tags/* ]] || continue
            name="${ref#refs/tags/}"
            if [[ "$name" == *'^{}' ]]; then printf '%s %s peeled\n' "$sha" "${name%'^{}'}"
            else printf '%s %s direct\n' "$sha" "$name"; fi
        done <<< "$listing" \
        | sort -k2,2 -k3,3r | awk '$2 != last { print $1, $2; last = $2 }'
    )"
}

# origin_tag_commit <name> -- the commit origin's tag <name> names, nothing if
# origin has no such tag.
origin_tag_commit() {
    awk -v n="$1" '$2 == n { print $1; exit }' <<< "$ORIGIN_TAGS"
}

# reviewed_commit <sha> -- is <sha> a commit that reached review: on origin/main
# (as just fetched) or the commit of one of origin's v* / rc-v* tags? The
# release-images workflow can be dispatched on any ref, so the run id alone
# proves nothing about WHAT was built.
reviewed_commit() {
    local sha="$1"
    if git merge-base --is-ancestor "$sha" refs/remotes/origin/main 2>/dev/null; then return 0; fi
    awk -v s="$sha" '$1 == s && ($2 ~ /^v/ || $2 ~ /^rc-v/) { found = 1 } END { exit !found }' <<< "$ORIGIN_TAGS"
}

main() {
    # Before anything else, usage errors included: a password that is in the
    # environment this script was started with is already readable at
    # /proc/<pid>/environ by everything it starts, and `unset` cannot undo that.
    if [[ -v COSIGN_PASSWORD ]]; then
        die "COSIGN_PASSWORD is in the environment, where every child of this script can read it (/proc/<pid>/environ). Unset it and put the password in a file (mode 0600, outside the repository): COSIGN_PASSWORD_FILE=<file>."
    fi
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

    # The password's source is settled now, before any network call: a file
    # that can be read. Its content is read in the signing subshell (step 4)
    # and nowhere else. There is no prompt fallback, terminal or not: the
    # signer captures cosign's stderr, so its prompt would hang unseen.
    [[ -n "${COSIGN_PASSWORD_FILE:-}" ]] || die "COSIGN_PASSWORD_FILE is not set: put the cosign key's password in a file (mode 0600, outside the repository) and set COSIGN_PASSWORD_FILE=<file>. cosign cannot prompt here."
    [[ -f "$COSIGN_PASSWORD_FILE" && -r "$COSIGN_PASSWORD_FILE" ]] || die "COSIGN_PASSWORD_FILE is not a readable file: $COSIGN_PASSWORD_FILE"

    # Only sign-release.sh needs the key. Everything else this script starts
    # (gh, git, node, make verify, the lint) is project code at the built
    # commit, so neither path stays in the environment it inherits.
    local sign_key="$COSIGN_KEY_PATH" sign_password_file="$COSIGN_PASSWORD_FILE"
    unset COSIGN_KEY_PATH COSIGN_PASSWORD_FILE

    local root status tag prev_tag signer
    root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)" || die "not inside a git checkout"
    tag="dist-v${version}"
    # Captured first: inside [[ -z "$(...)" ]] a failing `git status` would read as clean.
    status="$(git -C "$root" status --porcelain)" || die "git status failed"
    [[ -z "$status" ]] || die "working tree is not clean -- the release commit must be exactly the built sha plus the pins"
    cd "$root"

    # Origin is the record of what has been released, not this clone's tag
    # list: a dist tag cut from another workstation is not here until fetched.
    local fetch_out
    fetch_out="$(git fetch --tags origin '+refs/heads/main:refs/remotes/origin/main' 2>&1)" || fetch_failed "$fetch_out"
    read_origin_tags || die "cannot list origin's tags"
    if [[ -n "$(origin_tag_commit "$tag")" ]]; then
        # The fetch above put origin's tag into this clone too, so both places
        # hold it. Nothing here deletes a tag on origin: a release tag is the
        # record of a release. Removing a leftover is the operator's call.
        die "tag ${tag} already exists on origin (and, fetched just now, in this clone). Inspect it: git ls-remote --tags origin refs/tags/${tag} and git show ${tag}. If it is a release, cut the next version. If it is a leftover of a cut that pushed it and then failed, and no host ever deployed it, remove it yourself with: git push origin :refs/tags/${tag} and git tag -d ${tag}; then run again"
    fi
    if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
        die "tag ${tag} exists in this clone but not on origin, most likely left by a failed run: check it is not a release (git show ${tag}) and that origin really lacks it (git ls-remote --tags origin refs/tags/${tag} prints nothing), delete it (git tag -d ${tag}) and run again"
    fi
    prev_tag="$(awk '$2 ~ /^dist-v/ { print $2 }' <<< "$ORIGIN_TAGS" | sort -rV | head -n 1)"
    if [[ -z "$prev_tag" && "$first_release" -eq 0 ]]; then
        die "origin has no dist-v* tag: pass --first-release if ${tag} is the first, otherwise something is wrong with the fetch"
    fi
    if [[ -n "$prev_tag" && "$first_release" -eq 1 ]]; then
        die "--first-release, but ${prev_tag} already exists"
    fi

    WORK="$(mktemp -d)"
    trap cleanup EXIT
    # The signer is the copy that sits next to this script NOW, taken before the
    # detached checkout below replaces the tree with the built commit's: that
    # commit's own sign-release.sh is not what holds the key. (WORK is mode 0700
    # and goes with the trap.)
    signer="$WORK/sign-release.sh"
    cp -- "$SCRIPT_DIR/sign-release.sh" "$signer" || die "cannot copy sign-release.sh from ${SCRIPT_DIR}"
    chmod 0500 -- "$signer"

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
        # by origin's commit for the tag, not by name: a local tag of that name need not agree
        prev="$(git show "$(origin_tag_commit "$prev_tag"):scripts/migrations/applied.lock.json" | jq -c '[.chains[].files | keys[]] | unique')"
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
    # The one place the password exists: read here, in this subshell, and
    # exported to sign-release.sh alone. The signer is the trusted copy made before the
    # checkout; it finds its repository from its own location, so it is pointed
    # at this clone by GIT_DIR / GIT_WORK_TREE instead.
    (
        pw="$(<"$sign_password_file")" || exit 1
        # $(...) drops trailing newlines; a CRLF file also leaves the \r
        COSIGN_PASSWORD="${pw%$'\r'}"
        export COSIGN_PASSWORD
        GIT_DIR="$(git rev-parse --absolute-git-dir)" GIT_WORK_TREE="$root" bash "$signer" --key "$sign_key" "${refs_arr[@]}"
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
