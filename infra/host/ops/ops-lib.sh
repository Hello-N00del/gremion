# shellcheck shell=bash
# The helpers the host-side ops scripts share (R31 O14, TASK-039-FU Qf5): one
# copy of the readers metrics-textfile.sh and footprint.sh both need, so `esc`
# and `to_bytes` cannot drift between the two. Sourced, never executed, by
#
#   infra/host/ops/metrics-textfile.sh   (every minute)
#   infra/host/ops/footprint.sh          (weekly, TRD-223)
#
# Each script locates this file from its own directory (SCRIPT_DIR), so it
# works from <root>/current/infra/host/ops on the host and from the proof's
# collector container (/src/infra/host/ops) alike.
#
# The caller sets, before calling:
#   OPS_ENV      path of etc/env/ops.env            (ops_key)
#   STACK_NAME   the compose stack name, e.g. gremion (state_container)
#
# Behaviours kept exactly as they were in metrics-textfile.sh, because the
# `ops.bats` collector cases are the regression net:
#   ops_key        strips ONE pair of surrounding quotes and a trailing CR
#   to_bytes       prints NOTHING for a value or unit it cannot read (absent,
#                  never 0)
#   state_container first matching container only (the first line; since
#                  round 2 a failing docker ps is "none", never fatal)

# ops_key <KEY> -- the environment's value, else ops.env's, else empty.
ops_key() {
    local key="$1" v
    if [[ -n "${!key+x}" ]]; then printf '%s' "${!key}"; return 0; fi
    [[ -f "$OPS_ENV" ]] || return 0
    v="$(sed -n "s/^${key}=//p" "$OPS_ENV" | tail -n 1)"
    v="${v%$'\r'}"
    if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
    printf '%s' "$v"
}

# A label value, escaped for the text exposition format.
esc() { local v="${1//\\/\\\\}"; v="${v//\"/\\\"}"; printf '%s' "${v//$'\n'/ }"; }

# "12.5MiB", "1.2kB", "0B" -> bytes (binary units for docker stats, decimal
# units for docker ps --size and docker system df). Prints nothing for a
# value it cannot read.
to_bytes() {
    awk -v s="$1" 'BEGIN {
        if (match(s, /^[0-9]+(\.[0-9]+)?/) == 0) exit
        n = substr(s, 1, RLENGTH) + 0; u = substr(s, RLENGTH + 1)
        f["B"]=1; f["kB"]=1e3; f["KB"]=1e3; f["MB"]=1e6; f["GB"]=1e9; f["TB"]=1e12
        f["KiB"]=1024; f["MiB"]=1048576; f["GiB"]=1073741824; f["TiB"]=1099511627776
        if (!(u in f)) exit
        printf "%.0f\n", n * f[u]
    }'
}

# state_container <compose service> -- the first running container of it in
# ${STACK}-state, or nothing. Never fatal under the callers' set -euo pipefail:
# a docker ps that fails (daemon not answering) prints its own error and is
# "no container", which every caller already treats as absent with a note.
# The output is captured whole and its first line taken, so no `head` can
# SIGPIPE docker ps when several containers match (pipefail would turn that
# into 141).
state_container() {
    local ids
    ids="$(docker ps --filter "label=com.docker.compose.project=${STACK_NAME}-state" \
              --filter "label=com.docker.compose.service=$1" \
              --format '{{.ID}}')" || {
        echo "[ops-lib] docker ps failed looking up the ${STACK_NAME}-state $1 container -- treated as none" >&2
        return 0
    }
    [[ -z "$ids" ]] || printf '%s\n' "${ids%%$'\n'*}"
}
