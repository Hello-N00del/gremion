#!/usr/bin/env bash
# infra/host/lib/cd/driver.sh -- the driver of gremion-cd (unit cd-driver): the tick, the
# boot resume, the release pipeline, the failure policy, the start gates, the request
# handlers and the operator verbs release-now, rollback and reconcile.
#
# SOURCED, NEVER EXECUTED (see core.sh): no shell options set here, nothing runs at the top
# level except plain assignments. A stage function of another unit is called as
# `fn || rc=$?`, which switches errexit off inside it, so every command of this file that
# can fail carries its own `|| return`, or goes through _cd_drv_set (a state write that
# fails is fatal: the program alerts and exits 2).
#
# WHO WRITES WHAT. The driver owns: state.phase, the release record of the select stage, the
# stage bookkeeping, state.poll, the holds it decides, the retry file, the end of a release
# (phase idle, release null) and the order of the stages. It never writes what another
# unit owns: release.committed_at, live and previous (cd_commit_promote, commit step 5),
# switch_started (cd_traffic_switch), release.retag_prev (cd_prepare_retag), release.modules
# and release.leaves (the migrate stage), live.reconcile and the reconcile mail
# (cd_reconcile_run), the `released` mail (commit step 8), the block and hold of a rollback
# and its mail (cd_rollback_run).
#
# THE LINE. From `switch_started` until `release.committed_at` every
# failure, a crash, a kill and a stage retry included, goes through cd_rollback_run. From
# `committed_at` on NO failure of any kind does: cd_failure_policy and cd_pipeline_resume ask
# cd_release_committed before they choose a rollback, and every other path to
# cd_rollback_run goes through _cd_drv_rollback_auto, which asks it again (the backstop). Each
# committed-side path has its own check (marked LINE-1 to LINE-5 below). The backstop would
# catch what a missing check let through, and so hide it: it writes the history line
# `rollback_door_refused` when it fires, and every test of THE LINE asserts there is none, so
# that removing one check is a failing test of that path alone.
#
# shellcheck disable=SC2016  # the jq programs are single-quoted on purpose: $name is jq's own syntax
#
# THE REAL-DATA BOUNDARY. This file prints and records names of stages, counts and codes. A
# customer slug is never read here (the reconcile stage's child belongs to reconcile.sh).
# A reason typed by an operator goes to a history line (scrubbed), never into a hold code or
# a mail.

# the stage order of one release; host_apply and state_apply run only with --with-state
CD_DRV_STAGES=(select fetch classify host_apply state_apply retag render build snapshot migrate start gates switch watch commit reconcile)
# the holds that are a verdict on the newest candidate: the tick asks again, a clean newer
# candidate ends them
CD_DRV_CLASSIFIER_HOLDS=" state_tier unsupported_chain contract_migration waived_migration ci_changed chain_class_changed batch_too_large not_ancestor ruleset_missing range_unverified classify_failed "
# the classify-stage subset (a verdict on one tree): the same candidate is not judged twice
CD_DRV_CLASSIFY_ONLY=" state_tier unsupported_chain contract_migration waived_migration ci_changed chain_class_changed classify_failed "
# holds that only `resume` (after the cause is fixed) ends
CD_DRV_RESUME_HOLDS=" operator failure proof rollback_failed killswitch stuck_stage reconcile_failed "

CD_DRV_RESUME_ONLY=0   # 1 in `tick --resume-only` (the boot unit)
CD_DRV_ROLLED=0        # 1 once a rollback has ended the release in this process
CD_DRV_STARTED=0       # 1 once this process has started a release (an idle tick does one thing)
CD_DRV_ATT=1           # the attempt number of the stage about to run
CD_DRV_SWITCH_DONE=0   # 1 when a resumed switch stage found the new colour already serving
CD_DRV_RETRY_BACKOFF=(60 300 900)
CD_DRV_RETRY_MAX=3

_cd_drv_say() { cd_info "$*"; }

# _cd_drv_set FILTER [jq args] -- a state write; a refused one is fatal.
_cd_drv_set() {
    cd_state_set "$@" || {
        cd_alert "a state write failed in the driver"
        cd_die 2 "a state write failed"
    }
}

# _cd_drv_mail KIND [k=v ...] -- queue a mail; never fails, never waits.
_cd_drv_mail() { cd_notify "$@" >/dev/null 2>&1 || true; }

# an empty word is in no list (the lists carry a space at both ends, so " " would match)
_cd_drv_in_list() { [[ -n "$1" && " $2 " == *" $1 "* ]]; }

# _cd_drv_other COLOUR -- the other colour
_cd_drv_other() {
    if [[ "$1" == blue ]]; then printf 'green'; else printf 'blue'; fi
}

# _cd_drv_code STR FALLBACK -- STR when it is a reason code (the state's hold.reason shape and
# the mail's `code` shape: lower case, digits, underscore), else FALLBACK.
_cd_drv_code() {
    if [[ "${1:-}" =~ ^[a-z][a-z0-9_]{0,59}$ ]]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}

