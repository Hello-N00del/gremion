#!/usr/bin/env bash
# scripts/cd-proof/spike.sh -- the bounded 5xx spike of the CD proof run (scenario 2b).
#
# Sends a short, fixed burst of requests to the one public page that the proof-5xx patch
# makes answer 500 while its flag file exists, through the customer host named on the
# command line, and prints COUNTS only (never the host, a path or a body).
#
# Usage:   spike.sh <customer host>
#          spike.sh --limits        print the limits in force and exit (touches nothing)
#   <customer host>  a bare host name (no scheme, port or path). There is no default: the
#                    script never guesses which customer to load.
#
# Limits, none of them raisable from the command line or the environment (the one
# environment value, CD_PROOF_SPIKE_SECONDS, can only LOWER the 30 seconds):
#   - at most 40 requests, sent one after the other by ONE process (one burner), spaced
#     half a second apart (about 20 seconds for the 40);
#   - at most 30 seconds in all: the burst stops before a request could end after the
#     deadline (each request has a 3 second timeout), whatever was sent;
#   - a second run within 10 minutes of the last one is refused (exit 3). The time of the
#     last run is a number in a state file on the machine you run this on (default
#     ${XDG_STATE_HOME:-$HOME/.local/state}/gremion-cd-proof, CD_PROOF_STATE_DIR overrides the
#     folder); it is written BEFORE the first request, so a
#     run that dies half way still counts. A stamp that is not a number, or lies in the
#     future, refuses too. Two runs started at the very same moment are not told apart:
#     this is a hand-run proof tool, one operator at a time.
#
# Output (one line): spike: sent=<n> ok=<n> 5xx=<n> other=<n> seconds=<n>
# Exit codes: 0 the burst ran and at least one request got an answer; 1 no request got any
# answer; 2 usage or a refused precondition; 3 refused because of the 10 minute rule.

set -euo pipefail

SPIKE_PATH='/legal/cd-proof'
SPIKE_MAX_REQUESTS=40
SPIKE_MAX_SECONDS=30
SPIKE_MIN_GAP_S=600
SPIKE_INTERVAL='0.5'
SPIKE_CURL_MAX_S=3

die() { printf 'spike: %s\n' "$2" >&2; exit "$1"; }

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2; }

# The time limit in force: 30 seconds, or less when CD_PROOF_SPIKE_SECONDS asks for less.
limit_seconds="$SPIKE_MAX_SECONDS"
if [[ -n "${CD_PROOF_SPIKE_SECONDS:-}" ]]; then
    [[ "$CD_PROOF_SPIKE_SECONDS" =~ ^[0-9]{1,4}$ ]] || die 2 "CD_PROOF_SPIKE_SECONDS is not a number"
    ((CD_PROOF_SPIKE_SECONDS >= limit_seconds)) || limit_seconds="$CD_PROOF_SPIKE_SECONDS"
fi

case "${1:-}" in
    -h | --help) usage; exit 0 ;;
    --limits)
        printf 'requests=%d seconds=%d gap=%d\n' "$SPIKE_MAX_REQUESTS" "$limit_seconds" "$SPIKE_MIN_GAP_S"
        exit 0
        ;;
esac
(($# == 1)) || { usage; die 2 "exactly one argument: the customer host"; }
host="$1"
re_host='^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'
[[ "$host" =~ $re_host && "$host" != *..* ]] || die 2 "the argument is not a bare host name"

state_dir="${CD_PROOF_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/gremion-cd-proof}"
stamp="${state_dir}/spike.last"
now="$(printf '%(%s)T' -1)"

if [[ -e "$stamp" ]]; then
    last=''
    IFS= read -r last <"$stamp" || true
    [[ "$last" =~ ^[0-9]{1,12}$ ]] || die 2 "the state file ${stamp} does not hold a time; remove it by hand if no run is under way"
    age=$((now - last))
    if ((age < SPIKE_MIN_GAP_S)); then
        die 3 "refused: the last run was less than 10 minutes ago (or its time lies in the future); wait"
    fi
fi
mkdir -p "$state_dir" || die 2 "cannot create the state folder"
chmod 700 "$state_dir" 2>/dev/null || true
if ! { printf '%s\n' "$now" >"${stamp}.new" && mv -f "${stamp}.new" "$stamp"; }; then
    die 2 "cannot write the state file; nothing was sent"
fi

sent=0
ok=0
fivexx=0
other=0
answered=0
SECONDS=0
# A request is started only while it, its timeout and the pause after it still end inside
# the 30 seconds (SECONDS counts whole seconds, hence the two spare ones).
while ((sent < SPIKE_MAX_REQUESTS && SECONDS + SPIKE_CURL_MAX_S + 2 <= limit_seconds)); do
    code="$(curl -s -o /dev/null -m "$SPIKE_CURL_MAX_S" -w '%{http_code}' "https://${host}${SPIKE_PATH}" 2>/dev/null </dev/null)" || code=000
    sent=$((sent + 1))
    case "$code" in
        2??) ok=$((ok + 1)); answered=$((answered + 1)) ;;
        5??) fivexx=$((fivexx + 1)); answered=$((answered + 1)) ;;
        000) other=$((other + 1)) ;;
        *) other=$((other + 1)); answered=$((answered + 1)) ;;
    esac
    ((sent < SPIKE_MAX_REQUESTS)) && sleep "$SPIKE_INTERVAL"
done

printf 'spike: sent=%d ok=%d 5xx=%d other=%d seconds=%d\n' "$sent" "$ok" "$fivexx" "$other" "$SECONDS"
((answered > 0)) || exit 1
exit 0
