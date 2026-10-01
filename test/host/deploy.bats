#!/usr/bin/env bats
# Unit tests for infra/host/bin/gremion-deploy (spec A §F.4).
# Every test shims docker/git; nothing here touches a real daemon or registry.
# Run: bats test/host/deploy.bats

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
DEPLOY="${PROJECT_ROOT}/infra/host/bin/gremion-deploy"
FIXTURES="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/fixtures/release"

setup() {
    setup_host_root
    export FIXTURE_RELEASE="${FIXTURES}/valid"
    export EVICT_LABELLED=1
    seed_env
}

# ---------------------------------------------------------------------------
# fixtures shared by the whole file
# ---------------------------------------------------------------------------

seed_env() {
    mkdir -p "${GREMION_ROOT}/etc/env" "${GREMION_ROOT}/runtime" "${GREMION_ROOT}/releases"
    # Hermetic docker config. Without it the credential guard would read the
    # DEVELOPER's own ~/.docker/config.json, so a box with a real registry login
    # would turn every happy-path test RED for a reason that has nothing to do
    # with the program. The surviving-auths test overrides this with its own.
    export DOCKER_CONFIG="${GREMION_ROOT}/dockercfg"
    mkdir -p "$DOCKER_CONFIG"
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=teststack
COMPOSE_PROJECT_NAME=teststack-state
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:docker-compose.state-pins.yml
COMPOSE_PROFILES=
PLATFORM_DOMAIN=example.org
SOAK_MINUTES=0
HEALTH_EXEMPT_SERVICES=minio-mc
INTERNAL_PUSH_SECRET=test-push-secret
EOF
    local c
    for c in blue green; do
        cat > "${GREMION_ROOT}/etc/env/app-${c}.env" <<EOF
STACK=teststack
COLOUR=${c}
COMPOSE_PROJECT_NAME=teststack-app-${c}
COMPOSE_FILE=docker-compose.app.yml:docker-compose.pins.yml
EOF
    done
    printf '{"ts":"2026-09-09T02:00:00Z","ok":true,"label":"daily","bytes":1000}\n' \
        > "${GREMION_ROOT}/runtime/last-backup.json"
    seed_trust_anchor
}

# TASK-046: step 2 verifies every first-party pinned digest against the host
# key. Every case gets the host key and a cosign that vouches for exactly the
# digest and repository it was asked about; section J breaks each on purpose.
# The key body is a placeholder (cosign is shimmed): no key material here.
seed_trust_anchor() {
    printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'placeholder-not-a-key' '-----END PUBLIC KEY-----' \
        > "${GREMION_ROOT}/etc/cosign.pub"
    # What `docker compose config --images` resolves: the canonical pins of
    # BOTH layers (docker-compose.pins.yml, docker-compose.state-pins.yml) plus
    # anything a test injects through EXTRA_RESOLVED (images compose would
    # pull although no canonical `image:` line names them). Every docker shim
    # in this file answers `compose … config --images` through this helper.
    # Like real compose, it leaves out services under an inactive profile
    # (PROFILED_RESOLVED) unless COMPOSE_PROFILES='*'; RESOLVE_OMIT drops the
    # canonical pins matching a pattern (a pin compose does not show).
    cat > "${GREMION_ROOT}/.resolve-images" <<'RESOLVE'
#!/usr/bin/env bash
# A missing layer fails here the way compose fails on a missing COMPOSE_FILE
# entry: never a quietly smaller image set (R28 review LOW).
for f in docker-compose.pins.yml docker-compose.state-pins.yml; do
    [ -r "$FIXTURE_RELEASE/$f" ] || { echo "resolve-images shim: $FIXTURE_RELEASE/$f missing" >&2; exit 1; }
done
cat "$FIXTURE_RELEASE/docker-compose.pins.yml" "$FIXTURE_RELEASE/docker-compose.state-pins.yml" \
    | grep -E '^[[:space:]]*image:' \
    | sed -E 's/^[[:space:]]*image:[[:space:]]*//; s/^["'\'']//; s/["'\'']$//' \
    | { if [ -n "${RESOLVE_OMIT:-}" ]; then grep -v -- "$RESOLVE_OMIT" || true; else cat; fi; }
[ -z "${EXTRA_RESOLVED:-}" ] || printf '%s\n' "$EXTRA_RESOLVED"
if [ -n "${PROFILED_RESOLVED:-}" ] && [ "${COMPOSE_PROFILES:-}" = '*' ]; then
    printf '%s\n' "$PROFILED_RESOLVED"
fi
exit "${RESOLVE_STATUS:-0}"
RESOLVE
    chmod +x "${GREMION_ROOT}/.resolve-images"
    # Like real cosign, the claim names the repository WITHOUT a tag (a
    # release is signed by digest), whatever tag the pin carries.
    shim cosign '
ref="${*: -1}"
repo="$(printf "%s" "${ref%@*}" | sed -E "s#:[^/:]+\$##" | tr "[:upper:]" "[:lower:]")"
printf "[{\"critical\":{\"identity\":{\"docker-reference\":\"%s\"},\"image\":{\"docker-manifest-digest\":\"%s\"},\"type\":\"cosign container image signature\"},\"optional\":null}]\n" "$repo" "${ref##*@}"
exit 0'
}

stub_git() {
    shim git '
# The program calls `git -C <dir> rev-parse …`, so the subcommand is NOT $1.
# Step over any leading -C <dir> pair before dispatching, exactly as git does.
while [ "$1" = "-C" ]; do shift 2; done
case "$1" in
  clone)
      dest="${*: -1}"
      mkdir -p "$dest"
      cp -R "$FIXTURE_RELEASE"/. "$dest"/
      mkdir -p "$dest/.git"
      exit 0 ;;
  rev-parse|rev-list)
      printf "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"; exit 0 ;;
esac
exit 0
'
}

# A stateful docker shim: "compose ... up -d" marks a colour up, "down" marks it
# down, and "ps -q" answers accordingly, so ordering assertions are real. The
# colour is read out of the --env-file path, exactly as the program passes it.
stub_docker() {
    shim docker '
st="$BATS_TEST_TMPDIR"
args="$*"
case "$args" in *app-green*|*c-green-*) c=green ;; *) c=blue ;; esac
case "$1" in
  login)    cat >/dev/null; printf "Login Succeeded\n"; exit 0 ;;
  logout)   exit 0 ;;
  manifest) printf "{\"config\":{\"size\":100},\"layers\":[{\"size\":1000},{\"size\":2000}]}\n"; exit 0 ;;
  image)    exit 0 ;;
  ps)
      case "$args" in
        *"gremion.evict=true"*)
            [ "${EVICT_LABELLED:-1}" = "1" ] && printf "teststack-app-%s-gremion-ui-1\n" "$c" ;;
      esac
      exit 0 ;;
  inspect)
      case "$args" in
        # the per-network alias query of assert_stack_isolation (TASK-040) also
        # contains "Aliases", so it is matched first.
        *"\$ep.Aliases"*)                 printf "%s_edge=gremion-ui-%s,ui-1, %s_state=gremion-ui-%s, \n" "$STACK" "$c" "$STACK" "$c" ;;
        *Aliases*)                      printf "gremion-ui-%s \n" "$c" ;;
        *ExposedPorts*)                 printf "3000/tcp \n" ;;
        # ORDER IS LOAD-BEARING: the mounts format is
        # `{{range .Mounts}}{{.Name}} {{end}}`, so it CONTAINS "{{.Name}}".
        # The narrower pattern has to come first or the mounts query answers
        # with the container name and the isolation guard reads garbage.
        *"range .Mounts"*)              printf "%s_tenant_secrets \n" "$STACK" ;;
        *"{{.Name}}"*)                  printf "/ui-1\n" ;;
        *"NetworkSettings.Networks"*)   printf "%s_edge %s_state \n" "$STACK" "$STACK" ;;
        *"com.docker.compose.service"*) printf "gremion-ui\n" ;;
        *"{{.State.Status}}"*)          printf "running\n" ;;
        *"{{.State.ExitCode}}"*)        printf "0\n" ;;
        *".State.Health"*)              printf "healthy\n" ;;
        *)                              printf "\n" ;;
      esac
      exit 0 ;;
  compose)
      case "$*" in *"config --images"*) "$GREMION_ROOT/.resolve-images"; exit $? ;; esac
      colour=""
      case "$args" in *app-blue.env*) colour=blue ;; *app-green.env*) colour=green ;; esac
      case "$args" in
        *" up -d"*)  [ -n "$colour" ] && : > "$st/up-$colour"; exit 0 ;;
        *" down"*)   [ -n "$colour" ] && rm -f "$st/up-$colour"; exit 0 ;;
        *" ps -a -q"*|*" ps -q"*)
            if [ -n "$colour" ] && [ -f "$st/up-$colour" ]; then printf "c-%s-1\n" "$colour"; fi
            exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0
