#!/usr/bin/env bash
# infra/host/lib/cd/leaves.sh - the host side of the leaf step of the continuous deployment
# program: before the new colour starts, run the `--migrate-only` entry of every leaf service
# of the target colour (calendar, content, publishing) once, so that the leaf databases carry
# every migration file of the new image, and only with a live dump of this release for every
# leaf database the entry would open.
#
# SOURCED, NEVER EXECUTED. Like modules.sh it does not set shell options: the program that
# sources it owns them. It calls cd_svc_cid, cd_kv_get, cd_envfile and cd_dc of docker.sh and
# cd_cfg, cd_state_get, cd_state_set, cd_now, cd_sleep, cd_hist and cd_notify of the core and
# notify libraries (all resolved at call time), and docker, jq, timeout and coreutils. It uses
# a prefix of its own (_cd_leaf_) and calls nothing private of modules.sh, because both files
# are sourced into one process. The dump ledger is read through the installed
# gremion-migration-dump.
#
#   cd_leaves_services TREE COLOUR       prints the leaf services of the target colour that are in
#                                        its compose profiles, one per line (a subset of the fixed
#                                        list below); prints nothing when none is
#   cd_leaves_migrate TREE COLOUR TAG    the step (run inside stage `migrate`, after the module step,
#                                        with the cd lock and the host lock)
#
# THE FIXED LIST. calendar-service, content-service and newsletter-service, each with its own
# database server. Board is not in it (its data is in a gate database, which the module step
# applies), and neither are messaging, Nextcloud or any other service. A drift test pins the
# list against the compose file: a leaf added there turns it red until it is decided.
#
# ONE CONTAINER PER LEAF SERVICE. The container goes through the customers itself. This
# library never loops over customers, never sees a slug and never puts a database name in an
# argument.
#
# RETURN CODES of cd_leaves_migrate (it returns, it never exits):
#   0 ok (also: nothing to do) - 1 an assertion about the result failed, i.e. a failure of the
#   commit (a migration file raised an SQL error, or the answer of the entry cannot be
#   trusted) - 2 a usage error or a missing precondition, a dump that is missing, a timeout, a
#   container that cannot be confirmed gone - 4 an infrastructure failure (a refused
#   connection, compose's own failure): retry, no block.
# It never returns 3, and never for a timeout. It writes no block and no hold, calls no
# rollback and releases no lock; the driver maps the code.
# The one short code that names the cause of a non-zero return is left in CD_LEAVES_REASON
# (codes only: never a name, a path or a value); call the function directly, not in $(...),
# to keep it. The code `leaf_container_alive` means a labelled container could not be
# confirmed gone: the driver must then skip the teardown and the retag restore until it is
# gone, so that no DDL runs beside it.
#
# THE REAL-DATA BOUNDARY. A leaf database name carries the customer slug. The names live in
# this process only (bash variables): they reach no stdout line, no stderr line, no journal
# line, no history line, no mail, no state file and no argv (the queries contain no name,
# `docker ps` and `docker kill` take container ids, the entry is started with the release
# id). What psql, the dump program and the entry say goes to 0600 files under logs/, and only
# the file name is ever printed.

# shellcheck disable=SC2034,SC2016  # SC2034: CD_LEAVES_REASON is read by the driver, which this file does not see; SC2016: the jq programs are single-quoted on purpose
CD_LEAVES_REASON=''

# The fixed list, and the database server of each (the compose service of the state project).
_CD_LEAF_SERVICES=(calendar-service content-service newsletter-service)
declare -gA _CD_LEAF_SERVER_OF=(
    [calendar-service]=calendar-postgres
    [content-service]=content-postgres
    [newsletter-service]=newsletter-postgres
)
# The migration chains of the three leaves (scripts/migrations/ranges.json): a file gained by
# one of them is what the policy `migration` waits for.
_CD_LEAF_CHAINS_JQ='(.key == "module-calendar" or .key == "module-content" or .key == "module-publishing")'

# A database name the dump program accepts, and a gate-database name (the module step's, not
# the entry's: a blocked gate database sits on the same server and is left undumped by design).
_CD_LEAF_RE_DB='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$'
_CD_LEAF_RE_GATE='^t_[0-9a-f]{32}__[a-z][a-z0-9]*(_[a-z0-9]+)*$'
_CD_LEAF_SQL_SERVER="SELECT datname FROM pg_catalog.pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname"

