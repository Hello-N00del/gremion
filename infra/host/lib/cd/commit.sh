#!/usr/bin/env bash
# infra/host/lib/cd/commit.sh - the end of a release of the continuous deployment program:
# the watch loop, the commit point and the prune.
#
# SOURCED, NEVER EXECUTED. Like colour.sh and watch.sh it sets no shell options and runs
# nothing at the top level except plain assignments: the program that sources it owns the
# options. It calls core.sh (cd_state_load, cd_state_set, cd_cfg, cd_now, cd_iso, cd_sleep,
# cd_hist, cd_hold_set, cd_hold_clear, cd_killswitch_active, cd_hb_write, cd_heartbeat_start,
# cd_heartbeat_stop, cd_atomic_write, cd_mkdir), notify.sh (cd_notify), watch.sh
# (cd_watch_sample, cd_watch_eval), rollback.sh (cd_rollback_run), colour.sh
# (cd_colour_isolation_record, cd_colour_down, cd_colour_workers), data.sh
# (cd_data_dumpset_retire), docker.sh (cd_dc) and common.sh (executor_unit_action) when they
# exist, and docker, jq, timeout, df and coreutils.
#
# WHAT IS HERE
#   cd_commit_watch_loop    the watch stage: a sample every CD_WATCH_INTERVAL_S, evaluated by
#                           cd_watch_eval, until the OBSERVED time (release.watch.observed_s,
#                           which the evaluation keeps) reaches CD_WATCH_MINUTES. A trigger runs
#                           cd_rollback_run with its rule. A `rollback` request is taken within
#                           one sample (and only that verb: every other request stays queued for
#                           the driver, so a `hold` is never lost and never stops the loop). The
#                           kill switch parks IN PLACE: the process stays alive with the cd lock
#                           and the host lock, stops evaluating triggers, keeps writing its own
#                           heartbeat and polls every 15 seconds for the file to be gone (the watch
#                           goes on with the same observed time) or for a `rollback` request.
#                           A `parked` verdict (the pause cap) sets phase parked and the hold
#                           `failure`, queues a mail and releases the HOST lock; entering the loop
#                           again at phase `parked` is the resume: the host lock is taken again, the
#                           pause budget starts fresh. A proof release whose window ends clean is
#                           rolled back with the rule proof_end (no block) and is never committed.
#   cd_commit_promote       the commit point, steps 1 to 8. Steps 1 to 5
#                           retry as ONE sequence inside this process every 60 seconds with the
#                           host lock never released, for at most CD_COMMIT_MAX_MIN; at the cap the
#                           release is rolled back with the rule commit_stuck (no block). Step 5 is
#                           ONE atomic state write (live, previous and release.committed_at) and is
#                           THE commit point; from it no path of this file can reach
#                           cd_rollback_run except the operator's own `rollback` request. Steps 6
#                           to 8 retry per step every 60 seconds; at the cap the hold `failure`
#                           (reason post_commit_<n>) and a mail are written and the release stays
#                           committed. It releases no lock: the driver runs the prune and step 10.
#                           The kill switch is looked at at every boundary of the stage: before each
#                           of steps 1 to 5, before step 6, 7 and 8 and so on a resume into the stage
#                           too. While the file exists the process parks in place as the watch does
#                           (both locks held, nothing further moves) and the time spent there is not
#                           counted against CD_COMMIT_MAX_MIN. An operator `rollback` request that
#                           the rollback refuses (nothing touched) is consumed, mailed
#                           (rollback_failed, reason rollback_refused) and ends nothing: the park
#                           goes on, the retries go on, steps 6 to 8 finish or reach their hold.
#   cd_commit_prune         the builder cache when the disk is low, the images of pilot-<12 hex>
#                           tags outside the keep set, the release trees outside live, previous, in
#                           flight, what `current` names and what a running container mounts from,
#                           and the logs of the program (logs/cd-<name>.log) older than 14 days.
#
# RETURN CODES (stage functions: 0 ok - 1 failure attributable to the commit - 2 usage or a
# missing precondition - 3 waiting - 4 infrastructure, retryable)
#   cd_commit_watch_loop  0 the window ended clean and complete (the caller runs the commit
#                         point); 1 the release was rolled back here (a trigger, the operator's
#                         request or proof_end; the state says how it ended); 2 a precondition (no
#                         release, a committed release, a phase that is not watching, a lock not
#                         held); 3 the release is parked (the pause cap: phase parked, host lock
#                         released); 4 the loop could not judge (eight samples in a row gave no
#                         verdict) or the rollback that a TRIGGER asked for was refused or busy with
#                         nothing touched: the release is still watching, in flight, with both locks
#                         held. The plan gives the driver no rule for it (commit_stuck is defined for
#                         the commit steps 1 to 5 only), so what it does with a 4 is the driver's
#                         decision (unit U14a); this file promises nothing. A rollback that the
#                         OPERATOR asks for and that is refused is never a 4: it is mailed and the
#                         watch goes on (in the kill switch park too). A trigger on a release whose
#                         rollback target is unusable leaves the process waiting in place, both
#                         locks held, for that operator rollback (it never returns 3: the host lock
#                         is handed back only by the pause cap and by a complete rollback).
#   cd_commit_promote     0 committed and steps 6 to 8 done; 1 not done: a rollback ran (the
#                         operator's request, or commit_stuck at the cap; cd_rollback_run owns the
#                         state and the hold it leaves, and after a complete one there is no release
#                         any more) or, after step 5, step 6 or 7 was given up with the hold
#                         `failure` (post_commit_<n>). A caller tells the cases apart with
#                         cd_release_committed and the hold. 2 a precondition (nothing is touched):
#                         no release, a proof release, a phase that is not watching, a window that
#                         is not complete, a lock not held. 4 the rollback at the cap (commit_stuck)
#                         was refused or busy with nothing touched (a code 2 or 3 AND a state that
#                         did not move): the release is still in flight and the driver decides. A
#                         rollback that began (any code 0, 1 or 4, or a phase that is no longer
#                         watching) is a 1 whatever it answered, and the state says how it stands.
#   cd_commit_prune       0 done (a removal that failed is a history line); 2 no live release;
#                         4 the keep set could not be computed (nothing was removed).
#
# THE LINE. Nothing here calls cd_rollback_run for a committed release except the operator's
# `rollback` request (manual_rollback). The functions that follow step 5 never name another rule.
#
# WHAT THIS FILE DOES NOT OWN. The observed time, the two samples after a resume that may not
# trigger, and the worker-gate verdicts are cd_watch_eval's (watch.sh): the loop reads
# release.watch.observed_s and applies the `flip <colour> on|off` lines the evaluation prints.
# The moment the host lock was taken is the driver's: it may set CD_HOSTLOCK_SINCE (an epoch) after
# cd_hostlock_take, and the `released` mail then carries hostlock_min and, past CD_LOCK_SPAN_MIN,
# the note lock_span_over; without it those two are left out. Moving `current` and the tag files
# back after a rollback at the cap (commit_stuck) is cd_rollback_run's step, not this file's.
#
# THE REAL-DATA BOUNDARY. Names of components and stages, colours, tags, codes and counts only.
# Image references are never printed; the release trees and logs are named by their short SHA.

