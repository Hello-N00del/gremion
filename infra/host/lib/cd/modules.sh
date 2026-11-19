#!/usr/bin/env bash
# infra/host/lib/cd/modules.sh - the host side of the module step of the continuous
# deployment program: apply the pending files of the module migration chains to the
# enable-gate databases (t_<hex32>__<module>) of every customer that has the module
# enabled, before the new colour starts, and only with a live dump of this release for
# every database it opens.
#
# SOURCED, NEVER EXECUTED. Like docker.sh it does not set shell options: the program that
# sources it owns them. It calls cd_svc_cid, cd_kv_get, cd_envfile and cd_dc of docker.sh
# and cd_cfg, cd_state_get, cd_state_set, cd_now, cd_sleep, cd_hist and cd_notify of the
# core and notify libraries (all resolved at call time), and docker, jq, timeout and
# coreutils. The one-shot it starts is the `module-upgrade --all` verb of the
# tenant-create service (unit module-upgrade); the dump ledger is read through the
# installed gremion-migration-dump.
#
#   cd_modules_upgrade TREE COLOUR TAG   the step (run inside stage `migrate`, after the two
#                                        kernel one-shots, with the cd lock and the host lock)
#   cd_modules_enabled_count             an integer: the registry rows in state `enabled`
#
# RETURN CODES of cd_modules_upgrade (it returns, it never exits):
#   0 ok (also: nothing to do) - 1 an assertion about the result failed, i.e. a failure of
#   the commit (a file raised an SQL error, or the answer of the one-shot cannot be trusted)
#   - 2 a usage error or a missing precondition, an unknown or unlistable registry, a
#   dump that is missing, a timeout, a container that cannot be confirmed gone - 4 an
#   infrastructure failure (a refused connection, compose's own failure): retry, no block.
# It never returns 3, and never for a timeout: a slow migration cannot be told from a stuck
# server, and neither is proof against the commit (the caller holds `failure`).
# The one short code that names the cause of a non-zero return is left in
# CD_MODULES_REASON (codes only: never a name, a path or a value); call the function
# directly, not in $(...), to keep it. The code `module_container_alive` means a labelled
# container could not be confirmed gone: the driver must then skip the teardown, the
# retag restore and the release of the locks, so that no DDL runs beside it; this
# library releases no lock itself.
#
# THE REAL-DATA BOUNDARY. A module database name can carry a customer id and the registry
# is read from the customer data of gremion_platform. The names live in this process only
# (bash variables): they reach no stdout line, no stderr line, no journal line, no history
# line, no mail, no state file and no argv (the queries contain no name, `docker ps` and
# `docker kill` take container ids, the one-shot is started with the release id). What
# psql, the dump program and the one-shot say goes to 0600 files under logs/, and only
# the file name is ever printed.

# shellcheck disable=SC2034,SC2016  # SC2034: CD_MODULES_REASON is read by the driver, which this file does not see; SC2016: the jq programs are single-quoted on purpose
CD_MODULES_REASON=''

# The gate-database name the registry holds (plt.module_database CHECK) and the five
# states it can be in (migration 0003 plus the Karenz state `blocked`, 0016).
_CD_MOD_NAME_RE='^t_[0-9a-f]{32}__[a-z][a-z0-9]*(_[a-z0-9]+)*$'
_CD_MOD_STATES=" enabling enabled disabling blocked dropped "

# The one-shot's contract, in one place: the verb, and the three SQL texts. None of them
# holds a name.
_CD_MOD_SQL_ALL="SELECT db_name, state FROM plt.module_database ORDER BY db_name"
_CD_MOD_SQL_ENABLED="SELECT d.db_name FROM plt.module_database d JOIN plt.module_enablement e ON e.customer_id = d.customer_id AND e.module_id = d.module_id WHERE d.state = 'enabled' AND e.state = 'enabled' ORDER BY d.db_name"
_CD_MOD_SQL_SERVER="SELECT datname FROM pg_catalog.pg_database WHERE NOT datistemplate AND datname ~ '^t_[0-9a-f]{32}__' ORDER BY datname"