# What one run holds, all in the process. Reset at the start of every run.
declare -ga _CD_LEAF_RUN=()       # the services this run will start, in the order of the fixed list
declare -gA _CD_LEAF_LIVE=()      # database name -> 1, a live ledger line of this release
_CD_LEAF_LOG=''                   # the path of the log file _cd_leaf_logfile made last
declare -ga _CD_LEAF_LOGS=()      # every log file of this run
_CD_LEAF_SUM_TOTAL=0              # the counts of the services that answered, summed
_CD_LEAF_SUM_MIGRATED=0
_CD_LEAF_SUM_SKIPPED=0
_CD_LEAF_SUM_FAILED=0

_cd_leaf_err() { printf 'cd-leaves: %s\n' "$*" >&2; }

_cd_leaf_root() { printf '%s' "${GREMION_ROOT:-/opt/gremion}"; }

# _cd_leaf_fail REASON RC [MESSAGE] - record the reason, say it once, return RC.
_cd_leaf_fail() {
    CD_LEAVES_REASON="${1:-failed}"
    _cd_leaf_err "${3:-${1:-failed}}"
    return "${2:-1}"
}

_cd_leaf_now() {
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

_cd_leaf_sleep() {
    if declare -F cd_sleep >/dev/null 2>&1; then
        cd_sleep "$1"
    else
        sleep "$1"
    fi
}

# _cd_leaf_int VALUE DEFAULT - VALUE when it is a whole number of at least 1, else DEFAULT.
_cd_leaf_int() {
    if [[ "${1:-}" =~ ^[0-9]{1,9}$ ]] && ((10#$1 >= 1)); then
        printf '%s' "$((10#$1))"
    else
        printf '%s' "$2"
    fi
}

# _cd_leaf_limit - the seconds one docker, psql or program call of this library may take.
_cd_leaf_limit() { _cd_leaf_int "${CD_LEAVES_DOCKER_LIMIT:-}" 60; }

# _cd_leaf_logfile NAME - a new 0600 file under logs/, its path left in _CD_LEAF_LOG (not
# printed, and remembered in _CD_LEAF_LOGS so that a run that succeeds removes the ones that
# stayed empty). Only the file NAME is ever said to the journal or to stdout.
_cd_leaf_logfile() {
    local dir f
    dir="$(_cd_leaf_root)/logs"
    mkdir -p -- "$dir" 2>/dev/null || true
    f="${dir}/cd-leaves-${1}-$(_cd_leaf_now)-${RANDOM}${RANDOM}.log"
    (umask 077; : >"$f") 2>/dev/null || {
        _cd_leaf_err "cannot create a log file under logs/"
        return 2
    }
    _CD_LEAF_LOG="$f"
    _CD_LEAF_LOGS+=("$f")
}

# _cd_leaf_tidy - remove the log files of this run that are still empty.
_cd_leaf_tidy() {
    local f
    for f in "${_CD_LEAF_LOGS[@]}"; do
        if [[ -e "$f" && ! -s "$f" ]]; then rm -f -- "$f"; fi
    done
    _CD_LEAF_LOGS=()
    return 0
}

# _cd_leaf_reset - forget everything a previous run held.
_cd_leaf_reset() {
    CD_LEAVES_REASON=''
    _CD_LEAF_LOG=''
    _CD_LEAF_LOGS=()
    _CD_LEAF_RUN=()
    _CD_LEAF_LIVE=()
    _CD_LEAF_SUM_TOTAL=0
    _CD_LEAF_SUM_MIGRATED=0
    _CD_LEAF_SUM_SKIPPED=0
    _CD_LEAF_SUM_FAILED=0
}

# -- the service list ---------------------------------------------------------------------------

# _cd_leaf_services TREE COLOUR - fill _CD_LEAF_RUN: the services of the fixed list that the
# compose project of the target colour renders (`config --services` lists the services of the
# profiles its env file declares, never the profile-gated others; compose would start the
# profile of a named service by itself, so this filter is the only thing that keeps a leaf
# that is switched off from running). A project that renders no service at all is a refusal,
# never "no leaf". Code 2 on a refusal.
_cd_leaf_services() {
    local tree="$1" colour="$2" listing errf why s line
    local -A rendered=()
    _CD_LEAF_RUN=()
    errf="$(mktemp 2>/dev/null)" || { _cd_leaf_fail tmpfile 2 "cannot create a temporary file"; return 2; }
    listing="$(
        CD_DC_TIMEOUT="$(_cd_leaf_limit)" cd_dc "$tree" "app-${colour}" config --services 2>"$errf" </dev/null
    )" || {
        why="$(tr -cd '[:print:]\n' <"$errf" 2>/dev/null | head -n 1 | cut -c 1-200)"
        rm -f -- "$errf"
        _cd_leaf_fail services_failed 2 "the target colour's compose project did not render${why:+: ${why#cd-docker: }}"
        return 2
    }
    rm -f -- "$errf"
    while IFS= read -r line; do
        line="${line%$'\r'}"
        [[ -n "$line" ]] || continue
        if [[ ! "$line" =~ ^[a-z0-9][a-z0-9_.-]*$ ]]; then
            _cd_leaf_fail services_failed 2 "the compose service listing has a line that is not a service name"
            return 2
        fi
        rendered["$line"]=1
    done <<<"$listing"
    if [[ "${#rendered[@]}" -eq 0 ]]; then
        _cd_leaf_fail services_failed 2 "the target colour's compose project renders no service"
        return 2
    fi
    for s in "${_CD_LEAF_SERVICES[@]}"; do
        if [[ -n "${rendered[$s]+set}" ]]; then _CD_LEAF_RUN+=("$s"); fi
    done
    return 0
}

# cd_leaves_services TREE COLOUR - see the head of the file.
cd_leaves_services() {
    local tree="${1:-}" colour="${2:-}" s
    [[ "$#" -eq 2 ]] || { _cd_leaf_fail usage 2 "usage: TREE COLOUR"; return 2; }
    [[ -d "$tree" && -x "$tree" ]] || { _cd_leaf_fail usage 2 "no release tree directory that can be entered"; return 2; }
    case "$colour" in blue | green) ;; *) _cd_leaf_fail usage 2 "the colour is blue or green"; return 2 ;; esac
    _cd_leaf_services "$tree" "$colour" || return $?
    for s in "${_CD_LEAF_RUN[@]}"; do printf '%s\n' "$s"; done
    return 0
}

