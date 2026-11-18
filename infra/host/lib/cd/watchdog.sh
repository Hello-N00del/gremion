#!/usr/bin/env bash
# infra/host/lib/cd/watchdog.sh -- the gremion-cd dead-man check: verb `watchdog`.
#
# SOURCED, NEVER EXECUTED (see core.sh). Run by its own unit on its own timer (every ten
# minutes), so it is separate from the tick it watches.
#
# STATE-FREE LIVENESS. The first thing the watchdog judges is whether the program is alive,
# and for that it reads only: the heartbeat file, a flock probe of the cd lock, the age of the
# oldest queued mail, the data/cd/ALERT file and the kill switch. It never parses state.json
# for liveness, and a missing, truncated or foreign-version state file is itself an alert (a `stalled` mail with
# detail state_unreadable), never an exit 2 that would silence the watchdog together with the
# tick. The rules that need the state (a stale poll, a red main, the kill-switch reminder)
# run after the liveness rules and read it with a tolerant jq.
#
# This file does not source or call the poller or the pipeline driver: the dead-man check
# must not live in the code it watches (a test greps for it).
#
# THE JUDGEMENTS
#   no cd lock holder:   the heartbeat is older than three timer intervals (the tick rewrites
#                        it on every run) -> `stalled`, once per distinct heartbeat; skipped
#                        while the kill switch is present, because automation is then off on
#                        purpose and the weekly reminder speaks instead.
#   cd lock held:        "release stuck" = the beat is older than three minutes, OR now is
#                        past stage start + 1.25 x budget + 120 s (the heartbeat stops itself
#                        at the same limit, core.sh). A 60 minute build with a live beat is
#                        not stuck; a hung stage whose beat stopped is.
#   an outbox file older than one hour (on any transport but a stated Stalwart) -> data/cd/ALERT
#                        and a logger line (cd_alert): the mail path is dead, so no mail can say
#                        so. The watchdog sends the queue first and judges the age of what is
#                        left, so a relay that is back after a long outage writes no ALERT.
#   data/cd/ALERT present (a fatal exit of the tick wrote it, or the rule above did) ->
#                        `stalled` detail alert, once per ALERT episode and daily after, even while
#                        the heartbeat is fresh and with the kill switch on.
#   the last poll success older than CD_STALL_MINUTES while `git ls-remote` shows a tip that
#                        neither the poller nor the live release knows -> `stalled`.
#   main red for six hours -> one `stalled` mail per red episode.
#   the kill switch present -> one `killswitch` reminder a week.
# The watchdog keeps its own few facts (when the poll last succeeded, since when main is red)
# in data/cd/watchdog.state and its dedupe marks in data/cd/notified.marks, so it never
# writes the state file and never needs the cd lock.

CD_WD_TICK_S=300
CD_WD_BEAT_STALE_S=180
CD_WD_RED_S=21600

_cd_wd_file() { printf '%s' "${CD_DATA}/watchdog.state"; }

# _cd_wd_get KEY -- the value in the watchdog's own file (empty when absent).
_cd_wd_get() {
    local f
    f="$(_cd_wd_file)"
    [[ -f "$f" ]] || return 0
    awk -F= -v k="$1" '$1 == k { v = substr($0, length(k) + 2) } END { if (v != "") print v }' "$f" 2>/dev/null || true
}

# _cd_wd_put KEY VALUE / _cd_wd_del KEY
_cd_wd_put() {
    local f cur=""
    f="$(_cd_wd_file)"
    [[ -f "$f" ]] && cur="$(awk -F= -v k="$1" '$1 != k' "$f" 2>/dev/null)"
    { [[ -n "$cur" ]] && printf '%s\n' "$cur"; printf '%s=%s\n' "$1" "$2"; } | cd_atomic_write "$f" 600
}
_cd_wd_del() {
    local f cur
    f="$(_cd_wd_file)"
    [[ -f "$f" ]] || return 0
    [[ -n "$(_cd_wd_get "$1")" ]] || return 0
    cur="$(awk -F= -v k="$1" '$1 != k' "$f" 2>/dev/null)"
    printf '%s\n' "$cur" | sed '/^$/d' | cd_atomic_write "$f" 600
}