# _cd_drv_load -- the fields every decision needs, into D_* (state) and R_* (release). Called
# DIRECTLY, never in $( ): an unreadable state stops the program here.
_cd_drv_load() {
    local line
    cd_state_load
    line="$(printf '%s' "$CD_STATE_DOC" | jq -r '[
        .phase, (.hold.kind // ""), (.hold.sha12 // ""), (.live.colour // ""), (.live.tree // ""),
        (.live.sha12 // ""), (.live.tag // ""),
        (.release.sha // ""), (.release.sha12 // ""), (.release.tag // ""), (.release.colour // ""),
        (.release.tree // ""), (.release.stage // ""), (.release.stage_status // ""),
        ((.release.attempt // 0) | tostring), ((.release.switch_started // false) | tostring),
        (.release.committed_at // ""), (.release.mode // ""), ((.release.with_state // false) | tostring),
        (.release.id // ""), (.previous.sha12 // ""), ((.previous.startable // false) | tostring)
        ] | join("|")')" || return 2
    # shellcheck disable=SC2034  # D_LTAG, D_PSHA12 and D_PSTART are read by the handlers below
    IFS='|' read -r D_PHASE D_HOLD D_HOLDSHA D_LCOL D_LTREE D_LSHA12 D_LTAG \
        R_SHA R_SHA12 R_TAG R_COL R_TREE R_STAGE R_STATUS R_ATT R_SWITCH R_COMMIT R_MODE R_WS R_ID \
        D_PSHA12 D_PSTART <<<"$line"
}

# _cd_drv_stage_index NAME -- the position in the stage order.
_cd_drv_stage_index() {
    local i=0 s
    for s in "${CD_DRV_STAGES[@]}"; do
        if [[ "$s" == "$1" ]]; then
            printf '%s' "$i"
            return 0
        fi
        i=$((i + 1))
    done
    return 1
}

# _cd_drv_next_stage CURRENT WITH_STATE -- the stage after CURRENT; `end` after the last.
_cd_drv_next_stage() {
    local idx n
    idx="$(_cd_drv_stage_index "$1")" || return 1
    n=$((idx + 1))
    while ((n < ${#CD_DRV_STAGES[@]})); do
        case "${CD_DRV_STAGES[n]}" in
            host_apply | state_apply)
                if [[ "$2" != true ]]; then
                    n=$((n + 1))
                    continue
                fi
                ;;
        esac
        printf '%s' "${CD_DRV_STAGES[n]}"
        return 0
    done
    printf 'end'
}

# -- the end of a release -----------------------------------------------------------
# _cd_drv_end_release -- phase idle, no release. The hold, the live and previous records and
# the blocks are left as the caller wrote them. Needs the cd lock.
_cd_drv_end_release() {
    _cd_drv_set '.phase = "idle" | .release = null'
    rm -f "${CD_DATA}/release-ref" 2>/dev/null || true
}

# _cd_drv_consume_rollbacks -- a release has ended without a rollback of its own (an abort, a
# refusal), or this process has rolled one back and is about to exit. Every rollback request
# that is pending now was made while that release ran, for it: left in the queue it would be
# taken later as the verb of an idle host and take the LIVE release back to `previous`, which
# nobody asked for, and a process that ends without a drain (the boot unit's resume-only tick)
# would leave it to the next tick. So each one is moved to processed/ and said so in the history;
# the operator may ask again. Called BEFORE the release is ended in the state, so that a kill
# between the two leaves the release (and the request) for the next process, never a request
# for an idle host. A release that committed is never passed here: its rollback request is the
# operator's way back from it.
_cd_drv_consume_rollbacks() {
    local f
    for f in "${CD_REQUEST_DIR}/"*-rollback.json; do
        if [[ -f "$f" && ! -L "$f" ]]; then
            cd_mkdir "${CD_REQUEST_DIR}/processed" || return 0
            mv -f -- "$f" "${CD_REQUEST_DIR}/processed/${f##*/}" || continue
            cd_hist rollback_refused why=release_over || true
            _cd_drv_say "rollback refused: the release it was made for is already over"
        fi
    done
    return 0
}

# _cd_drv_keep_log COLOUR -- the last 500 lines of the failed colour's gremion-ui into a 0600
# file under logs/; never printed, never mailed (it names tenant slugs). Best effort.
_cd_drv_keep_log() {
    local colour="$1" sha12="$2" cid dir f
    declare -F cd_svc_cid >/dev/null 2>&1 || return 0
    cid="$(cd_svc_cid "app-${colour}" gremion-ui 2>/dev/null </dev/null)" || return 0
    [[ "$cid" =~ ^[0-9a-f]{12,64}$ ]] || return 0
    dir="${CD_ROOT}/logs"
    mkdir -p "$dir" 2>/dev/null || return 0
    f="${dir}/cd-failed-${sha12}.log"
    ( umask 077; timeout 30 docker logs --tail 500 "$cid" >"$f" 2>&1 </dev/null ) || true
    chmod 600 "$f" 2>/dev/null || true
    return 0
}

# _cd_drv_counts_args -- the module and leaf counts of the release as mail arguments
# (CD_DRV_COUNTS).
_cd_drv_counts_args() {
    local line mt mu mf lt lm ls lf
    CD_DRV_COUNTS=()
    line="$(printf '%s' "$CD_STATE_DOC" | jq -r '[
        (.release.modules.total // ""), (.release.modules.upgraded // ""), (.release.modules.failed // ""),
        (.release.leaves.total // ""), (.release.leaves.migrated // ""), (.release.leaves.skipped // ""),
        (.release.leaves.failed // "")] | map(tostring) | join("|")')" || return 0
    IFS='|' read -r mt mu mf lt lm ls lf <<<"$line"
    [[ -n "$mt" ]] && CD_DRV_COUNTS+=("modules_total=${mt}" "modules_upgraded=${mu}" "modules_failed=${mf}")
    [[ -n "$lt" ]] && CD_DRV_COUNTS+=("leaves_total=${lt}" "leaves_migrated=${lm}" "leaves_skipped=${ls}" "leaves_failed=${lf}")
    return 0
}

# -- before the switch: tear down ---------------------------------------------------
# _cd_drv_teardown -- stop the inactive colour, keep its log, put the target env's IMAGE_TAG
# back, leave the live colour and everything of it alone. Never a rollback (the colour never
# served: switch_started is false on every path that calls it). Always 0: a step that fails
# is a history line, and the caller goes on to write the hold.
_cd_drv_teardown() {
    local rc=0
    _cd_drv_load
    _cd_drv_keep_log "$R_COL" "$R_SHA12"
    cd_colour_down "$R_TREE" "$R_COL" || rc=$?
    if ((rc != 0)); then
        cd_hist teardown_incomplete stage="$R_STAGE" code="$rc" || true
        cd_err "the teardown of the target colour did not complete (code ${rc})"
    fi
    rc=0
    cd_prepare_retag_restore || rc=$?
    if ((rc != 0)); then
        cd_hist retag_restore_failed code="$rc" || true
    fi
    return 0
}

# _cd_drv_abort KIND ... -- the pre-switch end of a release: teardown, block (kind commit
# only), hold, mail, end. KIND is one of
#   commit RULE DETAIL    block RULE, hold blocked, mail rejected
#   host   REASON         hold failure, mail stopped, no block
#   infra  REASON         no hold, no block, mail stopped, a retry later (retry file)
#   operator              hold operator, no block (the operator's rollback before the switch)
#   killswitch            hold killswitch, no block
#   stuck                 hold stuck_stage, no block
_cd_drv_abort() {
    local kind="$1" a="${2:-}" b="${3:-}" stage sha sha12 tag colour dump
    _cd_drv_load
    stage="$R_STAGE"
    sha="$R_SHA"
    sha12="$R_SHA12"
    tag="$R_TAG"
    colour="$R_COL"
    dump="$(printf '%s' "$CD_STATE_DOC" | jq -r '.release.dump_label // empty')"
    if [[ "$R_SWITCH" == true ]]; then
        # a bug in a caller, not a state this code expects: the line is crossed, so the
        # only safe move is the rollback
        cd_err "driver: a pre-switch end was asked for after switch_started; rolling back instead"
        _cd_drv_rollback_auto commit_stuck "$stage"
        return 0
    fi
    _cd_drv_teardown
    _cd_drv_load
    local -a m=(sha12="$sha12" tag="$tag" colour="$colour")
    [[ "$stage" =~ ^(select|fetch|classify|host_apply|state_apply|retag|render|build|snapshot|migrate|start|gates|switch|watch|commit|reconcile)$ ]] && m+=(stage="$stage")
    [[ -n "$D_LSHA12" ]] && m+=(prev_sha12="$D_LSHA12")
    [[ -n "$dump" ]] && m+=(dump_label="$dump")
    case "$kind" in
        commit)
            cd_block_add "$sha" "$a" "$b" || cd_err "driver: the block could not be written"
            cd_hold_set blocked "$(_cd_drv_code "$a" blocked)" "$sha12" || true
            _cd_drv_counts_args
            _cd_drv_mail rejected "${m[@]}" rule="$a" reason="$(_cd_drv_code "$b" none)" "${CD_DRV_COUNTS[@]}" \
                command="gremion-cd release-now ${sha12}" key="rejected.${sha12}.${R_ID}"
            ;;
        host)
            cd_hold_set failure "$(_cd_drv_code "$a" stage_failed)" "$sha12" || true
            _cd_drv_mail stopped "${m[@]}" reason="$(_cd_drv_code "$a" stage_failed)" \
                command="gremion-cd resume" key="stopped.${sha12}.${R_ID}"
            ;;
        infra)
            _cd_drv_retry_record "$sha12"
            _cd_drv_mail stopped "${m[@]}" reason="$(_cd_drv_code "$a" infra_failure)" \
                key="stopped.${sha12}.$(_cd_drv_retry_count)"
            ;;
        operator)
            cd_hold_set operator requested "$sha12" || true
            ;;
        killswitch)
            cd_hold_set killswitch abort "$sha12" || true
            _cd_drv_mail killswitch phase=releasing sha12="$sha12" stage="$stage" command="gremion-cd status" \
                key="killswitch.${sha12}.abort"
            ;;
        stuck)
            cd_hold_set stuck_stage "$(_cd_drv_code "$stage" stage)" "$sha12" || true
            _cd_drv_mail stopped "${m[@]}" reason=stuck_stage command="gremion-cd resume" key="stuck.${sha12}.${R_ID}"
            ;;
    esac
    cd_hist release_aborted kind="$kind" stage="$stage" sha12="$sha12" || true
    # the operator's own rollback is the request that asked for this end (a second one meets
    # CD_DRV_ROLLED); every other end was not asked for by a request that is waiting
    if [[ "$kind" != operator ]]; then
        _cd_drv_consume_rollbacks
    fi
    _cd_drv_end_release
    cd_hostlock_release
    return 0
}

# -- the infra retry file -------------------------------------------------------------
# data/cd/retry: "<sha12> <count> <not-before-epoch>". The state schema has no key for it.
_cd_drv_retry_file() { printf '%s' "${CD_DATA}/retry"; }

_cd_drv_retry_count() {
    local f sha n next
    f="$(_cd_drv_retry_file)"
    [[ -r "$f" ]] || { printf '0'; return 0; }
    read -r sha n next <"$f" || true
    [[ "$n" =~ ^[0-9]+$ ]] && printf '%s' "$n" || printf '0'
}

# _cd_drv_retry_record SHA12 -- one more infrastructure failure of that commit.
_cd_drv_retry_record() {
    local sha12="$1" f psha n next now wait idx
    f="$(_cd_drv_retry_file)"
    n=0
    if [[ -r "$f" ]]; then
        read -r psha n next <"$f" || true
        [[ "$psha" == "$sha12" && "$n" =~ ^[0-9]+$ ]] || n=0
    fi
    n=$((n + 1))
    now="$(cd_now)" || return 1
    idx=$((n - 1))
    ((idx >= ${#CD_DRV_RETRY_BACKOFF[@]})) && idx=$((${#CD_DRV_RETRY_BACKOFF[@]} - 1))
    wait="${CD_DRV_RETRY_BACKOFF[idx]}"
    printf '%s %s %s\n' "$sha12" "$n" "$((now + wait))" | cd_atomic_write "$f" 600
    cd_hist infra_retry sha12="$sha12" count="$n" wait_s="$wait" || true
}

# _cd_drv_retry_gate SHA12 -- 0 when the candidate may start; 3 inside the backoff; 2 when the
# retries are used up (the caller holds `failure`).
_cd_drv_retry_gate() {
    local sha12="$1" f psha n next now
    f="$(_cd_drv_retry_file)"
    [[ -r "$f" ]] || return 0
    read -r psha n next <"$f" || true
    if [[ "$psha" != "$sha12" || ! "$n" =~ ^[0-9]+$ || ! "$next" =~ ^[0-9]+$ ]]; then
        rm -f "$f"
        return 0
    fi
    ((n >= CD_DRV_RETRY_MAX)) && return 2
    now="$(cd_now)" || return 2
    ((now < next)) && return 3
    return 0
}

# -- after the switch: roll back ----------------------------------------------------
# _cd_drv_rollback_call RULE -- cd_rollback_run under a heartbeat of its own. The sequence
# ends with a watch of CD_POST_ROLLBACK_S and starts the old colour first, so without a beat
# the watchdog reads a lock that is held and a beat that is old as a stuck release. Its
# return code is the sequence's; the beat is stopped on every path.
_cd_drv_rollback_call() {
    local rule="$1" rc=0
    cd_heartbeat_start rollback $(( $(cd_cfg CD_POST_ROLLBACK_S) + 900 )) || cd_err "driver: the heartbeat did not start"
    cd_rollback_run "$rule" || rc=$?
    cd_heartbeat_stop
    return "$rc"
}

# _cd_drv_rollback_auto RULE STAGE -- the one door to cd_rollback_run for a release that has
# not committed. A committed release is never sent through here; if a caller does, nothing is
# touched and the failure becomes the committed side's hold.
_cd_drv_rollback_auto() {
    local rule="$1" stage="${2:-watch}" rc=0
    # BACKSTOP: the last check that keeps a committed release out of a rollback
    if cd_release_committed; then
        cd_err "driver: a rollback was asked for a committed release (rule ${rule}); refused, nothing touched"
        cd_hist rollback_door_refused rule="$(_cd_drv_code "$rule" unknown)" stage="$stage" || true
        _cd_drv_policy_committed "$stage" host "post_commit_${stage}"
        return 0
    fi
    CD_DRV_ROLLED=1
    cd_stage_fail "$stage" commit "$rule" || true
    _cd_drv_set '.phase = "rolling_back"'
    _cd_drv_rollback_call "$rule" || rc=$?
    _cd_drv_after_rollback "$rc" "$rule"
    return 0
}

# _cd_drv_after_rollback RC RULE -- whatever the sequence did, the release is over: nowhere
# else is left to go. The block, the hold and the mail are the sequence's.
_cd_drv_after_rollback() {
    local rc="$1" rule="$2" kind
    _cd_drv_load
    if [[ "$rc" != 0 ]]; then
        cd_hist rollback_returned rule="$rule" code="$rc" || true
        if [[ -z "$D_HOLD" ]]; then
            cd_hold_set rollback_failed "$(_cd_drv_code "$rule" rollback)" "$R_SHA12" || true
        fi
    fi
    if [[ "$D_PHASE" != idle || -n "$R_ID" ]]; then
        _cd_drv_end_release
    fi
    cd_hostlock_release
    CD_DRV_ROLLED=1
    return 0
}

# -- after the commit point ---------------------------------------------------------
# _cd_drv_policy_committed STAGE KIND CODE -- a committed release failed somewhere. It stays
# committed: no rollback, no block, `current`, the env files and the colours untouched. The
# hold is `reconcile_failed` for the reconcile stage and `failure` for the rest; the locks go.
_cd_drv_policy_committed() {
    local stage="$1" kind="$2" code="$3" sha12 colour hk
    _cd_drv_load
    sha12="$R_SHA12"
    colour="$R_COL"
    if [[ "$stage" == reconcile ]]; then
        hk=reconcile_failed
        code="$(_cd_drv_code "$code" unknown)"
        cd_hold_set reconcile_failed "$code" "$sha12" || true
        _cd_drv_mail reconcile_failed sha12="$sha12" colour="$colour" reason="$code" \
            command="gremion-cd reconcile" key="reconcile_failed.${sha12}"
    elif [[ "$D_HOLD" == failure && "$D_HOLDSHA" == "$sha12" ]]; then
        # the failing unit (commit steps 6 to 8) wrote its own hold, with the step in its
        # reason, and queued its own mail: neither is replaced or doubled
        hk=failure
    else
        hk=failure
        code="$(_cd_drv_code "post_commit_${stage}" post_commit)"
        cd_hold_set failure "$code" "$sha12" || true
        _cd_drv_mail stopped sha12="$sha12" tag="$R_TAG" colour="$colour" reason="$code" \
            command="gremion-cd resume" key="stopped.${sha12}.${code}"
    fi
    cd_hist committed_failure stage="$stage" kind="$kind" hold="$hk" sha12="$sha12" || true
    _cd_drv_end_release
    cd_hostlock_release
    return 0
}

# _cd_drv_end_interrupted -- a committed release whose reconcile stage has no process (a
# crash, a kill, a reboot): never run again, ended with hold reconcile_failed. The cd lock
# stays with the caller until its cycle ends.
_cd_drv_end_interrupted() {
    local sha12 colour tot ok failed skipped
    _cd_drv_load
    sha12="$R_SHA12"
    colour="$R_COL"
    # a stage recorded `failed` whose hold already stands: cd_reconcile_run said why (reason,
    # counts, one mail) and only the end of the release was missing; its reason is not replaced
    if [[ "$R_STATUS" == failed && "$D_HOLD" == reconcile_failed ]]; then
        cd_hist reconcile_interrupted sha12="$sha12" kept=hold || true
        _cd_drv_end_release
        return 0
    fi
    tot="$(printf '%s' "$CD_STATE_DOC" | jq -r '[.live.reconcile.total, .live.reconcile.ok, .live.reconcile.failed, .live.reconcile.skipped] | map(. // "") | map(tostring) | join("|")')" || tot="|||"
    IFS='|' read -r tot ok failed skipped <<<"$tot"
    local -a m=(sha12="$sha12" colour="$colour" reason=interrupted command="gremion-cd reconcile" key="reconcile_failed.${sha12}")
    [[ -n "$tot" ]] && m+=(customers_total="$tot" customers_ok="$ok" customers_failed="$failed" customers_skipped="$skipped")
    cd_hold_set reconcile_failed interrupted "$sha12" || true
    _cd_drv_mail reconcile_failed "${m[@]}"
    cd_hist reconcile_interrupted sha12="$sha12" || true
    _cd_drv_end_release
    return 0
}

# -- the failure policy -------------------------------------------------------------
# cd_failure_policy STAGE KIND CODE -- what a failed stage means. KIND is commit, infra or
# host; CODE is a reason code (a rule name for a rollback). It acts, and returns 0 once the
# release has been dealt with.
#   committed                 hold only, never a rollback (LINE-4 / LINE-5)
#   switch_started, not yet   cd_rollback_run, never the teardown
#   before the switch         infra: retry later, no block; host: hold failure, no block;
#                             commit: block, hold blocked, mail rejected
cd_failure_policy() {
    local stage="${1:-}" kind="${2:-}" code="${3:-}" rule detail
    [[ "$kind" =~ ^(commit|infra|host)$ ]] || { cd_err "failure policy: kind is commit, infra or host"; return 2; }
    _cd_drv_in_list "$stage" "${CD_DRV_STAGES[*]}" || { cd_err "failure policy: not a stage"; return 2; }
    # LINE-5: a policy call for a committed release, every stage and kind
    if cd_release_committed; then
        _cd_drv_policy_committed "$stage" "$kind" "$code"
        return 0
    fi
    _cd_drv_load
    if [[ "$R_SWITCH" == true ]]; then
        rule="$(_cd_drv_code "$code" post_switch_verify)"
        case "$rule" in
            post_switch_verify | watch_readiness | watch_crash | watch_5xx | watch_pause_cap | manual_rollback | commit_stuck | proof_end) ;;
            *) rule=post_switch_verify ;;
        esac
        _cd_drv_rollback_auto "$rule" "$stage"
        return 0
    fi
    case "$kind" in
        infra) _cd_drv_abort infra "$(_cd_drv_code "$code" infra_failure)" ;;
        host) _cd_drv_abort host "$(_cd_drv_code "$code" "${stage}_failed")" ;;
        commit)
            rule="$(_cd_drv_block_rule "$stage")"
            detail="$(_cd_drv_code "$code" "$rule")"
            _cd_drv_abort commit "$rule" "$detail"
            ;;
    esac
    return 0
}

# _cd_drv_block_rule STAGE -- the block rule of a commit failure in that stage.
_cd_drv_block_rule() {
    case "$1" in
        build) printf 'build_failed' ;;
        migrate) printf 'migrate_failed' ;;
        start) printf 'start_failed' ;;
        gates)
            case "${CD_COLOUR_REASON:-}" in
                isolation*) printf 'isolation_failed' ;;
                verify*) printf 'verify_failed' ;;
                *) printf 'readiness_failed' ;;
            esac
            ;;
        *) printf 'readiness_failed' ;;
    esac
}

