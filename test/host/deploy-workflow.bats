#!/usr/bin/env bats
# Tests for the keyless release pipeline (.github/workflows/release-images.yml,
# scripts/release/release-tag-check.sh, scripts/release/cut-dist-tag.sh) and
# docs/ops/host-tooling.md.
#
# This file used to test deploy.yml, the workflow that handed a deploy key to an
# Actions runner and ran `gremion-deploy` on the host over a shell session. It is
# gone (TRD-364: no CI runner holds a deploy credential), and the tests of its
# host hand-off (the deploy-channel block: ssh-agent, known_hosts, the EXIT
# trailer) went with it, because the step they exercised no longer exists. The
# host side of that contract is still tested where it lives, in
# test/host/deploy.bats and test/host/hostd*.bats; the host-tooling.md tests
# below are kept.
#
# The pieces that are real shell are standalone scripts and are EXECUTED here
# against a real git repository: release-tag-check.sh against real git plumbing
# and real node, cut-dist-tag.sh through stubs on PATH that record what it tried
# to do. A workflow that is only grepped is a workflow nobody has ever run, so
# the workflow's contract is asserted with anchored patterns, and its build
# matrix is diffed against the service sets emit-pins.mjs derives.
#
# Run: bats test/host/deploy-workflow.bats

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
WORKFLOW="${PROJECT_ROOT}/.github/workflows/release-images.yml"
TAGCHECK="${PROJECT_ROOT}/scripts/release/release-tag-check.sh"
CUTTAG="${PROJECT_ROOT}/scripts/release/cut-dist-tag.sh"
DOC="${PROJECT_ROOT}/docs/ops/host-tooling.md"
INDEX="${PROJECT_ROOT}/docs/INDEX.md"
BIN_DIR="${PROJECT_ROOT}/infra/host/bin"

setup() {
    setup_host_root
}

# Build a throwaway repository carrying one annotated (or lightweight) release
# tag, so the tag check runs against real git plumbing and not a mock.
make_release_repo() {
    local dir="$1" tag="$2" json="$3" pins="${4:-yes}" kind="${5:-annotated}"
    mkdir -p "$dir"
    git -C "$dir" init -q -b main
    git -C "$dir" config user.email 'plan@example.org'
    git -C "$dir" config user.name 'plan'
    git -C "$dir" config core.autocrlf false
    printf '%s\n' "$json" > "${dir}/release.json"
    if [ "$pins" = yes ]; then
        printf 'services: {}\n' > "${dir}/docker-compose.pins.yml"
    fi
    git -C "$dir" add -A
    git -C "$dir" commit -q -m 'release'
    if [ "$kind" = annotated ]; then
        git -C "$dir" tag -a "$tag" -m "$tag"
    else
        git -C "$dir" tag "$tag"
    fi
}

VALID_RELEASE_JSON='{"tag":"dist-v1.4.0","overlap":true,"migrations":["1101_add_x"],"distManifestDigest":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'

# run_bodies <workflow> -- prints every line of every `run:` block scalar (and
# every one-line `run:` value) of the workflow, and nothing else. The block ends
# at the first non-blank line indented no deeper than the `run:` key.
run_bodies() {
    awk '
        function indent(s) { match(s, /^ */); return RLENGTH }
        inbody && NF && indent($0) <= runind { inbody = 0 }
        inbody { print; next }
        /^[[:space:]]*(- )?run:[[:space:]]*[|>]/ { inbody = 1; runind = indent($0); next }
        /^[[:space:]]*(- )?run:[[:space:]]*[^|>[:space:]]/ { print }
    ' "$1"
}

# step_body <workflow> <step name> -- the `run:` body of the one step with that
# exact `- name:`, dedented, so a test can EXECUTE the shell the workflow runs
# (a workflow that is only grepped is a workflow nobody has ever run).
step_body() {
    awk -v want="      - name: $2" '
        function indent(s) { match(s, /^ */); return RLENGTH }
        inbody && NF && indent($0) <= 8 { inbody = 0 }
        inbody { print substr($0, 11); next }
        $0 == want { instep = 1; next }
        instep && /^      - / { instep = 0 }
        instep && /^        run: \|$/ { inbody = 1 }
    ' "$1"
}

# assert_present <ere> <file> <why> / assert_absent <ere> <file> <why> live in
# test_helper/host.bash: a negated grep silently passes when it is not the last
# statement of a test, and an unanchored positive grep is satisfied by the
# comment that explains the setting. Their rationale travelled with them.

# ---------------------------------------------------------------------------
# release-images.yml: static contract
# ---------------------------------------------------------------------------

@test "release-images.yml exists and deploy.yml is gone" {
    [ -f "$WORKFLOW" ]
    [ ! -e "${PROJECT_ROOT}/.github/workflows/deploy.yml" ]
}

@test "release-images.yml is valid YAML under the repo yamllint config" {
    command -v yamllint >/dev/null || skip "yamllint not installed (CI installs it)"
    run yamllint -c "${PROJECT_ROOT}/.yamllint.yml" "$WORKFLOW"
    [ "$status" -eq 0 ]
}

@test "release-images.yml triggers on dispatch (release_ref) and on rc-v* / v* tags, and nothing else" {
    assert_present '^on:' "$WORKFLOW" 'no trigger block'
    assert_present '^  workflow_dispatch:' "$WORKFLOW" 'not dispatch-triggered'
    assert_present '^      release_ref:' "$WORKFLOW" 'no release_ref input'
    assert_present '^        default: main$' "$WORKFLOW" 'release_ref does not default to main'
    assert_present '^  push:' "$WORKFLOW" 'not push-triggered'
    assert_present "^      - 'rc-v\\*'$" "$WORKFLOW" 'rc-v* tags do not trigger a release build'
    assert_present "^      - 'v\\*'$" "$WORKFLOW" 'v* tags do not trigger a release build'
    assert_absent '^  (pull_request|pull_request_target|schedule|workflow_run):' "$WORKFLOW" \
        'a trigger other than dispatch and release tags can push images'
    assert_absent '^    branches:' "$WORKFLOW" 'a branch push can push images'
}

@test "release-images.yml token is exactly contents: read and packages: write" {
    local perms
    perms="$(awk '/^permissions:/ { f = 1; next } f && /^[^ ]/ { exit } f && NF { print }' "$WORKFLOW")"
    [ "$perms" = "$(printf '  contents: read\n  packages: write')" ] || {
        echo "workflow permissions are: ${perms}" >&2
        return 1
    }
    # packages is the only writable scope anywhere, job-level blocks included.
    [ "$(grep -cE ': write$' "$WORKFLOW")" -eq 1 ]
    assert_absent 'id-token:' "$WORKFLOW" 'an OIDC token is minted for a release build'
}

@test "release-images.yml has no environment, no deploy path and no remote shell" {
    assert_absent '^[[:space:]]+environment:' "$WORKFLOW" 'a GitHub environment (and its secrets) is attached'
    assert_absent '[sS][sS][hH]' "$WORKFLOW" 'the workflow mentions a remote shell'
    assert_absent 'docker compose' "$WORKFLOW" 'CI issues a compose command of its own'
    assert_absent 'gremion-deploy|DEPLOY_' "$WORKFLOW" 'the workflow reaches for the deploy path'
}

@test "release-images.yml uses no secret but GITHUB_TOKEN" {
    local names
    names="$(grep -oE 'secrets\.[A-Za-z0-9_]+' "$WORKFLOW" | sort -u)"
    [ "$names" = 'secrets.GITHUB_TOKEN' ] || {
        echo "secrets referenced: ${names:-none}" >&2
        return 1
    }
    assert_absent 'secrets: inherit|toJSON\(secrets\)|secrets\[' "$WORKFLOW" 'the whole secrets context is reachable'
}

@test "release-images.yml pins every action to a full commit SHA and uses only the five it needs" {
    local n=0 line
    while IFS= read -r line; do
        n=$((n + 1))
        printf '%s' "$line" | grep -qE 'uses: [^@]+@[0-9a-f]{40}( +#.*)?$' || {
            echo "unpinned action: ${line}" >&2
            return 1
        }
        printf '%s' "$line" | grep -qE 'uses: actions/(checkout|setup-node|upload-artifact|download-artifact)@' || {
            echo "an action outside the allowed set: ${line}" >&2
            return 1
        }
    done < <(grep -E '^\s+(- )?uses:' "$WORKFLOW")
    [ "$n" -ge 5 ]
}

