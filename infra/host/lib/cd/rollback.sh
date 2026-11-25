#!/usr/bin/env bash
# infra/host/lib/cd/rollback.sh - the switch back of the continuous deployment program: the one
# rollback sequence, the same code for an automatic and a manual rollback, resumable.
#
# SOURCED, NEVER EXECUTED. Like colour.sh and traffic.sh it sets no shell options and runs
# nothing at the top level. It calls core.sh (cd_state_get, cd_state_set, cd_hist, cd_hold_set,
# cd_block_add, cd_lock_take, cd_release_committed, cd_now, cd_iso, cd_sleep, cd_cfg,
# cd_atomic_write), docker.sh (cd_envfile, cd_kv_get, cd_wait_healthy, cd_svc_cid,
# cd_traefik_service), colour.sh (cd_colour_start, cd_colour_down, cd_colour_identity,
# cd_colour_probe, cd_colour_portal_probe, cd_colour_workers, cd_colour_isolation_record,
# cd_colour_isolation_run), traffic.sh (cd_traffic_switch, cd_traffic_truth,
# cd_traffic_confirm), watch.sh (cd_watch_probe_public, cd_watch_sample,
# cd_watch_accesslog_count), prepare.sh (cd_prepare_retag_restore) and notify.sh (cd_notify)
# when they exist, and curl, jq, timeout and coreutils.
#
# WHAT IS HERE
#   cd_rollback_run RULE   the rollback sequence, in this order:
#       record   the rule and the time (a 0600 sidecar, data/cd/rollback.json, and the history),
#                phase rolling_back. Nothing waits for mail.
#       old      the old colour is started from ITS OWN tree, env file and tag when its project
#                is not all running and healthy. Its env IMAGE_TAG is checked against the tag
#                first (a colour that was retagged for a later release is not startable). A colour
#                that the truth (cd_traffic_truth) still names as serving, which is the old colour
#                of a rollback before the switch, is never started: it is waited for, up to
#                CD_COLOUR_HEALTHY_S, and a colour that does not get healthy ends the rollback
#                (old_unhealthy).
#       prove    the old colour is the old release: image identity, three consecutive internal
#                answers (colour and release are the old ones), the portal list page (the old
#                image reads the migrated schema), and the ready-only answer through the next
#                route when that route names the old colour.
#       switch   gremion-switch from the OLD tree (cd_traffic_switch), three tries. A switch
#                that the truth (runtime/active-colour AND Traefik) already shows as done is
#                not written again. Three failures: rollback_failed, a critical mail, the new
#                colour is LEFT RUNNING.
#       confirm  cd_traffic_confirm for the old colour (three services, the router graph) and the
#                public ready-only probe through the real edge. Then the post-rollback window
#                (CD_POST_ROLLBACK_S): the samples of the watch on the old colour; a bad streak is
#                a critical mail (rollback_failed, note unhealthy_after_rollback) and nothing is
#                stopped. The failure path of the watch (and of the window with no good sample)
#                settles what already follows the traffic, see _cd_rb_settle: the worker gate (new
#                colour off, then old colour on) and the block of the new commit. The hold stays
#                rollback_failed, the new colour stays RUNNING (the mail says so with the note
#                new_colour_still_running) and `gremion-cd status` names it.
#       workers  the new colour's gate file off, THEN the old colour's on.
#       stop     the new colour project is stopped (cd_colour_down, which refuses a colour that
#                the file or Traefik names), only after the confirm. Its log tail is kept under
#                logs/ (0600, never printed). A failed stop is a warning, not a failure.
#       restore  before the commit point only: the target env file's IMAGE_TAG goes back to
#                release.retag_prev and previous.startable is true again (cd_prepare_retag_restore).
#       blockhold the block (every rule except proof_end and commit_stuck) and the hold, written
#                BEFORE the mail is queued.
#       current  `current`, runtime/current-tag and previous-tag go back when they had moved (a
#                manual rollback after the commit point; a commit_stuck rollback after commit
#                step 2); live and previous of the state follow after a committed release.
#       isolation the isolation record of the OLD tip, when the new tip was recorded (a committed
#                release, commit_stuck, and any rule while the stage is commit: commit step 1
#                records the new tip before the commit point). A failure is only a mail.
#       mail     `rolled_back`.
#     Then phase idle and release null. A rollback never restores a database.
#
# RETURN CODES. 0 the release is rolled back. 1 the rollback did not complete (state: hold
# rollback_failed, phase idle, a critical mail; what the next step is stays with the operator,
# who repairs by hand and runs `adopt --re-adopt`). 2 usage or a refusal with nothing touched: an
# unknown rule, a COMMITTED release with any rule but manual_rollback (THE LINE: nothing but the
# operator's explicit rollback goes back after commit step 5), nothing in flight, a `previous`
# that is not startable. 3 another cd_rollback_run holds the cd lock. The reason of a return of 1
# is a short code in CD_ROLLBACK_REASON (call the function directly, not in $(...)).
#
# LOCKS. It takes the cd lock (idempotent when the caller holds it: the driver does) and
# releases NO lock. The host lock is the driver's: the process of a release holds it until a
# rollback is complete, and a manual rollback of an idle host takes it before this is called.
#
# RESUME. The sidecar holds the context (rule, release id, old and new release) and the steps
# done, so a kill at any point resumes with the recorded rule whatever the caller passes, from
# the first step not done; every step is also idempotent against the running system (a healthy
# old colour is not started again, a switch the truth shows as done is not written again). The
# sidecar is honoured only while phase is rolling_back and the release id matches.
#
# THE REAL-DATA BOUNDARY. Names of components, stages, colours, tags, codes and counts only. The
# kept log tail names tenants: it is a 0600 file under logs/ and its path is never printed.