# shellcheck disable=SC2016  # the jq programs are single-quoted on purpose
# shellcheck disable=SC2034  # the CM_ variables are shared between the functions of this file

_cd_commit_err() { printf 'cd-commit: %s\n' "$*" >&2; }

# How long one sleep of a wait is, and how often a parked process looks around. A test shortens
# the park poll with GREMION_CD_PARK_POLL_S (honoured only with GREMION_CD_TESTING=1), so a
# parked process does not move the fake clock.
_CD_COMMIT_POLL_S=15
_CD_COMMIT_RETRY_S=60
# Samples in a row that give no verdict: the loop gives up (4). The release stays in flight and the
# driver decides: unknown is never green, and this file never reads it as a trigger.
_CD_COMMIT_UNUSABLE_MAX=8
# Seconds that a kill switch park has taken from the retry cap of the sequence that is waiting.
_CD_COMMIT_PARKED_S=0
# The epoch at which the window of the steps after the commit point (6 and 7) began.
_CD_COMMIT_FWD_START=""

# _cd_commit_int KEY - the config value as a whole number; 2 when it is not one.
_cd_commit_int() {
    local v
    v="$(cd_cfg "$1" 2>/dev/null)" || { _cd_commit_err "the config key $1 cannot be read"; return 2; }
    [[ "$v" =~ ^[0-9]{1,9}$ ]] || { _cd_commit_err "the config key $1 is not a whole number"; return 2; }
    printf '%s\n' "$((10#$v))"
}

