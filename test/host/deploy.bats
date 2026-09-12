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
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:docker-compose.pins.yml
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
case "$args" in *app-green*) c=green ;; *) c=blue ;; esac
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
  compose) exit 0 ;;
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
  compose) exit 0 ;;
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
        *"NetworkSettings.Networks"*)   printf "%s_state \n" "$STACK" ;;
        *"com.docker.compose.service"*) printf "minio-mc\n" ;;
        *"{{.State.Status}}"*)          printf "exited\n" ;;
        *"{{.State.ExitCode}}"*)        printf "1\n" ;;
        *".State.Health"*)              printf "none\n" ;;
        *)                              printf "\n" ;;
      esac
      exit 0 ;;
  compose)
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