'
}

stub_siblings() {
    shim gremion-render   'exit 0'
    shim gremion-snapshot 'exit 0'
    shim gremion-verify   'exit 0'
    shim gremion-switch   'printf "%s\n" "$1" > "$GREMION_ROOT/runtime/active-colour"; exit 0'
}

stub_all() { stub_git; stub_docker; stub_siblings; }

# ---------------------------------------------------------------------------
# A. structure
# ---------------------------------------------------------------------------

@test "gremion-deploy exists and is executable" {
    [[ -x "$DEPLOY" ]]
}

@test "gremion-deploy sets strict mode" {
    grep -q '^set -euo pipefail$' "$DEPLOY"
}

@test "gremion-deploy invokes compose only with --env-file (N20)" {
    run grep -nE 'docker compose( |$)' "$DEPLOY"
    [ "$status" -eq 0 ]
    ! grep -nE 'docker compose[^\n]*( -f | --profile | -p )' "$DEPLOY"
}

@test "gremion-deploy refuses to remove volumes" {
    # assert_absent, not `! grep`: this is the never-remove-volumes data-safety
    # constraint, and mid-body a !-negated grep cannot fail. The sibling test
    # above gets away with the same shape only because it is its body's last
    # statement.
    assert_absent 'down .*(-v|--volumes)' "$DEPLOY" \
        'gremion-deploy must never pass a volume-destroying flag to compose down'
    grep -q 'deploy never removes volumes' "$DEPLOY"
}

@test "gremion-deploy carries the shellcheck source directive" {
    grep -q '^# shellcheck source=../lib/common.sh$' "$DEPLOY"
}

# ---------------------------------------------------------------------------
# B. usage and preconditions
# ---------------------------------------------------------------------------

@test "no tag argument exits 2 with usage" {
    run "$DEPLOY"
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: gremion-deploy"* ]]
}

@test "a malformed tag exits 2" {
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' v1.2.3"
    [ "$status" -eq 2 ]
    [[ "$output" == *"invalid tag: v1.2.3"* ]]
}

@test "an empty stdin exits 2 with the token message" {
    # docker is shimmed here only so the tool census (need_cmd) cannot pre-empt
    # the assertion: the linux bats runner carries no docker binary, and a
    # census failure would satisfy `status -eq 2` for entirely the wrong reason.
    shim docker 'exit 0'
    run bash -c "printf '' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no registry token on stdin"* ]]
}

# ---------------------------------------------------------------------------
# D. the registry credential (N12)
# ---------------------------------------------------------------------------

@test "the token is passed to docker login on stdin and logged out afterwards" {
    stub_all
    run bash -c "printf 'TOKEN sekrit-token\n' | '$DEPLOY' dist-v1.2.3"
    assert_recorded docker "login ghcr.io -u x-access-token --password-stdin"
    assert_recorded docker "logout ghcr.io"
    [[ "$output" != *"sekrit-token"* ]]
}

@test "the token never reaches disk" {
    stub_all
    run bash -c "printf 'TOKEN sekrit-token\n' | '$DEPLOY' dist-v1.2.3"
    run grep -rl 'sekrit-token' "$GREMION_ROOT" "$BATS_TEST_TMPDIR"
    [ "$status" -ne 0 ]
}

@test "a surviving auths entry fails the deploy with exit 1" {
    stub_all
    export DOCKER_CONFIG="${BATS_TEST_TMPDIR}/dockercfg"
    mkdir -p "$DOCKER_CONFIG"
    # The auth blob is BUILT here, not pasted. A committed base64 literal of
    # "<user>:<password>" is high-entropy enough that gitleaks reports the
    # fixture as a finding, and this repo's .gitleaks.toml allowlists by VALUE
    # rather than by path precisely so test files stay scanned — so the fixture
    # must not look like a leak in the first place.
    local blob
    blob="$(printf 'x-access-token:not-a-real-token' | base64)"
    # Pretty-printed, exactly as docker writes it: a single-line grep cannot see
    # this, jq can. That is why the guard is written with jq.
    cat > "${DOCKER_CONFIG}/config.json" <<EOF
{
  "auths": {
    "ghcr.io": {
      "auth": "${blob}"
    }
  }
}
EOF
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"registry credential survived logout"* ]]
}

# ---------------------------------------------------------------------------
# C. release.json and pins validation, and the spec-B refusal
# ---------------------------------------------------------------------------

@test "a release tree without docker-compose.app.yml exits 3 BLOCKED" {
    stub_all
    local strip="${BATS_TEST_TMPDIR}/strip"
    mkdir -p "$strip"
    cp -R "${FIXTURES}/valid"/. "$strip"/
    rm -f "$strip/docker-compose.app.yml"
    export FIXTURE_RELEASE="$strip"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: docker-compose.app.yml absent (spec B)"* ]]
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
}

@test "a release tree without the signed waiver ledger is refused at step 2" {
    # gremion-verify hard-dies (exit 2) without docs/ops/release-1-waivers.md,
    # and steps 9 and 11 are the only places that ran it - step 9 AFTER step 6
    # has stopped the old colour and step 7 has applied migrations. Discovered
    # there, a release tree with no ledger left the host with migrations
    # applied, the old colour down and no verified colour. The ledger is a
    # release-tree contract like the other three, so it is refused where they
    # are: step 2, before the token is used on a pull and long before anything
    # is stopped. The post-condition is the steps that did NOT run.
    stub_all
    local strip="${BATS_TEST_TMPDIR}/no-ledger"
    mkdir -p "$strip"
    cp -R "${FIXTURES}/valid"/. "$strip"/
    rm -f "$strip/docs/ops/release-1-waivers.md"
    [ ! -f "$strip/docs/ops/release-1-waivers.md" ]
    export FIXTURE_RELEASE="$strip"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: docs/ops/release-1-waivers.md absent (spec B)"* ]]
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
    # Nothing past step 2 may have run: no stop, no migrate, no start, no
    # verify. A count, not a `! grep`, so a renamed step cannot pass vacuously.
    run bash -c "grep -cE ' STEP (6|7|8|9|10|11|12) ' '${GREMION_ROOT}/runtime/deploy.log'"
    [ "$output" = "0" ]
    # ... and the step that DID run is in the same log, so the grep above was
    # reading a real file and not an empty one.
    run bash -c "grep -cE ' STEP 2 ' '${GREMION_ROOT}/runtime/deploy.log'"
    [ "$output" = "1" ]
}

