#!/usr/bin/env bash
# infra/host/lib/cd/core.sh -- the foundation of gremion-cd (continuous deployment).
#
# SOURCED, NEVER EXECUTED, and like common.sh it does NOT set shell options and runs
# nothing at the top level except plain assignments: options belong to the program
# (gremion-cd sets `set -euo pipefail` on its second line), a library that flips them
# changes whatever sourced it, and a top-level `exit` would end the program that
# sourced the library. Functions may exit (cd_die); nothing else does.
#
# WHAT IS HERE: the config parser, the clock, the state file and its schema, the two
# locks, the heartbeat, the history line, the scrubber, the alert file, the request
# queue, the block list, the hold and the stage bookkeeping. Every other unit of the
# program sources this file through the dispatcher and writes its state only through
# these functions.
#
# EXIT / RETURN CODES (the whole family): 0 ok, 1 an assertion or post-condition
# failed, 2 usage or a missing precondition (also a bad config or an unknown state
# version), 3 busy or blocked, retry later. Stage functions use their own codes (see
# the stage-function convention): 0 ok, 1 attributable to the commit, 2 precondition or host
# configuration, 3 waiting, 4 infrastructure failure, retryable.
#
# The jq programs below are single-quoted on purpose: $name is jq's own variable syntax.
# shellcheck disable=SC2016
#
# THE REAL-DATA BOUNDARY. Nothing here reads or prints customer data. History lines,
# the ALERT file and every message carry names of components and stages, counts,
# durations and codes; cd_scrub_value is the last line of defence for a value that
# might carry an address, an IP, a URL with a host or a /home path.

# shellcheck disable=SC2034  # read by cmd-state.sh, which shellcheck does not follow from here
CD_PROGRAM_VERSION=1
CD_STATE_SCHEMA=1

# -- paths --------------------------------------------------------------------
# Plain assignments, re-run by the dispatcher after GREMION_ROOT is final.
cd_paths_init() {
    CD_ROOT="${GREMION_ROOT:-/opt/gremion}"
    CD_DATA="${CD_ROOT}/data/cd"
    CD_RUN="${CD_ROOT}/runtime/cd"
    CD_CFG_FILE="${CD_ROOT}/etc/cd.env"
    CD_KILLSWITCH_FILE="${CD_ROOT}/etc/cd.disabled"
    CD_STATE_FILE="${CD_DATA}/state.json"
    CD_BLOCKED_FILE="${CD_DATA}/blocked.json"
    CD_HIST_FILE="${CD_DATA}/history.jsonl"
    CD_ALERT_FILE="${CD_DATA}/ALERT"
    CD_MIRROR_DIR="${CD_DATA}/mirror.git"
    CD_HEARTBEAT_FILE="${CD_RUN}/heartbeat"
    CD_REQUEST_DIR="${CD_RUN}/requests"
}
cd_paths_init

# -- messages -----------------------------------------------------------------
# cd_mkdir DIR -- the directory (and its parents) with DIR itself mode 0700.
cd_mkdir() {
    [[ -d "$1" ]] && return 0
    mkdir -p "$1" && chmod 700 "$1"
}

cd_err() { printf 'gremion-cd: %s\n' "$*" >&2; }
cd_info() { printf '%s\n' "$*"; }

# cd_die CODE MSG -- print MSG, stop the heartbeat, exit CODE. It writes NO alert: a
# refused operator command must not block releases (ALERT does). A fatal state or
# config problem calls cd_alert itself before it dies.
cd_die() {
    local code="${1:-1}"
    shift || true
    cd_err "$*"
    cd_heartbeat_stop 2>/dev/null || true
    exit "$code"
}

# -- config -------------------------------------------------------------------
# The file is PARSED, never sourced: a line is KEY=VALUE, the value is taken literally
# (one pair of surrounding quotes is stripped, nothing is expanded), a key must be
# known, a value must pass its validator and may not be a CHANGE_ME_OPERATOR_ marker.
# A problem is a return of 2 with a message that names the key, never the value.

declare -gA CD_DEFAULTS=(
    [CD_ALLOW_NO_MAIL]=0 [CD_ALLOW_ANY_MERGE_METHOD]=0 [CD_ALIVE_HOUR]=8
    [CD_API_BUDGET_PER_HOUR]=30 [CD_MAX_BATCH]=50 [CD_WALKBACK]=10 [CD_PENDING_MAX_MIN]=90
    [CD_QUIET_WINDOWS]="01:45-03:15" [CD_LOCK_SPAN_MIN]=60 [CD_LOCK_SPAN_MAX_MIN]=180
    [CD_BACKUP_MAX_MIN]=90 [CD_PURGE_MAX_MIN]=5 [CD_MIN_FREE_GB]=15 [CD_BUILD_CACHE_KEEP_GB]=12
    [CD_BUILD_TIMEOUT_MIN]=60 [CD_BUILD_RETRIES]=2 [CD_DUMP_POLICY]=always
    [CD_MODULE_UPGRADE_TIMEOUT_S]=900 [CD_LEAF_MIGRATE_TIMEOUT_S]=600 [CD_RECONCILE]=1
    [CD_RECONCILE_TIMEOUT_S]=300 [CD_RECONCILE_MAX_MIN]=20 [CD_RECONCILE_LOCK_WAIT_S]=120
    [CD_POST_RECONCILE_S]=120 [CD_WATCH_MINUTES]=20 [CD_WATCH_INTERVAL_S]=15
    [CD_SAMPLE_TIMEOUT_S]=12 [CD_PAUSE_MAX_MIN]=15 [CD_COMMIT_MAX_MIN]=30
    [CD_POST_ROLLBACK_S]=180 [CD_FAIL_SAMPLES]=3 [CD_5XX_WINDOW_S]=300 [CD_5XX_MIN]=10
    [CD_5XX_FACTOR]=3 [CD_BASELINE_S]=3600 [CD_STALL_MINUTES]=360 [CD_LOCK_WAIT_S]=300
    [CD_VERIFY_ENFORCE]=0 [CD_PROOF_MODE]=0
)

# key -> validator kind. A key with no entry in CD_DEFAULTS has no default (empty).
declare -gA CD_KIND=(
    [CD_REPO_URL]=urlreq [CD_MAIL_TO]=mail [CD_HOST_LABEL]=label [CD_PROBE_HOST]=host
    [CD_PING_URL]=url [CD_POLICY_ACK]=free [CD_GITHUB_TOKEN_FILE]=path [CD_PROOF_REPO]=proofrepo
    [CD_ALLOW_NO_MAIL]=bool [CD_ALLOW_ANY_MERGE_METHOD]=bool [CD_ALIVE_HOUR]=hour
    [CD_API_BUDGET_PER_HOUR]=int:1 [CD_MAX_BATCH]=int:1 [CD_WALKBACK]=int:1
    [CD_PENDING_MAX_MIN]=int:1 [CD_QUIET_WINDOWS]=windows [CD_LOCK_SPAN_MIN]=int:1
    [CD_LOCK_SPAN_MAX_MIN]=int:1 [CD_BACKUP_MAX_MIN]=int:1 [CD_PURGE_MAX_MIN]=int:1
    [CD_MIN_FREE_GB]=int:0 [CD_BUILD_CACHE_KEEP_GB]=int:0 [CD_BUILD_TIMEOUT_MIN]=int:1
    [CD_BUILD_RETRIES]=int:0 [CD_DUMP_POLICY]=enum:always [CD_MODULE_UPGRADE_TIMEOUT_S]=int:1
    [CD_LEAF_MIGRATE_TIMEOUT_S]=int:60 [CD_RECONCILE]=bool [CD_RECONCILE_TIMEOUT_S]=int:1
    [CD_RECONCILE_MAX_MIN]=int:1 [CD_RECONCILE_LOCK_WAIT_S]=int:1 [CD_POST_RECONCILE_S]=int:0
    [CD_WATCH_MINUTES]=int:1 [CD_WATCH_INTERVAL_S]=int:1 [CD_SAMPLE_TIMEOUT_S]=int:1
    [CD_PAUSE_MAX_MIN]=int:1 [CD_COMMIT_MAX_MIN]=int:1 [CD_POST_ROLLBACK_S]=int:0
    [CD_FAIL_SAMPLES]=int:1 [CD_5XX_WINDOW_S]=int:1 [CD_5XX_MIN]=int:1 [CD_5XX_FACTOR]=int:1
    [CD_BASELINE_S]=int:1 [CD_STALL_MINUTES]=int:1 [CD_LOCK_WAIT_S]=int:1
    [CD_VERIFY_ENFORCE]=bool [CD_PROOF_MODE]=bool
)

