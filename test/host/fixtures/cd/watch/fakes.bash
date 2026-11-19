# fakes.sh -- file-driven stand-ins for the functions that other units own (colour.sh, and
# the compose wait of docker.sh). Sourced by cd-watch.bats AFTER the real watch.sh. $DK is the
# answers directory. Each call is logged to $DK/fake.log with the timeout it was given.
_fk_rc() { local f="$DK/$1"; if [[ -f "$f" ]]; then cat "$f"; else printf '%s' "${2:-0}"; fi; }
cd_colour_probe() {
    printf 'probe %s timeout=%s\n' "$1" "${CD_COLOUR_EXEC_TIMEOUT_S:-unset}" >> "$DK/fake.log"
    [[ -f "$DK/probe.$1" ]] || return 1
    local rc
    rc="$(_fk_rc "probe.$1.rc" 0)"
    [[ "$rc" -eq 0 ]] || return "$rc"
    cat "$DK/probe.$1"
}
cd_colour_portal_probe() {
    printf 'portal %s timeout=%s\n' "$1" "${CD_COLOUR_EXEC_TIMEOUT_S:-unset}" >> "$DK/fake.log"
    return "$(_fk_rc "portal.$1.rc" 0)"
}
cd_colour_identity() {
    printf 'identity %s %s\n' "$1" "$2" >> "$DK/fake.log"
    return "$(_fk_rc "identity.$1.rc" 0)"
}
cd_colour_workers() {
    printf 'workers %s %s\n' "$1" "$2" >> "$DK/fake.log"
    if [[ "$2" == get ]]; then
        _fk_rc "workers.$1" on
        echo
        return 0
    fi
    return 0
}
cd_wait_healthy() {
    printf 'wait %s %s %s timeout=%s\n' "$1" "$2" "$3" "${CD_DC_TIMEOUT:-unset}" >> "$DK/fake.log"
    return "$(_fk_rc state.rc 0)"
}