# What one run holds, all in the process. Reset at the start of every run.
declare -gA _CD_MOD_ROW_STATE=()  # registry database name -> state (every row)
declare -gA _CD_MOD_ENABLED_Q2=() # names the joined query answers (state enabled in both tables)
declare -ga _CD_MOD_ENABLED=()    # names of the rows in state enabled, as the first query reads them
declare -gA _CD_MOD_SVC_OF=()     # module id -> the compose service of its postgres server
declare -gA _CD_MOD_SVC_RUN=()    # service -> 1 when its container is running
declare -gA _CD_MOD_SVC_DBS=()    # "<service> <database>" -> 1, the gate databases a running server holds
declare -gA _CD_MOD_LIVE=()       # database name -> 1, a live ledger line of this release
_CD_MOD_CID=''                    # the running container of the state project's postgres
_CD_MOD_LOG=''                    # the path of the log file _cd_mod_logfile made last
declare -ga _CD_MOD_LOGS=()       # every log file of this run

_cd_mod_err() { printf 'cd-modules: %s\n' "$*" >&2; }

_cd_mod_root() { printf '%s' "${GREMION_ROOT:-/opt/gremion}"; }

# _cd_mod_fail REASON RC [MESSAGE] - record the reason, say it once, return RC.
_cd_mod_fail() {
    CD_MODULES_REASON="${1:-failed}"
    _cd_mod_err "${3:-${1:-failed}}"
    return "${2:-1}"
}

_cd_mod_now() {
    local t=''
    if declare -F cd_now >/dev/null 2>&1; then
        t="$(cd_now 2>/dev/null)" || t=''
    fi
    if [[ "$t" =~ ^[0-9]+$ ]]; then
        printf '%s' "$t"
    else
        date +%s
    fi
}

_cd_mod_sleep() {
    if declare -F cd_sleep >/dev/null 2>&1; then
        cd_sleep "$1"
    else
        sleep "$1"
    fi
}

