#!/usr/bin/env bash
# infra/host/lib/cd/reconcile.sh - the reconcile stage of the continuous deployment program:
# after the commit point, once per customer, `gremion-tenant reconcile <slug> --apply --reason
# <text>` run by CD itself, with a canary customer first and a probe of the public edge after
# every customer.
#
# SOURCED, NEVER EXECUTED. Like leaves.sh it does not set shell options: the program that
# sources it owns them. It calls core.sh (cd_cfg, cd_now, cd_iso, cd_sleep, cd_hist,
# cd_state_get, cd_state_set, cd_hold_set, cd_require_lock, cd_hostlock_take,
# cd_hostlock_release, cd_killswitch_active, CD_ROOT, CD_REQUEST_DIR), docker.sh (cd_envfile,
# cd_kv_get, cd_svc_cid), data.sh (cd_data_timer_guard, cd_data_kernel_db_ids), watch.sh
# (cd_watch_probe_public) and notify.sh (cd_notify), all resolved at call time, and docker,
# jq, timeout and coreutils. It uses a prefix of its own (_cd_rec_) and calls nothing private
# of another library.
#
#   cd_reconcile_customers ARRAYNAME   fill a caller array with the customer slugs the stage
#                                      will reconcile, the canary first and the rest sorted;
#                                      prints nothing. 0 ok, 2 the listing cannot be trusted
#                                      (fail closed: CD_RECONCILE_REASON is `unknown`).
#                                      Sets CD_RECONCILE_INVALID (rows that broke the slug
#                                      rule and were left out) and CD_RECONCILE_CANARY (1 when
#                                      the first slug is the canary).
#   cd_reconcile_run                   the stage. 0 every customer is ok; 1 anything else; 2 a
#                                      precondition. It runs under the cd lock the caller holds
#                                      and takes the host lock itself, per customer. It writes
#                                      live.reconcile, queues the mail and, when something is
#                                      not ok, sets the hold `reconcile_failed`.
#
# THE LINE. The release is committed when this stage runs. Nothing here rolls it back, blocks a
# commit, calls cd_rollback_run or cd_block_add, or touches `current`, `live`'s release fields,
# the env files, the image tags or runtime/active-colour; the stage only reads them. The one
# state it writes is live.reconcile and the hold.
#
# THE REAL-DATA BOUNDARY. The slugs are read from the registry into bash variables of this
# process and go nowhere else: not the state file, not a history line, not a mail, not stdout,
# not stderr, not the journal, and not the argv of any command of CD's own (the child's argv
# carries one, because the verb needs it, and nothing else does; every query goes to psql on
# stdin). What the child and psql say goes to one 0600 file under logs/ and only a count is ever
# said about it.

# The reason that the verb writes into the access record the council administrator reads: one
# constant, 10 to 500 characters, the release tag (public) and no slug. %s is the tag.
# shellcheck disable=SC2034,SC2016  # read by the tests and the child call; the jq program is single-quoted on purpose
CD_RECONCILE_REASON_FMT='Automatischer Abgleich nach dem Release %s (gremion-cd)'

# What the last run ended with: a reason code (failed, timeout, busy, precondition, budget,
# rollback_request, killswitch, timer_guard, canary, probe, container_alive, unknown) or empty.
# shellcheck disable=SC2034  # read by the tests and the callers
CD_RECONCILE_REASON=''
# shellcheck disable=SC2034
CD_RECONCILE_INVALID=0
# shellcheck disable=SC2034
CD_RECONCILE_CANARY=0

# The five statuses the control database knows; the three that a customer can be reconciled in
# or must still be looked after in.
_CD_REC_STATUSES=' provisioning active suspended deleting deleted '
_CD_REC_LIVE_STATUSES=' provisioning active suspended '
# The verb's own slug rule (3 to 30 characters is checked beside it), and a host name.
_CD_REC_RE_SLUG='^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
_CD_REC_RE_HOST='^[a-z0-9.-]{1,253}$'
_CD_REC_RE_UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# The queries. They hold no value; the canary query's one value (the probe host) is added to
# the text that goes to psql on stdin.
_CD_REC_SQL_LIST="select slug from tenant where status in ('active','suspended') order by slug;"
_CD_REC_SQL_STATUS='select status, count(*) from tenant group by status order by status;'
_CD_REC_SQL_IDS="select replace(id::text, '-', ''), status from tenant order by 1;"

