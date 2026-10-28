#!/usr/bin/env bash
# The scheduled purge run (TRD-144 / TRD-145, TASK-033-a): remove the data that
# is past its retention window and record the outcome. Runs from
# gremion-purge.timer (daily, 02:30 UTC) as the deploy user, on the HOST, and
# does one thing: `tenant-create purge-run` in the ACTIVE colour, the container
# that already holds the kernel server's admin credential and the platform
# owner's (the same one-shot the executor drives). The rules (which category,
# which table, which window) are @gremion/tenant-store's PURGE_RULES, derived
# from docs/compliance/retention-catalogue.md; the run writes one plt.job_run
# row (job_kind purge_run, platform migration 0012) with the counts per
# category and the errors, and prints one JSON line.
#
# It takes runtime/hostd.lock (waiting up to PURGE_LOCK_WAIT seconds, default
# 20): a deploy, switch or rollback in progress must not race a purge that
# is about to run in the colour being switched. A host operation that outlasts
# the wait makes this exit 3 (blocked): the unit fails visibly, and the next
# day's run purges everything this one would have (every rule is "older than
# now - window", so skipping a day only delays deletion by a day).
# The wait is short because it shares gremion-purge.service's TimeoutStartSec
# (170 s) with the run itself, which stops at its own deadline (PURGE_DEADLINE_MS
# in purge.ts, 110 s) and records a partial run: wait + one-shot start + deadline
# + the record must fit, or systemd kills the run before it writes plt.job_run.
#
# exit 0 the run succeeded (or another run held its own lock and recorded a skip)
#      1 the run failed: a customer database or rule errored (the plt.job_run
#        row says which), or it could not start or record
#      2 usage: an argument, no active colour, a missing tool or env file
#      3 blocked: the host lock was not free within the wait
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=../lib/customer-ops.sh
. "$SCRIPT_DIR/../lib/customer-ops.sh"

(( $# == 0 )) || die "purge.sh takes no argument (the windows are the catalogue's, not a flag)" "$GREMION_EXIT_USAGE"

need_cmd docker flock

# customer-ops.sh holds these as globals; ROOT/RELEASE_DIR come from the install.
setup_paths
active_colour

LOCK="${ROOT}/runtime/hostd.lock"
mkdir -p "$(dirname "$LOCK")"
exec 9>>"$LOCK" || die "cannot open the host lock ${LOCK}" "$GREMION_EXIT_USAGE"
if ! flock -w "${PURGE_LOCK_WAIT:-20}" 9; then
    die "another host operation holds ${LOCK}; no purge this run" "$GREMION_EXIT_BLOCKED"
fi

rc=0
tc purge-run || rc=$?
exit "$rc"
