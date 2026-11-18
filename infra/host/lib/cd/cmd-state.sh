#!/usr/bin/env bash
# infra/host/lib/cd/cmd-state.sh -- the operator verbs that only read the state or queue a
# request: help, version, status, hold, resume.
#
# SOURCED, NEVER EXECUTED (see core.sh): no shell options set here, nothing runs at the top
# level. `hold` and `resume` never touch the state: they write a request file and try to
# start the unit that drains it (the process that holds the locks drains requests; an idle
# one takes them at the next tick). `status` is read-only and prints NAMES, COUNTS and
# CODES: the operator-value keys of cd.env show as set or unset and never as a value.

# -- help and version ---------------------------------------------------------
cd_cmd_help() {
    local fn
    cat <<'EOF'
usage: gremion-cd VERB [ARGS]
verbs:
EOF
    while IFS= read -r fn; do
        fn="${fn#declare -f cd_cmd_}"
        printf '  %s\n' "${fn//_/-}"
    done < <(declare -F | grep -E '^declare -f cd_cmd_' | LC_ALL=C sort)
    cat <<'EOF'
exit codes: 0 ok, 1 an assertion failed, 2 usage or a missing precondition, 3 busy or blocked
EOF
}

cd_cmd_version() {
    printf 'gremion-cd %s (state schema %s)\n' "$CD_PROGRAM_VERSION" "$CD_STATE_SCHEMA"
}

