#!/usr/bin/env bats
# Unit tests for infra/host/lib/cd/docker.sh (continuous deployment):
# the one compose shape, the env-file helpers, the health wait and the
# Traefik reads. Nothing here touches a real docker, curl or network: both are
# recording shims (test_helper/host.bash) and the host layout is a temp
# $GREMION_ROOT.

bats_require_minimum_version 1.5.0
load 'test_helper/host'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/docker"

setup() {
    setup_host_root
    export STACK=teststack
    unset CD_DC_TIMEOUT CD_WAIT_POLL_S CD_WAIT_BAD
    DOCKER_LIB="${HOST_SRC}/lib/cd/docker.sh"
    DK="${SHIM_DIR}/dk"
    export DK
    mkdir -p "$DK" "${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    TREE="${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    export TREE
    cp "${FIX}/state.env" "${GREMION_ROOT}/etc/env/state.env"
    cp "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/app-green.env"
    cp "${FIX}/app-blue.env" "${GREMION_ROOT}/etc/env/app-blue.env"
    shim_docker
}

teardown() {
    teardown_host_root
}

# A docker shim that answers the calls docker.sh makes. State lives in $DK:
#   argv.log            one line per call, args joined with '|'
#   ctx.log             cwd and GREMION_ROOT of every compose call
#   env.log             the COMPOSE_* variables every compose call could see
#   stdin.log           whatever the last compose call could read on stdin
#   built               images a `compose build` produced: the star adds the
#                       profile-gated one-shot image, as the real compose does
#   services            the `config --services` answer (config.fail = exit 1)
#   cid.<project>.<svc> the container a service has (absent = none)
#   cids.<project>      every running container of a project
#   status.<cid>        lines of the inspect answer; one per call, last sticks
#   image.<ref>         the image id of a reference (/ and : become _)
#   slow                a compose call sleeps 5 s (timeout test)
#   ps.fail             `docker ps` exits 1
#   image.daemon        `docker image inspect` fails as a daemon that does
#                       not answer (not as a missing image)
shim_docker() {
    shim docker "$(cat <<'EOF'
(IFS='|'; printf '%s\n' "$*" >> "$DK/argv.log")
case "$1" in
  compose)
    printf 'cwd=%s root=%s\n' "$PWD" "${GREMION_ROOT:-}" >> "$DK/ctx.log"
    env | grep -E '^COMPOSE_' | sort >> "$DK/env.log" || true
    IFS= read -r -t 0.3 -d '' data || true
    printf '%s' "$data" > "$DK/stdin.log"
    [ -f "$DK/slow" ] && sleep 5
    case " $* " in
      *" build "*)
        echo gremion-ui >> "$DK/built"
        case " $* " in *" --profile * "*) echo gremion-migrate >> "$DK/built" ;; esac ;;
      *" config "*"--services"*)
        [ -f "$DK/config.fail" ] && exit 1
        [ -f "$DK/services" ] && cat "$DK/services" ;;
    esac
    exit 0 ;;
  ps)
    [ -f "$DK/ps.fail" ] && exit 1
    proj=''; svc=''
    for a in "$@"; do
      case "$a" in
        label=com.docker.compose.project=*) proj="${a#label=com.docker.compose.project=}" ;;
        label=com.docker.compose.service=*) svc="${a#label=com.docker.compose.service=}" ;;
      esac
    done
    # A one-off container (compose run) is listed unless the caller filters
    # the oneoff label to False, as the real daemon does.
    case " $* " in *" label=com.docker.compose.oneoff=False "*) ;; *) [ -f "$DK/oneoff.$proj" ] && cat "$DK/oneoff.$proj" ;; esac
    if [ -n "$svc" ]; then [ -f "$DK/cid.$proj.$svc" ] && cat "$DK/cid.$proj.$svc"
    else [ -f "$DK/cids.$proj" ] && cat "$DK/cids.$proj"; fi
    exit 0 ;;
  inspect)
    cid="${@: -1}"
    [ -f "$DK/status.$cid" ] || exit 1
    n=$(cat "$DK/n.$cid" 2>/dev/null || echo 0)
    line=$(sed -n "$((n + 1))p" "$DK/status.$cid")
    [ -n "$line" ] || line=$(tail -n 1 "$DK/status.$cid")
    echo $((n + 1)) > "$DK/n.$cid"
    printf '%s\n' "$line"
    exit 0 ;;
  image)
    ref="${@: -1}"; key=$(printf '%s' "$ref" | tr '/:' '__')
    [ -f "$DK/image.daemon" ] && { echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; }
    [ -f "$DK/image.$key" ] || { echo "Error: No such image: $ref" >&2; exit 1; }
    cat "$DK/image.$key"
    exit 0 ;;
esac
exit 0
EOF
)"
}

# The last recorded docker call, args joined with '|'.
last_argv() { tail -n 1 "$DK/argv.log"; }

# How many --profile arguments the last docker call carried.
profile_count() { last_argv | tr '|' '\n' | grep -c -x -- '--profile' || true; }

load_lib() {
    # shellcheck source=/dev/null
    . "$DOCKER_LIB"
}

# ---------------------------------------------------------------- cd_envfile

@test "cd_envfile names the three project env files and refuses anything else" {
    load_lib
    for p in state app-blue app-green; do
        run cd_envfile "$p"
        [ "$status" -eq 0 ]
        [ "$output" = "${GREMION_ROOT}/etc/env/${p}.env" ]
    done
    run cd_envfile app-purple
    [ "$status" -eq 2 ]
    run cd_envfile ''
    [ "$status" -eq 2 ]
    run cd_envfile ../state
    [ "$status" -eq 2 ]
}

# ------------------------------------------------------------------- cd_dc

@test "cd_dc is cd <tree> && docker compose --env-file <env>, no -f and no -p" {
    load_lib
    cd_dc "$TREE" app-green up -d
    [ "$(last_argv)" = "compose|--env-file|${GREMION_ROOT}/etc/env/app-green.env|up|-d" ]
    run cat "$DK/ctx.log"
    [[ "$output" == *"cwd=${TREE} "* ]]
    [[ "$output" == *"root=${GREMION_ROOT}"* ]]
    run grep -cE '\|-f\||\|-p\|' "$DK/argv.log"
    [ "$output" = 0 ]
}