@test "an exported GREMION_WAIVER_LEDGER is honoured by step 2 and both verify steps" {
    # docs/ops/host-tooling.md offers this as THE recovery for a release tree
    # with no ledger - a rollback to a tag cut before the ledger existed. It
    # was inert in the path that meets the failure: steps 9 and 11 set
    # GREMION_WAIVER_LEDGER as a bare command prefix, which overrides whatever
    # the operator exported, so the documented workaround changed nothing.
    stub_all
    local strip="${BATS_TEST_TMPDIR}/no-ledger"
    mkdir -p "$strip"
    cp -R "${FIXTURES}/valid"/. "$strip"/
    rm -f "$strip/docs/ops/release-1-waivers.md"
    export FIXTURE_RELEASE="$strip"
    local own="${BATS_TEST_TMPDIR}/operator-ledger.md"
    cp "${PROJECT_ROOT}/docs/ops/release-1-waivers.md" "$own"
    export GREMION_WAIVER_LEDGER="$own"
    shim gremion-verify 'printf "%s\n" "${GREMION_WAIVER_LEDGER:-UNSET}" >> "${GREMION_ROOT}/runtime/verify-ledger.log"; exit 0'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    # Again post-conditions, not the run's status: step 12 creates $ROOT/current
    # with ln -s, which a Windows working copy cannot do.
    grep -qE ' STEP 2 checkout ok$'       "${GREMION_ROOT}/runtime/deploy.log"
    grep -qE ' STEP 9 verify-colour ok$'  "${GREMION_ROOT}/runtime/deploy.log"
    grep -qE ' STEP 11 verify-public ok$' "${GREMION_ROOT}/runtime/deploy.log"
    [ "$(wc -l < "${GREMION_ROOT}/runtime/verify-ledger.log")" -eq 2 ]
    run bash -c "sort -u '${GREMION_ROOT}/runtime/verify-ledger.log'"
    [ "$output" = "$own" ]
}

@test "release.json without overlap fails with exit 1" {
    stub_all
    export FIXTURE_RELEASE="${FIXTURES}/missing-overlap"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"release.json overlap is not a boolean"* ]]
}

@test "a tag-only image in the pins layer fails with exit 1 and names it" {
    stub_all
    export FIXTURE_RELEASE="${FIXTURES}/unpinned"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"unpinned image"* ]]
    [[ "$output" == *"gremion-ui:dist-v1.2.3"* ]]
}

@test "release.json naming a different tag fails with exit 1" {
    stub_all
    local skew="${BATS_TEST_TMPDIR}/skew"
    mkdir -p "$skew"
    cp -R "${FIXTURES}/valid"/. "$skew"/
    sed -i 's/dist-v1.2.3/dist-v9.9.9/' "$skew/release.json"
    export FIXTURE_RELEASE="$skew"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"release.json tag mismatch"* ]]
}

@test "the release tree is checked out at the tag from GREMION_SOURCE_URL" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    assert_recorded git "clone --depth 1 --branch dist-v1.2.3"
    [ -f "${GREMION_ROOT}/releases/dist-v1.2.3/release.json" ]
}

# ---------------------------------------------------------------------------
# E. free space and the pull (§F.4.3)
# ---------------------------------------------------------------------------

@test "a missing last-backup.json is a precondition failure (exit 2)" {
    stub_all
    rm -f "${GREMION_ROOT}/runtime/last-backup.json"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 2 ]
    [[ "$output" == *"last-backup.json absent"* ]]
}

@test "insufficient free space aborts before pulling" {
    stub_all
    shim df 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/vda4 1000 999 1 100%% /\n"'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"insufficient free space"* ]]
    run grep -c 'compose .* pull' "$SHIM_LOG"
    [ "$output" = "0" ]
}

@test "the pull is asserted by image inspect, not by its exit code" {
    stub_all
    shim docker '
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  manifest) printf "{\"config\":{\"size\":1},\"layers\":[{\"size\":1}]}\n"; exit 0 ;;
  image) exit 1 ;;
  compose) case "$*" in *"config --images"*) "$GREMION_ROOT/.resolve-images"; exit $? ;; esac; exit 0 ;;
esac
exit 0
'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"image absent after pull"* ]]
}

# ---------------------------------------------------------------------------
# F. render, snapshot, overlap ordering, migrate (§F.4.4 – §F.4.7)
# ---------------------------------------------------------------------------

@test "the renderer and the snapshot run against this release" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    assert_recorded gremion-render "--release ${GREMION_ROOT}/releases/dist-v1.2.3"
    assert_recorded gremion-snapshot "dist-v1.2.3"
}

@test "overlap true leaves the old colour running until after the switch" {
    stub_all
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    : > "${BATS_TEST_TMPDIR}/up-blue"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    # the only `app-blue.env … down` is the post-soak one, after the switch
    run bash -c "grep -c 'app-blue.env.* down' '$SHIM_LOG'"
    [ "${output// /}" = "1" ]
    run bash -c "grep -n 'gremion-switch' '$SHIM_LOG' | head -1 | cut -d: -f1"
    switch_line="$output"
    run bash -c "grep -n 'app-blue.env.* down' '$SHIM_LOG' | head -1 | cut -d: -f1"
    [ "$output" -gt "$switch_line" ]
}

@test "overlap false stops the old colour BEFORE the migrate run" {
    stub_all
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    : > "${BATS_TEST_TMPDIR}/up-blue"
    local ov="${BATS_TEST_TMPDIR}/nooverlap"
    mkdir -p "$ov"; cp -R "${FIXTURES}/valid"/. "$ov"/
    sed -i 's/"overlap": true/"overlap": false/' "$ov/release.json"
    export FIXTURE_RELEASE="$ov"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    run bash -c "grep -n 'app-blue.env.* down' '$SHIM_LOG' | head -1 | cut -d: -f1"
    down_line="$output"
    run bash -c "grep -n 'run --rm migrate' '$SHIM_LOG' | head -1 | cut -d: -f1"
    [ "$down_line" -lt "$output" ]
}

@test "the migrate job runs against the NEW colour's env file" {
    stub_all
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    assert_recorded docker "--env-file ${GREMION_ROOT}/etc/env/app-green.env run --rm migrate"
}

@test "a surviving migrate container fails the deploy" {
    stub_git; stub_siblings
    shim docker '
args="$*"
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  manifest) printf "{\"config\":{\"size\":1},\"layers\":[{\"size\":1}]}\n"; exit 0 ;;
  image) exit 0 ;;
  ps) printf "leftover-migrate\n"; exit 0 ;;
  compose) case "$*" in *"config --images"*) "$GREMION_ROOT/.resolve-images"; exit $? ;; esac; exit 0 ;;
esac
exit 0
'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"migrate container survived --rm"* ]]
}

# ---------------------------------------------------------------------------
# G. starting the inactive colour (§F.4.8, §E stack isolation, evict targets)
# ---------------------------------------------------------------------------

@test "the inactive colour is blue on a first deploy and green when blue is active" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    assert_recorded docker "--env-file ${GREMION_ROOT}/etc/env/app-blue.env up -d"
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    : > "${SHIM_LOG}"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    assert_recorded docker "--env-file ${GREMION_ROOT}/etc/env/app-green.env up -d"
}

@test "a container mounting a foreign stack's volume fails the deploy and stops the colour" {
    stub_git; stub_siblings
    shim docker '
st="$BATS_TEST_TMPDIR"
args="$*"
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  manifest) printf "{\"config\":{\"size\":1},\"layers\":[{\"size\":1}]}\n"; exit 0 ;;
  image) exit 0 ;;
  ps) exit 0 ;;
  inspect)
      case "$args" in
        *"range .Mounts"*)            printf "otherstack_tenant_secrets \n" ;;
        *"{{.Name}}"*)                printf "/ui-1\n" ;;
        *"NetworkSettings.Networks"*) printf "%s_edge \n" "$STACK" ;;
        *)                            printf "\n" ;;
      esac
      exit 0 ;;
  compose)
      case "$*" in *"config --images"*) "$GREMION_ROOT/.resolve-images"; exit $? ;; esac
      case "$args" in
        *" up -d"*) : > "$st/up-blue"; exit 0 ;;
        *" down"*)  rm -f "$st/up-blue"; exit 0 ;;
        *" ps -a -q"*|*" ps -q"*) [ -f "$st/up-blue" ] && printf "c1\n"; exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0