# _cd_wd_lock_held -- 0 when another process holds the cd lock. A momentary non-blocking
# probe: the lock is taken and given back at once.
_cd_wd_lock_held() {
    local rc=0
    [[ -d "$CD_RUN" ]] || return 1
    command -v flock >/dev/null 2>&1 || return 1
    ( exec 6>>"${CD_RUN}/cd.lock" 2>/dev/null || exit 2; flock -n 6 ) || rc=$?
    (( rc == 1 ))
}

# _cd_wd_hb_read -- the heartbeat into HB_EPOCH HB_PHASE HB_STAGE HB_START HB_BUDGET HB_PID.
# 0 read, 1 no file, 2 not a heartbeat.
_cd_wd_hb_read() {
    local line="" extra=""
    HB_EPOCH="" HB_PHASE="" HB_STAGE="" HB_START="" HB_BUDGET="" HB_PID=""
    [[ -f "$CD_HEARTBEAT_FILE" ]] || return 1
    read -r line < "$CD_HEARTBEAT_FILE" 2>/dev/null || true
    read -r HB_EPOCH HB_PHASE HB_STAGE HB_START HB_BUDGET HB_PID extra <<< "$line" || true
    if [[ ! "$HB_EPOCH" =~ ^[0-9]{1,12}$ || ! "$HB_START" =~ ^[0-9]{1,12}$ \
        || ! "$HB_BUDGET" =~ ^[0-9]{1,9}$ || ! "$HB_PID" =~ ^[0-9]{1,9}$ \
        || ! "$HB_PHASE" =~ ^[a-z_]+$ || ! "$HB_STAGE" =~ ^[a-z_]+$ || -n "$extra" ]]; then
        return 2
    fi
    return 0
}

# _cd_wd_state_read -- WD_PHASE WD_LIVE12 WD_TIP12 WD_VERDICT WD_LAST_AT WD_LAST_OK from the
# state with a tolerant jq. 0 when the file is a version-1 document, 1 otherwise.
_cd_wd_state_read() {
    local out
    WD_PHASE=unknown WD_LIVE12=none WD_TIP12="" WD_VERDICT="" WD_LAST_AT="" WD_LAST_OK=""
    [[ -f "$CD_STATE_FILE" ]] || return 1
    jq -e 'type == "object" and .v == 1 and ((.poll // {}) | type == "object")' "$CD_STATE_FILE" >/dev/null 2>&1 </dev/null || return 1
    out="$(jq -r '[(.phase // "unknown"), (.live.sha12 // "none"), (.poll.tip12 // ""), (.poll.verdict // ""),
                   (.poll.last_at // ""), ((.poll.last_ok // "") | tostring)] | join("|")' "$CD_STATE_FILE" 2>/dev/null </dev/null)" || return 1
    # a separator that is not whitespace: with a tab an empty field (a poll that never ran
    # has no tip and no time) would be collapsed and every later value would shift
    IFS='|' read -r WD_PHASE WD_LIVE12 WD_TIP12 WD_VERDICT WD_LAST_AT WD_LAST_OK <<< "$out" || true
    [[ "$WD_PHASE" =~ ^[a-z_]+$ ]] || WD_PHASE=unknown
    [[ "$WD_LIVE12" =~ ^[0-9a-f]{12}$ ]] || WD_LIVE12=none
    return 0
}

# _cd_wd_stalled DETAIL KEY EVERY PHASE STAGE [HB_AGE_MIN] [POLL_AGE_MIN]
_cd_wd_stalled() {
    local detail="$1" key="$2" every="$3" phase="$4" stage="$5" hb="${6:-}" poll="${7:-}"
    local -a args=("detail=${detail}" "key=${key}" "phase=${phase}")
    [[ -n "$every" ]] && args+=("every=${every}")
    [[ -n "$stage" ]] && args+=("stage=${stage}")
    [[ -n "$hb" ]] && args+=("heartbeat_age_min=${hb}")
    [[ -n "$poll" ]] && args+=("poll_age_min=${poll}")
    args+=("command=gremion-cd status")
    cd_notify stalled "${args[@]}"
}

# -- liveness (state-free) ---------------------------------------------------------------
_cd_wd_liveness() {
    local now="$1" held=0 hbrc=0 age limit detail="" key
    _cd_wd_lock_held && held=1
    _cd_wd_hb_read || hbrc=$?
    if (( held == 1 )); then
        case "$hbrc" in
            1) _cd_wd_stalled no_heartbeat no_heartbeat 86400 unknown "" ; return 0 ;;
            2) _cd_wd_stalled heartbeat_unreadable heartbeat_unreadable 86400 unknown "" ; return 0 ;;
        esac
        age=$(( now - HB_EPOCH ))
        (( age < 0 )) && age=0
        limit=$(( HB_BUDGET + HB_BUDGET / 4 + 120 ))
        if (( age > CD_WD_BEAT_STALE_S )); then
            detail=release_stuck
            key="stuck-${HB_START}-beat"
        elif (( now > HB_START + limit )); then
            detail=release_over_budget
            key="stuck-${HB_START}-budget"
        fi
        if [[ -n "$detail" ]]; then
            _cd_wd_stalled "$detail" "$key" "" "$HB_PHASE" "$HB_STAGE" "$(( age / 60 ))"
        fi
        return 0
    fi
    # no lock holder: the tick is not running right now, so the heartbeat of its last run
    # must be recent. With the kill switch on and an idle program, automation is off on
    # purpose and the weekly reminder speaks instead. A heartbeat that names a release in
    # flight (releasing, watching, rolling_back) with nobody holding the lock is a crashed
    # release, and the kill switch must not hide it.
    if cd_killswitch_active && { (( hbrc != 0 )) || [[ "$HB_PHASE" == idle ]]; }; then
        return 0
    fi
    case "$hbrc" in
        1) _cd_wd_stalled no_heartbeat no_heartbeat 86400 unknown "" ; return 0 ;;
        2) _cd_wd_stalled heartbeat_unreadable heartbeat_unreadable 86400 unknown "" ; return 0 ;;
    esac
    age=$(( now - HB_EPOCH ))
    (( age < 0 )) && age=0
    if (( age > 3 * CD_WD_TICK_S )); then
        _cd_wd_stalled no_tick "no_tick-${HB_EPOCH}" "" "$HB_PHASE" "$HB_STAGE" "$(( age / 60 ))"
    fi
    return 0
}