@test "cd_dc runs with stdin from /dev/null" {
    load_lib
    cd_dc "$TREE" app-green run --rm -T migrate <<<"leaked-line"
    [ ! -s "$DK/stdin.log" ]
}

@test "cd_dc build carries exactly one --profile '*' and the profile-gated one-shot image is built" {
    load_lib
    cd_dc "$TREE" app-green build --pull
    [ "$(last_argv)" = "compose|--env-file|${GREMION_ROOT}/etc/env/app-green.env|--profile|*|build|--pull" ]
    [ "$(profile_count)" = 1 ]
    grep -qx gremion-migrate "$DK/built"
    grep -qx gremion-ui "$DK/built"
}

@test "cd_dc pull --ignore-buildable carries the star" {
    load_lib
    cd_dc "$TREE" app-green pull --ignore-buildable
    [ "$(last_argv)" = "compose|--env-file|${GREMION_ROOT}/etc/env/app-green.env|--profile|*|pull|--ignore-buildable" ]
    [ "$(profile_count)" = 1 ]
}

@test "cd_dc config carries the star for --images, --format json and plain" {
    load_lib
    cd_dc "$TREE" app-green config --images
    [ "$(last_argv)" = "compose|--env-file|${GREMION_ROOT}/etc/env/app-green.env|--profile|*|config|--images" ]
    cd_dc "$TREE" app-green config --format json
    [ "$(last_argv)" = "compose|--env-file|${GREMION_ROOT}/etc/env/app-green.env|--profile|*|config|--format|json" ]
    cd_dc "$TREE" app-green config
    [ "$(profile_count)" = 1 ]
}

@test "cd_dc config --services carries NO star (the services the env file declares)" {
    load_lib
    cd_dc "$TREE" app-green config --services
    [ "$(last_argv)" = "compose|--env-file|${GREMION_ROOT}/etc/env/app-green.env|config|--services" ]
    [ "$(profile_count)" = 0 ]
}

@test "cd_dc up carries no --profile" {
    load_lib
    cd_dc "$TREE" app-green up -d --no-build
    [ "$(profile_count)" = 0 ]
}

@test "cd_dc run carries no --profile" {
    load_lib
    cd_dc "$TREE" app-green run --rm -T --no-deps tenant-create module-upgrade --all
    [ "$(profile_count)" = 0 ]
    [[ "$(last_argv)" == *"|run|--rm|-T|--no-deps|tenant-create|module-upgrade|--all" ]]
}

@test "cd_dc down carries no --profile" {
    load_lib
    cd_dc "$TREE" app-green down --remove-orphans
    [ "$(profile_count)" = 0 ]
}

@test "cd_dc ps carries no --profile" {
    load_lib
    cd_dc "$TREE" app-green ps -q
    [ "$(profile_count)" = 0 ]
}

@test "cd_dc exec carries no --profile" {
    load_lib
    cd_dc "$TREE" app-green exec -T gremion-ui true
    [ "$(profile_count)" = 0 ]
}

@test "cd_dc a plain pull carries no --profile" {
    load_lib
    cd_dc "$TREE" app-green pull gremion-ui
    [ "$(profile_count)" = 0 ]
}

@test "cd_dc refuses a leading option and every global compose option, calling docker never" {
    load_lib
    for bad in "-f x.yml up" "-p name up" "--profile x up" "up --profile x" "up --project-name x" \
        "up --file x.yml" "up --env-file /etc/passwd" "up --project-directory /" "Up" "up;id"; do
        run cd_dc "$TREE" app-green $bad
        [ "$status" -eq 2 ]
    done
    [ ! -s "$DK/argv.log" ]
}

@test "cd_dc refuses missing arguments, a missing tree, an unknown project and a missing env file" {
    load_lib
    run cd_dc "$TREE" app-green
    [ "$status" -eq 2 ]
    run cd_dc "${GREMION_ROOT}/nope" app-green up
    [ "$status" -eq 2 ]
    run cd_dc "$TREE" app-purple up
    [ "$status" -eq 2 ]
    rm -f "${GREMION_ROOT}/etc/env/app-green.env"
    run cd_dc "$TREE" app-green up
    [ "$status" -eq 2 ]
    [ ! -s "$DK/argv.log" ]
}

# The compose project name and the compose files come from the env file and
# from nowhere else: without them compose would fall back to the name of the
# tree directory and to docker-compose.yml, and could start a third stack
# beside the live colours. A missing key is a named stop, never a default.
@test "cd_dc refuses (2) an env file with neither COMPOSE_PROJECT_NAME nor COMPOSE_FILE, naming the key, and never starts compose" {
    load_lib
    f="${GREMION_ROOT}/etc/env/app-green.env"
    sed -i '/^COMPOSE_PROJECT_NAME=/d;/^COMPOSE_FILE=/d' "$f"
    for verb in up build config ps; do
        run --separate-stderr cd_dc "$TREE" app-green "$verb"
        [ "$status" -eq 2 ]
        [[ "$stderr" == *COMPOSE_PROJECT_NAME* ]]
        [ "$(printf '%s\n' "$stderr" | wc -l)" -eq 1 ]
    done
    [ ! -e "$DK/argv.log" ]
}

@test "cd_dc refuses (2) an env file that lacks only COMPOSE_FILE, naming it, and never starts compose" {
    load_lib
    sed -i '/^COMPOSE_FILE=/d' "${GREMION_ROOT}/etc/env/app-green.env"
    run --separate-stderr cd_dc "$TREE" app-green up -d
    [ "$status" -eq 2 ]
    [[ "$stderr" == *COMPOSE_FILE* ]]
    [ "$(printf '%s\n' "$stderr" | wc -l)" -eq 1 ]
    [ ! -e "$DK/argv.log" ]
}