'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"mounts foreign volume 'otherstack_tenant_secrets'"* ]]
    [ ! -f "${BATS_TEST_TMPDIR}/up-blue" ]
}

@test "a container on a foreign network fails the deploy" {
    stub_git; stub_siblings
    shim docker '
st="$BATS_TEST_TMPDIR"
args="$*"
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  manifest) printf "{\"config\":{\"size\":1},\"layers\":[{\"size\":1}]}\n"; exit 0 ;;
  image) exit 0 ;;
  ps) exit 0 ;;
  inspect)
      case "$args" in
        *"range .Mounts"*)            printf "\n" ;;
        *"{{.Name}}"*)                printf "/ui-1\n" ;;
        *"NetworkSettings.Networks"*) printf "otherstack_edge \n" ;;
        *)                            printf "\n" ;;
      esac
      exit 0 ;;
  compose)
      case "$*" in *"config --images"*) "$GREMION_ROOT/.resolve-images"; exit $? ;; esac
      case "$args" in
        *" up -d"*) : > "$st/up-blue"; exit 0 ;;
        *" down"*)  rm -f "$st/up-blue"; exit 0 ;;
        *" ps -a -q"*|*" ps -q"*) [ -f "$st/up-blue" ] && printf "c1\n"; exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0
'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"attached to foreign network 'otherstack_edge'"* ]]
}

# TASK-040: the alias half of assert_stack_isolation. The shim answers mounts
# and networks exactly like a healthy colour; only the aliases differ.
alias_shim() { # <answer to the per-network alias query>
    printf '%s' "$1" > "${BATS_TEST_TMPDIR}/alias-answer"
    shim docker '
st="$BATS_TEST_TMPDIR"
args="$*"
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  manifest) printf "{\"config\":{\"size\":1},\"layers\":[{\"size\":1}]}\n"; exit 0 ;;
  image) exit 0 ;;
  ps) exit 0 ;;
  inspect)
      case "$args" in
        *"\$ep.Aliases"*)           cat "$st/alias-answer"; printf "\n" ;;
        *"range .Mounts"*)              printf "%s_tenant_secrets \n" "$STACK" ;;
        *"{{.Name}}"*)                  printf "/ui-1\n" ;;
        *"NetworkSettings.Networks"*)   printf "%s_edge %s_state \n" "$STACK" "$STACK" ;;
        *"com.docker.compose.service"*) printf "gremion-ui\n" ;;
        *)                              printf "\n" ;;
      esac
      exit 0 ;;
  compose)
      case "$*" in *"config --images"*) "$GREMION_ROOT/.resolve-images"; exit $? ;; esac
      case "$args" in
        *" up -d"*) : > "$st/up-blue"; exit 0 ;;
        *" down"*)  rm -f "$st/up-blue"; exit 0 ;;
        *" ps -a -q"*|*" ps -q"*) [ -f "$st/up-blue" ] && printf "c1\n"; exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0
'
}

@test "an app container without its <service>-<colour> alias fails isolation and stops the colour" {
    stub_git; stub_siblings
    # on both shared networks, but answering only to the bare service name
    alias_shim "teststack_edge=gremion-ui,ui-1, teststack_state=gremion-ui, "
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"on 'teststack_edge' carries no 'gremion-ui-blue' alias"* ]]
    [[ "$output" == *"stack isolation violated"* ]]
    [ ! -f "${BATS_TEST_TMPDIR}/up-blue" ]
}

@test "the other colour's alias, or the alias on one shared network only, fails isolation" {
    stub_git; stub_siblings
    alias_shim "teststack_edge=gremion-ui-green, teststack_state=gremion-ui-green, "
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"carries no 'gremion-ui-blue' alias"* ]]
    # aliased on _edge, bare on _state: the _state hop is still ambiguous
    alias_shim "teststack_edge=gremion-ui-blue, teststack_state=gremion-ui, "
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"on 'teststack_state' carries no 'gremion-ui-blue' alias"* ]]
    [ ! -f "${BATS_TEST_TMPDIR}/up-blue" ]
}

@test "an exempt one-shot service must have exited 0, not be running forever" {
    stub_git; stub_siblings
    shim docker '
st="$BATS_TEST_TMPDIR"
args="$*"
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  manifest) printf "{\"config\":{\"size\":1},\"layers\":[{\"size\":1}]}\n"; exit 0 ;;
  image) exit 0 ;;
  ps) exit 0 ;;
  inspect)
      case "$args" in
        *"range .Mounts"*)              printf "\n" ;;
        *"{{.Name}}"*)                  printf "/mc-1\n" ;;
        *"\$ep.Aliases"*)                 printf "%s_state=minio-mc-blue, \n" "$STACK" ;;
        *"NetworkSettings.Networks"*)   printf "%s_state \n" "$STACK" ;;
        *"com.docker.compose.service"*) printf "minio-mc\n" ;;
        *"{{.State.Status}}"*)          printf "exited\n" ;;
        *"{{.State.ExitCode}}"*)        printf "1\n" ;;
        *".State.Health"*)              printf "none\n" ;;
        *)                              printf "\n" ;;
      esac
      exit 0 ;;
  compose)
      case "$*" in *"config --images"*) "$GREMION_ROOT/.resolve-images"; exit $? ;; esac
      case "$args" in
        *" up -d"*) : > "$st/up-blue"; exit 0 ;;
        *" down"*)  rm -f "$st/up-blue"; exit 0 ;;
        *" ps -a -q"*|*" ps -q"*) [ -f "$st/up-blue" ] && printf "c1\n"; exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0
'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"exempt service minio-mc is exited with exit code 1"* ]]
}

@test "the colour records the tag it holds" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$(cat "${GREMION_ROOT}/runtime/colour-blue-tag")" = "dist-v1.2.3" ]
}

@test "the started colour's evict targets are written for gremion-switch" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 0 ]
    run jq -c . "${GREMION_ROOT}/runtime/evict-targets.json"
    [ "$output" = '[{"container":"teststack-app-blue-gremion-ui-1","url":"http://gremion-ui-blue:3000/api/internal/evict"}]' ]
    # the bearer stays in state.env; the targets file never carries it
    ! grep -q 'test-push-secret' "${GREMION_ROOT}/runtime/evict-targets.json"
}

@test "a colour whose containers carry no gremion.evict label fails the deploy" {
    stub_all
    export EVICT_LABELLED=0
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"carries label gremion.evict=true"* ]]
}

@test "a state.env without INTERNAL_PUSH_SECRET is a precondition failure (exit 2)" {
    stub_all
    sed -i '/^INTERNAL_PUSH_SECRET=/d' "${GREMION_ROOT}/etc/env/state.env"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 2 ]
    [[ "$output" == *"INTERNAL_PUSH_SECRET absent from state.env"* ]]
}

# ---------------------------------------------------------------------------
# H. verify, switch, record, soak (§F.4.9 – §F.4.12)
# ---------------------------------------------------------------------------

