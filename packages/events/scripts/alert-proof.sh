#!/usr/bin/env bash
#
# TASK-079 acceptance "Alert": each dead-letter path produces exactly ONE e-mail through TASK-039's
# alerting over the host's collection path; a still-firing condition sends no second e-mail within
# 3 x group_interval; a resolve notice follows the clear (TRD-182). Invoked by proof.sh (one phase per
# call, each under 4 minutes):
#
#   alert-prepare   TASK-039's scratch stack (observability-proof.sh prepare) on t079-owned names, ports, subnets
#   alert-up        the ops project up, the service stand-ins, the DLQ stream, the quiet baseline
#   alert-red       RED first: the DeadLetterQueueNotEmpty rule absent from the rendered tree -> the
#                   condition is 1 in Prometheus and NO e-mail follows; the rule is then restored
#   alert-fire      all four conditions breach: exactly one FIRING e-mail each
#   alert-hold      the breach persists and grows for 3 x group_interval (180 s): still one each
#   alert-resolve   every condition clears: exactly one RESOLVED e-mail each
#   down            stand-ins removed BY NAME, then the 039 harness's own teardown
#
# Reuse, not a second harness [A, 079-R31-5]: the ops project, Grafana-managed alerting, Mailpit and the
# host collector are TASK-039's (test/host/integration/observability-proof.sh, called, never edited). That
# script refuses a stack name that does not start with t039-, so ours is t039-t079-<sha8>-obs: every name
# it derives (containers, volumes, networks, the ops project) carries t079. Proof timings are the harness's
# (evaluation 10 s, for 10 s, group_wait 10 s, group_interval 60 s), applied to the rendered tree by sed on the
# exact line shapes the committed rules keep.
#
# Deviations from the live path, named (the ledger repeats them):
#   - the three service gauges come from a stand-in container per context labelled
#     org.gremion.events-metrics=<ctx> whose `pnpm exec events metrics` prints the text the REAL
#     renderMetrics produces for the counts the proof sets. The collector's emit_events, the textfile,
#     Alloy, the recording rules, Grafana and the e-mail are real; the gauge VALUES from a real database are
#     proved by the live deadletter group and by test/cli.test.ts, and the CLI needs a tenant-store binding
#     that a scratch ops stack does not have.
#   - the DLQ condition reads the broker's real `jsz` through the real collector, from the ops harness's
#     unauthenticated scratch server (account $G); authentication is proved by the live groups.

set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PHASE="${1:-}"
OBS_SCRIPT="$ROOT/test/host/integration/observability-proof.sh"

hp() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
SHA8="$(git -C "$(hp "$ROOT")" rev-parse --short=8 HEAD)"
export STACK="t039-t079-${SHA8}-obs"
OPS="${STACK}-ops"
OUT="$ROOT/.scratch/t079/obs"
SROOT="$OUT/root"
SDIR="$ROOT/.scratch/t079/standins"
NET_STATE="${STACK}_state"
C_NATS="${STACK}-state-nats-1"
C_COLL="${STACK}-collector"
MAILPIT_PORT=18079

# The ports and subnets are t079's own so a TASK-039 proof running elsewhere cannot collide.
export OBS_PROOF_STACK="$STACK" OBS_PROOF_OUT="$OUT"
export OBS_GRAFANA_PORT=13079 OBS_KC_PORT=18479 OBS_INGEST_PORT=14379 OBS_INGEST_GRPC_PORT=14378 OBS_MAILPIT_PORT="$MAILPIT_PORT"
export OBS_STATE_SUBNET=10.239.79.0/24
OPS_SUBNET_V4=10.239.79.128/25
OPS_SUBNET_V6=fd5a:239:79::/64

# The 039 harness's own digests, read from it so they cannot drift.
pinned() { sed -n "s/^$1=\"\\(.*\\)\"\$/\\1/p" "$OBS_SCRIPT" | head -n 1; }
BUSYBOX_IMAGE="$(pinned BUSYBOX_IMAGE)"
NATSBOX_IMAGE="$(pinned NATSBOX_IMAGE)"