@test "cd_dc refuses (2) a repeated or empty COMPOSE_FILE, a repeated or foreign COMPOSE_PROJECT_NAME and a STACK that disagrees, and starts compose never" {
    load_lib
    f="${GREMION_ROOT}/etc/env/app-green.env"
    cp "$f" "${BATS_TEST_TMPDIR}/orig.env"
    for variant in filedup fileempty namedup foreign stack; do
        cp "${BATS_TEST_TMPDIR}/orig.env" "$f"
        export STACK=teststack
        case "$variant" in
            filedup) echo 'COMPOSE_FILE=other.yml' >> "$f" ;;
            fileempty) sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=/' "$f" ;;
            namedup) echo 'COMPOSE_PROJECT_NAME=teststack-app-green' >> "$f" ;;
            foreign) sed -i 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=teststack-app-blue/' "$f" ;;
            stack) export STACK=otherstack ;;
        esac
        run --separate-stderr cd_dc "$TREE" app-green up -d
        [ "$status" -eq 2 ]
        [ -n "$stderr" ]
    done
    [ ! -e "$DK/argv.log" ]
}

@test "cd_dc runs compose for the state project once its env file declares both keys" {
    load_lib
    cd_dc "$TREE" state up -d
    [ "$(last_argv)" = "compose|--env-file|${GREMION_ROOT}/etc/env/state.env|up|-d" ]
}

@test "cd_dc says so on stderr when compose hits CD_DC_TIMEOUT" {
    load_lib
    touch "$DK/slow"
    CD_DC_TIMEOUT=1
    run --separate-stderr cd_dc "$TREE" app-green up
    [ "$status" -eq 124 ] || [ "$status" -eq 137 ]
    [[ "$stderr" == *"timed out"* ]]
}

@test "cd_dc returns the exit status of compose" {
    load_lib
    shim docker 'exit 7'
    run cd_dc "$TREE" app-green up
    [ "$status" -eq 7 ]
}

@test "cd_dc honours CD_DC_TIMEOUT and refuses a bad value" {
    load_lib
    touch "$DK/slow"
    export CD_DC_TIMEOUT=1
    run cd_dc "$TREE" app-green up
    [ "$status" -eq 124 ]
    export CD_DC_TIMEOUT=soon
    run cd_dc "$TREE" app-green up
    [ "$status" -eq 2 ]
}

# A value with a leading zero is a decimal number of seconds, never octal: 08
# must not switch the bound off (octal error) and 010 is ten, not eight.
@test "cd_dc reads a CD_DC_TIMEOUT with a leading zero as decimal" {
    load_lib
    shim timeout 'shift 3; exec "$@"'
    hash -r
    export CD_DC_TIMEOUT=08
    run cd_dc "$TREE" app-green up
    [ "$status" -eq 0 ]
    grep -q '^timeout -k 10 8 docker compose' "$SHIM_LOG"
    : > "$SHIM_LOG"
    export CD_DC_TIMEOUT=010
    run cd_dc "$TREE" app-green up
    [ "$status" -eq 0 ]
    grep -q '^timeout -k 10 10 docker compose' "$SHIM_LOG"
    : > "$SHIM_LOG"
    export CD_DC_TIMEOUT=00
    run cd_dc "$TREE" app-green up
    [ "$status" -eq 0 ]
    ! grep -q '^timeout ' "$SHIM_LOG"
}

# ------------------------------------------------------------ cd_set_env_key

mk_envfile() { printf 'A=1\nIMAGE_TAG=old\nIMAGE_TAG_OLD=keep\n# IMAGE_TAG=comment\nZ=9\n' > "$1"; }

@test "cd_dc ignores the COMPOSE_* variables of the caller's environment: the env file decides" {
    load_lib
    export COMPOSE_PROJECT_NAME=fromshell-app-blue COMPOSE_PROFILES='*' COMPOSE_FILE=/elsewhere/x.yml \
        COMPOSE_PATH_SEPARATOR=: COMPOSE_ENV_FILES=/elsewhere/x.env
    cd_dc "$TREE" app-green up -d
    cd_dc "$TREE" app-green build
    [ "$(grep -c . "$DK/env.log" || true)" = 0 ]
    [ "$(last_argv | tr '|' '\n' | grep -c -x -- '--profile')" = 1 ]
}

@test "cd_set_env_key replaces one declaration and leaves the other lines alone" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    mk_envfile "$f"
    cd_set_env_key "$f" IMAGE_TAG pilot-aaaaaaaaaaaa
    [ "$(grep -c '^IMAGE_TAG=' "$f")" = 1 ]
    [ "$(cat "$f")" = "$(printf 'A=1\nIMAGE_TAG=pilot-aaaaaaaaaaaa\nIMAGE_TAG_OLD=keep\n# IMAGE_TAG=comment\nZ=9')" ]
}

@test "cd_set_env_key appends an absent key exactly once and keeps a file without a final newline sane" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    printf 'A=1' > "$f"
    cd_set_env_key "$f" NEWKEY value
    [ "$(grep -c '^NEWKEY=' "$f")" = 1 ]
    [ "$(cat "$f")" = "$(printf 'A=1\nNEWKEY=value')" ]
}

@test "cd_set_env_key writes a value with slash, ampersand, backslash, dollar, quote and space verbatim" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    mk_envfile "$f"
    for v in 'a/b/c' 'x&y' 'back\slash' '$HOME' 'a b "q" '"'"'s'"'"'' '\n' '|pipe|' 'k=v'; do
        cd_set_env_key "$f" IMAGE_TAG "$v"
        [ "$(grep -c '^IMAGE_TAG=' "$f")" = 1 ]
        grep -Fxq -- "IMAGE_TAG=${v}" "$f"
    done
}

@test "cd_set_env_key refuses a value with a line break and leaves the file byte for byte" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    mk_envfile "$f"
    before="$(cksum < "$f")"
    run cd_set_env_key "$f" IMAGE_TAG $'a\nINJECTED=1'
    [ "$status" -ne 0 ]
    run cd_set_env_key "$f" IMAGE_TAG $'a\rb'
    [ "$status" -ne 0 ]
    [ "$(cksum < "$f")" = "$before" ]
    [ "$(ls "${BATS_TEST_TMPDIR}" | grep -c '^x.env')" = 1 ]
}