@test "the happy path runs all twelve steps and logs each one ok" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 0 ]
    local n
    for n in 1 2 3 4 5 6 7 8 9 10 11 12; do
        grep -qE " STEP ${n} [a-z-]+ ok$" "${GREMION_ROOT}/runtime/deploy.log" \
            || { echo "missing: STEP ${n} … ok"; return 1; }
    done
    # The run that proves no step is skipped is exactly the run where a
    # !-negated grep would report ok whatever the log said.
    assert_absent ' SKIP ' "${GREMION_ROOT}/runtime/deploy.log" \
        'a step was skipped in the run that exists to prove none are'
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "dist-v1.2.3" ]
    [[ "$output" == *"DEPLOY-RESULT: tag=dist-v1.2.3 colour=blue overlap=true switched=yes soak-minutes=0"* ]]
}

@test "the inactive colour is verified before the switch and the public edge after it" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    assert_recorded gremion-verify "--colour blue"
    run bash -c "grep -n 'gremion-verify --colour blue' '$SHIM_LOG' | head -1 | cut -d: -f1"
    pre="$output"
    run bash -c "grep -n 'gremion-switch blue' '$SHIM_LOG' | head -1 | cut -d: -f1"
    sw="$output"
    run bash -c "grep -n 'gremion-verify' '$SHIM_LOG' | tail -1 | cut -d: -f1"
    [ "$pre" -lt "$sw" ]
    [ "$sw" -lt "$output" ]
}

@test "both verify steps read the waiver ledger out of the release being deployed" {
    # The verifier hard-dies without the signed ledger and resolves it from
    # $(gremion_root)/current unless told otherwise. current/ is moved onto the
    # new release in step 12 - AFTER both verify steps - and bootstrap.sh never
    # creates it, so steps 9 and 11 must name the release tree themselves. Left
    # to the default, the first deploy on a fresh host aborts at step 9 with
    # exit 2 and every later deploy verifies release N+1 while printing release
    # N's waivers.
    stub_all
    shim gremion-verify 'printf "%s\n" "${GREMION_WAIVER_LEDGER:-UNSET}" >> "${GREMION_ROOT}/runtime/verify-ledger.log"; exit 0'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    # The post-condition is what steps 9 and 11 DID, not the run's exit code:
    # step 12 creates $ROOT/current with ln -s, which a Windows working copy
    # cannot do, so this deploy's own status carries no information about the
    # two steps this test is about. (The sibling test that owns step 12 fails
    # on this box for the same pre-existing reason.)
    grep -qE ' STEP 9 verify-colour ok$'  "${GREMION_ROOT}/runtime/deploy.log"
    grep -qE ' STEP 11 verify-public ok$' "${GREMION_ROOT}/runtime/deploy.log"
    [ "$(wc -l < "${GREMION_ROOT}/runtime/verify-ledger.log")" -eq 2 ]
    run bash -c "sort -u '${GREMION_ROOT}/runtime/verify-ledger.log'"
    [ "$output" = "${GREMION_ROOT}/releases/dist-v1.2.3/docs/ops/release-1-waivers.md" ]
}

@test "the runtime tag files and the current symlink are recorded" {
    stub_all
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/current-tag"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "dist-v1.0.0" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "dist-v1.2.3" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/dist-v1.2.3" ]
}

@test "the old colour is stopped only after the soak window" {
    stub_all
    printf 'blue\n'        > "${GREMION_ROOT}/runtime/active-colour"
    printf 'dist-v1.0.0\n' > "${GREMION_ROOT}/runtime/colour-blue-tag"
    : > "${BATS_TEST_TMPDIR}/up-blue"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3 --soak-minutes 0"
    [ "$status" -eq 0 ]
    [[ "$output" == *"SOAK-START minutes=0 colour=blue"* ]]
    [[ "$output" == *"SOAK-END colour=blue"* ]]
    [ ! -f "${BATS_TEST_TMPDIR}/up-blue" ]
    [ ! -f "${GREMION_ROOT}/runtime/colour-blue-tag" ]
}

@test "--no-switch stops after step 9 and skips 10, 11 and 12" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3 --no-switch"
    [ "$status" -eq 0 ]
    grep -qE " SKIP 10 switch --no-switch$"        "${GREMION_ROOT}/runtime/deploy.log"
    grep -qE " SKIP 11 verify-public --no-switch$" "${GREMION_ROOT}/runtime/deploy.log"
    grep -qE " SKIP 12 record --no-switch$"        "${GREMION_ROOT}/runtime/deploy.log"
    assert_absent 'gremion-switch' "$SHIM_LOG" \
        '--no-switch invoked gremion-switch anyway'
    [ ! -f "${GREMION_ROOT}/runtime/current-tag" ]
    [[ "$output" == *"switched=no"* ]]
}

@test "a switch that does not take effect fails the deploy" {
    stub_git; stub_docker
    shim gremion-render   'exit 0'
    shim gremion-snapshot 'exit 0'
    shim gremion-verify   'exit 0'
    shim gremion-switch   'exit 0'   # writes no runtime/active-colour
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"runtime/active-colour is 'none' after switching to blue"* ]]
}

# ---------------------------------------------------------------------------
# I. option arity (the dangling-final-option finding)
# ---------------------------------------------------------------------------

@test "a dangling --soak-minutes exits 2 and names the option" {
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3 --soak-minutes"
    [ "$status" -eq 2 ]
    [[ "$output" == *"option --soak-minutes needs a value"* ]]
}

# ---------------------------------------------------------------------------
# J. first-party image signatures (TASK-046, TRD-441)
# ---------------------------------------------------------------------------

@test "every first-party pinned digest is verified with the host key before any manifest read or pull" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 0 ]
    local img
    for img in gremion-ui@sha256:1111111111111111111111111111111111111111111111111111111111111111 \
               gremion-public@sha256:2222222222222222222222222222222222222222222222222222222222222222 \
               gremion-migrate@sha256:3333333333333333333333333333333333333333333333333333333333333333; do
        assert_recorded cosign "verify --key ${GREMION_ROOT}/etc/cosign.pub --insecure-ignore-tlog=true --output json ghcr.io/hello-n00del/${img}"
    done
    [[ "$output" == *"6 first-party image(s) verified against ${GREMION_ROOT}/etc/cosign.pub"* ]]
    # Order: the last verify precedes the first manifest read and the first pull.
    local last_verify first_manifest first_pull
    last_verify="$(grep -n '^cosign verify' "$SHIM_LOG" | tail -1 | cut -d: -f1)"
    first_manifest="$(grep -n '^docker manifest inspect' "$SHIM_LOG" | head -1 | cut -d: -f1)"
    first_pull="$(grep -n '^docker compose .* pull' "$SHIM_LOG" | head -1 | cut -d: -f1)"
    [ -n "$last_verify" ] && [ -n "$first_manifest" ] && [ -n "$first_pull" ]
    [ "$last_verify" -lt "$first_manifest" ]
    [ "$last_verify" -lt "$first_pull" ]
}

@test "a failing signature verification dies at step 2, before any compose pull" {
    stub_all
    shim cosign 'printf "Error: no matching signatures\n" >&2; exit 12'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"signature verification failed for ghcr.io/hello-n00del/gremion-"* ]]
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
    # The call log proves what did NOT happen: the verifier ran, no manifest
    # was read and nothing was pulled. Counts, not `! grep`.
    [ "$(grep -c '^cosign verify' "$SHIM_LOG")" -ge 1 ]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
    [ "$(grep -c '^docker manifest' "$SHIM_LOG")" -eq 0 ]
    [ "$(grep -cE ' STEP (3|4|5|6|7|8|9|10|11|12) ' "${GREMION_ROOT}/runtime/deploy.log")" -eq 0 ]
}