# _cd_mod_int VALUE DEFAULT - VALUE when it is a whole number of at least 1, else DEFAULT.
_cd_mod_int() {
    if [[ "${1:-}" =~ ^[0-9]{1,9}$ ]] && ((10#$1 >= 1)); then
        printf '%s' "$((10#$1))"
    else
        printf '%s' "$2"
    fi
}

# _cd_mod_limit - the seconds one docker, psql or program call of this library may take.
_cd_mod_limit() { _cd_mod_int "${CD_MODULES_DOCKER_LIMIT:-}" 60; }

# _cd_mod_logfile NAME - a new 0600 file under logs/, its path left in _CD_MOD_LOG (not
# printed, and remembered in _CD_MOD_LOGS so that a run that succeeds removes the ones that
# stayed empty). Only the file NAME is ever said to the journal or to stdout.
_cd_mod_logfile() {
    local dir f
    dir="$(_cd_mod_root)/logs"
    mkdir -p -- "$dir" 2>/dev/null || true
    f="${dir}/cd-modules-${1}-$(_cd_mod_now)-${RANDOM}${RANDOM}.log"
    (umask 077; : >"$f") 2>/dev/null || {
        _cd_mod_err "cannot create a log file under logs/"
        return 2
    }
    _CD_MOD_LOG="$f"
    _CD_MOD_LOGS+=("$f")
}

# _cd_mod_tidy - remove the log files of this run that are still empty.
_cd_mod_tidy() {
    local f
    for f in "${_CD_MOD_LOGS[@]}"; do
        if [[ -e "$f" && ! -s "$f" ]]; then rm -f -- "$f"; fi
    done
    _CD_MOD_LOGS=()
    return 0
}

# _cd_mod_reset - forget everything a previous run held.
_cd_mod_reset() {
    CD_MODULES_REASON=''
    _CD_MOD_LOG=''
    _CD_MOD_LOGS=()
    _CD_MOD_ROW_STATE=()
    _CD_MOD_ENABLED_Q2=()
    _CD_MOD_ENABLED=()
    _CD_MOD_SVC_OF=()
    _CD_MOD_SVC_RUN=()
    _CD_MOD_SVC_DBS=()
    _CD_MOD_LIVE=()
}

# -- preconditions ------------------------------------------------------------------------

# _cd_mod_owned_dir PATH MODE - 0 when PATH is a real directory (no symlink) owned by the
# deploy user; with MODE (an octal string) its permission bits must be exactly MODE.
# Docker creates a missing bind source as root, and a directory a root process owns can be
# neither read nor retired by the deploy user.
_cd_mod_owned_dir() {
    local p="$1" want="${2:-}" st mode owner
    [[ -d "$p" && ! -L "$p" ]] || return 1
    st="$(stat -c '%a %u' -- "$p" 2>/dev/null)" || return 1
    mode="${st%% *}"
    owner="${st##* }"
    [[ "$owner" == "$(id -u)" ]] || return 1
    [[ -z "$want" || "$mode" == "$want" ]]
}

# _cd_mod_precheck_dirs ENVFILE - the host directories the one-shot bind-mounts that hold
# secrets: etc/secrets/governance and TENANT_SECRETS_DIR (from the target env file) must exist
# as 0700 directories of the deploy user (gremion-init and bootstrap make them so), else code
# 2 and no container starts: Docker would create a missing bind source as root. The service
# also mounts data/module-exports; nothing of the module step uses it and its owner on a host
# is whatever the first tenant-create run made it, so it is not checked. A TENANT_SECRETS_DIR in
# the process environment that differs from the env file is refused: compose prefers the
# environment, and the directory checked here would not be the one that is mounted.
_cd_mod_precheck_dirs() {
    local envf="$1" root ts
    root="$(_cd_mod_root)"
    _cd_mod_owned_dir "${root}/etc/secrets/governance" 700 \
        || { _cd_mod_fail secrets_dir 2 "etc/secrets/governance must exist as a 0700 directory of the deploy user"; return 2; }
    ts="$(cd_kv_get "$envf" TENANT_SECRETS_DIR 2>/dev/null)" || ts=''
    if [[ -z "$ts" || "$ts" != /* || "$ts" == *'$'* ]]; then
        _cd_mod_fail secrets_dir 2 "the target env file does not give TENANT_SECRETS_DIR as one absolute path"
        return 2
    fi
    if [[ -n "${TENANT_SECRETS_DIR:-}" && "${TENANT_SECRETS_DIR}" != "$ts" ]]; then
        _cd_mod_fail secrets_dir 2 "TENANT_SECRETS_DIR in the environment differs from the target env file"
        return 2
    fi
    _cd_mod_owned_dir "$ts" 700 \
        || { _cd_mod_fail secrets_dir 2 "TENANT_SECRETS_DIR must exist as a 0700 directory of the deploy user"; return 2; }
    return 0
}

# -- the registry ----------------------------------------------------------------------------

# _cd_mod_psql CID ROLE DB SQL ERRLOG - one psql call through docker exec: no stdin, a
# time limit, the server's own complaints into ERRLOG (a 0600 file). Prints the rows
# (unaligned, tuples only, fields separated by |) without carriage returns.
_cd_mod_psql() {
    local cid="$1" role="$2" db="$3" sql="$4" errlog="$5" out
    out="$(timeout -k 5 "$(_cd_mod_limit)" docker exec "$cid" psql -X -U "$role" -d "$db" -v ON_ERROR_STOP=1 -Atq -c "$sql" </dev/null 2>>"$errlog")" || return 1
    printf '%s' "${out//$'\r'/}"
}

# _cd_mod_state_cid - the running postgres container of the state project, left in
# _CD_MOD_CID (not printed, so the reason of a failure survives the call); code 2 and a
# reason when there is none or docker does not answer.
_cd_mod_state_cid() {
    _CD_MOD_CID=''
    _CD_MOD_CID="$(cd_svc_cid state postgres 2>/dev/null)" || {
        _CD_MOD_CID=''
        _cd_mod_fail no_state_postgres 2 "docker did not answer for the state project's postgres"
        return 2
    }
    if [[ -z "$_CD_MOD_CID" ]]; then
        _cd_mod_fail no_state_postgres 2 "the state project's postgres is not running"
        return 2
    fi
    return 0
}

# _cd_mod_load_rows CID ERRLOG - the two registry queries, validated shape by shape. The
# first reads every row of plt.module_database with its state (any state), the second the
# `enabled` ones joined to plt.module_enablement `enabled`. A failing query, a row that is
# not a name and a state, a state outside the five known ones, and a number of enabled
# rows that differs between the two queries are all code 2: unknown is never "nothing to do".
_cd_mod_load_rows() {
    local cid="$1" errlog="$2" role out line name st n
    role="$(cd_kv_get "$(cd_envfile state)" POSTGRES_USER 2>/dev/null)" || role=''
    [[ -n "$role" ]] || { _cd_mod_fail no_pg_user 2 "state.env does not give POSTGRES_USER"; return 2; }
    out="$(_cd_mod_psql "$cid" "$role" gremion_platform "$_CD_MOD_SQL_ALL" "$errlog")" \
        || { _cd_mod_fail listing_failed 2 "the registry listing failed; output in logs/${errlog##*/}"; return 2; }
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        if [[ "$line" != *'|'* ]]; then
            _cd_mod_fail listing_malformed 2 "a registry row is not a name and a state"
            return 2
        fi
        name="${line%%|*}"
        st="${line#*|}"
        if [[ ! "$name" =~ $_CD_MOD_NAME_RE || "${#name}" -gt 63 ]]; then
            _cd_mod_fail listing_malformed 2 "a registry row does not carry a gate-database name"
            return 2
        fi
        if [[ "$_CD_MOD_STATES" != *" ${st} "* ]]; then
            _cd_mod_fail unknown_state 2 "a registry row has a state the program does not know"
            return 2
        fi
        if [[ -n "${_CD_MOD_ROW_STATE[$name]+set}" ]]; then
            _cd_mod_fail listing_malformed 2 "a registry name appears twice"
            return 2
        fi
        _CD_MOD_ROW_STATE["$name"]="$st"
        if [[ "$st" == enabled ]]; then _CD_MOD_ENABLED+=("$name"); fi
    done <<<"$out"
    out="$(_cd_mod_psql "$cid" "$role" gremion_platform "$_CD_MOD_SQL_ENABLED" "$errlog")" \
        || { _cd_mod_fail listing_failed 2 "the enabled listing failed; output in logs/${errlog##*/}"; return 2; }
    n=0
    while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        if [[ ! "$name" =~ $_CD_MOD_NAME_RE || "${#name}" -gt 63 ]]; then
            _cd_mod_fail listing_malformed 2 "an enabled row does not carry a gate-database name"
            return 2
        fi
        # every joined row must be an enabled row of the first query
        if [[ "${_CD_MOD_ROW_STATE[$name]:-}" != enabled || -n "${_CD_MOD_ENABLED_Q2[$name]+set}" ]]; then
            _cd_mod_fail enabled_count_mismatch 2 "the two registry queries disagree"
            return 2
        fi
        _CD_MOD_ENABLED_Q2["$name"]=1
        n=$((n + 1))
    done <<<"$out"
    if [[ "$n" -ne "${#_CD_MOD_ENABLED[@]}" ]]; then
        _cd_mod_fail enabled_count_mismatch 2 "the number of enabled rows differs between the two registry queries"
        return 2
    fi
    return 0
}

# cd_modules_enabled_count - the number of registry rows in state `enabled` (the joined
# listing, after the same shape checks as the step). Prints an integer and returns 0; on
# anything else prints nothing and returns 2.
cd_modules_enabled_count() {
    local errlog rc=0
    _cd_mod_reset
    _cd_mod_logfile count || return 2
    errlog="$_CD_MOD_LOG"
    _cd_mod_state_cid || return 2
    _cd_mod_load_rows "$_CD_MOD_CID" "$errlog" || rc=$?
    [[ "$rc" -eq 0 ]] || return "$rc"
    _cd_mod_tidy
    printf '%s\n' "${#_CD_MOD_ENABLED_Q2[@]}"
}

# -- the servers -----------------------------------------------------------------------------

# _cd_mod_servers TREE ERRLOG - find the module servers of the NEW tree by the declaration
# (a module.json whose runtime.database names a postgresService; a module with no database
# is never entered), then list, on every server whose container runs, every gate database it
# holds. The role is <SERVER>_PG_USER of state.env, read by name and never printed: a missing
# key is code 2, never a default. A server that does not run is skipped here; a registry row
# in state enabled whose server does not run is refused by the cross-check.
_cd_mod_servers() {
    local tree="$1" errlog="$2" f dir id svc row statef up cid role out name
    local -A seen=()
    if [[ ! -d "${tree}/modules" ]]; then
        _cd_mod_fail module_tree 2 "the release tree has no modules directory"
        return 2
    fi
    for f in "${tree}"/modules/*/module.json; do
        [[ -f "$f" ]] || continue
        dir="${f%/module.json}"
        dir="${dir##*/}"
        row="$(jq -r '[(.id // ""), (.runtime.database.postgresService // "")] | @tsv' "$f" 2>/dev/null </dev/null)" || {
            _cd_mod_fail module_json 2 "a module.json of the release tree cannot be read"
            return 2
        }
        IFS=$'\t' read -r id svc <<<"$row" || true
        if [[ ! "$id" =~ ^[a-z][a-z0-9]*(_[a-z0-9]+)*$ || "$id" != "$dir" ]]; then
            _cd_mod_fail module_json 2 "a module.json does not name its own directory"
            return 2
        fi
        [[ -n "$svc" ]] || continue
        if [[ ! "$svc" =~ ^[a-z][a-z0-9]*-postgres$ ]]; then
            _cd_mod_fail module_json 2 "a module declares a server name the program does not accept"
            return 2
        fi
        _CD_MOD_SVC_OF["$id"]="$svc"
        seen["$svc"]=1
    done
    statef="$(cd_envfile state)" || return 2
    for svc in "${!seen[@]}"; do
        cid="$(cd_svc_cid state "$svc" 2>/dev/null)" || {
            _cd_mod_fail module_server 2 "docker did not answer for a module server"
            return 2
        }
        [[ -n "$cid" ]] || continue
        up="${svc%-postgres}"
        up="${up^^}"
        role="$(cd_kv_get "$statef" "${up}_PG_USER" 2>/dev/null)" || role=''
        if [[ -z "$role" ]]; then
            _cd_mod_fail no_pg_user 2 "state.env does not give the role of a running module server"
            return 2
        fi
        out="$(_cd_mod_psql "$cid" "$role" postgres "$_CD_MOD_SQL_SERVER" "$errlog")" || {
            _cd_mod_fail server_listing_failed 2 "a module server could not be listed; output in logs/${errlog##*/}"
            return 2
        }
        _CD_MOD_SVC_RUN["$svc"]=1
        while IFS= read -r name; do
            [[ -n "$name" ]] || continue
            if [[ ! "$name" =~ $_CD_MOD_NAME_RE || "${#name}" -gt 63 ]]; then
                _cd_mod_fail server_listing_failed 2 "a module server lists a gate database with an odd name"
                return 2
            fi
            _CD_MOD_SVC_DBS["${svc} ${name}"]=1
        done <<<"$out"
    done
    return 0
}

# _cd_mod_cross_check - the registry and the servers must tell one story. Every gate
# database found on a running module server has a row in the registry (any state), else
# `unknown_database`; every row in state enabled has its database on the running server of
# its module, else `enabled_database_missing`. So a join or a state literal that would read
# as "nothing to do" fails, while `blocked` and `enabling` rows whose databases are present
# are no error (they are simply not migrated here).
_cd_mod_cross_check() {
    local key svc name mod
    for key in "${!_CD_MOD_SVC_DBS[@]}"; do
        name="${key#* }"
        if [[ -z "${_CD_MOD_ROW_STATE[$name]+set}" ]]; then
            _cd_mod_fail unknown_database 2 "a gate database on a running module server has no registry row"
            return 2
        fi
    done
    for name in "${_CD_MOD_ENABLED[@]}"; do
        [[ "$name" =~ ^t_[0-9a-f]{32}__(.+)$ ]] || { _cd_mod_fail listing_malformed 2 "a registry row does not carry a gate-database name"; return 2; }
        mod="${BASH_REMATCH[1]}"
        svc="${_CD_MOD_SVC_OF[$mod]:-}"
        if [[ -z "$svc" ]]; then
            _cd_mod_fail module_undeclared 2 "an enabled row belongs to a module the release tree does not declare a database for"
            return 2
        fi
        if [[ -z "${_CD_MOD_SVC_RUN[$svc]:-}" || -z "${_CD_MOD_SVC_DBS["${svc} ${name}"]+set}" ]]; then
            _cd_mod_fail enabled_database_missing 2 "an enabled row has no database on a running module server"
            return 2
        fi
    done
    return 0
}

# -- the dump precondition --------------------------------------------------------------------

# _cd_mod_dump_check TAG ERRLOG - a live ledger line of this release label for every
# database the step will open. `status` is read into a variable (its lines carry the
# names) and parsed token by token; its trailer must agree with the lines, and a line that
# is none of the two known shapes is refused. One database without a line is code 2 and
# nothing is opened.
_cd_mod_dump_check() {
    local tag="$1" errlog="$2" prog out line rel db count=0 trailer='' missing=0 name
    prog="$(_cd_mod_root)/bin/gremion-migration-dump"
    if [[ ! -x "$prog" ]]; then
        _cd_mod_fail dump_program 2 "gremion-migration-dump is not installed"
        return 2
    fi
    out="$(timeout -k 5 "$(_cd_mod_limit)" "$prog" status --release "$tag" 2>>"$errlog" </dev/null)" || {
        _cd_mod_fail dump_status_failed 2 "the dump ledger could not be read; output in logs/${errlog##*/}"
        return 2
    }
    while IFS= read -r line; do
        line="${line%$'\r'}"
        [[ -n "$line" ]] || continue
        if [[ -n "$trailer" ]]; then
            _cd_mod_fail dump_status_unparsed 2 "the dump ledger answer has lines after its trailer"
            return 2
        fi
        if [[ "$line" =~ ^LIVE\ [^\ ]+\ release=([^\ ]+)\ db=([^\ ]+)\  ]]; then
            rel="${BASH_REMATCH[1]}"
            db="${BASH_REMATCH[2]}"
            if [[ "$rel" == "$tag" ]]; then
                _CD_MOD_LIVE["$db"]=1
                count=$((count + 1))
            fi
        elif [[ "$line" =~ ^STATUS:\ ([0-9]+)\ live\ dump\(s\)$ ]]; then
            trailer="${BASH_REMATCH[1]}"
        else
            _cd_mod_fail dump_status_unparsed 2 "the dump ledger answer has a line of an unknown shape"
            return 2
        fi
    done <<<"$out"
    if [[ -z "$trailer" || "$trailer" -ne "$count" ]]; then
        _cd_mod_fail dump_status_unparsed 2 "the dump ledger answer is truncated or does not add up"
        return 2
    fi
    for name in "${!_CD_MOD_ENABLED_Q2[@]}"; do
        [[ -n "${_CD_MOD_LIVE[$name]+set}" ]] || missing=$((missing + 1))
    done
    if [[ "$missing" -gt 0 ]]; then
        _cd_mod_fail dump_missing 2 "${missing} enabled module database(s) have no live dump of ${tag}"
        return 2
    fi
    return 0
}

# -- the container, and the label that finds it --------------------------------------------

# _cd_mod_labelled LABELID - the ids of every container (running or stopped: `ps -a`) that
# carries the label gremion.cd=<release id>, one per line. 1 when docker did not answer,
# which is never read as "none".
_cd_mod_labelled() {
    local out id
    out="$(timeout -k 5 "$(_cd_mod_limit)" docker ps -a -q --filter "label=gremion.cd=${1}" </dev/null 2>/dev/null)" || return 1
    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || return 1
        printf '%s\n' "$id"
    done <<<"$out"
    return 0
}

# _cd_mod_reap LABELID - kill and remove every container of the label and poll `docker ps
# -a` until two answers in a row are empty (a stopped container counts, a killed one that
# is not auto-removed would otherwise be left behind), for at most CD_MODULES_CONFIRM_S
# seconds (60). 0 when confirmed gone, 1 when not. An unanswered `docker ps` is no empty
# answer. It returns no earlier than that.
_cd_mod_reap() {
    local rid="$1" deadline empties=0 ids
    local -a arr=()
    deadline=$(($(_cd_mod_now) + $(_cd_mod_int "${CD_MODULES_CONFIRM_S:-}" 60)))
    while :; do
        if ids="$(_cd_mod_labelled "$rid")"; then
            if [[ -z "$ids" ]]; then
                empties=$((empties + 1))
                [[ "$empties" -ge 2 ]] && return 0
            else
                empties=0
                mapfile -t arr <<<"$ids"
                timeout -k 5 "$(_cd_mod_limit)" docker kill "${arr[@]}" </dev/null >/dev/null 2>&1 || true
                timeout -k 5 "$(_cd_mod_limit)" docker rm -f "${arr[@]}" </dev/null >/dev/null 2>&1 || true
            fi
        else
            empties=0
        fi
        [[ "$(_cd_mod_now)" -lt "$deadline" ]] || return 1
        _cd_mod_sleep 1
    done
}

# _cd_mod_alive TAG COLOUR - a labelled container could not be confirmed gone: code 2, the
# reason that tells the driver to skip the teardown, and a mail (kind `stopped`).
_cd_mod_alive() {
    local tag="$1" colour="$2"
    CD_MODULES_REASON=module_container_alive
    _cd_mod_err "a container of the module step could not be confirmed gone"
    if declare -F cd_hist >/dev/null 2>&1; then cd_hist modules_container_alive || true; fi
    if declare -F cd_notify >/dev/null 2>&1; then
        cd_notify stopped "tag=${tag}" "colour=${colour}" "sha12=${tag#pilot-}" stage=migrate reason=module_container_alive >/dev/null 2>&1 || true
    fi
    return 2
}

# -- the answer of the one-shot -----------------------------------------------------------

# _cd_mod_json OUTFILE - the one JSON line the verb prints on stdout, reduced to its six
# counts. Exactly one line that starts with { must exist, and its six keys must be whole
# non-negative numbers; anything else is no valid line (rc 1). Prints the reduced object.
_cd_mod_json() {
    local f="$1" n line obj
    n="$(grep -c '^[[:space:]]*{' "$f" 2>/dev/null)" || n=0
    [[ "$n" -eq 1 ]] || return 1
    line="$(grep '^[[:space:]]*{' "$f" 2>/dev/null)" || return 1
    obj="$(printf '%s' "$line" | jq -c 'select(type == "object") | {total, upgraded, unchanged, skipped, failed, files_applied} | select(all(.[]; type == "number" and . >= 0 and . == floor and . < 1000000000))' 2>/dev/null)" || return 1
    [[ -n "$obj" ]] || return 1
    printf '%s' "$obj"
}

# _cd_mod_record JSON - release.modules in the state, from the six counts.
_cd_mod_record() {
    cd_state_set '.release.modules = $m' --argjson m "$1" \
        || { _cd_mod_fail state_write 2 "the module counts could not be written to the state"; return 2; }
}

# _cd_mod_policy_skips - 0 when the step is skipped: the policy `migration` and no chain of
# class module-upgrade gained a file (the class of the release record). With the policy
# `always` the step runs. A policy `migration` with no readable class is code 2, never a skip.
_cd_mod_policy_skips() {
    local policy n
    policy="$(cd_cfg CD_DUMP_POLICY 2>/dev/null)" || policy=''
    case "$policy" in
        always) return 1 ;;
        migration)
            n="$(cd_state_get 'if (.release.class.migrations.chains | type) == "object" then [ .release.class.migrations.chains | to_entries[] | select((.key | startswith("module-")) and (.value.class == "module-upgrade") and (((.value.expand // 0) + (.value.migrate // 0) + (.value.contract // 0)) > 0)) ] | length else "none" end' 2>/dev/null)" || n=''
            if [[ ! "$n" =~ ^[0-9]+$ ]]; then
                _cd_mod_fail class_missing 2 "the policy is migration and the release record has no readable class"
                return 2
            fi
            [[ "$n" -eq 0 ]] && return 0
            return 1
            ;;
        *)
            _cd_mod_fail policy 2 "CD_DUMP_POLICY is not readable"
            return 2
            ;;
    esac
}