# _cd_drv_kind STAGE RC -- the failure kind of a stage's return code.
_cd_drv_kind() {
    local stage="$1" rc="$2"
    case "$rc" in
        4 | 3) printf 'infra' ;;
        1)
            case "$stage" in
                build | migrate | start | gates) printf 'commit' ;;
                *) printf 'host' ;;
            esac
            ;;
        *) printf 'host' ;;
    esac
}

# _cd_drv_fail STAGE RC [DETAIL] -- record the failure of the running stage and apply the policy.
_cd_drv_fail() {
    local stage="$1" rc="$2" detail="${3:-}" kind code
    kind="$(_cd_drv_kind "$stage" "$rc")"
    code="$(_cd_drv_code "$detail" "${stage}_failed")"
    cd_stage_fail "$stage" "$kind" "$code" || true
    cd_failure_policy "$stage" "$kind" "$code"
}

# -- the stages ---------------------------------------------------------------------
# A stage runner records its own begin and end, runs the unit function under a heartbeat and
# returns 0 (done or dealt with), 3 (waiting: the process ends quietly, the release waits for
# the next tick). The pipeline loop reads the state again after every runner.

# _cd_drv_begin STAGE BUDGET_S -- stage record, attempt counter, heartbeat.
_cd_drv_begin() {
    local stage="$1" budget="$2"
    cd_stage_begin "$stage" || true
    _cd_drv_set '.release.attempt = $a' --argjson a "$CD_DRV_ATT"
    cd_heartbeat_start "$stage" "$budget" || cd_err "driver: the heartbeat did not start"
}

_cd_drv_done() {
    cd_heartbeat_stop
    cd_stage_ok "$1" || true
}

# _cd_drv_run NAME BUDGET FN ARGS... -- begin, run, end; the failure policy on a non-zero code.
_cd_drv_run() {
    local name="$1" budget="$2" rc=0
    shift 2
    CD_DRV_WHY=''
    _cd_drv_begin "$name" "$budget"
    "$@" || rc=$?
    cd_heartbeat_stop
    if ((rc != 0)); then
        _cd_drv_fail "$name" "$rc" "${CD_DRV_WHY:-}"
        return 0
    fi
    cd_stage_ok "$name" || true
    return 0
}

_cd_drv_st_fetch() {
    local ref=""
    if [[ "$R_MODE" == proof && -r "${CD_DATA}/release-ref" ]]; then
        read -r ref <"${CD_DATA}/release-ref" || ref=""
    fi
    CD_DRV_WHY=''
    if [[ -n "$ref" ]]; then
        cd_prepare_fetch "$R_SHA" "$ref" >/dev/null
    else
        cd_prepare_fetch "$R_SHA" >/dev/null
    fi
}

# _cd_drv_st_classify -- not a failure when it holds: a hold is the answer. The class goes into
# the release record. In manual mode the flags of release-now waive some holds.
_cd_drv_st_classify() {
    local cls rc=0 holds waived blocking migs first_kind first_reason
    _cd_drv_begin classify 300
    cls="$(cd_classify "$D_LTREE" "$R_TREE")" || rc=$?
    cd_heartbeat_stop
    if ((rc != 0)) || ! printf '%s' "$cls" | jq -e 'type == "object" and (.holds | type == "array")' >/dev/null 2>&1; then
        # a classifier that cannot answer is a verdict on this tree like any other: the hold
        # classify_failed, ended by a newer clean candidate, not a failure that needs `resume`.
        # Nothing was built or started at this stage, so the release only goes away.
        cd_stage_fail classify host classify_failed || true
        cd_hist classify_crashed code="$rc" sha12="$R_SHA12" || true
        if [[ "$R_MODE" == auto ]]; then
            _cd_drv_hold_candidate classify_failed classify_failed "$R_SHA12"
            _cd_drv_abort_refused held
        else
            # the operator's request is refused; a hold that already stands (a blocked
            # candidate) is the candidate walk's verdict and stays as it is
            cd_hist release_now_refused why=classify_failed sha12="$R_SHA12" || true
            _cd_drv_say "release-now refused: the classifier could not judge the candidate"
            _cd_drv_abort_refused refused
        fi
        return 0
    fi
    _cd_drv_set '.release.class = $c' --argjson c "$cls"
    holds="$(printf '%s' "$cls" | jq -c '.holds')"
    # a proof release may not carry a new migration file (the proof proves nothing about one)
    if [[ "$R_MODE" == proof ]]; then
        # a count that is missing or not a number is no answer: it never reads as none
        migs="$(printf '%s' "$cls" | jq -r '.migrations.total | if type == "number" then tostring else "unknown" end' 2>/dev/null)" || migs=unknown
        if [[ "$migs" != 0 ]]; then
            cd_hist release_refused reason=proof_migration sha12="$R_SHA12" || true
            _cd_drv_say "refused: a proof release may not add a migration file, and its migration count must be known"
            # the stage is NOT recorded ok: a kill before the end of the release below would
            # leave "classify ok" behind, and the next tick would build what was refused. Left
            # `started`, the resume judges the candidate again (the third attempt is stuck_stage).
            _cd_drv_abort_refused proof_migration
            return 0
        fi
    fi
    waived=""
    if [[ "$R_MODE" == manual ]]; then
        waived="ci_changed chain_class_changed"
        [[ "$R_WS" == true ]] && waived="${waived} state_tier"
    fi
    blocking="$(printf '%s' "$holds" | jq -r --arg w "$waived" '[.[] | select(.kind as $k | ($w | split(" ") | index($k)) | not)] | length')"
    if ((blocking > 0)); then
        first_kind="$(printf '%s' "$holds" | jq -r --arg w "$waived" '[.[] | select(.kind as $k | ($w | split(" ") | index($k)) | not)][0].kind')"
        first_reason="$(printf '%s' "$holds" | jq -r --arg w "$waived" '[.[] | select(.kind as $k | ($w | split(" ") | index($k)) | not)][0].reason')"
        # not recorded ok, as above: a refused candidate never reads as a classified one
        if [[ "$R_MODE" == auto ]]; then
            _cd_drv_hold_candidate "$first_kind" "$first_reason" "$R_SHA12"
            _cd_drv_abort_refused held
        else
            cd_hist release_now_refused kind="$first_kind" sha12="$R_SHA12" || true
            _cd_drv_say "release-now refused: the candidate is held by ${first_kind} and no flag waives it"
            _cd_drv_mail held hold="$first_kind" reason="$(_cd_drv_code "${first_reason//[:.]/_}" "$first_kind")" sha12="$R_SHA12" \
                key="held.${first_kind}.${R_SHA12}.manual"
            _cd_drv_abort_refused refused
        fi
        return 0
    fi
    # clean (or waived): a classifier hold of an earlier candidate ends here
    _cd_drv_load
    if _cd_drv_in_list "$D_HOLD" "$CD_DRV_CLASSIFIER_HOLDS"; then
        cd_hold_clear || true
    fi
    cd_stage_ok classify || true
    return 0
}

# _cd_drv_abort_refused WHY -- a release that never became one: nothing was built or started,
# so no teardown beyond forgetting the record. Keeps the fetched tree (the next candidate may
# reuse it) and the hold the caller wrote.
_cd_drv_abort_refused() {
    cd_hist release_not_started why="$1" sha12="${R_SHA12:-}" || true
    _cd_drv_consume_rollbacks
    _cd_drv_end_release
    cd_hostlock_release
}

# _cd_drv_hostlock_wait BEAT -- cd_hostlock_take for up to CD_LOCK_WAIT_S, under a heartbeat when
# this process has none running (a stage stops its own, and the wait is longer than the 180 s
# after which the watchdog calls a silent holder of the cd lock a stuck release). A beat that is
# running (the tick's own) is left alone. BEAT is the name in the heartbeat file.
_cd_drv_hostlock_wait() {
    local name="$1" rc=0 beat=0 span
    span="$(cd_cfg CD_LOCK_WAIT_S)"
    if [[ -z "${CD_HB_PID:-}" ]]; then
        if cd_heartbeat_start "$name" $((span + 60)); then
            beat=1
        else
            cd_err "driver: the heartbeat did not start"
        fi
    fi
    cd_hostlock_take "$span" || rc=$?
    if ((beat == 1)); then
        cd_heartbeat_stop
    fi
    return "$rc"
}

# The two apply stages run with the host lock held by this process, so that a child that takes
# the lock itself is told (GREMION_HOST_LOCK_HELD) instead of failing on it; the lock is let go
# when the state apply ends, before the build.
_cd_drv_st_host_apply() {
    local rc=0
    cd_adopt_apply_host "$R_TREE" || rc=$?
    return "$rc"
}
_cd_drv_st_state_apply() {
    local rc=0
    cd_adopt_apply_state "$R_TREE" || rc=$?
    cd_hostlock_release
    return "$rc"
}

# _cd_drv_apply_stage STAGE -- the lock first, then the stage. A host lock that is busy is
# waiting (return 3, the stage record untouched, no mail, no backoff), like the snapshot stage:
# another holder (a backup, the purge) is no failure of this release. Any other refusal is.
_cd_drv_apply_stage() {
    local stage="$1" rc=0
    _cd_drv_hostlock_wait "$stage" || rc=$?
    if ((rc == 3)); then
        cd_hist apply_waiting why=host_lock stage="$stage" sha12="$R_SHA12" || true
        _cd_drv_say "waiting: the host lock is held"
        return 3
    elif ((rc != 0)); then
        _cd_drv_begin "$stage" 900
        cd_heartbeat_stop
        _cd_drv_fail "$stage" "$rc" host_lock
        return 0
    fi
    _cd_drv_run "$stage" 900 "_cd_drv_st_${stage}"
}
_cd_drv_st_retag() { cd_prepare_retag "$R_TREE" "$R_COL" "$R_TAG" >/dev/null; }
_cd_drv_st_render() { cd_prepare_render "$R_TREE" "$R_COL" >/dev/null; }
_cd_drv_st_build() { cd_prepare_build "$R_TREE" "$R_COL" "$R_TAG"; }

# _cd_drv_st_snapshot -- the timer guard, then the host lock, then the dump set. A guard or a
# lock that says "not now" is waiting, not a failure: the built release waits for the next tick.
_cd_drv_st_snapshot() {
    local rc=0 span t0 t1 dur
    span="$(cd_cfg CD_LOCK_SPAN_MAX_MIN)" || return 2
    cd_data_timer_guard "$span" || rc=$?
    if ((rc == 3)); then
        cd_hist snapshot_waiting why=timer_guard sha12="$R_SHA12" || true
        _cd_drv_say "waiting: the lock span would overlap the backup or the purge"
        return 3
    elif ((rc != 0)); then
        _cd_drv_begin snapshot 600
        cd_heartbeat_stop
        _cd_drv_fail snapshot "$rc" timer_unreadable
        return 0
    fi
    rc=0
    cd_hostlock_take 0 || rc=$?
    if ((rc == 3)); then
        cd_hist snapshot_waiting why=host_lock sha12="$R_SHA12" || true
        _cd_drv_say "waiting: the host lock is held"
        return 3
    elif ((rc != 0)); then
        _cd_drv_begin snapshot 600
        cd_heartbeat_stop
        _cd_drv_fail snapshot "$rc" host_lock
        return 0
    fi
    _cd_drv_begin snapshot 3600
    t0="$(cd_now)" || t0=0
    rc=0
    CD_DRV_WHY=''
    cd_data_precheck || rc=$?
    if ((rc == 0)); then
        cd_data_dumpset_take "$R_TAG" app || rc=$?
    fi
    cd_heartbeat_stop
    if ((rc != 0)); then
        _cd_drv_fail snapshot "$rc" dump_failed
        return 0
    fi
    t1="$(cd_now)" || t1="$t0"
    dur=$((t1 - t0))
    ((dur < 0)) && dur=0
    _cd_drv_set '.release.dump_label = $l | .release.timing.snapshot_s = $d' --arg l "$R_TAG" --argjson d "$dur"
    cd_stage_ok snapshot || true
    return 0
}

# _cd_drv_reasons -- the code a failed migrate step left (modules or leaves), for the block
# detail and the hold reason.
_cd_drv_migrate_detail() {
    local lf mf
    lf="$(printf '%s' "$CD_STATE_DOC" | jq -r '.release.leaves.failed // 0')"
    mf="$(printf '%s' "$CD_STATE_DOC" | jq -r '.release.modules.failed // 0')"
    if [[ -n "${CD_LEAVES_REASON:-}" ]]; then
        case "$CD_LEAVES_REASON" in
            leaf_timeout | leaf_container_alive) printf '%s' "$CD_LEAVES_REASON" ;;
            *) printf 'leaf_migrate' ;;
        esac
    elif [[ "$lf" != 0 ]]; then
        printf 'leaf_migrate'
    elif [[ -n "${CD_MODULES_REASON:-}" ]]; then
        case "$CD_MODULES_REASON" in
            module_timeout | module_container_alive | module_infra) printf '%s' "$CD_MODULES_REASON" ;;
            *) printf 'module_upgrade' ;;
        esac
    elif [[ "$mf" != 0 ]]; then
        printf 'module_upgrade'
    else
        printf 'migrate'
    fi
}

