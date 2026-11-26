#!/usr/bin/env bats
# test/host/cd-watchdog.bats -- cd-notify: infra/host/lib/cd/watchdog.sh (the gremion-cd
# dead-man check, verb `watchdog`).
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-watchdog.bats
#
# The watchdog flushes the outbox at its end; most tests keep the relay failing
# (.curl-fail) so the mails it queued stay in the outbox where the test can read them.
# Time is the fake clock of core.sh: NOW is 1700000000.

load 'test_helper/host'
load 'test_helper/cd'
load 'test_helper/cd-notify'

NOW=1700000000

setup() {
    notify_setup
    touch "${GREMION_ROOT}/.curl-fail"
    shim logger
    # git answers `ls-remote ... refs/heads/main` with the SHA in .git-tip, or fails
    shim git 'if [ -f "$GREMION_ROOT/.git-fail" ]; then exit 128; fi; printf "%s\trefs/heads/main\n" "$(cat "$GREMION_ROOT/.git-tip")"'
    cd_seed_state
}
teardown() { cd_teardown; }

# hb EPOCH [PHASE STAGE START BUDGET PID] -- the heartbeat file
hb() { printf '%s %s %s %s %s %s\n' "$1" "${2:-idle}" "${3:-tick}" "${4:-$1}" "${5:-60}" "${6:-1234}" > "${GREMION_ROOT}/runtime/cd/heartbeat"; }
# a fresh idle heartbeat at the fake clock's now
fresh_hb() { hb "$(cd_clock)"; }
# the queued mails that carry DETAIL
mails_with() { grep -l "^detail: ${1}\$" "${GREMION_ROOT}"/data/cd/outbox/*.eml 2>/dev/null | wc -l | tr -d ' '; }
hold_cd_lock() { cd_need_flock; cd_bg 'cd_lock_take; echo ready; exec sleep 300'; }
wd() { run nlib 'cd_cmd_watchdog'; }

# ---------------------------------------------------------------------------
# Liveness: no lock holder
# ---------------------------------------------------------------------------

@test "liveness: a heartbeat within three timer intervals and no lock is quiet" {
    cd_need_flock
    hb $(( NOW - 800 ))
    wd
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
}

@test "liveness: a heartbeat older than three intervals with no cd lock holder gives stalled once, not every run" {
    cd_need_flock
    hb $(( NOW - 1000 ))
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with no_tick)" -eq 1 ]
    grep -qx 'kind: stalled' "$(mail_files)"
    grep -qx 'phase: idle' "$(mail_files)"
    grep -qx 'heartbeat_age_min: 16' "$(mail_files)"
    wd
    [ "$status" -eq 0 ]
    cd_advance 600
    wd
    [ "$(mails_with no_tick)" -eq 1 ]
    # a new stall (a newer heartbeat that goes stale again) is a new mail
    hb $(( NOW + 600 - 10 ))
    cd_advance 2000
    wd
    [ "$(mails_with no_tick)" -eq 2 ]
}

@test "liveness: no heartbeat file at all with no lock holder is an alert too" {
    cd_need_flock
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with no_heartbeat)" -eq 1 ]
}

@test "liveness: an unreadable heartbeat is an alert, never a pass" {
    cd_need_flock
    printf 'garbage here\n' > "${GREMION_ROOT}/runtime/cd/heartbeat"
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with heartbeat_unreadable)" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Liveness: the lock is held (release stuck)
# ---------------------------------------------------------------------------

@test "stuck: a 60 minute build with a live heartbeat is NOT stuck" {
    hold_cd_lock
    hb $(( NOW - 10 )) releasing build $(( NOW - 3000 )) 3600 "$CD_BG_PID"
    wd
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
}

@test "stuck: a hung stage whose beat stopped (older than three minutes) IS stuck, once" {
    hold_cd_lock
    hb $(( NOW - 400 )) releasing build $(( NOW - 3000 )) 3600 "$CD_BG_PID"
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with release_stuck)" -eq 1 ]
    grep -qx 'stage: build' "$(mail_files)"
    grep -qx 'phase: releasing' "$(mail_files)"
    wd
    [ "$(mails_with release_stuck)" -eq 1 ]
}

@test "stuck: now past stage start + 1.25 x budget + 120 s is stuck even while a beat is fresh" {
    hold_cd_lock
    # budget 600 s: the limit is 870 s after the stage started
    hb $(( NOW - 5 )) releasing snapshot $(( NOW - 1000 )) 600 "$CD_BG_PID"
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with release_over_budget)" -eq 1 ]
    [ "$(mails_with release_stuck)" -eq 0 ]
    # and just inside the limit it is not
    rm -f "${GREMION_ROOT}"/data/cd/outbox/*.eml "${GREMION_ROOT}/data/cd/notified.marks"
    hb $(( NOW - 5 )) releasing snapshot $(( NOW - 860 )) 600 "$CD_BG_PID"
    wd
    [ "$(mail_count)" -eq 0 ]
}

# the process that has just taken the cd lock and has not yet written a beat of its own: the
# lock is held, the heartbeat on disk is still the previous run's
hold_cd_lock_unannounced() {
    cd_need_flock
    cd_bg 'cd_mkdir "$CD_RUN"; exec 8>>"${CD_RUN}/cd.lock"; flock -n 8; echo ready; exec sleep 300'
}
# a process id that is certainly not running
gone_pid() { bash -c 'echo $$'; }

@test "stuck: a lock just taken, with the previous run's old beat (another pid) still on disk, is NOT stuck" {
    hold_cd_lock_unannounced
    # the shape seen on a host: the beat of the previous tick, 368 s old, written by a process that has ended
    hb $(( NOW - 368 )) idle tick $(( NOW - 368 )) 600 "$(gone_pid)"
    wd
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
}

@test "stuck: an old beat of a live process that does not hold the lock is the previous run's, not the holder's" {
    hold_cd_lock_unannounced
    sleep 30 3>&- &
    local other=$!
    hb $(( NOW - 368 )) idle tick $(( NOW - 368 )) 600 "$other"
    wd
    kill "$other" 2>/dev/null || true
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
}

@test "stuck: the budget rule is not applied to the previous run's beat either" {
    hold_cd_lock_unannounced
    hb $(( NOW - 5 )) releasing snapshot $(( NOW - 1000 )) 600 "$(gone_pid)"
    wd
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
}

@test "stuck: the holder's own beat older than three minutes is stuck as before (the holder is told apart by pid)" {
    hold_cd_lock_unannounced
    hb $(( NOW - 368 )) idle tick $(( NOW - 368 )) 600 "$CD_BG_PID"
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with release_stuck)" -eq 1 ]
}

# A holder that never beats: the lock is held and the beat on disk belongs to another process.
# The first run that sees this only notes it (a holder that has just taken the lock looks the
# same); a later run that sees the same old beat with the lock still held, more than three
# minutes after the first sighting, reports it. The kill switch does not hide it: it is a
# process that holds the lock, not a program that is off on purpose.
@test "stuck: a holder that never writes a beat of its own is reported on the run that finds it still holding, once" {
    hold_cd_lock_unannounced
    hb $(( NOW - 1000 )) idle tick $(( NOW - 1000 )) 600 "$(gone_pid)"
    wd
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
    cd_advance 600
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with release_stuck)" -eq 1 ]
    [ "$(mails_with no_tick)" -eq 0 ]
    cd_advance 600
    wd
    [ "$(mails_with release_stuck)" -eq 1 ]
}

@test "stuck: the kill switch does not hide a holder that never beats (an idle beat of an earlier run, long past)" {
    hold_cd_lock_unannounced
    touch "${GREMION_ROOT}/etc/cd.disabled"
    hb $(( NOW - 5000 )) idle tick $(( NOW - 5000 )) 600 "$(gone_pid)"
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with release_stuck)" -eq 0 ]
    cd_advance 600
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with release_stuck)" -eq 1 ]
}

@test "stuck: a holder whose main process ended while a child keeps the lock is reported the same way (a release beat of a dead pid)" {
    hold_cd_lock_unannounced
    hb $(( NOW - 100 )) releasing build $(( NOW - 200 )) 3600 "$(gone_pid)"
    wd
    [ "$(mail_count)" -eq 0 ]
    cd_advance 600
    wd
    [ "$(mails_with release_stuck)" -eq 1 ]
}

@test "stuck: a second run within three minutes of the first sighting is still quiet (a hand-run verb that has just taken the lock)" {
    hold_cd_lock_unannounced
    hb $(( NOW - 5000 )) idle tick $(( NOW - 5000 )) 600 "$(gone_pid)"
    wd
    cd_advance 120
    wd
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
}

@test "stuck: once the holder beats, the first sighting is forgotten (a later holder with the same old beat is a new first sighting)" {
    hold_cd_lock_unannounced
    local old_beat="$(( NOW - 5000 )) idle tick $(( NOW - 5000 )) 600 $(gone_pid)"
    # shellcheck disable=SC2086
    hb $old_beat
    wd
    cd_advance 600
    # the holder beats, so the lock is judged by its own beat, which is fresh
    hb "$(cd_clock)" idle tick "$(cd_clock)" 600 "$CD_BG_PID"
    wd
    [ "$(mail_count)" -eq 0 ]
    cd_advance 600
    # the same old beat is back and the lock is held again: first sighting, quiet
    # shellcheck disable=SC2086
    hb $old_beat
    wd
    [ "$(mail_count)" -eq 0 ]
}

@test "stuck: with the lock free the first sighting is forgotten too" {
    hold_cd_lock_unannounced
    hb $(( NOW - 5000 )) idle tick $(( NOW - 5000 )) 600 "$(gone_pid)"
    wd
    kill "$CD_BG_PID" 2>/dev/null || true
    wait "$CD_BG_PID" 2>/dev/null || true
    touch "${GREMION_ROOT}/etc/cd.disabled"
    cd_advance 600
    wd
    [ "$(mails_with release_stuck)" -eq 0 ]
    hold_cd_lock_unannounced
    cd_advance 600
    wd
    [ "$(mails_with release_stuck)" -eq 0 ]
}

@test "stuck: when the holder cannot be told apart (unknown) the beat is judged as before" {
    hold_cd_lock_unannounced
    hb $(( NOW - 368 )) idle tick $(( NOW - 368 )) 600 "$(gone_pid)"
    run nlib 'cd_pid_holds_cd_lock() { return 2; }; cd_cmd_watchdog'
    [ "$status" -eq 0 ]
    [ "$(mails_with release_stuck)" -eq 1 ]
}

@test "stuck: a missing or unreadable heartbeat while the lock is held is stuck (a held lock is not proof of life)" {
    hold_cd_lock
    wd
    [ "$(mails_with no_heartbeat)" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Liveness is state-free: the state file is never parsed first
# ---------------------------------------------------------------------------

@test "state-free: with state.json deleted, truncated or carrying v 99 the liveness rules still run and the watchdog mails stalled with detail state_unreadable and exits 0" {
    cd_need_flock
    local variant
    for variant in deleted truncated v99; do
        rm -f "${GREMION_ROOT}"/data/cd/outbox/*.eml "${GREMION_ROOT}/data/cd/notified.marks" "${GREMION_ROOT}/data/cd/ALERT"
        case "$variant" in
            deleted) rm -f "${GREMION_ROOT}/data/cd/state.json" ;;
            truncated) printf '{"v":1,"phase":"idle","ho' > "${GREMION_ROOT}/data/cd/state.json" ;;
            v99) cd_base_state | jq '.v = 99' > "${GREMION_ROOT}/data/cd/state.json" ;;
        esac
        # a stale heartbeat as well: the liveness rule must still have run
        hb $(( NOW - 1000 ))
        wd
        [ "$status" -eq 0 ]
        [ "$(mails_with state_unreadable)" -eq 1 ]
        [ "$(mails_with no_tick)" -eq 1 ]
        # and a second run is quiet about both
        wd
        [ "$status" -eq 0 ]
        [ "$(mails_with state_unreadable)" -eq 1 ]
        [ "$(mails_with no_tick)" -eq 1 ]
    done
}

@test "state-free: a tick that dies at the state read leaves a fresh beat, and the unreadable state is still reported with the kill switch on" {
    cd_need_flock
    touch "${GREMION_ROOT}/etc/cd.disabled"
    printf 'not json' > "${GREMION_ROOT}/data/cd/state.json"
    hb "$NOW"
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with state_unreadable)" -eq 1 ]
}

@test "state-free: through the program, a deleted state is exit 0 with the same mails (the dispatcher does not turn it into exit 2)" {
    cd_need_flock
    rm -f "${GREMION_ROOT}/data/cd/state.json"
    hb $(( NOW - 1000 ))
    run cd_prog watchdog
    [ "$status" -eq 0 ]
    [ "$(mails_with state_unreadable)" -eq 1 ]
    [ "$(mails_with no_tick)" -eq 1 ]
}

@test "state-free: the watchdog never writes the state file, not even the dedupe mark of a mail it queues (the mark goes to its own file)" {
    cd_need_flock
    hb $(( NOW - 1000 ))
    local before
    before="$(cat "${GREMION_ROOT}/data/cd/state.json")"
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with no_tick)" -eq 1 ]
    [ "$(cat "${GREMION_ROOT}/data/cd/state.json")" = "$before" ]
    grep -q '^stalled:no_tick-' "${GREMION_ROOT}/data/cd/notified.marks"
}

# ---------------------------------------------------------------------------
# The kill switch does not disable the watchdog
# ---------------------------------------------------------------------------

@test "kill switch: the present file gives one weekly reminder" {
    cd_need_flock
    touch "${GREMION_ROOT}/etc/cd.disabled"
    fresh_hb
    wd
    [ "$status" -eq 0 ]
    [ "$(grep -l '^kind: killswitch$' "${GREMION_ROOT}"/data/cd/outbox/*.eml | wc -l | tr -d ' ')" -eq 1 ]
    cd_advance 600
    fresh_hb
    wd
    [ "$(mail_count)" -eq 1 ]
    cd_advance $(( 7 * 86400 ))
    fresh_hb
    wd
    # a week of dead relay also writes the ALERT file and its one mail; the reminders are two
    [ "$(grep -l '^kind: killswitch$' "${GREMION_ROOT}"/data/cd/outbox/*.eml | wc -l | tr -d ' ')" -eq 2 ]
}

@test "kill switch: an idle program with no heartbeat for hours is not an alarm (automation is off on purpose)" {
    cd_need_flock
    touch "${GREMION_ROOT}/etc/cd.disabled"
    hb $(( NOW - 5000 )) idle tick
    wd
    [ "$(mails_with no_tick)" -eq 0 ]
}

@test "kill switch: a heartbeat that names a release in flight with nobody holding the lock is still an alarm" {
    cd_need_flock
    touch "${GREMION_ROOT}/etc/cd.disabled"
    hb $(( NOW - 5000 )) watching watch $(( NOW - 6000 )) 1200 4321
    wd
    [ "$(mails_with no_tick)" -eq 1 ]
}

@test "kill switch: a stuck release is still reported while the switch is present" {
    hold_cd_lock
    touch "${GREMION_ROOT}/etc/cd.disabled"
    hb $(( NOW - 400 )) watching watch $(( NOW - 600 )) 1200 "$CD_BG_PID"
    wd
    [ "$(mails_with release_stuck)" -eq 1 ]
}

# ---------------------------------------------------------------------------
# The mail path
# ---------------------------------------------------------------------------

@test "outbox: a file older than one hour on the relay transport writes data/cd/ALERT and a logger line" {
    cd_need_flock
    run nlib 'cd_notify held sha12=aaaaaaaaaaaa hold=blocked'
    cd_advance 3700
    fresh_hb
    [ ! -e "${GREMION_ROOT}/data/cd/ALERT" ]
    wd
    [ "$status" -eq 0 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    assert_recorded logger "gremion-cd"
}

@test "outbox: a file younger than one hour is no alert" {
    cd_need_flock
    run nlib 'cd_notify held sha12=aaaaaaaaaaaa hold=blocked'
    cd_advance 3500
    fresh_hb
    wd
    [ ! -e "${GREMION_ROOT}/data/cd/ALERT" ]
}

@test "outbox: on the Stalwart transport an old file is a stated limit, not an alert" {
    cd_need_flock
    echo stalwart > "${GREMION_ROOT}/.transport"
    run nlib 'cd_notify held sha12=aaaaaaaaaaaa hold=blocked'
    cd_advance 7200
    fresh_hb
    wd
    [ "$status" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/data/cd/ALERT" ]
}

@test "outbox: a transport that cannot be read is NOT the stated Stalwart limit: an old file still writes ALERT (unknown is never green)" {
    cd_need_flock
    run nlib 'cd_notify held sha12=aaaaaaaaaaaa hold=blocked'
    echo broken > "${GREMION_ROOT}/.transport"
    cd_advance 7200
    fresh_hb
    wd
    [ "$status" -eq 0 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    assert_recorded logger "gremion-cd"
}

@test "outbox: a missing gremion-mail (half-installed host) with an old file still writes ALERT" {
    cd_need_flock
    run nlib 'cd_notify held sha12=aaaaaaaaaaaa hold=blocked'
    rm -f "${GREMION_ROOT}/bin/gremion-mail"
    cd_advance 7200
    fresh_hb
    wd
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
}

@test "outbox: the watchdog sends first and judges the age after, so a relay that is back after a long outage writes no ALERT" {
    cd_need_flock
    run nlib 'cd_notify held sha12=aaaaaaaaaaaa hold=blocked'
    cd_advance 7200
    rm -f "${GREMION_ROOT}/.curl-fail"
    fresh_hb
    wd
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/data/cd/ALERT" ]
}

@test "outbox: the watchdog flushes the queue, so the mail of a parked process still leaves the host" {
    cd_need_flock
    rm -f "${GREMION_ROOT}/.curl-fail"
    run nlib 'cd_notify parked sha12=aaaaaaaaaaaa colour=blue rule=watch_pause_cap'
    fresh_hb
    wd
    [ "$status" -eq 0 ]
    [ "$(curl_calls)" -eq 1 ]
    [ "$(mail_count)" -eq 0 ]
}

# ---------------------------------------------------------------------------
# data/cd/ALERT: a fatal exit of the tick must not stay silent behind a fresh heartbeat
# ---------------------------------------------------------------------------

# alerts_sent -- the alert mails the relay shim took
alerts_sent() { grep -l 'detail: alert' "${GREMION_ROOT}"/.sent.* 2>/dev/null | wc -l | tr -d ' '; }
# alert_at EPOCH -- an ALERT file with that mtime (what cd_alert leaves behind)
alert_at() {
    printf 'cd: state schema not supported
' > "${GREMION_ROOT}/data/cd/ALERT"
    touch -d "@$1" "${GREMION_ROOT}/data/cd/ALERT"
}

@test "alert: an ALERT file with a fresh heartbeat and a readable state gives one stalled mail with detail alert" {
    cd_need_flock
    fresh_hb
    alert_at $(( NOW - 100 ))
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with alert)" -eq 1 ]
    grep -qx 'kind: stalled' "$(mail_files)"
    grep -qx 'command: gremion-cd status' "$(mail_files)"
}

@test "alert: one mail per ALERT episode, not per rewrite -- every failing tick rewrites the file (a new mtime), and that is still one mail" {
    cd_need_flock
    fresh_hb
    alert_at $(( NOW - 100 ))
    wd
    [ "$(mails_with alert)" -eq 1 ]
    cd_advance 600
    fresh_hb
    alert_at $(( NOW + 600 ))
    wd
    cd_advance 600
    fresh_hb
    alert_at $(( NOW + 1200 ))
    wd
    [ "$(mails_with alert)" -eq 1 ]
}

@test "alert: a dead relay rewrites ALERT on every run (the outbox rule) and that is still one alert mail" {
    cd_need_flock
    run nlib 'cd_notify held sha12=aaaaaaaaaaaa hold=blocked'
    cd_advance 3700
    fresh_hb
    wd
    [ "$(mails_with alert)" -eq 1 ]
    # a new file mtime at the next run, whatever the filesystem's clock grain
    sleep 1.1
    cd_advance 600
    fresh_hb
    wd
    sleep 1.1
    cd_advance 600
    fresh_hb
    wd
    [ "$(mails_with alert)" -eq 1 ]
}

@test "alert: a reminder once a day while ALERT stands, and a new mail for a new episode after it was removed" {
    cd_need_flock
    rm -f "${GREMION_ROOT}/.curl-fail"
    fresh_hb
    alert_at $(( NOW - 100 ))
    wd
    [ "$(alerts_sent)" -eq 1 ]
    cd_advance 600
    fresh_hb
    wd
    [ "$(alerts_sent)" -eq 1 ]
    cd_advance 86400
    fresh_hb
    wd
    [ "$(alerts_sent)" -eq 2 ]
    # the operator clears it; the episode ends
    rm -f "${GREMION_ROOT}/data/cd/ALERT"
    cd_advance 600
    fresh_hb
    wd
    [ "$(alerts_sent)" -eq 2 ]
    cd_advance 600
    fresh_hb
    alert_at $(( NOW - 10 ))
    wd
    [ "$(alerts_sent)" -eq 3 ]
}

@test "alert: no ALERT file, no alert mail" {
    cd_need_flock
    fresh_hb
    wd
    [ "$(mails_with alert)" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
}

@test "alert: a tick that died on a schema it rejects (v 1 state that breaks the closed schema, ALERT written) is not silent behind its fresh heartbeat" {
    cd_need_flock
    fresh_hb
    cd_seed_state '.phase = "no-such-phase"'
    # the tick's first read of the state (the driver refreshes no heartbeat before it)
    run cd_lib 'cd_state_load'
    [ "$status" -eq 2 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    fresh_hb
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with alert)" -eq 1 ]
}

@test "alert: the kill switch does not hide an ALERT" {
    cd_need_flock
    touch "${GREMION_ROOT}/etc/cd.disabled"
    fresh_hb
    alert_at $(( NOW - 100 ))
    wd
    [ "$(mails_with alert)" -eq 1 ]
}

@test "alert: an ALERT beside a deleted state and a stale heartbeat still mails each judgement (the rules do not shadow one another)" {
    cd_need_flock
    hb $(( NOW - 1000 ))
    rm -f "${GREMION_ROOT}/data/cd/state.json"
    alert_at $(( NOW - 100 ))
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with alert)" -eq 1 ]
    [ "$(mails_with no_tick)" -eq 1 ]
    [ "$(mails_with state_unreadable)" -eq 1 ]
}

# ---------------------------------------------------------------------------
# The probe holds the lock for an instant only
# ---------------------------------------------------------------------------

@test "liveness: while the watchdog runs (here: inside the mail relay call of its final flush) the cd lock is free for the tick" {
    cd_need_flock
    # a stale heartbeat queues a mail, so the final flush calls curl while the watchdog is
    # still running; the shim then tries to take the cd lock from another process
    hb $(( NOW - 1000 ))
    shim curl "$(cat <<'SH'
cat > /dev/null
if ( flock -n 9 ) 9>>"$GREMION_ROOT/runtime/cd/cd.lock"; then echo free >> "$GREMION_ROOT/.lock-during"; else echo held >> "$GREMION_ROOT/.lock-during"; fi
exit 7
SH
)"
    wd
    [ "$status" -eq 0 ]
    [ -f "${GREMION_ROOT}/.lock-during" ]
    [ "$(sort -u "${GREMION_ROOT}/.lock-during")" = "free" ]
}

# ---------------------------------------------------------------------------
# The rules that read the state
# ---------------------------------------------------------------------------

state_poll() {
    # state_poll LAST_AT LAST_OK TIP12 VERDICT
    cd_seed_state '.live = '"$CD_LIVE_JSON"' | .poll.last_at = "'"$1"'" | .poll.last_ok = '"$2"' | .poll.tip12 = "'"$3"'" | .poll.verdict = "'"$4"'"'
}

@test "poll: a last success older than CD_STALL_MINUTES while ls-remote shows a newer tip gives the stalled mail" {
    cd_need_flock
    state_poll "$(date -u -d "@$(( NOW - 7 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb none
    printf '%s\n' cccccccccccccccccccccccccccccccccccccccc > "${GREMION_ROOT}/.git-tip"
    fresh_hb
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with poll_stale)" -eq 1 ]
    grep -qx 'poll_age_min: 420' "$(mail_files)"
    assert_recorded git "ls-remote"
}

@test "poll: no mail when ls-remote shows the tip the poller already has, or the live release, or cannot be read" {
    cd_need_flock
    state_poll "$(date -u -d "@$(( NOW - 7 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb none
    fresh_hb
    printf '%s\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb > "${GREMION_ROOT}/.git-tip"
    wd
    [ "$(mail_count)" -eq 0 ]
    printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "${GREMION_ROOT}/.git-tip"
    wd
    [ "$(mail_count)" -eq 0 ]
    touch "${GREMION_ROOT}/.git-fail"
    wd
    [ "$(mail_count)" -eq 0 ]
}

@test "poll: a recent success (inside CD_STALL_MINUTES) does not even ask the repository" {
    cd_need_flock
    state_poll "$(date -u -d "@$(( NOW - 5 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb none
    printf '%s\n' cccccccccccccccccccccccccccccccccccccccc > "${GREMION_ROOT}/.git-tip"
    fresh_hb
    wd
    [ "$(mail_count)" -eq 0 ]
    refute_recorded git "ls-remote"
}

@test "poll: a stale poll mails once a day, not every run" {
    cd_need_flock
    state_poll "$(date -u -d "@$(( NOW - 7 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb none
    printf '%s\n' cccccccccccccccccccccccccccccccccccccccc > "${GREMION_ROOT}/.git-tip"
    fresh_hb
    wd
    cd_advance 600
    fresh_hb
    wd
    [ "$(mails_with poll_stale)" -eq 1 ]
    cd_advance 86400
    fresh_hb
    wd
    [ "$(mails_with poll_stale)" -eq 2 ]
}

@test "poll: a poll that never ran (last_ok true, no time yet) is not aged from today's midnight, whatever the hour" {
    cd_need_flock
    # the fake clock is a few days past the REAL today: `date -d ""` reads the real clock,
    # so only then does a midnight of today look like an old poll success
    local later=$(( $(date +%s) + 5 * 86400 ))
    cd_fake_now "$later"
    state_poll "" true "" ""
    printf '%s
' cccccccccccccccccccccccccccccccccccccccc > "${GREMION_ROOT}/.git-tip"
    fresh_hb
    wd
    [ "$status" -eq 0 ]
    [ "$(mails_with poll_stale)" -eq 0 ]
    grep -qx "poll_ok_epoch=${later}" "${GREMION_ROOT}/data/cd/watchdog.state"
}

@test "poll: a failing poll (last_ok false) is aged from the last success the watchdog saw" {
    cd_need_flock
    printf 'poll_ok_epoch=%s\n' $(( NOW - 7 * 3600 )) > "${GREMION_ROOT}/data/cd/watchdog.state"
    state_poll "$(date -u -d "@$(( NOW - 30 ))" +%Y-%m-%dT%H:%M:%SZ)" false bbbbbbbbbbbb none
    printf '%s\n' cccccccccccccccccccccccccccccccccccccccc > "${GREMION_ROOT}/.git-tip"
    fresh_hb
    wd
    [ "$(mails_with poll_stale)" -eq 1 ]
}

@test "poll: a failing poll the watchdog has no earlier success for starts the clock at its first sight" {
    cd_need_flock
    state_poll "$(date -u -d "@$(( NOW - 30 ))" +%Y-%m-%dT%H:%M:%SZ)" false bbbbbbbbbbbb none
    printf '%s\n' cccccccccccccccccccccccccccccccccccccccc > "${GREMION_ROOT}/.git-tip"
    fresh_hb
    wd
    [ "$(mail_count)" -eq 0 ]
    grep -qx "poll_ok_epoch=${NOW}" "${GREMION_ROOT}/data/cd/watchdog.state"
}

@test "main red: six hours of red gives one mail per red episode" {
    cd_need_flock
    state_poll "$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb red
    fresh_hb
    wd
    [ "$(mail_count)" -eq 0 ]
    cd_advance $(( 6 * 3600 - 60 ))
    state_poll "$(date -u -d "@$(cd_clock)" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb red
    fresh_hb
    wd
    [ "$(mail_count)" -eq 0 ]
    cd_advance 120
    state_poll "$(date -u -d "@$(cd_clock)" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb red
    fresh_hb
    wd
    [ "$(mails_with main_red)" -eq 1 ]
    cd_advance 600
    state_poll "$(date -u -d "@$(cd_clock)" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb red
    fresh_hb
    wd
    [ "$(mails_with main_red)" -eq 1 ]
    # green again ends the episode; a new red counts from its own start
    cd_advance 60
    state_poll "$(date -u -d "@$(cd_clock)" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb green
    fresh_hb
    wd
    cd_advance 60
    state_poll "$(date -u -d "@$(cd_clock)" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb red
    fresh_hb
    wd
    cd_advance $(( 6 * 3600 + 60 ))
    state_poll "$(date -u -d "@$(cd_clock)" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb red
    fresh_hb
    wd
    [ "$(mails_with main_red)" -eq 2 ]
}

@test "main red: an empty poll tip (a poll that never ran) does not shift the verdict: red for six hours still mails" {
    cd_need_flock
    state_poll "" true "" red
    fresh_hb
    wd
    [ "$(mail_count)" -eq 0 ]
    cd_advance $(( 6 * 3600 + 60 ))
    fresh_hb
    wd
    [ "$(mails_with main_red)" -eq 1 ]
}

@test "kill switch: with the switch on, an old poll with a newer tip and a red verdict are not alarms (nothing polls); the weekly reminder is the one mail" {
    cd_need_flock
    touch "${GREMION_ROOT}/etc/cd.disabled"
    state_poll "$(date -u -d "@$(( NOW - 7 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb red
    printf '%s\n' cccccccccccccccccccccccccccccccccccccccc > "${GREMION_ROOT}/.git-tip"
    fresh_hb
    wd
    cd_advance $(( 7 * 3600 ))
    fresh_hb
    wd
    [ "$(mails_with poll_stale)" -eq 0 ]
    [ "$(mails_with main_red)" -eq 0 ]
    [ "$(grep -l '^kind: killswitch$' "${GREMION_ROOT}"/data/cd/outbox/*.eml | wc -l | tr -d ' ')" -eq 1 ]
    refute_recorded git "ls-remote"
}

@test "kill switch: a poll that was off on purpose is not stale the moment the switch is removed" {
    cd_need_flock
    touch "${GREMION_ROOT}/etc/cd.disabled"
    state_poll "$(date -u -d "@$(( NOW - 9 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)" true bbbbbbbbbbbb none
    printf '%s\n' cccccccccccccccccccccccccccccccccccccccc > "${GREMION_ROOT}/.git-tip"
    fresh_hb
    wd
    rm -f "${GREMION_ROOT}/etc/cd.disabled"
    cd_advance 600
    fresh_hb
    wd
    [ "$(mails_with poll_stale)" -eq 0 ]
}

@test "stalled: the commonest dead-man mail names the heartbeat's stage (tick) instead of redacting it" {
    cd_need_flock
    hb $(( NOW - 1000 )) idle tick
    wd
    grep -qx 'stage: tick' "$(mail_files)"
}

# ---------------------------------------------------------------------------
# The program and the guard
# ---------------------------------------------------------------------------

@test "program: a half-written library does not stop the real watchdog (exit 0, ALERT written, the check ran)" {
    cd_need_flock
    local src="${GREMION_ROOT}/host-copy"
    cp -r "$HOST_SRC" "$src"
    printf 'cd_cmd_zz_half() {\n  echo half\n' > "${src}/lib/cd/zz-half.sh"
    hb $(( NOW - 1000 ))
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" watchdog
    [ "$status" -eq 0 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    [ "$(mails_with no_tick)" -eq 1 ]
}

# forbidden_sources FILE -- prints each line of FILE that sources, or names a call of, the
# poller or the pipeline driver; 0 when there is none to print.
forbidden_sources() {
    grep -nE '^[[:space:]]*(\.|source)[[:space:]].*(github|driver)\.sh|(^|[^A-Za-z0-9_])(cd_gh_[a-z_]+|cd_pipeline_[a-z_]+|cd_failure_policy|cd_cmd_(tick|poll|release_now))([^A-Za-z0-9_]|$)' "$1" || true
}

@test "guard: watchdog.sh does not source github.sh or driver.sh, nor call their functions" {
    run forbidden_sources "${HOST_SRC}/lib/cd/watchdog.sh"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "guard: the guard sees a source line and a call (watched red on a copy that has them)" {
    local copy="${GREMION_ROOT}/watchdog-bad.sh"
    cp "${HOST_SRC}/lib/cd/watchdog.sh" "$copy"
    printf '. "${CD_LIB_DIR}/github.sh"\n' >> "$copy"
    run forbidden_sources "$copy"
    [[ "$output" == *github.sh* ]]
    cp "${HOST_SRC}/lib/cd/watchdog.sh" "$copy"
    printf '    cd_gh_tip\n' >> "$copy"
    run forbidden_sources "$copy"
    [[ "$output" == *cd_gh_tip* ]]
    cp "${HOST_SRC}/lib/cd/watchdog.sh" "$copy"
    printf 'source /x/driver.sh\n' >> "$copy"
    run forbidden_sources "$copy"
    [[ "$output" == *driver.sh* ]]
}
