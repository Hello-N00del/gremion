#!/usr/bin/env bats
# Tests for .github/workflows/deploy.yml and docs/ops/host-tooling.md.
#
# deploy.yml is the only path a release takes to a host, so it is tested the
# way the host scripts are tested. The two pieces of it that are real shell
# live between sentinel markers, are EXTRACTED from the YAML, and are then
# executed against a real git repository and against shimmed ssh binaries.
# A workflow that is only grepped is a workflow nobody has ever run.
#
# Run: bats test/host/deploy-workflow.bats

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
WORKFLOW="${PROJECT_ROOT}/.github/workflows/deploy.yml"
DOC="${PROJECT_ROOT}/docs/ops/host-tooling.md"
INDEX="${PROJECT_ROOT}/docs/INDEX.md"
BIN_DIR="${PROJECT_ROOT}/infra/host/bin"

setup() {
    setup_host_root
    BLOCKDIR="${BATS_TEST_TMPDIR}/blocks"
    mkdir -p "$BLOCKDIR"
}

# Extract one marked shell block from the workflow into a runnable script.
# The markers are the contract: `# --- <name> begin ---` / `# --- <name> end ---`.
#
# Indentation note: the `run: |` bodies in deploy.yml sit at 10 spaces (the
# block scalar's own indentation, set by its first line), and this extractor
# strips exactly that many. The extracted script is therefore byte-for-byte
# the shell GitHub itself would run, and relative indentation inside the block
# survives the round trip unchanged — so a heredoc body in a block still works.
# A block moved to a different nesting depth changes that count; the line-count
# guard below is what turns such a move into a failure instead of a vacuum.
#
# The line-count guard below is the only thing standing between a silent
# mis-extraction (a renamed marker, a moved file, a changed indent that eats
# the body) and every behavioural test in this file passing vacuously against
# an empty script. Do not remove it.
extract_block() {
    local name="$1" dest="$2"
    printf '#!/usr/bin/env bash\n' > "$dest"
    sed -n "/# --- ${name} begin ---/,/# --- ${name} end ---/p" "$WORKFLOW" \
        | sed -e '1d' -e '$d' -e 's/^          //' >> "$dest"
    if [ "$(wc -l < "$dest")" -lt 6 ]; then
        echo "extract_block: '${name}' produced no body from ${WORKFLOW}" >&2
        return 1
    fi
    chmod +x "$dest"
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

# assert_present <ere> <file> <why> / assert_absent <ere> <file> <why> were
# derived here and are now in test_helper/host.bash, loaded above: four other
# files in this suite had re-derived the broken `! grep` shape they exist to
# replace, so the whole suite needed them. Their rationale -- including the
# measured drill where a negated grep left the host-key guard reporting ok --
# travelled with them and is the comment above their definitions.

# ---------------------------------------------------------------------------
# Static contract
# ---------------------------------------------------------------------------

@test "deploy.yml exists" {
    [ -f "$WORKFLOW" ]
}

@test "deploy.yml is valid YAML under the repo yamllint config" {
    command -v yamllint >/dev/null || skip "yamllint not installed (CI installs it)"
    run yamllint -c "${PROJECT_ROOT}/.yamllint.yml" "$WORKFLOW"
    [ "$status" -eq 0 ]
}

@test "deploy.yml is dispatch-only with tag and target inputs" {
    assert_present '^on:' "$WORKFLOW" 'no trigger block'
    assert_present '^  workflow_dispatch:' "$WORKFLOW" 'not dispatch-triggered'
    assert_present '^      tag:' "$WORKFLOW" 'no tag input'
    assert_present '^      target:' "$WORKFLOW" 'no target input'
    assert_present 'type: choice' "$WORKFLOW" 'target is not a closed choice'
    assert_present '^ +- production$' "$WORKFLOW" 'production is not an option'
    # No push/pull_request/schedule trigger may ever reach a host.
    assert_absent '^  (push|pull_request|schedule):' "$WORKFLOW" \
        'an automatic trigger can reach a host'
}

@test "deploy.yml runs in the production environment behind a single-flight lock" {
    assert_present '^    environment: production$' "$WORKFLOW" \
        'the job does not run in the production environment'
    assert_present '^  group: deploy-\$\{\{ inputs.target \}\}$' "$WORKFLOW" \
        'no per-target concurrency group'
    assert_present '^  cancel-in-progress: false$' "$WORKFLOW" \
        'a deploy can be cancelled mid-flight'
}

@test "deploy.yml token is read-only: contents and packages, nothing writable" {
    assert_present '^  contents: read$' "$WORKFLOW" 'contents is not read-only'
    assert_present '^  packages: read$' "$WORKFLOW" 'packages is not readable'
    assert_absent '^[[:space:]]+[a-z-]+: write$' "$WORKFLOW" \
        'the job token carries a writable scope'
}

@test "deploy.yml pins every action to a full commit SHA" {
    local n=0 line
    while IFS= read -r line; do
        n=$((n + 1))
        printf '%s' "$line" | grep -qE 'uses: [^@]+@[0-9a-f]{40}( +#.*)?$' || {
            echo "unpinned action: ${line}" >&2
            return 1
        }
    done < <(grep -E '^\s+(- )?uses:' "$WORKFLOW")
    [ "$n" -ge 1 ]
}

@test "deploy.yml binds every workflow expression to a metadata or env key, never into a shell body" {
    # Script injection is the failure this forbids: an expression expanded
    # inside `run:` becomes shell the dispatcher wrote. Every one of them is
    # bound to a key instead, and the shell reads it as an environment
    # variable.
    local total bad=0 line
    total="$(grep -cF '${{' "$WORKFLOW")"
    [ "$total" -ge 8 ]
    while IFS= read -r line; do
        printf '%s' "$line" \
            | grep -qE '^[[:space:]]*(run-name|group|TAG|DEPLOY_HOST|DEPLOY_SSH_KEY|DEPLOY_HOST_KEY|GHCR_TOKEN):[[:space:]]' \
            || { echo "unbound expression: ${line}" >&2; bad=1; }
    done < <(grep -F '${{' "$WORKFLOW")
    [ "$bad" -eq 0 ]
}

@test "deploy.yml verifies the host key and never trusts on first use" {
    # Anchored to the ssh option itself, not to the prose: the comment above
    # the invocation also spells StrictHostKeyChecking=yes, so an unanchored
    # match is satisfied by that comment while the real option says
    # accept-new. Measured in a drill on a scratch copy.
    assert_present '^[[:space:]]*-o StrictHostKeyChecking=yes([[:space:]]|$)' "$WORKFLOW" \
        'the ssh invocation does not set StrictHostKeyChecking=yes'
    assert_absent 'StrictHostKeyChecking=(no|accept-new)' "$WORKFLOW" \
        'trust-on-first-use hands the deploy token to whoever answers'
    assert_present '^[[:space:]]*-o UserKnownHostsFile=' "$WORKFLOW" \
        'no known_hosts file is pinned on the ssh invocation'
    assert_present 'DEPLOY_HOST_KEY' "$WORKFLOW" \
        'the host key does not come from the environment secret'
}

@test "deploy.yml keeps the deploy key off the runner disk and never traces" {
    assert_present '\| ssh-add -([[:space:]]|$)' "$WORKFLOW" \
        'the deploy key is not piped into ssh-add'
    assert_absent 'DEPLOY_SSH_KEY"?[[:space:]]*>' "$WORKFLOW" \
        'the deploy key is redirected to a file on the runner'
    assert_absent '^[[:space:]]*set -x' "$WORKFLOW" \
        'shell tracing would print the key and the token'
    assert_absent 'echo "\$GHCR_TOKEN"' "$WORKFLOW" \
        'the registry token is echoed into the log'
}

@test "deploy.yml issues no compose command of its own" {
    # N20: composition happens on the host, through --env-file only. A
    # compose verb in CI would be a second, unpinned way to change a host.
    # assert_absent refuses on a missing file, so this cannot pass vacuously
    # before the workflow is written.
    assert_absent 'docker compose' "$WORKFLOW" \
        'CI issues a compose command of its own'
}

# ---------------------------------------------------------------------------
# release-tag-check — executed against real git and real node
# ---------------------------------------------------------------------------

@test "release-tag-check accepts an annotated dist tag carrying release.json and pins" {
    extract_block release-tag-check "${BLOCKDIR}/tagcheck.sh"
    local repo="${BATS_TEST_TMPDIR}/repo-ok"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON"
    cd "$repo"
    export TAG=dist-v1.4.0
    run bash "${BLOCKDIR}/tagcheck.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"dist-v1.4.0 overlap=true migrations=1"* ]]
}

@test "release-tag-check refuses a tag that is not dist-vX.Y.Z" {
    extract_block release-tag-check "${BLOCKDIR}/tagcheck.sh"
    local repo="${BATS_TEST_TMPDIR}/repo-name"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON"
    cd "$repo"
    export TAG='v1.4.0; rm -rf /'
    run bash "${BLOCKDIR}/tagcheck.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"a release tag is dist-vX.Y.Z"* ]]
}

@test "release-tag-check refuses a lightweight tag" {
    extract_block release-tag-check "${BLOCKDIR}/tagcheck.sh"
    local repo="${BATS_TEST_TMPDIR}/repo-light"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON" yes lightweight
    cd "$repo"
    export TAG=dist-v1.4.0
    run bash "${BLOCKDIR}/tagcheck.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"is lightweight"* ]]
}

@test "release-tag-check refuses a tag whose tree has no docker-compose.pins.yml" {
    extract_block release-tag-check "${BLOCKDIR}/tagcheck.sh"
    local repo="${BATS_TEST_TMPDIR}/repo-nopins"
    make_release_repo "$repo" dist-v1.4.0 "$VALID_RELEASE_JSON" no
    cd "$repo"
    export TAG=dist-v1.4.0
    run bash "${BLOCKDIR}/tagcheck.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"does not carry docker-compose.pins.yml"* ]]
}

@test "release-tag-check refuses release.json without an explicit boolean overlap" {
    extract_block release-tag-check "${BLOCKDIR}/tagcheck.sh"
    local repo="${BATS_TEST_TMPDIR}/repo-nooverlap"
    make_release_repo "$repo" dist-v1.4.0 \
        '{"tag":"dist-v1.4.0","migrations":[],"distManifestDigest":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
    cd "$repo"
    export TAG=dist-v1.4.0
    run bash "${BLOCKDIR}/tagcheck.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no explicit boolean overlap"* ]]
}