_cd_drv_st_migrate() {
    local rc=0
    CD_MODULES_REASON=''
    CD_LEAVES_REASON=''
    _cd_drv_begin migrate "$(( $(cd_cfg CD_MODULE_UPGRADE_TIMEOUT_S) + 3 * $(cd_cfg CD_LEAF_MIGRATE_TIMEOUT_S) + 1800 ))"
    cd_data_migrate "$R_TREE" "$R_COL" || rc=$?
    cd_heartbeat_stop
    if ((rc != 0)); then
        cd_state_load
        CD_DRV_WHY="$(_cd_drv_migrate_detail)"
        _cd_drv_fail migrate "$rc" "$CD_DRV_WHY"
        return 0
    fi
    cd_stage_ok migrate || true
    return 0
}

_cd_drv_st_start() {
    local rc=0 secs=900
    CD_DRV_WHY=''
    cd_colour_start "$R_TREE" "$R_COL" "$R_TAG" || return $?
    _cd_drv_set '.release.workers = "off"'
    cd_wait_healthy "app-${R_COL}" "$secs" "$R_TREE" || rc=$?
    if ((rc == 3)); then
        CD_DRV_WHY=unhealthy
        return 1
    elif ((rc != 0)); then
        return "$rc"
    fi
    cd_colour_identity "$R_COL" "$R_TAG" || return $?
    return 0
}

_cd_drv_st_gates() {
    CD_COLOUR_REASON=''
    cd_colour_gates "$R_TREE" "$R_COL" "$R_TAG"
}

# _cd_drv_st_switch -- the live colour's own signals first (they only record
# rollback_target), then the switch, the confirm, and the workers: old off, THEN new on.
_cd_drv_st_switch() {
    local out rc=0 now
    out="$(cd_data_live_signal_read 2>/dev/null)" || out=""
    if [[ "$out" == *trigger* ]]; then
        _cd_drv_mail stopped sha12="$R_SHA12" tag="$R_TAG" colour="$R_COL" rule=watch_5xx reason=rollback_target_unusable \
            command="gremion-cd status" key="unusable.${R_ID}"
    fi
    _cd_drv_begin switch 600
    if ((CD_DRV_SWITCH_DONE == 0)); then
        cd_traffic_switch "$R_TREE" "$R_COL" || rc=$?
    fi
    CD_DRV_SWITCH_DONE=0
    if ((rc != 0)); then
        cd_heartbeat_stop
        _cd_drv_rollback_auto post_switch_verify switch
        return 0
    fi
    cd_traffic_confirm "$R_COL" || rc=$?
    if ((rc != 0)); then
        cd_heartbeat_stop
        _cd_drv_rollback_auto post_switch_verify switch
        return 0
    fi
    # the confirmed switch: the old colour's workers go off first, then the new colour's go on
    cd_colour_workers "$D_LCOL" off || rc=$?
    if ((rc == 0)); then
        cd_colour_workers "$R_COL" on || rc=$?
    fi
    if ((rc != 0)); then
        cd_heartbeat_stop
        _cd_drv_rollback_auto post_switch_verify switch
        return 0
    fi
    now="$(cd_iso)" || now=""
    _cd_drv_set '.release.workers = "on" | .release.switched_at = $t | .phase = "watching"' --arg t "$now"
    cd_heartbeat_stop
    cd_stage_ok switch || true
    return 0
}

# _cd_drv_st_watch -- the loop is commit.sh's. What it did is read back from the state: a
# rollback it ran ended the release, a park left phase `parked`, a clean window leaves the
# release watching.
_cd_drv_st_watch() {
    local rc=0 budget
    budget=$(( ($(cd_cfg CD_WATCH_MINUTES) + $(cd_cfg CD_PAUSE_MAX_MIN)) * 60 + 300 ))
    _cd_drv_begin watch "$budget"
    cd_commit_watch_loop || rc=$?
    cd_heartbeat_stop
    _cd_drv_load
    if [[ -z "$R_ID" || "$D_PHASE" == idle ]]; then
        # the loop ran a rollback (a trigger, proof_end or the operator's request)
        CD_DRV_ROLLED=1
        cd_hostlock_release
        return 0
    fi
    if [[ "$D_PHASE" == parked ]]; then
        return 3
    fi
    if [[ "$D_PHASE" == rolling_back ]]; then
        CD_DRV_ROLLED=1
        _cd_drv_after_rollback "$rc" loop
        return 0
    fi
    if ((rc != 0)); then
        # the loop failed on its own: not proof that the release is bad, so no block
        cd_stage_fail watch host watch_loop || true
        _cd_drv_rollback_auto commit_stuck watch
        return 0
    fi
    cd_stage_ok watch || true
    return 0
}

# _cd_drv_st_commit -- the commit point and what follows it up to the release of the host
# lock. On a committed release this is the forward finish of steps 6 to 10: cd_commit_promote
# is idempotent and does only what is left.
_cd_drv_st_commit() {
    local rc=0 sha12
    if [[ "$R_MODE" == proof ]]; then
        # a proof release is never committed: a clean window ends as the rollback `proof_end`
        # (it writes no block), whatever the watch loop did
        _cd_drv_rollback_auto proof_end commit
        return 0
    fi
    _cd_drv_begin commit $(( $(cd_cfg CD_COMMIT_MAX_MIN) * 60 + 300 ))
    cd_commit_promote || rc=$?
    if ((rc != 0)); then
        cd_heartbeat_stop
        _cd_drv_load
        # LINE-1: after commit step 5 nothing goes back, whatever the step that failed
        if cd_release_committed; then
            cd_stage_fail commit host post_commit || true
            _cd_drv_policy_committed commit host post_commit
        elif [[ -z "$R_ID" || "$D_PHASE" == idle ]]; then
            # promote ran the rollback itself (commit.sh at CD_COMMIT_MAX_MIN) and ended the
            # release: a second sequence would meet a release that is over
            CD_DRV_ROLLED=1
            cd_hostlock_release
        elif [[ "$D_PHASE" == rolling_back ]]; then
            CD_DRV_ROLLED=1
            _cd_drv_after_rollback "$rc" commit_stuck
        else
            _cd_drv_rollback_auto commit_stuck commit
        fi
        return 0
    fi
    _cd_drv_load
    sha12="$R_SHA12"
    if [[ -z "$R_COMMIT" ]]; then
        # promote said ok and wrote no committed_at: not a commit
        cd_heartbeat_stop
        cd_stage_fail commit host not_committed || true
        _cd_drv_rollback_auto commit_stuck commit
        return 0
    fi
    # the blocks this release contains are superseded, and the hold of the manual path clears
    if [[ "$R_MODE" == manual ]]; then
        cd_block_close_superseded "$sha12" || cd_err "driver: the blocks could not be closed"
    fi
    if [[ "$D_HOLD" == blocked ]] || _cd_drv_in_list "$D_HOLD" "$CD_DRV_CLASSIFIER_HOLDS"; then
        cd_hold_clear || true
    fi
    rm -f "$(_cd_drv_retry_file)" 2>/dev/null || true
    rc=0
    cd_commit_prune || rc=$?
    if ((rc != 0)); then
        cd_hist prune_failed code="$rc" || true
    fi
    # step 10: the host lock only. The cd lock stays for the reconcile stage.
    cd_hostlock_release
    cd_heartbeat_stop
    cd_stage_ok commit || true
    return 0
}