# _cd_commit_load - the state into the CM_ variables. Called DIRECTLY (cd_state_load exits the
# program on an unreadable state, which must never read as "no release" or "not committed").
_cd_commit_load() {
    local line
    cd_state_load
    line="$(printf '%s' "$CD_STATE_DOC" | jq -r '[
        .phase, (.release.mode // ""), (.release.committed_at // ""), (.release.id // ""),
        (.release.sha12 // ""), (.release.tag // ""), (.release.colour // ""), (.release.tree // ""),
        (.live.sha12 // ""), (.live.tag // ""), (.live.colour // ""), (.live.tree // ""),
        (.previous.sha12 // ""), (.previous.tag // ""), (.previous.colour // ""), (.previous.tree // ""),
        (.release.rollback_target // ""), ((.release.watch.observed_s // 0) | floor | tostring),
        (.release.dump_label // ""), (.hold.kind // ""), (.hold.reason // "")] | join("|")')" || return 2
    IFS='|' read -r CM_PHASE CM_MODE CM_COMMITTED CM_ID CM_SHA12 CM_TAG CM_COLOUR CM_TREE \
        CM_LIVE_SHA12 CM_LIVE_TAG CM_LIVE_COLOUR CM_LIVE_TREE \
        CM_PREV_SHA12 CM_PREV_TAG CM_PREV_COLOUR CM_PREV_TREE \
        CM_TARGET CM_OBSERVED CM_DUMP CM_HOLD_KIND CM_HOLD_REASON <<<"$line"
    return 0
}

# _cd_commit_locks_held - both locks belong to this process.
_cd_commit_locks_held() {
    [[ "${CD_LOCK_PID:-}" == "$$" && "${CD_HOSTLOCK_PID:-}" == "$$" ]]
}

# _cd_commit_hb_budget STAGE - the heartbeat budget the driver gives that stage.
_cd_commit_hb_budget() {
    local a b
    case "$1" in
        watch)
            a="$(_cd_commit_int CD_WATCH_MINUTES)" || return 2
            b="$(_cd_commit_int CD_PAUSE_MAX_MIN)" || return 2
            printf '%s\n' "$(((a + b) * 60 + 300))"
            ;;
        *)
            a="$(_cd_commit_int CD_COMMIT_MAX_MIN)" || return 2
            printf '%s\n' "$((a * 60 + 300))"
            ;;
    esac
}

# -- requests -----------------------------------------------------------------------------
# _cd_commit_take_rollback_request - 0 when a pending `rollback` request was taken (moved to
# processed/), 1 when there is none. Only that verb is looked at: a `hold`, a `resume` or a
# `release-now` stays queued for the driver, so none of them is consumed and lost here. A file
# that is not a well-formed request is left alone for the driver's own reject.
_cd_commit_take_rollback_request() {
    local f base size
    [[ -d "$CD_REQUEST_DIR" ]] || return 1
    while IFS= read -r f; do
        [[ -n "$f" && -f "$f" && ! -L "$f" ]] || continue
        base="${f##*/}"
        [[ "$base" =~ ^[0-9]{1,12}-[0-9]{4}-rollback\.json$ ]] || continue
        size="$(stat -c %s "$f" 2>/dev/null)" || continue
        [[ "$size" =~ ^[0-9]+$ ]] || continue
        ((size <= 65536)) || continue
        if ! jq -s -e 'length == 1 and (.[0] | type == "object" and .v == 1 and .verb == "rollback" and (.args | type == "object"))' \
            "$f" >/dev/null 2>&1; then
            continue
        fi
        cd_mkdir "${CD_REQUEST_DIR}/processed" || return 1
        mv -f -- "$f" "${CD_REQUEST_DIR}/processed/${base}" || return 1
        return 0
    done < <(find "$CD_REQUEST_DIR" -maxdepth 1 -type f -name '*-rollback.json' 2>/dev/null | LC_ALL=C sort)
    return 1
}

# _cd_commit_rollback RULE - cd_rollback_run, and what the caller must return. 1 when the
# sequence ran (code 0 rolled back, code 1 did not complete, code 4 an infrastructure failure of
# a sequence that is resumable and may have run in part: the state says which); 4 when it was
# refused or busy with nothing touched (the release is still in flight). Only a code the sequence
# gives for a refusal (2 a precondition, 3 busy, or a code it does not define) AND a state that is
# still the one of the call (the same release, still watching or releasing) is a refusal: a
# sequence that began is never reported as one, because the caller would go on with the commit.
_cd_commit_rollback() {
    local rule="$1" rc=0 id0 phase0
    _cd_commit_load || true
    id0="$CM_ID"
    phase0="$CM_PHASE"
    cd_hist rollback_call rule="$rule" || true
    cd_rollback_run "$rule" || rc=$?
    case "$rc" in
        0 | 1 | 4) return 1 ;;
    esac
    # a state that cannot be read, or one that moved, proves nothing about "nothing was touched"
    _cd_commit_load || return 1
    if [[ "$CM_ID" != "$id0" || "$CM_PHASE" != "$phase0" ]]; then return 1; fi
    case "$CM_PHASE" in
        watching | releasing) ;;
        *) return 1 ;;
    esac
    _cd_commit_err "the rollback (${rule}) was refused or is busy (code ${rc}); nothing was touched"
    return 4
}

# _cd_commit_run_requested STAGE DURING - the operator's `rollback` request was taken: the
# sequence runs. 0 it ran (the state says how it ended; the caller returns), 1 it was refused or
# busy with nothing touched: the request is consumed, a history line and a critical mail say so,
# and the caller goes on as if the request had not come (the release is still what it was).
_cd_commit_run_requested() {
    local stage="$1" during="$2" rc=0 prev_sha prev_colour
    cd_hist rollback_requested during="$during" stage="$stage" || true
    _cd_commit_rollback manual_rollback || rc=$?
    if ((rc != 4)); then return 0; fi
    cd_hist rollback_refused during="$during" stage="$stage" || true
    prev_sha="$CM_LIVE_SHA12"
    prev_colour="$CM_LIVE_COLOUR"
    if [[ -n "$CM_COMMITTED" ]]; then
        prev_sha="$CM_PREV_SHA12"
        prev_colour="$CM_PREV_COLOUR"
    fi
    cd_notify rollback_failed "key=${CM_ID}-manual-refused" every=3600 "sha12=${CM_SHA12}" "prev_sha12=${prev_sha}" \
        "tag=${CM_TAG}" "colour=${CM_COLOUR}" "prev_colour=${prev_colour}" "stage=${stage}" rule=manual_rollback \
        reason=rollback_refused command="gremion-cd status" || true
    return 1
}

# _cd_commit_gate STAGE - the kill switch at a boundary of the commit stage (its start, between
# its steps, before step 6, 7 and 8): while the file exists the process parks in place, as the
# watch does. 0 go on, 10 a rollback the operator asked for ran (the caller returns 1).
_cd_commit_gate() {
    local rc=0
    cd_killswitch_active || return 0
    _cd_commit_park "$1" || rc=$?
    if ((rc == 10)); then return 10; fi
    return 0
}

# -- the kill switch ----------------------------------------------------------------------
# _cd_commit_poll - the wait between two looks of a parked process.
_cd_commit_poll() {
    local s="$_CD_COMMIT_POLL_S"
    if [[ "${GREMION_CD_TESTING:-}" == 1 && -n "${GREMION_CD_PARK_POLL_S:-}" ]]; then
        s="$GREMION_CD_PARK_POLL_S"
    fi
    sleep "$s"
}

# _cd_commit_park STAGE - the kill switch while a release is in its watch or its commit: the
# process stays alive holding both locks, evaluates nothing, writes its own heartbeat and polls
# for the file to be gone (return 0) or for an operator `rollback` request (the sequence runs,
# return 10). One critical mail per hour says that automatic rollback is OFF and that the host
# lock is held. The time spent here is added to _CD_COMMIT_PARKED_S, so the retry cap of the
# sequence that is waiting does not run out while the operator holds the switch.
_cd_commit_park() {
    local stage="$1" t0 now rearm=0
    # an unreadable state is no reason to leave the park (10 would say "a rollback ran"): the
    # variables of the last good read name the release for the mails
    _cd_commit_load || _cd_commit_err "park: the state could not be read; the process parks with what it knew"
    cd_hist killswitch_park stage="$stage" sha12="$CM_SHA12" || true
    t0="$(cd_now)" || t0=0
    if [[ -n "${CD_HB_PID:-}" ]]; then rearm=1; fi
    # this process is the heartbeat while it waits: the background beat is progress-bounded and
    # would stop, and a heartbeat that stops is the dead-man's signal for a stuck release
    cd_heartbeat_stop
    while cd_killswitch_active; do
        cd_notify killswitch "key=killswitch.${CM_ID}" every=3600 "phase=${CM_PHASE}" "sha12=${CM_SHA12}" "stage=${stage}" \
            notes=rollback_off_lock_held command="gremion-cd status" || true
        if _cd_commit_take_rollback_request; then
            # the sequence ran (return 10), or it was refused with nothing touched: the process
            # stays parked, because leaving the park with the switch still on would hand the
            # release back to a caller that answers with an automatic rollback
            if _cd_commit_run_requested "$stage" killswitch; then return 10; fi
        fi
        now="$(cd_now)" || now=0
        cd_hb_write "$stage" "$now" 300 "$$" || true
        _cd_commit_poll
    done
    now="$(cd_now)" || now="$t0"
    _CD_COMMIT_PARKED_S=$((_CD_COMMIT_PARKED_S + now - t0))
    cd_hist killswitch_cleared stage="$stage" sha12="$CM_SHA12" || true
    if ((rearm == 1)); then
        cd_heartbeat_start "$stage" "$(_cd_commit_hb_budget "$stage")" || true
    fi
    return 0
}

# _cd_commit_wait_operator STAGE - a watch trigger met a release whose old colour cannot be
# switched back to (rollback_target unusable): the process stays alive holding both locks, judges
# nothing further, writes its own heartbeat and polls for the operator's `rollback` request. It
# returns only when that sequence ran (the state says how it ended); a request the rollback
# refuses with nothing touched is consumed, mailed, and the wait goes on. Leaving by killing the
# process leaves the phase as it is (watching): the resume path of the next tick takes the locks
# again and the next trigger lands here again.
_cd_commit_wait_operator() {
    local stage="$1" now
    cd_heartbeat_stop
    while :; do
        if _cd_commit_take_rollback_request; then
            if _cd_commit_run_requested "$stage" unusable; then return 0; fi
        fi
        now="$(cd_now)" || now=0
        cd_hb_write "$stage" "$now" 300 "$$" || true
        _cd_commit_poll
    done
}

# _cd_commit_nap SECONDS STAGE - a wait that stays responsive: it looks for the kill switch and
# for a `rollback` request before every slice of at most 15 seconds. 0 slept (the caller goes
# on), 10 a rollback ran (the caller returns 1).
_cd_commit_nap() {
    local rem="$1" stage="$2" step rc
    while ((rem > 0)); do
        if cd_killswitch_active; then
            rc=0
            _cd_commit_park "$stage" || rc=$?
            if ((rc == 10)); then return 10; fi
        fi
        if _cd_commit_take_rollback_request; then
            # a refused rollback ends nothing: the retries go on, the operator has been told
            if _cd_commit_run_requested "$stage" retry; then return 10; fi
        fi
        step="$_CD_COMMIT_POLL_S"
        if ((rem < step)); then step="$rem"; fi
        cd_sleep "$step"
        rem=$((rem - step))
    done
    return 0
}

# -- the watch loop -------------------------------------------------------------------------
# _cd_commit_parse_eval OUTPUT - the verdict on line 1 (CM_VERDICT, empty when it is not one of
# the words of cd_watch_eval) and the `flip <colour> on|off` instructions (CM_FLIPS).
_cd_commit_parse_eval() {
    local out="$1" line first=1 rule
    CM_VERDICT=""
    CM_FLIPS=()
    while IFS= read -r line; do
        if ((first == 1)); then
            first=0
            case "$line" in
                ok | bad | paused | parked) CM_VERDICT="$line" ;;
                trigger:*)
                    rule="${line#trigger:}"
                    if [[ "$rule" =~ ^[a-z][a-z0-9_]{0,40}$ ]]; then CM_VERDICT="$line"; fi
                    ;;
            esac
            continue
        fi
        if [[ "$line" =~ ^flip\ (blue|green)\ (on|off)$ ]]; then
            CM_FLIPS+=("${BASH_REMATCH[1]} ${BASH_REMATCH[2]}")
        fi
    done <<<"$out"
    return 0
}