# -- the mail path -----------------------------------------------------------------------
_cd_wd_outbox() {
    local age
    age="$(cd_notify_outbox_age)"
    (( age > 3600 )) || return 0
    # Stalwart cannot send, which is a stated limit and the only thing that excuses an old
    # file. A transport that cannot be read (gremion-mail missing, half-installed or failing)
    # is not that answer: the mail path may be dead, so unknown is never green.
    if ! cd_notify_transport_ok && [[ "$CD_NOTIFY_TRANSPORT_VALUE" == stalwart ]]; then
        return 0
    fi
    cd_alert "the mail outbox has a message older than one hour"
}

# -- the ALERT file ----------------------------------------------------------------------
# A fatal exit of the tick (a bad config, a state this program rejects) writes data/cd/ALERT
# and leaves a heartbeat behind, and the state-free liveness rules above are content with a
# fresh heartbeat. Without this rule a tick that dies on every run is silent for as long as
# the beat is young, and the ALERT it wrote reaches nobody but the start gate. One `stalled`
# mail per ALERT episode (from the first run that sees the file to the run that finds it gone),
# a reminder once a day while it stands, whatever the kill switch says. It reads the file's
# existence only, never its text.
_cd_wd_alert() {
    local now="$1" since phase=unknown stage=""
    if [[ ! -e "$CD_ALERT_FILE" ]]; then
        _cd_wd_del alert_since || true
        return 0
    fi
    # The episode, not the file's time, is the identity: cd_alert rewrites the file on every
    # failing tick and every dead-relay run, so its mtime changes all the time.
    since="$(_cd_wd_get alert_since)"
    if [[ ! "$since" =~ ^[0-9]{1,12}$ ]]; then
        since="$now"
        _cd_wd_put alert_since "$now" || true
    fi
    if _cd_wd_hb_read; then
        phase="$HB_PHASE"
        stage="$HB_STAGE"
    fi
    _cd_wd_stalled alert "alert-${since}" 86400 "$phase" "$stage"
}

# -- rules that read the state -----------------------------------------------------------
# _cd_wd_remote_tip -- the full SHA of main at the repository, empty when it cannot be read.
_cd_wd_remote_tip() {
    local url out sha
    url="$(cd_cfg CD_REPO_URL 2>/dev/null)" || return 1
    out="$(GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote "$url" refs/heads/main </dev/null 2>/dev/null)" || return 1
    sha="$(printf '%s\n' "$out" | awk 'NR == 1 { print $1 }')"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    printf '%s\n' "$sha"
}