@test "release-tag-check refuses release.json that names a different tag" {
    extract_block release-tag-check "${BLOCKDIR}/tagcheck.sh"
    local repo="${BATS_TEST_TMPDIR}/repo-skew"
    make_release_repo "$repo" dist-v1.4.1 "$VALID_RELEASE_JSON"
    cd "$repo"
    export TAG=dist-v1.4.1
    run bash "${BLOCKDIR}/tagcheck.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"names tag dist-v1.4.0"* ]]
}

# ---------------------------------------------------------------------------
# deploy-channel — executed against shimmed ssh binaries, never a real host
# ---------------------------------------------------------------------------

channel_env() {
    export TAG=dist-v1.4.0
    export DEPLOY_HOST=deploy.example.org
    export DEPLOY_SSH_KEY='-----BEGIN OPENSSH PRIVATE KEY-----
not-a-key
-----END OPENSSH PRIVATE KEY-----'
    export DEPLOY_HOST_KEY='deploy.example.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample'
    export GHCR_TOKEN=ghs_exampletoken
    export SSH_STDIN="${BATS_TEST_TMPDIR}/ssh.stdin"
    export SSH_ADD_STDIN="${BATS_TEST_TMPDIR}/ssh-add.stdin"
    shim ssh-agent 'echo "SSH_AUTH_SOCK=/dev/null; export SSH_AUTH_SOCK;"; echo "SSH_AGENT_PID=0; export SSH_AGENT_PID;"'
    shim ssh-add 'cat > "$SSH_ADD_STDIN"'
}

