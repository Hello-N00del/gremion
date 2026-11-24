#!/usr/bin/env bash
# test/host/test_helper/cd-pipeline.bash -- the whole-pipeline helper of cd-pipeline.bats.
#
#     load 'test_helper/host'
#     load 'test_helper/cd'
#     load 'test_helper/cd-github'
#     load 'test_helper/cd-pipeline'
#
# EVERY LIBRARY IS THE REAL ONE. gremion-cd is run from the whole infra/host tree, so no function of
# infra/host/lib/cd is replaced; the helper's stub file steps aside for all of them (pl_no_stubs checks
# that no `stub ...` line ever reaches the call log). Only programs outside the family are shims:
#   docker, curl     one world each (fixtures/cd/pipeline/docker.body and curl.body), state under $DK
#   git              the REAL git, recorded (the code host is a local bare repository)
#   logger, systemctl, df, ionice, renice
#   gremion-switch, gremion-render, gremion-tenant   committed into the release trees (as the program
#                    finds them: <tree>/infra/host/bin, current/infra/host/bin)
#   gremion-migration-dump, gremion-isolation, gremion-verify, gremion-mail   in $GREMION_ROOT/bin
# The clock is the fake clock of the program (cd_sleep moves it), so a window of twenty minutes takes
# a moment. A kill -9 is done from outside the libraries: a hook file the world shims evaluate
# (DK/*.hook), or a second process.
#
# The world, in words: a host whose live release is the first commit of a small repository, blue
# serving; a state project with a main postgres and three module servers; three customers.

PL_FIX="${HOST_TEST_DIR}/fixtures/cd/pipeline"
PL_H1=11111111111111111111111111111111
PL_H2=22222222222222222222222222222222
PL_H3=33333333333333333333333333333333
PL_H4=44444444444444444444444444444444

# pl_script NAME DEST -- a fixture body installed as an executable program.
pl_script() {
    local dest="$2"
    mkdir -p "$(dirname "$dest")"
    if ! head -n 1 "${PL_FIX}/$1.body" | grep -q '^#!'; then
        { echo '#!/usr/bin/env bash'; cat "${PL_FIX}/$1.body"; } >"$dest"
    else
        cp "${PL_FIX}/$1.body" "$dest"
    fi
    chmod +x "$dest"
}