# _cd_drv_st_reconcile -- after the commit point, under the cd lock; never a rollback, never a
# block, never a re-run: a stage that was already started ends as `interrupted`.
_cd_drv_st_reconcile() {
    local rc=0 budget
    if [[ "$R_STATUS" == started || "$CD_DRV_RESUME_ONLY" == 1 ]]; then
        _cd_drv_end_interrupted
        return 0
    fi
    budget=$(( $(cd_cfg CD_RECONCILE_MAX_MIN) * 60 + $(cd_cfg CD_POST_RECONCILE_S) + 120 ))
    if [[ "$(cd_cfg CD_RECONCILE)" != 1 ]]; then
        cd_hist reconcile_skipped reason=disabled sha12="$R_SHA12" || true
        cd_stage_begin reconcile || true
        cd_stage_ok reconcile || true
        _cd_drv_end_release
        return 0
    fi
    _cd_drv_begin reconcile "$budget"
    _cd_drv_set '.phase = "releasing"'
    cd_reconcile_run || rc=$?
    cd_heartbeat_stop
    if ((rc != 0)); then
        # the stage's own outcome (hold, counts, mail) is cd_reconcile_run's; what is left for
        # the driver is to make sure a hold stands, and never to ask for a rollback
        _cd_drv_load
        if [[ "$D_HOLD" != reconcile_failed ]]; then
            _cd_drv_policy_committed reconcile host unknown
            return 0
        fi
        cd_stage_fail reconcile host "reconcile_${rc}" || true
        _cd_drv_end_release
        return 0
    fi
    cd_stage_ok reconcile || true
    _cd_drv_end_release
    return 0
}

# -- the pipeline loop ----------------------------------------------------------------
# _cd_drv_stuck STAGE -- the third attempt of a stage.
_cd_drv_stuck() {
    local stage="$1"
    cd_hist stuck_stage stage="$stage" sha12="$R_SHA12" || true
    if [[ -n "$R_COMMIT" ]]; then
        # LINE-3: a committed release only holds
        cd_hold_set stuck_stage "$(_cd_drv_code "$stage" stage)" "$R_SHA12" || true
        _cd_drv_mail stopped sha12="$R_SHA12" tag="$R_TAG" colour="$R_COL" reason=stuck_stage \
            command="gremion-cd resume" key="stuck.${R_ID}"
        _cd_drv_end_release
        cd_hostlock_release
    elif [[ "$R_SWITCH" == true ]]; then
        _cd_drv_rollback_auto commit_stuck "$stage"
    else
        _cd_drv_abort stuck
    fi
}

# _cd_drv_dispatch STAGE -- the attempt check, then the runner.
_cd_drv_dispatch() {
    local stage="$1" att
    if [[ "$R_STAGE" == "$stage" && "$R_STATUS" == started ]]; then
        att=$((R_ATT + 1))
    else
        att=1
    fi
    CD_DRV_ATT="$att"
    if ((att >= 3)) && [[ "$stage" != reconcile ]]; then
        _cd_drv_stuck "$stage"
        return 0
    fi
    case "$stage" in
        fetch) _cd_drv_run fetch 900 _cd_drv_st_fetch ;;
        classify) _cd_drv_st_classify ;;
        host_apply | state_apply) _cd_drv_apply_stage "$stage" ;;
        retag) _cd_drv_run retag 300 _cd_drv_st_retag ;;
        render) _cd_drv_run render 600 _cd_drv_st_render ;;
        build) _cd_drv_run build $(( $(cd_cfg CD_BUILD_TIMEOUT_MIN) * 60 * 3 + 1500 )) _cd_drv_st_build ;;
        snapshot) _cd_drv_st_snapshot ;;
        migrate) _cd_drv_st_migrate ;;
        start) _cd_drv_run start 1800 _cd_drv_st_start ;;
        gates) _cd_drv_run gates 1800 _cd_drv_st_gates ;;
        switch) _cd_drv_st_switch ;;
        watch) _cd_drv_st_watch ;;
        commit) _cd_drv_st_commit ;;
        reconcile) _cd_drv_st_reconcile ;;
        *) cd_err "driver: no runner for stage ${stage}"; return 2 ;;
    esac
}

# _cd_drv_boundary -- between two stages: the kill switch and the request queue. 0 go on, 1
# the release is over (or parked) in this process.
_cd_drv_boundary() {
    if cd_killswitch_active; then
        if [[ "$R_SWITCH" != true ]]; then
            cd_hist killswitch_abort stage="$R_STAGE" sha12="$R_SHA12" || true
            _cd_drv_abort killswitch
            return 1
        fi
        if [[ -z "$R_COMMIT" ]]; then
            _cd_drv_park || return 1
        fi
    fi
    _cd_drv_drain
    if ((CD_DRV_ROLLED == 1)); then
        return 1
    fi
    _cd_drv_load
    [[ -n "$R_ID" && "$D_PHASE" != idle && "$D_PHASE" != parked ]] || return 1
    return 0
}

# _cd_drv_park -- the kill switch while a release stands between its switch and its commit:
# the process stays alive with both locks, evaluates nothing, keeps its heartbeat, and every
# 15 seconds looks for the file to be gone (0) or for a rollback request (the sequence runs,
# 1). Automatic rollback is OFF while it waits.
_cd_drv_park() {
    local n=0
    _cd_drv_mail killswitch phase="$D_PHASE" sha12="$R_SHA12" stage="$R_STAGE" notes=rollback_off_lock_held \
        command="gremion-cd status" key="killswitch.${R_ID}" every=3600
    cd_hist killswitch_park stage="$R_STAGE" sha12="$R_SHA12" || true
    cd_heartbeat_start killswitch_park 3600 || true
    while cd_killswitch_active; do
        _cd_drv_drain
        if ((CD_DRV_ROLLED == 1)); then
            cd_heartbeat_stop
            return 1
        fi
        n=$((n + 1))
        if ((n % 100 == 0)); then
            cd_heartbeat_start killswitch_park 3600 || true
        fi
        cd_sleep 15
    done
    cd_heartbeat_stop
    cd_hist killswitch_cleared sha12="$R_SHA12" || true
    _cd_drv_load
    return 0
}

# _cd_drv_loop -- run the release from where the state says it is.
_cd_drv_loop() {
    local rc next kind code
    while :; do
        _cd_drv_load
        if [[ -z "$R_ID" || "$D_PHASE" == idle || "$D_PHASE" == parked ]]; then
            return 0
        fi
        if ((CD_DRV_ROLLED == 1)); then
            return 0
        fi
        # mail goes out between stages, but not while the new colour serves and the release has
        # not committed: a relay send then waits on the network with the heartbeat stopped
        if [[ "$R_SWITCH" != true || -n "$R_COMMIT" ]]; then
            cd_notify_flush >/dev/null 2>&1 || true
        fi
        # a reconcile stage that is already started, or any committed release met by the boot
        # unit, is ended instead of run (never run again); it needs no boundary checks
        if [[ -z "$R_COMMIT" ]] || [[ "$R_STAGE" != reconcile ]]; then
            _cd_drv_boundary || return 0
        fi
        if [[ "$R_STATUS" == failed ]]; then
            kind="$(printf '%s' "$CD_STATE_DOC" | jq -r '.release.failure.kind // "host"')"
            code="$(printf '%s' "$CD_STATE_DOC" | jq -r '.release.failure.code // ""')"
            # a policy that leaves the release as it was would loop for ever: stop with its code
            cd_failure_policy "$R_STAGE" "$kind" "$code" || return $?
            continue
        fi
        if [[ "$R_STATUS" == ok ]]; then
            next="$(_cd_drv_next_stage "$R_STAGE" "$R_WS")" || { cd_err "driver: unknown stage"; return 2; }
        else
            next="$R_STAGE"
        fi
        if [[ "$next" == end ]]; then
            _cd_drv_end_release
            return 0
        fi
        rc=0
        _cd_drv_dispatch "$next" || rc=$?
        if ((rc == 3)); then
            return 0
        elif ((rc != 0)); then
            return "$rc"
        fi
    done
}

# cd_pipeline_run -- a release that has just been selected (stage select ok, phase releasing).
cd_pipeline_run() {
    _cd_drv_loop
}

# cd_pipeline_resume -- a release in flight with no process: run it from where the state says.
# THE LINE: a committed release is finished forward or ended, never rolled back; before
# committed_at a crash in the switch stage is a rollback, a crash anywhere else re-runs the
# stage (the third attempt is `stuck_stage`).
cd_pipeline_resume() {
    local rc
    _cd_drv_load
    case "$D_PHASE" in
        rolling_back)
            _cd_drv_resume_rollback
            return 0
            ;;
        releasing | watching) ;;
        *) return 0 ;;
    esac
    if [[ -z "$R_ID" ]]; then
        cd_alert "state says a release is in flight but holds no release record"
        _cd_drv_set '.phase = "idle"'
        return 0
    fi
    # LINE-2: the committed side first; nothing below this check may choose a rollback for it
    if cd_release_committed; then
        _cd_drv_loop
        return 0
    fi
    if [[ "$R_SWITCH" == true && "$R_STATUS" != ok ]] && ! cd_killswitch_active; then
        case "$R_STAGE" in
            switch)
                # the call may have written the edge file and died in its poll: what serves is read
                # from the file and the Traefik API, never from our own state
                rc=0
                _cd_drv_switch_truth || rc=$?
                if ((rc == 0)); then
                    CD_DRV_SWITCH_DONE=1
                elif ((rc != 1)); then
                    cd_hist resume_crash stage=switch sha12="$R_SHA12" || true
                    _cd_drv_rollback_auto commit_stuck switch
                    return 0
                fi
                ;;
            commit | reconcile)
                # a crash in the commit before commit step 5 (or any later stage of a release
                # that never committed): the switch back. A crash in the watch is not this: the
                # loop resumes with its observed time.
                cd_hist resume_crash stage="$R_STAGE" sha12="$R_SHA12" || true
                _cd_drv_rollback_auto commit_stuck "$R_STAGE"
                return 0
                ;;
        esac
    fi
    _cd_drv_loop
    return 0
}

# _cd_drv_switch_truth -- what serves, after a crash in the switch stage: 0 the new colour
# (the call went through), 1 the old colour (it never wrote the file), 2 not known (the file and
# the API differ, or neither can be read). The answer of cd_traffic_truth names the colour(s) it
# read; a failure or two different colours is "not known".
_cd_drv_switch_truth() {
    local out cols n rc=0
    out="$(cd_traffic_truth 2>/dev/null)" || rc=$?
    ((rc == 0)) || return 2
    cols="$(printf '%s
' "$out" | grep -oE 'blue|green' | LC_ALL=C sort -u)" || return 2
    n="$(printf '%s
' "$cols" | grep -c .)" || n=0
    ((n == 1)) || return 2
    if [[ "$cols" == "$R_COL" ]]; then return 0; fi
    if [[ "$cols" == "$D_LCOL" ]]; then return 1; fi
    return 2
}

# _cd_drv_resume_rollback -- phase rolling_back with no process: the sequence is resumable and
# reads its own record; the rule is the one recorded, `manual_rollback` for a committed release.
_cd_drv_resume_rollback() {
    local rule rc=0
    rule="$(printf '%s' "$CD_STATE_DOC" | jq -r '.release.failure.code // "manual_rollback"')"
    # LINE-3 on the rolling_back path: a committed release only goes back by hand
    if [[ -n "$R_COMMIT" || -z "$R_ID" ]]; then
        rule=manual_rollback
    fi
    case "$rule" in
        post_switch_verify | watch_readiness | watch_crash | watch_5xx | watch_pause_cap | manual_rollback | commit_stuck | proof_end) ;;
        *) rule=commit_stuck ;;
    esac
    _cd_drv_rollback_call "$rule" || rc=$?
    _cd_drv_after_rollback "$rc" "$rule"
}

# -- candidates and the hold of a candidate ------------------------------------------
# _cd_drv_poll_store VERDICT FINAL TIP12 OK -- the driver owns state.poll (github.sh header).
_cd_drv_poll_store() {
    local v="$1" final="$2" tip12="$3" ok="$4" at n="" cur
    at="$(cd_iso)" || return 0
    if declare -F cd_gh_calls_hour >/dev/null 2>&1; then
        n="$(cd_gh_calls_hour 2>/dev/null)" || n=""
    fi
    [[ "$n" =~ ^[0-9]+$ ]] || n=""
    cur="$(printf '%s' "$CD_STATE_DOC" | jq -r '.poll.tip12')"
    [[ "$tip12" =~ ^[0-9a-f]{12}$ ]] || tip12="$cur"
    _cd_drv_set '.poll.last_at = $t | .poll.last_ok = $ok | .poll.tip12 = $tip | .poll.verdict = $v
                 | (if $n == "" then (.) else .poll.api_calls_hour = ($n | tonumber) end)' \
        --arg t "$at" --argjson ok "$ok" --arg tip "$tip12" --arg v "$v" --arg n "$n"
    : "$final"
}