@test "release-images.yml binds every workflow expression to a metadata, with: or env key, never into a shell body" {
    # Script injection is the failure this forbids: an expression expanded
    # inside `run:` becomes shell the dispatcher wrote. Every one of them is
    # bound to a key instead, and the shell reads it as an environment
    # variable.
    local bodies total bad=0 line
    bodies="$(run_bodies "$WORKFLOW")"
    # Vacuity: the extractor really found the build step's body.
    [ "$(printf '%s\n' "$bodies" | wc -l)" -ge 25 ]
    [[ "$bodies" == *"docker buildx build"* ]]
    [[ "$bodies" == *"--password-stdin"* ]]
    [ "$(printf '%s' "$bodies" | grep -cF '${{' || true)" -eq 0 ] || {
        echo "expression inside a run body:" >&2
        printf '%s\n' "$bodies" | grep -nF '${{' >&2
        return 1
    }
    total="$(grep -cF '${{' "$WORKFLOW")"
    [ "$total" -ge 15 ]
    while IFS= read -r line; do
        printf '%s' "$line" \
            | grep -qE '^[[:space:]]*(- )?(group|name|ref|path|pattern|sha|cache_write|REGISTRY_USER|REGISTRY_TOKEN|IMAGE|SERVICES|DOCKERFILE|CONTEXT|TARGET|NAME|RELEASE_SHA|EXPECTED_SHA|CACHE_WRITE):[[:space:]]' \
            || { echo "unbound expression: ${line}" >&2; bad=1; }
    done < <(grep -F '${{' "$WORKFLOW")
    [ "$bad" -eq 0 ]
}

@test "release-images.yml logs in on stdin, builds with registry cache, asserts the digest and always logs out" {
    assert_present '\| docker login ghcr\.io -u "\$REGISTRY_USER" --password-stdin$' "$WORKFLOW" \
        'the registry token is not piped to docker login on stdin'
    assert_absent 'docker login[^|]*(-p |--password )' "$WORKFLOW" 'the registry token is on a command line'
    assert_present 'docker buildx create --use .*--driver docker-container' "$WORKFLOW" \
        'no docker-container buildx builder (the registry cache exporter needs it)'
    assert_present '--cache-from "type=registry,ref=\$\{IMAGE\}:buildcache"' "$WORKFLOW" 'no registry cache import'
    assert_present '--cache-to "type=registry,ref=\$\{IMAGE\}:buildcache,mode=max"' "$WORKFLOW" 'no registry cache export'
    assert_present '--metadata-file "\$meta"' "$WORKFLOW" 'the build does not write its metadata file'
    assert_present '--push \\$' "$WORKFLOW" 'the build does not push'
    assert_present "containerimage\\.digest" "$WORKFLOW" 'the pushed digest is not read from the build metadata'
    assert_present "\\^sha256:\\[0-9a-f\\]\\{64\\}\\\$" "$WORKFLOW" 'the pushed digest is not asserted to be a sha256'
    # The logout step must run on failure too: `if: always()` directly above its run.
    run grep -B2 'docker logout ghcr.io' "$WORKFLOW"
    [ "$status" -eq 0 ]
    [[ "$output" == *"if: always()"* ]]
}

@test "release-images.yml image names are lowercase first-party ghcr.io refs and the pins artefacts are named" {
    local images
    images="$(grep -oE 'image: [^,]+' "$WORKFLOW" | sed 's/^image: //')"
    [ "$(printf '%s\n' "$images" | wc -l)" -ge 9 ]
    while IFS= read -r line; do
        printf '%s' "$line" | grep -qE '^ghcr\.io/hello-n00del/gremion-[a-z-]+$' || {
            echo "not a lowercase first-party image: ${line}" >&2
            return 1
        }
    done <<< "$images"
    assert_present 'name: pin-\$\{\{ matrix\.name \}\}$' "$WORKFLOW" 'no per-image pin artefact'
    assert_present 'name: release-pins-\$\{\{ steps\.sha\.outputs\.sha \}\}$' "$WORKFLOW" 'no release-pins-<sha> artefact'
    assert_present 'emit-pins\.mjs --project app' "$WORKFLOW" 'the app pins layer is not emitted'
    assert_present 'emit-pins\.mjs --project state' "$WORKFLOW" 'the state pins layer is not emitted'
    assert_present 'check-image-digests\.mjs --render' "$WORKFLOW" 'the emitted layers are not rendered and judged'
}

@test "release-images.yml build matrix names exactly the services emit-pins derives" {
    # The full agreement (compose build blocks, docker-build) is
    # scripts/release/release-images.test.mjs; this is the part that needs no
    # node_modules, so it cannot skip on a bare runner.
    command -v node >/dev/null || skip "node not installed"
    local derived matrix
    derived="$(cd "$PROJECT_ROOT" && node --input-type=module -e "
        const m = await import('./scripts/release/check-pins.mjs')
        console.log([...m.derivedServices('app'), ...m.derivedServices('state')].sort().join('\n'))")"
    matrix="$(grep -E '^ +- \{ name: ' "$WORKFLOW" | sed -E 's/.*services: ([^,]+),.*/\1/' | tr ' ' '\n' | sort)"
    [ "$(printf '%s\n' "$derived" | wc -l)" -ge 11 ]
    [ "$derived" = "$matrix" ] || {
        echo "emit-pins derives:" >&2; printf '%s\n' "$derived" >&2
        echo "the matrix builds:" >&2; printf '%s\n' "$matrix" >&2
        return 1
    }
}

# A throwaway origin with: main (tip M2, an older commit M1), a feature branch
# ahead of main (F1), an annotated v1.0.0 tag and a lightweight rc-v2.0.0 tag on
# two commits that are on no branch (T1, T2). The shas land in M1 M2 F1 T1 T2.
make_ref_origin() {
    REF_ORIGIN="${BATS_TEST_TMPDIR}/ref-origin.git"
    local w="${BATS_TEST_TMPDIR}/ref-seed"
    git init -q --bare -b main "$REF_ORIGIN"
    git init -q -b main "$w"
    git -C "$w" config user.email 'plan@example.org'
    git -C "$w" config user.name 'plan'
    git -C "$w" config commit.gpgsign false
    git -C "$w" config tag.gpgsign false
    git -C "$w" remote add origin "$REF_ORIGIN"
    git -C "$w" commit -q --allow-empty -m m1
    M1="$(git -C "$w" rev-parse HEAD)"
    git -C "$w" commit -q --allow-empty -m m2
    M2="$(git -C "$w" rev-parse HEAD)"
    git -C "$w" checkout -q -b feature
    git -C "$w" commit -q --allow-empty -m f1
    F1="$(git -C "$w" rev-parse HEAD)"
    git -C "$w" checkout -q -b relA "$M1"
    git -C "$w" commit -q --allow-empty -m t1
    T1="$(git -C "$w" rev-parse HEAD)"
    git -C "$w" tag -a v1.0.0 -m v1.0.0
    git -C "$w" checkout -q -b relB "$M1"
    git -C "$w" commit -q --allow-empty -m t2
    T2="$(git -C "$w" rev-parse HEAD)"
    git -C "$w" tag rc-v2.0.0
    git -C "$w" push -q origin main feature relA relB v1.0.0 rc-v2.0.0
    # the tag-only commits must be reachable by their tag alone
    git --git-dir="$REF_ORIGIN" branch -q -D relA relB
    export REF_ORIGIN M1 M2 F1 T1 T2
}

# resolve_ref_at <sha> -- run the workflow's own "Resolve the ref" shell in a
# fresh clone of the origin with <sha> checked out, as checkout@ leaves it.
resolve_ref_at() {
    local sha="$1" clone="${BATS_TEST_TMPDIR}/ref-clone-${1:0:8}"
    git clone -q "$REF_ORIGIN" "$clone"
    git -C "$clone" -c advice.detachedHead=false checkout -q --detach "$sha"
    GITHUB_OUTPUT="${BATS_TEST_TMPDIR}/gh-output-${sha:0:8}"
    : > "$GITHUB_OUTPUT"
    export GITHUB_OUTPUT
    step_body "$WORKFLOW" 'Resolve the ref to one commit' > "${BATS_TEST_TMPDIR}/resolve.sh"
    (cd "$clone" && bash "${BATS_TEST_TMPDIR}/resolve.sh" > /dev/null)
}