@test "cd_set_env_key refuses a bad key name" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    mk_envfile "$f"
    before="$(cksum < "$f")"
    for k in '' lower 'A-B' '1A' 'A=B' 'A B' 'A.B' '$(id)'; do
        run cd_set_env_key "$f" "$k" v
        [ "$status" -eq 2 ]
    done
    [ "$(cksum < "$f")" = "$before" ]
}

@test "cd_set_env_key refuses a missing file and does not create it" {
    load_lib
    run cd_set_env_key "${BATS_TEST_TMPDIR}/none.env" A 1
    [ "$status" -eq 2 ]
    [ ! -e "${BATS_TEST_TMPDIR}/none.env" ]
}

@test "cd_set_env_key on a file with a duplicate key fails closed and changes nothing" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    printf 'IMAGE_TAG=one\nA=1\nIMAGE_TAG=two\n' > "$f"
    before="$(cksum < "$f")"
    run cd_set_env_key "$f" IMAGE_TAG new
    [ "$status" -eq 1 ]
    [ "$(cksum < "$f")" = "$before" ]
    [ "$(ls "${BATS_TEST_TMPDIR}" | grep -c '^x.env')" = 1 ]
}

@test "cd_set_env_key keeps the mode and the owner of the file" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    mk_envfile "$f"
    chmod 640 "$f"
    m_before="$(stat -c %a "$f")"
    if [ "$(id -u)" = 0 ]; then chown 1234:4321 "$f"; fi
    o_before="$(stat -c %u:%g "$f")"
    cd_set_env_key "$f" IMAGE_TAG changed
    [ "$(stat -c %a "$f")" = "$m_before" ]
    [ "$(stat -c %u:%g "$f")" = "$o_before" ]
    if [ "$(id -u)" = 0 ]; then [ "$o_before" = 1234:4321 ]; fi
}

@test "cd_set_env_key never leaves a temporary copy behind" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    mk_envfile "$f"
    cd_set_env_key "$f" IMAGE_TAG a
    cd_set_env_key "$f" NEW b
    [ "$(ls "${BATS_TEST_TMPDIR}" | grep -c '^x.env')" = 1 ]
}

# ---------------------------------------------------------------- cd_kv_get

@test "cd_kv_get reads a value, strips one pair of quotes and a carriage return" {
    load_lib
    f="${BATS_TEST_TMPDIR}/kv.env"
    printf 'PLAIN=abc\nQ1="quoted v"\nQ2='"'"'single'"'"'\nCRLF=windows\r\nEQ=a=b=c\nEMPTY=\n' > "$f"
    [ "$(cd_kv_get "$f" PLAIN)" = abc ]
    [ "$(cd_kv_get "$f" Q1)" = 'quoted v' ]
    [ "$(cd_kv_get "$f" Q2)" = single ]
    [ "$(cd_kv_get "$f" CRLF)" = windows ]
    [ "$(cd_kv_get "$f" EQ)" = 'a=b=c' ]
    run cd_kv_get "$f" EMPTY
    [ "$status" -eq 0 ]
    [ "$output" = "" ]
}

@test "cd_kv_get returns 1 for an absent key, 1 for a duplicate and 2 for a missing file or bad key" {
    load_lib
    f="${BATS_TEST_TMPDIR}/kv.env"
    printf 'A=1\nDUP=1\nDUP=2\nAB=x\n' > "$f"
    run --separate-stderr cd_kv_get "$f" B
    [ "$status" -eq 1 ]
    [ "$output" = "" ]
    run --separate-stderr cd_kv_get "$f" DUP
    [ "$status" -eq 1 ]
    [[ "$output" != *1* && "$output" != *2* ]]
    run --separate-stderr cd_kv_get "$f" 'A.'
    [ "$status" -eq 2 ]
    run --separate-stderr cd_kv_get "${BATS_TEST_TMPDIR}/none" A
    [ "$status" -eq 2 ]
    run --separate-stderr cd_kv_get "$f" lower
    [ "$status" -eq 2 ]
}

# -------------------------------------------------------------- cd_svc_cid

@test "cd_svc_cid asks docker for the project and service label and prints the first container" {
    load_lib
    printf 'c111\nc222\n' > "$DK/cid.teststack-app-blue.gremion-ui"
    run cd_svc_cid app-blue gremion-ui
    [ "$status" -eq 0 ]
    [ "$output" = c111 ]
    [ "$(last_argv)" = "ps|-q|--filter|label=com.docker.compose.project=teststack-app-blue|--filter|label=com.docker.compose.service=gremion-ui|--filter|label=com.docker.compose.oneoff=False" ]
}

@test "cd_svc_cid prints nothing and returns 0 when the service has no container" {
    load_lib
    run cd_svc_cid app-blue gremion-ui
    [ "$status" -eq 0 ]
    [ "$output" = "" ]
}

@test "cd_svc_cid returns 2 when docker does not answer or a name is bad" {
    load_lib
    touch "$DK/ps.fail"
    run cd_svc_cid app-blue gremion-ui
    [ "$status" -eq 2 ]
    rm -f "$DK/ps.fail" "$DK/argv.log"
    run cd_svc_cid app-blue '--all'
    [ "$status" -eq 2 ]
    run cd_svc_cid app-purple gremion-ui
    [ "$status" -eq 2 ]
    [ ! -e "$DK/argv.log" ]
}

# The compose project name is the one the env file declares (what compose
# itself acts on), never a name rebuilt from the shell's STACK: a STACK that
# differs would otherwise report "no container" for a project that is running.
@test "cd_svc_cid and cd_project_cids look under the COMPOSE_PROJECT_NAME of the env file when STACK is unset" {
    load_lib
    sed -i 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=prod-app-green/' "${GREMION_ROOT}/etc/env/app-green.env"
    printf 'c111\n' > "$DK/cid.prod-app-green.gremion-ui"
    printf 'c111\n' > "$DK/cids.prod-app-green"
    unset STACK
    run cd_svc_cid app-green gremion-ui
    [ "$status" -eq 0 ]
    [ "$output" = c111 ]
    run cd_project_cids app-green
    [ "$status" -eq 0 ]
    [ "$output" = c111 ]
}