# shellcheck disable=SC2016,SC2034  # the jq programs are single-quoted on purpose; the RB_ variables are shared between the steps

CD_ROLLBACK_REASON=''

# The rules a rollback may carry: the twelve block rules of blocked.json and the two that write
# no block.
_CD_RB_RULES=" build_failed migrate_failed start_failed readiness_failed isolation_failed verify_failed post_switch_verify watch_readiness watch_crash watch_5xx watch_pause_cap manual_rollback proof_end commit_stuck "

# The steps in order. A step that is marked in the sidecar is not run again.
_CD_RB_STEPS="old prove switch confirm watch workers stop restore blockhold current isolation mail"

_cd_rb_err() { printf 'cd-rollback: %s\n' "$*" >&2; }

# _cd_rb_why CODE MESSAGE - record the reason, say it once.
_cd_rb_why() {
    CD_ROLLBACK_REASON="${1:-failed}"
    _cd_rb_err "${2:-${1:-failed}}"
}

# _cd_rb_num NAME DEFAULT - the whole number in the environment variable NAME, else DEFAULT.
# These are timing knobs of the sequence (tries and gaps), not config keys.
_cd_rb_num() {
    local v="${!1:-}"
    if [[ "$v" =~ ^[0-9]{1,6}$ ]]; then
        printf '%s' "$((10#$v))"
    else
        printf '%s' "$2"
    fi
}

# _cd_rb_cfg_int KEY DEFAULT - a whole-number key of cd.env, DEFAULT when it cannot be read.
_cd_rb_cfg_int() {
    local v=''
    v="$(cd_cfg "$1" 2>/dev/null)" || v=''
    if [[ "$v" =~ ^[0-9]{1,9}$ ]]; then
        printf '%s' "$((10#$v))"
    else
        printf '%s' "$2"
    fi
}

_cd_rb_sidecar() { printf '%s' "${CD_DATA}/rollback.json"; }

_cd_rb_writes_block() {
    case "$1" in
        proof_end | commit_stuck) return 1 ;;
        *) return 0 ;;
    esac
}

# -- the context ------------------------------------------------------------------------

# _cd_rb_load JSON - the context document into the RB_ variables.
_cd_rb_load() {
    local f
    f="$(printf '%s' "$1" | jq -r '[.rule, (if .committed then "1" else "0" end), .release_id, .stage,
        (if .synth then "1" else "0" end), (.prev_tag // ""),
        .new.sha, .new.sha12, .new.tag, .new.colour, .new.tree,
        .old.sha, .old.sha12, .old.tag, .old.colour, .old.tree] | join("|")' 2>/dev/null)" || return 2
    IFS='|' read -r RB_RULE RB_COMMITTED RB_ID RB_STAGE RB_SYNTH RB_PREV_TAG \
        RB_NEW_SHA RB_NEW_SHA12 RB_NEW_TAG RB_NEW_COLOUR RB_NEW_TREE \
        RB_OLD_SHA RB_OLD_SHA12 RB_OLD_TAG RB_OLD_COLOUR RB_OLD_TREE <<<"$f"
    [[ -n "${RB_NEW_COLOUR:-}" && -n "${RB_OLD_COLOUR:-}" && -n "${RB_OLD_TREE:-}" ]] || return 2
    return 0
}