# What one run holds, all in the process. Reset at the start of every run.
_CD_REC_LOG=''
_CD_REC_CID=''
_CD_REC_ROLE=''
_CD_REC_DB=''
_CD_REC_T0=0
declare -gA _CD_REC_N=()      # ok failed timeout busy skipped invalid
_CD_REC_CHILD_RC=0
_CD_REC_ALIVE=0

_cd_rec_err() { printf 'cd-reconcile: %s\n' "$*" >&2; }

_cd_rec_root() { printf '%s' "${GREMION_ROOT:-/opt/gremion}"; }

_cd_rec_int() {
    if [[ "${1:-}" =~ ^[0-9]{1,9}$ ]] && ((10#$1 >= 1)); then
        printf '%s' "$((10#$1))"
    else
        printf '%s' "$2"
    fi
}

# _cd_rec_limit - the seconds one docker or psql call of this library may take.
_cd_rec_limit() { _cd_rec_int "${CD_RECONCILE_DOCKER_LIMIT:-}" 60; }

_cd_rec_reset() {
    CD_RECONCILE_REASON=''
    CD_RECONCILE_INVALID=0
    CD_RECONCILE_CANARY=0
    _CD_REC_LOG=''
    _CD_REC_CID=''
    _CD_REC_ROLE=''
    _CD_REC_DB=''
    _CD_REC_T0=0
    _CD_REC_N=([ok]=0 [failed]=0 [timeout]=0 [busy]=0 [skipped]=0 [invalid]=0)
    _CD_REC_CHILD_RC=0
    _CD_REC_ALIVE=0
}

# _cd_rec_logfile - the one 0600 file of this run under logs/ (psql's complaints, the
# children's output). Its path stays in _CD_REC_LOG; only the file NAME is ever said.
_cd_rec_logfile() {
    local dir f
    dir="$(_cd_rec_root)/logs"
    mkdir -p -- "$dir" 2>/dev/null || true
    f="${dir}/cd-reconcile-$(cd_now)-${RANDOM}${RANDOM}.log"
    (umask 077; : >"$f") 2>/dev/null || {
        _cd_rec_err "cannot create a log file under logs/"
        return 2
    }
    _CD_REC_LOG="$f"
}

# _cd_rec_tidy - an empty log is removed; one with output stays (it names customers).
_cd_rec_tidy() {
    if [[ -n "$_CD_REC_LOG" && -e "$_CD_REC_LOG" && ! -s "$_CD_REC_LOG" ]]; then
        rm -f -- "$_CD_REC_LOG"
    fi
    return 0
}

# _cd_rec_slug_ok SLUG - the verb's rule: its pattern, 3 to 30 characters, not `platform`.
_cd_rec_slug_ok() {
    local s="${1:-}"
    [[ "$s" =~ $_CD_REC_RE_SLUG ]] || return 1
    ((${#s} >= 3 && ${#s} <= 30)) || return 1
    [[ "$s" != platform ]]
}

# -- the registry ---------------------------------------------------------------------------

# _cd_rec_connect - the running postgres of the state project and the role and database of the
# control registry, from state.env. 0, or 2 (fail closed) with the reason left in
# CD_RECONCILE_REASON.
_cd_rec_connect() {
    local f
    f="$(cd_envfile state 2>/dev/null)" || { _cd_rec_err "no state.env"; CD_RECONCILE_REASON=unknown; return 2; }
    _CD_REC_ROLE="$(cd_kv_get "$f" POSTGRES_USER 2>/dev/null)" || _CD_REC_ROLE=''
    _CD_REC_DB="$(cd_kv_get "$f" CONTROL_DB_NAME 2>/dev/null)" || _CD_REC_DB=''
    if [[ ! "$_CD_REC_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ || ! "$_CD_REC_DB" =~ ^[A-Za-z0-9_]{1,63}$ ]]; then
        _cd_rec_err "state.env does not give POSTGRES_USER and CONTROL_DB_NAME"
        CD_RECONCILE_REASON=unknown
        return 2
    fi
    _CD_REC_CID="$(cd_svc_cid state postgres 2>/dev/null </dev/null)" || _CD_REC_CID=''
    if [[ ! "$_CD_REC_CID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
        _cd_rec_err "the state project's postgres is not running (or docker does not answer)"
        _CD_REC_CID=''
        CD_RECONCILE_REASON=unknown
        return 2
    fi
    return 0
}

# _cd_rec_psql SQL - one query on psql's STDIN (never an argv), bounded; the rows, unaligned,
# without carriage returns. psql's own complaints go to the log file.
_cd_rec_psql() {
    local out err="${_CD_REC_LOG:-/dev/null}"
    out="$(printf '%s\n' "$1" | timeout -k 5 "$(_cd_rec_limit)" docker exec -i "$_CD_REC_CID" psql -X -U "$_CD_REC_ROLE" -d "$_CD_REC_DB" -Atq -v ON_ERROR_STOP=1 -f - 2>>"$err")" || return 1
    printf '%s' "${out//$'\r'/}"
}

# _cd_rec_probe_host - CD_PROBE_HOST, else the first host of etc/tenant-hosts.txt that is no
# comment (the rule of the start gate and of the probe). Prints it; 2 when there is none.
_cd_rec_probe_host() {
    local h f line
    h="$(cd_cfg CD_PROBE_HOST 2>/dev/null)" || h=''
    if [[ -z "$h" ]]; then
        f="$(_cd_rec_root)/etc/tenant-hosts.txt"
        if [[ -r "$f" ]]; then
            while IFS= read -r line || [[ -n "$line" ]]; do
                line="${line%$'\r'}"
                line="${line#"${line%%[![:space:]]*}"}"
                [[ -z "$line" || "$line" == \#* ]] && continue
                h="${line%%[[:space:]]*}"
                break
            done <"$f"
        fi
    fi
    [[ "$h" =~ $_CD_REC_RE_HOST ]] || return 2
    printf '%s' "$h"
}

# _cd_rec_fresh_install - the zero-row listing is accepted only as an install with no customer:
# the status counts show no provisioning, active or suspended row and no status of the five
# unknown ones, and every t_<hex32>__kernel database of the main server has a registry row of
# status deleting or deleted. 0 accepted, 2 not (unknown is not "no customers").
_cd_rec_fresh_install() {
    local out line st n id
    local -A rowstatus=()
    local -a kernels=()
    out="$(_cd_rec_psql "$_CD_REC_SQL_STATUS")" || { _cd_rec_err "the status count failed; output in logs/${_CD_REC_LOG##*/}"; return 2; }
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        [[ "$line" == *'|'* ]] || { _cd_rec_err "a status count row is not a status and a number"; return 2; }
        st="${line%%|*}"
        n="${line#*|}"
        [[ "$n" =~ ^[0-9]{1,9}$ ]] || { _cd_rec_err "a status count is not a number"; return 2; }
        if [[ "$_CD_REC_STATUSES" != *" ${st} "* ]]; then
            _cd_rec_err "the registry has a status the program does not know"
            return 2
        fi
        if [[ "$_CD_REC_LIVE_STATUSES" == *" ${st} "* ]] && ((10#$n > 0)); then
            _cd_rec_err "an empty customer listing, but the registry counts customers that are not deleted"
            return 2
        fi
    done <<<"$out"
    out="$(_cd_rec_psql "$_CD_REC_SQL_IDS")" || { _cd_rec_err "the registry id listing failed; output in logs/${_CD_REC_LOG##*/}"; return 2; }
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        [[ "$line" == *'|'* ]] || { _cd_rec_err "a registry id row is not an id and a status"; return 2; }
        id="${line%%|*}"
        st="${line#*|}"
        [[ "$id" =~ ^[0-9a-f]{32}$ && "$_CD_REC_STATUSES" == *" ${st} "* ]] || { _cd_rec_err "a registry id row does not parse"; return 2; }
        rowstatus["$id"]="$st"
    done <<<"$out"
    cd_data_kernel_db_ids kernels >/dev/null 2>&1 || { _cd_rec_err "the kernel databases of the main server cannot be listed"; return 2; }
    for id in "${kernels[@]+"${kernels[@]}"}"; do
        st="${rowstatus[$id]:-}"
        if [[ "$st" != deleting && "$st" != deleted ]]; then
            _cd_rec_err "a customer database has no registry row that is deleting or deleted"
            return 2
        fi
    done
    return 0
}

# _cd_rec_canary - the slug of the active customer that owns the probe host, one line, or
# nothing (no canary). 0 answered (empty or one slug), 2 the question could not be asked.
# The host goes on psql's stdin, never on an argv.
_cd_rec_canary() {
    local host out
    host="$(_cd_rec_probe_host)" || return 0
    out="$(_cd_rec_psql "select t.slug from tenant t join tenant_domain d on d.tenant_id = t.id where d.host = '${host}' and t.status = 'active';")" || return 2
    printf '%s' "$out"
}

# cd_reconcile_customers ARRAYNAME - see the header.
cd_reconcile_customers() {
    local _cd_arg="${1:-}" _cd_out _cd_line _cd_canary _cd_n _cd_s
    local -a _cd_valid=() _cd_sorted=() _cd_final=() _cd_cl=()
    if [[ ! "$_cd_arg" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || "$_cd_arg" == _cd_* ]]; then
        _cd_rec_err "cd_reconcile_customers: not an array name"
        return 2
    fi
    local -n _cd_dest="$_cd_arg"
    _cd_dest=()
    CD_RECONCILE_INVALID=0
    CD_RECONCILE_CANARY=0
    CD_RECONCILE_REASON=''
    if [[ -z "$_CD_REC_CID" ]]; then
        _cd_rec_connect || return 2
    fi
    if [[ -z "$_CD_REC_LOG" ]]; then
        _cd_rec_logfile || { CD_RECONCILE_REASON=unknown; return 2; }
    fi
    if ! _cd_out="$(_cd_rec_psql "$_CD_REC_SQL_LIST")"; then
        _cd_rec_err "the customer listing failed; output in logs/${_CD_REC_LOG##*/}"
        CD_RECONCILE_REASON=unknown
        return 2
    fi
    while IFS= read -r _cd_line; do
        [[ -n "$_cd_line" ]] || continue
        if _cd_rec_slug_ok "$_cd_line"; then
            _cd_valid+=("$_cd_line")
        else
            CD_RECONCILE_INVALID=$((CD_RECONCILE_INVALID + 1))
        fi
    done <<<"$_cd_out"
    if ((${#_cd_valid[@]} + CD_RECONCILE_INVALID == 0)); then
        if ! _cd_rec_fresh_install; then
            CD_RECONCILE_REASON=unknown
            return 2
        fi
        return 0
    fi
    if ((${#_cd_valid[@]} > 0)); then
        mapfile -t _cd_sorted < <(printf '%s\n' "${_cd_valid[@]}" | LC_ALL=C sort -u)
    fi
    # the canary: the customer that owns the probe host goes first
    if ! _cd_canary="$(_cd_rec_canary)"; then
        _cd_rec_err "the canary question failed; output in logs/${_CD_REC_LOG##*/}"
        CD_RECONCILE_REASON=unknown
        return 2
    fi
    mapfile -t _cd_cl <<<"$_cd_canary"
    _cd_final=("${_cd_sorted[@]+"${_cd_sorted[@]}"}")
    if ((${#_cd_cl[@]} == 1)) && _cd_rec_slug_ok "${_cd_cl[0]}"; then
        for _cd_s in "${_cd_sorted[@]+"${_cd_sorted[@]}"}"; do
            if [[ "$_cd_s" == "${_cd_cl[0]}" ]]; then
                _cd_final=("$_cd_s")
                for _cd_n in "${_cd_sorted[@]}"; do
                    [[ "$_cd_n" == "$_cd_s" ]] || _cd_final+=("$_cd_n")
                done
                CD_RECONCILE_CANARY=1
                break
            fi
        done
    fi
    _cd_dest=("${_cd_final[@]+"${_cd_final[@]}"}")
    return 0
}

# -- one child -------------------------------------------------------------------------------

# _cd_rec_uuid - a fresh lower-case UUID.
_cd_rec_uuid() {
    local u=''
    if [[ -r /proc/sys/kernel/random/uuid ]]; then
        read -r u </proc/sys/kernel/random/uuid || u=''
    fi
    if [[ ! "$u" =~ $_CD_REC_RE_UUID ]] && command -v uuidgen >/dev/null 2>&1; then
        u="$(uuidgen 2>/dev/null | tr 'A-F' 'a-f')" || u=''
    fi
    if [[ ! "$u" =~ $_CD_REC_RE_UUID ]]; then
        u="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')" || u=''
        u="${u:0:8}-${u:8:4}-4${u:13:3}-8${u:17:3}-${u:20:12}"
    fi
    [[ "$u" =~ $_CD_REC_RE_UUID ]] || return 1
    printf '%s' "$u"
}

# _cd_rec_gone UUID - kill every container that carries gremion.request=<UUID> and poll
# `docker ps` until it finds none twice in a row, 0.5 seconds apart, for at most 30 seconds
# (the executor's own rule). 0 confirmed gone, 1 not. An answer that fails is no empty answer.
# `timeout` ends the compose client and not the container, so this runs after every child.
_cd_rec_gone() {
    local uuid="$1" ids empty=0 polls=0 deadline killed=''
    local -a arr=()
    deadline=$(($(cd_now) + 30))
    while :; do
        if ids="$(timeout -k 5 "$(_cd_rec_limit)" docker ps -q --filter "label=gremion.request=${uuid}" </dev/null 2>/dev/null)"; then
            ids="${ids//$'\r'/}"
            if [[ -z "${ids//[[:space:]]/}" ]]; then
                empty=$((empty + 1))
                if ((empty >= 2)); then
                    if [[ -n "$killed" ]]; then
                        # a killed container the client no longer removes is left stopped: remove it
                        mapfile -t arr < <(timeout -k 5 "$(_cd_rec_limit)" docker ps -a -q --filter "label=gremion.request=${uuid}" </dev/null 2>/dev/null)
                        if ((${#arr[@]} > 0)); then
                            timeout -k 5 "$(_cd_rec_limit)" docker rm -f "${arr[@]}" </dev/null >/dev/null 2>&1 || true
                        fi
                    fi
                    return 0
                fi
            else
                empty=0
                mapfile -t arr <<<"$ids"
                timeout -k 5 "$(_cd_rec_limit)" docker kill "${arr[@]}" </dev/null >/dev/null 2>&1 || true
                killed=1
            fi
        else
            empty=0
        fi
        polls=$((polls + 1))
        ((polls < 60)) || return 1
        (($(cd_now) < deadline)) || return 1
        cd_sleep 0.5
    done
}

# _cd_rec_child SLUG TAG - one call of the verb, the host lock held for exactly this call.
# 0 the call ran and its container is confirmed gone (the exit code is in _CD_REC_CHILD_RC);
# 3 the host lock could not be taken (twice); 4 a container could not be confirmed gone
# (_CD_REC_ALIVE=1, and the host lock stays held). The host lock is freed only after the
# container is confirmed gone.
_cd_rec_child() {
    local slug="$1" tag="$2" wait uuid prog reason rc=0 lrc=0
    wait="$(cd_cfg CD_RECONCILE_LOCK_WAIT_S)" || wait=120
    cd_hostlock_take "$wait" || lrc=$?
    if ((lrc == 3)); then
        # one retry, then busy
        lrc=0
        cd_hostlock_take "$wait" || lrc=$?
    fi
    if ((lrc != 0)); then
        return 3
    fi
    uuid="$(_cd_rec_uuid)" || { cd_hostlock_release; _cd_rec_err "no request id could be made"; _CD_REC_CHILD_RC=1; return 0; }
    prog="$(_cd_rec_root)/current/infra/host/bin/gremion-tenant"
    # shellcheck disable=SC2059  # the format is the constant above
    printf -v reason "$CD_RECONCILE_REASON_FMT" "$tag"
    {
        printf '%s\n' "--- child $((_CD_REC_N[ok] + _CD_REC_N[failed] + _CD_REC_N[timeout] + _CD_REC_N[busy] + 1))"
    } >>"$_CD_REC_LOG" 2>/dev/null || true
    # stdin /dev/null, stdout and stderr to the one 0600 file, neither lock descriptor (an
    # orphan of a killed child must pin no lock), GREMION_HOST_LOCK_HELD=1 for this child
    # only, a fresh request id (the label the container gets), the release tree of `current`
    timeout -k 10 "$(cd_cfg CD_RECONCILE_TIMEOUT_S)" \
        env -u GREMION_RELEASE_DIR GREMION_ROOT="$(_cd_rec_root)" GREMION_HOST_LOCK_HELD=1 \
        GREMION_EXECUTOR_REQUEST_ID="$uuid" \
        "$prog" reconcile "$slug" --apply --reason "$reason" \
        >>"$_CD_REC_LOG" 2>&1 </dev/null 8>&- 9>&- || rc=$?
    _CD_REC_CHILD_RC="$rc"
    if ! _cd_rec_gone "$uuid"; then
        _CD_REC_ALIVE=1
        return 4
    fi
    cd_hostlock_release
    return 0
}

# _cd_rec_one SLUG TAG - one customer: the call, and one retry after 30 seconds for exit 3.
# The outcome word is left in _CD_REC_OUTCOME: ok failed timeout busy precondition alive. It is
# called directly and never inside $( ): the host lock it takes, and keeps when a container is
# still alive, belongs to this process, and a subshell would lose it.
_cd_rec_one() {
    local slug="$1" tag="$2" rc=0 tries=0
    _CD_REC_OUTCOME=failed
    while :; do
        tries=$((tries + 1))
        rc=0
        _cd_rec_child "$slug" "$tag" || rc=$?
        case "$rc" in
            3) _CD_REC_OUTCOME=busy; return 0 ;;
            4) _CD_REC_OUTCOME=alive; return 0 ;;
        esac
        case "$_CD_REC_CHILD_RC" in
            0) _CD_REC_OUTCOME=ok ;;
            1) _CD_REC_OUTCOME=failed ;;
            2) _CD_REC_OUTCOME=precondition ;;
            3)
                if ((tries < 2)); then
                    # the verb met a lock CD already holds: not expected; once more in 30
                    # seconds, the host lock free in between
                    cd_sleep 30
                    continue
                fi
                _CD_REC_OUTCOME=busy
                ;;
            124) _CD_REC_OUTCOME=timeout ;;
            *) _CD_REC_OUTCOME=failed ;;
        esac
        return 0
    done
}

# -- the probes ------------------------------------------------------------------------------

# _cd_rec_probe_pair - the public probe, asked again after 5 seconds when it is bad. 0 good,
# 1 two bad answers in a row. Nothing it prints reaches stdout.
_cd_rec_probe_pair() {
    if cd_watch_probe_public >/dev/null 2>&1 </dev/null; then
        return 0
    fi
    cd_sleep 5
    cd_watch_probe_public >/dev/null 2>&1 </dev/null
}

# _cd_rec_post - after the last customer: every 15 seconds for CD_POST_RECONCILE_S seconds;
# three bad samples in a row are a failure. 0 good, 1 bad.
_cd_rec_post() {
    local span t0 now bad=0
    span="$(cd_cfg CD_POST_RECONCILE_S)" || span=120
    t0="$(cd_now)"
    while :; do
        now="$(cd_now)"
        ((now - t0 < span)) || return 0
        cd_sleep 15
        if cd_watch_probe_public >/dev/null 2>&1 </dev/null; then
            bad=0
        else
            bad=$((bad + 1))
            ((bad < 3)) || return 1
        fi
    done
}

# _cd_rec_rollback_pending - a rollback request waits in the queue (it is left there for the
# driver, never taken or moved here).
_cd_rec_rollback_pending() {
    local f
    for f in "${CD_REQUEST_DIR}/"*-rollback.json; do
        [[ -f "$f" && ! -L "$f" ]] || continue
        if (($(stat -c %s "$f" 2>/dev/null || echo 999999) > 65536)); then continue; fi
        if jq -s -e 'length == 1 and (.[0] | type == "object" and .v == 1 and .verb == "rollback")' "$f" >/dev/null 2>&1; then
            return 0
        fi
    done
    return 1
}

# -- the end of the stage --------------------------------------------------------------------

# _cd_rec_finish REASON RC - record the outcome: live.reconcile, the history, the mail and, for
# anything but all ok, the hold. REASON is empty for all ok. Returns RC, or 1 when the state
# cannot be written.
_cd_rec_finish() {
    local reason="$1" rc="$2" sha12 colour now secs total ok bad skipped at rcmd
    ok="${_CD_REC_N[ok]}"
    total=$((ok + _CD_REC_N[failed] + _CD_REC_N[timeout] + _CD_REC_N[busy] + _CD_REC_N[skipped] + _CD_REC_N[invalid]))
    bad=$((_CD_REC_N[failed] + _CD_REC_N[timeout] + _CD_REC_N[busy] + _CD_REC_N[invalid]))
    skipped="${_CD_REC_N[skipped]}"
    now="$(cd_now)" || now="$_CD_REC_T0"
    secs=$((now - _CD_REC_T0))
    ((secs >= 0)) || secs=0
    at="$(cd_iso "$now")" || at=''
    CD_RECONCILE_REASON="$reason"
    sha12="$(cd_state_get '.live.sha12 // empty')" || sha12=''
    colour="$(cd_state_get '.live.colour // empty')" || colour=''
    if ! cd_state_set '.live.reconcile = {at: $at, total: $total, ok: $ok, failed: $failed, timeout: $timeout,
                       busy: $busy, skipped: $skipped, invalid: $invalid, seconds: $secs,
                       reason: (if $reason == "" then null else $reason end)}' \
        --arg at "$at" --arg reason "$reason" \
        --argjson total "$total" --argjson ok "$ok" --argjson failed "${_CD_REC_N[failed]}" \
        --argjson timeout "${_CD_REC_N[timeout]}" --argjson busy "${_CD_REC_N[busy]}" \
        --argjson skipped "$skipped" --argjson invalid "${_CD_REC_N[invalid]}" --argjson secs "$secs"; then
        _cd_rec_err "live.reconcile could not be written"
        _cd_rec_tidy
        return 1
    fi
    if [[ -z "$reason" ]]; then
        cd_hist reconciled total="$total" ok="$ok" seconds="$secs" sha12="$sha12" || true
        cd_notify reconciled "sha12=${sha12}" "colour=${colour}" "customers_total=${total}" "customers_ok=${ok}" \
            "customers_failed=${bad}" "customers_skipped=${skipped}" "reconcile_s=${secs}" >/dev/null 2>&1 || true
    else
        rcmd='gremion-cd reconcile'
        case "$reason" in canary | probe) rcmd='gremion-cd rollback' ;; esac
        cd_hold_set reconcile_failed "$reason" "$sha12" || _cd_rec_err "the hold could not be set"

        cd_hist reconcile_failed reason="$reason" total="$total" ok="$ok" failed="${_CD_REC_N[failed]}" timeout="${_CD_REC_N[timeout]}" \
            busy="${_CD_REC_N[busy]}" skipped="$skipped" invalid="${_CD_REC_N[invalid]}" seconds="$secs" sha12="$sha12" || true
        cd_notify reconcile_failed "sha12=${sha12}" "colour=${colour}" "customers_total=${total}" "customers_ok=${ok}" \
            "customers_failed=${bad}" "customers_skipped=${skipped}" "reconcile_s=${secs}" "reason=${reason}" \
            "command=${rcmd}" >/dev/null 2>&1 || true
    fi
    _cd_rec_tidy
    return "$rc"
}

# _cd_rec_order_guard - `current` must resolve to the live release's tree and
# runtime/active-colour must name the live colour: the stage runs after the commit point's move
# and never before it. 0, or 2 with a reason on stderr (no word of a customer).
_cd_rec_order_guard() {
    local tree colour cur want active
    tree="$(cd_state_get '.live.tree // empty')" || tree=''
    colour="$(cd_state_get '.live.colour // empty')" || colour=''
    [[ -n "$tree" && -n "$colour" ]] || { _cd_rec_err "no release is live"; return 2; }
    cur="$(readlink -f -- "$(_cd_rec_root)/current" 2>/dev/null)" || cur=''
    want="$(readlink -f -- "$tree" 2>/dev/null)" || want=''
    if [[ -z "$cur" || "$cur" != "$want" ]]; then
        _cd_rec_err "current is not the live release's tree"
        return 2
    fi
    active=''
    if [[ -f "$(_cd_rec_root)/runtime/active-colour" && ! -L "$(_cd_rec_root)/runtime/active-colour" ]]; then
        active="$(tr -d '[:space:]' <"$(_cd_rec_root)/runtime/active-colour" 2>/dev/null)" || active=''
    fi
    if [[ -z "$active" || "$active" != "$colour" ]]; then
        _cd_rec_err "runtime/active-colour is not the live colour"
        return 2
    fi
    return 0
}

# cd_reconcile_run - see the header.
cd_reconcile_run() {
    local tag max_s guard_min i n slug stop='' grc
    local -a slugs=()
    _cd_rec_reset
    cd_require_lock "the reconcile stage" || return 2
    _CD_REC_T0="$(cd_now)" || return 2
    tag="$(cd_state_get '.live.tag // empty')" || tag=''
    if [[ ! "$tag" =~ ^pilot-[0-9a-f]{12}$ ]]; then
        _cd_rec_err "no release is live"
        CD_RECONCILE_REASON=precondition
        return 2
    fi
    _cd_rec_logfile || { CD_RECONCILE_REASON=precondition; return 2; }
    # the order guard, then what the stage needs to run at all: all before the first query
    if ! _cd_rec_order_guard; then
        _cd_rec_finish precondition 2
        return $?
    fi
    if [[ ! -x "$(_cd_rec_root)/current/infra/host/bin/gremion-tenant" ]]; then
        _cd_rec_err "the release tree has no executable gremion-tenant"
        _cd_rec_finish precondition 2
        return $?
    fi
    if ! _cd_rec_probe_host >/dev/null; then
        _cd_rec_err "no probe host (CD_PROBE_HOST, or a line of etc/tenant-hosts.txt)"
        _cd_rec_finish precondition 2
        return $?
    fi
    if ! cd_reconcile_customers slugs; then
        # fail closed: nothing was asked of a customer
        _cd_rec_finish unknown 1
        return $?
    fi
    n=${#slugs[@]}
    _CD_REC_N[invalid]="$CD_RECONCILE_INVALID"
    if ((CD_RECONCILE_CANARY == 0 && n > 0)); then
        cd_hist reconcile_no_canary customers="$n" >/dev/null 2>&1 || true
    fi
    max_s=$(($(cd_cfg CD_RECONCILE_MAX_MIN) * 60))
    guard_min=$((($(cd_cfg CD_RECONCILE_TIMEOUT_S) + 59) / 60 + 1))
    for ((i = 0; i < n; i++)); do
        slug="${slugs[$i]}"
        # between two customers (and before the first): the kill switch, a rollback request,
        # the budget, the timers. A stop here counts customer i and every later one skipped.
        if cd_killswitch_active; then stop=killswitch; break; fi
        if _cd_rec_rollback_pending; then stop=rollback_request; break; fi
        if (($(cd_now) - _CD_REC_T0 >= max_s)); then stop=budget; break; fi
        grc=0
        cd_data_timer_guard "$guard_min" >/dev/null 2>&1 || grc=$?
        if ((grc == 3)); then
            stop=timer_guard
            break
        elif ((grc != 0)); then
            stop=unknown
            break
        fi
        _cd_rec_one "$slug" "$tag"
        case "$_CD_REC_OUTCOME" in
            ok) _CD_REC_N[ok]=$((_CD_REC_N[ok] + 1)) ;;
            failed) _CD_REC_N[failed]=$((_CD_REC_N[failed] + 1)) ;;
            timeout) _CD_REC_N[timeout]=$((_CD_REC_N[timeout] + 1)) ;;
            busy) _CD_REC_N[busy]=$((_CD_REC_N[busy] + 1)) ;;
            precondition)
                # the same for every customer: the stage stops here
                _CD_REC_N[failed]=$((_CD_REC_N[failed] + 1))
                stop=precondition
                i=$((i + 1))
                break
                ;;
            *)
                # alive: the host lock is still held, and stays held until this process exits
                _CD_REC_N[failed]=$((_CD_REC_N[failed] + 1))
                stop=container_alive
                i=$((i + 1))
                break
                ;;
        esac
        if [[ "$_CD_REC_OUTCOME" != busy ]] && ! _cd_rec_probe_pair; then
            if ((i == 0 && CD_RECONCILE_CANARY == 1)); then stop=canary; else stop=probe; fi
            i=$((i + 1))
            break
        fi
    done
    if [[ -n "$stop" ]]; then
        _CD_REC_N[skipped]=$((n - i))
        if [[ "$stop" == container_alive ]]; then
            cd_alert "reconcile: a container of the verb could not be confirmed gone; the host lock is kept until this process exits"
        fi
        _cd_rec_finish "$stop" 1
        return $?
    fi
    if ((n > 0)) && ! _cd_rec_post; then
        _cd_rec_finish probe 1
        return $?
    fi
    if ((_CD_REC_N[ok] == n && CD_RECONCILE_INVALID == 0)); then
        _cd_rec_finish '' 0
        return $?
    fi
    if ((_CD_REC_N[failed] + _CD_REC_N[invalid] > 0)); then
        _cd_rec_finish failed 1
    elif ((_CD_REC_N[timeout] > 0)); then
        _cd_rec_finish timeout 1
    else
        _cd_rec_finish busy 1
    fi
    return $?
}