@test "cd_svc_cid and cd_project_cids refuse (2) when STACK names a different project than the env file, never a quiet 'no container'" {
    load_lib
    sed -i 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=prod-app-green/' "${GREMION_ROOT}/etc/env/app-green.env"
    printf 'c111\n' > "$DK/cid.prod-app-green.gremion-ui"
    printf 'c111\n' > "$DK/cids.prod-app-green"
    export STACK=other
    run cd_svc_cid app-green gremion-ui
    [ "$status" -eq 2 ]
    [ "$output" != c111 ]
    run cd_project_cids app-green
    [ "$status" -eq 2 ]
    [ ! -e "$DK/argv.log" ]
}

@test "cd_svc_cid and cd_project_cids refuse (2) an env file with no, a repeated, a malformed or a foreign COMPOSE_PROJECT_NAME, and ask docker never" {
    load_lib
    f="${GREMION_ROOT}/etc/env/app-green.env"
    cp "$f" "${BATS_TEST_TMPDIR}/orig.env"
    # Once with STACK set (its cross-check would catch a bad or foreign name
    # first) and once with it unset, where only the format and suffix check of
    # the name itself stands in the way.
    for stack in teststack unset; do
        if [ "$stack" = unset ]; then unset STACK; else export STACK="$stack"; fi
        for variant in none dup bad foreign; do
            cp "${BATS_TEST_TMPDIR}/orig.env" "$f"
            case "$variant" in
                none) sed -i '/^COMPOSE_PROJECT_NAME=/d' "$f" ;;
                dup) echo 'COMPOSE_PROJECT_NAME=teststack-app-green' >> "$f" ;;
                bad) sed -i 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=Bad Name/' "$f" ;;
                foreign) sed -i 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=teststack-app-blue/' "$f" ;;
            esac
            run cd_svc_cid app-green gremion-ui
            [ "$status" -eq 2 ]
            run cd_project_cids app-green
            [ "$status" -eq 2 ]
        done
    done
    [ ! -e "$DK/argv.log" ]
}

# ---------------------------------------------------------- cd_project_cids

@test "cd_project_cids lists the running containers of the project and nothing else" {
    load_lib
    printf 'c111\nc222\n' > "$DK/cids.teststack-app-green"
    run cd_project_cids app-green
    [ "$status" -eq 0 ]
    [ "$output" = "$(printf 'c111\nc222')" ]
    [ "$(last_argv)" = "ps|-q|--filter|label=com.docker.compose.project=teststack-app-green|--filter|label=com.docker.compose.oneoff=False" ]
    run cd_project_cids app-blue
    [ "$status" -eq 0 ]
    [ "$output" = "" ]
}

@test "cd_project_cids returns 2 when docker does not answer" {
    load_lib
    touch "$DK/ps.fail"
    run cd_project_cids app-green
    [ "$status" -eq 2 ]
}

# --------------------------------------------------------- cd_wait_healthy

# svc_state <service> <status lines...>: a container for the service of the
# project app-green and its answers to successive inspect calls.
svc_state() {
    local svc="$1"
    shift
    echo "cid-${svc}" > "$DK/cid.teststack-app-green.${svc}"
    printf '%s\n' "$@" > "$DK/status.cid-${svc}"
}

@test "cd_wait_healthy: a service with no container is absent and the wait times out with code 3" {
    load_lib
    printf 'gremion-ui\ndb\n' > "$DK/services"
    svc_state db 'running healthy'
    CD_WAIT_POLL_S=0.1
    cd_wait_healthy app-green 0 "$TREE" 2>"${BATS_TEST_TMPDIR}/err" && rc=0 || rc=$?
    [ "$rc" -eq 3 ]
    [ "$CD_WAIT_BAD" = " gremion-ui(absent)" ]
    grep -q 'gremion-ui(absent)' "${BATS_TEST_TMPDIR}/err"
}

@test "cd_wait_healthy: starting times out with code 3 and names the service" {
    load_lib
    printf 'gremion-ui\n' > "$DK/services"
    svc_state gremion-ui 'running starting'
    CD_WAIT_POLL_S=0.1
    cd_wait_healthy app-green 0 "$TREE" 2>"${BATS_TEST_TMPDIR}/err" && rc=0 || rc=$?
    [ "$rc" -eq 3 ]
    [ "$CD_WAIT_BAD" = " gremion-ui(running starting)" ]
    grep -q 'gremion-ui(running starting)' "${BATS_TEST_TMPDIR}/err"
}

@test "cd_wait_healthy: running nohealthcheck counts as healthy (livekit)" {
    load_lib
    printf 'gremion-ui\nlivekit\n' > "$DK/services"
    svc_state gremion-ui 'running healthy'
    svc_state livekit 'running nohealthcheck'
    cd_wait_healthy app-green 0 "$TREE"
    [ -z "$CD_WAIT_BAD" ]
}

@test "cd_wait_healthy: an exited, restarting or unhealthy service is not healthy" {
    load_lib
    printf 'a\nb\nc\n' > "$DK/services"
    svc_state a 'exited nohealthcheck'
    svc_state b 'restarting unhealthy'
    svc_state c 'running unhealthy'
    CD_WAIT_POLL_S=0.1
    cd_wait_healthy app-green 0 "$TREE" 2>/dev/null && rc=0 || rc=$?
    [ "$rc" -eq 3 ]
    [ "$CD_WAIT_BAD" = " a(exited nohealthcheck) b(restarting unhealthy) c(running unhealthy)" ]
}

@test "cd_wait_healthy: the names printed are services only, never a container id or the project" {
    load_lib
    printf 'gremion-ui\nnats\n' > "$DK/services"
    svc_state gremion-ui 'running starting'
    CD_WAIT_POLL_S=0.1
    cd_wait_healthy app-green 0 "$TREE" 2>"${BATS_TEST_TMPDIR}/err" && rc=0 || rc=$?
    [ "$rc" -eq 3 ]
    run cat "${BATS_TEST_TMPDIR}/err"
    [[ "$output" != *cid-gremion-ui* && "$output" != *teststack* ]]
    [[ "$CD_WAIT_BAD" != *cid-* && "$CD_WAIT_BAD" != *teststack* ]]
    [[ "$CD_WAIT_BAD" == *"nats(absent)"* ]]
}