@test "release-images.yml resolve-ref pins the ref to one 40-hex commit and lets only main's tip or a release tag write the build cache" {
    make_ref_origin
    # The body really was extracted: a vacuous extractor would "pass" below.
    [ "$(step_body "$WORKFLOW" 'Resolve the ref to one commit' | wc -l)" -ge 10 ]

    resolve_ref_at "$M2"
    grep -qx "sha=${M2}" "$GITHUB_OUTPUT"
    grep -qx 'cache_write=true' "$GITHUB_OUTPUT"

    # an annotated tag: ls-remote lists the tag object, the commit is the peeled line
    resolve_ref_at "$T1"
    grep -qx "sha=${T1}" "$GITHUB_OUTPUT"
    grep -qx 'cache_write=true' "$GITHUB_OUTPUT"

    resolve_ref_at "$T2"
    grep -qx 'cache_write=true' "$GITHUB_OUTPUT"

    # a feature branch's commit, and a commit main has since moved past, read the cache only
    resolve_ref_at "$F1"
    grep -qx "sha=${F1}" "$GITHUB_OUTPUT"
    grep -qx 'cache_write=false' "$GITHUB_OUTPUT"
    resolve_ref_at "$M1"
    grep -qx 'cache_write=false' "$GITHUB_OUTPUT"
}

@test "release-images.yml resolve-ref refuses a checkout that is not a commit" {
    make_ref_origin
    local clone="${BATS_TEST_TMPDIR}/ref-empty"
    mkdir -p "$clone"
    git -C "$clone" init -q -b main
    git -C "$clone" remote add origin "$REF_ORIGIN"
    GITHUB_OUTPUT="${BATS_TEST_TMPDIR}/gh-output-empty"
    : > "$GITHUB_OUTPUT"
    export GITHUB_OUTPUT
    step_body "$WORKFLOW" 'Resolve the ref to one commit' > "${BATS_TEST_TMPDIR}/resolve.sh"
    # no commit in this repository: `git rev-parse HEAD` cannot name a sha
    run bash -c "cd '$clone' && bash '${BATS_TEST_TMPDIR}/resolve.sh'"
    [ "$status" -ne 0 ]
    [ ! -s "$GITHUB_OUTPUT" ]
}

@test "release-images.yml only the cache write is conditional, and only on CACHE_WRITE" {
    # Every commit reads the shared cache.
    assert_present '--cache-from "type=registry,ref=\$\{IMAGE\}:buildcache"' "$WORKFLOW" 'no registry cache import'
    # The export sits directly under `if [ "$CACHE_WRITE" = true ]`, and nowhere else.
    [ "$(grep -c -- '--cache-to' "$WORKFLOW")" -eq 1 ]
    run grep -B1 -- '--cache-to' "$WORKFLOW"
    [ "$status" -eq 0 ]
    [[ "$output" == *'if [ "$CACHE_WRITE" = true ]; then'* ]]
}

@test "release-images.yml the pins job refuses a pin record that names another commit, or none" {
    local tmp="${BATS_TEST_TMPDIR}/emit" sha=0123456789abcdef0123456789abcdef01234567
    local other=fedcba9876543210fedcba9876543210fedcba98
    # Only the part of the step before the first node call: the sha agreement.
    local body
    body="$(step_body "$WORKFLOW" 'Emit the app and state pins layers' | sed '/emit-pins\.mjs/,$d')"
    [ "$(printf '%s\n' "$body" | wc -l)" -ge 10 ]
    mkdir -p "${tmp}/pins"
    printf '# release-sha=%s\nlegal=ghcr.io/hello-n00del/gremion-legal@sha256:%064d\n' "$sha" 1 > "${tmp}/pins/pin-legal.txt"
    printf '# release-sha=%s\nvector=ghcr.io/hello-n00del/gremion-vector@sha256:%064d\n' "$sha" 2 > "${tmp}/pins/pin-vector.txt"

    RUNNER_TEMP="$tmp" RELEASE_SHA="$sha" run bash -c "$body"
    [ "$status" -eq 0 ]
    # the record that survives is clean: no comment line reaches emit-pins
    [ "$(cat "${tmp}/release-pins/release-sha.txt")" = "$sha" ]
    [ "$(wc -l < "${tmp}/release-pins/pins-all.txt")" -eq 2 ]
    assert_absent '^#' "${tmp}/release-pins/pins-all.txt" 'a comment line reaches emit-pins'

    # a leg that built another commit
    printf '# release-sha=%s\nvector=ghcr.io/hello-n00del/gremion-vector@sha256:%064d\n' "$other" 2 > "${tmp}/pins/pin-vector.txt"
    rm -rf "${tmp}/release-pins"
    RUNNER_TEMP="$tmp" RELEASE_SHA="$sha" run bash -c "$body"
    [ "$status" -eq 1 ]
    [[ "$output" == *"pin-vector.txt records '${other}', the release is ${sha}"* ]]
    [ ! -e "${tmp}/release-pins/pins-all.txt" ]

    # a leg that recorded no commit at all
    printf 'vector=ghcr.io/hello-n00del/gremion-vector@sha256:%064d\n' 2 > "${tmp}/pins/pin-vector.txt"
    RUNNER_TEMP="$tmp" RELEASE_SHA="$sha" run bash -c "$body"
    [ "$status" -eq 1 ]
    [[ "$output" == *"pin-vector.txt records '', the release is ${sha}"* ]]

    # no records downloaded at all is a failure, not an empty pass
    rm -f "${tmp}"/pins/pin-*.txt
    RUNNER_TEMP="$tmp" RELEASE_SHA="$sha" run bash -c "$body"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no pin record was downloaded"* ]]
}

# ---------------------------------------------------------------------------
# release-tag-check.sh -- executed against real git and real node
# ---------------------------------------------------------------------------

@test "release-tag-check accepts an annotated dist tag carrying release.json and pins" {
    local repo="${BATS_TEST_TMPDIR}/repo-ok"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON"
    cd "$repo"
    run bash "$TAGCHECK" dist-v1.4.0
    [ "$status" -eq 0 ]
    [[ "$output" == *"dist-v1.4.0 overlap=true migrations=1"* ]]
}

@test "release-tag-check takes the tag from TAG when no argument is given" {
    local repo="${BATS_TEST_TMPDIR}/repo-env"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON"
    cd "$repo"
    TAG=dist-v1.4.0 run bash "$TAGCHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"dist-v1.4.0 overlap=true"* ]]
}

@test "release-tag-check refuses when no tag is given at all" {
    local repo="${BATS_TEST_TMPDIR}/repo-notag"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON"
    cd "$repo"
    unset TAG
    run bash "$TAGCHECK"
    [ "$status" -ne 0 ]
    [[ "$output" == *"TAG is required"* ]]
}

@test "release-tag-check refuses a tag that is not dist-vX.Y.Z" {
    local repo="${BATS_TEST_TMPDIR}/repo-name"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON"
    cd "$repo"
    run bash "$TAGCHECK" 'v1.4.0; rm -rf /'
    [ "$status" -eq 2 ]
    [[ "$output" == *"a release tag is dist-vX.Y.Z"* ]]
}

@test "release-tag-check refuses a lightweight tag" {
    local repo="${BATS_TEST_TMPDIR}/repo-light"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON" yes lightweight
    cd "$repo"
    run bash "$TAGCHECK" dist-v1.4.0
    [ "$status" -eq 2 ]
    [[ "$output" == *"is lightweight"* ]]
}

@test "release-tag-check refuses a tag that does not exist" {
    local repo="${BATS_TEST_TMPDIR}/repo-missing"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON"
    cd "$repo"
    run bash "$TAGCHECK" dist-v9.9.9
    [ "$status" -eq 2 ]
    [[ "$output" == *"does not exist"* ]]
}

@test "release-tag-check refuses a tag whose tree has no docker-compose.pins.yml" {
    local repo="${BATS_TEST_TMPDIR}/repo-nopins"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON" no
    cd "$repo"
    run bash "$TAGCHECK" dist-v1.4.0
    [ "$status" -eq 2 ]
    [[ "$output" == *"does not carry docker-compose.pins.yml"* ]]
}

@test "release-tag-check refuses release.json without an explicit boolean overlap" {
    local repo="${BATS_TEST_TMPDIR}/repo-nooverlap"
    make_release_repo "$repo" dist-v1.4.0 \
        '{"tag":"dist-v1.4.0","migrations":[],"distManifestDigest":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
    cd "$repo"
    run bash "$TAGCHECK" dist-v1.4.0
    [ "$status" -eq 2 ]
    [[ "$output" == *"no explicit boolean overlap"* ]]
}

@test "release-tag-check refuses release.json that names a different tag" {
    local repo="${BATS_TEST_TMPDIR}/repo-skew"
    make_release_repo "$repo" dist-v1.4.1 "$VALID_RELEASE_JSON"
    cd "$repo"
    run bash "$TAGCHECK" dist-v1.4.1
    [ "$status" -eq 2 ]
    [[ "$output" == *"names tag dist-v1.4.0"* ]]
}