# The operator-value keys: status shows them as set or unset, never their value.
# shellcheck disable=SC2034  # read by cmd-state.sh
CD_OPERATOR_KEYS=(CD_REPO_URL CD_MAIL_TO CD_HOST_LABEL CD_PROBE_HOST CD_PING_URL CD_GITHUB_TOKEN_FILE CD_PROOF_REPO)

declare -gA CD_CFG=()
CD_CFG_LOADED=0

# cd_cfg_check KIND VALUE -- 0 when VALUE is valid for KIND.
cd_cfg_check() {
    local kind="$1" v="$2" min
    local re_url='^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~%/+@:=?&-]*)?$'
    local re_mail='^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$'
    local re_host='^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'
    local re_path='^/[A-Za-z0-9._/@+-]+$'
    # an absolute local path: every segment is non-empty and starts with a letter, digit or one of _@+-,
    # so no dot segment, no hidden name, no empty segment, no trailing slash
    local re_abs='^(/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)+$'
    local w='([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]'
    local re_win="^${w}(,${w})*\$"
    case "$kind" in
        free) [[ "$v" != *[[:cntrl:]]* ]] ;;
        bool) [[ "$v" == 0 || "$v" == 1 ]] ;;
        int:*)
            min="${kind#int:}"
            [[ "$v" =~ ^[0-9]{1,9}$ ]] && (( 10#$v >= min ))
            ;;
        hour) [[ "$v" =~ ^([0-9]|1[0-9]|2[0-3])$ ]] ;;
        urlreq) [[ "$v" =~ $re_url ]] ;;
        url) [[ -z "$v" ]] || [[ "$v" =~ $re_url ]] ;;
        proofrepo) [[ -z "$v" ]] || [[ "$v" =~ $re_url ]] || [[ "$v" =~ $re_abs ]] ;;
        mail) [[ "$v" =~ $re_mail ]] ;;
        label) [[ "$v" =~ ^[a-z0-9-]{1,32}$ ]] ;;
        host) [[ -z "$v" ]] || [[ "$v" =~ $re_host ]] ;;
        path) [[ -z "$v" ]] || [[ "$v" =~ $re_path ]] ;;
        windows) [[ -z "$v" ]] || [[ "$v" =~ $re_win ]] ;;
        enum:*) [[ "$v" == "${kind#enum:}" ]] ;;
        *) return 1 ;;
    esac
}

