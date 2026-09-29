#!/bin/sh
# prune-retained.sh — deletes day files of Vector's retention sink whose DATE IN
# THE FILE NAME is older than the retention window (R28-VECTOR-RETENTION).
#
# vector.toml writes /logs/processed/retained-%Y-%m-%d.log (one file per UTC
# day). logrotate cannot age these out: it checks `maxage` only for a log it is
# rotating (logrotate(8): "The age is only checked if the logfile is to be
# rotated"), a day file is rotated once (-> .1, empty base re-created) and
# `notifempty` stops every later rotation — so its .1 was kept forever.
#
# This script therefore judges each file by its name, never by mtime (mtime moves
# on copy/compress), and removes every form of an aged-out day in one pass: the
# base file (often the empty one the single rotation left), .log.N and .log.N.gz.
# It is POSIX sh and needs only GNU or busybox `date` (-u, -d, @epoch).
#
# Kept: every day file dated today-DAYS .. today (UTC), i.e. DAYS+1 calendar
# days. Removed: dated strictly before today-DAYS.
#
# Environment (defaults are the production values):
#   RETAINED_DIR             directory holding the sink files   (/logs/processed)
#   RETAINED_RETENTION_DAYS  retention in whole days, >= 1       (31)
#   RETAINED_TODAY           YYYY-MM-DD override for tests       (UTC today)
#
# Fail safe: an unusable clock, date or retention value deletes NOTHING and
# exits 1 with the reason on stderr; the entrypoint loop reports it.
set -u

DIR="${RETAINED_DIR:-/logs/processed}"
DAYS="${RETAINED_RETENTION_DAYS:-31}"
TODAY="${RETAINED_TODAY:-}"

die() {
    echo "prune-retained.sh: $*; nothing deleted" >&2
    exit 1
}

case "$DAYS" in
    '' | *[!0-9]* | 0*) die "RETAINED_RETENTION_DAYS must be a positive integer (got '$DAYS')" ;;
esac

if [ -z "$TODAY" ]; then
    TODAY=$(date -u +%Y-%m-%d) || die "cannot read the UTC date"
fi
case "$TODAY" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) die "RETAINED_TODAY must be YYYY-MM-DD (got '$TODAY')" ;;
esac

today_s=$(date -u -d "$TODAY" +%s 2>/dev/null) || die "cannot parse the date '$TODAY'"
# Round-trip check: rejects dates such as 2026-02-30 that some date(1)s normalise.
[ "$(date -u -d "@$today_s" +%Y-%m-%d 2>/dev/null)" = "$TODAY" ] || die "'$TODAY' is not a calendar date"
cutoff=$(date -u -d "@$((today_s - DAYS * 86400))" +%Y%m%d 2>/dev/null) || die "cannot compute the cut-off date"
case "$cutoff" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "unexpected cut-off date '$cutoff'" ;;
esac

# Nothing written yet (fresh volume): nothing to prune.
[ -d "$DIR" ] || exit 0

rc=0
for f in "$DIR"/retained-*.log "$DIR"/retained-*.log.*; do
    [ -e "$f" ] || [ -L "$f" ] || continue # unmatched glob stays literal
    name=${f##*/}
    d=${name#retained-}
    d=${d%%.log*}
    case "$d" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
        *) continue ;; # not a sink day file: never touched
    esac
    y=${d%%-*}
    md=${d#*-}
    m=${md%%-*}
    dd=${md#*-}
    if [ "$y$m$dd" -lt "$cutoff" ]; then
        if rm -f -- "$f"; then
            echo "prune-retained.sh: removed $name (dated $d, older than $DAYS days)"
        else
            echo "prune-retained.sh: could not remove $name" >&2
            rc=1
        fi
    fi
done
exit "$rc"