# -- preconditions ------------------------------------------------------------------------------

# _cd_leaf_owned_dir PATH MODE - 0 when PATH is a real directory (no symlink) owned by the
# deploy user whose permission bits are exactly MODE. Docker creates a missing bind source as
# root, and a directory a root process owns can be neither read nor retired by the deploy user.
_cd_leaf_owned_dir() {
    local p="$1" want="${2:-}" st mode owner
    [[ -d "$p" && ! -L "$p" ]] || return 1
    st="$(stat -c '%a %u' -- "$p" 2>/dev/null)" || return 1
    mode="${st%% *}"
    owner="${st##* }"
    [[ "$owner" == "$(id -u)" ]] || return 1
    [[ -z "$want" || "$mode" == "$want" ]]
}

# _cd_leaf_precheck_dirs ENVFILE - the two secrets directories the module step also needs:
# etc/secrets/governance and TENANT_SECRETS_DIR (from the target env file) must exist as 0700
# directories of the deploy user, else code 2 and no container starts. A TENANT_SECRETS_DIR in
# the process environment that differs from the env file is refused: compose prefers the
# environment, and the directory checked here would not be the one that is mounted.
_cd_leaf_precheck_dirs() {
    local envf="$1" root ts
    root="$(_cd_leaf_root)"
    _cd_leaf_owned_dir "${root}/etc/secrets/governance" 700 \
        || { _cd_leaf_fail secrets_dir 2 "etc/secrets/governance must exist as a 0700 directory of the deploy user"; return 2; }
    ts="$(cd_kv_get "$envf" TENANT_SECRETS_DIR 2>/dev/null)" || ts=''
    if [[ -z "$ts" || "$ts" != /* || "$ts" == *'$'* ]]; then
        _cd_leaf_fail secrets_dir 2 "the target env file does not give TENANT_SECRETS_DIR as one absolute path"
        return 2
    fi
    if [[ -n "${TENANT_SECRETS_DIR:-}" && "${TENANT_SECRETS_DIR}" != "$ts" ]]; then
        _cd_leaf_fail secrets_dir 2 "TENANT_SECRETS_DIR in the environment differs from the target env file"
        return 2
    fi
    _cd_leaf_owned_dir "$ts" 700 \
        || { _cd_leaf_fail secrets_dir 2 "TENANT_SECRETS_DIR must exist as a 0700 directory of the deploy user"; return 2; }
    return 0
}

# _cd_leaf_policy_skips - 0 when the step is skipped: the policy `migration` and no chain of a
# leaf (module-calendar, module-content, module-publishing) gained a file in the release
# record's class. With the policy `always` the step runs. A policy `migration` with no
# readable class is code 2, never a skip.
_cd_leaf_policy_skips() {
    local policy n
    policy="$(cd_cfg CD_DUMP_POLICY 2>/dev/null)" || policy=''
    case "$policy" in
        always) return 1 ;;
        migration)
            n="$(cd_state_get 'if (.release.class.migrations.chains | type) == "object" then [ .release.class.migrations.chains | to_entries[] | select('"$_CD_LEAF_CHAINS_JQ"') | select(((.value.expand // 0) + (.value.migrate // 0) + (.value.contract // 0)) > 0) ] | length else "none" end' 2>/dev/null)" || n=''
            if [[ ! "$n" =~ ^[0-9]+$ ]]; then
                _cd_leaf_fail class_missing 2 "the policy is migration and the release record has no readable class"
                return 2
            fi
            [[ "$n" -eq 0 ]] && return 0
            return 1
            ;;
        *)
            _cd_leaf_fail policy 2 "CD_DUMP_POLICY is not readable"
            return 2
            ;;
    esac
}

# _cd_leaf_psql CID ROLE DB SQL ERRLOG - one psql call through docker exec: no stdin, a time
# limit, the server's own complaints into ERRLOG (a 0600 file). Prints the rows (unaligned,
# tuples only) without carriage returns.
_cd_leaf_psql() {
    local cid="$1" role="$2" db="$3" sql="$4" errlog="$5" out
    out="$(timeout -k 5 "$(_cd_leaf_limit)" docker exec "$cid" psql -X -U "$role" -d "$db" -v ON_ERROR_STOP=1 -Atq -c "$sql" </dev/null 2>>"$errlog")" || return 1
    printf '%s' "${out//$'\r'/}"
}

# _cd_leaf_dump_read TAG ERRLOG - read `status` of the label into _CD_LEAF_LIVE. The answer is
# read into a variable (its lines carry the names) and parsed token by token; its trailer must
# agree with the lines, and a line that is none of the two known shapes is refused.
_cd_leaf_dump_read() {
    local tag="$1" errlog="$2" prog out line rel db count=0 trailer=''
    prog="$(_cd_leaf_root)/bin/gremion-migration-dump"
    if [[ ! -x "$prog" ]]; then
        _cd_leaf_fail dump_program 2 "gremion-migration-dump is not installed"
        return 2
    fi
    out="$(timeout -k 5 "$(_cd_leaf_limit)" "$prog" status --release "$tag" 2>>"$errlog" </dev/null)" || {
        _cd_leaf_fail dump_status_failed 2 "the dump ledger could not be read; output in logs/${errlog##*/}"
        return 2
    }
    while IFS= read -r line; do
        line="${line%$'\r'}"
        [[ -n "$line" ]] || continue
        if [[ -n "$trailer" ]]; then
            _cd_leaf_fail dump_status_unparsed 2 "the dump ledger answer has lines after its trailer"
            return 2
        fi
        if [[ "$line" =~ ^LIVE\ [^\ ]+\ release=([^\ ]+)\ db=([^\ ]+)\  ]]; then
            rel="${BASH_REMATCH[1]}"
            db="${BASH_REMATCH[2]}"
            if [[ "$rel" == "$tag" ]]; then
                _CD_LEAF_LIVE["$db"]=1
                count=$((count + 1))
            fi
        elif [[ "$line" =~ ^STATUS:\ ([0-9]+)\ live\ dump\(s\)$ ]]; then
            trailer="${BASH_REMATCH[1]}"
        else
            _cd_leaf_fail dump_status_unparsed 2 "the dump ledger answer has a line of an unknown shape"
            return 2
        fi
    done <<<"$out"
    if [[ -z "$trailer" || "$trailer" -ne "$count" ]]; then
        _cd_leaf_fail dump_status_unparsed 2 "the dump ledger answer is truncated or does not add up"
        return 2
    fi
    return 0
}

