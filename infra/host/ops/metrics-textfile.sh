#!/usr/bin/env bash
# The host collector (TASK-039 Q3, Q8, Q9, Q16): every signal the ops project
# may NOT read for itself, measured on the HOST and written as one Prometheus
# textfile that Alloy reads read-only. Runs from gremion-metrics.timer every
# minute, as the deploy user -- never in a container, so no ops container needs
# the Docker API, the root filesystem or a route to a council network.
#
#   backup        gremion_backup_{last_ok,last_ts_seconds,timer_enabled}  (Q8)
#   containers    gremion_container_{unhealthy,up,memory_bytes,disk_bytes}
#   postgres      gremion_postgres_connections_{used,max}
#   broker        gremion_nats_jsz_up, gremion_nats_stream_*, gremion_nats_consumer_*
#                 (`jsz` read inside the broker container: its monitor listens
#                 on the container loopback only, TASK-024)
#   filesystems   gremion_host_filesystem_{size,avail}_bytes{mountpoint}
#   TRD-224       gremion_host_disk_provisioned_bytes{path},
#                 gremion_storage_component_bytes{component}
#
# Every metric here is ABSENT rather than zero when it cannot be measured. The
# matching conditions carry an absent() arm (compose/observability/prometheus/
# rules.yml), so a collector that has gone blind fires instead of reporting a
# comfortable 0.
#
# Knobs (the environment wins over ops.env): STACK, GREMION_DISK_ROOT (the
# filesystem whose size is the TRD-224 denominator; default Docker's data
# root), GREMION_STORAGE_COMPONENTS (space-separated <component>=<path>,
# measured with du; default every Postgres volume and the Vector volume of the
# state project, measured by the daemon), GREMION_STORAGE_INTERVAL (seconds
# between two component measurements, default 900; the last reading is reused
# in between, because a volume walk every minute is IO the host does not owe).
#
# exit 0 wrote the file · 2 missing runtime directory or tool
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

need_cmd docker jq date mktemp awk df

ROOT="$(gremion_root)"
RUNTIME="$ROOT/runtime"
OUT_DIR="$RUNTIME/textfile"
OPS_ENV="$ROOT/etc/env/ops.env"

[[ -d "$RUNTIME" ]] || die "runtime directory absent: $RUNTIME" 2
mkdir -p "$OUT_DIR"

# Diagnostics go to stderr: stdout is the metrics stream.
note() { echo "[metrics] $*" >&2; }

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

STACK_NAME="$(ops_key STACK)"; STACK_NAME="${STACK_NAME:-gremion}"
DISK_ROOT="$(ops_key GREMION_DISK_ROOT)"
COMPONENTS="$(ops_key GREMION_STORAGE_COMPONENTS)"
STORAGE_INTERVAL="$(ops_key GREMION_STORAGE_INTERVAL)"; STORAGE_INTERVAL="${STORAGE_INTERVAL:-900}"
[[ "$STORAGE_INTERVAL" =~ ^[0-9]+$ ]] || STORAGE_INTERVAL=900
STORAGE_CACHE="$RUNTIME/ops/storage-components.prom"