# cd_cfg_load -- parse etc/cd.env into CD_CFG. 0 ok, 2 on any problem (nothing is
# kept on a failure).
cd_cfg_load() {
    local file="$CD_CFG_FILE" line key val n=0
    local -A seen=()
    local -A parsed=()
    if [[ ! -f "$file" || ! -r "$file" ]]; then
        cd_err "config: ${file} is missing or unreadable"
        return 2
    fi
    while IFS= read -r line || [[ -n "$line" ]]; do
        n=$((n + 1))
        if [[ "$line" == *$'\r'* ]]; then
            cd_err "config: line ${n} has a carriage return"
            return 2
        fi
        if [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]]; then
            continue
        fi
        if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
            cd_err "config: line ${n} is not KEY=VALUE"
            return 2
        fi
        key="${BASH_REMATCH[1]}"
        val="${BASH_REMATCH[2]}"
        if [[ -z "${CD_KIND[$key]:-}" ]]; then
            cd_err "config: unknown key ${key}"
            return 2
        fi
        if [[ -n "${seen[$key]:-}" ]]; then
            cd_err "config: ${key} is set twice"
            return 2
        fi
        seen[$key]=1
        if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then
            val="${BASH_REMATCH[1]}"
        fi
        if [[ "$val" == *CHANGE_ME_OPERATOR_* ]]; then
            cd_err "config: ${key} still carries a CHANGE_ME_OPERATOR_ placeholder"
            return 2
        fi
        if ! cd_cfg_check "${CD_KIND[$key]}" "$val"; then
            cd_err "config: ${key} has an invalid value"
            return 2
        fi
        parsed[$key]="$val"
    done < "$file"
    # A key that has no default and that every release needs: the repository URL always,
    # the mail address and the host label unless the operator turned mail off. Deleting a
    # line must not be a way round a placeholder check.
    if [[ -z "${parsed[CD_REPO_URL]:-}" ]]; then
        cd_err "config: CD_REPO_URL is required"
        return 2
    fi
    if [[ "${parsed[CD_ALLOW_NO_MAIL]:-0}" != 1 ]]; then
        for key in CD_MAIL_TO CD_HOST_LABEL; do
            if [[ -z "${parsed[$key]:-}" ]]; then
                cd_err "config: ${key} is required (or CD_ALLOW_NO_MAIL=1)"
                return 2
            fi
        done
    fi
    # A local path as the proof repository is a proof-mode feature only. It is checked here, after the loop,
    # because the order of the lines in the file is free.
    if [[ "${parsed[CD_PROOF_REPO]:-}" == /* && "${parsed[CD_PROOF_MODE]:-0}" != 1 ]]; then
        cd_err "config: CD_PROOF_REPO is a local path, which is accepted only with CD_PROOF_MODE=1"
        return 2
    fi
    CD_CFG=()
    for key in "${!parsed[@]}"; do
        CD_CFG[$key]="${parsed[$key]}"
    done
    CD_CFG_LOADED=1
    return 0
}

# cd_cfg KEY -- the value (the default when the file does not set it), 2 when the config
# is not loaded or the key is unknown. Nothing here guesses.
cd_cfg() {
    local key="${1:-}"
    if [[ "$CD_CFG_LOADED" != 1 ]]; then
        cd_err "config: not loaded (cd_cfg_load first)"
        return 2
    fi
    if [[ -z "${CD_KIND[$key]:-}" ]]; then
        cd_err "config: unknown key ${key}"
        return 2
    fi
    if [[ -n "${CD_CFG[$key]+set}" ]]; then
        printf '%s\n' "${CD_CFG[$key]}"
    else
        printf '%s\n' "${CD_DEFAULTS[$key]:-}"
    fi
}

# cd_cfg_is_set KEY -- 0 when the file gives KEY a non-empty value.
cd_cfg_is_set() {
    [[ "$CD_CFG_LOADED" == 1 && -n "${CD_CFG[${1:-}]:-}" ]]
}

# cd_cfg_require KEY... -- 2 (with the key named) unless every key has a non-empty value.
cd_cfg_require() {
    local key rc=0
    for key in "$@"; do
        if ! cd_cfg_is_set "$key"; then
            cd_err "config: ${key} is required"
            rc=2
        fi
    done
    return "$rc"
}

# -- clock --------------------------------------------------------------------
# Time is read through cd_now only. A fake clock (the env GREMION_CD_NOW, or the file
# GREMION_CD_NOW_FILE, whose content is an epoch) is honoured ONLY when
# GREMION_CD_TESTING=1; without it both variables are ignored.
cd_now() {
    local v=""
    if [[ "${GREMION_CD_TESTING:-}" == 1 ]]; then
        if [[ -n "${GREMION_CD_NOW_FILE:-}" && -r "${GREMION_CD_NOW_FILE}" ]]; then
            read -r v < "$GREMION_CD_NOW_FILE" || true
        elif [[ -n "${GREMION_CD_NOW:-}" ]]; then
            v="$GREMION_CD_NOW"
        fi
        if [[ -n "$v" ]]; then
            if [[ ! "$v" =~ ^[0-9]{1,12}$ ]]; then
                cd_err "the fake clock is not an epoch"
                return 2
            fi
            printf '%s\n' "$v"
            return 0
        fi
    fi
    date +%s
}

# cd_iso [EPOCH] -- UTC, 2026-11-17T01:45:00Z.
cd_iso() {
    local t="${1:-}"
    if [[ -z "$t" ]]; then
        t="$(cd_now)" || return 2
    fi
    date -u -d "@${t}" +%Y-%m-%dT%H:%M:%SZ
}

# cd_sleep SECONDS -- sleeps; under the file fake clock it advances the clock instead,
# so a test walks a 20 minute window in milliseconds.
cd_sleep() {
    local n="${1:-0}" cur
    if [[ "${GREMION_CD_TESTING:-}" == 1 && -n "${GREMION_CD_NOW_FILE:-}" && -r "${GREMION_CD_NOW_FILE}" ]]; then
        cur="$(cd_now)" || return 2
        printf '%s\n' "$((cur + ${n%.*}))" > "$GREMION_CD_NOW_FILE"
        sleep 0.01
        return 0
    fi
    sleep "$n"
}

# -- scrubbing and the alert file ---------------------------------------------
# cd_scrub_value STR -- prints STR, or <redacted> when it contains an e-mail address, an
# IPv4 or IPv6 address, a URL with a host or a path under /home. IPv6 is recognised by
# a "::" or by eight groups; a clock time such as 12:30:45 is not an address and passes.
cd_scrub_value() {
    local s="${1-}"
    local re_mail='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+'
    local re_v4='([0-9]{1,3}\.){3}[0-9]{1,3}'
    local re_v6a='[0-9A-Fa-f:]*::[0-9A-Fa-f:]*'
    local re_v6b='([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}'
    local re_url='[A-Za-z][A-Za-z0-9+.-]*://[^/[:space:]]+'
    local re_home='(^|[^A-Za-z0-9_])/home/'
    if [[ "$s" =~ $re_mail || "$s" =~ $re_v4 || "$s" =~ $re_v6a || "$s" =~ $re_v6b \
        || "$s" =~ $re_url || "$s" =~ $re_home ]]; then
        printf '%s\n' '<redacted>'
    else
        printf '%s\n' "$s"
    fi
}

# cd_atomic_write PATH MODE -- body on stdin; temp file in the same directory, then rename.
cd_atomic_write() {
    ( umask 077; atomic_write "$1" "$2" )
}

# cd_alert MSG -- a fatal exit tells the operator: data/cd/ALERT (one line, scrubbed;
# its presence blocks a release on the relay transport) and a syslog line. Best effort
# on every step; an alert that cannot be written must not hide the fatal exit.
cd_alert() {
    local msg="${1:-alert}" line
    msg="${msg//$'\n'/ }"
    msg="${msg//$'\r'/ }"
    msg="$(cd_scrub_value "${msg:0:200}")"
    line="$(cd_iso 2>/dev/null || echo unknown-time) ${msg}"
    mkdir -p "$CD_DATA" 2>/dev/null || true
    printf '%s\n' "$line" | cd_atomic_write "$CD_ALERT_FILE" 600 2>/dev/null || true
    if command -v logger >/dev/null 2>&1; then
        logger -t gremion-cd -p daemon.err -- "$msg" </dev/null 2>/dev/null || true
    fi
    return 0
}

# -- history ------------------------------------------------------------------
# cd_hist EVENT [k=v ...] -- one JSON line, append-only: names and counts only. A value
# runs through cd_scrub_value; a value with a newline is refused (one line per event).
# A canonical non-negative integer of at most nine digits is stored as a number.
cd_hist() {
    local event="${1:-}" kv key val at
    shift || true
    local -a pairs=()
    if [[ ! "$event" =~ ^[a-z][a-z0-9_]{0,63}$ ]]; then
        cd_err "hist: bad event name"
        return 2
    fi
    for kv in "$@"; do
        key="${kv%%=*}"
        val="${kv#*=}"
        if [[ "$kv" != *=* || ! "$key" =~ ^[a-z][a-z0-9_]{0,63}$ ]]; then
            cd_err "hist: bad key"
            return 2
        fi
        if [[ "$val" == *$'\n'* || "$val" == *$'\r'* ]]; then
            cd_err "hist: a value with a line break is refused"
            return 2
        fi
        val="$(cd_scrub_value "$val")"
        pairs+=("$key" "$val")
    done
    at="$(cd_iso)" || return 2
    cd_mkdir "$CD_DATA" || return 2
    jq -cn --arg at "$at" --arg event "$event" '
        {at: $at, event: $event}
        + ([ $ARGS.positional as $p | range(0; ($p | length); 2)
             | {key: $p[.], value: ($p[. + 1] | if test("^(0|[1-9][0-9]{0,8})$") then tonumber else (.) end)} ]
           | from_entries)' --args "${pairs[@]}" >> "$CD_HIST_FILE"
}

# -- state --------------------------------------------------------------------
# The jq program that checks a state document: it prints one line per violation (key
# and field NAMES only, never a value) and nothing for a valid document. The objects
# that carry counts are closed: no other key is allowed in them (a name field is a
# violation). release/live/previous require the keys every reader needs and allow the
# rest of the documented record.
cd_state_schema_jq() {
    cat <<'JQ'
def isint: type == "number" and . >= 0 and . == floor;
def isnum: type == "number" and . >= 0;
def isstr: type == "string";
def isbool: type == "boolean";
def closed($allowed; $w): ((keys - $allowed) | map($w + ": unknown key " + .));
def need($req; $w): (($req - keys) | map($w + ": missing key " + .));
def shape($w; $allowed; $req): if type != "object" then [$w + ": not an object"] else closed($allowed; $w) + need($req; $w) end;
def check($w; $ok; $msg): if $ok then [] else [$w + ": " + $msg] end;
def counts($w; $keys): if . == null then []
  elif type != "object" then [$w + ": not an object"]
  else closed($keys; $w) + need($keys; $w)
       + ([ . as $o | $keys[] | select($o[.] != null and ($o[.] | isint | not)) | $w + "." + . + ": not a count" ])
  end;
def sha40: isstr and test("^[0-9a-f]{40}$");
def sha12: isstr and test("^[0-9a-f]{12}$");
def tagok: isstr and test("^pilot-[0-9a-f]{12}$");
def colour: IN("blue", "green");

def hold_v: if . == null then []
  else shape("hold"; ["kind","reason","sha12","since","left_running"]; ["kind","reason","sha12","since"])
    + (if type == "object" then
        check("hold.kind"; (.kind | IN("operator","blocked","state_tier","unsupported_chain","contract_migration","waived_migration","ci_changed","chain_class_changed","batch_too_large","not_ancestor","ruleset_missing","range_unverified","classify_failed","failure","proof","rollback_failed","killswitch","stuck_stage","reconcile_failed")); "not an allowed kind")
        + check("hold.reason"; ((.reason | isstr) and (.reason | test("^[A-Za-z0-9_:./+-]{0,120}$"))); "not a code")
        + check("hold.sha12"; ((.sha12 | isstr) and (.sha12 | test("^([0-9a-f]{12})?$"))); "not a short sha")
        + check("hold.since"; (.since | isstr); "not a string")
        + (if has("left_running") then check("hold.left_running"; (.left_running | colour); "not a colour") else [] end)
       else [] end)
  end;

def rec_v($w): if . == null then []
  else shape($w; ["at","total","ok","failed","timeout","busy","skipped","invalid","seconds","reason"]; ["at","total","ok","failed","timeout","busy","skipped","invalid","seconds","reason"])
    + (if type == "object" then
        check($w + ".at"; (.at | isstr); "not a string")
        + ([ . as $o | ["total","ok","failed","timeout","busy","skipped","invalid"][] | select($o[.] != null and ($o[.] | isint | not)) | $w + "." + . + ": not a count" ])
        + check($w + ".seconds"; (.seconds | isnum); "not a number")
        + check($w + ".reason"; (.reason == null or ((.reason | isstr) and (.reason | test("^[A-Za-z0-9_:.-]{0,60}$")))); "not a code or null")
       else [] end)
  end;
def live_v: if . == null then []
  else shape("live"; ["sha","sha12","tag","colour","tree","since","proof","modules","leaves","reconcile"]; ["sha","sha12","tag","colour","tree","since"])
    + (if type == "object" then
        check("live.sha"; (.sha | sha40); "not a full sha")
        + check("live.sha12"; (.sha12 | sha12); "not a short sha")
        + check("live.tag"; (.tag | tagok); "not a release tag")
        + check("live.colour"; (.colour | colour); "not a colour")
        + check("live.tree"; ((.tree | isstr) and (.tree | startswith("/"))); "not an absolute path")
        + check("live.since"; (.since | isstr); "not a string")
        + (if has("proof") then check("live.proof"; (.proof | isbool); "not a boolean") else [] end)
        + (if has("modules") then (.modules | counts("live.modules"; ["total","upgraded","unchanged","skipped","failed","files_applied"])) else [] end)
        + (if has("leaves") then (.leaves | counts("live.leaves"; ["total","migrated","skipped","failed"])) else [] end)
        + (if has("reconcile") then (.reconcile | rec_v("live.reconcile")) else [] end)
       else [] end)
  end;
def prev_v: if . == null then []
  else shape("previous"; ["sha","sha12","tag","colour","tree","startable"]; ["sha","sha12","tag","colour","tree","startable"])
    + (if type == "object" then
        check("previous.sha"; (.sha | sha40); "not a full sha")
        + check("previous.sha12"; (.sha12 | sha12); "not a short sha")
        + check("previous.tag"; (.tag | tagok); "not a release tag")
        + check("previous.colour"; (.colour | colour); "not a colour")
        + check("previous.tree"; ((.tree | isstr) and (.tree | startswith("/"))); "not an absolute path")
        + check("previous.startable"; (.startable | isbool); "not a boolean")
       else [] end)
  end;
def watch_v: if . == null then []
  else shape("release.watch"; ["observed_s","samples","bad_streak","paused_s","blind","requests","baseline_5xx","baseline_not_ready","last_sample_epoch"]; [])
    + (if type == "object" then
        ([ . as $o | ["observed_s","paused_s"][] | select($o[.] != null and ($o[.] | isnum | not)) | "release.watch." + . + ": not a number" ])
        + ([ . as $o | ["samples","bad_streak","blind","requests","last_sample_epoch"][] | select($o[.] != null and ($o[.] | isint | not)) | "release.watch." + . + ": not a count" ])
        + ([ . as $o | ["baseline_5xx","baseline_not_ready"][] | select($o[.] != null and ($o[.] | isint | not)) | "release.watch." + . + ": not a count or null" ])
       else [] end)
  end;
def release_v: if . == null then []
  else shape("release";
      ["id","sha","sha12","tag","colour","tree","from_sha12","mode","with_state","stage","stage_status","attempt","class","dump_label","rollback_target","retag_prev","workers","modules","leaves","switch_started","commit_attempts","committed_at","timing","started_at","switched_at","watch","failure"];
      ["id","sha","sha12","tag","colour","tree","mode","stage","stage_status"])
    + (if type == "object" then
        check("release.id"; ((.id | isstr) and (.id | test("^[0-9a-f]{12}-[0-9]+$"))); "not a release id")
        + check("release.sha"; (.sha | sha40); "not a full sha")
        + check("release.sha12"; (.sha12 | sha12); "not a short sha")
        + check("release.tag"; (.tag | tagok); "not a release tag")
        + check("release.colour"; (.colour | colour); "not a colour")
        + check("release.tree"; ((.tree | isstr) and (.tree | startswith("/"))); "not an absolute path")
        + check("release.mode"; (.mode | IN("auto","manual","proof")); "not an allowed mode")
        + check("release.stage"; (.stage | IN("select","fetch","classify","host_apply","state_apply","retag","render","build","snapshot","migrate","start","gates","switch","watch","commit","reconcile")); "not an allowed stage")
        + check("release.stage_status"; (.stage_status | IN("started","ok","failed")); "not an allowed status")
        + (if has("from_sha12") then check("release.from_sha12"; ((.from_sha12 | isstr) and (.from_sha12 | test("^([0-9a-f]{12})?$"))); "not a short sha") else [] end)
        + (if has("with_state") then check("release.with_state"; (.with_state | isbool); "not a boolean") else [] end)
        + (if has("attempt") then check("release.attempt"; (.attempt | isint); "not a count") else [] end)
        + (if has("class") then check("release.class"; (.class == null or (.class | type) == "object"); "not an object or null") else [] end)
        + (if has("dump_label") then check("release.dump_label"; (.dump_label == null or (.dump_label | isstr)); "not a string or null") else [] end)
        + (if has("rollback_target") then check("release.rollback_target"; (.rollback_target == null or (.rollback_target | IN("ok","unusable"))); "not ok, unusable or null") else [] end)
        + (if has("retag_prev") then check("release.retag_prev"; (.retag_prev == null or (.retag_prev | isstr)); "not a string or null") else [] end)
        + (if has("workers") then check("release.workers"; (.workers | IN("off","on")); "not off or on") else [] end)
        + (if has("modules") then (.modules | counts("release.modules"; ["total","upgraded","unchanged","skipped","failed","files_applied"])) else [] end)
        + (if has("leaves") then (.leaves | counts("release.leaves"; ["total","migrated","skipped","failed"])) else [] end)
        + (if has("switch_started") then check("release.switch_started"; (.switch_started | isbool); "not a boolean") else [] end)
        + (if has("commit_attempts") then check("release.commit_attempts"; (.commit_attempts | isint); "not a count") else [] end)
        + (if has("committed_at") then check("release.committed_at"; (.committed_at == null or (.committed_at | isstr)); "not a string or null") else [] end)
        + (if has("timing") then (.timing | if . == null then [] else shape("release.timing"; ["snapshot_s","module_s"]; []) + (if type == "object" then ([ . as $o | keys[] | select($o[.] | isnum | not) | "release.timing." + . + ": not a number" ]) else [] end) end) else [] end)
        + (if has("started_at") then check("release.started_at"; (.started_at | isstr); "not a string") else [] end)
        + (if has("switched_at") then check("release.switched_at"; (.switched_at == null or (.switched_at | isstr)); "not a string or null") else [] end)
        + (if has("watch") then (.watch | watch_v) else [] end)
        + (if has("failure") then (.failure | if . == null then [] else shape("release.failure"; ["kind","stage","code","at"]; ["kind","stage","code","at"])
              + (if type == "object" then check("release.failure.kind"; (.kind | IN("commit","infra","host")); "not commit, infra or host")
                   + check("release.failure.stage"; (.stage | isstr); "not a string")
                   + check("release.failure.code"; (.code | isstr); "not a string")
                   + check("release.failure.at"; (.at | isstr); "not a string") else [] end) end) else [] end)
       else [] end)
  end;
def poll_v: shape("poll"; ["last_at","last_ok","tip12","verdict","api_calls_hour"]; ["last_at","last_ok","tip12","verdict","api_calls_hour"])
    + (if type == "object" then
        check("poll.last_at"; (.last_at | isstr); "not a string")
        + check("poll.last_ok"; (.last_ok | isbool); "not a boolean")
        + check("poll.tip12"; ((.tip12 | isstr) and (.tip12 | test("^([0-9a-f]{12})?$"))); "not a short sha")
        + check("poll.verdict"; (.verdict | IN("green","red","pending","none","unknown")); "not an allowed verdict")
        + check("poll.api_calls_hour"; (.api_calls_hour | isint); "not a count")
       else [] end);
def notified_v: if type != "object" then ["notified: not an object"]
  else [ to_entries[] | select(.value | isstr | not) | "notified: a value is not a string" ] | unique end;
def state_v: if type != "object" then ["state: not an object"]
  else closed(["v","phase","hold","live","previous","release","poll","notified"]; "state")
    + need(["v","phase","hold","live","previous","release","poll","notified"]; "state")
    + check("v"; (.v == 1); "not 1")
    + check("phase"; (.phase | IN("idle","releasing","watching","rolling_back","parked")); "not an allowed phase")
    + (.hold | hold_v) + (.live | live_v) + (.previous | prev_v) + (.release | release_v)
    + (.poll | poll_v) + (.notified | notified_v)
  end;

(if length != 1 then ["state: not exactly one JSON document"] else (.[0] | state_v) end) | .[]
JQ
}

# cd_state_check -- a document on stdin; prints the violations, 0 when there are none.
cd_state_check() {
    local out rc=0
    out="$(jq -r -s "$(cd_state_schema_jq)" 2>&1)" || rc=$?
    if (( rc == 3 )); then
        printf '%s\n' "state: the schema program does not compile (a bug in core.sh)"
        return 1
    elif (( rc != 0 )); then
        printf '%s\n' "state: not valid JSON"
        return 1
    fi
    if [[ -n "$out" ]]; then
        printf '%s\n' "$out"
        return 1
    fi
    return 0
}

# cd_state_load -- read the state into CD_STATE_DOC. A missing file, an unparseable file, an
# unknown version or a document that breaks the schema stops the program (exit 2); the
# last three also write the ALERT file, so a schema bump that this program rejects cannot
# silence the tick and the watchdog together.
#
# It sets a variable instead of printing, on purpose: it must be called DIRECTLY, never
# inside $( ), because an exit inside a command substitution ends only the substitution and
# the caller would carry on with an empty answer. cd_release_committed and the verbs call it
# directly; a caller that wraps cd_state_get in $( ) gets exit status 2 and an empty string.
cd_state_load() {
    local v
    CD_STATE_DOC=""
    if [[ ! -f "$CD_STATE_FILE" ]]; then
        cd_die 2 "no state file (gremion-cd adopt has not run)"
    fi
    CD_STATE_DOC="$(cat "$CD_STATE_FILE")" || cd_die 2 "state file unreadable"
    if ! v="$(printf '%s' "$CD_STATE_DOC" | jq -r 'if type == "object" then (.v | tostring) else "none" end' 2>/dev/null)"; then
        cd_alert "state file is not valid JSON"
        cd_die 2 "state file is not valid JSON"
    fi
    if [[ "$v" != "$CD_STATE_SCHEMA" ]]; then
        cd_alert "state file has an unknown schema version"
        cd_die 2 "state file has an unknown schema version"
    fi
    if ! printf '%s' "$CD_STATE_DOC" | cd_state_check >/dev/null; then
        cd_alert "state file breaks the schema"
        cd_die 2 "state file breaks the schema"
    fi
}

# cd_state_get JQ_EXPR -- the expression applied to the state, raw output (null prints
# as null; use `// empty` for "nothing").
cd_state_get() {
    local expr="${1:-}"
    [[ -n "$expr" ]] || { cd_err "cd_state_get: no expression"; return 2; }
    cd_state_load
    printf '%s' "$CD_STATE_DOC" | jq -r "$expr"
}

# cd_require_lock WHAT -- a writer must hold the cd lock in this shell. The check compares
# $$, which a ( ) subshell or a $( ) shares with its parent; such a subshell inherits fd 8
# and so holds the same lock for as long as the parent does. A separate program that
# merely inherited fd 8 does not pass: it has its own $$ and never ran cd_lock_take.
cd_require_lock() {
    if [[ "${CD_LOCK_PID:-}" != "$$" ]]; then
        cd_err "refusing ${1:-a write} without the cd lock"
        return 2
    fi
    return 0
}

# cd_state_init -- the first state: schema 1, idle, nothing live. Needs the cd lock;
# refuses to overwrite an existing state.
cd_state_init() {
    cd_require_lock "state init" || return 2
    if [[ -e "$CD_STATE_FILE" ]]; then
        cd_err "state already exists"
        return 2
    fi
    cd_mkdir "$CD_DATA" || return 2
    jq -n '{v: 1, phase: "idle", hold: null, live: null, previous: null, release: null,
            poll: {last_at: "", last_ok: true, tip12: "", verdict: "none", api_calls_hour: 0},
            notified: {}}' | cd_atomic_write "$CD_STATE_FILE" 600 || return 1
}

# cd_state_set JQ_FILTER [--arg k v | --argjson k v]... -- read, filter, validate against
# the schema, write atomically (mode 0600). Needs the cd lock. A filter that errors, that
# does not yield exactly one document or that breaks the schema is refused (return 1) and
# the file is not touched.
cd_state_set() {
    local filter="${1:-}" cur new problems
    shift || true
    [[ -n "$filter" ]] || { cd_err "cd_state_set: no filter"; return 2; }
    cd_require_lock "a state write" || return 2
    cd_state_load
    cur="$CD_STATE_DOC"
    if ! new="$(printf '%s' "$cur" | jq "$@" "$filter" 2>&1)"; then
        cd_err "state filter failed: $(cd_scrub_value "${new%%$'\n'*}")"
        return 1
    fi
    if ! problems="$(printf '%s' "$new" | cd_state_check)"; then
        cd_err "state change refused by the schema:"
        printf '%s\n' "$problems" | head -n 5 | sed 's/^/  /' >&2
        return 1
    fi
    printf '%s\n' "$new" | cd_atomic_write "$CD_STATE_FILE" 600 || { cd_err "state write failed"; return 1; }
}

# cd_release_committed -- 0 when release.committed_at is set. An unreadable state stops the
# program HERE, in the caller's own shell (cd_state_load is called directly): an
# `if cd_release_committed` must never fall into the "not committed" branch, which is the
# rollback side, because the state could not be read.
cd_release_committed() {
    local v
    cd_state_load
    v="$(printf '%s' "$CD_STATE_DOC" | jq -r '.release.committed_at // empty')"
    [[ -n "$v" ]]
}

# cd_hold_set KIND REASON [SHA12 [LEFT_RUNNING]] / cd_hold_clear
# LEFT_RUNNING (blue or green) is the colour that a failed rollback left running. It lives and goes
# with the hold, so `gremion-cd status` reads it from there after the release record has ended.
cd_hold_set() {
    local kind="${1:-}" reason="${2:-}" sha12="${3:-}" left="${4:-}" since
    since="$(cd_iso)" || return 2
    cd_state_set '.hold = ({kind: $k, reason: $r, sha12: $s, since: $t} + (if $l == "" then {} else {left_running: $l} end))' \
        --arg k "$kind" --arg r "$reason" --arg s "$sha12" --arg t "$since" --arg l "$left" || return $?
    cd_hist hold_set kind="$kind" reason="$reason" sha12="$sha12" || true
}
cd_hold_clear() {
    local kind
    cd_state_load
    kind="$(printf '%s' "$CD_STATE_DOC" | jq -r '.hold.kind // empty')"
    cd_state_set '.hold = null' || return $?
    cd_hist hold_cleared kind="${kind:-none}" || true
}

# cd_stage_begin NAME / cd_stage_ok NAME / cd_stage_fail NAME KIND CODE -- the stage
# bookkeeping of the release record. The schema decides which names are allowed.
cd_stage_begin() {
    local name="${1:-}"
    cd_state_set '.release.stage = $n | .release.stage_status = "started"' --arg n "$name" || return $?
    cd_hist stage_begin stage="$name" || true
}
cd_stage_ok() {
    local name="${1:-}"
    cd_state_set '.release.stage = $n | .release.stage_status = "ok"' --arg n "$name" || return $?
    cd_hist stage_ok stage="$name" || true
}
cd_stage_fail() {
    local name="${1:-}" kind="${2:-}" code="${3:-}" at
    at="$(cd_iso)" || return 2
    cd_state_set '.release.stage = $n | .release.stage_status = "failed"
                  | .release.failure = {kind: $k, stage: $n, code: $c, at: $t}' \
        --arg n "$name" --arg k "$kind" --arg c "$code" --arg t "$at" || return $?
    cd_hist stage_failed stage="$name" kind="$kind" code="$code" || true
}

# -- locks --------------------------------------------------------------------
# runtime/cd/cd.lock (one gremion-cd process, fd 8) and runtime/hostd.lock (the host's
# mutating lock, fd 9). flock locks belong to the open file description, so they die
# with the process (kill -9 included) and are inherited by every child that does not
# close the fd: a background subshell closes 8 and 9 (see cd_heartbeat_start).
#
# NOTE: `exec 8>>file` a second time in the same process closes the first descriptor and so
# frees the lock for a moment before the second flock takes it again; another process could
# win that moment. Both takers are therefore idempotent per process (CD_LOCK_PID /
# CD_HOSTLOCK_PID) and never re-open a descriptor they already hold.

# cd_lock_take -- 0 held, 3 another process holds it, 2 no flock or no lock file.
cd_lock_take() {
    command -v flock >/dev/null 2>&1 || { cd_err "flock (util-linux) is not installed"; return 2; }
    if [[ "${CD_LOCK_PID:-}" == "$$" ]]; then
        return 0
    fi
    cd_mkdir "$CD_RUN" || return 2
    if ! exec 8>>"${CD_RUN}/cd.lock"; then
        cd_err "cannot open the cd lock"
        return 2
    fi
    if ! flock -n 8; then
        exec 8>&-
        return 3
    fi
    CD_LOCK_PID=$$
    return 0
}

# cd_pid_holds_cd_lock PID -- whom a heartbeat belongs to. 0 when PID is a live process that
# has the cd lock open on fd 8 (the descriptor cd_lock_take holds the flock on), 1 when it is
# not: the process has ended, or it is some other process. 2 when that cannot be told (not a
# pid, no /proc, a process of another user whose descriptors are not readable); the caller
# then keeps its old judgement. The check reads /proc/PID/fd/8, not the flock: the flock is
# taken by the `flock` child on the inherited descriptor, so the owner the kernel records
# for it is that short-lived child and never the program. A holder has the file open from
# before the flock until it lets go, so there is no gap between "holds the lock" and
# "can be told from the previous run".
cd_pid_holds_cd_lock() {
    local pid="${1:-}" lock="${CD_RUN}/cd.lock"
    [[ "$pid" =~ ^[0-9]{1,9}$ ]] || return 2
    [[ -d /proc/self/fd && -e "$lock" ]] || return 2
    [[ -d "/proc/${pid}" ]] || return 1
    [[ -r "/proc/${pid}/fd" ]] || return 2
    [[ -e "/proc/${pid}/fd/8" && "/proc/${pid}/fd/8" -ef "$lock" ]]
}

# cd_hostlock_take [WAIT_S] -- waits up to WAIT_S seconds (default: none). 0 held, 3 busy.
# Exports GREMION_HOST_LOCK_HELD=1 while held, so a family program called by CD does not
# try to take the lock again (a family program must not take it twice).
cd_hostlock_take() {
    local wait="${1:-0}"
    command -v flock >/dev/null 2>&1 || { cd_err "flock (util-linux) is not installed"; return 2; }
    [[ "$wait" =~ ^[0-9]{1,6}$ ]] || { cd_err "cd_hostlock_take: bad wait"; return 2; }
    if [[ "${CD_HOSTLOCK_PID:-}" == "$$" ]]; then
        return 0
    fi
    mkdir -p "${CD_ROOT}/runtime" || return 2
    if ! exec 9>>"${CD_ROOT}/runtime/hostd.lock"; then
        cd_err "cannot open the host lock"
        return 2
    fi
    if (( wait > 0 )); then
        flock -w "$wait" 9 || { exec 9>&-; return 3; }
    else
        flock -n 9 || { exec 9>&-; return 3; }
    fi
    CD_HOSTLOCK_PID=$$
    export GREMION_HOST_LOCK_HELD=1
    return 0
}

# cd_hostlock_release -- the host lock only; the cd lock stays.
cd_hostlock_release() {
    # no redirection on this line: `exec` with no command makes every redirection on it
    # permanent, and a stray 2>/dev/null here would silence every later message of the
    # program. Closing a descriptor that is not open is not an error.
    exec 9>&- || true
    CD_HOSTLOCK_PID=""
    unset GREMION_HOST_LOCK_HELD
    return 0
}

# cd_locks_release -- both.
cd_locks_release() {
    cd_hostlock_release
    exec 8>&- || true
    CD_LOCK_PID=""
    return 0
}

cd_killswitch_active() {
    [[ -e "$CD_KILLSWITCH_FILE" || -L "$CD_KILLSWITCH_FILE" ]]
}

# -- heartbeat ----------------------------------------------------------------
# runtime/cd/heartbeat: "<epoch> <phase> <stage> <stage_started_epoch> <stage_budget_s>
# <pid>". A background subshell rewrites it every 30 seconds while a stage runs, so a 60
# minute build is not a stall, and it STOPS after budget x 1.25 + 120 seconds, so a hung
# stage stops looking alive (a heartbeat a loop must re-arm is not a watchdog; the judge
# is the separate watchdog unit). The subshell holds neither fd 8 nor fd 9 and exits
# when its parent is gone, so a kill -9 of the program never leaves a lock to an orphan.

cd_hb_write() {
    local stage="$1" started="$2" budget="$3" pid="$4" now phase
    now="$(cd_now)" || return 1
    phase="$(jq -r '.phase // "unknown"' "$CD_STATE_FILE" 2>/dev/null)" || phase=unknown
    [[ "$phase" =~ ^[a-z_]+$ ]] || phase=unknown
    printf '%s %s %s %s %s %s\n' "$now" "$phase" "$stage" "$started" "$budget" "$pid" \
        | cd_atomic_write "$CD_HEARTBEAT_FILE" 600
}

cd_heartbeat_start() {
    local stage="${1:-}" budget="${2:-}" parent=$$ started limit poll
    if [[ ! "$stage" =~ ^[a-z_]+$ || ! "$budget" =~ ^[0-9]{1,9}$ ]]; then
        cd_err "heartbeat: usage: cd_heartbeat_start STAGE BUDGET_S"
        return 2
    fi
    cd_heartbeat_stop
    cd_mkdir "$CD_RUN" || return 2
    started="$(cd_now)" || return 2
    limit=$(( budget + budget / 4 + 120 ))
    poll=5
    if [[ "${GREMION_CD_TESTING:-}" == 1 && -n "${GREMION_CD_HB_POLL_S:-}" ]]; then
        poll="$GREMION_CD_HB_POLL_S"
    fi
    cd_hb_write "$stage" "$started" "$budget" "$parent" || return 1
    (
        exec 8>&- 9>&-
        last="$started"
        while :; do
            sleep "$poll"
            kill -0 "$parent" 2>/dev/null || exit 0
            now="$(cd_now)" || exit 0
            (( now - started > limit )) && exit 0
            if (( now - last >= 30 )); then
                cd_hb_write "$stage" "$started" "$budget" "$parent" || true
                last="$now"
            fi
        done
    ) </dev/null >/dev/null 2>&1 3>&- &
    CD_HB_PID=$!
    return 0
}

cd_heartbeat_stop() {
    if [[ -n "${CD_HB_PID:-}" ]]; then
        kill "$CD_HB_PID" 2>/dev/null || true
        wait "$CD_HB_PID" 2>/dev/null || true
    fi
    CD_HB_PID=""
    return 0
}

# -- requests -----------------------------------------------------------------
# runtime/cd/requests/<epoch>-<seq>-<verb>.json: {"v":1,"verb","args","at","by"}, mode
# 0600. <seq> (four digits, allocated with noclobber) keeps FIFO order inside one second.
# cd_request_next prints the oldest VALID request and moves it to processed/; a file
# that is not a well-formed request (or is a symlink) is moved to rejected/ and logged,
# never executed.

cd_request_put() {
    local verb="${1:-}" args="${2:-}" epoch by body seq name path
    if [[ ! "$verb" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
        cd_err "request: bad verb"
        return 2
    fi
    printf '%s' "$args" | jq -s -e 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1 || { cd_err "request: args must be a JSON object"; return 2; }
    epoch="$(cd_now)" || return 2
    by="${SUDO_USER:-${USER:-$(id -un 2>/dev/null || echo unknown)}}"
    [[ "$by" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || by=unknown
    body="$(jq -cn --arg verb "$verb" --argjson args "$args" --arg at "$(cd_iso "$epoch")" --arg by "$by" \
        '{v: 1, verb: $verb, args: $args, at: $at, by: $by}')" || return 2
    cd_mkdir "$CD_REQUEST_DIR" || return 2
    seq=$(( 10#$(cd_request_max_seq "$epoch") + 1 ))
    while (( seq < 10000 )); do
        printf -v name '%s-%04d-%s.json' "$epoch" "$seq" "$verb"
        path="${CD_REQUEST_DIR}/${name}"
        if ( set -o noclobber; umask 077; printf '%s\n' "$body" > "$path" ) 2>/dev/null; then
            return 0
        fi
        seq=$((seq + 1))
    done
    cd_err "request: could not allocate a file"
    return 1
}

# cd_request_max_seq EPOCH -- the highest sequence among the pending files of that second.
cd_request_max_seq() {
    local f base max=0 n
    for f in "${CD_REQUEST_DIR}/${1}-"*.json; do
        [[ -e "$f" || -L "$f" ]] || continue
        base="${f##*/}"
        n="${base#"${1}"-}"
        n="${n%%-*}"
        [[ "$n" =~ ^[0-9]{4}$ ]] || continue
        (( 10#$n > max )) && max=$((10#$n))
    done
    printf '%s\n' "$max"
}

cd_request_reject() {
    local f="$1" why="$2" base="${1##*/}"
    cd_mkdir "${CD_REQUEST_DIR}/rejected" || return 0
    mv -f -- "$f" "${CD_REQUEST_DIR}/rejected/${base}" 2>/dev/null || rm -f -- "$f"
    cd_hist request_rejected reason="$why" || true
}

cd_request_next() {
    local f body base
    [[ -d "$CD_REQUEST_DIR" ]] || return 1
    while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        base="${f##*/}"
        if [[ -L "$f" ]]; then
            cd_request_reject "$f" symlink
            continue
        fi
        [[ -f "$f" ]] || continue
        if (( $(stat -c %s "$f" 2>/dev/null || echo 999999) > 65536 )); then
            cd_request_reject "$f" too_large
            continue
        fi
        body="$(cat "$f")"
        # -s and length == 1: jq 1.6 answers "true" to -e for an input with no document at
        # all, so an empty file must be refused by counting the documents, not by -e alone
        if ! printf '%s' "$body" | jq -s -e '
              length == 1 and (.[0] | type == "object" and .v == 1
              and (.verb | type == "string" and test("^[a-z][a-z0-9-]{0,31}$"))
              and (.args | type == "object") and (.at | type == "string") and (.by | type == "string"))' >/dev/null 2>&1; then
            cd_request_reject "$f" malformed
            continue
        fi
        cd_mkdir "${CD_REQUEST_DIR}/processed" || return 2
        mv -f -- "$f" "${CD_REQUEST_DIR}/processed/${base}" || return 2
        printf '%s' "$body" | jq -c .
        return 0
    done < <(find "$CD_REQUEST_DIR" -maxdepth 1 \( -type f -o -type l \) -name '*.json' 2>/dev/null | LC_ALL=C sort)
    return 1
}

# -- blocks -------------------------------------------------------------------
# data/cd/blocked.json: [{"sha","sha12","tag","at","rule","detail","cleared":null|{"at","reason"}}].
# Every write needs the cd lock. A missing file is an empty list.

cd_blocks_check_jq() {
    cat <<'JQ'
def okblock: type == "object"
  and ((keys - ["sha","sha12","tag","at","rule","detail","cleared"]) == [])
  and (.sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.sha12 | type == "string" and test("^[0-9a-f]{12}$"))
  and (.tag | type == "string" and test("^pilot-[0-9a-f]{12}$"))
  and (.at | type == "string")
  and (.rule | IN("build_failed","migrate_failed","start_failed","readiness_failed","isolation_failed","verify_failed","post_switch_verify","watch_readiness","watch_crash","watch_5xx","watch_pause_cap","manual_rollback"))
  and (.detail | type == "string")
  and (.cleared == null or (.cleared | type == "object" and ((keys - ["at","reason"]) == []) and (.at | type == "string") and (.reason | type == "string")));
length == 1 and (.[0] | type == "array" and all(.[]; okblock))
JQ
}

# cd_blocks_load -- read the list into CD_BLOCKS_DOC (a missing file is []). A file that is
# not a valid list stops the program. Like cd_state_load it must be called DIRECTLY, not
# inside $( ) or a pipeline, so that the exit is real and cd_is_blocked cannot answer "not
# blocked" for a list it could not read.
cd_blocks_load() {
    CD_BLOCKS_DOC="[]"
    [[ -e "$CD_BLOCKED_FILE" ]] || return 0
    CD_BLOCKS_DOC="$(cat "$CD_BLOCKED_FILE")" || cd_die 2 "blocked.json unreadable"
    if ! printf '%s' "$CD_BLOCKS_DOC" | jq -s -e "$(cd_blocks_check_jq)" >/dev/null 2>&1; then
        cd_alert "blocked.json is not a valid block list"
        cd_die 2 "blocked.json is not a valid block list"
    fi
}

# cd_blocks_apply JQ_FILTER [jq args] -- read, filter, validate, write (cd lock needed).
cd_blocks_apply() {
    local filter="$1" cur new
    shift
    cd_require_lock "a block write" || return 2
    cd_blocks_load
    cur="$CD_BLOCKS_DOC"
    if ! new="$(printf '%s' "$cur" | jq "$@" "$filter" 2>&1)"; then
        cd_err "block filter failed"
        return 1
    fi
    if ! printf '%s' "$new" | jq -s -e "$(cd_blocks_check_jq)" >/dev/null 2>&1; then
        cd_err "block change refused by the schema"
        return 1
    fi
    cd_mkdir "$CD_DATA" || return 2
    printf '%s\n' "$new" | cd_atomic_write "$CD_BLOCKED_FILE" 600 || { cd_err "block write failed"; return 1; }
}

# cd_block_add SHA RULE DETAIL -- the same commit is blocked once while its block is open.
cd_block_add() {
    local sha="${1:-}" rule="${2:-}" detail="${3:-}" at
    if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
        cd_err "block: not a full sha"
        return 2
    fi
    detail="$(cd_scrub_value "${detail//$'\n'/ }")"
    detail="${detail:0:120}"
    at="$(cd_iso)" || return 2
    cd_blocks_apply '
        if any(.[]; .sha == $sha and .cleared == null) then (.)
        else (. + [{sha: $sha, sha12: $sha[0:12], tag: ("pilot-" + $sha[0:12]), at: $at, rule: $rule, detail: $detail, cleared: null}]) end' \
        --arg sha "$sha" --arg at "$at" --arg rule "$rule" --arg detail "$detail" || return $?
    cd_hist block_added rule="$rule" sha12="${sha:0:12}" || true
}

# cd_block_open_list -- one line per open block: "<sha> <rule>".
cd_block_open_list() {
    cd_blocks_load
    printf '%s' "$CD_BLOCKS_DOC" | jq -r '.[] | select(.cleared == null) | .sha + " " + .rule'
}

# cd_is_blocked SHA -- 0 when SHA (40 or 12 hex, either case) is the commit of an open
# block. Input it cannot parse (empty, other lengths, non-hex) answers 0 "blocked" with a
# reason on stderr: unknown is never green, and inside `if` or `&&` a return code of 2
# would read the same as 1 ("free").
cd_is_blocked() {
    local sha="${1:-}"
    sha="${sha,,}"
    if [[ ! "$sha" =~ ^[0-9a-f]{12}([0-9a-f]{28})?$ ]]; then
        cd_err "is_blocked: not a 12 or 40 hex sha, treated as blocked"
        return 0
    fi
    cd_blocks_load
    printf '%s' "$CD_BLOCKS_DOC" | jq -e --arg s "$sha" 'any(.[]; .cleared == null and (.sha == $s or .sha12 == $s))' >/dev/null
}

# cd_contains_open_block SHA -- 0 when the candidate is, or descends from, a commit with
# an open block (so a plain resume cannot let a descendant carry the defect to the
# customer). The candidate is 40 or 12 hex, either case; a 12-hex one is resolved to the
# full commit through the mirror. The ancestry is read from the mirror. Anything that
# cannot be proven counts as "contains": unparseable input, a short sha the mirror cannot
# resolve to one commit, no mirror, a block commit the mirror does not know. Unknown is
# never green, and the answer is only ever 0 or 1 because inside `if` or `&&` a return
# code of 2 would read the same as 1.
cd_contains_open_block() {
    local cand="${1:-}" b rc full
    local -a open=()
    cand="${cand,,}"
    if [[ ! "$cand" =~ ^[0-9a-f]{12}([0-9a-f]{28})?$ ]]; then
        cd_err "contains_open_block: not a 12 or 40 hex sha, treated as contained"
        return 0
    fi
    cd_blocks_load
    mapfile -t open < <(printf '%s' "$CD_BLOCKS_DOC" | jq -r '.[] | select(.cleared == null) | .sha')
    for b in "${open[@]}"; do
        [[ "$b" == "$cand" || "${b:0:12}" == "$cand" ]] && return 0
    done
    if [[ "${#cand}" == 12 ]]; then
        full="$(git --git-dir="$CD_MIRROR_DIR" rev-parse --verify --quiet "${cand}^{commit}" </dev/null 2>/dev/null)" || full=""
        if [[ ! "$full" =~ ^[0-9a-f]{40}$ || "${full:0:12}" != "$cand" ]]; then
            cd_err "contains_open_block: the mirror cannot resolve that short sha, treated as contained"
            return 0
        fi
        cand="$full"
    fi
    for b in "${open[@]}"; do
        [[ -n "$b" ]] || continue
        [[ "$b" == "$cand" ]] && return 0
        if git --git-dir="$CD_MIRROR_DIR" merge-base --is-ancestor "$b" "$cand" </dev/null 2>/dev/null; then
            return 0
        else
            rc=$?
        fi
        [[ "$rc" == 1 ]] || return 0
    done
    return 1
}

# cd_block_close_superseded SHA12 -- the release SHA12 committed: close every open block
# whose commit it contains (equal or ancestor), as "superseded by <sha12>".
cd_block_close_superseded() {
    local sha12="${1:-}" full b at rc
    local -a open=() closing=()
    [[ "$sha12" =~ ^[0-9a-f]{12}$ ]] || { cd_err "close_superseded: not a short sha"; return 2; }
    full="$(git --git-dir="$CD_MIRROR_DIR" rev-parse --verify --quiet "${sha12}^{commit}" </dev/null 2>/dev/null)" || {
        cd_err "close_superseded: the mirror does not know that commit"
        return 2
    }
    cd_blocks_load
    mapfile -t open < <(printf '%s' "$CD_BLOCKS_DOC" | jq -r '.[] | select(.cleared == null) | .sha')
    for b in "${open[@]}"; do
        [[ -n "$b" ]] || continue
        if [[ "$b" == "$full" ]]; then
            closing+=("$b")
            continue
        fi
        if git --git-dir="$CD_MIRROR_DIR" merge-base --is-ancestor "$b" "$full" </dev/null 2>/dev/null; then
            closing+=("$b")
        else
            rc=$?
            [[ "$rc" == 1 ]] || { cd_err "close_superseded: ancestry unreadable"; return 2; }
        fi
    done
    (( ${#closing[@]} > 0 )) || return 0
    at="$(cd_iso)" || return 2
    cd_blocks_apply '
        ($shas | split(",")) as $s
        | map(if .cleared == null and (.sha | IN($s[])) then .cleared = {at: $at, reason: ("superseded by " + $by)} else (.) end)' \
        --arg shas "$(IFS=,; echo "${closing[*]}")" --arg at "$at" --arg by "$sha12" || return $?
    cd_hist blocks_superseded by="$sha12" count="${#closing[@]}" || true
}

# cd_block_clear_all REASON -- close every open block; the reason is logged.
cd_block_clear_all() {
    local reason="${1:-}" at n
    if [[ -z "$reason" || "$reason" == *$'\n'* ]]; then
        cd_err "block clear: a one-line reason is required"
        return 2
    fi
    at="$(cd_iso)" || return 2
    cd_blocks_load
    n="$(printf '%s' "$CD_BLOCKS_DOC" | jq -r '[.[] | select(.cleared == null)] | length')"
    cd_blocks_apply 'map(if .cleared == null then .cleared = {at: $at, reason: $reason} else (.) end)' \
        --arg at "$at" --arg reason "$reason" || return $?
    cd_hist blocks_cleared count="$n" reason="$reason" || true
}
