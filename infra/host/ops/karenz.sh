#!/usr/bin/env bash
# The scheduled module-Karenz run (module switch-off with the 30-day Karenz,
# phase 2): finalize the switch-offs whose 30 days are over. Runs from
# gremion-karenz.timer (hourly, at minute 17 UTC) as the deploy user, on the
# HOST, and does one thing: `tenant-create karenz-run` in the ACTIVE colour, the
# container that already holds the kernel server's admin credential and the
# platform owner's (the same one-shot the executor drives). The finalize rule
# (drop the blocked module database, delete the switch-off's own export, record
# platform_done_at) lives in @gremion/tenant-store (finalizeDueKarenz); the
# deletion switch KARENZ_FINAL_DELETION is read by the verb inside the
# container, and the shipped value `off` makes every run a DRY RUN that records
# the mode on each due row and prints what it would delete. The verb prints ONE
# JSON line: {"verb":"karenz-run","deletion":"on|off","due":n,"finalized":n,
# "kept":n,"orphanedExports":[...],"errors":[...]}.
#
# Hourly, not daily: a row is due at its own final_at (switch-off plus 30
# days), so an hourly run deletes within an hour of the day-30 moment. Every
# step of the finalize rule is keyed on persisted state and converges after a
# crash, so a skipped or killed run is finished by the next hour's.
#
# It takes runtime/hostd.lock (waiting up to KARENZ_LOCK_WAIT seconds, default
# 20): a deploy, switch, rollback or executor request in progress must not race
# a DROP DATABASE in the colour being switched, and the other way round. A host
# operation that outlasts the wait makes this exit 3 (blocked): the unit fails
# visibly and the next hour's run takes over. The wait is short because it
# shares gremion-karenz.service's TimeoutStartSec (170 s) with the run itself,
# which stops at its own deadline (KARENZ_RUN_DEADLINE_MS in
# gremion-ui/scripts/tenant-provision-karenz.ts, 110 s): wait + one-shot start +
# deadline + the record must fit, or systemd kills the run mid-row.
#
# exit 0 the run succeeded, or it was a dry run (deletion off), whatever is due
#      1 the run failed: a row errored (the JSON line lists which), or the
#        one-shot could not start
#      2 usage: an argument, no active colour, a missing tool or env file
#      3 blocked: the host lock was not free within the wait
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=../lib/customer-ops.sh
. "$SCRIPT_DIR/../lib/customer-ops.sh"

(( $# == 0 )) || die "karenz.sh takes no argument (the 30 days and the deletion switch are the platform's, not a flag)" "$GREMION_EXIT_USAGE"

need_cmd docker flock

# customer-ops.sh holds these as globals; ROOT/RELEASE_DIR come from the install.
setup_paths
active_colour

LOCK="${ROOT}/runtime/hostd.lock"
mkdir -p "$(dirname "$LOCK")"
exec 9>>"$LOCK" || die "cannot open the host lock ${LOCK}" "$GREMION_EXIT_USAGE"
if ! flock -w "${KARENZ_LOCK_WAIT:-20}" 9; then
    die "another host operation holds ${LOCK}; no Karenz run this hour" "$GREMION_EXIT_BLOCKED"
fi

rc=0
tc karenz-run || rc=$?
exit "$rc"