@test "cd_wait_healthy: a service that turns healthy inside the window ends the wait with 0" {
    load_lib
    printf 'gremion-ui\n' > "$DK/services"
    svc_state gremion-ui 'running starting' 'running starting' 'running healthy'
    CD_WAIT_POLL_S=0.2
    cd_wait_healthy app-green 20 "$TREE"
    [ -z "$CD_WAIT_BAD" ]
    [ "$(cat "$DK/n.cid-gremion-ui")" = 3 ]
}

@test "cd_wait_healthy: a service that never turns healthy times out at the deadline, not before" {
    # A fake clock that moves one second per reading, so the test does not
    # depend on how a real, whole-second clock falls against the window: with
    # a 3 s window the first reading is 1000, the deadline 1003, and the loop
    # looks at the service once per reading until a reading reaches 1003.
    load_lib
    printf 'gremion-ui
' > "$DK/services"
    svc_state gremion-ui 'running starting'
    echo 1000 > "${BATS_TEST_TMPDIR}/clock"
    cd_now() { local t; t=$(cat "${BATS_TEST_TMPDIR}/clock"); echo $((t + 1)) > "${BATS_TEST_TMPDIR}/clock"; echo "$t"; }
    CD_WAIT_POLL_S=0.05
    cd_wait_healthy app-green 3 "$TREE" 2>"${BATS_TEST_TMPDIR}/err" && rc=0 || rc=$?
    [ "$rc" -eq 3 ]
    # readings: 1000 (deadline), then one after each of the looks at 1001,
    # 1002 and 1003; the third look is the one that meets the deadline
    [ "$(cat "$DK/n.cid-gremion-ui")" -eq 3 ]
    [ "$(cat "${BATS_TEST_TMPDIR}/clock")" -eq 1004 ]
    grep -q 'not healthy after 3s' "${BATS_TEST_TMPDIR}/err"
}

@test "cd_wait_healthy reads time through cd_now when core provides it" {
    load_lib
    printf 'gremion-ui\n' > "$DK/services"
    svc_state gremion-ui 'running starting'
    echo 1000 > "${BATS_TEST_TMPDIR}/clock"
    cd_now() { local t; t=$(cat "${BATS_TEST_TMPDIR}/clock"); echo $((t + 100)) > "${BATS_TEST_TMPDIR}/clock"; echo "$t"; }
    CD_WAIT_POLL_S=0.1
    t0=$SECONDS
    cd_wait_healthy app-green 300 "$TREE" 2>/dev/null && rc=0 || rc=$?
    [ "$rc" -eq 3 ]
    [ $((SECONDS - t0)) -lt 20 ]
}

@test "cd_wait_healthy lists the declared services WITHOUT the star and from the tree it is given" {
    load_lib
    printf 'gremion-ui\n' > "$DK/services"
    svc_state gremion-ui 'running healthy'
    cd_wait_healthy app-green 0 "$TREE"
    run grep -c -- '--profile' "$DK/argv.log"
    [ "$output" = 0 ]
    grep -q "^compose|--env-file|${GREMION_ROOT}/etc/env/app-green.env|config|--services$" "$DK/argv.log"
    grep -q "cwd=${TREE} " "$DK/ctx.log"
}

@test "cd_wait_healthy has no default tree: a missing or empty tree is a usage error and compose is never asked" {
    load_lib
    mkdir -p "${GREMION_ROOT}/current"
    printf 'gremion-ui\n' > "$DK/services"
    svc_state gremion-ui 'running healthy'
    run cd_wait_healthy app-green 0
    [ "$status" -eq 2 ]
    run cd_wait_healthy app-green 0 ''
    [ "$status" -eq 2 ]
    [ ! -e "$DK/argv.log" ]
    [ ! -e "$DK/ctx.log" ]
}

@test "cd_wait_healthy returns 2 for a project that renders no service, a compose failure or bad arguments" {
    load_lib
    : > "$DK/services"
    run cd_wait_healthy app-green 0 "$TREE"
    [ "$status" -eq 2 ]
    touch "$DK/config.fail"
    run cd_wait_healthy app-green 0 "$TREE"
    [ "$status" -eq 2 ]
    rm -f "$DK/config.fail"
    run cd_wait_healthy app-green soon "$TREE"
    [ "$status" -eq 2 ]
    run cd_wait_healthy app-purple 0 "$TREE"
    [ "$status" -eq 2 ]
}

@test "cd_wait_healthy: a docker that will not answer, or an inspect that fails, is never healthy" {
    load_lib
    printf 'gremion-ui\n' > "$DK/services"
    svc_state gremion-ui 'running healthy'
    CD_WAIT_POLL_S=0.1
    rm -f "$DK/status.cid-gremion-ui"
    cd_wait_healthy app-green 0 "$TREE" 2>/dev/null && rc=0 || rc=$?
    [ "$rc" -eq 3 ]
    [ "$CD_WAIT_BAD" = " gremion-ui(inspect_failed)" ]
    touch "$DK/ps.fail"
    cd_wait_healthy app-green 0 "$TREE" 2>/dev/null && rc=0 || rc=$?
    [ "$rc" -eq 3 ]
    [ "$CD_WAIT_BAD" = " gremion-ui(docker_error)" ]
}

# ------------------------------------------------------------- cd_image_id

