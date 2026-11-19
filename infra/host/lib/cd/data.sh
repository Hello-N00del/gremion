#!/usr/bin/env bash
# infra/host/lib/cd/data.sh -- the data stages of gremion-cd (unit cd-data): the timer
# guard, the dump set, the migrate stage and the live signal.
#
# SOURCED, NEVER EXECUTED. Like the rest of the family it sets no shell options and runs
# nothing at the top level except plain assignments: a driver calls a stage as
# `fn || rc=$?`, which switches errexit off inside it, so every command that can fail
# carries its own `|| return N`. It is sourced BEFORE docker.sh (sorted order), so it
# resolves cd_dc, cd_svc_cid, cd_envfile and cd_kv_get at call time, and it calls no
# private helper of another unit.
#
# STAGE RETURN CODES (the family convention): 0 ok, 1 a failure attributable to the commit,
# 2 a precondition or a refusal (the host is not as the stage needs it), 3 waiting (retry
# later), 4 an infrastructure failure that may be retried. A stage prints one reason line
# on stderr: names of services, counts and codes, never a database name of a module server.
#
# THE REAL-DATA BOUNDARY. The name of a module database can carry a customer slug. It
# lives in variables of this process only. It reaches no journal line, no stdout or
# stderr line of CD, no state file, no history line, no outbox file and no file name. Every
# call of gremion-migration-dump sends its stdout and stderr to a 0600 file under logs/
# (its own audit lines, and its refusals, name databases); `status` is read into a
# variable only. A one-shot's output goes to a 0600 file under logs/ as well (its last
# 15 lines) and only the file name is reported.
#
# WHAT IT NEVER DOES. It does not move `current`, touch an env file, a tag or a live
# container, and it calls compose only through cd_dc. It takes no lock itself: the driver
# holds the cd lock (state writes need it) and takes the host lock after the timer guard.
#
# CALLED BY THE STATUS VERB WITHOUT A LOCK. cd_data_timer_guard and cd_data_dumpset_live
# read no state, take no lock and never exit.
#
# shellcheck disable=SC2016  # the jq programs and SQL texts below are single-quoted on purpose

# -- constants (plain assignments; none is a config key) ---------------------------------
# The fixed allowance of the lock span for the dump, the start, the gates and the two kernel
# one-shots, which have no cap of their own that is summed (the dump time of the module
# servers is an owed measurement; the constant is revised from it).
_CD_DATA_ALLOWANCE_MIN=30
# One confirmation poll after a kill by label, per container-running step and service.
_CD_DATA_KILL_CONFIRM_S=60
# A leaf service count in the sum of the lock span: calendar, content, publishing.
_CD_DATA_LEAF_SERVICES=3
# The cap of one kernel one-shot (migrate, kernel-api-migrate). The timeout ends the
# docker client, not the container: the stage then kills by label.
_CD_DATA_ONESHOT_TIMEOUT_S=600
# The lifetime of one query through docker exec.
_CD_DATA_QUERY_TIMEOUT_S=120
# The timers whose next elapse the lock span must not overlap.
_CD_DATA_BACKUP_TIMER=gremion-backup.timer
_CD_DATA_PURGE_TIMER=gremion-purge.timer
# A database name the host program accepts, and a gate database name.
_CD_DATA_RE_DB='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$'
_CD_DATA_RE_GATE='^t_([0-9a-f]{32})__([a-z][a-z0-9]*(_[a-z0-9]+)*)$'
_CD_DATA_RE_LABEL='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

# The plan of the dump set, filled by _cd_data_plan: one entry per database,
# "service|role|name|bytes" (service and role are empty for the main server).
declare -ga _CD_DATA_PLAN=()
# Counters of the last plan (names never): main, modules, servers_skipped, blocked, dropped.
declare -gA _CD_DATA_PLAN_N=()
# What the last status read found: a live line per database name, per label, and how many
# lines come from a module server's dump file.
declare -gA _CD_DATA_ST_DB=()
declare -gA _CD_DATA_ST_LABEL=()
_CD_DATA_ST_N=0
_CD_DATA_ST_MOD=0

_cd_data_err() { printf 'cd-data: %s\n' "$*" >&2; }

_cd_data_hist() { cd_hist "$@" >/dev/null 2>&1 || true; }

# _cd_data_int VALUE -- 0 when VALUE is a whole number of at most nine digits.
_cd_data_int() { [[ "${1:-}" =~ ^[0-9]{1,9}$ ]]; }

# _cd_data_env KEY -- one value of state.env (never printed by a caller). 1 when the key is
# absent, repeated or not a plain line (cd_kv_get's rule).
_cd_data_env() {
    local f
    f="$(cd_envfile state)" || return 2
    [[ -f "$f" && -r "$f" ]] || { _cd_data_err "no readable state.env"; return 2; }
    cd_kv_get "$f" "$1" 2>/dev/null
}

# _cd_data_logdir -- logs/ (0700), created when absent. Prints it.
_cd_data_logdir() {
    local d="${CD_ROOT}/logs"
    if [[ ! -d "$d" ]]; then
        ( umask 077; mkdir -p "$d" ) || return 1
        chmod 700 "$d" || return 1
    fi
    printf '%s\n' "$d"
}

# _cd_data_logfile NAME -- a fresh 0600 file logs/NAME.log, its path on stdout.
_cd_data_logfile() {
    local d f
    d="$(_cd_data_logdir)" || return 1
    f="${d}/${1}.log"
    ( umask 077; : >"$f" ) || return 1
    chmod 600 "$f" || return 1
    printf '%s\n' "$f"
}

# _cd_data_label_ok LABEL -- the label shape the host program accepts.
_cd_data_label_ok() { [[ "${1:-}" =~ $_CD_DATA_RE_LABEL && "${1:-}" != *..* ]]; }

# _cd_data_prog -- the installed dump program. A missing one is a refusal, never a fallback.
_cd_data_prog() {
    local p="${GREMION_BIN_DIR:-${CD_ROOT}/bin}/gremion-migration-dump"
    if [[ ! -x "$p" ]]; then
        _cd_data_err "gremion-migration-dump is not installed"
        return 2
    fi
    printf '%s\n' "$p"
}

# _cd_data_dumpdir -- GREMION_MIGRATION_DUMP_DIR of state.env: an absolute path. Prints it.
_cd_data_dumpdir() {
    local d
    d="$(_cd_data_env GREMION_MIGRATION_DUMP_DIR)" || { _cd_data_err "GREMION_MIGRATION_DUMP_DIR is not set once in state.env"; return 2; }
    [[ "$d" =~ ^/[A-Za-z0-9._/@+-]+$ && "$d" != *..* ]] || { _cd_data_err "GREMION_MIGRATION_DUMP_DIR is not a plain absolute path"; return 2; }
    printf '%s\n' "$d"
}

# _cd_data_no_container_override -- the dump program honours a container override and would
# then ignore --pg-service silently (it refuses the combination; a main-server take would
# simply dump the wrong server). The set is never taken while one is set. 2 when it is.
_cd_data_no_container_override() {
    local f v
    if [[ -n "${GREMION_MIGRATION_DUMP_PG_CONTAINER:-}" ]]; then
        _cd_data_err "GREMION_MIGRATION_DUMP_PG_CONTAINER is set in the environment; the dump set refuses to run under it"
        return 2
    fi
    f="$(cd_envfile state)" || return 2
    if v="$(cd_kv_get "$f" GREMION_MIGRATION_DUMP_PG_CONTAINER 2>/dev/null)"; then
        [[ -z "$v" ]] || { _cd_data_err "GREMION_MIGRATION_DUMP_PG_CONTAINER is set in state.env; the dump set refuses to run under it"; return 2; }
    fi
    return 0
}