@test "release-tag-check refuses a bare-hex distManifestDigest" {
    local repo="${BATS_TEST_TMPDIR}/repo-barehex"
    make_release_repo "$repo" dist-v1.4.0 \
        '{"tag":"dist-v1.4.0","overlap":false,"migrations":[],"distManifestDigest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
    cd "$repo"
    run bash "$TAGCHECK" dist-v1.4.0
    [ "$status" -eq 2 ]
    [[ "$output" == *"distManifestDigest is not a sha256 digest"* ]]
}

# ---------------------------------------------------------------------------
# cut-dist-tag.sh -- operator workstation only; stubs on PATH, never a key
# ---------------------------------------------------------------------------

GOOD_DIGEST_A=1111111111111111111111111111111111111111111111111111111111111111
GOOD_DIGEST_B=2222222222222222222222222222222222222222222222222222222222222222

# The password the credential tests plant. It lives in a file the script is
# pointed at, never in an environment the script is started with.
CUT_SECRET=dummy-password-for-the-test

# cut_probe -- the line every recording stub runs: "probe <name> env=<n>
# ppid=<n> vars=<n>": env is how many lines of the stub's own environment, and
# ppid how many of the environ its PARENT was exec'd with (/proc/$PPID/environ,
# which `unset` does not touch), contain the test password. A grep on the
# exported variable alone would pass for a script that merely unset it.
# "unreadable" if /proc is not there, which the tests then refuse. vars is how
# many of COSIGN_PASSWORD_FILE and COSIGN_KEY_PATH the stub's environment
# holds: no secret, but only the signer has a use for them.
cut_probe() {
    # shellcheck disable=SC2016
    local tmpl='printf "probe %s env=%s ppid=%s vars=%s\n" "${0##*/}" "$(env | grep -c -- NEEDLE)" "$(if [ -r "/proc/$PPID/environ" ]; then tr "\0" "\n" < "/proc/$PPID/environ" | grep -c -- NEEDLE; else echo unreadable; fi)" "$(env | grep -c -E "^COSIGN_(PASSWORD_FILE|KEY_PATH)=")" >> "$ENV_LOG"'
    printf '%s\n' "${tmpl//NEEDLE/$CUT_SECRET}"
}

require_proc() {
    [ -r /proc/self/environ ] || skip "no /proc (the credential probe reads /proc/<pid>/environ; CI and the bats runner image have it)"
}

# assert_probes_clean -- every child that recorded a probe, bar sign-release.sh,
# neither holds the password nor was started from an environ that did, and has
# neither COSIGN_PASSWORD_FILE nor COSIGN_KEY_PATH in its environment; the
# named children did record one (a stub that never ran proves nothing).
assert_probes_clean() {
    local who leaked
    for who in "$@"; do
        grep -q "^probe ${who} " "$ENV_LOG" || { echo "no probe from ${who}:" >&2; cat "$ENV_LOG" >&2; return 1; }
    done
    leaked="$(grep '^probe ' "$ENV_LOG" | grep -v '^probe sign-release\.sh ' | grep -v ' env=0 ppid=0 vars=0$' || true)"
    [ -z "$leaked" ] || { echo "the password reached:" >&2; echo "$leaked" >&2; return 1; }
}

# A throwaway clone that holds a copy of the script at the path it expects, so
# its repository root (derived from its own location) is the throwaway and the
# dirty-tree check never looks at the real working tree. It has a bare origin
# (the script fetches tags and main from it and pushes the tag to it) and the
# few files the script reads or runs at the built commit; the heavy ones
# (lint, signing, the tag check) are recording stubs. FAKE_SHA is the seed
# commit, which is main's tip on origin.
make_cut_repo() {
    CUT_ORIGIN="${BATS_TEST_TMPDIR}/cut-origin.git"
    CUT_REPO="${BATS_TEST_TMPDIR}/cut-repo"
    git init -q --bare -b main "$CUT_ORIGIN"
    mkdir -p "${CUT_REPO}/scripts/release" "${CUT_REPO}/scripts/migrations"
    git -C "$CUT_REPO" init -q -b main
    git -C "$CUT_REPO" config user.email 'plan@example.org'
    git -C "$CUT_REPO" config user.name 'plan'
    git -C "$CUT_REPO" config core.autocrlf false
    git -C "$CUT_REPO" config commit.gpgsign false
    git -C "$CUT_REPO" remote add origin "$CUT_ORIGIN"
    cp "$CUTTAG" "${CUT_REPO}/scripts/release/cut-dist-tag.sh"
    printf '{"chains":[{"files":{"001_a":"x","002_b":"y"}}]}\n' > "${CUT_REPO}/scripts/migrations/applied.lock.json"
    printf '#!/usr/bin/env bash\n%s\nexit 0\n' "$(cut_probe)" > "${CUT_REPO}/scripts/release/lint-release.sh"
    printf '#!/usr/bin/env bash\n%s\nexit 0\n' "$(cut_probe)" > "${CUT_REPO}/scripts/release/release-tag-check.sh"
    # What sign-release.sh sees of the environment is the whole point of the
    # credential test: it is the one child that may hold the password.
    {
        # shellcheck disable=SC2016
        printf '#!/usr/bin/env bash\nprintf "sign-release pw=%%s key=%%s args=%%s\\n" "${COSIGN_PASSWORD-unset}" "${COSIGN_KEY_PATH-unset}" "$*" >> "$ENV_LOG"\n'
        cut_probe
    } > "${CUT_REPO}/scripts/release/sign-release.sh"
    git -C "$CUT_REPO" add -A
    git -C "$CUT_REPO" commit -q -m 'seed'
    git -C "$CUT_REPO" push -q -u origin main
    FAKE_SHA="$(git -C "$CUT_REPO" rev-parse HEAD)"
    CUT="${CUT_REPO}/scripts/release/cut-dist-tag.sh"
    DIST_MANIFEST="${BATS_TEST_TMPDIR}/dist.json"
    printf '{}\n' > "$DIST_MANIFEST"
    ENV_LOG="${BATS_TEST_TMPDIR}/env.log"
    : > "$ENV_LOG"
    ARTEFACT="${BATS_TEST_TMPDIR}/artefact"
    write_artefact
    # The password source every test but the prompt one uses: a file. Nothing
    # of it is exported but the path.
    CUT_PW_FILE="${BATS_TEST_TMPDIR}/cosign-password"
    printf '%s\n' "$CUT_SECRET" > "$CUT_PW_FILE"
    chmod 600 "$CUT_PW_FILE"
    unset COSIGN_PASSWORD
    export COSIGN_PASSWORD_FILE="$CUT_PW_FILE"
    export CUT_ORIGIN CUT_REPO CUT FAKE_SHA DIST_MANIFEST ENV_LOG ARTEFACT
}

# The files the run's release-pins-<sha> artefact holds: both layers as
# emit-pins.mjs writes them, and release-sha.txt. A test rewrites one to plant
# a defect.
write_artefact() {
    mkdir -p "$ARTEFACT"
    printf '# docker-compose.pins.yml: the release pins layer (app services), written by\n# scripts/release/emit-pins.mjs and judged by scripts/release/check-pins.mjs.\nservices:\n  gremion-ui:\n    build: !reset null\n    image: ghcr.io/hello-n00del/gremion-ui@sha256:%s\n  migrate:\n    build: !reset null\n    image: ghcr.io/hello-n00del/gremion-migrate@sha256:%s\n' \
        "$GOOD_DIGEST_A" "$GOOD_DIGEST_B" > "${ARTEFACT}/docker-compose.pins.yml"
    printf '# docker-compose.state-pins.yml: the release pins layer (state services), written by\n# scripts/release/emit-pins.mjs and judged by scripts/release/check-pins.mjs.\nservices:\n  legal:\n    build: !reset null\n    image: ghcr.io/hello-n00del/gremion-legal@sha256:%s\n' \
        "$GOOD_DIGEST_A" > "${ARTEFACT}/docker-compose.state-pins.yml"
    printf '%s\n' "$FAKE_SHA" > "${ARTEFACT}/release-sha.txt"
}