# -- reading the world ---------------------------------------------------------------------------
pl_state() { jq -r "$1" "${GREMION_ROOT}/data/cd/state.json"; }
pl_hist() { # EVENT -- how many history lines of the event
    if [ ! -f "${GREMION_ROOT}/data/cd/history.jsonl" ]; then echo 0; return 0; fi
    jq -s --arg e "$1" '[.[] | select(.event == $e)] | length' "${GREMION_ROOT}/data/cd/history.jsonl"
}
pl_blocks() { if [ -f "${GREMION_ROOT}/data/cd/blocked.json" ]; then jq -r 'length' "${GREMION_ROOT}/data/cd/blocked.json"; else echo 0; fi; }
pl_order() { cat "$DK/order.log" 2>/dev/null || true; }
# pl_before A B -- the first line of the order log that matches A is before the first that matches B
pl_before() {
    local a b
    a="$(grep -n -m1 -E -- "$1" "$DK/order.log" | cut -d: -f1)" || a=''
    b="$(grep -n -m1 -E -- "$2" "$DK/order.log" | cut -d: -f1)" || b=''
    [ -n "$a" ] || { echo "pl_before: not in the order log: $1" >&2; cat "$DK/order.log" >&2; return 1; }
    [ -n "$b" ] || { echo "pl_before: not in the order log: $2" >&2; cat "$DK/order.log" >&2; return 1; }
    [ "$a" -lt "$b" ] || { echo "pl_before: '$1' ($a) is not before '$2' ($b)" >&2; cat "$DK/order.log" >&2; return 1; }
}
# pl_after A B -- the LAST line of the order log that matches B is after the first that matches A
pl_after() {
    local a b
    a="$(grep -n -m1 -E -- "$1" "$DK/order.log" | cut -d: -f1)" || a=''
    b="$(grep -n -E -- "$2" "$DK/order.log" | tail -n 1 | cut -d: -f1)" || b=''
    [ -n "$a" ] || { echo "pl_after: not in the order log: $1" >&2; cat "$DK/order.log" >&2; return 1; }
    [ -n "$b" ] || { echo "pl_after: not in the order log: $2" >&2; cat "$DK/order.log" >&2; return 1; }
    [ "$b" -gt "$a" ] || { echo "pl_after: '$2' ($b) is not after '$1' ($a)" >&2; cat "$DK/order.log" >&2; return 1; }
}
pl_count() { grep -c -E -- "$1" "$DK/order.log" 2>/dev/null || true; }
# pl_mails KIND -- how many mails of the kind left the program: the relay took them (the curl world keeps
# a copy of each) or they still wait in the outbox
pl_mails() {
    local n=0 f
    for f in "$DK"/mail.*.eml "${GREMION_ROOT}"/data/cd/outbox/*.eml; do
        [ -f "$f" ] || continue
        if grep -q "^kind: $1[[:space:]]*$" "$f"; then n=$((n + 1)); fi
    done
    echo "$n"
}
# pl_mail_field FILE KEY -- the value of one `key: value` line of a mail (the lines end in CRLF)
pl_mail_field() { sed -n "s/^$2: //p" "$1" | tr -d '\r'; }
# pl_mail_file KIND -- the first mail of the kind
pl_mail_file() {
    local f
    for f in "$DK"/mail.*.eml "${GREMION_ROOT}"/data/cd/outbox/*.eml; do
        if [ -f "$f" ] && grep -q "^kind: $1[[:space:]]*$" "$f"; then echo "$f"; return 0; fi
    done
    return 1
}
pl_hostlock_free() { ( exec 9>>"${GREMION_ROOT}/runtime/hostd.lock"; flock -n 9 ); }
pl_cdlock_free() { ( exec 8>>"${GREMION_ROOT}/runtime/cd/cd.lock"; flock -n 8 ); }
# no stand-in of the family was used: the stub file only ever names functions the libraries define
pl_no_stubs() {
    if grep -q '^stub ' "$SHIM_LOG"; then
        echo "a stand-in of the family ran:" >&2
        grep '^stub ' "$SHIM_LOG" >&2
        return 1
    fi
}
# everything a release moves, as one string
pl_fingerprint() {
    {
        readlink "${GREMION_ROOT}/current" 2>/dev/null || echo no-current
        cat "${GREMION_ROOT}/etc/env/app-blue.env" "${GREMION_ROOT}/etc/env/app-green.env" "${GREMION_ROOT}/runtime/active-colour"
        cat "${GREMION_ROOT}/runtime/current-tag" "${GREMION_ROOT}/runtime/previous-tag" 2>/dev/null || true
        jq -S '{live, previous}' "${GREMION_ROOT}/data/cd/state.json"
        cat "${GREMION_ROOT}/data/cd/blocked.json" 2>/dev/null || echo no-blocks
    } | sha256sum
}

# pl_tick [ARGS] -- one tick of the program, to the end
pl_tick() { "${HOST_SRC}/bin/gremion-cd" tick "$@" </dev/null; }

# pl_assert_committed -- the end state of a release of C_B on top of C_L0 that committed: live, previous,
# `current`, the tag files, the colour that serves, the env files, the isolation record, nothing in flight,
# the locks free and the dump set retired
pl_assert_committed() {
    local b12="${C_B:0:12}" l12="${C_L0:0:12}"
    [ "$(pl_state .live.sha)" = "$C_B" ]
    [ "$(pl_state .live.colour)" = green ]
    [ "$(pl_state .previous.sha)" = "$C_L0" ]
    [ "$(pl_state .previous.colour)" = blue ]
    [ "$(pl_state .previous.startable)" = true ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${b12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${b12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "pilot-${l12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = green ]
    [ "$(jq -r '.loadBalancer.servers[0].url' "$DK/traefik.app@file")" = "http://gremion-ui-green:3000" ]
    assert_present "^IMAGE_TAG=pilot-${b12}\$" "${GREMION_ROOT}/etc/env/app-green.env"
    assert_present "^IMAGE_TAG=pilot-${l12}\$" "${GREMION_ROOT}/etc/env/app-blue.env"
    [ "$(cat "${GREMION_ROOT}/data/isolation-recorded")" = "$C_B" ]
    [ "$(pl_blocks)" = 0 ]
    pl_hostlock_free
    pl_cdlock_free
    [ ! -s "$DK/live.tsv" ]
}

# -- kill -9 from outside the libraries ---------------------------------------------------------------
# Every program of the world calls pl_hook "<program> <args>" first (hook.sh, written by pl_setup).
# While $DK/kill.at holds an extended regular expression, the NTH (kill.nth, default 1) call whose text
# matches it kills the program under test with signal 9 and does not return: the call it was is the
# one the program died in.
pl_write_hook() {
    cat >"$DK/hook.sh" <<'HOOK'
pl_hook() {
    local r base
    # a change of the world at a call: $DK/run.<name>.re holds the pattern, run.<name>.sh the shell to
    # run, once, at the first call that matches (before the call does its work)
    for r in "$DK"/run.*.re; do
        [ -f "$r" ] || continue
        if printf '%s\n' "$1" | grep -qE -- "$(cat "$r")"; then
            base="${r%.re}"
            mv -f "$r" "${base}.done"
            . "${base}.sh"
        fi
    done
    [ -f "$DK/kill.at" ] || return 0
    local pat n want
    pat="$(cat "$DK/kill.at")"
    printf '%s\n' "$1" | grep -qE -- "$pat" || return 0
    n=$(( $(cat "$DK/kill.n" 2>/dev/null || echo 0) + 1 ))
    echo "$n" >"$DK/kill.n"
    want="$(cat "$DK/kill.nth" 2>/dev/null || echo 1)"
    [ "$n" -eq "$want" ] || return 0
    echo "kill-9 in: $1" >>"$DK/order.log"
    rm -f "$DK/kill.at" "$DK/kill.n" "$DK/kill.nth"
    kill -9 "$(cat "$DK/tick.pid")"
    exit 137
}
HOOK
}
# pl_on NAME REGEX SHELL -- at the first call that matches REGEX, run SHELL (the world changes)
pl_on() {
    printf '%s\n' "$2" >"$DK/run.$1.re"
    printf '%s\n' "$3" >"$DK/run.$1.sh"
}
# pl_kill_at REGEX [NTH] -- arm the kill
pl_kill_at() {
    printf '%s\n' "$1" >"$DK/kill.at"
    rm -f "$DK/kill.n"
    printf '%s\n' "${2:-1}" >"$DK/kill.nth"
}
# pl_tick_bg [ARGS] -- a tick in the background; it records its own pid (the pid of the program itself,
# which `exec` keeps) for the hook; pl_wait sets PL_RC to its exit code
pl_tick_bg() {
    bash -c 'echo $$ >"$DK/tick.pid"; exec "${HOST_SRC}/bin/gremion-cd" tick "$@"' pl-tick "$@" \
        >"${GREMION_ROOT}/.tick.out" 2>&1 3>&- </dev/null &
    PL_PID=$!
    CD_BG_PIDS+=("$PL_PID")
}
pl_wait() {
    PL_RC=0
    wait "$PL_PID" || PL_RC=$?
}
# pl_killed_tick REGEX [NTH] [ARGS] -- run a tick that is killed at the call, then return
pl_killed_tick() {
    local pat="$1" nth="${2:-1}"
    shift 2
    pl_kill_at "$pat" "$nth"
    pl_tick_bg "$@"
    pl_wait
    [ "$PL_RC" -eq 137 ] || { echo "the tick was not killed (exit ${PL_RC})" >&2; cat "${GREMION_ROOT}/.tick.out" >&2; return 1; }
    # a child of the killed program may still hold a lock for an instant
    local i
    for i in $(seq 1 50); do
        if pl_hostlock_free && pl_cdlock_free; then return 0; fi
        sleep 0.1
    done
    echo "a lock is still held after the kill" >&2
    return 1
}

# -- the repository ----------------------------------------------------------------------------------
# pl_repo_init -- the history of the code host: L0 carries every file the pipeline reads from a release
# tree (the programs the world shims stand for, the module declarations, the database function).
pl_repo_init() {
    local d="${GH_WORK}" m
    gh_hist_init
    mkdir -p "${d}/infra/host/bin" "${d}/infra/host/templates/edge" "${d}/docker/pgbouncer" "${d}/gremion-ui/src"
    pl_script switch "${d}/infra/host/bin/gremion-switch"
    pl_script tenant "${d}/infra/host/bin/gremion-tenant"
    pl_script render "${d}/infra/host/bin/gremion-render"
    printf '# active.yml.tmpl of the world\n' >"${d}/infra/host/templates/edge/active.yml.tmpl"
    printf -- '-- the auth_query function of the world\nCREATE SCHEMA IF NOT EXISTS pgbouncer;\n' >"${d}/docker/pgbouncer/pgbouncer-auth.sql"
    mkdir -p "${d}/scripts/migrations/runner"
    printf '{"chains":{}}\n' >"${d}/scripts/migrations/applied.lock.json"
    printf '{"chains":[]}\n' >"${d}/scripts/migrations/ranges.json"
    printf '{"chains":{}}\n' >"${d}/scripts/migrations/runner/chain-runners.json"
    printf '{"waivers":[]}\n' >"${d}/scripts/migrations/runner/lint-waivers.json"
    printf 'secrets/\n' >"${d}/.gitignore"
    printf 'zero\n' >"${d}/gremion-ui/src/app.txt"
    for m in calendar:calendar-postgres content:content-postgres publishing:newsletter-postgres finance:finance-postgres; do
        pl_module "${d}" "${m%%:*}" "${m##*:}"
    done
    pl_module "${d}" messaging null
    if [ -n "${PL_BOARD:-}" ]; then pl_module "${d}" board board-postgres; fi
    gh_rg -C "$d" add -A
    gh_rg -C "$d" commit -q --amend --no-edit
    C_L0="$(gh_rg -C "$d" rev-parse HEAD)"
}
# pl_module DIR ID SERVICE|null -- one module declaration
pl_module() {
    local d="$1/modules/$2"
    mkdir -p "$d"
    if [ "$3" = null ]; then
        printf '{"id":"%s","runtime":{"database":null}}\n' "$2" >"$d/module.json"
    else
        printf '{"id":"%s","runtime":{"database":{"postgresService":"%s","migrations":"migrations"}}}\n' "$2" "$3" >"$d/module.json"
    fi
}
# pl_commit NAME [PATH...] -- a commit on main that changes gremion-ui (or the named paths, which
# must exist already or are created); its sha is in C_<NAME>
pl_commit() {
    local name="$1" p
    shift
    gh_rg -C "$GH_WORK" checkout -q main
    printf '%s\n' "$name" >>"${GH_WORK}/gremion-ui/src/app.txt"
    for p in "$@"; do
        mkdir -p "$(dirname "${GH_WORK}/${p}")"
        printf '%s\n' "$name" >>"${GH_WORK}/${p}"
    done
    gh_rg -C "$GH_WORK" add -A
    gh_rg -C "$GH_WORK" commit -q -m "$name"
    printf -v "C_${name}" '%s' "$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
}

# -- the host --------------------------------------------------------------------------------------
pl_envs() { # LIVE_TAG
    local root="${GREMION_ROOT}" tag="$1"
    cat >"${root}/etc/env/state.env" <<EOF
STACK=teststack
COMPOSE_PROJECT_NAME=teststack-state
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:docker-compose.state-pins.yml
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=203.0.113.10
EDGE_HTTPS_PORT=443
TRAEFIK_API_PORT=18080
INTERNALTEST_PORT=18081
PUBLIC_BASE_PATH=
POSTGRES_USER=pgsuper
CONTROL_DB_NAME=control
KEYCLOAK_DB_NAME=keycloak
GREMION_DB_NAME=gremion
CALENDAR_PG_USER=cal_admin
CONTENT_PG_USER=con_admin
NEWSLETTER_PG_USER=nl_admin
FINANCE_PG_USER=fin_admin
BOARD_PG_USER=brd_admin
GREMION_MIGRATION_DUMP_DIR=${root}/migration-dumps
EOF
    # a made-up value, generated here and never committed
    printf 'PGBOUNCER_AUTH_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >>"${root}/etc/env/state.env"
    printf 'COMPOSE_PROJECT_NAME=teststack-app-blue\nCOMPOSE_PROFILES=production\nCOMPOSE_FILE=docker-compose.app.yml:docker-compose.pins.yml\nIMAGE_TAG=%s\nTENANT_SECRETS_DIR=%s/etc/secrets/tenants\n' "$tag" "$root" >"${root}/etc/env/app-blue.env"
    printf 'COMPOSE_PROJECT_NAME=teststack-app-green\nCOMPOSE_PROFILES=production\nCOMPOSE_FILE=docker-compose.app.yml:docker-compose.pins.yml\nIMAGE_TAG=pilot-eeeeeeeeeeee\nTENANT_SECRETS_DIR=%s/etc/secrets/tenants\n' "$root" >"${root}/etc/env/app-green.env"
}

pl_state_ctr() { # SVC
    local c="c-state-$1"
    printf 'proj=teststack-state\nsvc=%s\nref=%s:16\nid=sha256:%s\noneoff=False\nstatus=running\nhealth=healthy\nrestarts=0\nexit=0\ncolour=state\nmounts=teststack_pgdata\nnets=teststack_state\naliases=teststack_state=%s,\n' \
        "$1" "$1" "$(printf '%s' "$1" | sha256sum | cut -c1-64)" "$1" >"$DK/ctr/$c"
}
# pl_server SVC ROLE -- a postgres of the state project; its databases on stdin
pl_server() {
    pl_state_ctr "$1"
    printf '%s\n' "$2" >"$DK/srv.$1.role"
    cat >"$DK/srv.$1.dbs"
}

pl_world() {
    local root="${GREMION_ROOT}" h
    mkdir -p "$DK/ctr" "${root}/etc/edge" "${root}/etc/secrets/governance" "${root}/etc/secrets/tenants" "${root}/data"
    chmod 700 "${root}/etc/secrets/governance" "${root}/etc/secrets/tenants"
    mkdir -m 700 "$DUMPDIR"
    : >"$DK/order.log"
    printf 'ipcrypt-key-of-the-world\n' >"${root}/etc/secrets/ipcrypt_key.txt"
    printf 'gremion-ui\ngremion-public\nkernel-api\n' >"$DK/svc.app"
    printf 'gremion-migrate:%%TAG%%\ngremion-tenant-create:%%TAG%%\n' >"$DK/refs.app"
    printf 'postgres\ntraefik\ncalendar-postgres\ncontent-postgres\nnewsletter-postgres\n' >"$DK/svc.state"
    pl_state_ctr traefik
    pl_server postgres pgsuper <<EOF
control|1000
gremion|2000
gremion_platform|3000
keycloak|4000
postgres|100
t_${PL_H1}__kernel|5000
t_${PL_H2}__kernel|6000
gremion_kernel_api|700
EOF
    pl_server calendar-postgres cal_admin <<EOF
postgres|100
t_${PL_H1}__calendar|1000
calendar_control|1400
EOF
    pl_server content-postgres con_admin <<EOF
postgres|100
t_${PL_H1}__content|1000
content_control|1400
EOF
    pl_server newsletter-postgres nl_admin <<EOF
postgres|100
t_${PL_H1}__publishing|1000
newsletter_control|1400
EOF
    # servers the dump set and the module step must never enter (they answer, so a call shows in exec.log)
    pl_server messaging-postgres msg_admin <<EOF
postgres|100
messaging_main|900
EOF
    pl_server governance-postgres gov_admin <<EOF
postgres|100
governance_main|900
EOF
    pl_server nextcloud-postgres nc_admin <<EOF
postgres|100
nextcloud_main|900
EOF
    printf '%s\n%s\n' "$PL_H1" "$PL_H2" >"$DK/tenants.active"
    printf 'slug-a\nslug-b\nslug-c\n' >"$DK/q.list"
    printf 'active|3\n' >"$DK/q.status"
    printf '%s|active\n%s|active\n%s|active\n' "$PL_H1" "$PL_H2" "$PL_H3" >"$DK/q.ids"
    printf 'slug-a\n' >"$DK/q.canary"
    printf 't_%s__calendar|enabled\nt_%s__content|enabled\nt_%s__publishing|enabled\n' "$PL_H1" "$PL_H1" "$PL_H1" >"$DK/rows.module_database"
    printf 't_%s__calendar\nt_%s__content\nt_%s__publishing\n' "$PL_H1" "$PL_H1" "$PL_H1" >"$DK/q.module_enabled"
    printf '{"total":3,"upgraded":0,"unchanged":3,"skipped":0,"failed":0,"files_applied":0}\n' >"$DK/run.tenant-create.out"
    jq -cn '[{name:"api@internal", rule:"PathPrefix(`/api`)", status:"enabled", service:"api@internal"},
             {name:"portal@docker", rule:"Host(`example.org`)", status:"enabled", service:"public@file"}]' >"$DK/routers.json"
    # the edge before the first release: blue serves, green is the next route
    printf 'blue\n' >"${root}/runtime/active-colour"
    local pair name svc u
    for pair in app@file:gremion-ui public@file:gremion-public panel@file:control-panel; do
        name="${pair%%:*}"; svc="${pair##*:}"; u="http://${svc}-blue:3000"
        jq -cn --arg u "$u" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): "UP"}}' >"$DK/traefik.${name}"
    done
    for pair in app-next@file:gremion-ui public-next@file:gremion-public; do
        name="${pair%%:*}"; svc="${pair##*:}"; u="http://${svc}-green:3000"
        jq -cn --arg u "$u" '{loadBalancer: {servers: [{url: $u}]}, serverStatus: {($u): "UP"}}' >"$DK/traefik.${name}"
    done
    h=''
    : "$h"
}

# pl_leaf_world -- the three leaf services run in the target colour (their profiles are on), and each
# leaf entry answers one customer migrated
pl_leaf_world() {
    local s
    printf 'calendar-service\ncontent-service\nnewsletter-service\n' >>"$DK/svc.app"
    for s in calendar-service content-service newsletter-service; do
        printf '{"v":1,"total":1,"migrated":1,"skipped":0,"failed":0}\n' >"$DK/run.$s.out"
    done
    # the live colour runs them too (its containers are part of what a build must leave alone)
    docker compose --env-file "${GREMION_ROOT}/etc/env/app-blue.env" build >/dev/null
    docker compose --env-file "${GREMION_ROOT}/etc/env/app-blue.env" up -d >/dev/null
    : >"$DK/order.log"
    : >"$SHIM_LOG"
}

# pl_no_modules_world -- no module database exists: the servers hold only their own bookkeeping
pl_no_modules_world() {
    local s
    for s in calendar content newsletter; do
        printf 'postgres|100\n' >"$DK/srv.${s}-postgres.dbs"
    done
    : >"$DK/rows.module_database"
    : >"$DK/q.module_enabled"
    printf '{"total":0,"upgraded":0,"unchanged":0,"skipped":0,"failed":0,"files_applied":0}\n' >"$DK/run.tenant-create.out"
}

# pl_board_world -- a board module whose server runs, with one gate database of its own (call it
# with PL_BOARD=1 exported before pl_scn_green, so the declaration is in the live tree too)
pl_board_world() {
    pl_server board-postgres brd_admin <<EOF
postgres|100
t_${PL_H1}__board|1000
board_control|1400
EOF
    printf 't_%s__board|enabled\n' "$PL_H1" >>"$DK/rows.module_database"
    printf 't_%s__board\n' "$PL_H1" >>"$DK/q.module_enabled"
    printf '{"total":4,"upgraded":0,"unchanged":4,"skipped":0,"failed":0,"files_applied":0}\n' >"$DK/run.tenant-create.out"
}

# pl_setup -- the host, the repository and the shims. The state is seeded by pl_seed_live.
pl_setup() {
    gh_setup
    export STACK=teststack TZ=UTC GREMION_BIN_DIR="${GREMION_ROOT}/bin"
    DK="${GREMION_ROOT}/.world"
    DUMPDIR="${GREMION_ROOT}/migration-dumps"
    export DK DUMPDIR
    mkdir -p "$DK" "${GREMION_ROOT}/bin"
    : >"$DK/argv.log"
    pl_write_hook
    shim git '[ -f "$DK/hook.sh" ] && . "$DK/hook.sh" && pl_hook "git $*"
exec "$GH_REAL_GIT" "$@"'
    shim docker "$(cat "${PL_FIX}/docker.body")"
    shim curl "$(cat "${PL_FIX}/curl.body")"
    shim logger
    shim ionice
    shim renice
    shim systemctl 'cat "$DK/timers.json" 2>/dev/null || exit 1'
    shim df 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\nx 1 1 99999999 1%% /\n"'
    pl_script dump "${GREMION_ROOT}/bin/gremion-migration-dump"
    pl_script isolation "${GREMION_ROOT}/bin/gremion-isolation"
    pl_script verify "${GREMION_ROOT}/bin/gremion-verify"
    pl_script mail "${GREMION_ROOT}/bin/gremion-mail"
    pl_world
    export CD_COLOUR_STABLE_S=1 CD_COLOUR_ROUND_S=1 CD_COLOUR_ROUTE_WAIT_S=4 CD_WAIT_POLL_S=0.1
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_POST_RECONCILE_S=0 CD_WATCH_MINUTES=2 CD_WATCH_INTERVAL_S=30 "$@"
    pl_timers
}

# pl_lib 'snippet' [args] -- a fresh bash with EVERY library of gremion-cd, the way the program loads
# them (no stub file), the paths set and the config loaded. Use with `run`.
pl_lib() {
    local snippet="$1"
    shift
    bash -c "set -euo pipefail
export LC_ALL=C
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
for f in \"\${HOST_SRC}\"/lib/cd/*.sh; do
    n=\"\${f##*/}\"; n=\"\${n%.sh}\"
    case \"\$n\" in core|apply-root) continue ;; esac
    . \"\$f\"