# _cd_commit_apply_flips - the worker gate files the evaluation says have diverged: every `off`
# first, and the `on` instructions only when every `off` was written (old off, THEN new on).
# A failed write is a history line and the next sample asks again.
_cd_commit_apply_flips() {
    local f colour mode failed=0
    for f in ${CM_FLIPS[@]+"${CM_FLIPS[@]}"}; do
        colour="${f%% *}"
        mode="${f##* }"
        [[ "$mode" == off ]] || continue
        cd_colour_workers "$colour" off || { failed=1; cd_hist worker_gate_failed colour="$colour" mode=off || true; }
    done
    ((failed == 0)) || return 0
    for f in ${CM_FLIPS[@]+"${CM_FLIPS[@]}"}; do
        colour="${f%% *}"
        mode="${f##* }"
        [[ "$mode" == on ]] || continue
        cd_colour_workers "$colour" on || cd_hist worker_gate_failed colour="$colour" mode=on || true
    done
    return 0
}

# _cd_commit_enter_parked REASON MAILKIND - the park of the watch: phase parked and the hold
# `failure` first, then the mail, and the host lock LAST, so the lock is never free while the
# state still says the release is being watched. The new colour keeps serving and `current` is
# still the old tree. MAILKIND is `parked` (the mail of the pause cap) or `none`.
_cd_commit_enter_parked() {
    local reason="$1" mailkind="$2" observed paused
    cd_state_set '.phase = "parked"' || return 1
    cd_hold_set failure "$reason" "$CM_SHA12" || true
    observed="$(cd_state_get '(.release.watch.observed_s // 0) | floor' 2>/dev/null)" || observed=0
    paused="$(cd_state_get '(.release.watch.paused_s // 0) | floor' 2>/dev/null)" || paused=0
    [[ "$observed" =~ ^[0-9]+$ ]] || observed=0
    [[ "$paused" =~ ^[0-9]+$ ]] || paused=0
    if [[ "$mailkind" == parked ]]; then
        cd_notify parked "key=${CM_ID}" every=3600 "sha12=${CM_SHA12}" "prev_sha12=${CM_LIVE_SHA12}" "colour=${CM_COLOUR}" \
            "prev_colour=${CM_LIVE_COLOUR}" stage=watch rule=watch_pause_cap "observed_min=$((observed / 60))" \
            "paused_min=$((paused / 60))" command="gremion-cd resume" || true
    fi
    cd_hist parked reason="$reason" sha12="$CM_SHA12" || true
    cd_hostlock_release
    return 0
}

# _cd_commit_unpark - the resume: the host lock is taken again (3 when it stays busy), the pause
# budget starts fresh, phase is watching and the hold the park wrote is cleared.
_cd_commit_unpark() {
    local wait rc=0
    wait="$(_cd_commit_int CD_LOCK_WAIT_S)" || return 2
    if [[ "${CD_HOSTLOCK_PID:-}" != "$$" ]]; then
        cd_hostlock_take "$wait" || rc=$?
        if ((rc != 0)); then
            _cd_commit_err "the host lock is busy; the release stays parked"
            return 3
        fi
    fi
    cd_state_set '.phase = "watching" | .release.watch.paused_s = 0' || return 2
    if [[ "$CM_HOLD_KIND" == failure && "$CM_HOLD_REASON" == watch_pause_cap ]]; then
        cd_hold_clear || true
    fi
    cd_hist unparked sha12="$CM_SHA12" || true
    return 0
}