# Every tool the script checks for, shimmed (jq stays real: the script computes
# release.json with it). The refusals under test happen before most of them
# are used, and a stub that was called would be in the log.
shim_cut_tools() {
    local t
    for t in gh cosign make; do
        shim "$t"
    done
    # node is the check-pins / check-record calls: it records and can be told
    # to refuse check-pins.
    # shellcheck disable=SC2016
    shim node 'printf "node COSIGN_PASSWORD=%s COSIGN_KEY_PATH=%s\n" "${COSIGN_PASSWORD-unset}" "${COSIGN_KEY_PATH-unset}" >> "$ENV_LOG"
'"$(cut_probe)"'
case "$*" in *check-pins.mjs*) exit "${CHECKPINS_RC:-0}" ;; esac'
}

# The four questions the script asks gh, answered from the environment of the
# test: RUN_PATH / RUN_CONCLUSION / RUN_HEAD / RUN_HEAD_REPO describe the run,
# FAKE_SHA the built commit, ARTEFACT the files "downloaded".
shim_cut_gh() {
    # shellcheck disable=SC2016
    shim gh 'printf "gh COSIGN_PASSWORD=%s COSIGN_KEY_PATH=%s\n" "${COSIGN_PASSWORD-unset}" "${COSIGN_KEY_PATH-unset}" >> "$ENV_LOG"
'"$(cut_probe)"'
case "$*" in
  "api "*"/artifacts"*) echo "release-pins-$FAKE_SHA" ;;
  "api "*"/actions/runs/"*)
    printf "%s\t%s\t%s\t%s\t%s\n" "${RUN_PATH:-.github/workflows/release-images.yml}" "${RUN_CONCLUSION:-success}" "${RUN_HEAD:-$FAKE_SHA}" "${RUN_HEAD_REPO:-o/r}" "o/r" ;;
  "run download "*)
    dest=""
    while [ $# -gt 0 ]; do if [ "$1" = -D ]; then dest="$2"; fi; shift; done
    mkdir -p "$dest"
    cp -R "$ARTEFACT"/. "$dest"/ ;;
esac'
}

# A signing key the throwaway repository can sign the tag with.
make_cut_signing_key() {
    command -v ssh-keygen >/dev/null || skip "ssh-keygen not installed"
    ssh-keygen -q -t ed25519 -N '' -C plan -f "${BATS_TEST_TMPDIR}/tagkey" > /dev/null
    git -C "$CUT_REPO" config user.signingkey "${BATS_TEST_TMPDIR}/tagkey"
}

# After a refusal nothing in the clone moved and nothing was signed.
assert_cut_changed_nothing() {
    [ "$(git -C "$CUT_REPO" rev-parse HEAD)" = "$FAKE_SHA" ]
    [ "$(git -C "$CUT_REPO" branch --show-current)" = main ]
    [ ! -e "${CUT_REPO}/release.json" ]
    [ ! -e "${CUT_REPO}/docker-compose.pins.yml" ]
    refute_recorded cosign ""
    [ ! -s "$ENV_LOG" ] || ! grep -q '^sign-release' "$ENV_LOG"
}

run_cut() {
    run bash "$CUT" "$@"
}

@test "cut-dist-tag.sh is shellcheck-clean, as is release-tag-check.sh" {
    command -v shellcheck >/dev/null || skip "shellcheck not installed (CI installs it)"
    run shellcheck -x -s bash "$CUTTAG" "$TAGCHECK"
    [ "$status" -eq 0 ]
}

@test "cut-dist-tag.sh has no remote shell, no token hand-off and no host name" {
    # The only line that may spell the signing format is the tag command's.
    local body
    body="$(grep -v 'gpg\.format=ssh' "$CUTTAG")"
    [ -n "$body" ]
    if printf '%s\n' "$body" | grep -qiE '(^|[^a-z])ssh([^a-z]|$)'; then
        echo "cut-dist-tag.sh mentions a remote shell:" >&2
        printf '%s\n' "$body" | grep -niE '(^|[^a-z])ssh([^a-z]|$)' >&2
        return 1
    fi
    assert_absent 'gh auth token' "$CUTTAG" 'the script hands a GitHub token over'
    assert_absent 'GHCR_TOKEN|DEPLOY_HOST|DEPLOY_SSH_KEY|StrictHostKeyChecking' "$CUTTAG" 'the retired deploy hand-off survived'
    assert_absent '([a-z0-9-]+\.)+(com|net|org|de|io)([^a-z0-9.]|$)' "$CUTTAG" 'a host name is written into the script'
    assert_present 'host-side deploy is a manual operator step' "$CUTTAG" 'the script does not say the deploy is manual'
    assert_present '^set -euo pipefail$' "$CUTTAG" 'not strict bash'
}

@test "cut-dist-tag.sh refuses a bad version and a missing argument" {
    make_cut_repo
    shim_cut_tools
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    run_cut 1.2 --run-id 1 --overlap true --dist-manifest "$DIST_MANIFEST"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not a version"* ]]
    run_cut 1.2.3 --overlap true --dist-manifest "$DIST_MANIFEST"
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage:"* ]]
    [[ "$output" == *"[--first-release]"* ]]
}

@test "cut-dist-tag.sh refuses when COSIGN_KEY_PATH is unset, before any network call" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    unset COSIGN_KEY_PATH
    run_cut 1.2.3 --run-id 1 --overlap true --dist-manifest "$DIST_MANIFEST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"COSIGN_KEY_PATH is not set"* ]]
    refute_recorded gh ""
}

@test "cut-dist-tag.sh refuses a COSIGN_KEY_PATH that is not a readable file" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="${BATS_TEST_TMPDIR}/no-such-key"
    run_cut 1.2.3 --run-id 1 --overlap true --dist-manifest "$DIST_MANIFEST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"COSIGN_KEY_PATH is not a readable file"* ]]
    refute_recorded gh ""
}

@test "cut-dist-tag.sh refuses a dirty working tree, before any network call" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    printf 'stray\n' > "${CUT_REPO}/stray.txt"
    run_cut 1.2.3 --run-id 1 --overlap true --dist-manifest "$DIST_MANIFEST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"working tree is not clean"* ]]
    refute_recorded gh ""
}

@test "cut-dist-tag.sh refuses a pins artefact holding an image that is not a digest, and changes nothing" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    sed -i 's#gremion-ui@sha256:[0-9a-f]*#gremion-ui:latest#' "${ARTEFACT}/docker-compose.pins.yml"
    run_cut 1.2.3 --run-id 42 --overlap false --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"not a first-party digest reference"* ]] || { echo "$output" >&2; return 1; }
    [[ "$output" == *"gremion-ui:latest"* ]]
    assert_cut_changed_nothing
}

@test "cut-dist-tag.sh refuses a pins layer that is anything but the services emit-pins writes, and changes nothing" {
    # Each of these has only valid image: lines, which is all the old check read.
    local app case_name
    make_cut_repo
    app="${ARTEFACT}/docker-compose.pins.yml"
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    cp "$app" "${BATS_TEST_TMPDIR}/pristine.yml"
    for case_name in extra-key-after-image extra-key-before-image extra-top-level-key duplicate-service \
                     trailing-comment no-services image-first quoted-image; do
        write_artefact
        case "$case_name" in
            extra-key-after-image) sed -i 's#^\(    image: .*gremion-ui@.*\)$#\1\n    privileged: true#' "$app" ;;
            extra-key-before-image) sed -i 's#^\(    build: !reset null\)$#\1\n    command: [sh, -c, evil]#' "$app" ;;
            extra-top-level-key) printf 'volumes:\n  evil: {}\n' >> "$app" ;;
            duplicate-service) printf '  gremion-ui:\n    build: !reset null\n    image: ghcr.io/hello-n00del/gremion-ui@sha256:%s\n' "$GOOD_DIGEST_A" >> "$app" ;;
            trailing-comment) sed -i 's|^\(    image: .*gremion-ui@.*\)$|\1 # pinned|' "$app" ;;
            no-services) printf '# header only\nservices:\n' > "$app" ;;
            image-first) sed -i '/^    build: !reset null$/d' "$app" ;;
            quoted-image) sed -i 's#^    image: \(.*gremion-ui@.*\)$#    image: "\1"#' "$app" ;;
        esac
        if cmp -s "$app" "${BATS_TEST_TMPDIR}/pristine.yml"; then
            echo "${case_name}: the mutation did not change the layer" >&2
            return 1
        fi
        run_cut 1.2.3 --run-id 42 --overlap false --dist-manifest "$DIST_MANIFEST" --first-release
        [ "$status" -eq 1 ] || { echo "${case_name}: accepted (status ${status}): ${output}" >&2; return 1; }
        [[ "$output" == *"cut-dist-tag: "* ]] || { echo "${case_name}: no refusal message: ${output}" >&2; return 1; }
        assert_cut_changed_nothing
    done
}