# -- request helpers ----------------------------------------------------------
# cd_arg_reason TEXT -- a reason is one line of at most 200 characters, no control bytes.
cd_arg_reason() {
    local r="${1-}"
    if [[ "$r" == *[[:cntrl:]]* || ${#r} -gt 200 ]]; then
        cd_die 2 "--reason must be one line of at most 200 characters"
    fi
}

# cd_request_kick -- try to start the unit that drains requests; a missing sudoers entry
# is not an error, the next tick takes the request.
cd_request_kick() {
    if sudo -n systemctl start --no-block gremion-cd.service </dev/null >/dev/null 2>&1; then
        cd_info "queued; the service was started"
    else
        cd_info "queued; the next tick takes it (the service could not be started from here)"
    fi
}

# -- status -------------------------------------------------------------------
# cd_status_changed_keys -- the keys whose value differs from the default, by name only.
cd_status_changed_keys() {
    local key cur op
    local -a out=()
    for key in "${!CD_KIND[@]}"; do
        for op in "${CD_OPERATOR_KEYS[@]}"; do
            [[ "$key" == "$op" ]] && continue 2
        done
        [[ -n "${CD_CFG[$key]+set}" ]] || continue
        cur="${CD_CFG[$key]}"
        if [[ -n "${CD_DEFAULTS[$key]+set}" ]]; then
            [[ "$cur" == "${CD_DEFAULTS[$key]}" ]] && continue
        else
            [[ -z "$cur" ]] && continue
        fi
        out+=("$key")
    done
    ((${#out[@]} > 0)) && printf '%s\n' "${out[@]}" | LC_ALL=C sort
    return 0
}

cd_cmd_status() {
    local as_json=0 arg
    for arg in "$@"; do
        case "$arg" in
            --json) as_json=1 ;;
            *) cd_die 2 "status: unknown argument (usage: gremion-cd status [--json])" ;;
        esac
    done

    local proof auto adopted=false doc="" phase="" now
    proof="$(cd_cfg CD_PROOF_MODE)"
    auto=on
    cd_killswitch_active && auto=off
    if [[ -f "$CD_STATE_FILE" ]]; then
        adopted=true
        cd_state_load
        doc="$CD_STATE_DOC"
        phase="$(printf '%s' "$doc" | jq -r .phase)"
    fi
    now="$(cd_now)" || return 2

    # the facts that come from the state
    local hold_j=null live_j=null prev_j=null rel_j=null poll_j=null serving_j=null watch_left=null
    local mods_j=null leaves_j=null rec_j=null
    if [[ "$adopted" == true ]]; then
        hold_j="$(printf '%s' "$doc" | jq -c '.hold')"
        live_j="$(printf '%s' "$doc" | jq -c '.live | if . == null then null else {sha12, tag, colour, since, proof: (.proof // false)} end')"
        prev_j="$(printf '%s' "$doc" | jq -c '.previous | if . == null then null else {sha12, tag, colour, startable} end')"
        rel_j="$(printf '%s' "$doc" | jq -c '.release | if . == null then null else {id, sha12, colour, stage, stage_status, attempt: (.attempt // 1), committed: (.committed_at != null)} end')"
        poll_j="$(printf '%s' "$doc" | jq -c '.poll')"
        mods_j="$(printf '%s' "$doc" | jq -c '.live.modules // null')"
        leaves_j="$(printf '%s' "$doc" | jq -c '.live.leaves // null')"
        rec_j="$(printf '%s' "$doc" | jq -c '.live.reconcile // null')"
        serving_j="$(printf '%s' "$doc" | jq -c '
            if .phase == "parked" and .release != null then {colour: .release.colour, sha12: .release.sha12, note: "the new release serves, current is still the old tree"}
            elif .live != null then {colour: .live.colour, sha12: .live.sha12, note: "live release"}
            else null end')"
        if [[ "$phase" == watching ]]; then
            watch_left="$(printf '%s' "$doc" | jq -r --argjson total "$(( $(cd_cfg CD_WATCH_MINUTES) * 60 ))" '
                ($total - (.release.watch.observed_s // 0)) as $left | (if $left < 0 then 0 else (($left + 59) / 60 | floor) end)')"
        fi
    fi

    # blocks
    local blocks_n blocks_rules
    cd_blocks_load
    blocks_n="$(printf '%s' "$CD_BLOCKS_DOC" | jq -r '[.[] | select(.cleared == null)] | length')"
    blocks_rules="$(printf '%s' "$CD_BLOCKS_DOC" | jq -r '[.[] | select(.cleared == null) | .rule] | unique | join(",")')"

    # dump sets
    local dumps_state=unknown dumps_out="" rc=0
    local -a dumps=()
    if declare -F cd_data_dumpset_live >/dev/null 2>&1; then
        if dumps_out="$(cd_data_dumpset_live </dev/null 2>/dev/null)"; then
            dumps_state=ok
            mapfile -t dumps < <(printf '%s\n' "$dumps_out" | sed '/^$/d')
        fi
    fi

    # host-program drift
    local drift=unknown drift_out="" drift_n=0
    if declare -F cd_manifest_diff >/dev/null 2>&1; then
        if drift_out="$(cd_manifest_diff "${CD_ROOT}/current" </dev/null 2>/dev/null)"; then rc=0; else rc=$?; fi
        drift_n="$(printf '%s\n' "$drift_out" | sed '/^$/d' | wc -l | tr -d ' ')"
        if (( drift_n > 0 )); then
            drift="drift:${drift_n}"
        elif (( rc == 0 )); then
            drift=none
        fi
    fi

    # mail
    local mail_ok=unknown outbox_age=null f e oldest=""
    if declare -F cd_notify_transport_ok >/dev/null 2>&1; then
        if cd_notify_transport_ok </dev/null >/dev/null 2>&1; then mail_ok=true; else mail_ok=false; fi
    fi
    if [[ -d "${CD_DATA}/outbox" ]]; then
        for f in "${CD_DATA}/outbox"/*; do
            [[ -f "$f" ]] || continue
            e="${f##*/}"
            e="${e%%-*}"
            [[ "$e" =~ ^[0-9]{9,12}$ ]] || continue
            if [[ -z "$oldest" ]] || (( e < oldest )); then oldest="$e"; fi
        done
        [[ -n "$oldest" ]] && outbox_age=$(( (now - oldest) / 60 ))
    fi
    local alert=false
    [[ -e "$CD_ALERT_FILE" ]] && alert=true

    # lock span against the backup and purge timers
    local span=unknown
    if declare -F cd_data_timer_guard >/dev/null 2>&1; then
        if cd_data_timer_guard "$(cd_cfg CD_LOCK_SPAN_MAX_MIN)" </dev/null >/dev/null 2>&1; then rc=0; else rc=$?; fi
        case "$rc" in
            0) span=fits ;;
            3) span=overlap ;;
            *) span=unknown ;;
        esac
    fi

    # host lock now, and how long the last release held it (a history event the driver writes)
    local hostlock_min=null
    if [[ -s "$CD_HIST_FILE" ]]; then
        hostlock_min="$(jq -rs '[.[] | select(.event == "hostlock_released" and (.minutes | type == "number"))] | last | .minutes // null' "$CD_HIST_FILE" 2>/dev/null)" || hostlock_min=null
        [[ "$hostlock_min" =~ ^[0-9]+$ ]] || hostlock_min=null
    fi

    # next timer elapse (best effort)
    local next_timer=""
    if command -v systemctl >/dev/null 2>&1; then
        next_timer="$(systemctl list-timers --no-pager --no-legend gremion-cd.timer 2>/dev/null </dev/null | head -n 1 | cut -c1-80)" || next_timer=""
        next_timer="$(cd_scrub_value "$next_timer")"
    fi

    # config: names that differ from the default, the operator keys as set / unset
    local -a changed=()
    mapfile -t changed < <(cd_status_changed_keys)
    local key op_j="{}"
    for key in "${CD_OPERATOR_KEYS[@]}"; do
        if cd_cfg_is_set "$key"; then
            op_j="$(printf '%s' "$op_j" | jq -c --arg k "$key" '. + {($k): "set"}')"
        else
            op_j="$(printf '%s' "$op_j" | jq -c --arg k "$key" '. + {($k): "unset"}')"
        fi
    done
    local changed_j
    if ((${#changed[@]} > 0)); then
        changed_j="$(printf '%s\n' "${changed[@]}" | jq -R . | jq -sc .)"
    else
        changed_j='[]'
    fi
    local dumps_j='[]'
    if ((${#dumps[@]} > 0)); then
        dumps_j="$(printf '%s\n' "${dumps[@]}" | jq -R . | jq -sc .)"
    fi

    if (( as_json )); then
        jq -n \
            --argjson proof "$([[ "$proof" == 1 ]] && echo true || echo false)" \
            --arg automation "$auto" --argjson adopted "$adopted" --arg phase "$phase" \
            --argjson hold "$hold_j" --argjson live "$live_j" --argjson previous "$prev_j" \
            --argjson release "$rel_j" --argjson serving "$serving_j" --argjson watch_minutes_left "$watch_left" \
            --argjson poll "$poll_j" --argjson blocks_open "$blocks_n" --arg blocks_rules "$blocks_rules" \
            --argjson reconcile "$rec_j" --argjson modules "$mods_j" --argjson leaves "$leaves_j" \
            --argjson hostlock_minutes "$hostlock_min" \
            --argjson dump_sets "$dumps_j" --arg dumps_state "$dumps_state" --arg drift "$drift" \
            --arg mail_ok "$mail_ok" --argjson outbox_age_min "$outbox_age" --argjson alert "$alert" \
            --arg lock_span "$span" --arg next_timer "$next_timer" \
            --argjson differs "$changed_j" --argjson operator "$op_j" '
            {proof_mode: $proof, automation: $automation, adopted: $adopted,
             phase: (if $phase == "" then null else $phase end),
             hold: $hold, live: $live, previous: $previous, release: $release, serving: $serving,
             watch_minutes_left: $watch_minutes_left, poll: $poll,
             blocks_open: $blocks_open, blocks_rules: ($blocks_rules | if . == "" then [] else split(",") end),
             reconcile: $reconcile, modules: $modules, leaves: $leaves,
             host_lock_last_minutes: $hostlock_minutes,
             dump_sets: $dump_sets, dump_sets_known: ($dumps_state == "ok"), host_drift: $drift,
             mail: {transport_ok: (if $mail_ok == "true" then true elif $mail_ok == "false" then false else null end), outbox_age_min: $outbox_age_min},
             alert: $alert, lock_span: $lock_span, next_timer: (if $next_timer == "" then null else $next_timer end),
             config: {differs: $differs, operator: $operator}}'
        return 0
    fi

    # -- text --
    if [[ "$proof" == 1 ]]; then
        printf 'PROOF MODE ON: releases are proof releases (mails carry [PROOF])\n'
    fi
    if [[ "$auto" == off ]]; then
        printf 'automation: OFF (kill switch file present: no poll, no new release, no automatic rollback)\n'
    else
        printf 'automation: on\n'
    fi
    if [[ "$adopted" != true ]]; then
        printf 'state: not adopted yet (no state file; run gremion-cd adopt)\n'
    else
        printf 'phase: %s\n' "$phase"
        if [[ "$phase" == parked ]]; then
            printf 'serving: %s\n' "$(printf '%s' "$serving_j" | jq -r '"parked: the new release " + .sha12 + " (" + .colour + ") serves; current is still the old tree"')"
        fi
        printf 'hold: %s\n' "$(printf '%s' "$hold_j" | jq -r 'if . == null then "none" else .kind + " (" + .reason + ") since " + .since + (if .sha12 != "" then " sha " + .sha12 else "" end) end')"
        printf 'live: %s\n' "$(printf '%s' "$live_j" | jq -r 'if . == null then "none" else .sha12 + " " + .tag + " " + .colour + " since " + .since + (if .proof then " (proof)" else "" end) end')"
        printf 'previous: %s\n' "$(printf '%s' "$prev_j" | jq -r 'if . == null then "none" else .sha12 + " " + .tag + " " + .colour + (if .startable then " startable" else " not startable" end) end')"
        printf 'release in flight: %s\n' "$(printf '%s' "$rel_j" | jq -r 'if . == null then "none" else .id + " " + .colour + " stage " + .stage + "/" + .stage_status + " attempt " + (.attempt | tostring) + (if .committed then " (committed)" else "" end) end')"
        if [[ "$watch_left" != null ]]; then
            printf 'watch: %s minutes left\n' "$watch_left"
        fi
        printf 'poll: %s\n' "$(printf '%s' "$poll_j" | jq -r 'if .last_at == "" then "never" else "last " + .last_at + (if .last_ok then " ok" else " FAILED" end) + ", candidate " + (if .tip12 == "" then "none" else .tip12 end) + " verdict " + .verdict + ", " + (.api_calls_hour | tostring) + " api calls this hour" end')"
    fi
    if (( blocks_n > 0 )); then
        printf 'blocks: %s open (%s)\n' "$blocks_n" "$blocks_rules"
    else
        printf 'blocks: 0 open\n'
    fi
    if [[ "$adopted" == true ]]; then
        printf 'reconcile (last): %s\n' "$(printf '%s' "$rec_j" | jq -r 'if . == null then "none yet" else (.total | tostring) + " customers: " + (.ok | tostring) + " ok, " + (.failed | tostring) + " failed, " + (.timeout | tostring) + " timeout, " + (.busy | tostring) + " busy, " + (.skipped | tostring) + " skipped, " + (.invalid | tostring) + " invalid, " + (.seconds | tostring) + " s at " + .at end')"
        printf 'modules: %s\n' "$(printf '%s' "$mods_j" | jq -r 'if . == null then "none yet" else (.total | tostring) + " total, " + (.upgraded | tostring) + " upgraded, " + (.unchanged | tostring) + " unchanged, " + (.skipped | tostring) + " skipped, " + (.failed | tostring) + " failed, " + (.files_applied | tostring) + " files applied" end')"
        printf 'leaves: %s\n' "$(printf '%s' "$leaves_j" | jq -r 'if . == null then "none yet" else (.total | tostring) + " total, " + (.migrated | tostring) + " migrated, " + (.skipped | tostring) + " skipped, " + (.failed | tostring) + " failed" end')"
    fi
    if [[ "$hostlock_min" == null ]]; then
        printf 'host lock: the span of the last release is not recorded\n'
    else
        printf 'host lock: the last release held it %s minutes\n' "$hostlock_min"
    fi
    if [[ "$dumps_state" != ok ]]; then
        printf 'dump sets live: unknown\n'
    elif ((${#dumps[@]} > 0)); then
        printf 'dump sets live: %s\n' "${dumps[*]}"
    else
        printf 'dump sets live: none\n'
    fi
    case "$drift" in
        none) printf 'host programs: no drift against the manifest\n' ;;
        drift:*) printf 'host programs: %s file(s) differ from the manifest\n' "${drift#drift:}" ;;
        *) printf 'host programs: drift unknown\n' ;;
    esac
    case "$mail_ok" in
        true) printf 'mail: transport ok' ;;
        false) printf 'mail: transport NOT ok' ;;
        *) printf 'mail: transport unknown' ;;
    esac
    if [[ "$outbox_age" == null ]]; then printf ', outbox empty\n'; else printf ', oldest outbox file %s minutes old\n' "$outbox_age"; fi
    if [[ "$alert" == true ]]; then
        printf 'ALERT: present (data/cd/ALERT; a release on the relay transport waits until it is dealt with)\n'
    fi
    case "$span" in
        fits) printf 'lock span: fits before the next backup and purge\n' ;;
        overlap) printf 'lock span: overlaps a backup or purge timer\n' ;;
        *) printf 'lock span: unknown (no timer data)\n' ;;
    esac
    if ((${#changed[@]} > 0)); then
        printf 'config differs from the default: %s\n' "${changed[*]}"
    else
        printf 'config differs from the default: nothing\n'
    fi
    printf 'operator values:'
    for key in "${CD_OPERATOR_KEYS[@]}"; do
        printf ' %s=%s' "$key" "$(printf '%s' "$op_j" | jq -r --arg k "$key" '.[$k]')"
    done
    printf '\n'
    printf 'next timer: %s\n' "${next_timer:-unknown}"
}

# -- hold and resume ----------------------------------------------------------
cd_cmd_hold() {
    local reason=""
    while (($# > 0)); do
        case "$1" in
            --reason)
                (($# >= 2)) || cd_die 2 "hold: --reason needs a value"
                reason="$2"
                shift 2
                ;;
            *) cd_die 2 "hold: unknown argument (usage: gremion-cd hold [--reason TEXT])" ;;
        esac
    done
    cd_arg_reason "$reason"
    cd_state_load
    cd_request_put hold "$(jq -cn --arg reason "$reason" '{reason: $reason}')" || return $?
    cd_request_kick
}

# cd_resume_guidance KIND SHA12 -- how a classifier hold ends (it is the verdict on the
# newest candidate: resume would classify the same tree again and hold again).
cd_resume_guidance() {
    local kind="$1" sha="${2:-<sha12>}"
    [[ -n "$sha" ]] || sha="<sha12>"
    printf 'nothing to resume: %s is the classifier verdict on the newest candidate, and resume would classify the same tree again.\n' "$kind"
    case "$kind" in
        state_tier) printf 'It ends with: gremion-cd release-now %s --with-state\n' "$sha" ;;
        range_unverified) printf 'It ends with: gremion-cd release-now %s --accept-range --reason TEXT\n' "$sha" ;;
        ci_changed | batch_too_large | chain_class_changed) printf 'It ends with: gremion-cd release-now %s\n' "$sha" ;;
        unsupported_chain | contract_migration | waived_migration)
            printf 'Stage 1 cannot apply this by itself: a hand upgrade of the host, then gremion-cd adopt --re-adopt --reason TEXT.\n' ;;
        ruleset_missing)
            # the cause is the repository's rules, not a commit: nothing a commit does ends it
            printf 'It cannot be waived: fix the cause by restoring the repository rules; the next tick goes on once they hold.\n'
            return 0
            ;;
        *) printf 'It cannot be waived: fix the cause (a later commit that removes it ends the hold at the next tick).\n' ;;
    esac
    printf 'It also ends by itself when a later commit removes the cause and the newest candidate classifies clean.\n'
}

cd_cmd_resume() {
    local reason="" discard=false accept=false doc kind sha12 phase live_out rc=0 nblocks
    while (($# > 0)); do
        case "$1" in
            --reason)
                (($# >= 2)) || cd_die 2 "resume: --reason needs a value"
                reason="$2"
                shift 2
                ;;
            --discard-dump) discard=true; shift ;;
            --accept-descendants) accept=true; shift ;;
            *) cd_die 2 "resume: unknown argument (usage: gremion-cd resume [--reason TEXT] [--discard-dump] [--accept-descendants])" ;;
        esac
    done
    cd_arg_reason "$reason"
    if [[ "$accept" == true && -z "$reason" ]]; then
        cd_die 2 "resume: --accept-descendants needs --reason TEXT (it is logged and mailed)"
    fi
    cd_state_load
    doc="$CD_STATE_DOC"
    kind="$(printf '%s' "$doc" | jq -r '.hold.kind // empty')"
    sha12="$(printf '%s' "$doc" | jq -r '.hold.sha12 // empty')"
    phase="$(printf '%s' "$doc" | jq -r '.phase')"
    if [[ -z "$kind" ]]; then
        cd_info "no hold: nothing to resume"
        return 0
    fi
    case "$kind" in
        state_tier | unsupported_chain | contract_migration | waived_migration | ci_changed | chain_class_changed \
            | batch_too_large | not_ancestor | ruleset_missing | range_unverified | classify_failed)
            cd_resume_guidance "$kind" "$sha12"
            return 0
            ;;
    esac

    # an open block: a plain resume would let the next commit, which contains the bad one,
    # go out
    cd_blocks_load
    nblocks="$(printf '%s' "$CD_BLOCKS_DOC" | jq -r '[.[] | select(.cleared == null)] | length')"
    if (( nblocks > 0 )) && [[ "$accept" != true ]]; then
        cd_err "resume refused: ${nblocks} block(s) are open (every later commit contains the blocked one)."
        cd_err "Release the fix with: gremion-cd release-now <sha12>, or accept the descendants with: gremion-cd resume --accept-descendants --reason TEXT"
        return 2
    fi

    # a failed release's dump set is a restore point the next take refuses to overwrite:
    # the operator decides (restore, discard by hand, or --discard-dump). A parked release is
    # not a failed one: its dump set is legitimately live.
    if [[ "$phase" == idle && "$discard" != true ]]; then
        if ! declare -F cd_data_dumpset_live >/dev/null 2>&1; then
            cd_err "resume refused: the live dump sets cannot be checked (data.sh is not installed)"
            return 2
        fi
        if live_out="$(cd_data_dumpset_live </dev/null 2>/dev/null)"; then rc=0; else rc=$?; fi
        if (( rc != 0 )); then
            cd_err "resume refused: the live dump sets could not be listed (unknown is not clear)"
            return 2
        fi
        if [[ -n "$(printf '%s' "$live_out" | tr -d '[:space:]')" ]]; then
            cd_err "resume refused: a dump set is live after a failed release. Restore or discard it first, or pass --discard-dump to resume."
            return 2
        fi
    fi

    cd_request_put resume "$(jq -cn --arg reason "$reason" --argjson d "$discard" --argjson a "$accept" \
        '{reason: $reason, discard_dump: $d, accept_descendants: $a}')" || return $?
    cd_request_kick
}