_cd_wd_state_rules() {
    local now="$1" stall_min ok_e last_e age_min since remote ks
    if ! _cd_wd_state_read; then
        _cd_wd_stalled state_unreadable state_unreadable 86400 unknown ""
        return 0
    fi
    # With the kill switch on nothing polls (the plan's kill switch rule), so a poll that
    # grows old and a verdict that stays red are expected, not alarms: the weekly reminder
    # is the one message. The liveness rules and an unreadable state above still run.
    if cd_killswitch_active; then
        _cd_wd_del red_since || true
        _cd_wd_put killswitch_seen "$now" || true
        return 0
    fi
    # main red for six hours
    if [[ "$WD_VERDICT" == red ]]; then
        since="$(_cd_wd_get red_since)"
        if [[ ! "$since" =~ ^[0-9]{1,12}$ ]]; then
            since="$now"
            _cd_wd_put red_since "$now" || true
        fi
        if (( now - since >= CD_WD_RED_S )); then
            _cd_wd_stalled main_red "main_red-${since}" "" "$WD_PHASE" ""
        fi
    else
        _cd_wd_del red_since || true
    fi
    # a stale poll while a newer tip exists
    stall_min="$(cd_cfg CD_STALL_MINUTES)" || return 0
    ok_e="$(_cd_wd_get poll_ok_epoch)"
    [[ "$ok_e" =~ ^[0-9]{1,12}$ ]] || ok_e=""
    if [[ "$WD_LAST_OK" == true ]] && last_e="$(_cd_nf_epoch "$WD_LAST_AT")"; then
        ok_e="$last_e"
        _cd_wd_put poll_ok_epoch "$ok_e" || true
    elif [[ -z "$ok_e" ]]; then
        ok_e="$now"
        _cd_wd_put poll_ok_epoch "$ok_e" || true
    fi
    # the poll was off on purpose while the kill switch was on: count from its last sighting
    ks="$(_cd_wd_get killswitch_seen)"
    if [[ "$ks" =~ ^[0-9]{1,12}$ ]] && (( ks > ok_e )); then ok_e="$ks"; fi
    (( now > ok_e )) || return 0
    age_min=$(( (now - ok_e) / 60 ))
    (( age_min >= stall_min )) || return 0
    remote="$(_cd_wd_remote_tip)" || return 0
    if [[ "${remote:0:12}" != "$WD_TIP12" && "${remote:0:12}" != "$WD_LIVE12" ]]; then
        _cd_wd_stalled poll_stale poll_stale 86400 "$WD_PHASE" "" "" "$age_min"
    fi
    return 0
}

_cd_wd_killswitch() {
    cd_killswitch_active || return 0
    _cd_wd_state_read || true
    cd_notify killswitch key=weekly every=604800 "phase=${WD_PHASE:-unknown}" "sha12=${WD_LIVE12:-none}"
}

# cd_cmd_watchdog -- the verb. It exits 0 whatever it finds (the dispatcher already refused a
# bad config); every judgement below is mailed or alerted, never an exit code.
cd_cmd_watchdog() {
    local now
    # shellcheck disable=SC2034  # read by notify.sh
    CD_NOTIFY_MARKS="file"
    cd_mkdir "$CD_DATA" || return 2
    now="$(cd_now)" || return 2
    local flush_rc=0
    # send first: an outbox that is old only because the watchdog (or the tick) was away
    # is judged after the send it may now get, not before
    cd_notify_flush || flush_rc=$?
    _cd_wd_liveness "$now" || cd_hist watchdog_rule_failed rule=liveness || true
    _cd_wd_outbox || cd_hist watchdog_rule_failed rule=outbox || true
    _cd_wd_alert "$now" || cd_hist watchdog_rule_failed rule=alert || true
    _cd_wd_state_rules "$now" || cd_hist watchdog_rule_failed rule=state || true
    _cd_wd_killswitch || cd_hist watchdog_rule_failed rule=killswitch || true
    # the mails this run queued leave now, unless the first pass of this run already failed or
    # found no usable transport (a relay that just refused is not asked a second time, a
    # send may take a minute, and the "not supported" line is logged once a run)
    if (( flush_rc != 1 && flush_rc != 2 )); then cd_notify_flush || true; fi
    return 0
}