# -- one query through docker -------------------------------------------------------------
# _cd_data_cid SERVICE -- the one running container of a service of the state project, printed.
# Nothing printed and 0 when it is not running; 4 when docker cannot be asked.
_cd_data_cid() {
    local out rc=0
    out="$(cd_svc_cid state "$1" 2>/dev/null)" || rc=$?
    if ((rc != 0)); then
        _cd_data_err "docker could not be asked for the ${1} container"
        return 4
    fi
    printf '%s' "$out"
}

# _cd_data_psql SERVICE ROLE DB SQL -- the answer of one query on one server of the state
# project, as `-Atq`. 4 when the container is not running or the query fails (a wrong role is
# a failure; psql's own text, which names databases, is dropped).
_cd_data_psql() {
    local svc="$1" role="$2" db="$3" sql="$4" cid out
    cid="$(_cd_data_cid "$svc")" || return 4
    if [[ -z "$cid" ]]; then
        _cd_data_err "the ${svc} container is not running"
        return 4
    fi
    out="$(timeout -k 5 "${CD_DATA_QUERY_TIMEOUT_S:-$_CD_DATA_QUERY_TIMEOUT_S}" \
        docker exec "$cid" psql -X -U "$role" -d "$db" -Atq -v ON_ERROR_STOP=1 -c "$sql" </dev/null 2>/dev/null)" || {
        _cd_data_err "a query on the ${svc} server failed"
        return 4
    }
    printf '%s' "$out"
}

# -- the host program ---------------------------------------------------------------------
# _cd_data_dump_run LOGFILE ARGS... -- one call of the dump program with both streams in the
# 0600 log. Its exit code is returned.
_cd_data_dump_run() {
    local log="$1" prog rc=0
    shift
    prog="$(_cd_data_prog)" || return 2
    "$prog" "$@" </dev/null >>"$log" 2>&1 || rc=$?
    return "$rc"
}

# _cd_data_status_read [LABEL] -- read `status` into the _CD_DATA_ST_* variables. Nothing is
# printed. 0 read; 1 the answer is not the shape the program prints (a count that disagrees
# with the lines too: unknown is not clear); 2 not installed.
_cd_data_status_read() {
    local label="${1:-}" prog out line n=0 stated="" mod=0 rel db file re_live re_stat
    local -a args=(status)
    _CD_DATA_ST_DB=()
    _CD_DATA_ST_LABEL=()
    _CD_DATA_ST_N=0
    _CD_DATA_ST_MOD=0
    prog="$(_cd_data_prog)" || return 2
    [[ -z "$label" ]] || args+=(--release "$label")
    out="$("$prog" "${args[@]}" </dev/null 2>/dev/null)" || return 1
    re_live='^LIVE [^ ]+ release=([^ ]+) db=([^ ]+) taken=[^ ]* bytes=[0-9]+ file=([^ ]+)$'
    re_stat='^STATUS: ([0-9]+) live dump\(s\)$'
    while IFS= read -r line; do
        line="${line%$'\r'}"
        [[ -n "$line" ]] || continue
        if [[ "$line" =~ $re_live ]]; then
            rel="${BASH_REMATCH[1]}"
            db="${BASH_REMATCH[2]}"
            file="${BASH_REMATCH[3]}"
            n=$((n + 1))
            _CD_DATA_ST_DB["$db"]=1
            _CD_DATA_ST_LABEL["$rel"]=$(( ${_CD_DATA_ST_LABEL["$rel"]:-0} + 1 ))
            # a dump of a module server is named <service>.<id>.dump (the program never names
            # a file after such a database)
            file="${file#*/}"
            [[ "${file%%.*}" =~ ^[a-z][a-z0-9]*-postgres$ ]] && mod=$((mod + 1))
        elif [[ "$line" =~ $re_stat ]]; then
            stated="${BASH_REMATCH[1]}"
        else
            return 1
        fi
    done <<<"$out"
    [[ "$stated" =~ ^[0-9]+$ && "$stated" -eq "$n" ]] || return 1
    _CD_DATA_ST_N="$n"
    _CD_DATA_ST_MOD="$mod"
    return 0
}