# _cd_leaf_dump_check TAG ERRLOG - for every service of the run: the leaf server must be
# running, and every database it holds that the entry would open (every non-template database
# except `postgres` and except a gate database, which the module step handles) must have a live
# ledger line of this release label. The role is <SERVER>_PG_USER of state.env, read by name
# and never printed: a missing key is code 2, never a default. One database without a line is
# code 2 and nothing is run. Every service is checked before the first container starts.
_cd_leaf_dump_check() {
    local tag="$1" errlog="$2" svc server statef up cid role out name missing=0 seen=0
    _cd_leaf_dump_read "$tag" "$errlog" || return $?
    statef="$(cd_envfile state)" || { _cd_leaf_fail no_state_env 2 "no state env file"; return 2; }
    for svc in "${_CD_LEAF_RUN[@]}"; do
        server="${_CD_LEAF_SERVER_OF[$svc]:-}"
        [[ -n "$server" ]] || { _cd_leaf_fail leaf_unknown 2 "a leaf service has no database server in the fixed list"; return 2; }
        up="${server%-postgres}"
        up="${up^^}"
        role="$(cd_kv_get "$statef" "${up}_PG_USER" 2>/dev/null)" || role=''
        if [[ -z "$role" ]]; then
            _cd_leaf_fail no_pg_user 2 "state.env does not give the role of a leaf server"
            return 2
        fi
        cid="$(cd_svc_cid state "$server" 2>/dev/null)" || {
            _cd_leaf_fail leaf_server 2 "docker did not answer for a leaf server"
            return 2
        }
        if [[ -z "$cid" ]]; then
            _cd_leaf_fail leaf_server_down 2 "the database server of a leaf service of the target colour is not running"
            return 2
        fi
        out="$(_cd_leaf_psql "$cid" "$role" postgres "$_CD_LEAF_SQL_SERVER" "$errlog")" || {
            _cd_leaf_fail server_listing_failed 2 "a leaf server could not be listed; output in logs/${errlog##*/}"
            return 2
        }
        while IFS= read -r name; do
            [[ -n "$name" ]] || continue
            if [[ ! "$name" =~ $_CD_LEAF_RE_DB ]]; then
                _cd_leaf_fail server_listing_failed 2 "a leaf server lists a database with an odd name"
                return 2
            fi
            [[ "$name" =~ $_CD_LEAF_RE_GATE ]] && continue
            seen=$((seen + 1))
            [[ -n "${_CD_LEAF_LIVE[$name]+set}" ]] || missing=$((missing + 1))
        done <<<"$out"
    done
    if [[ "$missing" -gt 0 ]]; then
        _cd_leaf_fail dump_missing 2 "${missing} of ${seen} leaf database(s) have no live dump of ${tag}"
        return 2
    fi
    return 0
}