# _cd_drv_hold_cmd KIND SHA12 -- the one command a classifier hold mail carries (words of the
# notifier's own list), nothing when stage 1 cannot apply it.
_cd_drv_hold_cmd() {
    case "$1" in
        state_tier) printf 'gremion-cd release-now %s --with-state' "$2" ;;
        ci_changed | batch_too_large | chain_class_changed) printf 'gremion-cd release-now %s' "$2" ;;
        range_unverified) printf 'gremion-cd release-now %s --accept-range --reason TEXT' "$2" ;;
        *) printf '' ;;
    esac
}

# _cd_drv_hold_candidate KIND REASON SHA12 [COMMITS] -- the hold of a candidate, mailed once
# per candidate. A hold that already stands for the same kind and commit changes nothing.
_cd_drv_hold_candidate() {
    local kind="$1" reason="$2" sha12="$3" commits="${4:-}" cmd rcode
    _cd_drv_load
    [[ "$reason" =~ ^[A-Za-z0-9_:./+-]{0,120}$ ]] || reason="$kind"
    if [[ "$D_HOLD" == "$kind" && "$D_HOLDSHA" == "$sha12" ]]; then
        return 0
    fi
    cd_hold_set "$kind" "$reason" "$sha12" || true
    # the range hold is mailed by github.sh, with the short SHAs it found
    if [[ "$kind" == range_unverified ]]; then
        return 0
    fi
    rcode="$(_cd_drv_code "${reason//[:.]/_}" "$kind")"
    cmd="$(_cd_drv_hold_cmd "$kind" "$sha12")"
    local -a m=(hold="$kind" reason="$rcode" sha12="$sha12" key="held.${kind}.${sha12}")
    [[ "$commits" =~ ^[0-9]+$ ]] && m+=(commits="$commits")
    [[ -n "$cmd" ]] && m+=(command="$cmd")
    _cd_drv_mail held "${m[@]}"
}

# _cd_drv_select SHA MODE WITH_STATE [REF] -- write the release record (stage select) and
# start the pipeline.
_cd_drv_select() {
    local sha="$1" mode="$2" ws="$3" ref="${4:-}" sha12 now iso colour rc=0
    sha12="${sha:0:12}"
    CD_DRV_STARTED=1
    _cd_drv_load
    colour="$(_cd_drv_other "$D_LCOL")"
    now="$(cd_now)" || return 2
    iso="$(cd_iso "$now")" || return 2
    if [[ -n "$ref" ]]; then
        printf '%s\n' "$ref" | cd_atomic_write "${CD_DATA}/release-ref" 600 || return 2
    fi
    _cd_drv_set '.phase = "releasing" | .release = {
        id: ($s12 + "-" + $n), sha: $sha, sha12: $s12, tag: ("pilot-" + $s12), colour: $c,
        tree: ($root + "/releases/" + $s12), from_sha12: $from, mode: $mode, with_state: $ws,
        stage: "select", stage_status: "ok", attempt: 1, class: null, dump_label: null,
        rollback_target: null, retag_prev: null, workers: "off", modules: null, leaves: null,
        switch_started: false, commit_attempts: 0, committed_at: null,
        timing: {snapshot_s: 0, module_s: 0}, started_at: $iso, switched_at: null,
        watch: {observed_s: 0, samples: 0, bad_streak: 0, paused_s: 0, blind: 0, requests: 0,
                baseline_5xx: null, baseline_not_ready: null, last_sample_epoch: 0},
        failure: null}' \
        --arg s12 "$sha12" --arg n "$now" --arg sha "$sha" --arg c "$colour" --arg root "$CD_ROOT" \
        --arg from "$D_LSHA12" --arg mode "$mode" --argjson ws "$ws" --arg iso "$iso"
    cd_hist release_start sha12="$sha12" mode="$mode" colour="$colour" || true
    # the baseline of the live colour, taken at the start of the release
    cd_watch_baseline >/dev/null 2>&1 || rc=$?
    if ((rc != 0)); then
        cd_hist baseline_unreadable code="$rc" || true
    fi
    cd_pipeline_run
}

# _cd_drv_start_gate -- may a release start now? The hold and the open blocks are the
# driver's; everything else (the kill switch, the policy acknowledgement, the mail checks, the
# quiet window, the locks, the live colour, the state project, the disk) is cd_prepare_precheck.
# 0 yes; 1 no, with the reason said once per change.
_cd_drv_start_gate() {
    local rc=0 why last f
    f="${CD_RUN}/last-refusal"
    CD_PREPARE_WHY=''
    cd_prepare_precheck || rc=$?
    if ((rc == 0)); then
        rm -f "$f" 2>/dev/null || true
        return 0
    fi
    # A refusal is not a failed release: nothing was started, so there is nothing to back off
    # from and no `stopped` mail (a gate that mailed on every tick would mail every five
    # minutes for as long as the disk stays low). It is said once per change in the history and
    # in `status`; the infrastructure rows (backoff, `stopped`) belong to the stages.
    why="$(_cd_drv_code "${CD_PREPARE_WHY:-}" unknown)"
    last=""
    if [[ -r "$f" ]]; then
        read -r last <"$f" || last=""
    fi
    _cd_drv_say "no release now: ${why}"
    if [[ "$last" != "$why" ]]; then
        cd_hist start_refused why="$why" code="$rc" || true
        if cd_mkdir "$CD_RUN"; then
            printf '%s\n' "$why" | cd_atomic_write "$f" 600 || true
        fi
    fi
    return 1
}

# _cd_drv_candidate -- the auto path of an idle tick: ask for the newest candidate, store the
# poll, hold what must be held, start what may start.
_cd_drv_candidate() {
    local out rc=0 verdict sha reason final tip12 pv commits gate
    out="$(cd_gh_candidate)" || rc=$?
    if ((rc != 0)) || ! printf '%s' "$out" | jq -e 'type == "object" and (.verdict | type == "string")' >/dev/null 2>&1; then
        cd_hist candidate_error code="$rc" || true
        _cd_drv_load
        _cd_drv_poll_store unknown false "" false
        return 0
    fi
    verdict="$(printf '%s' "$out" | jq -r '.verdict')"
    sha="$(printf '%s' "$out" | jq -r '.sha // ""')"
    reason="$(printf '%s' "$out" | jq -r '.reason // ""')"
    final="$(printf '%s' "$out" | jq -r '.final // false')"
    commits="$(printf '%s' "$out" | jq -r '.commits // ""')"
    tip12="$(printf '%s' "$out" | jq -r '(.tip // .sha // "")[0:12]')"
    case "$verdict" in
        green) pv=green ;;
        pending | unknown) pv="$verdict" ;;
        none | hold)
            if [[ "$final" == true ]]; then
                if [[ "$reason" == no_green_commit ]]; then pv=red; else pv=none; fi
            else
                pv=pending
            fi
            ;;
        *) pv=unknown ;;
    esac
    _cd_drv_load
    _cd_drv_poll_store "$pv" "$final" "$tip12" true
    _cd_drv_load
    case "$verdict" in
        hold)
            case "$reason" in
                not_ancestor | batch_too_large | blocked | range_unverified | ruleset_missing)
                    _cd_drv_hold_candidate "$reason" "$reason" "${sha:0:12}" "$commits"
                    ;;
                *) cd_hist candidate_hold_unknown reason="$(_cd_drv_code "$reason" other)" || true ;;
            esac
            ;;
        none)
            if [[ "$reason" == up_to_date ]] && _cd_drv_in_list "$D_HOLD" "$CD_DRV_CLASSIFIER_HOLDS"; then
                cd_hold_clear || true
            fi
            ;;
        green)
            [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { cd_err "driver: the candidate sha is not a full sha"; return 0; }
            if _cd_drv_in_list "$D_HOLD" "$CD_DRV_CLASSIFY_ONLY" && [[ "$D_HOLDSHA" == "${sha:0:12}" ]]; then
                _cd_drv_say "held: ${D_HOLD} for the same candidate; nothing to do"
                return 0
            fi
            _cd_drv_start_gate || return 0
            rc=0
            _cd_drv_retry_gate "${sha:0:12}" || rc=$?
            if ((rc == 3)); then
                _cd_drv_say "waiting: the backoff after an infrastructure failure has not ended"
                return 0
            elif ((rc == 2)); then
                gate=infra_retries
                cd_hold_set failure "$gate" "${sha:0:12}" || true
                _cd_drv_mail stopped sha12="${sha:0:12}" reason="$gate" command="gremion-cd resume" key="stopped.${sha:0:12}.${gate}"
                rm -f "$(_cd_drv_retry_file)" 2>/dev/null || true
                return 0
            fi
            _cd_drv_select "$sha" auto false
            ;;
    esac
    return 0
}

# -- the request queue ------------------------------------------------------------------
# _cd_drv_drain -- every pending request, oldest first. The arguments are checked again here:
# the verb that wrote the file checked them once, but the file is data.
_cd_drv_drain() {
    local req verb args
    while req="$(cd_request_next)" && [[ -n "$req" ]]; do
        verb="$(printf '%s' "$req" | jq -r '.verb')"
        args="$(printf '%s' "$req" | jq -c '.args')"
        case "$verb" in
            hold) _cd_drv_do_hold "$args" ;;
            resume) _cd_drv_do_resume "$args" ;;
            rollback)
                # one rollback per release: a second request meets a release that is already
                # over (and an idle host), where the same verb would take the LIVE release back
                # to `previous`, which was never proven against the schema of the one just
                # rolled back. The request is consumed and said so; the operator may ask again.
                if ((CD_DRV_ROLLED == 1)); then
                    cd_hist rollback_refused why=already_rolled_back || true
                    _cd_drv_say "rollback refused: this release was already rolled back"
                else
                    _cd_drv_do_rollback "$args"
                fi
                ;;
            release-now) _cd_drv_do_release_now "$args" ;;
            *) cd_hist request_ignored verb="$verb" || true ;;
        esac
    done
    return 0
}