done
cd_paths_init
cd_cfg_load
${snippet}" pl-lib "$@"
}

# pl_lock_poller -- a second process that tries the host lock every 50 ms while the reconcile stage runs
# (the first child has started and the stage has not ended) and notes each moment it got it, in $DK/gaps:
# the moments the lock was free between two children
pl_lock_poller() {
    (
        while [ ! -f "$DK/poller.stop" ]; do
            if [ -s "$DK/tenant.slugs" ] && ! grep -q '"event":"reconciled"' "${GREMION_ROOT}/data/cd/history.jsonl" 2>/dev/null; then
                if ( exec 7>>"${GREMION_ROOT}/runtime/hostd.lock"; flock -n 7 ); then echo 1 >>"$DK/gaps"; fi
            fi
            sleep 0.05
        done
    ) 3>&- >/dev/null 2>&1 </dev/null &
    PL_POLL=$!
    CD_BG_PIDS+=("$PL_POLL")
}

# pl_diag -- what a failed test leaves to read: the state, the history, the order of the world's calls
pl_diag() {
    {
        echo "---- state"
        jq -c '{phase, hold, rel: (.release | if . == null then null else {stage, stage_status, switch_started, committed_at} end), live: .live.sha12}' "${GREMION_ROOT}/data/cd/state.json"
        echo "---- history"
        jq -c '[.event, (. | del(.event, .at))] | tostring' "${GREMION_ROOT}/data/cd/history.jsonl" | tail -n 60
        echo "---- order"
        tail -n 60 "$DK/order.log"
        echo "---- journal"
        grep '^logger ' "$SHIM_LOG" | tail -n 20
        if [ "${PL_DIAG:-}" = calls ]; then
            echo "---- calls"
            grep -E '^(git|docker|curl) ' "$SHIM_LOG" | cut -c1-170
        fi
        echo "---- mail"
        grep '^curl .*upload\|^curl .*-K' "$SHIM_LOG" | tail -n 4
        ls "$DK"/mail.* "${GREMION_ROOT}"/data/cd/outbox/ 2>&1 | tail -n 10
        echo "---- logs"
        tail -n 8 "${GREMION_ROOT}"/logs/*.log
    } 2>&1 || true
}

# pl_timers -- the next elapse of the backup and the purge: far from now
pl_timers() {
    local now
    now="$(cd_clock)"
    jq -cn --argjson b $((now + 86400)) --argjson p $((now + 90000)) '
        [{unit:"gremion-cd.timer", next:(($b + 5) * 1000000), activates:"gremion-cd.service"},
         {unit:"gremion-backup.timer", next:($b * 1000000), activates:"gremion-backup.service"},
         {unit:"gremion-purge.timer", next:($p * 1000000), activates:"gremion-purge.service"}]' >"$DK/timers.json"
}

# pl_scn_green -- L0 (live) - A - B (the tip): green, two squash pull requests, the rules in force,
# the host seeded with L0 live on blue and the live colour running.
pl_scn_green() {
    local tag tree
    pl_repo_init
    pl_commit A
    pl_commit B
    gh_publish
    gh_route_ci "$C_B"
    gh_route_ci "$C_A"
    gh_route_pulls "$C_A" "$C_B"
    gh_route_rules
    tag="pilot-${C_L0:0:12}"
    pl_envs "$tag"
    tree="${GREMION_ROOT}/releases/${C_L0:0:12}"
    gh_rg clone -q "$GH_WORK" "$tree"
    gh_rg -C "$tree" checkout -q "$C_L0"
    ln -sfn "$tree" "${GREMION_ROOT}/current"
    printf '%s\n' "$tag" >"${GREMION_ROOT}/runtime/current-tag"
    cd_seed_state ".live = $(jq -cn --arg s "$C_L0" --arg t "$tree" '{sha:$s, sha12:$s[0:12], tag:("pilot-" + $s[0:12]), colour:"blue", tree:$t, since:"2026-11-01T00:00:00Z", proof:false, modules:null, leaves:null, reconcile:null}')"
    # the host manifest of the live tree, written by the program's own function as the adoption does
    pl_lib 'cd_manifest_write "$1"' "$tree" >/dev/null
    bash -c '
        export GREMION_ROOT DK
        . "${HOST_SRC}/lib/common.sh"
        docker compose --env-file "${GREMION_ROOT}/etc/env/app-blue.env" build >/dev/null
        docker compose --env-file "${GREMION_ROOT}/etc/env/app-blue.env" up -d >/dev/null' </dev/null
    : >"$DK/order.log"
    : >"$SHIM_LOG"
}