# -- the container, and the label that finds it ------------------------------------------------

# _cd_leaf_labelled LABELID - the ids of every container (running or stopped: `ps -a`) that
# carries the label gremion.cd=<release id>, one per line. 1 when docker did not answer, which
# is never read as "none".
_cd_leaf_labelled() {
    local out id
    out="$(timeout -k 5 "$(_cd_leaf_limit)" docker ps -a -q --filter "label=gremion.cd=${1}" </dev/null 2>/dev/null)" || return 1
    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || return 1
        printf '%s\n' "$id"
    done <<<"$out"
    return 0
}

# _cd_leaf_reap LABELID - kill and remove every container of the label and poll `docker ps -a`
# until two answers in a row are empty (a stopped container counts: a killed one that is not
# auto-removed would otherwise be left behind), for at most CD_LEAVES_CONFIRM_S seconds (60).
# 0 when confirmed gone, 1 when not. An unanswered `docker ps` is no empty answer. It returns
# no earlier than that.
_cd_leaf_reap() {
    local rid="$1" deadline empties=0 ids
    local -a arr=()
    deadline=$(($(_cd_leaf_now) + $(_cd_leaf_int "${CD_LEAVES_CONFIRM_S:-}" 60)))
    while :; do
        if ids="$(_cd_leaf_labelled "$rid")"; then
            if [[ -z "$ids" ]]; then
                empties=$((empties + 1))
                [[ "$empties" -ge 2 ]] && return 0
            else
                empties=0
                mapfile -t arr <<<"$ids"
                timeout -k 5 "$(_cd_leaf_limit)" docker kill "${arr[@]}" </dev/null >/dev/null 2>&1 || true
                timeout -k 5 "$(_cd_leaf_limit)" docker rm -f "${arr[@]}" </dev/null >/dev/null 2>&1 || true
            fi
        else
            empties=0
        fi
        [[ "$(_cd_leaf_now)" -lt "$deadline" ]] || return 1
        _cd_leaf_sleep 1
    done
}

