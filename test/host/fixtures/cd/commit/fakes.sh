#!/usr/bin/env bash
# test/host/fixtures/cd/commit/fakes.sh -- scripted stand-ins for the functions that other units
# of the continuous deployment program own, sourced by cd-commit.bats AFTER commit.sh and BEFORE
# the helper's stub file (the stub file defines a stub only when no function of that name exists).
#
# Every fake appends one line to $SHIM_LOG: "fake <name> <args> | lock=<held|free> cur=<tree>".
# lock= is whether ANOTHER open file description could take the host lock at that moment, so a
# test that reads the log sees at every call whether the lock was free, and cur= is the sha12 of
# the tree `current` names, so the order of the commit steps can be read from it.
#
# The scripts live in files under $FK (a directory of the fake root):
#   <name>.fails      a number: the next that many calls of <name> fail (return 1)
#   <name>.rc         the return code of <name> once the failures are used up
#   verdicts          one line per sample for cd_watch_eval, "word[;flip c on|off]...", the last
#                     line sticks, `ok` when the file is empty
#   sample.rc         the return code of cd_watch_sample
#   sample.advance    seconds the fake clock moves during one sample
#   killat            the sample number at which the fake sample creates the kill switch file
#   eval.rc           the return code of cd_watch_eval
#   rollback.rc       the return code of cd_rollback_run (0 and 1 end the release in the state)

_fk_lockstate() {
    if ( exec 7>>"${GREMION_ROOT}/runtime/hostd.lock" && flock -n 7 ) 2>/dev/null </dev/null; then
        printf 'free'
    else
        printf 'held'
    fi
}

_fk_cur() {
    local t
    t="$(readlink "${GREMION_ROOT}/current" 2>/dev/null)" || t=none
    printf '%s' "${t##*/}"
}

# _fk NAME ARGS... -- log, then the scripted answer.
_fk() {
    local name="$1" n rc=0
    shift
    printf 'fake %s %s | lock=%s cur=%s\n' "$name" "$*" "$(_fk_lockstate)" "$(_fk_cur)" >> "$SHIM_LOG"
    if [[ -f "$FK/$name.fails" ]]; then
        n="$(cat "$FK/$name.fails")"
        if ((n > 0)); then
            echo $((n - 1)) > "$FK/$name.fails"
            return 1
        fi
    fi
    if [[ -f "$FK/$name.rc" ]]; then rc="$(cat "$FK/$name.rc")"; fi
    return "$rc"
}

cd_colour_isolation_record() { _fk cd_colour_isolation_record "$@"; }
cd_colour_down() { _fk cd_colour_down "$@"; }
cd_colour_workers() { _fk cd_colour_workers "$@"; }
cd_data_dumpset_retire() { _fk cd_data_dumpset_retire "$@"; }
executor_unit_action() { _fk executor_unit_action "$@"; }

cd_watch_sample() {
    local n=0 rc=0
    printf 'fake cd_watch_sample | lock=%s\n' "$(_fk_lockstate)" >> "$SHIM_LOG"
    if [[ -f "$FK/sample.rc" ]]; then
        rc="$(cat "$FK/sample.rc")"
        return "$rc"
    fi
    n="$(cat "$FK/sample.n" 2>/dev/null || echo 0)"
    n=$((n + 1))
    echo "$n" > "$FK/sample.n"
    if [[ -f "$FK/killat" && "$(cat "$FK/killat")" == "$n" ]]; then
        : > "$CD_KILLSWITCH_FILE"
    fi
    if [[ -f "$FK/sample.advance" ]]; then cd_sleep "$(cat "$FK/sample.advance")"; fi
    printf '{"fake":1}\n'
}

# cd_watch_eval -- the next scripted verdict, and the counters the real evaluation keeps: an
# ok or bad sample adds the interval to the observed time, a paused one to the paused time.
cd_watch_eval() {
    local n step line word rc=0
    printf 'fake cd_watch_eval | lock=%s\n' "$(_fk_lockstate)" >> "$SHIM_LOG"
    if [[ -f "$FK/eval.rc" ]]; then
        rc="$(cat "$FK/eval.rc")"
        return "$rc"
    fi
    n="$(cat "$FK/eval.n" 2>/dev/null || echo 0)"
    n=$((n + 1))
    echo "$n" > "$FK/eval.n"
    line="$(sed -n "${n}p" "$FK/verdicts" 2>/dev/null || true)"
    if [[ -z "$line" ]]; then line="$(tail -n 1 "$FK/verdicts" 2>/dev/null || true)"; fi
    if [[ -z "$line" ]]; then line=ok; fi
    word="${line%%;*}"
    step="$(cd_cfg CD_WATCH_INTERVAL_S)"
    case "$word" in
        ok | bad)
            cd_state_set '.release.watch.observed_s = ((.release.watch.observed_s // 0) + $d) | .release.watch.samples = ((.release.watch.samples // 0) + 1)' \
                --argjson d "$step" || return 2
            ;;
        paused)
            cd_state_set '.release.watch.paused_s = ((.release.watch.paused_s // 0) + $d)' --argjson d "$step" || return 2
            ;;
    esac
    printf '%s\n' "${line//;/$'\n'}"
}

# cd_rollback_run RULE -- the rule is recorded; code 0 and 1 end the release in the state, as the
# real sequence does (phase idle, no release), so a caller that reads the release afterwards fails.
cd_rollback_run() {
    local rc=0
    _fk cd_rollback_run "$@" || rc=$?
    echo "$1" >> "$FK/rollback.rules"
    if ((rc == 0 || rc == 1)); then
        cd_state_set '.phase = "idle" | .release = null' || true
    fi
    return "$rc"
}

# cd_sleep -- logs the state of the host lock at every wait (the fake clock still moves), so a test
# can read that the lock was never free while a retry sequence waited.
eval "_fk_orig_$(declare -f cd_sleep)"
cd_sleep() {
    printf 'fake cd_sleep %s | lock=%s\n' "$1" "$(_fk_lockstate)" >> "$SHIM_LOG"
    _fk_orig_cd_sleep "$@"
}