@test "a cosign that exits 0 but vouches for another digest is refused" {
    stub_all
    shim cosign '
ref="${*: -1}"
printf "[{\"critical\":{\"identity\":{\"docker-reference\":\"%s\"},\"image\":{\"docker-manifest-digest\":\"sha256:%064d\"}}}]\n" "${ref%@*}" 0
exit 0'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no claim binds sha256:"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a cosign that vouches for the digest under another repository is refused" {
    stub_all
    shim cosign '
ref="${*: -1}"
printf "[{\"critical\":{\"identity\":{\"docker-reference\":\"ghcr.io/someone-else/x\"},\"image\":{\"docker-manifest-digest\":\"%s\"}}}]\n" "${ref##*@}"
exit 0'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no claim binds"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a missing host trust anchor is a refusal at step 2, never a skip" {
    stub_all
    rm -f "${GREMION_ROOT}/etc/cosign.pub"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"trust anchor absent: ${GREMION_ROOT}/etc/cosign.pub"* ]]
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
    [ "$(grep -c '^cosign' "$SHIM_LOG")" -eq 0 ]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a symlinked host trust anchor is refused (the anchor is a file the host owns)" {
    stub_all
    mv "${GREMION_ROOT}/etc/cosign.pub" "${BATS_TEST_TMPDIR}/elsewhere.pub"
    ln -s "${BATS_TEST_TMPDIR}/elsewhere.pub" "${GREMION_ROOT}/etc/cosign.pub"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"trust anchor absent"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a cosign.pub shipped in the release tree is never passed to cosign" {
    stub_all
    local tree="${BATS_TEST_TMPDIR}/treekey"
    mkdir -p "$tree"; cp -R "${FIXTURES}/valid"/. "$tree"/
    printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'tree-placeholder' '-----END PUBLIC KEY-----' > "$tree/cosign.pub"
    export FIXTURE_RELEASE="$tree"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 0 ]
    [ "$(grep -c "^cosign verify --key ${GREMION_ROOT}/etc/cosign.pub " "$SHIM_LOG")" -eq 6 ]
    [ "$(grep -c 'releases/dist-v1.2.3/cosign.pub' "$SHIM_LOG")" -eq 0 ]
}

@test "a pins layer with no first-party image is refused, not passed vacuously" {
    stub_all
    local tp="${BATS_TEST_TMPDIR}/thirdparty"
    mkdir -p "$tp"; cp -R "${FIXTURES}/valid"/. "$tp"/
    cat > "$tp/docker-compose.pins.yml" <<'PINS'
services:
  postgres:
    image: docker.io/library/redis@sha256:4444444444444444444444444444444444444444444444444444444444444444
PINS
    # TASK-048b: the state layer is first-party too; empty it as well.
    printf 'services: {}\n' > "$tp/docker-compose.state-pins.yml"
    export FIXTURE_RELEASE="$tp"
    printf 'docker.io/library/redis\n' > "${GREMION_ROOT}/etc/third-party-images"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no first-party image"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "cosign missing from the host is a refusal, never a skip" {
    stub_all
    rm -f "${SHIM_DIR}/cosign"
    # A dev box may carry a real cosign; it then fails on the synthetic
    # digests instead. Either way: refused at step 2, nothing pulled.
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    if command -v cosign >/dev/null 2>&1; then
        [[ "$output" == *"signature verification failed"* ]]
    else
        [[ "$output" == *"cosign not on PATH"* ]]
    fi
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a pin renamed out of the first-party prefix is refused unless the HOST lists it as third-party" {
    # The tree picks image names. Were "not first-party" to mean "skip", one
    # signed image would carry any number of unsigned ones renamed elsewhere.
    stub_all
    local mix="${BATS_TEST_TMPDIR}/mixed"
    mkdir -p "$mix"; cp -R "${FIXTURES}/valid"/. "$mix"/
    cat > "$mix/docker-compose.pins.yml" <<'PINS'
services:
  gremion-ui:
    build: !reset null
    image: ghcr.io/hello-n00del/gremion-ui@sha256:1111111111111111111111111111111111111111111111111111111111111111
  gremion-public:
    build: !reset null
    image: docker.io/evil/gremion-public@sha256:2222222222222222222222222222222222222222222222222222222222222222
  migrate:
    build: !reset null
    image: ghcr.io:443/hello-n00del/gremion-migrate@sha256:3333333333333333333333333333333333333333333333333333333333333333
PINS
    export FIXTURE_RELEASE="$mix"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"is neither first-party"*"nor on the host third-party list"* ]]
    [[ "$output" == *"docker.io/evil/gremion-public@sha256:2222"* ]]
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a third-party pin listed in the host's etc/third-party-images passes unverified; first-party still verified" {
    stub_all
    local mix="${BATS_TEST_TMPDIR}/withpg"
    mkdir -p "$mix"; cp -R "${FIXTURES}/valid"/. "$mix"/
    cat >> "$mix/docker-compose.pins.yml" <<'PINS'
  postgres:
    image: docker.io/library/redis@sha256:4444444444444444444444444444444444444444444444444444444444444444
PINS
    export FIXTURE_RELEASE="$mix"
    printf '# third-party repositories this host may run unsigned (digest-pinned)\ndocker.io/library/redis\n' \
        > "${GREMION_ROOT}/etc/third-party-images"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 0 ]
    [ "$(grep -c '^cosign verify' "$SHIM_LOG")" -eq 6 ]
    [ "$(grep -c 'redis' "$SHIM_LOG" | tr -d ' ')" -eq 0 ] || ! grep -q '^cosign verify.*redis' "$SHIM_LOG"
    [[ "$output" == *"1 third-party image(s) on the host list"* ]]
}

@test "an image declared in any non-canonical form in the pins layer is refused, not skipped" {
    # The gate reads `image:` lines; a flow mapping or a quoted key would be
    # pulled by compose but never seen by it. Any such line is a refusal.
    stub_all
    local body
    for body in '  evil: {image: ghcr.io/hello-n00del/evil@sha256:5555555555555555555555555555555555555555555555555555555555555555}' \
                '  evil:
    "image": ghcr.io/hello-n00del/evil@sha256:5555555555555555555555555555555555555555555555555555555555555555' \
                '  evil:
    image: ghcr.io/hello-n00del/evil@sha256:5555555555555555555555555555555555555555555555555555555555555555 # pinned'; do
        local tree="${BATS_TEST_TMPDIR}/odd-$RANDOM"
        mkdir -p "$tree"; cp -R "${FIXTURES}/valid"/. "$tree"/
        printf '%s\n' "$body" >> "$tree/docker-compose.pins.yml"
        export FIXTURE_RELEASE="$tree"
        rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
        : > "$SHIM_LOG"
        run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
        [ "$status" -eq 1 ] || { echo "accepted: $body"; return 1; }
        [[ "$output" == *"unrecognised image declaration"* || "$output" == *"pin is not <repo>@sha256"* ]] || { echo "$output"; return 1; }
        [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
    done
}


# The gate verifies what COMPOSE resolves (`config --images` over the state
# project and both colours), not what a grep of the pins file finds: escaped
# keys, anchors/merge keys, a second YAML document, `extends:` or a service in
# docker-compose.app.yml all resolve to images the grep never sees.
@test "an image compose resolves but no canonical pins line names is refused when unlisted" {
    stub_all
    export EXTRA_RESOLVED="docker.io/evil/x@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker.io/evil/x@sha256:5555"*"is neither first-party"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
    [ "$(grep -c 'config --images' "$SHIM_LOG")" -ge 3 ]
}

@test "a first-party image only compose resolves is signature-verified too" {
    stub_all
    export EXTRA_RESOLVED="ghcr.io/hello-n00del/evil@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    shim cosign '
ref="${*: -1}"
case "$ref" in *5555*) echo "Error: no signatures found" >&2; exit 10 ;; esac
printf "[{\"critical\":{\"identity\":{\"docker-reference\":\"%s\"},\"image\":{\"docker-manifest-digest\":\"%s\"}}}]\n" "${ref%@*}" "${ref##*@}"'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"signature verification failed for ghcr.io/hello-n00del/evil@sha256:5555"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a tag-only image resolved by compose is refused" {
    stub_all
    export EXTRA_RESOLVED="docker.io/evil/y:latest"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"pin is not <repo>@sha256:<64 hex>: docker.io/evil/y:latest"* ]]
}