# _cd_leaf_clear RID TAG COLOUR - no container of this release may be left: 0 when none is (or
# after a reap that confirmed it), else the container-alive answer (code 2, a mail).
_cd_leaf_clear() {
    local rid="$1" tag="$2" colour="$3" ids
    if ! ids="$(_cd_leaf_labelled "$rid")" || [[ -n "$ids" ]]; then
        if ! _cd_leaf_reap "$rid"; then
            _cd_leaf_alive "$tag" "$colour"
            return 2
        fi
    fi
    return 0
}

# _cd_leaf_alive TAG COLOUR - a labelled container could not be confirmed gone: code 2, the
# reason that tells the driver to skip the teardown and the retag restore, and a mail (kind
# `stopped`).
_cd_leaf_alive() {
    local tag="$1" colour="$2"
    CD_LEAVES_REASON=leaf_container_alive
    _cd_leaf_err "a container of the leaf step could not be confirmed gone"
    if declare -F cd_hist >/dev/null 2>&1; then cd_hist leaves_container_alive >/dev/null 2>&1 || true; fi
    if declare -F cd_notify >/dev/null 2>&1; then
        cd_notify stopped "tag=${tag}" "colour=${colour}" "sha12=${tag#pilot-}" stage=migrate reason=leaf_container_alive >/dev/null 2>&1 || true
    fi
    return 2
}

# -- the answer of the entry --------------------------------------------------------------------

# _cd_leaf_json OUTFILE - the one JSON line the entry prints on stdout, reduced to its four
# counts. Exactly one line that starts with { must exist, its version must be 1 and its four
# keys must be whole non-negative numbers; anything else is no valid line (rc 1). Prints the
# reduced object. The shape only: an entry that stops at its first failing database prints a
# line whose outcomes fall short of the total, and that is a real failure of the commit; only
# an exit 0 must add up (checked by the caller).
_cd_leaf_json() {
    local f="$1" n line obj
    n="$(grep -c '^[[:space:]]*{' "$f" 2>/dev/null)" || n=0
    [[ "$n" -eq 1 ]] || return 1
    line="$(grep '^[[:space:]]*{' "$f" 2>/dev/null)" || return 1
    obj="$(printf '%s' "$line" | jq -c 'select(type == "object" and .v == 1) | {total, migrated, skipped, failed} | select(all(.[]; type == "number" and . >= 0 and . == floor and . < 1000000000))' 2>/dev/null)" || return 1
    [[ -n "$obj" ]] || return 1
    printf '%s' "$obj"
}

# _cd_leaf_add JSON - add the four counts of one service to the run's sum.
_cd_leaf_add() {
    local row t m s f
    row="$(printf '%s' "$1" | jq -r '[.total, .migrated, .skipped, .failed] | @tsv' 2>/dev/null)" || return 1
    IFS=$'\t' read -r t m s f <<<"$row" || return 1
    [[ "$t" =~ ^[0-9]+$ && "$m" =~ ^[0-9]+$ && "$s" =~ ^[0-9]+$ && "$f" =~ ^[0-9]+$ ]] || return 1
    _CD_LEAF_SUM_TOTAL=$((_CD_LEAF_SUM_TOTAL + t))
    _CD_LEAF_SUM_MIGRATED=$((_CD_LEAF_SUM_MIGRATED + m))
    _CD_LEAF_SUM_SKIPPED=$((_CD_LEAF_SUM_SKIPPED + s))
    _CD_LEAF_SUM_FAILED=$((_CD_LEAF_SUM_FAILED + f))
}