@test "cd_wait_healthy refuses (2) a project name that STACK or the env file contradicts, at once and without waiting" {
    load_lib
    printf 'gremion-ui\n' > "$DK/services"
    svc_state gremion-ui 'running healthy'
    f="${GREMION_ROOT}/etc/env/app-green.env"
    cp "$f" "${BATS_TEST_TMPDIR}/orig.env"
    CD_WAIT_POLL_S=0.1
    for variant in stack none dup bad foreign; do
        cp "${BATS_TEST_TMPDIR}/orig.env" "$f"
        export STACK=teststack
        case "$variant" in
            stack) export STACK=other ;;
            none) sed -i '/^COMPOSE_PROJECT_NAME=/d' "$f" ;;
            dup) echo 'COMPOSE_PROJECT_NAME=teststack-app-green' >> "$f" ;;
            bad) sed -i 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=Bad Name/' "$f" ;;
            foreign) sed -i 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=teststack-app-blue/' "$f" ;;
        esac
        start=$SECONDS
        cd_wait_healthy app-green 3 "$TREE" 2>"${BATS_TEST_TMPDIR}/err" && rc=0 || rc=$?
        [ "$rc" -eq 2 ]
        [ $((SECONDS - start)) -lt 2 ]
        # the named reason survives; no colour is reported as unhealthy
        grep -q 'COMPOSE_PROJECT_NAME' "${BATS_TEST_TMPDIR}/err"
        ! grep -q 'not healthy' "${BATS_TEST_TMPDIR}/err"
        [ -z "$CD_WAIT_BAD" ]
    done
}

@test "cd_image_id prints the id of an image reference" {
    load_lib
    id="sha256:$(printf 'a%.0s' $(seq 1 64))"
    echo "$id" > "$DK/image.gremion-ui_pilot-aaaaaaaaaaaa"
    run cd_image_id gremion-ui:pilot-aaaaaaaaaaaa
    [ "$status" -eq 0 ]
    [ "$output" = "$id" ]
    [ "$(last_argv)" = "image|inspect|-f|{{.Id}}|gremion-ui:pilot-aaaaaaaaaaaa" ]
}

@test "cd_image_id returns 1 with no output for an unknown image or an answer that is no image id" {
    load_lib
    run --separate-stderr cd_image_id gremion-ui:pilot-none
    [ "$status" -eq 1 ]
    [ "$output" = "" ]
    [[ "$stderr" == *"no such image"* ]]
    [ "$(printf '%s\n' "$stderr" | wc -l)" -eq 1 ]
    echo "not-an-id" > "$DK/image.gremion-ui_pilot-odd"
    run --separate-stderr cd_image_id gremion-ui:pilot-odd
    [ "$status" -eq 1 ]
    [ "$output" = "" ]
    [ "$(printf '%s\n' "$stderr" | wc -l)" -eq 1 ]
    [[ "$stderr" == *"not an image id"* ]]
    run cd_image_id ''
    [ "$status" -eq 2 ]
    run cd_image_id '--all'
    [ "$status" -eq 2 ]
}

@test "cd_image_id tells a daemon that does not answer (2, with the reason) from a missing image (1)" {
    load_lib
    touch "$DK/image.daemon"
    run --separate-stderr cd_image_id gremion-ui:pilot-aaaaaaaaaaaa
    [ "$status" -eq 2 ]
    [ "$output" = "" ]
    [[ "$stderr" == *"docker did not answer"* ]]
    [[ "$stderr" == *"Cannot connect"* ]]
    [ "$(printf '%s\n' "$stderr" | wc -l)" -eq 1 ]
    # the same ref with a healthy daemon and no such image is still 1
    rm -f "$DK/image.daemon"
    run --separate-stderr cd_image_id gremion-ui:pilot-aaaaaaaaaaaa
    [ "$status" -eq 1 ]
}

# --------------------------------------------------------- cd_colour_other

@test "cd_colour_other swaps blue and green and refuses anything else" {
    load_lib
    [ "$(cd_colour_other blue)" = green ]
    [ "$(cd_colour_other green)" = blue ]
    run cd_colour_other red
    [ "$status" -eq 2 ]
    run cd_colour_other ''
    [ "$status" -eq 2 ]
}

# ------------------------------------------------------- the Traefik reads

@test "cd_traefik_api builds the base URL from TRAEFIK_API_PORT of state.env" {
    load_lib
    run cd_traefik_api
    [ "$status" -eq 0 ]
    [ "$output" = "http://127.0.0.1:18080" ]
}

@test "cd_traefik_api fails closed: no key, no state.env, a bad port; it never defaults to 8080" {
    load_lib
    printf 'STACK=teststack\n' > "${GREMION_ROOT}/etc/env/state.env"
    run cd_traefik_api
    [ "$status" -eq 2 ]
    [[ "$output" != *8080* ]]
    for bad in '' 0 70000 abc '80 80' '-1'; do
        printf 'STACK=teststack\nTRAEFIK_API_PORT=%s\n' "$bad" > "${GREMION_ROOT}/etc/env/state.env"
        run cd_traefik_api
        [ "$status" -eq 2 ]
        [[ "$output" != http* ]]
    done
    printf 'TRAEFIK_API_PORT=1\nTRAEFIK_API_PORT=2\n' > "${GREMION_ROOT}/etc/env/state.env"
    run cd_traefik_api
    [ "$status" -eq 2 ]
    rm -f "${GREMION_ROOT}/etc/env/state.env"
    run cd_traefik_api
    [ "$status" -eq 2 ]
}

@test "cd_traefik_service reads the JSON from the state.env base and prints it" {
    load_lib
    shim curl "cat '${FIX}/traefik-service-app.json'"
    run cd_traefik_service app@file
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r '.loadBalancer.servers[0].url')" = "http://gremion-ui-green:3000" ]
    assert_recorded curl "http://127.0.0.1:18080/api/http/services/app@file"
}

@test "cd_traefik_service returns 1 on a failed call or an answer that is no JSON object" {
    load_lib
    shim curl 'exit 22'
    run --separate-stderr cd_traefik_service app@file
    [ "$status" -eq 1 ]
    [ "$output" = "" ]
    [[ "$stderr" == "cd-docker: cd_traefik_service: "* ]]
    [ "$(printf '%s\n' "$stderr" | wc -l)" -eq 1 ]
    shim curl 'printf "<html>edge</html>"'
    run --separate-stderr cd_traefik_service app@file
    [ "$status" -eq 1 ]
    [ "$output" = "" ]
    [[ "$stderr" == "cd-docker: cd_traefik_service: "* ]]
    [ "$(printf '%s\n' "$stderr" | wc -l)" -eq 1 ]
    shim curl 'printf "[]"'
    run cd_traefik_service app@file
    [ "$status" -eq 1 ]
}