@test "cut-dist-tag.sh refuses a layer check-pins refuses for the built commit (a service added or dropped)" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    CHECKPINS_RC=1 run_cut 1.2.3 --run-id 42 --overlap false --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"refused by check-pins"* ]]
    assert_recorded node "scripts/release/check-pins.mjs"
    [ ! -e "${CUT_REPO}/release.json" ]
    refute_recorded cosign ""
}

@test "cut-dist-tag.sh refuses a run that did not succeed" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    RUN_CONCLUSION=failure run_cut 1.2.3 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"did not succeed"* ]]
    assert_cut_changed_nothing
}

@test "cut-dist-tag.sh refuses a run of another workflow and a run dispatched from a fork" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    RUN_PATH=.github/workflows/ci.yml run_cut 1.2.3 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"not of release-images.yml"* ]]
    RUN_HEAD_REPO=someone/fork run_cut 1.2.3 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"dispatched from someone/fork"* ]]
    assert_cut_changed_nothing
    # the branch-qualified spelling of the real workflow is accepted past this check
    RUN_PATH=".github/workflows/release-images.yml@refs/heads/main" CHECKPINS_RC=1 run_cut 1.2.3 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [[ "$output" == *"refused by check-pins"* ]]
}

@test "cut-dist-tag.sh refuses a built or dispatching commit that is neither on origin/main nor a release tag" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    # a commit that only exists on an unmerged branch of origin
    git -C "$CUT_REPO" checkout -q -b unmerged
    git -C "$CUT_REPO" commit -q --allow-empty -m 'unreviewed'
    local side
    side="$(git -C "$CUT_REPO" rev-parse HEAD)"
    git -C "$CUT_REPO" push -q origin unmerged
    git -C "$CUT_REPO" checkout -q main
    git -C "$CUT_REPO" branch -q -D unmerged
    # the layer a run of that tree would carry, so only the provenance can refuse it
    printf '%s\n' "$side" > "${ARTEFACT}/release-sha.txt"

    FAKE_SHA="$side" run_cut 1.2.3 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"commit ${side} is neither on origin/main nor the commit of a v*/rc-v* tag"* ]]
    assert_cut_changed_nothing

    # built from main, but dispatched from the unmerged branch's copy of the workflow
    printf '%s\n' "$FAKE_SHA" > "${ARTEFACT}/release-sha.txt"
    RUN_HEAD="$side" run_cut 1.2.3 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"commit ${side} is neither on origin/main"* ]]
    assert_cut_changed_nothing
}

@test "cut-dist-tag.sh refuses a tag that exists on origin only, and fetches tags before choosing the previous one" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    # dist-v1.0.0 was cut from another workstation: origin has it, this clone does not
    local other="${BATS_TEST_TMPDIR}/other-clone"
    git clone -q "$CUT_ORIGIN" "$other"
    git -C "$other" config user.email 'plan@example.org'
    git -C "$other" config user.name 'plan'
    git -C "$other" tag -a dist-v1.0.0 -m dist-v1.0.0
    git -C "$other" push -q origin dist-v1.0.0
    if git -C "$CUT_REPO" rev-parse -q --verify refs/tags/dist-v1.0.0 > /dev/null; then
        echo "the clone already has dist-v1.0.0; the test would prove nothing" >&2
        return 1
    fi

    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"tag dist-v1.0.0 already exists"* ]]

    # ... and with --first-release the previous tag is found, so the claim is refused
    run_cut 1.0.1 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"--first-release, but dist-v1.0.0 already exists"* ]]
    assert_cut_changed_nothing
}

@test "cut-dist-tag.sh refuses a first release that does not say it is the first" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"origin has no dist-v* tag: pass --first-release"* ]]
    refute_recorded gh ""
    assert_cut_changed_nothing
}

@test "cut-dist-tag.sh refuses when origin cannot be fetched" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    git -C "$CUT_REPO" remote set-url origin "${BATS_TEST_TMPDIR}/no-such-origin.git"
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot fetch tags and main from origin"* ]]
    refute_recorded gh ""
}

@test "cut-dist-tag.sh cuts the tag, lists every migration as new only for the first release, and hands the key and password to sign-release.sh alone" {
    require_proc
    make_cut_repo
    make_cut_signing_key
    shim_cut_tools
    shim_cut_gh
    # the key file is any readable file; the password is a recognisable dummy
    # in COSIGN_PASSWORD_FILE (make_cut_repo)
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    # the tag is on origin, annotated, and carries the release.json of the first release
    git -C "$CUT_ORIGIN" rev-parse -q --verify refs/tags/dist-v1.0.0 > /dev/null
    [ "$(git -C "$CUT_ORIGIN" cat-file -t refs/tags/dist-v1.0.0)" = tag ]
    [ "$(git -C "$CUT_ORIGIN" show dist-v1.0.0:release.json | jq -c .migrations)" = '["001_a","002_b"]' ]
    git -C "$CUT_ORIGIN" show dist-v1.0.0:docker-compose.pins.yml | grep -q "gremion-ui@sha256:${GOOD_DIGEST_A}"
    git -C "$CUT_ORIGIN" show dist-v1.0.0:docker-compose.state-pins.yml | grep -q "gremion-legal@sha256:${GOOD_DIGEST_A}"
    # check-pins judged both layers before they were committed
    assert_recorded node "check-pins.mjs"
    assert_recorded node "docker-compose.pins.yml --project app"
    assert_recorded node "docker-compose.state-pins.yml --project state"
    assert_recorded make "verify"
    assert_recorded node "scripts/verify/check-record.mjs"
    # sign-release.sh is the one child that gets the password (the file's
    # content, without its newline), and it is handed the key by --key, not
    # through the environment
    grep -q "^sign-release pw=${CUT_SECRET} key=unset args=--key ${COSIGN_KEY_PATH} ghcr.io/hello-n00del/gremion-legal@sha256:${GOOD_DIGEST_A} ghcr.io/hello-n00del/gremion-migrate@sha256:${GOOD_DIGEST_B} ghcr.io/hello-n00del/gremion-ui@sha256:${GOOD_DIGEST_A}\$" "$ENV_LOG" || {
        echo "sign-release did not get the key and password:" >&2; cat "$ENV_LOG" >&2; return 1
    }
    # gh, node (check-pins, check-record) and make verify ran without either
    [ "$(grep -c '^gh ' "$ENV_LOG")" -ge 3 ]
    [ "$(grep -c '^node ' "$ENV_LOG")" -ge 3 ]
    local leaked
    leaked="$(grep -E '^(gh|node) ' "$ENV_LOG" | grep -v 'COSIGN_PASSWORD=unset COSIGN_KEY_PATH=unset' || true)"
    [ -z "$leaked" ] || { echo "credentials reached:" >&2; echo "$leaked" >&2; return 1; }
    # No other child, and no environ any of them was started from, ever held
    # the password; sign-release.sh holds it and its parent (the signing
    # subshell) was started from an environ that does not.
    assert_probes_clean gh node lint-release.sh release-tag-check.sh
    grep -qx 'probe sign-release.sh env=1 ppid=0 vars=0' "$ENV_LOG" || {
        echo "sign-release.sh did not hold the password, or its parent did:" >&2; cat "$ENV_LOG" >&2; return 1
    }
}

@test "cut-dist-tag.sh runs make verify without COSIGN_KEY_PATH or the password in its environment or its parent's" {
    require_proc
    make_cut_repo
    make_cut_signing_key
    shim_cut_tools
    shim_cut_gh
    # shellcheck disable=SC2016
    shim make 'printf "make COSIGN_PASSWORD=%s COSIGN_KEY_PATH=%s\n" "${COSIGN_PASSWORD-unset}" "${COSIGN_KEY_PATH-unset}" >> "$ENV_LOG"
'"$(cut_probe)"
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    grep -qx 'make COSIGN_PASSWORD=unset COSIGN_KEY_PATH=unset' "$ENV_LOG" || {
        echo "make verify saw the signing credentials:" >&2; cat "$ENV_LOG" >&2; return 1
    }
    assert_probes_clean make
}