cd_commit_watch_loop() {
    local interval window_s rc out sample t0 now dur slp broken=0 rule
    interval="$(_cd_commit_int CD_WATCH_INTERVAL_S)" || return 2
    window_s="$(_cd_commit_int CD_WATCH_MINUTES)" || return 2
    window_s=$((window_s * 60))
    _cd_commit_load || return 2
    if [[ -z "$CM_ID" ]]; then
        _cd_commit_err "watch: there is no release in the state"
        return 2
    fi
    if [[ -n "$CM_COMMITTED" ]]; then
        _cd_commit_err "watch: the release is committed; there is nothing to watch"
        return 2
    fi
    if [[ "$CM_PHASE" == parked ]]; then
        [[ "${CD_LOCK_PID:-}" == "$$" ]] || { _cd_commit_err "watch: the cd lock is not held"; return 2; }
        rc=0
        _cd_commit_unpark || rc=$?
        if ((rc != 0)); then return "$rc"; fi
        _cd_commit_load || return 2
    fi
    case "$CM_PHASE" in
        watching | releasing) ;;
        *) _cd_commit_err "watch: the phase is not watching"; return 2 ;;
    esac
    _cd_commit_locks_held || { _cd_commit_err "watch: the cd lock and the host lock must both be held"; return 2; }
    while :; do
        if cd_killswitch_active; then
            rc=0
            _cd_commit_park watch || rc=$?
            if ((rc == 10)); then return 1; fi
        fi
        if _cd_commit_take_rollback_request; then
            # the sequence ran (the state says how it ended): the loop is over. A rollback that was
            # refused with nothing touched is mailed and ends nothing: the watch goes on
            if _cd_commit_run_requested watch watch; then return 1; fi
        fi
        _cd_commit_load || return 2
        if [[ -z "$CM_ID" || "$CM_PHASE" == idle ]]; then
            _cd_commit_err "watch: the release is gone from the state"
            return 1
        fi
        if ((CM_OBSERVED >= window_s)); then
            if [[ "$CM_MODE" == proof ]]; then
                rc=0
                _cd_commit_rollback proof_end || rc=$?
                return "$rc"
            fi
            return 0
        fi
        t0="$(cd_now)" || return 2
        sample=""
        rc=0
        sample="$(cd_watch_sample)" || rc=$?
        CM_VERDICT=""
        CM_FLIPS=()
        if ((rc == 0)) && [[ -n "$sample" ]]; then
            out=""
            rc=0
            out="$(cd_watch_eval "$sample")" || rc=$?
            if ((rc == 0)); then _cd_commit_parse_eval "$out"; fi
        fi
        if [[ -z "$CM_VERDICT" ]]; then
            # unknown is never green and never a trigger: after eight of them the loop returns 4 (see the header)
            broken=$((broken + 1))
            cd_hist watch_sample_unusable count="$broken" || true
            if ((broken >= _CD_COMMIT_UNUSABLE_MAX)); then
                _cd_commit_err "watch: ${broken} samples in a row gave no verdict; giving up with the release in flight"
                return 4
            fi
        else
            broken=0
            _cd_commit_apply_flips
            case "$CM_VERDICT" in
                trigger:*)
                    rule="${CM_VERDICT#trigger:}"
                    _cd_commit_load || return 2
                    if [[ "$CM_TARGET" == unusable ]]; then
                        # there is nothing to go back to: the new colour stays and the operator is told.
                        # The host lock is NOT handed back (the new colour serves the migrated schema,
                        # `current` is the old tree and the old colour is known to fail on that schema;
                        # the one early release of the lock is the pause cap): the process waits in
                        # place for the operator's `rollback`
                        cd_notify rollback_failed "key=${CM_ID}" every=3600 "sha12=${CM_SHA12}" "prev_sha12=${CM_LIVE_SHA12}" \
                            "tag=${CM_TAG}" "colour=${CM_COLOUR}" "prev_colour=${CM_LIVE_COLOUR}" stage=watch "rule=${rule}" \
                            reason=rollback_target_unusable command="gremion-cd status" || true
                        cd_hist rollback_skipped rule="$rule" reason=target_unusable || true
                        _cd_commit_wait_operator watch
                        return 1
                    fi
                    rc=0
                    _cd_commit_rollback "$rule" || rc=$?
                    return "$rc"
                    ;;
                parked)
                    _cd_commit_load || return 2
                    _cd_commit_enter_parked watch_pause_cap parked || return 4
                    return 3
                    ;;
            esac
        fi
        now="$(cd_now)" || return 2
        dur=$((now - t0))
        slp=$((interval - dur))
        if ((slp < 1)); then slp=1; fi
        cd_sleep "$slp"
    done
}

# -- the commit point -------------------------------------------------------------------------

# step 1: the isolation record of the new tip (the enable gate refuses a stale tip).
_cd_commit_step1() {
    cd_colour_isolation_record "$CM_TREE"
}

# step 2: `current` to the new tree, a symlink swap, read back. The temporary link has its own
# name, never the one gremion-deploy uses.
_cd_commit_step2() {
    local root="${CD_ROOT}" tmp cur
    tmp="${root}/current.cd-commit.tmp"
    [[ -d "$CM_TREE" ]] || { _cd_commit_err "step 2: the release tree is not a directory"; return 2; }
    ln -sfn "$CM_TREE" "$tmp" || return 1
    mv -T -f -- "$tmp" "${root}/current" || { rm -f -- "$tmp"; return 1; }
    cur="$(readlink "${root}/current" 2>/dev/null)" || cur=""
    if [[ "$cur" != "$CM_TREE" ]]; then
        _cd_commit_err "step 2: current does not point at the release tree"
        return 1
    fi
    return 0
}

# step 3: runtime/current-tag and previous-tag, both from the STATE (the live release is still
# the old one), never from the file: a retry after this step has run would otherwise write the
# new tag as the previous one.
_cd_commit_step3() {
    local dir="${CD_ROOT}/runtime" prev
    prev="$CM_LIVE_TAG"
    [[ -n "$prev" ]] || prev=none
    printf '%s\n' "$prev" | cd_atomic_write "${dir}/previous-tag" 644 || return 1
    printf '%s\n' "$CM_TAG" | cd_atomic_write "${dir}/current-tag" 644 || return 1
    return 0
}

# _cd_commit_timed SECONDS CMD ARGS... - a shell function (which `timeout` cannot run) with a time
# limit and no stdin. It runs in a subshell that has let go of both lock descriptors, so a command
# that outlives its limit cannot keep a lock of this process alive; at the limit the subshell and
# its children are terminated (killed five seconds later). Returns the code of the command (143 or
# 137 when the limit ran out).
_cd_commit_timed() {
    local t="$1" pid wd rc=0
    shift
    ( exec 8>&- 9>&-; "$@" ) </dev/null &
    pid=$!
    (
        exec 8>&- 9>&-
        sleep "$t"
        pkill -TERM -P "$pid" 2>/dev/null
        kill -TERM "$pid" 2>/dev/null
        sleep 5
        pkill -KILL -P "$pid" 2>/dev/null
        kill -KILL "$pid" 2>/dev/null
    ) >/dev/null 2>&1 &
    wd=$!
    wait "$pid" 2>/dev/null || rc=$?
    pkill -TERM -P "$wd" 2>/dev/null
    kill -TERM "$wd" 2>/dev/null
    { wait "$wd"; } 2>/dev/null || true
    return "$rc"
}

# step 4: the executor re-reads its handlers from current/. A warning, never a failure, and never
# longer than a minute: a synchronous systemctl that hangs would hold the host lock for as long.
_cd_commit_step4() {
    local t=60
    if [[ "${GREMION_CD_TESTING:-}" == 1 && "${GREMION_CD_EXEC_TIMEOUT_S:-}" =~ ^[0-9]{1,4}$ ]]; then
        t="$GREMION_CD_EXEC_TIMEOUT_S"
    fi
    if declare -F executor_unit_action >/dev/null 2>&1; then
        _cd_commit_timed "$t" executor_unit_action try-restart || _cd_commit_err "step 4: the executor could not be restarted (a warning)"
    fi
    return 0
}

