#!/usr/bin/env bats
# Unit tests for test/host/integration/pooled-stack-proof.sh (TASK-040).
#
# The proof's own checks must be able to go RED. Nothing here reaches a real
# docker engine: `docker` is test/host/fixtures/pooled-stack/docker-shim/docker,
# which answers the app-wait and cold-state phases for one app-blue colour and
# a three-container state tier and logs every stop/start/restart it sees. Its
# gremion-ui answers /api/health the way the real resolver does (403 without
# x-proxy-trust, 404 without a registered forwarded host), so a probe that
# would fail on a running stack fails here too.
# The running proof itself is `bash test/host/integration/pooled-stack-proof.sh all`.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
PROOF="${REPO_ROOT}/test/host/integration/pooled-stack-proof.sh"

setup() {
    local bin="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$bin"
    # A copy with an executable bit, whatever the checkout's file mode is.
    tr -d '\r' < "${REPO_ROOT}/test/host/fixtures/pooled-stack/docker-shim/docker" > "${bin}/docker"
    chmod +x "${bin}/docker"
    export PATH="${bin}:${PATH}"
    export SHIM_STACK=t040-shim
    export SHIM_DIR="${BATS_TEST_TMPDIR}/shim"
    export SHIM_PROXY_SECRET="shim-secret-$RANDOM$RANDOM"
    export POOLED_STACK=t040-shim
    export POOLED_OUT="${BATS_TEST_TMPDIR}/out"
    # the directories prepare would have made before any later phase runs
    mkdir -p "${POOLED_OUT}/ledger"
    # cold-state budgets, in seconds, kept short for the shim
    export POOLED_COLD_HOLD=0
    export POOLED_COLD_BUDGET=3
    export POOLED_POLL=1
    unset SHIM_ALIAS_STATE SHIM_READY SHIM_READY_DOWN SHIM_REGISTER SHIM_PS SHIM_COMPOSE_LS
}

# ── app-wait: the per-colour isolation checks ────────────────────────────────

@test "app-wait: a correctly aliased colour is GREEN (positive control for the shim)" {
    run bash "$PROOF" app-wait blue
    [ "$status" -eq 0 ]
    [[ "$output" == *"ok   app-blue: 2 container(s)"* ]]
    [[ "$output" == *"[pooled-proof] GREEN"* ]]
    [[ "$output" != *"FAIL"* ]]
}