_cd_drv_reason_ok() {
    [[ "${1-}" != *[[:cntrl:]]* && ${#1} -le 200 ]]
}

_cd_drv_do_hold() {
    local reason
    reason="$(printf '%s' "$1" | jq -r '.reason // ""')"
    _cd_drv_reason_ok "$reason" || reason=""
    _cd_drv_load
    cd_hold_set operator requested "$D_HOLDSHA" || true
    cd_hist hold_requested reason="${reason:-none}" || true
    _cd_drv_say "hold set"
}

# _cd_drv_do_resume ARGS -- plain resume, --accept-descendants, --discard-dump, and the
# re-entry of a parked watch.
_cd_drv_do_resume() {
    local args="$1" reason accept discard nblocks label live rc=0
    reason="$(printf '%s' "$args" | jq -r '.reason // ""')"
    accept="$(printf '%s' "$args" | jq -r '.accept_descendants // false')"
    discard="$(printf '%s' "$args" | jq -r '.discard_dump // false')"
    _cd_drv_reason_ok "$reason" || { cd_hist resume_refused why=reason || true; return 0; }
    _cd_drv_load
    if [[ "$D_PHASE" == parked ]]; then
        rc=0
        _cd_drv_hostlock_wait tick || rc=$?
        if ((rc != 0)); then
            cd_hist resume_refused why=host_lock || true
            _cd_drv_say "resume refused: the host lock is busy"
            return 0
        fi
        # a fresh pause budget and a fresh attempt: a second park in one window is not a stage
        # that keeps dying, and the third attempt would roll the release back on its own
        _cd_drv_set '.phase = "watching" | .release.watch.paused_s = 0 | .release.attempt = 0'
        cd_hold_clear || true
        cd_hist resumed_parked sha12="$R_SHA12" || true
        cd_pipeline_resume
        return 0
    fi
    if [[ -z "$D_HOLD" ]]; then
        return 0
    fi
    if _cd_drv_in_list "$D_HOLD" "$CD_DRV_CLASSIFIER_HOLDS"; then
        cd_hist resume_refused why=classifier_hold kind="$D_HOLD" || true
        return 0
    fi
    cd_blocks_load
    nblocks="$(printf '%s' "$CD_BLOCKS_DOC" | jq -r '[.[] | select(.cleared == null)] | length')"
    if ((nblocks > 0)) && [[ "$accept" != true ]]; then
        cd_hist resume_refused why=open_blocks count="$nblocks" || true
        _cd_drv_say "resume refused: ${nblocks} block(s) are open"
        return 0
    fi
    if [[ "$D_PHASE" == idle ]]; then
        live="$(cd_data_dumpset_live 2>/dev/null </dev/null)" || live="?"
        if [[ -n "${live//[[:space:]]/}" ]]; then
            if [[ "$discard" != true ]]; then
                cd_hist resume_refused why=dump_live || true
                _cd_drv_say "resume refused: a dump set is live; restore or discard it, or resume with --discard-dump"
                return 0
            fi
            if [[ "$live" == "?" ]]; then
                cd_hist resume_refused why=dump_unreadable || true
                return 0
            fi
            while IFS= read -r label; do
                [[ -n "$label" ]] || continue
                cd_data_dumpset_discard "$label" "resume --discard-dump by the operator" || {
                    cd_hist resume_refused why=discard_failed || true
                    return 0
                }
            done <<<"$live"
        fi
    fi
    if [[ "$accept" == true ]]; then
        [[ -n "$reason" ]] || { cd_hist resume_refused why=no_reason || true; return 0; }
        cd_block_clear_all "$reason" || true
        _cd_drv_mail held hold=none reason=blocks_cleared key="blocks_cleared.$(cd_now)"
    fi
    cd_hold_clear || true
    cd_hist resumed reason="${reason:-none}" || true
    rm -f "${CD_DATA}/retry" 2>/dev/null || true
    _cd_drv_say "resumed"
}

# _cd_drv_do_rollback ARGS -- before the switch: abort, hold operator, no block; after it: the
# sequence; after the commit point: one release back, when `previous` can start.
_cd_drv_do_rollback() {
    local reason rc=0
    reason="$(printf '%s' "$1" | jq -r '.reason // ""')"
    _cd_drv_reason_ok "$reason" || reason=""
    cd_hist rollback_requested reason="${reason:-none}" || true
    _cd_drv_load
    case "$D_PHASE" in
        releasing | watching | rolling_back)
            if [[ "$D_PHASE" != rolling_back && -z "$R_COMMIT" && "$R_SWITCH" != true ]]; then
                _cd_drv_abort operator
                CD_DRV_ROLLED=1
                return 0
            fi
            # the process holds the locks (the host lock only until the commit point): a
            # committed release goes one release back, and takes the host lock first
            _cd_drv_hostlock_wait tick || rc=$?
            if ((rc != 0)); then
                _cd_drv_say "rollback not run: the host lock is busy"
                cd_hist rollback_refused why=host_lock || true
                return 0
            fi
            _cd_drv_manual_rollback
            ;;
        idle)
            if [[ -z "$D_LSHA12" ]]; then
                _cd_drv_say "rollback refused: no release is live"
                return 0
            fi
            if [[ -z "$D_PSHA12" || "$D_PSTART" != true ]]; then
                _cd_drv_say "rollback refused: the previous release cannot start (its colour was retagged); use gremion-rollback by hand, then gremion-cd adopt --re-adopt"
                cd_hist rollback_refused why=not_startable || true
                return 0
            fi
            _cd_drv_hostlock_wait tick || rc=$?
            if ((rc != 0)); then
                _cd_drv_say "rollback not run: the host lock is busy"
                cd_hist rollback_refused why=host_lock || true
                return 0
            fi
            _cd_drv_manual_rollback
            ;;
        parked)
            _cd_drv_hostlock_wait tick || rc=$?
            if ((rc != 0)); then
                _cd_drv_say "rollback not run: the host lock is busy"
                return 0
            fi
            _cd_drv_manual_rollback
            ;;
    esac
}

# _cd_drv_manual_rollback -- the operator's rollback: the one rule a committed release accepts.
_cd_drv_manual_rollback() {
    local rc=0
    CD_DRV_ROLLED=1
    _cd_drv_set '.phase = "rolling_back"'
    _cd_drv_rollback_call manual_rollback || rc=$?
    _cd_drv_after_rollback "$rc" manual_rollback
}