# step 5: THE COMMIT POINT. One atomic state write: live = the new release, previous = the old
# live release, the module and leaf counts copied, release.committed_at = now.
_cd_commit_step5() {
    local iso
    iso="$(cd_iso)" || return 1
    cd_state_set '
        .previous = {sha: .live.sha, sha12: .live.sha12, tag: .live.tag, colour: .live.colour, tree: .live.tree, startable: true}
        | .live = {sha: .release.sha, sha12: .release.sha12, tag: .release.tag, colour: .release.colour,
                   tree: .release.tree, since: $now, proof: false, modules: (.release.modules // null),
                   leaves: (.release.leaves // null), reconcile: null}
        | .release.committed_at = $now' --arg now "$iso" || return 1
    cd_hist committed sha12="$CM_SHA12" colour="$CM_COLOUR" || true
    return 0
}

# step 6: `gremion-migration-dump switched` for this release (the dump set is retired, and the
# post-condition on the ledger is cd_data_dumpset_retire's). The tag is the label of the set
# that kernel-api-migrate and the host `take` share; a label the release recorded that differs
# from it (a state-tier set) goes with it.
_cd_commit_step6() {
    local label prev="" rc=0
    declare -F cd_data_dumpset_retire >/dev/null 2>&1 || { _cd_commit_err "step 6: the dump set library is not installed"; return 2; }
    for label in "$CM_TAG" "$CM_DUMP"; do
        [[ -n "$label" && "$label" != "$prev" ]] || continue
        prev="$label"
        cd_data_dumpset_retire "$label" || rc=$?
    done
    return "$rc"
}

# step 7: the old colour project goes down. Its images, env file, tree and (off) worker file
# stay: one release back stays startable. cd_colour_down refuses a colour that serves.
_cd_commit_step7() {
    if [[ -z "$CM_PREV_TREE" || -z "$CM_PREV_COLOUR" ]]; then
        _cd_commit_err "step 7: the state names no previous release"
        return 2
    fi
    cd_colour_down "$CM_PREV_TREE" "$CM_PREV_COLOUR"
}

# step 8: the `released` mail, queued once (the key is the release id, so a resumed step 6 to 8
# does not send it again). Counts and durations only.
_cd_commit_step8() {
    local line since now span cap
    local -a args=()
    line="$(printf '%s' "$CD_STATE_DOC" | jq -r '
        def n: if type == "number" then (floor | tostring) else "" end;
        [(((.release.watch.observed_s // 0) / 60) | n), (.release.watch.requests | n),
         (.release.modules.total | n), (.release.modules.upgraded | n), (.release.modules.failed | n),
         (.release.leaves.total | n), (.release.leaves.migrated | n), (.release.leaves.skipped | n),
         (.release.leaves.failed | n), (.release.timing.snapshot_s | n), (.release.timing.module_s | n)]
        | join("|")')" || line=""
    local om rq mt mu mf lt lm ls lf ss ms
    IFS='|' read -r om rq mt mu mf lt lm ls lf ss ms <<<"$line"
    args=("sha12=${CM_SHA12}" "prev_sha12=${CM_PREV_SHA12}" "tag=${CM_TAG}" "colour=${CM_COLOUR}" "prev_colour=${CM_PREV_COLOUR}")
    [[ -n "$om" ]] && args+=("observed_min=${om}")
    [[ -n "$rq" ]] && args+=("requests=${rq}")
    [[ -n "$mt" ]] && args+=("modules_total=${mt}" "modules_upgraded=${mu}" "modules_failed=${mf}")
    [[ -n "$lt" ]] && args+=("leaves_total=${lt}" "leaves_migrated=${lm}" "leaves_skipped=${ls}" "leaves_failed=${lf}")
    [[ -n "$ss" ]] && args+=("snapshot_s=${ss}")
    [[ -n "$ms" ]] && args+=("module_s=${ms}")
    args+=("dump_label=${CM_TAG}")
    local -a notes=()
    if [[ "$(cd_cfg CD_RECONCILE 2>/dev/null)" != 1 ]]; then notes+=(reconcile_not_run); fi
    since="${CD_HOSTLOCK_SINCE:-}"
    if [[ "$since" =~ ^[0-9]{1,12}$ ]]; then
        now="$(cd_now)" || now="$since"
        span=$(((now - since) / 60))
        args+=("hostlock_min=${span}")
        cap="$(_cd_commit_int CD_LOCK_SPAN_MIN)" || cap=0
        if ((cap > 0 && span > cap)); then notes+=(lock_span_over); fi
    fi
    if ((${#notes[@]} > 0)); then
        args+=("notes=$(IFS=,; printf '%s' "${notes[*]}")")
    fi
    cd_notify released "key=${CM_ID}" "${args[@]}" || true
    return 0
}

# _cd_commit_forward N FN - one step after the commit point, retried every 60 seconds for at
# most CD_COMMIT_MAX_MIN: a mail after the third failure, and at the cap the hold `failure`
# (reason post_commit_N) with a mail. Never a rollback and never a block. 0 done, 1 given up
# (or a rollback the operator asked for ran).
_cd_commit_forward() {
    local n="$1" fn="$2" cap start now fails=0 rc elapsed
    cap="$(_cd_commit_int CD_COMMIT_MAX_MIN)" || return 1
    cap=$((cap * 60))
    # one window for steps 6 and 7 together (cd_commit_promote starts it), so the host lock is held
    # for at most CD_COMMIT_MAX_MIN after the commit point, not once per step
    start="$_CD_COMMIT_FWD_START"
    [[ "$start" =~ ^[0-9]+$ ]] || return 1
    while :; do
        _cd_commit_load || return 1
        rc=0
        _cd_commit_gate commit || rc=$?
        if ((rc == 10)); then return 1; fi
        rc=0
        "$fn" || rc=$?
        if ((rc == 0)); then return 0; fi
        fails=$((fails + 1))
        cd_hist commit_forward_failed step="$n" attempt="$fails" code="$rc" || true
        if ((fails == 3)); then
            cd_notify stopped "key=${CM_ID}-post-commit-${n}-retry" "sha12=${CM_SHA12}" "prev_sha12=${CM_PREV_SHA12}" "tag=${CM_TAG}" \
                "colour=${CM_COLOUR}" stage=commit rule=none "reason=post_commit_${n}" command="gremion-cd status" || true
        fi
        now="$(cd_now)" || return 1
        elapsed=$((now - start - _CD_COMMIT_PARKED_S))
        if ((elapsed >= cap)); then
            cd_hold_set failure "post_commit_${n}" "$CM_SHA12" || true
            cd_notify stopped "key=${CM_ID}-post-commit-${n}-cap" "sha12=${CM_SHA12}" "prev_sha12=${CM_PREV_SHA12}" "tag=${CM_TAG}" \
                "colour=${CM_COLOUR}" stage=commit rule=none "reason=post_commit_${n}" command="gremion-cd status" || true
            cd_hist commit_forward_given_up step="$n" sha12="$CM_SHA12" || true
            return 1
        fi
        rc=0
        _cd_commit_nap "$_CD_COMMIT_RETRY_S" commit || rc=$?
        if ((rc == 10)); then return 1; fi
    done
}

# _cd_commit_precommit - steps 1 to 5 as one retried sequence. 0 committed, 1 rolled back
# (commit_stuck or the operator's request), 4 the rollback at the cap was refused.
_cd_commit_precommit() {
    local cap start now fails=0 failed rc elapsed n
    cap="$(_cd_commit_int CD_COMMIT_MAX_MIN)" || return 2
    cap=$((cap * 60))
    start="$(cd_now)" || return 2
    _CD_COMMIT_PARKED_S=0
    while :; do
        _cd_commit_load || return 2
        # every attempt starts only while the release is still the one being watched: a phase that
        # moved (a rollback that began, whatever it answered) ends the sequence, the state is its
        # owner now
        if [[ -z "$CM_ID" ]]; then
            _cd_commit_err "commit: the release is gone from the state"
            return 1
        fi
        case "$CM_PHASE" in
            watching | releasing) ;;
            *)
                _cd_commit_err "commit: the phase is ${CM_PHASE}; the commit sequence stops"
                return 1
                ;;
        esac
        cd_state_set '.release.commit_attempts = ((.release.commit_attempts // 0) + 1)' || true
        failed=""
        for n in 1 2 3 4 5; do
            # the kill switch is looked at before every step: a release that is parked here keeps
            # both locks and moves nothing further (a rollback the operator asks for still runs)
            rc=0
            _cd_commit_gate commit || rc=$?
            if ((rc == 10)); then return 1; fi
            "_cd_commit_step${n}" || { failed="$n"; break; }
        done
        if [[ -z "$failed" ]]; then return 0; fi
        # a step 5 that reported an error may still have landed: the state is the truth, and a
        # committed release is never retried from step 1 (it would overwrite `previous` with the
        # new release) and never rolled back
        _cd_commit_load || return 2
        if [[ -n "$CM_COMMITTED" ]]; then
            cd_hist commit_step_reported_failed_but_landed step="$failed" || true
            return 0
        fi
        fails=$((fails + 1))
        cd_hist commit_step_failed step="$failed" attempt="$fails" || true
        if ((fails == 3)); then
            cd_notify stopped "key=${CM_ID}-commit-retry" "sha12=${CM_SHA12}" "prev_sha12=${CM_LIVE_SHA12}" "tag=${CM_TAG}" \
                "colour=${CM_COLOUR}" stage=commit rule=none "reason=commit_step_${failed}" command="gremion-cd status" || true
        fi
        now="$(cd_now)" || return 2
        elapsed=$((now - start - _CD_COMMIT_PARKED_S))
        if ((elapsed >= cap)); then
            # the cap: nothing is known to be wrong with the release, so no block. cd_rollback_run
            # moves `current` and the tag files back when step 2 or 3 had run
            rc=0
            _cd_commit_rollback commit_stuck || rc=$?
            return "$rc"
        fi
        rc=0
        _cd_commit_nap "$_CD_COMMIT_RETRY_S" commit || rc=$?
        if ((rc == 10)); then return 1; fi
    done
}

cd_commit_promote() {
    local window_s rc
    _cd_commit_load || return 2
    if [[ -z "$CM_ID" ]]; then
        _cd_commit_err "commit: there is no release in the state"
        return 2
    fi
    _cd_commit_locks_held || { _cd_commit_err "commit: the cd lock and the host lock must both be held"; return 2; }
    if [[ -z "$CM_COMMITTED" ]]; then
        if [[ "$CM_MODE" == proof ]]; then
            _cd_commit_err "commit: a proof release is never committed"
            return 2
        fi
        case "$CM_PHASE" in
            watching | releasing) ;;
            *) _cd_commit_err "commit: the phase is not watching"; return 2 ;;
        esac
        window_s="$(_cd_commit_int CD_WATCH_MINUTES)" || return 2
        if ((CM_OBSERVED < window_s * 60)); then
            _cd_commit_err "commit: the observed window is not complete"
            return 2
        fi
        if [[ -z "$CM_LIVE_TAG" || -z "$CM_LIVE_TREE" ]]; then
            _cd_commit_err "commit: the state names no live release"
            return 2
        fi
        rc=0
        _cd_commit_precommit || rc=$?
        if ((rc != 0)); then return "$rc"; fi
    elif [[ "$CM_PHASE" == idle || "$CM_PHASE" == parked || "$CM_PHASE" == rolling_back ]]; then
        _cd_commit_err "commit: the phase of a committed release must not be ${CM_PHASE}"
        return 2
    fi
    # from here the release is committed: nothing below can reach cd_rollback_run, except the
    # operator's own request that _cd_commit_nap takes
    _CD_COMMIT_FWD_START="$(cd_now)" || return 1
    _CD_COMMIT_PARKED_S=0
    rc=0
    _cd_commit_forward 6 _cd_commit_step6 || rc=$?
    if ((rc != 0)); then return 1; fi
    rc=0
    _cd_commit_forward 7 _cd_commit_step7 || rc=$?
    if ((rc != 0)); then return 1; fi
    _cd_commit_load || return 1
    rc=0
    _cd_commit_gate commit || rc=$?
    if ((rc == 10)); then return 1; fi
    _cd_commit_step8
    return 0
}

# -- the prune ------------------------------------------------------------------------------

# _cd_commit_free_gb PATH - whole gigabytes free on the file system of PATH.
_cd_commit_free_gb() {
    local kb
    kb="$(df -Pk -- "$1" 2>/dev/null </dev/null | awk 'NR == 2 { print $4 }')" || return 1
    [[ "$kb" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$((kb / 1048576))"
}

# _cd_commit_ref_norm REF - an image reference as compose and `docker images` both spell it: a
# registry prefix of the public hub and the `library/` namespace are dropped.
_cd_commit_ref_norm() {
    local r="$1"
    r="${r#index.docker.io/}"
    r="${r#docker.io/}"
    r="${r#library/}"
    printf '%s' "$r"
}

# _cd_commit_docker TIMEOUT ARGS... - docker with a time limit and no stdin.
_cd_commit_docker() {
    local t="$1"
    shift
    timeout -k 5 "$t" docker "$@" </dev/null
}

cd_commit_prune() {
    local min keepgb free droot dfree proj out ref tag n cid cids info cref img id12 list line
    local d name p keep_dir resolved now age f
    local removed_img=0 failed_img=0 removed_trees=0 removed_logs=0 pruned_cache=0
    local -A keep_tags=()
    local -A keep_refs=()
    local -A run_ids=()
    local -A keep_trees=()
    local -a mount_srcs=()
    local m mounted
    _cd_commit_load || return 2
    if [[ -z "$CM_LIVE_TAG" || -z "$CM_LIVE_TREE" ]]; then
        _cd_commit_err "prune: the state names no live release"
        return 2
    fi
    # 1. the build cache, when the disk is low (or cannot be read): keeps CD_BUILD_CACHE_KEEP_GB
    min="$(_cd_commit_int CD_MIN_FREE_GB)" || return 2
    keepgb="$(_cd_commit_int CD_BUILD_CACHE_KEEP_GB)" || return 2
    if ((min > 0)); then
        free="$(_cd_commit_free_gb "$CD_ROOT")" || free=-1
        droot="$(_cd_commit_docker 60 info --format '{{.DockerRootDir}}' 2>/dev/null)" || droot=""
        if [[ "$droot" == /* ]]; then
            dfree="$(_cd_commit_free_gb "$droot")" || dfree=-1
            if ((dfree < free || free < 0)); then free="$dfree"; fi
        fi
        if ((free < min)); then
            if _cd_commit_docker 300 builder prune -f --keep-storage "${keepgb}GB" >/dev/null 2>&1; then
                pruned_cache=1
            else
                _cd_commit_err "prune: the builder cache prune failed"
            fi
        fi
    fi
    # 2. the keep set: every reference that `compose config --images` yields for ALL THREE env
    # files (compose passes the profile star for it, so the one-shot images are in), the image
    # reference and ID of every running container, and every image of the live, previous and
    # in-flight tags. Every failure to compute it is a stop with nothing removed, and a part of
    # it that comes out empty is a failure too (a check that collected nothing proves nothing).
    keep_tags[$CM_LIVE_TAG]=1
    if [[ -n "$CM_PREV_TAG" ]]; then keep_tags[$CM_PREV_TAG]=1; fi
    if [[ -n "$CM_TAG" ]]; then keep_tags[$CM_TAG]=1; fi
    for proj in state app-blue app-green; do
        out="$(CD_DC_TIMEOUT=120 cd_dc "$CM_LIVE_TREE" "$proj" config --images </dev/null)" || {
            _cd_commit_err "prune: the images of the ${proj} project could not be listed; nothing was removed"
            return 4
        }
        n=0
        while IFS= read -r ref; do
            [[ -n "$ref" ]] || continue
            n=$((n + 1))
            keep_refs[$(_cd_commit_ref_norm "$ref")]=1
        done <<<"$out"
        if ((n == 0)); then
            _cd_commit_err "prune: the ${proj} project lists no image; nothing was removed"
            return 4
        fi
    done
    cids="$(_cd_commit_docker 60 ps -q)" || { _cd_commit_err "prune: the running containers could not be listed; nothing was removed"; return 4; }
    n=0
    for cid in $cids; do
        # line 1: the image reference and ID; every further line: the source of a mount
        info="$(_cd_commit_docker 60 inspect --format '{{.Config.Image}} {{.Image}}{{range .Mounts}}{{"\n"}}{{.Source}}{{end}}' "$cid")" || {
            _cd_commit_err "prune: a running container could not be inspected; nothing was removed"
            return 4
        }
        read -r cref img <<<"${info%%$'\n'*}"
        while IFS= read -r line; do
            [[ "$line" == /* ]] || continue
            line="$(readlink -m -- "$line" 2>/dev/null)" || continue
            mount_srcs+=("$line")
        done < <(printf '%s\n' "$info" | tail -n +2)
        n=$((n + 1))
        keep_refs[$(_cd_commit_ref_norm "$cref")]=1
        img="${img#sha256:}"
        if [[ -n "$img" ]]; then run_ids[${img:0:12}]=1; fi
    done
    if ((n == 0)); then
        _cd_commit_err "prune: no container is running; nothing was removed"
        return 4
    fi
    # 3. the images: only a pilot-<12 hex> tag outside the keep set, never a running container's
    # image, never `image prune -a`, never `rmi -f`
    list="$(_cd_commit_docker 60 images --format '{{.Repository}}:{{.Tag}} {{.ID}}')" || {
        _cd_commit_err "prune: the images could not be listed; nothing was removed"
        return 4
    }
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        read -r ref id12 <<<"$line"
        tag="${ref##*:}"
        [[ "$tag" =~ ^pilot-[0-9a-f]{12}$ ]] || continue
        [[ -z "${keep_tags[$tag]:-}" ]] || continue
        [[ -z "${keep_refs[$(_cd_commit_ref_norm "$ref")]:-}" ]] || continue
        id12="${id12#sha256:}"
        [[ -z "${run_ids[${id12:0:12}]:-}" ]] || continue
        if _cd_commit_docker 120 rmi "$ref" >/dev/null 2>&1; then
            removed_img=$((removed_img + 1))
        else
            failed_img=$((failed_img + 1))
        fi
    done <<<"$list"
    # 4. the release trees: direct children of releases/ named by a short SHA, other than live,
    # previous and the one in flight (compared by resolved path), never what `current` names
    keep_dir="${CD_ROOT}/releases"
    for p in "$CM_LIVE_TREE" "$CM_PREV_TREE" "$CM_TREE" "$(readlink -f "${CD_ROOT}/current" 2>/dev/null || true)"; do
        [[ -n "$p" ]] || continue
        resolved="$(readlink -m -- "$p" 2>/dev/null)" || continue
        keep_trees[$resolved]=1
    done
    if [[ -d "$keep_dir" && ! -L "$keep_dir" ]]; then
        for d in "$keep_dir"/*; do
            [[ -d "$d" && ! -L "$d" ]] || continue
            name="${d##*/}"
            [[ "$name" =~ ^[0-9a-f]{12}$ ]] || continue
            resolved="$(readlink -m -- "$d" 2>/dev/null)" || continue
            [[ -z "${keep_trees[$resolved]:-}" ]] || continue
            # a tree that a running container mounts from stays, whichever project it belongs to
            mounted=0
            for m in ${mount_srcs[@]+"${mount_srcs[@]}"}; do
                if [[ "$m" == "$resolved" || "$m" == "$resolved"/* ]]; then mounted=1; break; fi
            done
            ((mounted == 0)) || continue
            if rm -rf -- "$d"; then
                removed_trees=$((removed_trees + 1))
            else
                _cd_commit_err "prune: a release tree could not be removed"
            fi
        done
    fi
    # 5. the logs of the program (every library of it names its logs cd-<name>.log: the one-shot
    # and dump logs of data and modules, the isolation, verify, render and build logs, a rollback's
    # log) older than 14 days, measured against cd_now. Regular files only, no link is followed.
    now="$(cd_now)" || now=0
    if [[ -d "${CD_ROOT}/logs" ]]; then
        for f in "${CD_ROOT}/logs/"cd-*.log; do
            [[ -f "$f" && ! -L "$f" ]] || continue
            name="${f##*/}"
            [[ "$name" =~ ^cd-[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.log$ ]] || continue
            age="$(stat -c %Y -- "$f" 2>/dev/null)" || continue
            [[ "$age" =~ ^[0-9]+$ ]] || continue
            if ((now - age > 14 * 86400)); then
                if rm -f -- "$f"; then removed_logs=$((removed_logs + 1)); fi
            fi
        done
    fi
    cd_hist prune_done images="$removed_img" images_failed="$failed_img" trees="$removed_trees" logs="$removed_logs" cache="$pruned_cache" || true
    return 0
}