@test "compose failing to resolve the image set is a refusal, never a skip" {
    stub_all
    export RESOLVE_STATUS=1
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot resolve the image set"* ]]
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

# ---------------------------------------------------------------------------
# J2. intake round 1 (TASK-046): tag@digest pins and profiled services
# ---------------------------------------------------------------------------

@test "a third-party tag@digest pin (the pin-images.sh form) matches the host list's tagless repository" {
    stub_all
    local mix="${BATS_TEST_TMPDIR}/pgtag"
    mkdir -p "$mix"; cp -R "${FIXTURES}/valid"/. "$mix"/
    cat >> "$mix/docker-compose.pins.yml" <<'PINS'
  postgres:
    image: redis:7-alpine@sha256:4444444444444444444444444444444444444444444444444444444444444444
PINS
    export FIXTURE_RELEASE="$mix"
    local listed
    # The host may list the canonical docker.io name or the short one compose prints.
    for listed in docker.io/library/redis redis; do
        printf '%s\n' "$listed" > "${GREMION_ROOT}/etc/third-party-images"
        rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
        : > "$SHIM_LOG"
        run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
        [ "$status" -eq 0 ] || { echo "host list '$listed': $output"; return 1; }
        [[ "$output" == *"6 first-party image(s) verified"*"1 third-party image(s) on the host list"* ]]
        [ "$(grep -c '^cosign verify.*redis' "$SHIM_LOG")" -eq 0 ]
    done
}

@test "a tag@digest third-party pin is still refused when the host lists another repository" {
    stub_all
    local mix="${BATS_TEST_TMPDIR}/pgother"
    mkdir -p "$mix"; cp -R "${FIXTURES}/valid"/. "$mix"/
    cat >> "$mix/docker-compose.pins.yml" <<'PINS'
  postgres:
    image: evil/redis:7-alpine@sha256:4444444444444444444444444444444444444444444444444444444444444444
PINS
    export FIXTURE_RELEASE="$mix"
    printf 'docker.io/library/redis\n' > "${GREMION_ROOT}/etc/third-party-images"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"evil/redis:7-alpine@sha256:4444"*"is neither first-party"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a first-party tag@digest pin verifies against cosign's tagless docker-reference" {
    stub_all
    local tagged="${BATS_TEST_TMPDIR}/fptag"
    mkdir -p "$tagged"; cp -R "${FIXTURES}/valid"/. "$tagged"/
    sed -i -E 's#(ghcr\.io/hello-n00del/gremion-ui)@#\1:dist-v1.2.3@#' "$tagged/docker-compose.pins.yml"
    grep -q 'gremion-ui:dist-v1.2.3@sha256:' "$tagged/docker-compose.pins.yml"
    export FIXTURE_RELEASE="$tagged"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 0 ]
    [[ "$output" == *"6 first-party image(s) verified"* ]]
    assert_recorded cosign "verify --key ${GREMION_ROOT}/etc/cosign.pub --insecure-ignore-tlog=true --output json ghcr.io/hello-n00del/gremion-ui:dist-v1.2.3@sha256:"
}

@test "an unsigned image under an inactive compose profile (step 7's migrate) is still verified and refused" {
    stub_all
    export PROFILED_RESOLVED="ghcr.io/hello-n00del/gremion-migrate-x@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    shim cosign '
ref="${*: -1}"
case "$ref" in *5555*) echo "Error: no signatures found" >&2; exit 10 ;; esac
printf "[{\"critical\":{\"identity\":{\"docker-reference\":\"%s\"},\"image\":{\"docker-manifest-digest\":\"%s\"}}}]\n" "${ref%@*}" "${ref##*@}"'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"signature verification failed for ghcr.io/hello-n00del/gremion-migrate-x@sha256:5555"* ]]
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a canonical pin that compose does not show is signature-verified anyway" {
    stub_all
    export RESOLVE_OMIT="gremion-migrate"
    shim cosign '
ref="${*: -1}"
case "$ref" in *gremion-migrate*) echo "Error: no signatures found" >&2; exit 10 ;; esac
printf "[{\"critical\":{\"identity\":{\"docker-reference\":\"%s\"},\"image\":{\"docker-manifest-digest\":\"%s\"}}}]\n" "${ref%@*}" "${ref##*@}"'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"signature verification failed for ghcr.io/hello-n00del/gremion-migrate@sha256:3333"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

# ---------------------------------------------------------------------------
# K. the split pins layer (TASK-048b): docker-compose.state-pins.yml is the
#    state project's layer, judged by the SAME greps as the app layer
# ---------------------------------------------------------------------------

STATE_LEGAL="ghcr.io/hello-n00del/gremion-legal@sha256:7777777777777777777777777777777777777777777777777777777777777777"

# state_tree <name> -> a copy of the valid tree in $T; FIXTURE_RELEASE points
# at it. Called directly, never in $(…): the export must reach the test.
state_tree() {
    T="${BATS_TEST_TMPDIR}/$1"
    mkdir -p "$T"; cp -R "${FIXTURES}/valid"/. "$T"/
    export FIXTURE_RELEASE="$T"
}

@test "a release tree without docker-compose.state-pins.yml exits 3 BLOCKED, nothing pulled" {
    stub_all
    state_tree nostate
    rm -f "$T/docker-compose.state-pins.yml"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: docker-compose.state-pins.yml absent (spec B)"* ]]
    grep -qE ' STEP 2 checkout fail$' "${GREMION_ROOT}/runtime/deploy.log"
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
    [ "$(grep -c '^cosign' "$SHIM_LOG")" -eq 0 ]
}

@test "every state first-party image is signature-verified with the host key at step 2" {
    stub_all
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 0 ]
    local img
    for img in gremion-legal@sha256:7777777777777777777777777777777777777777777777777777777777777777 \
               gremion-vector@sha256:8888888888888888888888888888888888888888888888888888888888888888 \
               gremion-fallback@sha256:9999999999999999999999999999999999999999999999999999999999999999; do
        assert_recorded cosign "verify --key ${GREMION_ROOT}/etc/cosign.pub --insecure-ignore-tlog=true --output json ghcr.io/hello-n00del/${img}"
    done
    # release/valid pins 7 first-party images: app gremion-ui, gremion-public, gremion-migrate, gremion-control-panel (TASK-043) + state legal, vector, fallback
    [[ "$output" == *"7 first-party image(s) verified against ${GREMION_ROOT}/etc/cosign.pub"* ]]
    [[ "$output" == *"7 pinned image(s)"* ]]
}

@test "a tag-only, real-build, gremion/ or flow-map image in the STATE layer exits 1 naming the file" {
    stub_all
    local body
    for body in "    image: ghcr.io/hello-n00del/gremion-legal:dist-v1.2.3" \
                "    build: ./legal" \
                "    image: gremion/legal@sha256:7777777777777777777777777777777777777777777777777777777777777777" \
                "  evil: {image: ghcr.io/hello-n00del/evil@sha256:5555555555555555555555555555555555555555555555555555555555555555}"; do
        state_tree "bad-$RANDOM"
        printf '%s\n' "services:" "  legal:" "    build: !reset null" "    image: ${STATE_LEGAL}" > "$T/docker-compose.state-pins.yml"
        case "$body" in
          "    image:"*) sed -i "s#^    image: .*#${body}#" "$T/docker-compose.state-pins.yml" ;;
          *) printf '%s\n' "$body" >> "$T/docker-compose.state-pins.yml" ;;
        esac
        rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
        : > "$SHIM_LOG"
        run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
        [ "$status" -eq 1 ] || { echo "accepted: $body"; echo "$output"; return 1; }
        [[ "$output" == *"docker-compose.state-pins.yml"* ]] || { echo "file not named for: $body"; echo "$output"; return 1; }
        [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
    done
}