# _cd_leaf_record - release.leaves in the state, from the sum so far.
_cd_leaf_record() {
    local obj
    obj="$(jq -nc --argjson t "$_CD_LEAF_SUM_TOTAL" --argjson m "$_CD_LEAF_SUM_MIGRATED" --argjson s "$_CD_LEAF_SUM_SKIPPED" --argjson f "$_CD_LEAF_SUM_FAILED" '{total: $t, migrated: $m, skipped: $s, failed: $f}')" \
        || { _cd_leaf_fail state_write 2 "the leaf counts could not be built"; return 2; }
    cd_state_set '.release.leaves = $m' --argjson m "$obj" \
        || { _cd_leaf_fail state_write 2 "the leaf counts could not be written to the state"; return 2; }
}

# -- the step -----------------------------------------------------------------------------------------

# cd_leaves_migrate TREE COLOUR TAG - see the head of the file. A run that succeeds removes the
# log files that stayed empty; a run that fails keeps every one of them.
cd_leaves_migrate() {
    local rc=0
    _cd_leaf_migrate "$@" || rc=$?
    if [[ "$rc" -eq 0 ]]; then _cd_leaf_tidy; fi
    return "$rc"
}

# _cd_leaf_run_one TREE COLOUR TAG RID SERVICE TMO - one container for one leaf service, the
# whole mapping of its answer. 0 when the service is done and counted; else the code of the
# step (the reason is set). The sum is updated and written whenever the entry gave a valid line.
_cd_leaf_run_one() {
    local tree="$1" colour="$2" tag="$3" rid="$4" svc="$5" tmo="$6"
    local outf runerr start rc=0 json
    _cd_leaf_logfile "out-${svc%-service}" || return 2
    outf="$_CD_LEAF_LOG"
    _cd_leaf_logfile "run-${svc%-service}" || return 2
    runerr="$_CD_LEAF_LOG"
    start="$(_cd_leaf_now)"
    (
        CD_DC_TIMEOUT="$tmo" cd_dc "$tree" "app-${colour}" run --rm --no-deps -T --label "gremion.cd=${rid}" "$svc" node dist/index.js --migrate-only
    ) >"$outf" 2>"$runerr" </dev/null || rc=$?

    # a timeout ends the docker client, not the container: kill by the label, remove by
    # the label, and return only when `docker ps -a` has twice answered empty
    if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
        cd_hist leaves_timeout "seconds=$(($(_cd_leaf_now) - start))" >/dev/null 2>&1 || true
        if ! _cd_leaf_reap "$rid"; then
            _cd_leaf_alive "$tag" "$colour"
            return 2
        fi
        _cd_leaf_fail leaf_timeout 2 "the leaf step ran out of time (${tmo}s); the container is gone"
        return 2
    fi
    # after any other end, a created-but-never-started container must not stay either
    _cd_leaf_clear "$rid" "$tag" "$colour" || return 2

    json="$(_cd_leaf_json "$outf")" || json=''
    case "$rc" in
        0)
            if [[ -z "$json" ]] || ! printf '%s' "$json" | jq -e '.failed == 0 and (.migrated + .skipped + .failed) == .total' >/dev/null 2>&1; then
                _cd_leaf_fail leaf_result_invalid 1 "the leaf step exited 0 without a valid count line; output in logs/${outf##*/}"
                return 1
            fi
            _cd_leaf_add "$json" || { _cd_leaf_fail leaf_result_invalid 1 "the leaf step's count line cannot be added up"; return 1; }
            _cd_leaf_record || return $?
            return 0
            ;;
        1)
            if [[ -z "$json" ]]; then
                _cd_leaf_fail leaf_run_failed 4 "the leaf step failed before its own answer (exit 1); output in logs/${runerr##*/}"
                return 4
            fi
            _cd_leaf_add "$json" || true
            _cd_leaf_record || return $?
            _cd_leaf_fail leaf_migrate 1 "the leaf step failed on a migration file; output in logs/${runerr##*/}"
            return 1
            ;;
        2)
            _cd_leaf_fail leaf_usage 2 "the leaf step refused its arguments or a precondition (exit 2); output in logs/${runerr##*/}"
            return 2
            ;;
        3)
            if [[ -n "$json" ]]; then
                _cd_leaf_add "$json" || true
                _cd_leaf_record || return $?
            fi
            _cd_leaf_fail leaf_infra 4 "the leaf step could not reach a server (exit 3); output in logs/${runerr##*/}"
            return 4
            ;;
        *)
            _cd_leaf_fail leaf_run_failed 4 "the leaf step could not run (exit ${rc}); output in logs/${runerr##*/}"
            return 4
            ;;
    esac
}