@test "deploy-channel sends TOKEN then deploy on stdin and succeeds on EXIT 0" {
    extract_block deploy-channel "${BLOCKDIR}/channel.sh"
    channel_env
    shim ssh 'cat > "$SSH_STDIN"; echo "STEP 1 login ok"; echo "STEP 12 record ok"; echo "EXIT 0"'
    run bash "${BLOCKDIR}/channel.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"STEP 12 record ok"* ]]
    [[ "$output" == *"dist-v1.4.0 applied"* ]]
    assert_recorded ssh "StrictHostKeyChecking=yes"
    assert_recorded ssh "gremion@deploy.example.org"
    grep -q '^TOKEN ghs_exampletoken$' "$SSH_STDIN"
    grep -q '^deploy dist-v1.4.0$' "$SSH_STDIN"
    # Line order is the wire contract: the token precedes the command.
    [ "$(head -n 1 "$SSH_STDIN" | cut -d' ' -f1)" = TOKEN ]
    grep -q 'BEGIN OPENSSH PRIVATE KEY' "$SSH_ADD_STDIN"
}

@test "deploy-channel fails when the agent reports a non-zero EXIT" {
    extract_block deploy-channel "${BLOCKDIR}/channel.sh"
    channel_env
    shim ssh 'cat > "$SSH_STDIN"; echo "BLOCKED: docker-compose.app.yml absent (spec B)"; echo "EXIT 3"'
    run bash "${BLOCKDIR}/channel.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"the agent reported EXIT 3"* ]]
}

@test "deploy-channel fails when the agent produces no EXIT trailer" {
    # A truncated stream that happened to end after a success line would
    # otherwise be read as a green deploy.
    extract_block deploy-channel "${BLOCKDIR}/channel.sh"
    channel_env
    shim ssh 'cat > "$SSH_STDIN"; echo "STEP 9 verify ok"'
    run bash "${BLOCKDIR}/channel.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no EXIT trailer"* ]]
}

@test "deploy-channel fails loudly when an environment secret is missing" {
    extract_block deploy-channel "${BLOCKDIR}/channel.sh"
    channel_env
    unset DEPLOY_HOST
    shim ssh 'cat > "$SSH_STDIN"; echo "EXIT 0"'
    run bash "${BLOCKDIR}/channel.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"DEPLOY_HOST"* ]]
}

@test "both extracted deploy.yml shell blocks are shellcheck-clean" {
    command -v shellcheck >/dev/null || skip "shellcheck not installed (CI installs it)"
    extract_block release-tag-check "${BLOCKDIR}/tagcheck.sh"
    extract_block deploy-channel "${BLOCKDIR}/channel.sh"
    run shellcheck -s bash "${BLOCKDIR}/tagcheck.sh" "${BLOCKDIR}/channel.sh"
    [ "$status" -eq 0 ]
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