# -- the step -------------------------------------------------------------------------------------

# cd_modules_upgrade TREE COLOUR TAG - see the head of the file. A run that succeeds removes
# the log files that stayed empty; a run that fails keeps every one of them.
cd_modules_upgrade() {
    local rc=0
    _cd_mod_upgrade "$@" || rc=$?
    if [[ "$rc" -eq 0 ]]; then _cd_mod_tidy; fi
    return "$rc"
}

_cd_mod_upgrade() {
    local tree="${1:-}" colour="${2:-}" tag="${3:-}" rid rtag rcol envf pol rc=0 tmo
    local errlog outf runerr json ids start
    [[ "$#" -eq 3 ]] || { _cd_mod_fail usage 2 "usage: TREE COLOUR TAG"; return 2; }
    _cd_mod_reset
    [[ -d "$tree" && -x "$tree" ]] || { _cd_mod_fail usage 2 "no release tree directory that can be entered"; return 2; }
    case "$colour" in blue | green) ;; *) _cd_mod_fail usage 2 "the colour is blue or green"; return 2 ;; esac
    [[ "$tag" =~ ^pilot-[0-9a-f]{12}$ ]] || { _cd_mod_fail usage 2 "the tag is pilot-<12 hex>"; return 2; }
    rid="$(cd_state_get '.release.id // empty')" || rid=''
    rtag="$(cd_state_get '.release.tag // empty')" || rtag=''
    rcol="$(cd_state_get '.release.colour // empty')" || rcol=''
    if [[ ! "$rid" =~ ^[0-9a-f]{12}-[0-9]+$ ]]; then
        _cd_mod_fail no_release 2 "the state holds no release record"
        return 2
    fi
    if [[ "$rtag" != "$tag" || "$rcol" != "$colour" ]]; then
        _cd_mod_fail release_mismatch 2 "the release record names another tag or colour"
        return 2
    fi
    # the policy first: a skipped step touches nothing, not even docker
    pol=0
    _cd_mod_policy_skips || pol=$?
    case "$pol" in
        0)
            cd_hist modules_skipped reason=policy >/dev/null 2>&1 || true
            return 0
            ;;
        2) return 2 ;;
        *) ;;
    esac
    envf="$(cd_envfile "app-${colour}")" || { _cd_mod_fail usage 2 "no env file for the target colour"; return 2; }
    [[ -f "$envf" && -r "$envf" ]] || { _cd_mod_fail usage 2 "the target colour's env file is not readable"; return 2; }
    _cd_mod_precheck_dirs "$envf" || return $?

    _cd_mod_logfile query || return 2
    errlog="$_CD_MOD_LOG"
    _cd_mod_state_cid || return 2
    _cd_mod_load_rows "$_CD_MOD_CID" "$errlog" || return $?
    _cd_mod_servers "$tree" "$errlog" || return $?
    _cd_mod_cross_check || return $?

    if [[ "${#_CD_MOD_ENABLED_Q2[@]}" -eq 0 ]]; then
        # nothing is enabled: the cross-checks above are what makes an empty listing
        # trustworthy; the verb is not called
        _cd_mod_record '{"total":0,"upgraded":0,"unchanged":0,"skipped":0,"failed":0,"files_applied":0}' || return $?
        cd_hist modules_done total=0 >/dev/null 2>&1 || true
        return 0
    fi

    _cd_mod_dump_check "$tag" "$errlog" || return $?

    # a container of an earlier try of this release must be gone before the next one starts
    if ! ids="$(_cd_mod_labelled "$rid")" || [[ -n "$ids" ]]; then
        if ! _cd_mod_reap "$rid"; then
            _cd_mod_alive "$tag" "$colour"
            return 2
        fi
    fi

    tmo="$(_cd_mod_int "$(cd_cfg CD_MODULE_UPGRADE_TIMEOUT_S 2>/dev/null)" 900)"
    _cd_mod_logfile out || return 2
    outf="$_CD_MOD_LOG"
    _cd_mod_logfile run || return 2
    runerr="$_CD_MOD_LOG"
    start="$(_cd_mod_now)"
    (
        CD_DC_TIMEOUT="$tmo" cd_dc "$tree" "app-${colour}" run --rm --no-deps -T --label "gremion.cd=${rid}" tenant-create module-upgrade --all
    ) >"$outf" 2>"$runerr" </dev/null || rc=$?

    # whatever happened, no container of this release may be left: after a timeout the
    # client is dead and the container is not (F50), and after any other failure a
    # created-but-never-started one must not stay
    if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
        cd_hist modules_timeout seconds=$(($(_cd_mod_now) - start)) >/dev/null 2>&1 || true
        if ! _cd_mod_reap "$rid"; then
            _cd_mod_alive "$tag" "$colour"
            return 2
        fi
        _cd_mod_fail module_timeout 2 "the module step ran out of time (${tmo}s); the container is gone"
        return 2
    fi
    if ! ids="$(_cd_mod_labelled "$rid")" || [[ -n "$ids" ]]; then
        if ! _cd_mod_reap "$rid"; then
            _cd_mod_alive "$tag" "$colour"
            return 2
        fi
    fi

    json="$(_cd_mod_json "$outf")" || json=''
    case "$rc" in
        0)
            if [[ -z "$json" ]] || ! printf '%s' "$json" | jq -e '(.upgraded + .unchanged + .skipped + .failed) == .total and .failed == 0' >/dev/null 2>&1; then
                _cd_mod_fail module_result_invalid 1 "the module step exited 0 without a valid count line; output in logs/${outf##*/}"
                return 1
            fi
            _cd_mod_record "$json" || return $?
            cd_hist modules_done "total=$(printf '%s' "$json" | jq -r '.total')" "upgraded=$(printf '%s' "$json" | jq -r '.upgraded')" >/dev/null 2>&1 || true
            return 0
            ;;
        1)
            if [[ -z "$json" ]]; then
                _cd_mod_fail module_run_failed 4 "the module step failed before its own answer (exit 1); output in logs/${runerr##*/}"
                return 4
            fi
            _cd_mod_record "$json" || return $?
            _cd_mod_fail module_upgrade 1 "the module step failed on a migration file; output in logs/${runerr##*/}"
            return 1
            ;;
        2)
            _cd_mod_fail module_usage 2 "the module step refused its arguments or a precondition (exit 2); output in logs/${runerr##*/}"
            return 2
            ;;
        3)
            if [[ -n "$json" ]]; then _cd_mod_record "$json" || return $?; fi
            _cd_mod_fail module_infra 4 "the module step could not reach a server (exit 3); output in logs/${runerr##*/}"
            return 4
            ;;
        *)
            _cd_mod_fail module_run_failed 4 "the module step could not run (exit ${rc}); output in logs/${runerr##*/}"
            return 4
            ;;
    esac
}