# -- the lock span ------------------------------------------------------------------------
# cd_data_lock_span_floor -- the least CD_LOCK_SPAN_MAX_MIN that covers every cap of the
# stages that run under the host lock, in whole minutes: the module step, three leaf runs,
# one 60 second kill confirmation per container-running step and service, the watch, the
# longest pause, the commit, and the fixed allowance for dump, start and gates.
cd_data_lock_span_floor() {
    local mod leaf watch pause commit secs
    mod="$(cd_cfg CD_MODULE_UPGRADE_TIMEOUT_S)" || return 2
    leaf="$(cd_cfg CD_LEAF_MIGRATE_TIMEOUT_S)" || return 2
    watch="$(cd_cfg CD_WATCH_MINUTES)" || return 2
    pause="$(cd_cfg CD_PAUSE_MAX_MIN)" || return 2
    commit="$(cd_cfg CD_COMMIT_MAX_MIN)" || return 2
    secs=$((10#$mod + _CD_DATA_LEAF_SERVICES * 10#$leaf + (1 + _CD_DATA_LEAF_SERVICES) * _CD_DATA_KILL_CONFIRM_S))
    printf '%s\n' "$(( (secs + 59) / 60 + 10#$watch + 10#$pause + 10#$commit + _CD_DATA_ALLOWANCE_MIN ))"
}

# _cd_data_hostlock_free -- 0 when no OTHER process holds the host lock (this process's own
# hold counts as free: it is CD's lock), 1 when another does, 2 without flock.
_cd_data_hostlock_free() {
    local f="${CD_ROOT}/runtime/hostd.lock"
    [[ "${CD_HOSTLOCK_PID:-}" == "$$" ]] && return 0
    [[ -e "$f" ]] || return 0
    command -v flock >/dev/null 2>&1 || return 2
    ( exec 7>>"$f" && flock -n 7 ) 2>/dev/null </dev/null || return 1
    return 0
}

# _cd_data_timer_next UNIT JSON -- the next elapse of a timer as an epoch in seconds, from
# `systemctl list-timers --output json`. systemd reports it in microseconds; a value that
# does not land within a year either side of now once converted is no data. 2 for no data.
_cd_data_timer_next() {
    local unit="$1" json="$2" now="$3" raw n
    n="$(printf '%s' "$json" | jq -r --arg u "$unit" '[.[] | select(.unit == $u)] | length' 2>/dev/null)" || return 2
    [[ "$n" == 1 ]] || return 2
    raw="$(printf '%s' "$json" | jq -r --arg u "$unit" '[.[] | select(.unit == $u)][0].next | if type == "number" then tostring else "" end' 2>/dev/null)" || return 2
    [[ "$raw" =~ ^[0-9]{1,20}$ ]] || return 2
    ((${#raw} > 12)) || return 2
    raw=$((10#${raw} / 1000000))
    if ((raw < now - 31536000 || raw > now + 31536000)); then
        return 2
    fi
    printf '%s\n' "$raw"
}

# cd_data_timer_guard SPAN_MIN -- may a lock span of SPAN_MIN minutes from now start? 0 when it
# fits before the next backup and the next purge, 3 when it does not (waiting, no failure), 2
# when no timer data is readable (unknown is never a pass).
#
# A timer overlaps when its next elapse lies in [now, now + SPAN_MIN + its longest run]. The
# interval is wider than the overlap itself needs: the longest run is added because a
# stage that runs into a backup cannot be stopped half way. A backup or a purge that is
# already running holds the host lock, which is read as busy (3) as well.
#
# The hourly Karenz run (minute 17) cannot be avoided by a span of this length and is not
# guarded; the guard says so on stdout (the status verb discards stdout today).
cd_data_timer_guard() {
    local span="${1:-}" now json bmax pmax unit next max rc=0
    local -A nexts=()
    if ! _cd_data_int "$span" || ((10#$span < 1)); then
        _cd_data_err "timer guard: the span is not a whole number of minutes"
        return 2
    fi
    span=$((10#$span))
    now="$(cd_now)" || return 2
    bmax="$(cd_cfg CD_BACKUP_MAX_MIN)" || return 2
    pmax="$(cd_cfg CD_PURGE_MAX_MIN)" || return 2
    _cd_data_hostlock_free || rc=$?
    if ((rc == 2)); then
        _cd_data_err "timer guard: flock is not installed"
        return 2
    elif ((rc != 0)); then
        _cd_data_err "timer guard: the host lock is held (a backup, a purge or a customer operation)"
        return 3
    fi
    command -v systemctl >/dev/null 2>&1 || { _cd_data_err "timer guard: systemctl is not installed"; return 2; }
    json="$(timeout -k 5 30 systemctl list-timers --all --output json --no-pager </dev/null 2>/dev/null)" || {
        _cd_data_err "timer guard: the timer list cannot be read"
        return 2
    }
    for unit in "$_CD_DATA_BACKUP_TIMER" "$_CD_DATA_PURGE_TIMER"; do
        next="$(_cd_data_timer_next "$unit" "$json" "$now")" || {
            _cd_data_err "timer guard: no usable next elapse for ${unit} (unknown is not a pass)"
            return 2
        }
        nexts[$unit]="$next"
    done
    for unit in "$_CD_DATA_BACKUP_TIMER" "$_CD_DATA_PURGE_TIMER"; do
        next="${nexts[$unit]}"
        if [[ "$unit" == "$_CD_DATA_BACKUP_TIMER" ]]; then max=$((10#$bmax)); else max=$((10#$pmax)); fi
        # a next elapse older than the longest run is a stale answer, not a verdict
        if ((next < now - max * 60)); then
            _cd_data_err "timer guard: the next elapse of ${unit} is in the past (unknown is not a pass)"
            return 2
        fi
        # a timer that has just elapsed (its run is starting) counts, within its longest run
        if ((next <= now + (span + max) * 60)); then
            printf 'lock span: overlaps the next elapse of a timer; the hourly karenz run (minute 17) is not guarded (accepted)\n'
            _cd_data_err "timer guard: a span of ${span} minutes overlaps ${unit}"
            return 3
        fi
    done
    printf 'lock span: fits before the next backup and purge; the hourly karenz run (minute 17) is not guarded (accepted)\n'
    return 0
}

# -- the plan of the dump set --------------------------------------------------------------
# _cd_data_parts POLICY CLASS_JSON -- prints "<main> <module>" (1 or 0 each): which parts of
# the set the policy takes for this release. `always` takes both. `migration` takes the main
# part for any non-empty lock diff and the module part only when a chain of class
# module-upgrade gained a file. A class that is missing or unreadable takes both (unknown is
# not an empty diff). 2 for an unknown policy.
_cd_data_parts() {
    local policy="$1" cls="${2:-}" main mod
    case "$policy" in
        always) printf '1 1\n'; return 0 ;;
        migration) ;;
        *) _cd_data_err "unknown dump policy"; return 2 ;;
    esac
    if [[ -z "$cls" || "$cls" == null ]] || ! printf '%s' "$cls" | jq -e '.migrations | type == "object" and (.total | type == "number")' >/dev/null 2>&1; then
        printf '1 1\n'
        return 0
    fi
    main="$(printf '%s' "$cls" | jq -r 'if .migrations.total > 0 then 1 else 0 end')" || return 2
    mod="$(printf '%s' "$cls" | jq -r '
        if ([.migrations.chains // {} | to_entries[]
             | select(.value.class == "module-upgrade"
                      and (((.value.expand // 0) + (.value.migrate // 0) + (.value.contract // 0)) > 0))] | length) > 0
        then 1 else 0 end')" || return 2
    printf '%s %s\n' "$main" "$mod"
}

# _cd_data_declared TREE -- the module databases the tree declares, one line per module:
# "<id> <postgresService>". A module with no database declaration (`runtime.database` null
# or absent) is never entered and prints nothing. 2 when a declaration cannot be read or a
# tree declares no module at all (a wrong tree is a refusal, not "no work").
_cd_data_declared() {
    local tree="$1" f n=0 line id svc
    for f in "$tree"/modules/*/module.json; do
        [[ -f "$f" ]] || continue
        n=$((n + 1))
        line="$(jq -r '
            . as $m
            | ($m.id // "") as $id
            | (if ($m | has("runtime") | not) then null
               elif ($m.runtime | type) == "object" then ($m.runtime.database // null)
               else "INVALID" end) as $db
            | [$id,
               (if $db == null then ""
                elif ($db | type) == "object" and ($db.postgresService | type) == "string" then $db.postgresService
                else "INVALID" end)]
            | @tsv' "$f" 2>/dev/null)" || { _cd_data_err "a module declaration is not readable JSON"; return 2; }
        id="${line%%$'\t'*}"
        svc="${line#*$'\t'}"
        [[ "$id" =~ ^[a-z][a-z0-9]*(_[a-z0-9]+)*$ ]] || { _cd_data_err "a module declaration has no usable id"; return 2; }
        [[ -z "$svc" ]] && continue
        [[ "$svc" =~ ^[a-z][a-z0-9]*-postgres$ ]] || { _cd_data_err "the database declaration of module ${id} is not a postgres service"; return 2; }
        printf '%s %s\n' "$id" "$svc"
    done
    if ((n == 0)); then
        _cd_data_err "the release tree declares no module"
        return 2
    fi
    return 0
}

# _cd_data_plan KIND -- decide the whole dump set and check it. KIND is app (the main-server
# part plus the module part) or state (the main server including the login server's database,
# never a module server). Fills _CD_DATA_PLAN and _CD_DATA_PLAN_N; prints nothing but a reason
# on stderr (no database name). 0 planned; 2 a refusal (a short listing, a missing server of
# an enabled database, a duplicate name, a registry the set does not cover); 4 an
# infrastructure failure (a query or the container).
_cd_data_plan() {
    local kind="$1" pguser kc ctl gdb policy cls parts want_main want_mod rows line name bytes
    local tree state id mod svc role cid reg hex declared
    local -A seen=() main_set=() rowstate=() decl=() servers=() taken=()
    local -a svc_list=()
    _CD_DATA_PLAN=()
    _CD_DATA_PLAN_N=([main]=0 [modules]=0 [servers_skipped]=0 [blocked]=0 [dropped]=0)
    [[ "$kind" == app || "$kind" == state ]] || { _cd_data_err "unknown dump kind"; return 2; }
    pguser="$(_cd_data_env POSTGRES_USER)" || { _cd_data_err "POSTGRES_USER is not set once in state.env"; return 2; }
    ctl="$(_cd_data_env CONTROL_DB_NAME)" || { _cd_data_err "CONTROL_DB_NAME is not set once in state.env"; return 2; }
    gdb="$(_cd_data_env GREMION_DB_NAME)" || { _cd_data_err "GREMION_DB_NAME is not set once in state.env"; return 2; }
    kc="$(_cd_data_env KEYCLOAK_DB_NAME)" || { _cd_data_err "KEYCLOAK_DB_NAME is not set once in state.env"; return 2; }
    [[ "$pguser" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { _cd_data_err "POSTGRES_USER is not a role name"; return 2; }
    for name in "$ctl" "$gdb" "$kc"; do
        [[ "$name" =~ $_CD_DATA_RE_DB && "$name" != *\'* ]] || { _cd_data_err "a database name of state.env is not usable"; return 2; }
    done

    want_main=1
    want_mod=1
    if [[ "$kind" == app ]]; then
        policy="$(cd_cfg CD_DUMP_POLICY)" || return 2
        cls="$(cd_state_get '.release.class // empty')" || return 2
        parts="$(_cd_data_parts "$policy" "$cls")" || return 2
        want_main="${parts% *}"
        want_mod="${parts#* }"
    else
        want_mod=0
    fi

    if ((want_main == 1)); then
        local excl="and datname <> 'postgres'"
        [[ "$kind" == app ]] && excl="${excl} and datname <> '${kc}'"
        rows="$(_cd_data_psql postgres "$pguser" postgres \
            "select datname || '|' || pg_database_size(datname) from pg_database where not datistemplate ${excl} order by datname")" || return 4
        while IFS= read -r line; do
            [[ -n "$line" ]] || continue
            name="${line%|*}"
            bytes="${line##*|}"
            [[ "$name" =~ $_CD_DATA_RE_DB && "$bytes" =~ ^[0-9]{1,18}$ ]] || { _cd_data_err "the main server listed a database that does not parse"; return 2; }
            main_set["$name"]="$bytes"
            seen["$name"]=postgres
            _CD_DATA_PLAN+=("||${name}|${bytes}")
            _CD_DATA_PLAN_N[main]=$((_CD_DATA_PLAN_N[main] + 1))
        done <<<"$rows"
        # a short or empty listing fails closed
        for name in "$ctl" "$gdb" gremion_platform; do
            if [[ -z "${main_set[$name]:-}" ]]; then
                _cd_data_err "the listing of the main server lacks one of control, gremion or gremion_platform (or is empty)"
                return 2
            fi
        done
        # every active customer has its kernel database in the set
        reg="$(_cd_data_psql postgres "$pguser" "$ctl" "select replace(id::text, '-', '') from tenant where status = 'active' order by 1")" || return 4
        while IFS= read -r hex; do
            [[ -n "$hex" ]] || continue
            [[ "$hex" =~ ^[0-9a-f]{32}$ ]] || { _cd_data_err "the customer registry listed an id that does not parse"; return 2; }
            if [[ -z "${main_set[t_${hex}__kernel]:-}" ]]; then
                _cd_data_err "an active customer has no kernel database in the listing of the main server"
                return 2
            fi
        done <<<"$reg"
    fi

    ((want_mod == 1)) || return 0

    tree="$(cd_state_get '.release.tree // empty')" || return 2
    [[ -n "$tree" && -d "$tree" ]] || { _cd_data_err "the release tree is not recorded or not a directory"; return 2; }
    # the rows of plt.module_database, every state: the gate databases are told apart by them
    rows="$(_cd_data_psql postgres "$pguser" gremion_platform "select db_name || '|' || state from plt.module_database order by db_name")" || return 4
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        name="${line%|*}"
        state="${line##*|}"
        [[ "$name" =~ $_CD_DATA_RE_GATE ]] || { _cd_data_err "plt.module_database holds a name that is no gate database"; return 2; }
        case "$state" in
            enabling | enabled | disabling | blocked | dropped) ;;
            *) _cd_data_err "plt.module_database holds a state outside the five known ones"; return 2 ;;
        esac
        rowstate["$name"]="$state"
    done <<<"$rows"

    declared="$(_cd_data_declared "$tree")" || return 2
    while IFS=' ' read -r id svc; do
        [[ -n "$id" ]] || continue
        decl["$id"]="$svc"
        servers["$svc"]=1
    done <<<"$declared"

    # every enabled row names a database of a declared server that must be running
    for name in "${!rowstate[@]}"; do
        [[ "${rowstate[$name]}" == enabled ]] || continue
        [[ "$name" =~ $_CD_DATA_RE_GATE ]] || return 2
        mod="${BASH_REMATCH[2]}"
        if [[ -z "${decl[$mod]:-}" ]]; then
            _cd_data_err "an enabled module database belongs to a module whose declaration names no database server"
            return 2
        fi
    done

    mapfile -t svc_list < <(printf '%s\n' "${!servers[@]}" | LC_ALL=C sort)
    for svc in "${svc_list[@]+"${svc_list[@]}"}"; do
        [[ -n "$svc" ]] || continue
        role="$(_cd_data_env "$(printf '%s' "${svc%-postgres}" | tr '[:lower:]' '[:upper:]')_PG_USER")" || {
            _cd_data_err "the role of ${svc} is not set once in state.env"
            return 2
        }
        [[ "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { _cd_data_err "the role of ${svc} is not a role name"; return 2; }
        cid="$(_cd_data_cid "$svc")" || return 4
        if [[ -z "$cid" ]]; then
            _CD_DATA_PLAN_N[servers_skipped]=$((_CD_DATA_PLAN_N[servers_skipped] + 1))
            # an enabled database on a server that is not running is a refusal
            for name in "${!rowstate[@]}"; do
                [[ "${rowstate[$name]}" == enabled ]] || continue
                [[ "$name" =~ $_CD_DATA_RE_GATE ]] || return 2
                if [[ "${decl[${BASH_REMATCH[2]}]:-}" == "$svc" ]]; then
                    _cd_data_err "the ${svc} server is not running and holds an enabled module database"
                    return 2
                fi
            done
            continue
        fi
        rows="$(_cd_data_psql "$svc" "$role" postgres \
            "select datname || '|' || pg_database_size(datname) from pg_database where not datistemplate and datname <> 'postgres' order by datname")" || return 4
        while IFS= read -r line; do
            [[ -n "$line" ]] || continue
            name="${line%|*}"
            bytes="${line##*|}"
            [[ "$name" =~ $_CD_DATA_RE_DB && "$bytes" =~ ^[0-9]{1,18}$ ]] || { _cd_data_err "the ${svc} server listed a database that does not parse"; return 2; }
            if [[ -n "${seen[$name]:-}" ]]; then
                _cd_data_err "the same database name is on two servers (${seen[$name]} and ${svc})"
                return 2
            fi
            seen["$name"]="$svc"
            if [[ "$name" =~ $_CD_DATA_RE_GATE ]]; then
                state="${rowstate[$name]:-}"
                if [[ "$state" == blocked ]]; then
                    _CD_DATA_PLAN_N[blocked]=$((_CD_DATA_PLAN_N[blocked] + 1))
                    continue
                elif [[ "$state" == dropped ]]; then
                    _CD_DATA_PLAN_N[dropped]=$((_CD_DATA_PLAN_N[dropped] + 1))
                    continue
                fi
            fi
            taken["$name"]=1
            _CD_DATA_PLAN+=("${svc}|${role}|${name}|${bytes}")
            _CD_DATA_PLAN_N[modules]=$((_CD_DATA_PLAN_N[modules] + 1))
        done <<<"$rows"
    done
    # every enabled row has its database in the set
    for name in "${!rowstate[@]}"; do
        [[ "${rowstate[$name]}" == enabled ]] || continue
        if [[ -z "${taken[$name]:-}" ]]; then
            _cd_data_err "an enabled module database is not in the set"
            return 2
        fi
    done
    return 0
}

# -- precheck -----------------------------------------------------------------------------
# cd_data_precheck -- may a dump set be taken now? 0 yes. 2 a refusal (the dump directory, a
# ledger lock, a live set of another label, a lock span below its floor, a listing that does
# not add up); 4 the disk or a query. Creates the dump directory 0700 when it is absent
# (`take` will not).
cd_data_precheck() {
    local dir mode owner floor span own need sum entry free rc=0 label
    local -a fields=()
    _cd_data_no_container_override || return 2
    _cd_data_prog >/dev/null || return 2
    floor="$(cd_data_lock_span_floor)" || return 2
    span="$(cd_cfg CD_LOCK_SPAN_MAX_MIN)" || return 2
    if ((10#$span < floor)); then
        _cd_data_err "CD_LOCK_SPAN_MAX_MIN (${span}) is below the sum of the stage caps plus the allowance (${floor}); raise it"
        return 2
    fi
    dir="$(_cd_data_dumpdir)" || return 2
    if [[ ! -e "$dir" ]]; then
        [[ -d "${dir%/*}" ]] || { _cd_data_err "the parent of the dump directory does not exist"; return 2; }
        install -d -m 700 -- "$dir" || { _cd_data_err "the dump directory cannot be created"; return 2; }
    fi
    if [[ -L "$dir" || ! -d "$dir" ]]; then
        _cd_data_err "the dump directory is not a plain directory"
        return 2
    fi
    mode="$(stat -c '%a' -- "$dir")" || return 2
    owner="$(stat -c '%u' -- "$dir")" || return 2
    if [[ "$mode" != 700 ]]; then
        _cd_data_err "the dump directory has mode ${mode}, want 700 (it holds whole databases in clear)"
        return 2
    fi
    if [[ "$owner" != "$(id -u)" ]]; then
        _cd_data_err "the dump directory is owned by uid ${owner}, not by the deploy user"
        return 2
    fi
    if [[ -e "${dir}/ledger.lock" || -L "${dir}/ledger.lock" ]]; then
        _cd_data_err "a ledger lock is present in the dump directory: check that no gremion-migration-dump runs, then remove ledger.lock there"
        return 2
    fi
    own="$(cd_state_get '.release.tag // empty')" || return 2
    _cd_data_status_read || { _cd_data_err "the live dumps cannot be listed (unknown is not clear)"; return 2; }
    for label in "${!_CD_DATA_ST_LABEL[@]}"; do
        if [[ -z "$own" || ( "$label" != "$own" && "$label" != "state-${own}" ) ]]; then
            _cd_data_err "a dump set of another label is live: ${label} (restore or discard it first)"
            return 2
        fi
    done
    _cd_data_plan app || { rc=$?; return "$rc"; }
    sum=0
    for entry in "${_CD_DATA_PLAN[@]+"${_CD_DATA_PLAN[@]}"}"; do
        IFS='|' read -r -a fields <<<"$entry"
        sum=$((sum + 10#${fields[3]}))
    done
    need=$((sum * 2))
    free="$(df -Pk -- "$dir" 2>/dev/null </dev/null | awk 'NR == 2 { print $4 }')" || free=''
    [[ "$free" =~ ^[0-9]+$ ]] || { _cd_data_err "the free space of the dump directory cannot be read"; return 4; }
    if ((free * 1024 < need)); then
        _cd_data_err "the dump directory has $((free / 1024)) MB free; twice the size of the set is $((need / 1048576)) MB"
        return 4
    fi
    return 0
}

# -- the set ------------------------------------------------------------------------------
# _cd_data_release_ref -- GREMION_RELEASE_REF of the kernel-api-migrate service as compose
# resolves it for the target colour (the label the one-shot takes its own dump under).
# Printed. The resolved document holds secrets: it stays in a variable and is never printed.
_cd_data_release_ref() {
    local tree colour doc ref rc=0
    tree="$(cd_state_get '.release.tree // empty')" || return 2
    colour="$(cd_state_get '.release.colour // empty')" || return 2
    [[ -n "$tree" && -d "$tree" && ( "$colour" == blue || "$colour" == green ) ]] || {
        _cd_data_err "the release tree and colour are not recorded"
        return 2
    }
    doc="$(cd_dc "$tree" "app-${colour}" config --format json 2>/dev/null)" || rc=$?
    if ((rc != 0)); then
        _cd_data_err "compose could not resolve the target colour's configuration"
        return 4
    fi
    ref="$(printf '%s' "$doc" | jq -r '.services["kernel-api-migrate"].environment.GREMION_RELEASE_REF // empty' 2>/dev/null)" || ref=''
    doc=''
    [[ -n "$ref" ]] || { _cd_data_err "kernel-api-migrate carries no GREMION_RELEASE_REF"; return 2; }
    printf '%s\n' "$ref"
}

# _cd_data_trim_log FILE LINES -- keep the last LINES lines, mode 0600.
_cd_data_trim_log() {
    ( umask 077; tail -n "$2" -- "$1" >"${1}.tmp" ) || return 1
    mv -f -- "${1}.tmp" "$1" || return 1
    chmod 600 "$1"
}

# cd_data_dumpset_take LABEL [app|state] -- take the dump set under LABEL. Pass `app` for a
# release (the label must equal the GREMION_RELEASE_REF of kernel-api-migrate, which takes its
# own dump into the same ledger under it) and `state` for a state-tier apply (the label is
# `state-<tag>`, the login server's database goes in, a module server never). 0 taken and
# present in the ledger; 2 a refusal; 4 an infrastructure failure or a failed dump (nothing
# proceeds; the part already taken stays live under its label until retire or discard).
cd_data_dumpset_take() {
    local label="${1:-}" kind="${2:-app}" ref tag log entry n=0 total rc=0 reason
    local -a fields=() args=()
    _cd_data_label_ok "$label" || { _cd_data_err "bad dump label"; return 2; }
    [[ "$kind" == app || "$kind" == state ]] || { _cd_data_err "the kind is app or state"; return 2; }
    _cd_data_no_container_override || return 2
    _cd_data_prog >/dev/null || return 2
    if [[ "$kind" == app ]]; then
        ref="$(_cd_data_release_ref)" || { rc=$?; return "$rc"; }
        if [[ "$label" != "$ref" ]]; then
            _cd_data_err "the dump label is not the release ref that kernel-api-migrate takes its dump under; the ledger would see two live labels"
            return 2
        fi
    else
        tag="$(cd_state_get '.release.tag // empty')" || return 2
        if [[ -z "$tag" || "$label" != "state-${tag}" ]]; then
            _cd_data_err "the state-tier label is state-<release tag>"
            return 2
        fi
    fi
    _cd_data_plan "$kind" || { rc=$?; return "$rc"; }
    total="${#_CD_DATA_PLAN[@]}"
    log="$(_cd_data_logfile "cd-data-dump")" || { _cd_data_err "the dump log cannot be opened"; return 2; }
    for entry in "${_CD_DATA_PLAN[@]+"${_CD_DATA_PLAN[@]}"}"; do
        n=$((n + 1))
        IFS='|' read -r -a fields <<<"$entry"
        args=(take --release "$label" --db "${fields[2]}")
        if [[ -n "${fields[0]}" ]]; then
            args+=(--pg-service "${fields[0]}" --pg-user "${fields[1]}")
        fi
        rc=0
        _cd_data_dump_run "$log" "${args[@]}" || rc=$?
        if ((rc != 0)); then
            # the refusals that no retry can change are 2; any other failure may be retried
            if grep -qE 'DUMP_SERIES|LEDGER_LOCKED|DUMP_DIR_|DUMP_SERVER_MISMATCH|GREMION_MIGRATION_DUMP_PG_CONTAINER' "$log" 2>/dev/null || ((rc == 2)); then
                reason=2
            else
                reason=4
            fi
            _cd_data_err "take failed (exit ${rc}) for database ${n} of ${total} on ${fields[0]:-postgres}; see ${log##*/}"
            return "$reason"
        fi
    done
    # the post-condition on the ledger, not an exit code: every planned database has a live
    # line under the label
    if ((total > 0)); then
        _cd_data_status_read "$label" || { _cd_data_err "the ledger cannot be read back after the take"; return 4; }
        if ((_CD_DATA_ST_N < total)); then
            _cd_data_err "the ledger holds ${_CD_DATA_ST_N} live dumps of ${label}, ${total} were planned"
            return 1
        fi
        for entry in "${_CD_DATA_PLAN[@]}"; do
            IFS='|' read -r -a fields <<<"$entry"
            if [[ -z "${_CD_DATA_ST_DB[${fields[2]}]:-}" ]]; then
                _cd_data_err "a planned database has no live dump of ${label} in the ledger"
                return 1
            fi
        done
    fi
    _cd_data_trim_log "$log" 500 || true
    _cd_data_hist dumpset_taken label="$label" kind="$kind" databases="$total" main="${_CD_DATA_PLAN_N[main]}" \
        modules="${_CD_DATA_PLAN_N[modules]}" servers_skipped="${_CD_DATA_PLAN_N[servers_skipped]}" \
        blocked_skipped="${_CD_DATA_PLAN_N[blocked]}" dropped_skipped="${_CD_DATA_PLAN_N[dropped]}"
    return 0
}

# _cd_data_gone LABEL -- 0 when the ledger holds no live dump of LABEL (lines written by
# kernel-api-migrate under the same label included). 1 when one is left or the ledger cannot
# be read.
_cd_data_gone() {
    _cd_data_status_read "$1" || return 1
    [[ "$_CD_DATA_ST_N" -eq 0 ]]
}

# cd_data_dumpset_retire LABEL -- `switched`: delete every live dump of LABEL, then assert
# that none is left. 0; 1 a dump is left; 4 the program failed.
cd_data_dumpset_retire() {
    local label="${1:-}" log rc=0
    _cd_data_label_ok "$label" || { _cd_data_err "bad dump label"; return 2; }
    log="$(_cd_data_logfile "cd-data-retire")" || return 2
    _cd_data_dump_run "$log" switched --release "$label" || rc=$?
    if ((rc != 0)); then
        _cd_data_err "switched failed (exit ${rc}); see ${log##*/}"
        return 4
    fi
    if ! _cd_data_gone "$label"; then
        _cd_data_err "a live dump of ${label} is left after switched (or the ledger cannot be read)"
        return 1
    fi
    _cd_data_hist dumpset_retired label="$label"
    return 0
}

# cd_data_dumpset_discard LABEL REASON -- the logged discard; a reason is required.
cd_data_dumpset_discard() {
    local label="${1:-}" reason="${2:-}" log rc=0
    _cd_data_label_ok "$label" || { _cd_data_err "bad dump label"; return 2; }
    reason="${reason//$'\n'/ }"
    reason="${reason//$'\r'/ }"
    if [[ -z "${reason//[[:space:]]/}" ]]; then
        _cd_data_err "a discard needs a reason"
        return 2
    fi
    reason="$(cd_scrub_value "${reason:0:200}")"
    log="$(_cd_data_logfile "cd-data-discard")" || return 2
    _cd_data_dump_run "$log" discard --release "$label" --reason "$reason" || rc=$?
    if ((rc != 0)); then
        _cd_data_err "discard failed (exit ${rc}); see ${log##*/}"
        return 4
    fi
    if ! _cd_data_gone "$label"; then
        _cd_data_err "a live dump of ${label} is left after the discard (or the ledger cannot be read)"
        return 1
    fi
    _cd_data_hist dumpset_discarded label="$label"
    return 0
}

# cd_data_dumpset_live -- the labels of the live dump sets, one per line, sorted. Nothing when
# none is live. 1 when the ledger cannot be read. Reads no state and takes no lock.
cd_data_dumpset_live() {
    local label
    _cd_data_status_read || return 1
    for label in "${!_CD_DATA_ST_LABEL[@]}"; do
        printf '%s\n' "$label"
    done | LC_ALL=C sort
}

# cd_data_kernel_db_ids ARRAYNAME -- fill the caller's array with the 32 hex ids of the
# t_<hex32>__kernel databases of the main server, sorted. Prints nothing. A listing that
# fails (4) or is empty (2) is an error, never an empty array.
cd_data_kernel_db_ids() {
    local _cd_arg="${1:-}" pguser rows line
    local -a _cd_found=()
    [[ "$_cd_arg" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$_cd_arg" != _cd_* ]] || {
        _cd_data_err "cd_data_kernel_db_ids: not an array name"
        return 2
    }
    local -n _cd_out="$_cd_arg"
    pguser="$(_cd_data_env POSTGRES_USER)" || { _cd_data_err "POSTGRES_USER is not set once in state.env"; return 2; }
    [[ "$pguser" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { _cd_data_err "POSTGRES_USER is not a role name"; return 2; }
    rows="$(_cd_data_psql postgres "$pguser" postgres \
        "select datname from pg_database where not datistemplate and datname <> 'postgres' order by datname")" || return 4
    [[ -n "${rows//[[:space:]]/}" ]] || { _cd_data_err "the listing of the main server is empty"; return 2; }
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        [[ "$line" =~ $_CD_DATA_RE_DB ]] || { _cd_data_err "the main server listed a database that does not parse"; return 2; }
        if [[ "$line" =~ ^t_([0-9a-f]{32})__kernel$ ]]; then
            _cd_found+=("${BASH_REMATCH[1]}")
        fi
    done <<<"$rows"
    _cd_out=("${_cd_found[@]+"${_cd_found[@]}"}")
    return 0
}

# -- the migrate stage -------------------------------------------------------------------
# _cd_data_kill_label LABEL -- kill and remove every container (stopped ones included) that
# carries the label, then poll `docker ps -a` until it finds none twice in a row (at most 60
# seconds). 0 confirmed gone; 1 one is left.
_cd_data_kill_label() {
    local label="$1" ids empty=0 t0 now
    t0="$(cd_now)" || return 1
    while :; do
        ids="$(docker ps -aq --filter "label=${label}" </dev/null 2>/dev/null)" || ids='unknown'
        if [[ -z "$ids" ]]; then
            empty=$((empty + 1))
            ((empty >= 2)) && return 0
        else
            empty=0
            if [[ "$ids" != unknown ]]; then
                # shellcheck disable=SC2086  # ids is a list of container ids
                docker rm -f $ids </dev/null >/dev/null 2>&1 || true
            fi
        fi
        now="$(cd_now)" || return 1
        ((now - t0 >= _CD_DATA_KILL_CONFIRM_S)) && return 1
        cd_sleep 1
    done
}

# _cd_data_pgbouncer_role -- make sure the pgbouncer auth role exists with the password of
# state.env. The password reaches psql on its stdin only (supplied here by printf): never an
# argv, never the environment of a child, never a log. 0; 2 the key is unusable; 4 psql.
_cd_data_pgbouncer_role() {
    local pw pguser cid sql
    pw="$(_cd_data_env PGBOUNCER_AUTH_PASSWORD)" || { _cd_data_err "PGBOUNCER_AUTH_PASSWORD is not set once in state.env"; return 2; }
    [[ "$pw" =~ ^[A-Za-z0-9]{16,128}$ ]] || { _cd_data_err "PGBOUNCER_AUTH_PASSWORD is not 16 to 128 letters and digits"; return 2; }
    pguser="$(_cd_data_env POSTGRES_USER)" || return 2
    [[ "$pguser" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || return 2
    cid="$(_cd_data_cid postgres)" || return 4
    [[ -n "$cid" ]] || { _cd_data_err "the postgres container is not running"; return 4; }
    sql="$(cat <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pgbouncer_auth') THEN
    CREATE ROLE pgbouncer_auth LOGIN;
  END IF;
END $$;
ALTER ROLE pgbouncer_auth LOGIN PASSWORD '@PW@';
SQL
)"
    sql="${sql//@PW@/$pw}"
    if ! printf '%s\n' "$sql" | timeout -k 5 "${CD_DATA_QUERY_TIMEOUT_S:-$_CD_DATA_QUERY_TIMEOUT_S}" \
        docker exec -i "$cid" psql -X -U "$pguser" -d postgres -q -v ON_ERROR_STOP=1 -f - >/dev/null 2>&1; then
        sql=''
        pw=''
        _cd_data_err "the pgbouncer auth role could not be ensured"
        return 4
    fi
    return 0
}

# _cd_data_oneshot TREE COLOUR SERVICE RELEASE_ID -- one one-shot of the NEW tree with the
# TARGET colour's env file. Its output goes to a 0600 file under logs/ and the last 15 lines
# stay; only the file name is reported. 0 ok; 1 the one-shot failed (exit 1: the commit's
# fault); 3 it ran out of time (the container is then killed by label and confirmed gone); 2
# a container that cannot be confirmed gone, or a bad call; 4 anything else (compose's or
# the daemon's own failure).
_cd_data_oneshot() {
    local tree="$1" colour="$2" svc="$3" rid="$4" log rc=0 cap
    log="$(_cd_data_logfile "cd-data-${svc}")" || { _cd_data_err "the one-shot log cannot be opened"; return 2; }
    cap="${CD_DATA_ONESHOT_TIMEOUT_S:-$_CD_DATA_ONESHOT_TIMEOUT_S}"
    CD_DC_TIMEOUT="$cap" cd_dc "$tree" "app-${colour}" run --rm --no-deps -T --label "gremion.cd=${rid}" "$svc" \
        >"$log" 2>&1 </dev/null || rc=$?
    _cd_data_trim_log "$log" 15 || true
    case "$rc" in
        0) return 0 ;;
        1) _cd_data_err "the ${svc} one-shot failed; the last lines are in ${log##*/}"; return 1 ;;
        124 | 137)
            if _cd_data_kill_label "gremion.cd=${rid}"; then
                _cd_data_err "the ${svc} one-shot ran out of time and its container is gone; see ${log##*/}"
                return 3
            fi
            _cd_data_err "the ${svc} one-shot ran out of time and its container could not be confirmed gone"
            return 2
            ;;
        2) _cd_data_err "the ${svc} one-shot was refused (usage or a missing precondition); see ${log##*/}"; return 2 ;;
        *) _cd_data_err "the ${svc} one-shot stopped with exit ${rc}; see ${log##*/}"; return 4 ;;
    esac
}

# cd_data_migrate TREE COLOUR -- the migrate stage: the pgbouncer auth role, the `migrate` and
# `kernel-api-migrate` one-shots from the NEW tree with the target colour's env, then the
# module step (cd_modules_upgrade) and, when a module dump of the label exists, the leaf step
# (cd_leaves_migrate); then the live colour's portal probe and the start of the live signal.
# The code of the first step that fails is the code of the stage, and a failed step stops the
# stage before the next one (the probe included). Refuses, with nothing run, unless the
# ledger holds a live dump of the label for every database the set covers.
cd_data_migrate() {
    local tree="${1:-}" colour="${2:-}" tag rid entry rc=0 modules_dumped=0
    local -a fields=()
    [[ -d "$tree" && -x "$tree" ]] || { _cd_data_err "migrate: no release tree"; return 2; }
    [[ "$colour" == blue || "$colour" == green ]] || { _cd_data_err "migrate: the colour is blue or green"; return 2; }
    tag="$(cd_state_get '.release.tag // empty')" || return 2
    rid="$(cd_state_get '.release.id // empty')" || return 2
    [[ "$tag" =~ ^pilot-[0-9a-f]{12}$ && -n "$rid" ]] || { _cd_data_err "migrate: no release record"; return 2; }
    # nothing opens a database without a live dump of this release under the label
    _cd_data_plan app || { rc=$?; return "$rc"; }
    _cd_data_status_read "$tag" || { _cd_data_err "migrate: the live dumps cannot be listed"; return 4; }
    for entry in "${_CD_DATA_PLAN[@]+"${_CD_DATA_PLAN[@]}"}"; do
        IFS='|' read -r -a fields <<<"$entry"
        if [[ -z "${_CD_DATA_ST_DB[${fields[2]}]:-}" ]]; then
            _cd_data_err "migrate: a database of the set has no live dump of ${tag}; nothing was run"
            return 2
        fi
    done
    ((_CD_DATA_ST_MOD > 0)) && modules_dumped=1
    _cd_data_signal_prime "$rid" || true
    _cd_data_pgbouncer_role || { rc=$?; return "$rc"; }
    _cd_data_oneshot "$tree" "$colour" migrate "$rid" || { rc=$?; return "$rc"; }
    _cd_data_oneshot "$tree" "$colour" kernel-api-migrate "$rid" || { rc=$?; return "$rc"; }
    cd_modules_upgrade "$tree" "$colour" "$tag" || { rc=$?; return "$rc"; }
    if ((modules_dumped == 1)); then
        cd_leaves_migrate "$tree" "$colour" "$tag" || { rc=$?; return "$rc"; }
    fi
    cd_data_live_portal_probe || { rc=$?; return "$rc"; }
    cd_data_live_signal_start || { rc=$?; return "$rc"; }
    return 0
}

# -- the live colour after migrate --------------------------------------------------------
# _cd_data_unusable WHY -- the old colour cannot be switched back to. A rollback would land on
# a colour that fails on the migrated schema: the release then continues only if the new
# colour passes every gate. Recorded in the state, and in the history by code only.
_cd_data_unusable() {
    cd_state_set '.release.rollback_target = "unusable"' || return $?
    _cd_data_hist rollback_target_unusable why="$1"
    _cd_data_err "WARNING: the live colour looks broken on the migrated schema (${1}); a switch back is not safe, every gate is required"
}

# cd_data_live_portal_probe -- the portal list page of the LIVE colour, three tries after
# migrate. One good answer is a pass. Three answers that are 500s or timeouts (the probe says
# 1 each time) set rollback_target=unusable and return 0 with a warning. A probe that cannot
# say (docker unaskable, a bad base path) is no verdict: its code is returned and nothing is
# recorded.
cd_data_live_portal_probe() {
    local colour i rc bad=0 other=0
    colour="$(cd_state_get '.live.colour // empty')" || return 2
    [[ "$colour" == blue || "$colour" == green ]] || { _cd_data_err "portal probe: no live colour is recorded"; return 2; }
    for i in 1 2 3; do
        rc=0
        cd_colour_portal_probe "$colour" >/dev/null 2>&1 || rc=$?
        if ((rc == 0)); then
            return 0
        elif ((rc == 1)); then
            bad=$((bad + 1))
        else
            other=$((rc > other ? rc : other))
        fi
        ((i < 3)) && cd_sleep 5
    done
    if ((other != 0)); then
        _cd_data_err "portal probe: the live colour could not be asked (code ${other}); no verdict"
        return "$other"
    fi
    _cd_data_unusable portal_probe || return $?
    return 0
}

# The live signal file: runtime/cd/live-signal, 0600, counts and an epoch only.
_cd_data_signal_file() { printf '%s\n' "${CD_RUN}/live-signal"; }

# _cd_data_count_since EPOCH -- the 5xx count of the live colour since EPOCH, from the edge
# access log (counts only). Prints an integer, or "null" when the log cannot be read.
_cd_data_count_since() {
    local out
    if ! declare -F cd_watch_accesslog_count >/dev/null 2>&1; then
        printf 'null\n'
        return 0
    fi
    out="$(cd_watch_accesslog_count "$1" 2>/dev/null)" || { printf 'null\n'; return 0; }
    out="${out%%$'\n'*}"
    if [[ "$out" =~ ^[0-9]{1,9}$ ]]; then printf '%s\n' "$((10#$out))"; else printf 'null\n'; fi
}

# _cd_data_signal_prime RELEASE_ID -- the baseline, taken BEFORE the migrate: the 5xx count of
# the CD_BASELINE_S seconds before now (null when the log cannot be read). The epoch is stored
# at the end of migrate by cd_data_live_signal_start.
_cd_data_signal_prime() {
    local rid="$1" now span base f
    now="$(cd_now)" || return 1
    span="$(cd_cfg CD_BASELINE_S)" || return 1
    base="$(_cd_data_count_since "$((now - 10#$span))")"
    f="$(_cd_data_signal_file)"
    cd_mkdir "$CD_RUN" || return 1
    jq -cn --arg r "$rid" --argjson b "$base" '{v: 1, release: $r, epoch: null, baseline: $b}' | cd_atomic_write "$f" 600
}

# cd_data_live_signal_start -- store the epoch (now, the end of migrate) beside the baseline
# primed at its start. Without a primed baseline of this release it takes one now.
cd_data_live_signal_start() {
    local rid now span f base cur
    rid="$(cd_state_get '.release.id // empty')" || return 2
    [[ -n "$rid" ]] || { _cd_data_err "live signal: no release record"; return 2; }
    now="$(cd_now)" || return 2
    f="$(_cd_data_signal_file)"
    base=''
    if [[ -r "$f" ]]; then
        cur="$(jq -c --arg r "$rid" 'select(.v == 1 and .release == $r) | .baseline' "$f" 2>/dev/null)" || cur=''
        [[ "$cur" == null || "$cur" =~ ^[0-9]{1,9}$ ]] && base="$cur"
    fi
    if [[ -z "$base" ]]; then
        span="$(cd_cfg CD_BASELINE_S)" || return 2
        base="$(_cd_data_count_since "$((now - 10#$span))")"
    fi
    cd_mkdir "$CD_RUN" || return 2
    jq -cn --arg r "$rid" --argjson e "$now" --argjson b "$base" '{v: 1, release: $r, epoch: $e, baseline: $b}' \
        | cd_atomic_write "$f" 600 || return 1
    return 0
}

# cd_data_live_signal_read -- apply the watch_5xx rule to the live colour's 5xx count since the
# start: at least CD_5XX_MIN answers AND at least CD_5XX_FACTOR times the baseline scaled to
# the elapsed time (a null baseline uses the minimum alone). A trigger sets
# rollback_target=unusable. A count that cannot be read is "blind", never a trigger. Prints
# ok, trigger or blind. 0; 2 when no signal was started for this release.
cd_data_live_signal_read() {
    local rid f epoch base now n min factor span elapsed
    rid="$(cd_state_get '.release.id // empty')" || return 2
    f="$(_cd_data_signal_file)"
    [[ -n "$rid" && -r "$f" ]] || { _cd_data_err "live signal: it was not started"; return 2; }
    epoch="$(jq -r --arg r "$rid" 'select(.v == 1 and .release == $r) | .epoch | if type == "number" then tostring else empty end' "$f" 2>/dev/null)" || epoch=''
    [[ "$epoch" =~ ^[0-9]{1,12}$ ]] || { _cd_data_err "live signal: it was not started for this release"; return 2; }
    base="$(jq -r 'if (.baseline | type) == "number" then (.baseline | tostring) else "null" end' "$f" 2>/dev/null)" || base=null
    now="$(cd_now)" || return 2
    min="$(cd_cfg CD_5XX_MIN)" || return 2
    factor="$(cd_cfg CD_5XX_FACTOR)" || return 2
    span="$(cd_cfg CD_BASELINE_S)" || return 2
    n="$(_cd_data_count_since "$epoch")"
    if [[ "$n" == null ]]; then
        _cd_data_hist live_signal result=blind
        printf 'blind\n'
        return 0
    fi
    elapsed=$((now - epoch))
    ((elapsed >= 1)) || elapsed=1
    if ((n >= 10#$min)) && { [[ "$base" == null ]] || ((n * 10#$span >= 10#$factor * base * elapsed)); }; then
        _cd_data_hist live_signal result=trigger count="$n"
        _cd_data_unusable live_5xx || return $?
        printf 'trigger\n'
        return 0
    fi
    _cd_data_hist live_signal result=ok count="$n"
    printf 'ok\n'
    return 0
}