@test "cd_traefik_service refuses a bad name and a missing port without calling curl" {
    load_lib
    shim curl "cat '${FIX}/traefik-service-app.json'"
    : > "$SHIM_LOG"
    run cd_traefik_service '../x'
    [ "$status" -eq 2 ]
    run cd_traefik_service ''
    [ "$status" -eq 2 ]
    printf 'STACK=teststack\n' > "${GREMION_ROOT}/etc/env/state.env"
    run cd_traefik_service app@file
    [ "$status" -eq 2 ]
    [ ! -s "$SHIM_LOG" ]
}

# ---------------------------------------------- the file itself: independence

@test "docker.sh sources and calls nothing of the cd family but its own functions (and the optional cd_now)" {
    [ -f "$DOCKER_LIB" ]
    defined="$(grep -oE '^cd_[a-z_]+\(\)' "$DOCKER_LIB" | tr -d '()' | sort -u)"
    used="$(grep -vE '^[[:space:]]*#' "$DOCKER_LIB" | grep -oE '\bcd_[a-z_]+\b' | sort -u)"
    for u in $used; do
        case "$u" in cd_now) continue ;; esac
        printf '%s\n' "$defined" | grep -qx "$u" || { echo "docker.sh uses ${u}, which it does not define" >&2; return 1; }
    done
    code="${BATS_TEST_TMPDIR}/docker.code"
    grep -vE '^[[:space:]]*#' "$DOCKER_LIB" > "$code"
    assert_absent '(^|[[:space:];])(\.|source)[[:space:]]' "$code" "docker.sh must not source another file"
    assert_absent 'core\.sh|common\.sh' "$code" "no code may name core.sh or common.sh"
}

@test "docker.sh functions return, they never exit or die, and sourcing changes no shell option" {
    code="${BATS_TEST_TMPDIR}/docker.code"
    grep -vE '^[[:space:]]*#' "$DOCKER_LIB" | sed -e 's/|| exit 2$//' > "$code"
    assert_absent '\b(exit|die)\b' "$code" "only the subshell of cd_dc may exit"
    # bats itself runs with errexit on, so compare in a clean shell where it
    # is off: a stray `set -e`, `set -u` or `set -o pipefail` at file scope shows.
    run env -i PATH="$PATH" bash --norc --noprofile -c "
        before=\"\$-|\$(set +o)\"
        . '$DOCKER_LIB'
        after=\"\$-|\$(set +o)\"
        [ \"\$before\" = \"\$after\" ]
    "
    [ "$status" -eq 0 ]
}

@test "docker.sh runs under set -euo pipefail in a clean shell with nothing but GREMION_ROOT and STACK" {
    run env -i PATH="$PATH" GREMION_ROOT="$GREMION_ROOT" STACK=teststack bash -c "
        set -euo pipefail
        . '$DOCKER_LIB'
        cd_colour_other blue
        cd_envfile state
        cd_traefik_api
        cd_svc_cid app-blue gremion-ui
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *green* && "$output" == *"18080"* ]]
}

# A `compose run` container (label oneoff=True) is never "the" container of a
# service and never one of the project's containers: a migration that is still
# running must not be mistaken for the service it shares a name with.
@test "cd_svc_cid and cd_project_cids leave out one-off containers" {
    load_lib
    printf 'run999\n' > "$DK/oneoff.teststack-app-blue"
    printf 'c111\n' > "$DK/cid.teststack-app-blue.gremion-ui"
    printf 'c111\n' > "$DK/cids.teststack-app-blue"
    run cd_svc_cid app-blue gremion-ui
    [ "$status" -eq 0 ]
    [ "$output" = c111 ]
    run cd_project_cids app-blue
    [ "$status" -eq 0 ]
    [ "$output" = c111 ]
    rm -f "$DK/cid.teststack-app-blue.gremion-ui"
    run cd_svc_cid app-blue gremion-ui
    [ "$output" = "" ]
}

# ------------------------------- cd_set_env_key: refusals that keep the file

@test "cd_set_env_key refuses a symbolic link and leaves the target alone" {
    load_lib
    f="${BATS_TEST_TMPDIR}/real.env"
    mk_envfile "$f"
    ln -s "$f" "${BATS_TEST_TMPDIR}/link.env"
    before="$(cksum < "$f")"
    run cd_set_env_key "${BATS_TEST_TMPDIR}/link.env" IMAGE_TAG changed
    [ "$status" -eq 2 ]
    [ "$(cksum < "$f")" = "$before" ]
    [ -L "${BATS_TEST_TMPDIR}/link.env" ]
}

@test "cd_set_env_key refuses to replace a file whose owner it cannot keep" {
    # No root needed: chown is a no-op and stat reports a foreign owner for the
    # temporary copy only, which is what a refused chown leaves behind.
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    mk_envfile "$f"
    real_stat="$(command -v stat)"
    shim chown 'exit 0'
    shim stat "case \"\${*: -1}\" in *x.env.*) echo 9999:9999 ;; *) exec ${real_stat} \"\$@\" ;; esac"
    hash -r
    before="$(cksum < "$f")"
    run --separate-stderr cd_set_env_key "$f" IMAGE_TAG changed
    [ "$status" -eq 1 ]
    [[ "$stderr" == *"cannot keep the owner"* ]]
    [ "$(cksum < "$f")" = "$before" ]
    [ "$(ls "${BATS_TEST_TMPDIR}" | grep -c '^x.env')" = 1 ]
}

@test "cd_set_env_key reports a copy that does not read back as written" {
    load_lib
    f="${BATS_TEST_TMPDIR}/x.env"
    mk_envfile "$f"
    # a mv that puts something else in place of the finished copy
    shim mv 'for last; do :; done; printf "garbage\n" > "$last"'
    hash -r
    run --separate-stderr cd_set_env_key "$f" IMAGE_TAG changed
    [ "$status" -eq 1 ]
    [[ "$stderr" == *"does not read back"* ]]
}