PASS=0
FAILS=0
ok()  { printf '  ok   %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$*" >&2; FAILS=$((FAILS + 1)); }
die() { printf 'FATAL: %s\n' "$*" >&2; exit 2; }
finish() {   # <minimum passing>
  printf '[alert-proof] %s passing (minimum %s), %s failing -- phase %s\n' "$PASS" "$1" "$FAILS" "$PHASE"
  (( FAILS == 0 && PASS >= $1 )) || exit 1
  exit 0
}

obs() { bash "$OBS_SCRIPT" "$@"; }

container_of() { printf '%s-%s-1' "$OPS" "$1"; }
natsbox() { docker run --rm --network "$NET_STATE" "$NATSBOX_IMAGE" nats -s "nats://${C_NATS}:4222" "$@"; }

promq() {
  local enc
  enc="$(jq -rn --arg q "$1" '$q|@uri')"
  docker exec "$(container_of prometheus)" wget -qO- "http://127.0.0.1:9090/api/v1/query?query=${enc}" 2>/dev/null || echo '{}'
}
prom_value() { promq "$1" | jq -r '.data.result[0].value[1] // empty' 2>/dev/null || true; }
value_is() { [[ "$(prom_value "$1")" == "$2" ]]; }
wait_until() {   # <seconds> <command...> -- poll every 5 s
  local deadline=$(( $(date +%s) + $1 )); shift
  while ! "$@"; do
    (( $(date +%s) < deadline )) || return 1
    sleep 5
  done
}
wait_healthy() {   # <seconds> <container>
  wait_until "$1" bash -c "[ \"\$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' '$2' 2>/dev/null)\" = healthy ]"
}

# Mailpit, the alerts@ sink. A subject carries [FIRING...] or [RESOLVED] and the alert name.
mail_subjects() { curl -fsS "http://127.0.0.1:${MAILPIT_PORT}/api/v1/messages?limit=500" 2>/dev/null | jq -r '.messages[]?.Subject' 2>/dev/null || true; }
mail_count() {   # <FIRING|RESOLVED> <alertname>
  mail_subjects | grep -F "[$1" | grep -cF -- "$2" || true
}
mail_at_least() { [[ "$(mail_count "$1" "$2")" -ge 1 ]]; }

# The host collector, run for real inside its container (observability-proof.sh collect()).
collect() {
  docker exec -e GREMION_ROOT=/g -e STACK="$STACK" -e GREMION_DISK_ROOT=/disk \
    -e GREMION_STORAGE_COMPONENTS="seeded=/disk/seeded" -e GREMION_STORAGE_INTERVAL=0 \
    "$C_COLL" bash /src/infra/host/ops/metrics-textfile.sh >/dev/null 2>&1
}

# The conditions this proof drives: <alertname>|<recording rule>|<ctx the stand-in carries>
ALERTS="OutboxDeadLettered InboxDeadLettered InboxStalled DeadLetterQueueNotEmpty"
CTXS="idt gov plt"

# The text the real `events metrics` prints, for chosen counts: the library's own renderMetrics.
write_metrics() {   # <ctx> <outbox dead> <inbox dead> <stalled>
  mkdir -p "$SDIR/$1"
  ( cd "$ROOT/packages/events" && CTX="$1" O="$2" D="$3" S="$4" node --import tsx --input-type=module -e \
    "import { renderMetrics } from './src/metrics.ts'; process.stdout.write(renderMetrics({ ctx: process.env.CTX, consumer: 'finance', outboxDeadLettered: Number(process.env.O), inboxDeadLettered: Number(process.env.D), inboxStalled: Number(process.env.S) }))" \
  ) > "$SDIR/$1/metrics.prom"
  grep -q "^gremion_outbox_dead_lettered{ctx=\"$1\"} $2\$" "$SDIR/$1/metrics.prom" || die "renderMetrics did not print the expected gauge for $1"
}
set_breach() {   # the four conditions at 1: outbox on idt, inbox dead letter on gov, stalled on plt, DLQ message
  write_metrics idt 1 0 0; write_metrics gov 0 1 0; write_metrics plt 0 0 1
}
set_quiet() { write_metrics idt 0 0 0; write_metrics gov 0 0 0; write_metrics plt 0 0 0; }

standin_up() {   # <ctx>
  local name="${STACK}-events-$1"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network none --label "org.gremion.events-metrics=$1" \
    -v "$(hp "$SDIR/$1"):/m:ro" "$BUSYBOX_IMAGE" sh -c \
    'printf "#!/bin/sh\ncat /m/metrics.prom\n" > /usr/local/bin/pnpm && chmod +x /usr/local/bin/pnpm && exec sleep 86400' >/dev/null
}

dlq_messages() {
  natsbox stream info DLQ --json 2>/dev/null | jq -r '.state.messages // empty' 2>/dev/null || true
}
dlq_ensure() {
  natsbox stream add DLQ --subjects 'gremion.t.dlq.>' --storage file --defaults >/dev/null 2>&1 || true
  [[ -n "$(dlq_messages)" ]] || die "the DLQ stream could not be created on the scratch broker"
}
dlq_put() { natsbox pub gremion.t.dlq.finance.proof "poisoned-$(date +%s)" >/dev/null 2>&1 || bad "could not publish to DLQ"; }

rendered_rules() { printf '%s/runtime/ops/grafana-provisioning/alerting/rules.yaml' "$SROOT"; }

phase_prepare() {
  [[ -n "$BUSYBOX_IMAGE" && -n "$NATSBOX_IMAGE" ]] || die "could not read the pinned images from $OBS_SCRIPT"
  obs prepare || die "observability-proof.sh prepare failed"
  # t079's own ops subnets: prepare writes fixed ones into the env, which a concurrent 039 proof would also hold.
  local env_file="$SROOT/etc/env/ops.env"
  sed -i -E "s#^OPS_V4_SUBNET=.*#OPS_V4_SUBNET=${OPS_SUBNET_V4}#; s#^OPS_V6_SUBNET=.*#OPS_V6_SUBNET=${OPS_SUBNET_V6}#" "$env_file"
  grep -q "^OPS_V4_SUBNET=${OPS_SUBNET_V4}\$" "$env_file" && ok "ops subnets are t079's own" || bad "ops subnets not set"
  finish 1
}

phase_up() {
  obs up || die "observability-proof.sh up failed"
  set_quiet
  local c
  for c in $CTXS; do standin_up "$c"; done
  ok "service stand-ins up: one per context, each labelled org.gremion.events-metrics=<ctx>"
  dlq_ensure
  ok "DLQ stream on the scratch broker (empty)"
  collect || bad "the collector run failed"
  wait_until 90 value_is 'max(gremion:cond:outbox_dead_lettered{component="idt"})' 0 \
    && ok "baseline: gremion:cond:outbox_dead_lettered{idt} is 0 through emit_events, Alloy and Prometheus" \
    || bad "the stand-in gauge never reached Prometheus"
  wait_until 30 value_is 'max(gremion:cond:dead_letter_queue{component=~".*DLQ"})' 0 \
    && ok "baseline: the DLQ condition is 0 (empty stream, real jsz)" || bad "the DLQ condition is not 0 at rest"
  local a n=0
  for a in $ALERTS; do n=$(( n + $(mail_count FIRING "$a") )); done
  [[ "$n" == 0 ]] && ok "no dead-letter e-mail at rest" || bad "$n dead-letter e-mails before any breach"
  finish 5
}

# RED first: with the rule absent from the rendered tree the condition fires in Prometheus and nothing is mailed.
phase_red() {
  local rules; rules="$(rendered_rules)"
  [[ -f "$rules" ]] || die "no rendered rules: run alert-prepare first"
  awk '
    /^      - uid: gremion-dead-letter-queue$/ { skip = 1; next }
    skip && (/^      - uid:/ || /^  [^ ]/ || /^[^ ]/) { skip = 0 }
    !skip { print }
  ' "$rules" > "$rules.red"
  grep -q 'DeadLetterQueueNotEmpty' "$rules.red" && die "the rule was not removed from the rendered tree"
  cp "$rules" "$OUT/rules.yaml.full"
  mv "$rules.red" "$rules"
  docker restart "$(container_of grafana)" >/dev/null
  wait_healthy 120 "$(container_of grafana)" && ok "grafana restarted without the DeadLetterQueueNotEmpty rule" || bad "grafana not healthy"
  dlq_put
  collect || bad "the collector run failed"
  wait_until 60 value_is 'max(gremion:cond:dead_letter_queue{component=~".*DLQ"})' 1 \
    && ok "RED: the condition is 1 in Prometheus (the DLQ holds an entry) while the rule is absent" || bad "the DLQ condition never reached 1"
  local end=$(( $(date +%s) + 70 ))
  while (( $(date +%s) < end )); do collect || true; sleep 15; done
  [[ "$(mail_count FIRING DeadLetterQueueNotEmpty)" == 0 ]] \
    && ok "RED: no e-mail within 70 s with the rule absent" || bad "an e-mail arrived without the rule"
  cp "$OUT/rules.yaml.full" "$rules"
  docker restart "$(container_of grafana)" >/dev/null
  wait_healthy 120 "$(container_of grafana)" && ok "rule restored, grafana healthy" || bad "grafana not healthy after the restore"
  finish 4
}

phase_fire() {
  [[ "$(dlq_messages)" -ge 1 ]] 2>/dev/null || dlq_put
  set_breach
  collect || bad "the collector run failed"
  date +%s > "$OUT/fire-start"
  wait_until 60 value_is 'max(gremion:cond:outbox_dead_lettered{component="idt"})' 1 && ok "outbox_dead_lettered{idt} is 1" || bad "outbox condition not seen"
  wait_until 30 value_is 'max(gremion:cond:inbox_dead_lettered{ctx="gov"})' 1 && ok "inbox_dead_lettered{gov} is 1" || bad "inbox dead-letter condition not seen"
  wait_until 30 value_is 'max(gremion:cond:inbox_stalled{ctx="plt"})' 1 && ok "inbox_stalled{plt} is 1" || bad "stalled condition not seen"
  wait_until 30 value_is 'max(gremion:cond:dead_letter_queue{component=~".*DLQ"})' 1 && ok "dead_letter_queue is 1 (jsz, real)" || bad "DLQ condition not seen"
  local a
  for a in $ALERTS; do
    wait_until 150 mail_at_least FIRING "$a" \
      && ok "FIRING e-mail for $a after $(( $(date +%s) - $(cat "$OUT/fire-start") )) s" || bad "no FIRING e-mail for $a"
  done
  sleep 15
  for a in $ALERTS; do
    [[ "$(mail_count FIRING "$a")" == 1 ]] && ok "exactly one FIRING e-mail for $a" || bad "$(mail_count FIRING "$a") FIRING e-mails for $a"
  done
  { mail_subjects | grep -F '[FIRING' | sed 's/^/    subject: /'; } || true
  finish 12
}

phase_hold() {
  dlq_put
  local end=$(( $(date +%s) + 185 ))
  while (( $(date +%s) < end )); do collect || true; sleep 20; done
  [[ "$(dlq_messages)" -ge 2 ]] 2>/dev/null && ok "the breach grew (DLQ holds $(dlq_messages) entries) while firing" || bad "the DLQ did not grow"
  value_is 'max(gremion:cond:outbox_dead_lettered{component="idt"})' 1 && ok "the conditions are still firing" || bad "a condition cleared during the hold"
  local a
  for a in $ALERTS; do
    [[ "$(mail_count FIRING "$a")" == 1 ]] && ok "still exactly one FIRING e-mail for $a after 3 x group_interval" || bad "$(mail_count FIRING "$a") FIRING e-mails for $a"
  done
  finish 6
}

phase_resolve() {
  set_quiet
  natsbox stream purge DLQ -f >/dev/null 2>&1 || bad "could not purge DLQ"
  collect || bad "the collector run failed"
  wait_until 60 value_is 'max(gremion:cond:outbox_dead_lettered{component="idt"})' 0 && ok "the conditions cleared" || bad "the conditions did not clear"
  local end=$(( $(date +%s) + 170 )) a all
  while (( $(date +%s) < end )); do
    all=1
    for a in $ALERTS; do mail_at_least RESOLVED "$a" || all=0; done
    (( all )) && break
    collect || true; sleep 10
  done
  for a in $ALERTS; do
    [[ "$(mail_count RESOLVED "$a")" == 1 ]] && ok "exactly one RESOLVED e-mail for $a" || bad "$(mail_count RESOLVED "$a") RESOLVED e-mails for $a"
  done
  finish 5
}

phase_down() {
  local c
  for c in $CTXS; do docker rm -f "${STACK}-events-$c" >/dev/null 2>&1 || true; done
  if [[ -f "$SROOT/etc/env/ops.env" ]]; then obs down || true; fi
  local left
  left="$(docker ps -a --format '{{.Names}}' | grep -F "$STACK" || true)"
  [[ -z "$left" ]] || { echo "left behind: $left" >&2; exit 1; }
  echo "[alert-proof] nothing named ${STACK}* is left"
}

case "$PHASE" in
  alert-prepare) phase_prepare ;;
  alert-up) phase_up ;;
  alert-red) phase_red ;;
  alert-fire) phase_fire ;;
  alert-hold) phase_hold ;;
  alert-resolve) phase_resolve ;;
  down) phase_down ;;
  *) echo "usage: $0 alert-prepare|alert-up|alert-red|alert-fire|alert-hold|alert-resolve|down" >&2; exit 2 ;;
esac