# _cd_drv_do_release_now ARGS -- the verbs's request: judge the named candidate with the flags
# and start it.
_cd_drv_do_release_now() {
    local args="$1" target ws force accept reason ref unverified out rc=0 verdict sha creason
    local -a cargs=(--allow-blocked --allow-batch)
    target="$(printf '%s' "$args" | jq -r '.target // ""')"
    ws="$(printf '%s' "$args" | jq -r '.with_state // false')"
    force="$(printf '%s' "$args" | jq -r '.force_blocked // false')"
    accept="$(printf '%s' "$args" | jq -r '.accept_range // false')"
    reason="$(printf '%s' "$args" | jq -r '.reason // ""')"
    ref="$(printf '%s' "$args" | jq -r '.ref // ""')"
    unverified="$(printf '%s' "$args" | jq -r '.unverified // false')"
    _cd_drv_load
    if [[ "$D_PHASE" != idle ]]; then
        _cd_drv_say "release-now refused: a release is in flight"
        cd_hist release_now_refused why=busy || true
        return 0
    fi
    if _cd_drv_in_list "$D_HOLD" "$CD_DRV_RESUME_HOLDS"; then
        _cd_drv_say "release-now refused: the hold ${D_HOLD} needs resume first"
        cd_hist release_now_refused why=hold kind="$D_HOLD" || true
        return 0
    fi
    [[ "$target" =~ ^([0-9a-f]{12,40}|main)$ ]] || { cd_hist release_now_refused why=target || true; return 0; }
    _cd_drv_reason_ok "$reason" || { cd_hist release_now_refused why=reason || true; return 0; }
    if [[ "$accept" == true && -z "$reason" ]]; then
        _cd_drv_say "release-now refused: --accept-range needs --reason"
        cd_hist release_now_refused why=no_reason || true
        return 0
    fi
    if [[ "$unverified" == true ]]; then
        if [[ "$(cd_cfg CD_PROOF_MODE)" != 1 ]]; then
            _cd_drv_say "release-now refused: --unverified works only with CD_PROOF_MODE=1"
            cd_hist release_now_refused why=proof_mode_off || true
            return 0
        fi
        [[ "$ref" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { cd_hist release_now_refused why=ref || true; return 0; }
    fi
    [[ "$force" == true ]] && cargs=(--force-blocked --allow-batch)
    if [[ "$accept" == true ]]; then
        cargs+=(--accept-range "$reason")
        cd_hist range_accept_requested sha12="${target:0:12}" || true
    fi
    if [[ "$unverified" == true ]]; then
        # proof mode: the commit comes from the proof repository's branch, not from main
        [[ "$target" =~ ^[0-9a-f]{40}$ ]] || { _cd_drv_say "release-now refused: a proof release names a full sha"; return 0; }
        cd_gh_proof_source "$target" "$ref" || {
            _cd_drv_say "release-now refused: the proof branch could not be fetched"
            cd_hist release_now_refused why=proof_source || true
            return 0
        }
        _cd_drv_start_gate || return 0
        CD_DRV_ROLLED=0
        _cd_drv_select "$target" proof false "$ref"
        return 0
    fi
    [[ "$target" == main ]] || cargs+=("$target")
    out="$(cd_gh_candidate "${cargs[@]}")" || rc=$?
    if ((rc != 0)) || ! printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; then
        _cd_drv_say "release-now refused: no verdict"
        cd_hist release_now_refused why=no_verdict || true
        return 0
    fi
    verdict="$(printf '%s' "$out" | jq -r '.verdict')"
    sha="$(printf '%s' "$out" | jq -r '.sha // ""')"
    creason="$(printf '%s' "$out" | jq -r '.reason // ""')"
    if [[ "$verdict" != green ]]; then
        _cd_drv_say "release-now refused: ${verdict} ${creason}"
        cd_hist release_now_refused why="$(_cd_drv_code "${verdict}_${creason}" candidate)" || true
        return 0
    fi
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 0
    _cd_drv_start_gate || return 0
    # a new release is not rolled back yet, whatever ended the one before it in this tick: it
    # runs now (its loop stops at once for a process that has rolled back), and a rollback
    # request that meets it is for it
    CD_DRV_ROLLED=0
    _cd_drv_select "$sha" manual "$ws"
}

# -- the operator verbs ---------------------------------------------------------------
# cd_cmd_release_now <sha12|main> [--with-state] [--force-blocked] [--accept-range --reason
# TEXT] [--ref BRANCH --unverified]
cd_cmd_release_now() {
    local target="" ws=false force=false accept=false reason="" ref="" unverified=false
    (($# >= 1)) || cd_die 2 "usage: gremion-cd release-now <sha12|main> [--with-state] [--force-blocked] [--accept-range --reason TEXT] [--ref BRANCH --unverified]"
    while (($# > 0)); do
        case "$1" in
            --with-state) ws=true; shift ;;
            --force-blocked) force=true; shift ;;
            --accept-range) accept=true; shift ;;
            --unverified) unverified=true; shift ;;
            --reason)
                (($# >= 2)) || cd_die 2 "release-now: --reason needs a value"
                reason="$2"
                shift 2
                ;;
            --ref)
                (($# >= 2)) || cd_die 2 "release-now: --ref needs a value"
                ref="$2"
                shift 2
                ;;
            -*) cd_die 2 "release-now: unknown flag" ;;
            *)
                [[ -z "$target" ]] || cd_die 2 "release-now: one commit only"
                target="$1"
                shift
                ;;
        esac
    done
    [[ "$target" =~ ^([0-9a-f]{12}|[0-9a-f]{40}|main)$ ]] || cd_die 2 "release-now: name a commit by its 12 hex characters (or main)"
    cd_arg_reason "$reason"
    if [[ "$accept" == true && -z "$reason" ]]; then
        cd_die 2 "release-now: --accept-range needs --reason TEXT (it is logged and mailed)"
    fi
    if [[ -n "$reason" && "$accept" != true ]]; then
        cd_die 2 "release-now: --reason belongs to --accept-range"
    fi
    if [[ "$unverified" == true ]]; then
        [[ "$(cd_cfg CD_PROOF_MODE)" == 1 ]] || cd_die 2 "release-now: --unverified works only with CD_PROOF_MODE=1"
        [[ -n "$ref" ]] || cd_die 2 "release-now: --unverified needs --ref BRANCH"
    elif [[ -n "$ref" ]]; then
        cd_die 2 "release-now: --ref belongs to --unverified"
    fi
    cd_state_load
    local kind phase
    kind="$(printf '%s' "$CD_STATE_DOC" | jq -r '.hold.kind // empty')"
    phase="$(printf '%s' "$CD_STATE_DOC" | jq -r '.phase')"
    if [[ "$phase" != idle ]]; then
        cd_err "release-now refused: a release is in flight (phase ${phase})"
        return 3
    fi
    if _cd_drv_in_list "$kind" "$CD_DRV_RESUME_HOLDS"; then
        cd_err "release-now refused: the hold ${kind} needs resume first (after adopt --re-adopt when the host was changed by hand)"
        [[ "$kind" == reconcile_failed ]] && cd_err "for reconcile_failed: gremion-cd reconcile re-runs the stage"
        return 2
    fi
    cd_request_put release-now "$(jq -cn --arg t "$target" --argjson ws "$ws" --argjson f "$force" --argjson a "$accept" \
        --arg r "$reason" --arg ref "$ref" --argjson u "$unverified" \
        '{target: $t, with_state: $ws, force_blocked: $f, accept_range: $a, reason: $r, ref: $ref, unverified: $u}')" || return $?
    cd_request_kick
}

# cd_cmd_rollback [--reason TEXT]
cd_cmd_rollback() {
    local reason="" phase sha prev start
    while (($# > 0)); do
        case "$1" in
            --reason)
                (($# >= 2)) || cd_die 2 "rollback: --reason needs a value"
                reason="$2"
                shift 2
                ;;
            *) cd_die 2 "rollback: unknown argument (usage: gremion-cd rollback [--reason TEXT])" ;;
        esac
    done
    cd_arg_reason "$reason"
    cd_state_load
    phase="$(printf '%s' "$CD_STATE_DOC" | jq -r '.phase')"
    if [[ "$phase" == idle ]]; then
        sha="$(printf '%s' "$CD_STATE_DOC" | jq -r '.live.sha12 // empty')"
        prev="$(printf '%s' "$CD_STATE_DOC" | jq -r '.previous.sha12 // empty')"
        start="$(printf '%s' "$CD_STATE_DOC" | jq -r '.previous.startable // false')"
        if [[ -z "$sha" ]]; then
            cd_err "rollback refused: no release is live"
            return 2
        fi
        if [[ -z "$prev" || "$start" != true ]]; then
            cd_err "rollback refused: the previous release cannot start (its colour was retagged since)."
            cd_err "Use gremion-rollback by hand, then: gremion-cd adopt --re-adopt --reason TEXT"
            return 2
        fi
    fi
    cd_request_put rollback "$(jq -cn --arg reason "$reason" '{reason: $reason}')" || return $?
    cd_request_kick
}

# cd_cmd_reconcile -- re-run the reconcile stage for the live release. Idle only, whatever
# CD_RECONCILE says; clears reconcile_failed when every customer is ok.
cd_cmd_reconcile() {
    local rc=0 phase release hold
    (($# == 0)) || cd_die 2 "usage: gremion-cd reconcile"
    cd_state_load
    phase="$(printf '%s' "$CD_STATE_DOC" | jq -r '.phase')"
    # parked first and on its own: there `current` is the old tree and runtime/active-colour
    # names the new colour, and the stage's order guard would refuse it anyway
    if [[ "$phase" == parked ]]; then
        cd_err "reconcile refused: the release is parked (the new colour serves, current is the old tree)"
        return 2
    fi
    if [[ "$phase" == releasing || "$phase" == watching || "$phase" == rolling_back ]]; then
        cd_err "reconcile refused: a release is in flight (phase ${phase})"
        return 3
    fi
    cd_lock_take || rc=$?
    if ((rc == 3)); then
        cd_err "reconcile: another gremion-cd is running"
        return 3
    elif ((rc != 0)); then
        return "$rc"
    fi
    _cd_drv_load
    release="$R_ID"
    if [[ "$D_PHASE" != idle || -n "$release" ]]; then
        cd_err "reconcile refused: a release is in flight"
        cd_locks_release
        return 3
    fi
    if [[ -z "$D_LSHA12" ]]; then
        cd_err "reconcile refused: no release is live"
        cd_locks_release
        return 2
    fi
    cd_heartbeat_start reconcile $(( $(cd_cfg CD_RECONCILE_MAX_MIN) * 60 + $(cd_cfg CD_POST_RECONCILE_S) + 120 )) || true
    rc=0
    cd_reconcile_run || rc=$?
    cd_heartbeat_stop
    _cd_drv_load
    hold="$D_HOLD"
    if ((rc == 0)); then
        if [[ "$hold" == reconcile_failed ]]; then
            cd_hold_clear || true
        fi
        cd_hist reconcile_verb result=ok sha12="$D_LSHA12" || true
        _cd_drv_say "reconcile: every customer is ok"
    else
        if [[ "$hold" != reconcile_failed ]]; then
            cd_hold_set reconcile_failed unknown "$D_LSHA12" || true
        fi
        cd_hist reconcile_verb result=failed code="$rc" sha12="$D_LSHA12" || true
        _cd_drv_say "reconcile: not every customer is ok; the hold reconcile_failed stands"
    fi
    cd_notify_flush >/dev/null 2>&1 || true
    cd_locks_release
    return "$rc"
}

# -- the tick ---------------------------------------------------------------------------
# _cd_drv_host_lock_gone -- a committed release whose commit stage ended ok has let go of the
# host lock at step 10 (a crash between its end and the begin of the reconcile stage): the next
# stage runs under the cd lock only, and a park would hold nothing worth the name. Not so for a
# manual rollback of that release (phase rolling_back): a rollback runs under the host lock.
_cd_drv_host_lock_gone() {
    [[ -n "$R_COMMIT" && "$R_STAGE" == commit && "$R_STATUS" == ok && "$D_PHASE" != rolling_back ]]
}

# _cd_drv_inflight_locks -- the locks a resumed release needs. The host lock is taken first
# for a release the boot unit resumes and for every release at or after `snapshot`, waiting
# up to CD_LOCK_WAIT_S; a committed release in the reconcile stage, or one whose commit stage has
# ended ok, needs none (the host lock went at commit step 10).
_cd_drv_inflight_locks() {
    local need=0 idx snap rc=0
    _cd_drv_load
    if [[ -n "$R_COMMIT" && "$R_STAGE" == reconcile ]]; then
        return 0
    fi
    if _cd_drv_host_lock_gone; then
        return 0
    fi
    if [[ "$CD_DRV_RESUME_ONLY" == 1 ]]; then
        need=1
    elif [[ "$D_PHASE" == watching || "$D_PHASE" == rolling_back ]]; then
        need=1
    elif [[ -n "$R_STAGE" ]]; then
        idx="$(_cd_drv_stage_index "$R_STAGE")" || idx=0
        snap="$(_cd_drv_stage_index snapshot)"
        ((idx >= snap)) && need=1
    fi
    ((need == 1)) || return 0
    _cd_drv_hostlock_wait tick || rc=$?
    if ((rc != 0)); then
        _cd_drv_say "the host lock is busy; the release waits"
        return "$rc"
    fi
    return 0
}

# _cd_drv_tick_inflight -- a release that has no process.
_cd_drv_tick_inflight() {
    local rc=0
    _cd_drv_load
    # the one exception to every park: a committed release in its reconcile stage is ended
    if [[ -n "$R_COMMIT" && "$R_STAGE" == reconcile && "$R_STATUS" != ok ]]; then
        _cd_drv_end_interrupted
        return 0
    fi
    _cd_drv_inflight_locks || return $?
    if cd_killswitch_active; then
        # phase rolling_back is past the line whatever the record says: an idle manual rollback
        # has no release record at all (so no switch_started), and its half-run sequence is
        # parked, never ended as if it were a release that had not switched
        if [[ "$D_PHASE" != rolling_back && "$R_SWITCH" != true && -z "$R_COMMIT" ]]; then
            cd_hist killswitch_abort stage="$R_STAGE" sha12="$R_SHA12" || true
            _cd_drv_abort killswitch
            return 0
        fi
        # a park holds the host lock and says so in its mail: one that has let the lock go
        # (a committed release whose commit stage ended) goes on forward, as in the process
        if [[ -z "$R_COMMIT" || "$R_STAGE" != reconcile ]] && ! _cd_drv_host_lock_gone; then
            _cd_drv_park || return 0
        fi
    fi
    cd_pipeline_resume || rc=$?
    return "$rc"
}

# _cd_drv_tick_idle -- nothing in flight: the requests, the kill switch, the holds, a candidate.
_cd_drv_tick_idle() {
    _cd_drv_drain
    _cd_drv_load
    [[ "$D_PHASE" == idle ]] || return 0
    # a request that started a release was this tick's one thing
    ((CD_DRV_STARTED == 0)) || return 0
    if cd_killswitch_active; then
        _cd_drv_mail killswitch phase=idle command="gremion-cd status" key="killswitch.idle"
        return 0
    fi
    if [[ -n "$D_HOLD" ]] && ! _cd_drv_in_list "$D_HOLD" "$CD_DRV_CLASSIFIER_HOLDS"; then
        _cd_drv_say "held: ${D_HOLD}"
        return 0
    fi
    _cd_drv_candidate
}

# cd_cmd_tick [--resume-only]
cd_cmd_tick() {
    local rc=0 lrc=0 flavour=normal ran=0
    while (($# > 0)); do
        case "$1" in
            --resume-only) CD_DRV_RESUME_ONLY=1; shift ;;
            *) cd_die 2 "tick: unknown argument (usage: gremion-cd tick [--resume-only])" ;;
        esac
    done
    CD_DRV_ROLLED=0
    CD_DRV_STARTED=0
    if [[ ! -f "$CD_STATE_FILE" ]]; then
        cd_alert "no state file: gremion-cd adopt has not run"
        cd_die 2 "no state file (gremion-cd adopt has not run)"
    fi
    if [[ "$CD_DRV_RESUME_ONLY" == 1 ]]; then
        # an idle or parked host has nothing to resume: exit at once, no lock
        cd_state_load
        case "$(printf '%s' "$CD_STATE_DOC" | jq -r '.phase')" in
            idle | parked) return 0 ;;
        esac
        flavour=resume
    fi
    trap 'cd_heartbeat_stop' EXIT
    trap 'cd_heartbeat_stop; exit 143' TERM
    cd_lock_take || lrc=$?
    if ((lrc == 3)); then
        _cd_drv_say "another gremion-cd is running"
        return 3
    elif ((lrc != 0)); then
        cd_alert "the cd lock could not be taken"
        cd_die 2 "the cd lock could not be taken"
    fi
    _cd_drv_load
    # the watchdog expects the tick to rewrite the heartbeat on every run, an idle one too (a
    # stage or a park replaces this beat with its own); the budget bounds an idle tick's poll
    cd_heartbeat_start tick 600 || cd_err "driver: the heartbeat did not start"
    case "$D_PHASE" in
        releasing | watching | rolling_back)
            ran=1
            _cd_drv_tick_inflight || rc=$?
            ;;
        parked)
            # a request that ends the park (resume, rollback) is this tick's one thing, so the
            # next candidate is not asked for in the same run
            ran=1
            _cd_drv_drain
            ;;
    esac
    if [[ "$flavour" == resume ]]; then
        # no drain here: a request left for the release this process rolled back would be the
        # next tick's idle rollback of the live release
        if ((CD_DRV_ROLLED == 1)); then
            _cd_drv_consume_rollbacks
        fi
        cd_notify_flush >/dev/null 2>&1 || true
        cd_heartbeat_stop
        cd_locks_release
        return "$rc"
    fi
    _cd_drv_load
    if ((rc != 0 && CD_DRV_ROLLED == 1)); then
        # the drain below is skipped: see the resume flavour above
        _cd_drv_consume_rollbacks
    fi
    if ((rc == 0)) && [[ "$D_PHASE" == idle ]]; then
        if ((ran == 1)); then
            # a tick that has just run a release does one thing: the next candidate waits for the
            # next tick (an explicit request of the operator is still taken)
            _cd_drv_drain
        else
            _cd_drv_tick_idle || rc=$?
            if ((rc == 0 && CD_DRV_STARTED == 1)); then
                # a request the release itself left (the reconcile stage's failure path says "the
                # request is left for the driver") waits for no next tick; no new candidate is asked
                _cd_drv_load
                if [[ "$D_PHASE" == idle ]]; then
                    _cd_drv_drain
                fi
            fi
        fi
    fi
    if ! cd_killswitch_active; then
        cd_notify_digest >/dev/null 2>&1 || true
    fi
    cd_notify_flush >/dev/null 2>&1 || true
    if ((rc == 0)); then
        cd_ping >/dev/null 2>&1 || true
    fi
    cd_heartbeat_stop
    cd_locks_release
    return "$rc"
}