@test "cut-dist-tag.sh signs with the sign-release.sh it started with, not the one in the built commit" {
    make_cut_repo
    make_cut_signing_key
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    # a built commit (a release tag's, so it counts as reviewed) whose signer is another program
    git -C "$CUT_REPO" checkout -q --detach "$FAKE_SHA"
    # shellcheck disable=SC2016
    printf '#!/usr/bin/env bash\nprintf "TAINTED signer ran\\n" >> "$ENV_LOG"\nexit 0\n' > "${CUT_REPO}/scripts/release/sign-release.sh"
    git -C "$CUT_REPO" commit -q -am 'a built commit with another signer'
    local built
    built="$(git -C "$CUT_REPO" rev-parse HEAD)"
    git -C "$CUT_REPO" tag -a v1.0.1 -m v1.0.1
    git -C "$CUT_REPO" push -q origin v1.0.1
    git -C "$CUT_REPO" checkout -q main
    printf '%s\n' "$built" > "${ARTEFACT}/release-sha.txt"
    FAKE_SHA="$built" run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    if grep -q TAINTED "$ENV_LOG"; then echo "the built commit's sign-release.sh ran:" >&2; cat "$ENV_LOG" >&2; return 1; fi
    grep -q "^sign-release pw=${CUT_SECRET} key=unset args=--key " "$ENV_LOG" || { echo "the trusted sign-release.sh did not run:" >&2; cat "$ENV_LOG" >&2; return 1; }
}

@test "cut-dist-tag.sh strips a CRLF line ending from the password file" {
    make_cut_repo
    make_cut_signing_key
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    printf '%s\r\n' "$CUT_SECRET" > "$CUT_PW_FILE"
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    grep -q "^sign-release pw=${CUT_SECRET} key=unset " "$ENV_LOG" || { echo "the password kept its carriage return:" >&2; cat -A "$ENV_LOG" >&2; return 1; }
}

@test "cut-dist-tag.sh refuses to start with COSIGN_PASSWORD in its environment, even empty, before anything else" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    local value
    for value in "$CUT_SECRET" ""; do
        export COSIGN_PASSWORD="$value"
        run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
        [ "$status" -eq 1 ] || { echo "COSIGN_PASSWORD='${value}': status ${status}: ${output}" >&2; return 1; }
        [[ "$output" == *"cut-dist-tag: COSIGN_PASSWORD is in the environment"* ]]
        # how to supply it instead
        [[ "$output" == *"COSIGN_PASSWORD_FILE=<file>"* ]]
        # the password is never echoed back
        [[ "$output" != *"$CUT_SECRET"* ]]
    done
    # ahead of usage errors too: the check is the first thing the script does
    run_cut
    [ "$status" -eq 1 ]
    [[ "$output" == *"COSIGN_PASSWORD is in the environment"* ]]
    refute_recorded gh ""
    assert_cut_changed_nothing
}

@test "cut-dist-tag.sh refuses a COSIGN_PASSWORD_FILE that is not a readable file, before any network call" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    export COSIGN_PASSWORD_FILE="${BATS_TEST_TMPDIR}/no-such-password"
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"COSIGN_PASSWORD_FILE is not a readable file"* ]]
    # a directory is no password file either
    export COSIGN_PASSWORD_FILE="$BATS_TEST_TMPDIR"
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"COSIGN_PASSWORD_FILE is not a readable file"* ]]
    refute_recorded gh ""
    assert_cut_changed_nothing
}

@test "cut-dist-tag.sh refuses when there is neither a password file nor a terminal for cosign to prompt on" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    unset COSIGN_PASSWORD_FILE
    run bash "$CUT" 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release < /dev/null
    [ "$status" -eq 1 ]
    [[ "$output" == *"COSIGN_PASSWORD_FILE is not set"* ]]
    [[ "$output" == *"COSIGN_PASSWORD_FILE=<file>"* ]]
    refute_recorded gh ""
    assert_cut_changed_nothing
}

@test "cut-dist-tag.sh with no password file refuses on a terminal too: cosign's prompt would be hidden (#47 residual)" {
    command -v script >/dev/null || skip "script (util-linux) is not installed"
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    unset COSIGN_PASSWORD_FILE
    # a pty on stdin: the script runs as it would in the operator's terminal.
    # sign-release.sh captures cosign's stderr, where the prompt goes, and runs
    # cosign once per image and step, so a prompt can never be answered there.
    run script -qec "bash '${CUT}' 1.0.0 --run-id 42 --overlap true --dist-manifest '${DIST_MANIFEST}' --first-release" /dev/null
    [ "$status" -eq 1 ] || { echo "status ${status}: ${output}" >&2; return 1; }
    [[ "$output" == *"COSIGN_PASSWORD_FILE is not set"* ]]
    refute_recorded gh ""
    assert_cut_changed_nothing
}

@test "sign-release.sh refuses to start with COSIGN_PASSWORD unset, rather than hang on a cosign prompt it hides (#47 residual)" {
    local t
    for t in cosign docker jq node; do shim "$t"; done
    run env -u COSIGN_PASSWORD bash "${PROJECT_ROOT}/scripts/release/sign-release.sh" \
        --key "${BATS_TEST_TMPDIR}/no.key" "ghcr.io/hello-n00del/gremion-ui@sha256:${GOOD_DIGEST_A}"
    [ "$status" -eq 1 ] || { echo "status ${status}: ${output}" >&2; return 1; }
    [[ "$output" == *"sign-release: COSIGN_PASSWORD is not set"* ]]
    refute_recorded cosign ""
    refute_recorded docker ""
}

@test "cut-dist-tag.sh does not take a dist tag a failed run left in this clone for the previous release (#47 residual)" {
    make_cut_repo
    make_cut_signing_key
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    # a run that tagged dist-v0.9.0 here and then failed before the push
    git -C "$CUT_REPO" tag -a dist-v0.9.0 -m dist-v0.9.0
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    [ "$(git -C "$CUT_ORIGIN" show dist-v1.0.0:release.json | jq -c .migrations)" = '["001_a","002_b"]' ]
}

@test "cut-dist-tag.sh names a same-name tag a failed run left in this clone, and how to clear it (#47 residual)" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    git -C "$CUT_REPO" tag -a dist-v1.0.0 -m dist-v1.0.0
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"tag dist-v1.0.0 exists in this clone but not on origin"* ]]
    [[ "$output" == *"git tag -d dist-v1.0.0"* ]]
    # kernel #62 follow-up: where it exists, how to inspect it, how to confirm origin lacks it
    [[ "$output" == *"git show dist-v1.0.0"* ]]
    [[ "$output" == *"git ls-remote --tags origin refs/tags/dist-v1.0.0"* ]]
    refute_recorded gh ""
}

@test "cut-dist-tag.sh names a same-name tag that is already on origin, where it is, and the exact commands to inspect and remove it (kernel #62 follow-up)" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    # the leftover is on origin: a cut that pushed its tag and then failed, or a release
    local other="${BATS_TEST_TMPDIR}/other-clone"
    git clone -q "$CUT_ORIGIN" "$other"
    git -C "$other" config user.email 'plan@example.org'
    git -C "$other" config user.name 'plan'
    git -C "$other" tag -a dist-v1.0.0 -m dist-v1.0.0
    git -C "$other" push -q origin dist-v1.0.0
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    # which tag, and where it exists
    [[ "$output" == *"tag dist-v1.0.0 already exists on origin"* ]]
    # the exact command to inspect it, on origin and in the clone the fetch just filled
    [[ "$output" == *"git ls-remote --tags origin refs/tags/dist-v1.0.0"* ]]
    [[ "$output" == *"git show dist-v1.0.0"* ]]
    # the exact commands to remove it, said to be the operator's call and never run here
    [[ "$output" == *"git push origin :refs/tags/dist-v1.0.0"* ]]
    [[ "$output" == *"git tag -d dist-v1.0.0"* ]]
    # and nothing was touched: the tag is still on origin
    git -C "$CUT_ORIGIN" rev-parse -q --verify refs/tags/dist-v1.0.0 > /dev/null
    refute_recorded gh ""
}

@test "cut-dist-tag.sh names a tag that is in this clone AND on origin with different targets, instead of dying on the fetch (kernel #62 follow-up)" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    # origin holds one dist-v1.0.0 ...
    local other="${BATS_TEST_TMPDIR}/other-clone"
    git clone -q "$CUT_ORIGIN" "$other"
    git -C "$other" config user.email 'plan@example.org'
    git -C "$other" config user.name 'plan'
    git -C "$other" tag -a dist-v1.0.0 -m 'the one on origin'
    git -C "$other" push -q origin dist-v1.0.0
    # ... and this clone a different one of the same name (git fetch --tags
    # refuses to overwrite it, and says nothing under --quiet)
    git -C "$CUT_REPO" tag -a dist-v1.0.0 -m 'a different one, local only'
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" != *"cannot fetch tags and main from origin"* ]]
    # which tag, and where it exists
    [[ "$output" == *"dist-v1.0.0"* ]]
    [[ "$output" == *"in this clone"* ]]
    [[ "$output" == *"on origin"* ]]
    [[ "$output" == *"different"* ]]
    # the exact commands to inspect each side, and to remove the local one
    [[ "$output" == *"git show dist-v1.0.0"* ]]
    [[ "$output" == *"git ls-remote --tags origin refs/tags/dist-v1.0.0"* ]]
    [[ "$output" == *"git tag -d dist-v1.0.0"* ]]
    # nothing was deleted for the operator
    git -C "$CUT_REPO" rev-parse -q --verify refs/tags/dist-v1.0.0 > /dev/null
    git -C "$CUT_ORIGIN" rev-parse -q --verify refs/tags/dist-v1.0.0 > /dev/null
    refute_recorded gh ""
}