# _cd_rb_derive RULE - the context from the state, printed as a document, or a refusal (2).
# The sides are told by the phase and the committed marker, never by the release being there:
# an aborted release record can sit in an idle state.
#   a release in flight, not committed  -> new = release, old = live
#   anything else (a committed release, or none in flight) -> new = live, old = previous; only
#   the operator's manual_rollback may take that road.
_cd_rb_derive() {
    local rule="$1" doc err
    doc="$(cd_state_get '
        def sub: {sha, sha12, tag, colour, tree};
        .phase as $ph | .release as $r | .live as $l | .previous as $p
        | (($r != null) and (($r.committed_at // null) == null)) as $open
        | if $open and ($ph | IN("releasing", "watching", "parked", "rolling_back")) then
            if $l == null then {error: "no_live"}
            elif $l.colour == $r.colour then {error: "same_colour"}
            else {committed: false, release_id: $r.id, stage: $r.stage, synth: false,
                  new: ($r | sub), old: ($l | sub), prev_tag: ($p.tag // "")} end
          else
            ((($r != null) and (($r.committed_at // null) != null))) as $rec
            | if $l == null then {error: "no_live"}
              elif $p == null then {error: "no_previous"}
              elif $p.startable != true then {error: "not_startable"}
              elif $p.colour == $l.colour then {error: "same_colour"}
              else {committed: true, release_id: (if $rec then $r.id else ($l.sha12 + "-0") end),
                    stage: (if $rec then $r.stage else "switch" end), synth: ($rec | not),
                    new: ($l | sub), old: ($p | sub), prev_tag: ""} end
          end | tojson')" || return 2
    err="$(printf '%s' "$doc" | jq -r '.error // empty' 2>/dev/null)" || err=bad
    case "$err" in
        '') ;;
        no_live) _cd_rb_err "there is no live release to roll back from"; return 2 ;;
        no_previous) _cd_rb_err "there is no previous release to go back to"; return 2 ;;
        not_startable) _cd_rb_err "the previous release cannot be started: its colour was retagged for a later release; use gremion-rollback by hand and then gremion-cd adopt --re-adopt"; return 2 ;;
        same_colour) _cd_rb_err "the two releases are on the same colour; the state is not one this program can roll back"; return 2 ;;
        *) _cd_rb_err "the state is not one this program can roll back"; return 2 ;;
    esac
    if [[ "$(printf '%s' "$doc" | jq -r '.committed')" == true && "$rule" != manual_rollback ]]; then
        _cd_rb_err "refusing rule ${rule}: the release is committed or none is in flight; only the operator's manual_rollback goes back (nothing was touched)"
        return 2
    fi
    printf '%s' "$doc" | jq -c --arg rule "$rule" '. + {rule: $rule}'
}

# _cd_rb_plan RULE - set the RB_ variables: from the sidecar of a rollback that is in progress
# (phase rolling_back, the release id matching), else from the state. Sets RB_RESUMING.
_cd_rb_plan() {
    local rule="$1" side ph rid sc ctx srule
    RB_RESUMING=0
    side="$(_cd_rb_sidecar)"
    if [[ -r "$side" ]]; then
        ph="$(cd_state_get '.phase')" || return 2
        rid="$(cd_state_get '.release.id // empty')" || return 2
        sc="$(jq -c 'select(.v == 1)' "$side" 2>/dev/null)" || sc=''
        if [[ "$ph" == rolling_back && -n "$sc" && "$(printf '%s' "$sc" | jq -r '.ctx.release_id // empty')" == "$rid" ]]; then
            ctx="$(printf '%s' "$sc" | jq -c '.ctx')"
            srule="$(printf '%s' "$ctx" | jq -r '.rule // empty')"
            if [[ -n "$srule" && "$srule" != "$rule" ]]; then
                _cd_rb_err "a rollback with rule ${srule} is in progress; it is resumed with that rule"
            fi
            _cd_rb_load "$ctx" || return 2
            # the same line as in _cd_rb_derive: a committed rollback is only ever a manual one
            if [[ "$RB_COMMITTED" == 1 && "$RB_RULE" != manual_rollback ]]; then
                _cd_rb_err "refusing the recorded rule ${RB_RULE}: the release is committed; only manual_rollback goes back (nothing was touched)"
                return 2
            fi
            RB_RESUMING=1
            return 0
        fi
        # a sidecar of a rollback that is over (or of another release): never honoured
        if [[ "${CD_LOCK_PID:-}" == "$$" ]]; then rm -f -- "$side" 2>/dev/null || true; fi
    fi
    ctx="$(_cd_rb_derive "$rule")" || return $?
    if [[ "$(printf '%s' "$ctx" | jq -r '.synth')" == true ]]; then
        # a record made for this rollback: unique per attempt, so its mails are not deduped away
        ctx="$(printf '%s' "$ctx" | jq -c --argjson now "$(cd_now)" '.release_id = (.new.sha12 + "-" + ($now | tostring))')" || return 2
    fi
    _cd_rb_load "$ctx" || return 2
    RB_CTX="$ctx"
    return 0
}

# -- the sidecar and the marks -----------------------------------------------------------

_cd_rb_steps_done() {
    jq -r '(.steps // []) | join(" ")' "$(_cd_rb_sidecar)" 2>/dev/null || printf ''
}

_cd_rb_done() { [[ " $(_cd_rb_steps_done) " == *" $1 "* ]]; }

# _cd_rb_mark NAME - the step is done. Under GREMION_CD_TESTING=1 and
# GREMION_CD_ROLLBACK_KILL_AFTER=NAME the process is killed right after the mark (the tests of
# the resume read it; without the flag the variable is ignored).
_cd_rb_mark() {
    local side doc
    side="$(_cd_rb_sidecar)"
    doc="$(jq -c --arg s "$1" '.steps = (((.steps // []) + [$s]) | unique)' "$side" 2>/dev/null)" || return 1
    printf '%s\n' "$doc" | cd_atomic_write "$side" 600 || return 1
    if [[ "${GREMION_CD_TESTING:-}" == 1 && "${GREMION_CD_ROLLBACK_KILL_AFTER:-}" == "$1" ]]; then
        kill -9 "$$"
    fi
    return 0
}

# _cd_rb_begin - the first step (record): the sidecar, then the state. A release that is not in the
# state (a manual rollback of an idle host) gets a record that names the release being left, so
# the switch can write its marker (cd_traffic_switch needs a release in the state).
_cd_rb_begin() {
    local at now
    if [[ "$RB_RESUMING" -eq 1 ]]; then
        cd_hist rollback_resumed rule="$RB_RULE" || true
        return 0
    fi
    at="$(cd_iso)" || return 2
    now="$(cd_now)" || return 2
    jq -cn --argjson ctx "$RB_CTX" --arg at "$at" --argjson now "$now" \
        '{v: 1, ctx: $ctx, at: $at, epoch: $now, steps: []}' | cd_atomic_write "$(_cd_rb_sidecar)" 600 || {
        _cd_rb_err "the rollback record could not be written"
        return 2
    }
    cd_state_set '.phase = "rolling_back"
        | (if $synth == 1 then .release = {id: $id, sha: $sha, sha12: $s12, tag: $tag, colour: $col, tree: $tree,
              mode: "manual", stage: "switch", stage_status: "started", switch_started: false, committed_at: $at, attempt: 1}
           else (.) end)' \
        --argjson synth "$RB_SYNTH" --arg id "$RB_ID" --arg sha "$RB_NEW_SHA" --arg s12 "$RB_NEW_SHA12" \
        --arg tag "$RB_NEW_TAG" --arg col "$RB_NEW_COLOUR" --arg tree "$RB_NEW_TREE" --arg at "$at" || {
        _cd_rb_err "the state could not be written"
        return 2
    }
    cd_hist rollback_started rule="$RB_RULE" committed="$RB_COMMITTED" from="$RB_NEW_COLOUR" to="$RB_OLD_COLOUR" || true
    _cd_rb_mark record || return 2
    return 0
}

# -- the steps -------------------------------------------------------------------------

# old: the old colour is up, from its own tree, env and tag.
_cd_rb_s_old() {
    local c="$RB_OLD_COLOUR" tree="$RB_OLD_TREE" tag="$RB_OLD_TAG" envf cur t truth
    if cd_wait_healthy "app-${c}" 0 "$tree" >/dev/null 2>&1; then
        cd_hist rollback_old_running colour="$c" || true
        return 0
    fi
    # A rollback before the switch (or one that the switch never reached): the old colour still
    # SERVES, and the one look above can have met it starting or momentarily unhealthy. Starting
    # a colour that serves is refused by the guard of cd_colour_start (and would be wrong: it
    # takes the project down first), which ended the rollback in rollback_failed. The truth
    # names the old colour: wait for it, for as long as a started colour is given.
    truth="$(cd_traffic_truth 2>/dev/null </dev/null)" || truth=''
    if [[ "$truth" == "$c" ]]; then
        t="$(_cd_rb_num CD_COLOUR_HEALTHY_S 180)"
        if cd_wait_healthy "app-${c}" "$t" "$tree" >/dev/null 2>&1; then
            cd_hist rollback_old_running colour="$c" || true
            return 0
        fi
        _cd_rb_why old_unhealthy "the ${c} colour serves but did not become healthy"
        return 1
    fi
    envf="$(cd_envfile "app-${c}" 2>/dev/null)" || envf=''
    cur=''
    if [[ -n "$envf" ]]; then cur="$(cd_kv_get "$envf" IMAGE_TAG 2>/dev/null)" || cur=''; fi
    if [[ "$cur" != "$tag" ]]; then
        _cd_rb_why old_not_startable "the env file of the ${c} colour does not name the release to go back to; it cannot be started"
        return 1
    fi
    if ! cd_colour_start "$tree" "$c" "$tag"; then
        _cd_rb_why old_start_failed "the ${c} colour could not be started from its own tree"
        return 1
    fi
    t="$(_cd_rb_num CD_COLOUR_HEALTHY_S 180)"
    if ! cd_wait_healthy "app-${c}" "$t" "$tree" >/dev/null 2>&1; then
        _cd_rb_why old_unhealthy "the ${c} colour did not become healthy"
        return 1
    fi
    cd_hist rollback_old_started colour="$c" || true
    return 0
}

# _cd_rb_next_route - 0 when the next route does not stand in the way of the proof: it names the
# old colour, every server UP, and the ready-only answer of the loopback test router is
# {"ready":true}; or it names the other colour (the old colour still serves and the real-edge
# probe of the confirm covers it). 1 otherwise.
_cd_rb_next_route() {
    local c="$RB_OLD_COLOUR" svc urls u st port out code body want=0 other=0 down=0 envf
    svc="$(cd_traefik_service app-next@file 2>/dev/null </dev/null)" || return 1
    urls="$(printf '%s' "$svc" | jq -r '.loadBalancer.servers[]?.url // empty' 2>/dev/null)" || return 1
    [[ -n "$urls" ]] || return 1
    while IFS= read -r u; do
        [[ -n "$u" ]] || continue
        if [[ "$u" == "http://gremion-ui-${c}:3000" ]]; then want=$((want + 1)); else other=$((other + 1)); fi
        st="$(printf '%s' "$svc" | jq -r --arg u "$u" '.serverStatus[$u] // "none"' 2>/dev/null)" || st=none
        if [[ "$st" != UP ]]; then down=1; fi
    done <<<"$urls"
    if [[ "$want" -eq 0 && "$other" -gt 0 ]]; then return 0; fi
    if [[ "$other" -gt 0 || "$down" -eq 1 ]]; then return 1; fi
    envf="$(cd_envfile state 2>/dev/null)" || return 1
    port="$(cd_kv_get "$envf" INTERNALTEST_PORT 2>/dev/null)" || return 1
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
    out="$(curl -sS --max-time "$(_cd_rb_cfg_int CD_SAMPLE_TIMEOUT_S 12)" -H 'Host: cd-rollback.invalid' \
        -w $'\n%{http_code}' "http://127.0.0.1:${port}/readyz" </dev/null 2>/dev/null)" || return 1
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    [[ "$code" == 200 ]] || return 1
    printf '%s' "$body" | jq -e '. == {"ready": true}' >/dev/null 2>&1
}

# prove: the old colour IS the old release and lives with the schema.
_cd_rb_s_prove() {
    local c="$RB_OLD_COLOUR" tag="$RB_OLD_TAG" ans ok=0 tries n gap i
    if ! cd_colour_identity "$c" "$tag" >/dev/null 2>&1; then
        _cd_rb_why old_identity "the ${c} colour does not run the images of its own tag"
        return 1
    fi
    tries="$(_cd_rb_num CD_ROLLBACK_PROVE_TRIES 20)"
    gap="$(_cd_rb_num CD_ROLLBACK_PROVE_GAP_S 3)"
    n=0
    for ((i = 1; i <= tries; i++)); do
        ans=''
        if ans="$(cd_colour_probe "$c" 2>/dev/null </dev/null)" \
            && printf '%s' "$ans" | jq -e --arg c "$c" --arg t "$tag" '.ready == true and .colour == $c and .release == $t' >/dev/null 2>&1 \
            && _cd_rb_next_route; then
            n=$((n + 1))
        else
            n=0
        fi
        if [[ "$n" -ge 3 ]]; then ok=1; break; fi
        cd_sleep "$gap" || true
    done
    if [[ "$ok" -ne 1 ]]; then
        _cd_rb_why old_not_ready "the ${c} colour did not answer ready as the old release three times in a row"
        return 1
    fi
    if ! cd_colour_portal_probe "$c" >/dev/null 2>&1; then
        _cd_rb_why old_portal "the portal list page of the ${c} colour does not answer below 500"
        return 1
    fi
    return 0
}

# switch: gremion-switch of the OLD tree, three tries, unless the truth already says old.
_cd_rb_s_switch() {
    local c="$RB_OLD_COLOUR" truth tries gap i
    truth="$(cd_traffic_truth 2>/dev/null </dev/null)" || truth=''
    if [[ "$truth" == "$c" ]]; then
        cd_hist rollback_switch_skipped colour="$c" || true
        return 0
    fi
    tries="$(_cd_rb_num CD_ROLLBACK_SWITCH_TRIES 3)"
    gap="$(_cd_rb_num CD_ROLLBACK_SWITCH_GAP_S 5)"
    for ((i = 1; i <= tries; i++)); do
        if cd_traffic_switch "$RB_OLD_TREE" "$c"; then
            return 0
        fi
        cd_hist rollback_switch_failed try="$i" || true
        if [[ "$i" -lt "$tries" ]]; then cd_sleep "$gap" || true; fi
    done
    _cd_rb_why switch_failed "the switch back to the ${c} colour failed ${tries} times; the new colour is left running"
    return 1
}

# confirm: the edge shows the old colour on every service, the graph is clean, the real edge answers.
_cd_rb_s_confirm() {
    local c="$RB_OLD_COLOUR" tries gap i
    tries="$(_cd_rb_num CD_ROLLBACK_CONFIRM_TRIES 4)"
    gap="$(_cd_rb_num CD_ROLLBACK_CONFIRM_GAP_S 5)"
    for ((i = 1; i <= tries; i++)); do
        if cd_traffic_confirm "$c" >/dev/null 2>&1 && cd_watch_probe_public >/dev/null 2>&1 </dev/null; then
            RB_CONFIRMED_AT="$(cd_now)" || RB_CONFIRMED_AT=0
            return 0
        fi
        if [[ "$i" -lt "$tries" ]]; then cd_sleep "$gap" || true; fi
    done
    _cd_rb_why confirm_failed "the edge does not show the ${c} colour serving after the switch back"
    return 1
}

# _cd_rb_5xx_hit SINCE BASELINE - 0 when the 5xx answers since SINCE reach the watch rule: at
# least CD_5XX_MIN and at least CD_5XX_FACTOR times the baseline scaled to the elapsed time (a
# null baseline uses the minimum alone). A log that cannot be read is no trigger.
_cd_rb_5xx_hit() {
    local since="$1" base="$2" n now elapsed min factor span expected
    n="$(cd_watch_accesslog_count "$since" 2>/dev/null </dev/null)" || return 1
    [[ "$n" =~ ^[0-9]{1,9}$ ]] || return 1
    now="$(cd_now)" || return 1
    elapsed=$((now - since))
    ((elapsed >= 1)) || elapsed=1
    min="$(_cd_rb_cfg_int CD_5XX_MIN 10)"
    factor="$(_cd_rb_cfg_int CD_5XX_FACTOR 3)"
    span="$(_cd_rb_cfg_int CD_BASELINE_S 3600)"
    ((n >= min)) || return 1
    if [[ "$base" =~ ^[0-9]{1,9}$ ]]; then
        expected=$(((base * elapsed + span - 1) / span))
        ((n >= factor * expected)) || return 1
    fi
    return 0
}

# watch: the samples of the watch on the old colour for CD_POST_ROLLBACK_S. A bad streak of
# CD_FAIL_SAMPLES samples ends it. A sample is bad when the probes, the route, the identity, the
# portal or the containers fail or it ran out of time, or the 5xx rule hits since the confirm.
# While a shared service is down a bad sample neither counts nor resets the streak (the outage is
# not what the rollback did), but a window with NOT ONE good sample is a failure (old_colour_unproven,
# nothing is stopped). It judges the samples itself and writes none of the release's counters.
_cd_rb_s_watch() {
    local c="$RB_OLD_COLOUR" tag="$RB_OLD_TAG" window interval failn start end now streak=0 good=0 sample bad shared t0 dur base
    window="$(_cd_rb_cfg_int CD_POST_ROLLBACK_S 180)"
    interval="$(_cd_rb_cfg_int CD_WATCH_INTERVAL_S 15)"
    failn="$(_cd_rb_cfg_int CD_FAIL_SAMPLES 3)"
    [[ "$window" -gt 0 ]] || return 0
    base="$(cd_state_get '.release.watch.baseline_5xx // "null"' 2>/dev/null)" || base=null
    start="$(cd_now)" || return 1
    end=$((start + window))
    [[ "${RB_CONFIRMED_AT:-0}" -gt 0 ]] || RB_CONFIRMED_AT="$start"
    while :; do
        t0="$(cd_now)" || return 1
        bad=0
        shared=1
        if sample="$(cd_watch_sample "$c" "$tag" 2>/dev/null </dev/null)" && [[ -n "$sample" ]]; then
            printf '%s' "$sample" | jq -e --arg c "$c" --arg t "$tag" '
                (.timed_out == false) and (.public.ok == true) and (.internal.answered == true) and (.internal.ready == true)
                and (.internal.colour == $c) and (.internal.release == $t) and (.route.ok == true) and (.identity.ok == true)
                and (.portal.ok == true) and (.containers.known == true) and ((.containers.bad // 0) == 0)' >/dev/null 2>&1 || bad=1
            printf '%s' "$sample" | jq -e '(.shared.state_ok == true) and (.shared.traefik_ok == true) and (.shared.docker_ok == true)' >/dev/null 2>&1 || shared=0
            if [[ "$bad" -eq 0 ]] && _cd_rb_5xx_hit "$RB_CONFIRMED_AT" "$base"; then bad=1; fi
        else
            bad=1
        fi
        if [[ "$bad" -eq 0 ]]; then
            streak=0
            good=$((good + 1))
        elif [[ "$shared" -eq 1 ]]; then
            streak=$((streak + 1))
        fi
        if [[ "$streak" -ge "$failn" ]]; then
            _cd_rb_why unhealthy_after_rollback "the ${c} colour is unhealthy after the switch back; nothing is left to try"
            RB_NOTE=unhealthy_after_rollback
            return 1
        fi
        now="$(cd_now)" || return 1
        [[ "$now" -lt "$end" ]] || break
        dur=$((now - t0))
        if [[ "$dur" -lt "$interval" ]]; then cd_sleep "$((interval - dur))" || true; else cd_sleep 1 || true; fi
        now="$(cd_now)" || return 1
        [[ "$now" -lt "$end" ]] || break
    done
    # unknown is never green: a window in which not one sample was good (every sample was set aside
    # because a shared service was down or unreadable) proves nothing about the old colour
    if [[ "$good" -lt 1 ]]; then
        _cd_rb_why old_colour_unproven "no sample of the ${c} colour was good in the window after the switch back; nothing was stopped"
        return 1
    fi
    return 0
}

# workers: the new colour off, THEN the old colour on.
_cd_rb_s_workers() {
    if ! cd_colour_workers "$RB_NEW_COLOUR" off; then
        _cd_rb_why workers_failed "the worker gate of the ${RB_NEW_COLOUR} colour could not be set off"
        return 1
    fi
    if ! cd_colour_workers "$RB_OLD_COLOUR" on; then
        _cd_rb_why workers_failed "the worker gate of the ${RB_OLD_COLOUR} colour could not be set on"
        return 1
    fi
    return 0
}

# _cd_rb_settle - the end state of a rollback whose watch on the old colour failed. The switch back
# is confirmed, so the old colour serves whatever the watch says; the host must not be left half
# rolled back (the gate of the new colour on and the old one off while the old one serves, and no
# block for the commit that was condemned). The documented order stays (the watch comes first, so
# a rollback that ends well is unchanged); the failure path does the two steps that follow the
# traffic: the worker gate (new off, THEN old on, as the workers step) and the block (as the
# blockhold step). It does NOT stop the new colour, restore the env tag, move `current` or
# change the hold: with the old colour unproven or unhealthy that stays the operator's call.
# A step that fails here is a history line and a message, never a change of the reason the
# caller reports.
_cd_rb_settle() {
    if ! cd_colour_workers "$RB_NEW_COLOUR" off || ! cd_colour_workers "$RB_OLD_COLOUR" on; then
        cd_hist rollback_settle_failed what=workers || true
        _cd_rb_err "the worker gate could not be set to follow the ${RB_OLD_COLOUR} colour after the failed watch; set it by hand"
    fi
    if _cd_rb_writes_block "$RB_RULE" && ! cd_block_add "$RB_NEW_SHA" "$RB_RULE" "rolled back to ${RB_OLD_TAG}"; then
        cd_hist rollback_settle_failed what=block || true
        _cd_rb_err "the block for the ${RB_NEW_SHA12} commit could not be written after the failed watch"
    fi
    return 0
}

# _cd_rb_keep_logs - the last 500 lines of the new colour's gremion-ui, mode 0600, under logs/.
# Best effort: the new colour may not answer at all. The path is never printed.
_cd_rb_keep_logs() {
    local cid dir f
    cid="$(cd_svc_cid "app-${RB_NEW_COLOUR}" gremion-ui 2>/dev/null </dev/null)" || return 0
    [[ -n "$cid" ]] || return 0
    dir="${CD_ROOT}/logs"
    # 0700 when this creates it; a link in place of the directory or of the file is refused
    # (the log names tenants and must not be written through a planted link)
    [[ -L "$dir" ]] && return 0
    cd_mkdir "$dir" 2>/dev/null || return 0
    f="${dir}/cd-rollback-${RB_NEW_TAG}-$(cd_now).log"
    [[ -L "$f" ]] && return 0
    # noclobber: a link planted between the check and the write is not followed either
    ( umask 077; set -C; timeout -k 2 30 docker logs --tail 500 "$cid" >"$f" 2>&1 </dev/null ) || true
    chmod 600 -- "$f" 2>/dev/null || true
    return 0
}

# stop: the new colour project goes down, after the confirm. cd_colour_down refuses a colour that
# runtime/active-colour or Traefik names. A failed stop is a warning: the switch back is done.
_cd_rb_s_stop() {
    _cd_rb_keep_logs
    if ! cd_colour_down "$RB_NEW_TREE" "$RB_NEW_COLOUR"; then
        cd_hist rollback_stop_failed colour="$RB_NEW_COLOUR" || true
        RB_STOP_FAILED=1
        _cd_rb_err "the ${RB_NEW_COLOUR} colour could not be stopped; the switch back is done, stop it by hand"
    fi
    return 0
}

# restore: before the commit point the target env file's tag goes back and previous is
# startable again. When it cannot be restored previous stays not startable, and a manual
# rollback of an idle host then refuses with the message.
_cd_rb_s_restore() {
    [[ "$RB_COMMITTED" -eq 0 ]] || return 0
    if ! cd_prepare_retag_restore; then
        cd_hist rollback_retag_not_restored || true
        _cd_rb_err "the env file of the ${RB_NEW_COLOUR} colour could not be put back; the previous release stays not startable"
    fi
    return 0
}

# blockhold: the block (unless the rule writes none) and the hold, before any mail.
_cd_rb_s_blockhold() {
    local kind reason="$RB_RULE"
    if _cd_rb_writes_block "$RB_RULE"; then
        if ! cd_block_add "$RB_NEW_SHA" "$RB_RULE" "rolled back to ${RB_OLD_TAG}"; then
            _cd_rb_why block_failed "the block could not be written"
            return 1
        fi
        kind=blocked
    elif [[ "$RB_RULE" == proof_end ]]; then
        kind=proof
    else
        kind=failure
    fi
    if ! cd_hold_set "$kind" "$reason" "$RB_NEW_SHA12"; then
        _cd_rb_why hold_failed "the hold could not be written"
        return 1
    fi
    return 0
}

# _cd_rb_write_tag FILE VALUE - atomic, mode 0644.
_cd_rb_write_tag() { printf '%s\n' "$2" | cd_atomic_write "$1" 644; }

# current: `current`, current-tag and previous-tag back when they had moved; for a committed
# release the state follows (live is the old release, nothing is previous: the rolled-back one is
# blocked and must not be reachable by the next rollback).
_cd_rb_s_current() {
    local root="$CD_ROOT" cur ctag moved=0 tmp now
    cur="$(readlink "${root}/current" 2>/dev/null)" || cur=''
    if [[ "$cur" == "$RB_NEW_TREE" || ( "$RB_COMMITTED" -eq 1 && "$cur" != "$RB_OLD_TREE" ) ]]; then
        tmp="${root}/current.cd-rollback.tmp"
        if ! ln -sfn "$RB_OLD_TREE" "$tmp" || ! mv -T -f "$tmp" "${root}/current" \
            || [[ "$(readlink "${root}/current" 2>/dev/null)" != "$RB_OLD_TREE" ]]; then
            rm -f -- "$tmp" 2>/dev/null || true
            _cd_rb_why current_failed "the current link could not be moved back"
            return 1
        fi
        moved=1
    fi
    ctag=''
    if [[ -r "${root}/runtime/current-tag" ]]; then ctag="$(tr -d '[:space:]' <"${root}/runtime/current-tag" 2>/dev/null)" || ctag=''; fi
    if [[ "$ctag" == "$RB_NEW_TAG" || "$RB_COMMITTED" -eq 1 ]]; then
        _cd_rb_write_tag "${root}/runtime/current-tag" "$RB_OLD_TAG" || { _cd_rb_why current_failed "current-tag could not be written"; return 1; }
        if [[ -n "$RB_PREV_TAG" ]]; then
            _cd_rb_write_tag "${root}/runtime/previous-tag" "$RB_PREV_TAG" || { _cd_rb_why current_failed "previous-tag could not be written"; return 1; }
        else
            rm -f -- "${root}/runtime/previous-tag" 2>/dev/null || true
        fi
    fi
    if [[ "$moved" -eq 1 ]] && declare -F executor_unit_action >/dev/null 2>&1; then
        executor_unit_action try-restart >/dev/null 2>&1 || true
    fi
    if [[ "$RB_COMMITTED" -eq 1 ]]; then
        now="$(cd_iso)" || return 1
        cd_state_set '.live = {sha: $sha, sha12: $s12, tag: $tag, colour: $col, tree: $tree, since: $now,
                               proof: false, modules: null, leaves: null, reconcile: null}
                      | .previous = null' \
            --arg sha "$RB_OLD_SHA" --arg s12 "$RB_OLD_SHA12" --arg tag "$RB_OLD_TAG" --arg col "$RB_OLD_COLOUR" \
            --arg tree "$RB_OLD_TREE" --arg now "$now" || { _cd_rb_why state_failed "the state could not be written"; return 1; }
    fi
    return 0
}

# isolation: the isolation record of the OLD tip, when the new tip was recorded. The enable gate
# refuses ISOLATION_STALE_TIP otherwise. A failure here is a mail, never a blocker.
_cd_rb_s_isolation() {
    local rc=0
    # The new tip is recorded at commit step 1, before the commit point, so any rollback of a release
    # whose commit stage began (an operator's request taken while the steps retry, a kill switch park
    # that ends in one) must put the old tip back, not only commit_stuck.
    if [[ "$RB_COMMITTED" -ne 1 && "$RB_RULE" != commit_stuck && "$RB_STAGE" != commit ]]; then
        return 0
    fi
    cd_colour_isolation_record "$RB_OLD_TREE" >/dev/null 2>&1 </dev/null || rc=$?
    if [[ "$rc" -eq 1 ]]; then
        # no evidence file for the old tip any more: a fresh run, then the record
        if cd_colour_isolation_run "$RB_OLD_TREE" >/dev/null 2>&1 </dev/null; then
            rc=0
            cd_colour_isolation_record "$RB_OLD_TREE" >/dev/null 2>&1 </dev/null || rc=$?
        fi
    fi
    if [[ "$rc" -ne 0 ]]; then
        cd_hist rollback_isolation_failed || true
        cd_notify stopped "key=${RB_ID}-isolation" "sha12=${RB_NEW_SHA12}" "prev_sha12=${RB_OLD_SHA12}" "tag=${RB_NEW_TAG}" \
            "colour=${RB_NEW_COLOUR}" "stage=commit" "rule=${RB_RULE}" "reason=isolation_record_failed" "command=gremion-cd status" || true
    fi
    return 0
}

# _cd_rb_mail_args - the common fields of the two mails.
_cd_rb_mail_fields() {
    printf '%s\n' "sha12=${RB_NEW_SHA12}" "prev_sha12=${RB_OLD_SHA12}" "tag=${RB_NEW_TAG}" "colour=${RB_NEW_COLOUR}" \
        "prev_colour=${RB_OLD_COLOUR}" "rule=${RB_RULE}"
}

# mail: `rolled_back`, once per release (a resume after the mail does not send it twice).
_cd_rb_s_mail() {
    local -a f=()
    local obs stage
    mapfile -t f < <(_cd_rb_mail_fields)
    stage="${RB_STAGE:-none}"
    obs="$(cd_state_get '(.release.watch.observed_s // empty) | floor' 2>/dev/null)" || obs=''
    f+=("stage=${stage}" "command=gremion-cd status")
    if [[ "$obs" =~ ^[0-9]+$ ]]; then f+=("observed_min=$((obs / 60))"); fi
    cd_notify rolled_back "key=${RB_ID}-rolled_back" "${f[@]}" || true
    return 0
}

# -- the end ---------------------------------------------------------------------------

# _cd_rb_fail - the rollback did not complete: hold rollback_failed, phase idle (so no resume tick
# runs the sequence again), a critical mail, the sidecar goes. The new colour is left as it is.
# The release record stays for the operator. Returns 1.
_cd_rb_fail() {
    local reason="${CD_ROLLBACK_REASON:-failed}" notes="${RB_NOTE:-}" running=1 left=""
    local -a f=()
    reason="${reason//[^a-z0-9_]/_}"
    # the new colour is stopped only by the stop step: a rollback that failed before it, or whose stop
    # did not take, leaves the new colour running (stopping it is the operator's call). The hold keeps
    # the colour, because the release record is gone when `gremion-cd status` is asked and the
    # state's live colour is the OLD one, the colour that serves. Read before the sidecar goes.
    if _cd_rb_done stop && [[ "${RB_STOP_FAILED:-0}" -eq 0 ]]; then running=0; fi
    cd_hist rollback_failed reason="$reason" rule="$RB_RULE" || true
    if [[ "$running" -eq 1 ]]; then left="$RB_NEW_COLOUR"; fi
    cd_hold_set rollback_failed "$reason" "$RB_NEW_SHA12" "$left" || true
    if [[ "$RB_SYNTH" == 1 ]]; then
        # the record was made for this rollback (nothing was in flight): a failed rollback must not
        # leave it behind, a reader could take it for a commit with steps pending
        cd_state_set '.phase = "idle" | .release = null' || true
    else
        cd_state_set '.phase = "idle"' || true
    fi
    rm -f -- "$(_cd_rb_sidecar)" 2>/dev/null || true
    mapfile -t f < <(_cd_rb_mail_fields)
    f+=("stage=${RB_STAGE:-none}" "reason=${reason}" "command=gremion-cd status")
    if [[ "$running" == 1 ]]; then notes="${notes:+${notes},}new_colour_still_running"; fi
    if [[ -n "$notes" ]]; then f+=("notes=${notes}"); fi
    # no dedupe key: every failed attempt is a critical mail of its own (a retry on the same release
    # record must not be silenced)
    cd_notify rollback_failed "${f[@]}" || true
    CD_ROLLBACK_REASON="$reason"
    return 1
}

_cd_rb_finish() {
    cd_hist rolled_back rule="$RB_RULE" committed="$RB_COMMITTED" colour="$RB_OLD_COLOUR" || true
    cd_state_set '.phase = "idle" | .release = null' || return 1
    rm -f -- "$(_cd_rb_sidecar)" 2>/dev/null || true
    return 0
}

# _cd_rb_step NAME - run one step unless it is marked done.
_cd_rb_step() {
    local name="$1"
    if _cd_rb_done "$name"; then return 0; fi
    "_cd_rb_s_${name}" || return 1
    _cd_rb_mark "$name" || { _cd_rb_why mark_failed "the rollback record could not be written"; return 1; }
    return 0
}

cd_rollback_run() {
    local rule="${1:-}" rc=0 s
    CD_ROLLBACK_REASON=''
    RB_NOTE=''
    RB_STOP_FAILED=0
    RB_CONFIRMED_AT=0
    [[ "$#" -eq 1 ]] || { _cd_rb_err "cd_rollback_run: usage: RULE"; return 2; }
    [[ "$rule" =~ ^[a-z0-9_]{1,40}$ && "$_CD_RB_RULES" == *" ${rule} "* ]] || { _cd_rb_err "cd_rollback_run: not a rollback rule"; return 2; }
    # the refusals first, read-only: nothing is written, no lock is taken
    _cd_rb_plan "$rule" >/dev/null || return $?
    cd_lock_take || { rc=$?; [[ "$rc" -eq 3 ]] && _cd_rb_err "another rollback or release holds the cd lock"; return "$rc"; }
    # the state may have moved between the read and the lock
    _cd_rb_plan "$rule" || return $?
    _cd_rb_begin || return $?
    for s in $_CD_RB_STEPS; do
        # a failed watch on the old colour comes after the confirm: settle the gate and the block
        _cd_rb_step "$s" || { if [[ "$s" == watch ]]; then _cd_rb_settle; fi; _cd_rb_fail; return $?; }
    done
    _cd_rb_finish || { _cd_rb_why state_failed "the state could not be written"; _cd_rb_fail; return $?; }
    return 0
}