@test "a state first-party image whose signature vouches for another digest is refused" {
    stub_all
    shim cosign '
ref="${*: -1}"
d="${ref##*@}"
case "$ref" in *gremion-legal*) d="sha256:$(printf "%064d" 0)" ;; esac
printf "[{\"critical\":{\"identity\":{\"docker-reference\":\"%s\"},\"image\":{\"docker-manifest-digest\":\"%s\"}}}]\n" "${ref%@*}" "$d"
exit 0'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"signature verification failed for ${STATE_LEGAL}: no claim binds"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a state image absent after the pull fails step 3 (PINNED_IMAGES is the union of both layers)" {
    stub_all
    shim docker '
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  manifest) printf "{\"config\":{\"size\":1},\"layers\":[{\"size\":1}]}\n"; exit 0 ;;
  image) case "$*" in *gremion-legal*) exit 1 ;; esac; exit 0 ;;
  compose) case "$*" in *"config --images"*) "$GREMION_ROOT/.resolve-images"; exit $? ;; esac; exit 0 ;;
esac
exit 0
'
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"image absent after pull: ${STATE_LEGAL}"* ]]
    assert_recorded docker "manifest inspect ${STATE_LEGAL}"
}

@test "an empty state layer passes validation when the union pins images (Q3); both empty is refused" {
    stub_all
    state_tree emptystate
    printf 'services: {}\n' > "$T/docker-compose.state-pins.yml"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 0 ]
    [[ "$output" == *"4 pinned image(s)"* ]]
    printf 'services: {}\n' > "$T/docker-compose.pins.yml"
    rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
    : > "$SHIM_LOG"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"the pins layers pin no images"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "a stale host env layering is refused with exit 2 before any pull (Q2)" {
    stub_all
    local state_env="${GREMION_ROOT}/etc/env/state.env" bad
    cp "$state_env" "${BATS_TEST_TMPDIR}/state.env.orig"
    for bad in "docker-compose.yml:docker-compose.prod.yml:docker-compose.pins.yml" \
               "docker-compose.yml:docker-compose.prod.yml" \
               "docker-compose.yml:docker-compose.prod.yml:docker-compose.state-pins.yml:docker-compose.pins.yml"; do
        sed "s#^COMPOSE_FILE=.*#COMPOSE_FILE=${bad}#" "${BATS_TEST_TMPDIR}/state.env.orig" > "$state_env"
        rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
        : > "$SHIM_LOG"
        run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
        [ "$status" -eq 2 ] || { echo "accepted state COMPOSE_FILE=$bad"; echo "$output"; return 1; }
        [[ "$output" == *"state.env"*"docker-compose.state-pins.yml"* ]]
        # R28 review MEDIUM: the refusal points at the one-line upgrade edit,
        # never at a template re-render (gremion-init-secrets --force rotates
        # every live secret on a running host)
        [[ "$output" == *"docs/ops/runbook/upgrade.md"* ]] || { echo "$output"; return 1; }
        [[ "$output" != *"re-render"* ]] || { echo "$output"; return 1; }
        [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
        [ "$(grep -c '^cosign' "$SHIM_LOG")" -eq 0 ]
    done
    cp "${BATS_TEST_TMPDIR}/state.env.orig" "$state_env"
    sed -i 's#^COMPOSE_FILE=.*#COMPOSE_FILE=docker-compose.app.yml:docker-compose.pins.yml:docker-compose.state-pins.yml#' \
        "${GREMION_ROOT}/etc/env/app-green.env"
    rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
    : > "$SHIM_LOG"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 2 ]
    [[ "$output" == *"app-green.env"*"docker-compose.state-pins.yml"* ]]
    [[ "$output" == *"docs/ops/runbook/upgrade.md"* ]] || { echo "$output"; return 1; }
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "Q2 r1: the state.env COMPOSE_FILE forms compose reads are judged exactly; any other form is refused, exit 2" {
    stub_all
    local state_env="${GREMION_ROOT}/etc/env/state.env" line
    cp "$state_env" "${BATS_TEST_TMPDIR}/state.env.orig"
    # accepted: the quoted form (the rendered form is every other case's)
    for line in 'COMPOSE_FILE="docker-compose.yml:docker-compose.prod.yml:docker-compose.state-pins.yml"'; do
        { grep -v '^COMPOSE_FILE=' "${BATS_TEST_TMPDIR}/state.env.orig"; printf '%b\n' "$line"; } > "$state_env"
        rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
        run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
        [ "$status" -eq 0 ] || { echo "refused: $line"; echo "$output"; return 1; }
    done
    # refused: export (load_env's own refusal), a trailing comment or
    # whitespace hiding the app layer, a second declaration
    for line in 'export COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:docker-compose.state-pins.yml' \
                'COMPOSE_FILE="docker-compose.yml:docker-compose.state-pins.yml:docker-compose.pins.yml" # old' \
                'COMPOSE_FILE=docker-compose.yml:docker-compose.state-pins.yml:docker-compose.pins.yml   ' \
                'COMPOSE_FILE=docker-compose.yml:docker-compose.state-pins.yml\nCOMPOSE_FILE=docker-compose.yml:docker-compose.pins.yml' \
                'COMPOSE_FILE=docker-compose.yml:docker-compose.state-pins.yml\nCOMPOSE_FILE: docker-compose.yml:docker-compose.pins.yml' \
                'COMPOSE_FILE = docker-compose.yml:docker-compose.pins.yml:docker-compose.state-pins.yml' \
                'P=docker-compose.pins.yml\nCOMPOSE_FILE=docker-compose.yml:${P}:docker-compose.state-pins.yml' \
                'COMPOSE_PATH_SEPARATOR=,\nCOMPOSE_FILE=docker-compose.yml,docker-compose.pins.yml,docker-compose.state-pins.yml'; do
        { grep -v '^COMPOSE_FILE=' "${BATS_TEST_TMPDIR}/state.env.orig"; printf '%b\n' "$line"; } > "$state_env"
        rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
        : > "$SHIM_LOG"
        run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
        [ "$status" -eq 2 ] || { echo "accepted: $line"; echo "$output"; return 1; }
        [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
    done
    # the colour side: a comment hiding the state layer in app-green.env
    cp "${BATS_TEST_TMPDIR}/state.env.orig" "$state_env"
    sed -i 's#^COMPOSE_FILE=.*#COMPOSE_FILE=docker-compose.app.yml:docker-compose.pins.yml:docker-compose.state-pins.yml   #' \
        "${GREMION_ROOT}/etc/env/app-green.env"
    rm -rf "${GREMION_ROOT}/releases/dist-v1.2.3"
    : > "$SHIM_LOG"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 2 ]
    [[ "$output" == *"app-green.env"*"COMPOSE_FILE"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}

@test "Q2 r1: a symlinked pins layer in the release tree is refused (the state slot must be its own file)" {
    stub_all
    state_tree symstate
    rm -f "$T/docker-compose.state-pins.yml"
    ln -s docker-compose.pins.yml "$T/docker-compose.state-pins.yml"
    run bash -c "printf 'TOKEN t\n' | '$DEPLOY' dist-v1.2.3"
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker-compose.state-pins.yml"*"symlink"* ]]
    [ "$(grep -c 'compose .* pull' "$SHIM_LOG")" -eq 0 ]
}