@test "cut-dist-tag.sh names ANY clone-only tag that differs from origin's same-name tag, not only the one being cut (kernel #62 follow-up)" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    local other="${BATS_TEST_TMPDIR}/other-clone"
    git clone -q "$CUT_ORIGIN" "$other"
    git -C "$other" config user.email 'plan@example.org'
    git -C "$other" config user.name 'plan'
    git -C "$other" tag -a rc-v0.9.0 -m 'origin copy'
    git -C "$other" push -q origin rc-v0.9.0
    git -C "$CUT_REPO" tag -a rc-v0.9.0 -m 'local copy'
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" != *"cannot fetch tags and main from origin"* ]]
    [[ "$output" == *"rc-v0.9.0"* ]]
    [[ "$output" == *"git show rc-v0.9.0"* ]]
    [[ "$output" == *"git ls-remote --tags origin refs/tags/rc-v0.9.0"* ]]
    [[ "$output" == *"git tag -d rc-v0.9.0"* ]]
    refute_recorded gh ""
}

@test "cut-dist-tag.sh does not count a v* tag that exists only in this clone as provenance (#47 residual)" {
    make_cut_repo
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    git -C "$CUT_REPO" checkout -q --detach "$FAKE_SHA"
    git -C "$CUT_REPO" commit -q --allow-empty -m 'unreviewed, tagged locally only'
    local side
    side="$(git -C "$CUT_REPO" rev-parse HEAD)"
    git -C "$CUT_REPO" tag -a v9.9.9 -m v9.9.9
    git -C "$CUT_REPO" checkout -q main
    printf '%s\n' "$side" > "${ARTEFACT}/release-sha.txt"
    FAKE_SHA="$side" run_cut 1.2.3 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 1 ]
    [[ "$output" == *"commit ${side} is neither on origin/main nor the commit of a v*/rc-v* tag"* ]]
    assert_cut_changed_nothing
}

@test "the /proc probe of the credential tests sees a password that was merely unset" {
    require_proc
    ENV_LOG="${BATS_TEST_TMPDIR}/probe.log"
    export ENV_LOG
    : > "$ENV_LOG"
    cut_probe > "${BATS_TEST_TMPDIR}/probe.sh"
    # the outer shell is started with the secret, drops it from its own
    # environment and runs the probe as a child: the child's environment is
    # clean, the environ its parent was started with is not
    COSIGN_PASSWORD="$CUT_SECRET" bash -c 'unset COSIGN_PASSWORD; bash "$0"; true' "${BATS_TEST_TMPDIR}/probe.sh"
    grep -qx 'probe probe.sh env=0 ppid=1 vars=0' "$ENV_LOG" || { cat "$ENV_LOG" >&2; return 1; }
}

@test "the /proc probe of the credential tests flags COSIGN_PASSWORD_FILE and COSIGN_KEY_PATH in a child's environment" {
    ENV_LOG="${BATS_TEST_TMPDIR}/probe.log"
    export ENV_LOG
    : > "$ENV_LOG"
    cut_probe > "${BATS_TEST_TMPDIR}/probe.sh"
    COSIGN_PASSWORD_FILE=/x bash "${BATS_TEST_TMPDIR}/probe.sh"
    COSIGN_KEY_PATH=/y bash "${BATS_TEST_TMPDIR}/probe.sh"
    COSIGN_PASSWORD_FILE=/x COSIGN_KEY_PATH=/y bash "${BATS_TEST_TMPDIR}/probe.sh"
    [ "$(grep -c ' vars=1$' "$ENV_LOG")" -eq 2 ] && [ "$(grep -c ' vars=2$' "$ENV_LOG")" -eq 1 ] || { cat "$ENV_LOG" >&2; return 1; }
}

@test "cut-dist-tag.sh cuts a release built from a v* tag's commit, and the next release lists only the new migrations" {
    make_cut_repo
    make_cut_signing_key
    shim_cut_tools
    shim_cut_gh
    export COSIGN_KEY_PATH="$DIST_MANIFEST"
    # first release
    run_cut 1.0.0 --run-id 42 --overlap true --dist-manifest "$DIST_MANIFEST" --first-release
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    # a second release: a commit that is on no branch of origin, but is a release tag's commit
    git -C "$CUT_REPO" checkout -q --detach "$FAKE_SHA"
    printf '{"chains":[{"files":{"001_a":"x","002_b":"y","003_c":"z"}}]}\n' > "${CUT_REPO}/scripts/migrations/applied.lock.json"
    git -C "$CUT_REPO" commit -q -am 'a later commit'
    local built
    built="$(git -C "$CUT_REPO" rev-parse HEAD)"
    git -C "$CUT_REPO" tag -a v1.0.1 -m v1.0.1
    git -C "$CUT_REPO" push -q origin v1.0.1
    git -C "$CUT_REPO" checkout -q main
    # the artefact of the run that built it
    printf '%s\n' "$built" > "${ARTEFACT}/release-sha.txt"
    FAKE_SHA="$built" run_cut 1.0.1 --run-id 43 --overlap false --dist-manifest "$DIST_MANIFEST"
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    [ "$(git -C "$CUT_ORIGIN" show dist-v1.0.1:release.json | jq -c .migrations)" = '["003_c"]' ]
}

# ---------------------------------------------------------------------------
# docs/ops/host-tooling.md
# ---------------------------------------------------------------------------

@test "host-tooling.md exists and is linked from docs/INDEX.md" {
    [ -f "$DOC" ]
    grep -q 'ops/host-tooling.md' "$INDEX"
}

@test "host-tooling.md names every command in infra/host/bin" {
    local n=0 f base
    for f in "$BIN_DIR"/gremion-*; do
        [ -e "$f" ] || continue
        n=$((n + 1))
        base="$(basename "$f")"
        grep -q -- "$base" "$DOC" || {
            echo "host-tooling.md does not document ${base}" >&2
            return 1
        }
    done
    # Zero binaries would make the loop vacuous.
    [ "$n" -ge 10 ]
}

@test "host-tooling.md states the compose contract and shows no forbidden flag" {
    assert_present 'docker compose --env-file /opt/gremion/etc/env/' "$DOC" \
        'the doc never shows the --env-file form'
    # `.*`, not `[^\n]*`: grep is line-based, and inside a bracket expression
    # `\n` is the two characters backslash and n, so `[^\n]*` stops at the
    # first `n` and misses most violations.
    assert_absent 'docker compose .*(-f |--profile|--project-name| -p )' "$DOC" \
        'the doc shows a compose command carrying a forbidden flag'
}

@test "host-tooling.md documents the four exit codes and the noop dry-run" {
    assert_present '^\| *`0` *\|' "$DOC" 'exit code 0 is not in the table'
    assert_present '^\| *`1` *\|' "$DOC" 'exit code 1 is not in the table'
    assert_present '^\| *`2` *\|' "$DOC" 'exit code 2 is not in the table'
    assert_present '^\| *`3` *\|' "$DOC" 'exit code 3 is not in the table'
    assert_present 'BLOCKED:' "$DOC" 'the blocked form is not shown'
    assert_present "printf 'noop" "$DOC" 'the noop dry-run is not shown'
}

@test "host-tooling.md documents tenant-hosts.txt and the EXIT-trailer contract" {
    # tenant-hosts.txt is read by three programs (gremion-render --staging,
    # gremion-verify, the ops blackbox target list), created empty by bootstrap
    # (Task 2) and appended by the control plane. An input three programs share
    # must be documented with its owner and its format.
    assert_present 'etc/tenant-hosts.txt' "$DOC" 'the shared tenant host list is undocumented'
    assert_present 'one FQDN per line' "$DOC" 'the tenant host list format is unstated'
    # The verdict of a deploy is the agent's trailer, not ssh's status.
    assert_present 'not the ssh exit status' "$DOC" 'the verdict is not attributed to the trailer'
    assert_present 'no `EXIT` trailer at all' "$DOC" 'the missing-trailer case is undocumented'
}