@test "app-wait: gremion-ui without its <svc>-<colour> alias on _state is RED (verify-r2 HIGH 2)" {
    export SHIM_ALIAS_STATE=wrongalias
    run bash "$PROOF" app-wait blue
    [[ "$output" == *"FAIL /cid-ui on t040-shim_state carries no gremion-ui-blue alias"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
    # and it does not claim the isolation check passed
    [[ "$output" != *"ok   app-blue: "*" every shared-network alias"* ]]
}

@test "run.log records the phases that ran, not the empty list left after the loop (verify-r2 MEDIUM 2)" {
    run bash "$PROOF" app-wait blue
    [ "$status" -eq 0 ]
    grep -q 'phases \[app-wait blue\] RED=0' "${POOLED_OUT}/ledger/run.log"
}

# ── the shim's resolver model (what the real gremion-ui answers) ─────────────

@test "shim: /api/health is not resolve-exempt -- bare 403, untrusted 403, no/forged/unregistered host 404" {
    export SHIM_READY=ok
    local u=http://127.0.0.1:3000/api/health
    run docker exec cid-ui wget -qO- "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"403 Forbidden"* ]]
    run docker exec cid-ui wget -qO- --header "x-proxy-trust: wrong" --header "x-forwarded-host: a.example" --header "Host: a.example" "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"403 Forbidden"* ]]
    run docker exec cid-ui sh -c 'wget -qO- --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" "$1"' sh "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"404 Not Found"* ]]
    run docker exec cid-ui sh -c 'wget -qO- --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" --header "x-forwarded-host: a.example" --header "Host: a.example" "$1"' sh "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"404 Not Found"* ]]   # host not registered
    echo a.example > "${SHIM_DIR}/hosts"
    run docker exec cid-ui sh -c 'wget -qO- --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" --header "x-forwarded-host: a.example" --header "Host: b.example" "$1"' sh "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"404 Not Found"* ]]   # Host != forwarded host
    run docker exec cid-ui sh -c 'wget -qO- --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" --header "x-forwarded-host: a.example" --header "Host: a.example" "$1"' sh "$u"
    [ "$status" -eq 0 ]; [[ "$output" == *'"status":"ok"'* ]]
}

# ── cold-state: the app re-boots against a DOWN state tier ───────────────────

@test "cold-state: the app is restarted while state is down and is ready by /api/health once state is back" {
    export SHIM_READY=ok
    run bash "$PROOF" cold-state
    [ "$status" -eq 0 ]
    [[ "$output" == *"[pooled-proof] GREEN"* ]]
    # order: state stopped, then the app colour restarted, then state started
    local calls="${SHIM_DIR}/calls.log"
    local l_stop l_restart l_start
    l_stop="$(grep -n '^stop ' "$calls" | head -n1 | cut -d: -f1)"
    l_restart="$(grep -n '^restart ' "$calls" | head -n1 | cut -d: -f1)"
    l_start="$(grep -n '^start ' "$calls" | head -n1 | cut -d: -f1)"
    [ -n "$l_stop" ] && [ -n "$l_restart" ] && [ -n "$l_start" ]
    [ "$l_stop" -lt "$l_restart" ]
    [ "$l_restart" -lt "$l_start" ]
    grep -q '^stop .*cid-postgres' "$calls"
    grep -q '^restart .*cid-ui' "$calls"
    # readiness, not liveness: the proof asked /api/health, the way the edge does
    grep -q '/api/health' "$calls"
    grep -q 'x-proxy-trust' "$calls"
    grep -q 'INSERT INTO tenant_domain' "$calls"
    grep -q 'cold-state ready' "${POOLED_OUT}/ledger/cold-state.log"
}

@test "cold-state: the proxy-trust secret never reaches the docker argv, the output or the ledger" {
    export SHIM_READY=ok
    run bash "$PROOF" cold-state
    [ "$status" -eq 0 ]
    [[ "$output" != *"$SHIM_PROXY_SECRET"* ]]
    ! grep -rqF "$SHIM_PROXY_SECRET" "${SHIM_DIR}/calls.log" "${POOLED_OUT}"
}

@test "cold-state: a probe that cannot see ready on the running stack is RED before state is touched (positive control)" {
    export SHIM_READY=no
    run bash "$PROOF" cold-state
    [[ "$output" == *"FAIL cold-state: positive control"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
    ! grep -q '^stop ' "${SHIM_DIR}/calls.log"
}

@test "cold-state: a proof host the control DB does not register is RED" {
    export SHIM_READY=ok SHIM_REGISTER=fail
    run bash "$PROOF" cold-state
    [[ "$output" == *"FAIL cold-state: could not register"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
    ! grep -q '^stop ' "${SHIM_DIR}/calls.log"
}

@test "cold-state: an app that never becomes ready after state returns is RED (state held down past the retry budget)" {
    export SHIM_READY=stuck
    run bash "$PROOF" cold-state
    [[ "$output" == *"FAIL cold-state: app-blue gremion-ui not ready"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
}

@test "cold-state: a readiness probe that answers ok while state is DOWN is RED (negative control)" {
    export SHIM_READY_DOWN=ok
    run bash "$PROOF" cold-state
    [[ "$output" == *"FAIL cold-state: /api/health answers ok with the state tier DOWN"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
}

# ── render-env: every COMPOSE_FILE entry is a file that exists (TASK-040-FU 1) ─
# prepare's env render, alone: no docker engine, no write under the repo. The
# entries are read the way compose reads them -- split on the file's own
# COMPOSE_PATH_SEPARATOR, a relative entry resolved against the directory the
# proof's compose() runs in -- and every one must be an existing file.

# unresolved_compose_files <env file> <dir compose runs in>: prints every entry
# that does not resolve to an existing file; prints nothing when all resolve.
unresolved_compose_files() {
    local f="$1" dir="$2" files sep e
    files="$(sed -n 's/^COMPOSE_FILE=//p' "$f")"; files="${files#\"}"; files="${files%\"}"
    sep="$(sed -n 's/^COMPOSE_PATH_SEPARATOR=//p' "$f")"; sep="${sep#\"}"; sep="${sep%\"}"
    [[ -n "$files" && -n "$sep" ]] || { echo "$f: no COMPOSE_FILE or COMPOSE_PATH_SEPARATOR"; return 0; }
    local IFS="$sep"
    for e in $files; do
        e="${e#Z:}"   # the fake cygpath's drive letter (see the drive-letter test)
        case "$e" in /*) ;; *) e="${dir}/${e}" ;; esac
        [[ -f "$e" ]] || echo "$f: $e"
    done
}

# assert_env_files_resolve: state and both app colours run compose from the
# repo root, ops from compose/observability (TASK-039) and mail from
# infra/host/mail (the proof's compose()).
assert_env_files_resolve() {
    local env="${POOLED_OUT}/env" bad=""
    local p
    for p in state app-blue app-green; do
        [ -s "${env}/${p}.env" ]
        bad+="$(unresolved_compose_files "${env}/${p}.env" "$REPO_ROOT")"
    done
    [ -s "${env}/ops.env" ]
    bad+="$(unresolved_compose_files "${env}/ops.env" "${REPO_ROOT}/compose/observability")"
    [ -s "${env}/mail.env" ]
    bad+="$(unresolved_compose_files "${env}/mail.env" "${REPO_ROOT}/infra/host/mail")"
    [ -z "$bad" ] || { echo "unresolved COMPOSE_FILE entries: $bad" >&2; return 1; }
}

@test "render-env: POOLED_OUT outside the repo -- every COMPOSE_FILE entry names a file that exists, the overlays the ones written there" {
    case "$POOLED_OUT" in "$REPO_ROOT"/*) skip "BATS_TEST_TMPDIR is under the repo" ;; esac
    run bash "$PROOF" render-env
    [ "$status" -eq 0 ]
    [ -s "${POOLED_OUT}/state.proof.yml" ] && [ -s "${POOLED_OUT}/ops.proof.yml" ] && [ -s "${POOLED_OUT}/mail.proof.yml" ]
    assert_env_files_resolve
    # the overlays named are the ones this run wrote, not a stale in-repo copy
    grep -qF "${POOLED_OUT}/state.proof.yml" "${POOLED_OUT}/env/state.env"
    grep -qF "${POOLED_OUT}/ops.proof.yml" "${POOLED_OUT}/env/ops.env"
    grep -qF "${POOLED_OUT}/mail.proof.yml" "${POOLED_OUT}/env/mail.env"
}

@test "render-env: POOLED_OUT under the repo keeps repo-relative COMPOSE_FILE entries that resolve" {
    export POOLED_OUT="${REPO_ROOT}/.scratch/pooled-stack-proof/t040-shim-bats-${BATS_TEST_NUMBER}-$$"
    IN_REPO_OUT="$POOLED_OUT"
    run bash "$PROOF" render-env
    [ "$status" -eq 0 ]
    assert_env_files_resolve
    local rel=".scratch/pooled-stack-proof/t040-shim-bats-${BATS_TEST_NUMBER}-$$"
    grep -qxF "COMPOSE_FILE=\"docker-compose.yml:docker-compose.prod.yml:test/host/fixtures/pooled-stack/docker-compose.state-pins.yml:${rel}/state.proof.yml\"" "${POOLED_OUT}/env/state.env"
    # TASK-039: ops runs from compose/observability, two levels down.
    grep -qxF "COMPOSE_FILE=\"docker-compose.yml:../../${rel}/ops.proof.yml\"" "${POOLED_OUT}/env/ops.env"
    grep -qxF "COMPOSE_FILE=\"docker-compose.yml:../../../${rel}/mail.proof.yml\"" "${POOLED_OUT}/env/mail.env"
}

@test "render-env: a drive-letter host path (cygpath -m) is not split on ':' and the env file still sources in bash" {
    case "$POOLED_OUT" in "$REPO_ROOT"/*) skip "BATS_TEST_TMPDIR is under the repo" ;; esac
    # a Windows box's cygpath -m: /x/y -> Z:/x/y
    printf '#!/usr/bin/env bash\n[[ "$1" == -m ]] && shift\nprintf "Z:%%s" "$1"\n' > "${BATS_TEST_TMPDIR}/bin/cygpath"
    chmod +x "${BATS_TEST_TMPDIR}/bin/cygpath"
    run bash "$PROOF" render-env
    [ "$status" -eq 0 ]
    grep -qF "Z:${POOLED_OUT}/state.proof.yml" "${POOLED_OUT}/env/state.env"
    assert_env_files_resolve
    # state-wait, tenant and tenant-after source state.env: a ';' list must
    # arrive whole, and nothing in it may run as a command
    run bash -c 'set -eu; . "$1"; printf "%s|%s" "$COMPOSE_PATH_SEPARATOR" "$COMPOSE_FILE"' _ "${POOLED_OUT}/env/state.env"
    [ "$status" -eq 0 ]
    [[ "$output" == ";|docker-compose.yml;"*";Z:${POOLED_OUT}/state.proof.yml" ]]
}

# ── a failing `compose config` is never silent (TASK-040-FU 2) ────────────────
# names and counts ran `compose config 2>/dev/null` inside $(...) under
# pipefail: a render error either exited the proof with status 1 and no word
# (names) or recorded services=0 on both sides of TRD-440 (counts).

@test "names: positive control -- a clean render under \${STACK} is GREEN" {
    run bash "$PROOF" names
    [ "$status" -eq 0 ]
    [[ "$output" == *"ok   names: every rendered project"* ]]
    [ -f "${POOLED_OUT}/.names-ok" ]
}

@test "names: a failing compose config is a FATAL naming the project and compose's stderr (first 5 lines only)" {
    export SHIM_COMPOSE_CONFIG=fail
    run bash "$PROOF" names
    [ "$status" -ne 0 ]
    [[ "$output" == *"FATAL: "*"t040-shim-state"* ]]
    [[ "$output" == *"shim-compose-error line 1: service \"svc\" refers to undefined network nowhere"* ]]
    [[ "$output" == *"shim-compose-error line 5"* ]]
    [[ "$output" != *"shim-compose-error line 6"* ]]
    [ ! -f "${POOLED_OUT}/.names-ok" ]
    # the captured stderr does not outlive the message
    [ -z "$(find "$POOLED_OUT" -name '*.err' 2>/dev/null)" ]
}

@test "tenant-before: positive control -- the baseline counts the rendered services" {
    run bash "$PROOF" tenant-before
    [ "$status" -eq 0 ]
    grep -qx 'state services=2 running=3' "${POOLED_OUT}/ledger/trd440-before.txt"
}

@test "tenant-before: a failing compose config is a FATAL, never a services=0 baseline" {
    export SHIM_COMPOSE_CONFIG=fail
    run bash "$PROOF" tenant-before
    [ "$status" -ne 0 ]
    [[ "$output" == *"FATAL: "*"t040-shim-state"*"shim-compose-error line 1"* ]]
    [[ "$output" != *"ok   tenant-before"* ]]
    # not `! grep` mid-body: a !-negated command can never fail a bats test (common.bats:160 guard)
    run grep -q 'services=0' "${POOLED_OUT}/ledger/trd440-before.txt"
    [ "$status" -ne 0 ]
    # no half-written baseline for the tenant phase to accept
    [ ! -f "${POOLED_OUT}/ledger/trd440-before.txt" ]
}

# ── a failing docker engine is never a count of 0 (R29-MD-A, TRD-440) ────────
# counts() read `docker ps` and `docker compose ls` inside printf arguments: an
# engine error came out as running=0, an empty compose-ls and stack-containers 0
# on BOTH sides of TRD-440, and the tenant-add "changed nothing" on a dead engine.

@test "tenant-before: a failing docker ps is a FATAL naming the running= reading, never a running=0 baseline" {
    export SHIM_PS=fail
    run bash "$PROOF" tenant-before
    [ "$status" -ne 0 ]
    [[ "$output" == *"FATAL: "*"running="*"t040-shim-state"* ]]
    [[ "$output" != *"ok   tenant-before"* ]]
    [ ! -f "${POOLED_OUT}/ledger/trd440-before.txt" ]
    [ ! -f "${POOLED_OUT}/ledger/trd440-before.txt.part" ]
}

@test "tenant-before: a failing docker compose ls is a FATAL naming compose-ls, never an empty compose-ls baseline" {
    export SHIM_COMPOSE_LS=fail
    run bash "$PROOF" tenant-before
    [ "$status" -ne 0 ]
    [[ "$output" == *"FATAL: "*"compose-ls"* ]]
    [[ "$output" != *"ok   tenant-before"* ]]
    [ ! -f "${POOLED_OUT}/ledger/trd440-before.txt" ]
    [ ! -f "${POOLED_OUT}/ledger/trd440-before.txt.part" ]
}

@test "tenant-after: a failing docker ps against a baseline a failing engine wrote is a FATAL, not 'unchanged'" {
    run bash "$PROOF" render-env
    [ "$status" -eq 0 ]
    # exactly what an unfixed tenant-before wrote under SHIM_PS=fail (fixture)
    tr -d '\r' < "${REPO_ROOT}/test/host/fixtures/pooled-stack/trd440-before-failing-engine.txt" > "${POOLED_OUT}/ledger/trd440-before.txt"
    [ -s "${POOLED_OUT}/env/state.env" ]
    export SHIM_PS=fail
    run bash "$PROOF" tenant-after
    [[ "$output" == *"FATAL: "*"running="* ]] || { echo "no FATAL naming the running= reading; the proof said:" >&2; echo "$output" >&2; return 1; }
    [ "$status" -ne 0 ]
    [[ "$output" != *"ok   TRD-440: services, running containers and compose projects unchanged by the tenant-add"* ]]
}

@test "tenant-before: a failing compose config leaves neither an earlier baseline nor a .part behind" {
    printf 'state services=2 running=3\n' > "${POOLED_OUT}/ledger/trd440-before.txt"
    printf 'half written\n' > "${POOLED_OUT}/ledger/trd440-before.txt.part"
    export SHIM_COMPOSE_CONFIG=fail
    run bash "$PROOF" tenant-before
    [ "$status" -ne 0 ]
    [ ! -f "${POOLED_OUT}/ledger/trd440-before.txt" ]
    [ ! -f "${POOLED_OUT}/ledger/trd440-before.txt.part" ]
}

# ── Linux-vs-Docker-Desktop drift (r33g-proofsh) ─────────────────────────────
# Defects a real Linux host hit: MAIL_TRANSPORT never rendered, host-gateway is
# docker0 (not loopback), the ops binds collide with another ops stack, the
# bind-mounted dirs were created root-owned by the daemon, teardown left a stale
# scratch root, aux-up ran --pull never against images that were not local.

# A `uname` that says Linux, in a directory that is put on PATH for the proof's
# own run only (bats itself must keep the real uname): PATH="$LINUX_PATH".
linux_uname() {
    STUBS="${BATS_TEST_TMPDIR}/stubs"; mkdir -p "$STUBS"
    printf '#!/usr/bin/env bash\necho Linux\n' > "${STUBS}/uname"; chmod +x "${STUBS}/uname"
    LINUX_PATH="${STUBS}:${PATH}"
}

@test "render-env: mail.env carries MAIL_TRANSPORT=stalwart (mandatory, no default; the proof runs its own Stalwart)" {
    run bash "$PROOF" render-env
    [ "$status" -eq 0 ]
    grep -qxF 'MAIL_TRANSPORT=stalwart' "${POOLED_OUT}/env/mail.env"
}

@test "precreate_bind_dirs: the app's bind sources exist, owned by the invoking user, before any container" {
    export SROOT="${BATS_TEST_TMPDIR}/sroot"
    run bash -c 'set -euo pipefail; . "$1"; SROOT="$2"; precreate_bind_dirs' _ "$PROOF" "$SROOT"
    [ "$status" -eq 0 ]
    local d
    for d in etc/secrets/control-panel etc/secrets/tenant-create data/module-exports etc/edge; do
        [ -d "${SROOT}/${d}" ] || { echo "missing ${d}" >&2; return 1; }
        [ -O "${SROOT}/${d}" ] || { echo "${d} not owned by the invoking user" >&2; return 1; }
    done
}

@test "precreate_bind_dirs: every etc/secrets or data/ bind source docker-compose.app.yml names is pre-created" {
    local want src
    want="$(sed -n 's#.*GREMION_ROOT:-/opt/gremion}/\(etc/secrets/[a-z-]*\|data/[a-z-]*\)[:/].*#\1#p' "${REPO_ROOT}/docker-compose.app.yml" | tr -d '\r' | sort -u)"
    [ -n "$want" ]
    for src in $want; do
        grep -qF "/${src}\"" "$PROOF" || { echo "prepare does not pre-create ${src}" >&2; return 1; }
    done
}

@test "scratch_rm: removes a tree under .scratch/**/<STACK>/ and nothing else" {
    local s="t040-shim-rm-$$"
    IN_REPO_OUT="${REPO_ROOT}/.scratch/pooled-stack-proof/${s}"
    local t="${IN_REPO_OUT}/root"
    mkdir -p "$t/etc/secrets/tenant-create"; echo s > "$t/etc/secrets/tenant-create/secret"
    run bash -c 'set -euo pipefail; . "$1"; STACK="$3"; scratch_rm "$2"; echo "RED=$RED"' _ "$PROOF" "$t" "$s"
    [ "$status" -eq 0 ]
    [[ "$output" == *"RED=0"* ]]
    [ ! -e "$t" ]
}

@test "scratch_rm: a path outside .scratch is REFUSED -- left in place, RED, nothing deleted" {
    local t="${BATS_TEST_TMPDIR}/t040-shim/root"
    mkdir -p "$t"; echo keep > "$t/keep"
    run bash -c 'set -uo pipefail; . "$1"; STACK=t040-shim; rc=0; scratch_rm "$2" || rc=$?; echo "rc=$rc RED=$RED"' _ "$PROOF" "$t"
    [[ "$output" == *"refusing"*"outside"* ]]
    [[ "$output" == *"rc=1 RED=1"* ]]
    [ -f "$t/keep" ]
}

@test "scratch_rm: .. traversal, the empty string and a .scratch path without the STACK component are all refused" {
    local s="t040-shim-tr-$$"
    IN_REPO_OUT="${REPO_ROOT}/.scratch/pooled-stack-proof/${s}"
    IN_REPO_OTHER="${REPO_ROOT}/.scratch/other-$$"
    mkdir -p "$IN_REPO_OUT" "$IN_REPO_OTHER"
    local trav="${IN_REPO_OUT}/../../../.."   # climbs out of .scratch
    run bash -c 'set -uo pipefail; . "$1"; STACK="$2"
        r=0; scratch_rm "$3" || r=$?; echo "trav=$r"
        r=0; scratch_rm "" || r=$?; echo "empty=$r"; r=0; scratch_rm "$4" || r=$?; echo "nostack=$r"' \
        _ "$PROOF" "$s" "$trav" "$IN_REPO_OTHER"
    [[ "$output" == *"trav=1"* && "$output" == *"empty=1"* && "$output" == *"nostack=1"* ]]
    [ -d "$IN_REPO_OTHER" ]
    [ -d "$IN_REPO_OUT" ]
}

@test "scratch_rm: a symlink under .scratch pointing outside is refused and its target survives" {
    local s="t040-shim-ln-$$"
    IN_REPO_OUT="${REPO_ROOT}/.scratch/pooled-stack-proof/${s}"
    mkdir -p "$IN_REPO_OUT"
    local victim="${BATS_TEST_TMPDIR}/victim"; mkdir -p "$victim"; echo keep > "$victim/keep"
    ln -s "$victim" "${IN_REPO_OUT}/link" 2>/dev/null && [ -L "${IN_REPO_OUT}/link" ] || skip "no real symlinks here"
    run bash -c 'set -uo pipefail; . "$1"; STACK="$2"; r=0; scratch_rm "$3" || r=$?; echo "link=$r"' _ "$PROOF" "$s" "${IN_REPO_OUT}/link"
    [[ "$output" == *"link=1"* ]]
    [ -f "$victim/keep" ]
}

@test "scratch_rm: a path that does not exist is a no-op, not a failure" {
    run bash -c 'set -uo pipefail; . "$1"; STACK=t040-shim; rc=0; scratch_rm "$2" || rc=$?; echo "rc=$rc RED=$RED"' _ "$PROOF" "${REPO_ROOT}/.scratch/pooled-stack-proof/t040-shim-never/root"
    [[ "$output" == *"rc=0 RED=0"* ]]
}

@test "perm_hint: prints the run-as-root hint for a non-writable path as a non-root Linux user, nothing otherwise" {
    linux_uname
    printf '#!/usr/bin/env bash\necho 1000\n' > "${STUBS}/id"; chmod +x "${STUBS}/id"
    local ro="${BATS_TEST_TMPDIR}/ro"; mkdir -p "$ro"; chmod 555 "$ro"
    [ ! -w "$ro" ] || { chmod 755 "$ro"; skip "directory permissions are not enforced here"; }
    PATH="$LINUX_PATH" run bash -c 'set -euo pipefail; . "$1"; perm_hint "$2/sub"' _ "$PROOF" "$ro"
    chmod 755 "$ro"
    [[ "$output" == *"runs as root, like production"* && "$output" == *"sudo -E"* ]]
    PATH="$LINUX_PATH" run bash -c 'set -euo pipefail; . "$1"; perm_hint "$2"' _ "$PROOF" "$BATS_TEST_TMPDIR"      # writable: no hint
    [ -z "$output" ]
    printf '#!/usr/bin/env bash\necho 0\n' > "${STUBS}/id"                  # root: no hint
    PATH="$LINUX_PATH" run bash -c 'set -euo pipefail; . "$1"; perm_hint "$2/sub"' _ "$PROOF" "$ro"
    [ -z "$output" ]
}

teardown() {
    [[ -z "${IN_REPO_OUT:-}" ]] || rm -rf "$IN_REPO_OUT"
    [[ -z "${IN_REPO_OTHER:-}" ]] || rm -rf "$IN_REPO_OTHER"
}