to_epoch() {
    local ts="$1"
    if [[ "$ts" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$ts"
    else
        date -u -d "$ts" +%s
    fi
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

emit_backup() {
    # Q8: the outcome comes from runtime/last-backup.json (gremion-backup, the
    # control panel's backup button and gremion-snapshot write it); whether
    # the job is ON comes from systemd. A disabled timer with a good last run
    # is healthy [D R15-1]; no file at all is an absent signal, never "ok".
    local file="$RUNTIME/last-backup.json" ok_flag ts epoch state
    if command -v systemctl >/dev/null 2>&1; then
        state="$(systemctl is-enabled gremion-backup.timer 2>/dev/null || true)"
        state="${state%%$'\n'*}"
        if [[ -n "$state" ]]; then
            printf '# HELP gremion_backup_timer_enabled 1 when gremion-backup.timer is enabled.\n'
            printf '# TYPE gremion_backup_timer_enabled gauge\n'
            printf 'gremion_backup_timer_enabled %s\n' "$([[ "$state" == enabled ]] && echo 1 || echo 0)"
        else
            note "systemctl answered nothing for gremion-backup.timer -- timer state absent"
        fi
    else
        note "no systemctl -- timer state absent"
    fi
    [[ -f "$file" ]] || { note "no last-backup.json yet -- the backup record is absent (SignalAbsent)"; return 0; }
    ok_flag="$(jq -r 'if .ok == true then 1 elif .ok == false then 0 else "" end' "$file" 2>/dev/null || true)"
    ts="$(jq -r '.ts // empty' "$file" 2>/dev/null || true)"
    if [[ -z "$ok_flag" || -z "$ts" ]]; then
        note "last-backup.json carries no boolean ok or no ts -- the backup record is absent"
        return 0
    fi
    epoch="$(to_epoch "$ts" 2>/dev/null)" || { note "unparseable ts '$ts' -- the backup record is absent"; return 0; }
    printf '# HELP gremion_backup_last_ok 1 when the last gremion-backup run succeeded, 0 when it failed.\n'
    printf '# TYPE gremion_backup_last_ok gauge\n'
    printf 'gremion_backup_last_ok %s\n' "$ok_flag"
    printf '# HELP gremion_backup_last_ts_seconds Unix time of the last gremion-backup run, failed or not.\n'
    printf '# TYPE gremion_backup_last_ts_seconds gauge\n'
    printf 'gremion_backup_last_ts_seconds %s\n' "$epoch"
}

emit_containers() {
    local name status service project rows unhealthy="" up="" mem="" disk="" size bytes
    rows="$(docker ps --all --filter "label=com.docker.compose.project" \
        --format '{{.Names}}	{{.Status}}	{{.Label "com.docker.compose.service"}}	{{.Label "com.docker.compose.project"}}')" \
        || { note "docker ps failed -- container signals absent"; return 0; }
    while IFS=$'\t' read -r name status service project; do
        [[ -n "$name" ]] || continue
        unhealthy+="gremion_container_unhealthy{name=\"$(esc "$name")\"} $([[ "$status" == *"(unhealthy)"* ]] && echo 1 || echo 0)"$'\n'
        up+="gremion_container_up{name=\"$(esc "$name")\",service=\"$(esc "$service")\",project=\"$(esc "$project")\"} $([[ "$status" == Up* ]] && echo 1 || echo 0)"$'\n'
    done <<< "$rows"
    if [[ -n "$unhealthy" ]]; then
        printf '# HELP gremion_container_unhealthy 1 when Docker reports the container unhealthy.\n'
        printf '# TYPE gremion_container_unhealthy gauge\n'
        printf '%s' "$unhealthy"
        printf '# HELP gremion_container_up 1 when the container is running.\n'
        printf '# TYPE gremion_container_up gauge\n'
        printf '%s' "$up"
    fi
    # Per-container memory (TRD-181), from the daemon: no ops container reads
    # cgroups or the Docker API.
    while IFS=$'\t' read -r name size; do
        [[ -n "$name" ]] || continue
        bytes="$(to_bytes "${size%% /*}")"
        [[ -n "$bytes" ]] && mem+="gremion_container_memory_bytes{name=\"$(esc "$name")\"} ${bytes}"$'\n'
    done < <(docker stats --no-stream --format '{{.Name}}	{{.MemUsage}}' 2>/dev/null || true)
    if [[ -n "$mem" ]]; then
        printf '# HELP gremion_container_memory_bytes Memory the container uses (docker stats).\n'
        printf '# TYPE gremion_container_memory_bytes gauge\n'
        printf '%s' "$mem"
    fi
    # Per-container disk: the writable layer (volumes are TRD-224's components).
    while IFS=$'\t' read -r name size; do
        [[ -n "$name" ]] || continue
        bytes="$(to_bytes "${size%% *}")"
        [[ -n "$bytes" ]] && disk+="gremion_container_disk_bytes{name=\"$(esc "$name")\"} ${bytes}"$'\n'
    done < <(docker ps --all --size --filter "label=com.docker.compose.project" --format '{{.Names}}	{{.Size}}' 2>/dev/null || true)
    if [[ -n "$disk" ]]; then
        printf '# HELP gremion_container_disk_bytes Bytes in the container writable layer (docker ps --size).\n'
        printf '# TYPE gremion_container_disk_bytes gauge\n'
        printf '%s' "$disk"
    fi
}

state_container() {   # <compose service> -- the first running container of it in ${STACK}-state
    docker ps --filter "label=com.docker.compose.project=${STACK_NAME}-state" \
              --filter "label=com.docker.compose.service=$1" \
              --format '{{.ID}}' | head -n 1
}

emit_postgres_connections() {
    local cid row used max
    cid="$(state_container postgres)"
    [[ -n "$cid" ]] || { note "no ${STACK_NAME}-state postgres container -- PostgresConnections80pct fires by absence"; return 0; }
    row="$(docker exec "$cid" psql -U postgres -tAF'|' -c \
        "SELECT (SELECT count(*) FROM pg_stat_activity), (SELECT setting::int FROM pg_settings WHERE name='max_connections')" \
        2>/dev/null || true)"
    row="$(printf '%s' "$row" | tr -d '[:space:]')"
    used="${row%%|*}"
    max="${row##*|}"
    if ! [[ "$used" =~ ^[0-9]+$ && "$max" =~ ^[0-9]+$ && "$max" != "0" ]]; then
        note "postgres query returned '$row' -- emitting nothing"
        return 0
    fi
    printf '# HELP gremion_postgres_connections_used Backends currently connected to the state Postgres.\n'
    printf '# TYPE gremion_postgres_connections_used gauge\n'
    printf 'gremion_postgres_connections_used %s\n' "$used"
    printf '# HELP gremion_postgres_connections_max The server max_connections setting.\n'
    printf '# TYPE gremion_postgres_connections_max gauge\n'
    printf 'gremion_postgres_connections_max %s\n' "$max"
}

# The jq program per family: one family per pass, so every family's samples
# stay contiguous (the text format requires it).
JSZ_ESC='def esc: tostring | gsub("\\\\"; "\\\\\\\\") | gsub("\""; "\\\"");'
JSZ_STREAMS='.account_details[]? as $a | ($a.stream_detail // [])[] as $s'
JSZ_CONSUMERS="${JSZ_STREAMS}"' | ($s.consumer_detail // [])[] as $c'

emit_nats() {
    local cid json fam
    cid="$(state_container nats)"
    [[ -n "$cid" ]] || { note "no ${STACK_NAME}-state nats container -- broker signals absent"; return 0; }
    json="$(docker exec "$cid" wget -qO- 'http://127.0.0.1:8222/jsz?accounts=true&streams=true&consumers=true' 2>/dev/null || true)"
    if ! jq -e 'type == "object" and has("account_details")' >/dev/null 2>&1 <<< "$json"; then
        note "the broker's jsz did not answer with account details -- broker signals absent"
        return 0
    fi
    printf '# HELP gremion_nats_jsz_up 1 when the broker answered jsz with account details.\n'
    printf '# TYPE gremion_nats_jsz_up gauge\n'
    printf 'gremion_nats_jsz_up 1\n'
    for fam in 'stream_messages:$s.state.messages' 'stream_bytes:$s.state.bytes'; do
        printf '# TYPE gremion_nats_%s gauge\n' "${fam%%:*}"
        jq -r "${JSZ_ESC} ${JSZ_STREAMS} | \"gremion_nats_${fam%%:*}{account=\\\"\(\$a.name // \$a.id | esc)\\\",stream=\\\"\(\$s.name | esc)\\\"} \((${fam#*:}) // 0)\"" <<< "$json"
    done
    for fam in 'consumer_num_pending:$c.num_pending' 'consumer_num_ack_pending:$c.num_ack_pending' \
               'consumer_ack_floor_stream_seq:$c.ack_floor.stream_seq' 'consumer_delivered_stream_seq:$c.delivered.stream_seq'; do
        printf '# TYPE gremion_nats_%s gauge\n' "${fam%%:*}"
        jq -r "${JSZ_ESC} ${JSZ_CONSUMERS} | \"gremion_nats_${fam%%:*}{account=\\\"\(\$a.name // \$a.id | esc)\\\",stream=\\\"\(\$s.name | esc)\\\",consumer=\\\"\(\$c.name | esc)\\\"} \((${fam#*:}) // 0)\"" <<< "$json"
    done
}

# df -B1 of the filesystem holding <path>: "<size> <avail>", or nothing.
fs_bytes() {
    df -B1 --output=size,avail "$1" 2>/dev/null | awk 'NR == 2 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print $1, $2 }'
}

emit_filesystems() {
    local root="$DISK_ROOT" sa mp seen=""
    if [[ -z "$root" ]]; then
        root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
    fi
    printf '# HELP gremion_host_filesystem_size_bytes Size of the filesystem holding the mountpoint label.\n'
    printf '# TYPE gremion_host_filesystem_size_bytes gauge\n'
    for mp in / ${root:+"$root"}; do
        [[ " $seen " == *" $mp "* ]] && continue
        seen+=" $mp"
        sa="$(fs_bytes "$mp")"
        [[ -n "$sa" ]] && printf 'gremion_host_filesystem_size_bytes{mountpoint="%s"} %s\n' "$(esc "$mp")" "${sa%% *}"
    done
    printf '# HELP gremion_host_filesystem_avail_bytes Bytes available on the filesystem holding the mountpoint label.\n'
    printf '# TYPE gremion_host_filesystem_avail_bytes gauge\n'
    seen=""
    for mp in / ${root:+"$root"}; do
        [[ " $seen " == *" $mp "* ]] && continue
        seen+=" $mp"
        sa="$(fs_bytes "$mp")"
        [[ -n "$sa" ]] && printf 'gremion_host_filesystem_avail_bytes{mountpoint="%s"} %s\n' "$(esc "$mp")" "${sa##* }"
    done
    # TRD-224's denominator: the PROVISIONED size where the data lives.
    if [[ -n "$root" ]] && sa="$(fs_bytes "$root")" && [[ -n "$sa" ]]; then
        printf '# HELP gremion_host_disk_provisioned_bytes Size of the filesystem at GREMION_DISK_ROOT (TRD-224 denominator).\n'
        printf '# TYPE gremion_host_disk_provisioned_bytes gauge\n'
        printf 'gremion_host_disk_provisioned_bytes{path="%s"} %s\n' "$(esc "$root")" "${sa%% *}"
    else
        note "no filesystem size for GREMION_DISK_ROOT '${root}' -- the TRD-224 denominator is absent"
    fi
}

measure_components() {
    local entry name path bytes vols n=0
    if [[ -n "$COMPONENTS" ]]; then
        set -f
        # shellcheck disable=SC2086  # a space-separated list, split on purpose
        for entry in $COMPONENTS; do
            name="${entry%%=*}"; path="${entry#*=}"
            if [[ "$entry" != *=* || -z "$name" || -z "$path" ]]; then
                note "GREMION_STORAGE_COMPONENTS entry '$entry' is not <component>=<path> -- skipped"
                continue
            fi
            bytes="$(du -sb "$path" 2>/dev/null | awk 'NR == 1 && $1 ~ /^[0-9]+$/ { print $1 }')"
            if [[ -z "$bytes" ]]; then
                note "component ${name}: ${path} not measurable -- absent, never 0"
                continue
            fi
            printf 'gremion_storage_component_bytes{component="%s"} %s\n' "$(esc "$name")" "$bytes"
            n=$((n + 1))
        done
        set +f
    else
        vols="$(docker system df -v --format '{{json .Volumes}}' 2>/dev/null || true)"
        while IFS=$'\t' read -r name bytes; do
            [[ -n "$name" ]] || continue
            bytes="$(to_bytes "$bytes")"
            [[ -n "$bytes" ]] || continue
            printf 'gremion_storage_component_bytes{component="%s"} %s\n' "$(esc "$name")" "$bytes"
            n=$((n + 1))
        done < <(jq -r --arg p "${STACK_NAME}-state_" '.[]? | select((.Name | startswith($p)) and ((.Name | endswith("pg-data")) or (.Name | endswith("vector-processed-logs")))) | [.Name, .Size] | @tsv' <<< "${vols:-[]}" 2>/dev/null || true)
    fi
    (( n > 0 )) || note "no storage component measured -- gremion_storage_component_bytes is absent"
}

emit_storage_components() {
    local now age=-1 body
    now="$(date -u +%s)"
    if [[ -s "$STORAGE_CACHE" ]]; then
        age=$(( now - $(date -u -r "$STORAGE_CACHE" +%s) ))
    fi
    if (( age < 0 || age >= STORAGE_INTERVAL )); then
        body="$(measure_components)"
        mkdir -p "$(dirname "$STORAGE_CACHE")"
        printf '%s\n' "$body" | atomic_write "$STORAGE_CACHE" 0644
    fi
    body="$(grep '^gremion_storage_component_bytes{' "$STORAGE_CACHE" 2>/dev/null || true)"
    [[ -n "$body" ]] || return 0
    printf '# HELP gremion_storage_component_bytes Bytes a tracked storage component holds (TRD-224).\n'
    printf '# TYPE gremion_storage_component_bytes gauge\n'
    printf '%s\n' "$body"
}

main() {
    local tmp
    # The scratch file is NOT written next to the output: the textfile reader
    # takes every *.prom in the directory, and a half-written one there is a
    # parse error on a real collector.
    tmp="$(mktemp)"
    {
        emit_backup
        emit_containers
        emit_postgres_connections
        emit_nats
        emit_filesystems
        emit_storage_components
        printf '# HELP gremion_metrics_textfile_timestamp_seconds Unix time this collector last completed.\n'
        printf '# TYPE gremion_metrics_textfile_timestamp_seconds gauge\n'
        printf 'gremion_metrics_textfile_timestamp_seconds %s\n' "$(date -u +%s)"
    } > "$tmp"
    atomic_write "$OUT_DIR/gremion.prom" 0644 < "$tmp"
    rm -f "$tmp"
    note "wrote $OUT_DIR/gremion.prom ($(wc -l < "$OUT_DIR/gremion.prom") lines)"
}

main "$@"