_cd_leaf_migrate() {
    local tree="${1:-}" colour="${2:-}" tag="${3:-}" rid rtag rcol envf pol svc tmo errlog rc=0
    [[ "$#" -eq 3 ]] || { _cd_leaf_fail usage 2 "usage: TREE COLOUR TAG"; return 2; }
    _cd_leaf_reset
    [[ -d "$tree" && -x "$tree" ]] || { _cd_leaf_fail usage 2 "no release tree directory that can be entered"; return 2; }
    case "$colour" in blue | green) ;; *) _cd_leaf_fail usage 2 "the colour is blue or green"; return 2 ;; esac
    [[ "$tag" =~ ^pilot-[0-9a-f]{12}$ ]] || { _cd_leaf_fail usage 2 "the tag is pilot-<12 hex>"; return 2; }
    rid="$(cd_state_get '.release.id // empty')" || rid=''
    rtag="$(cd_state_get '.release.tag // empty')" || rtag=''
    rcol="$(cd_state_get '.release.colour // empty')" || rcol=''
    if [[ ! "$rid" =~ ^[0-9a-f]{12}-[0-9]+$ ]]; then
        _cd_leaf_fail no_release 2 "the state holds no release record"
        return 2
    fi
    if [[ "$rtag" != "$tag" || "$rcol" != "$colour" ]]; then
        _cd_leaf_fail release_mismatch 2 "the release record names another tag or colour"
        return 2
    fi
    # the policy first: a skipped step touches nothing, not even docker
    pol=0
    _cd_leaf_policy_skips || pol=$?
    case "$pol" in
        0)
            cd_hist leaves_skipped reason=policy >/dev/null 2>&1 || true
            return 0
            ;;
        2) return 2 ;;
        *) ;;
    esac
    envf="$(cd_envfile "app-${colour}")" || { _cd_leaf_fail usage 2 "no env file for the target colour"; return 2; }
    [[ -f "$envf" && -r "$envf" ]] || { _cd_leaf_fail usage 2 "the target colour's env file is not readable"; return 2; }

    # the leaf services of the target colour, then every precondition for all of them, and only
    # then the first container
    _cd_leaf_services "$tree" "$colour" || return $?
    if [[ "${#_CD_LEAF_RUN[@]}" -eq 0 ]]; then
        # no leaf profile is on: nothing to migrate, and the listing above is what makes that
        # trustworthy
        _cd_leaf_record || return $?
        cd_hist leaves_done total=0 >/dev/null 2>&1 || true
        return 0
    fi
    _cd_leaf_precheck_dirs "$envf" || return $?
    _cd_leaf_logfile query || return 2
    errlog="$_CD_LEAF_LOG"
    _cd_leaf_dump_check "$tag" "$errlog" || return $?

    # a container of an earlier try of this release must be gone before the next one starts
    _cd_leaf_clear "$rid" "$tag" "$colour" || return 2

    tmo="$(_cd_leaf_int "$(cd_cfg CD_LEAF_MIGRATE_TIMEOUT_S 2>/dev/null)" 600)"
    for svc in "${_CD_LEAF_RUN[@]}"; do
        _cd_leaf_run_one "$tree" "$colour" "$tag" "$rid" "$svc" "$tmo" || { rc=$?; return "$rc"; }
    done
    cd_hist leaves_done "total=${_CD_LEAF_SUM_TOTAL}" "migrated=${_CD_LEAF_SUM_MIGRATED}" "services=${#_CD_LEAF_RUN[@]}" >/dev/null 2>&1 || true
    return 0
}
