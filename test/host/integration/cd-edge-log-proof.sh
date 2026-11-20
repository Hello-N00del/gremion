#!/usr/bin/env bash
#
# INTEGRATION (Docker on this box). Not collected by `make test-unit`.
#
# Proves, against a REAL Traefik of the pinned image, the one fact the watch of gremion-cd
# stands on (watch.sh, fact F21 of the plan): the edge access log carries `ServiceName`,
# `RouterName` and `DownstreamStatus` and a parseable start time, in the JSON shape the 5xx
# counter reads, and `docker exec <traefik> tail` works on that image. If a field differs, the
# field names in watch.sh (_cd_watch_scan) are the first thing to fix.
#
# What it does, with throwaway objects only:
#   - one container `bd-edgelog-<random>` of the Traefik image (the pin of docker-compose.yml,
#     or CD_EDGE_PROOF_IMAGE), created without a pull, started on one random high loopback
#     port, carrying the access log stanza of docker/traefik/traefik.yml and a file provider
#     with services app and public whose backend refuses connections (so every request is a
#     5xx with a service name) and a router named test-app on the same service;
#   - requests through the app router, the public router, the test-app router and an unknown
#     host;
#   - assertions on the lines the log really holds, then the REAL counter of watch.sh
#     (cd_watch_accesslog_count) against the container, found by compose labels the way the
#     program finds the edge, in a throwaway GREMION_ROOT;
#   - removal of the container by name and of the temp directory, and a post-condition check
#     that both are gone.
# It never touches a compose project, a volume, the network of another stack or the docker
# socket of the edge.
#
# Prints: CD-EDGE-LOG-PROOF: ok image=<ref> fields=ok tail=ok time=ok counter=<n>
# Exit codes: 0 ok, 1 an assertion failed, 2 a missing precondition (no docker, the image is
# not present locally: pull it first or set CD_EDGE_PROOF_IMAGE).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Git Bash rewrites arguments that look like absolute paths; the container paths below must
# reach docker as they are.
export MSYS_NO_PATHCONV=1

fail() { echo "FAIL: $*" >&2; exit 1; }
missing() { echo "SKIP-PRECONDITION: $*" >&2; exit 2; }

for c in docker curl jq; do
    command -v "$c" >/dev/null 2>&1 || missing "$c is not installed"
done
docker info >/dev/null 2>&1 || missing "the docker daemon does not answer"

# the image: the pin of the compose file unless the caller names one; never pulled implicitly
pin="$(grep -m1 -oE 'image: traefik:v[0-9.]+@sha256:[0-9a-f]{64}' "$REPO_ROOT/docker-compose.yml" | sed 's/^image: //')" || pin=''
IMAGE="${CD_EDGE_PROOF_IMAGE:-$pin}"
[[ -n "$IMAGE" ]] || missing "no Traefik image: the compose file names none and CD_EDGE_PROOF_IMAGE is empty"
docker image inspect "$IMAGE" >/dev/null 2>&1 || missing "the image ${IMAGE} is not present locally; pull it or set CD_EDGE_PROOF_IMAGE"

NAME="bd-edgelog-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
PORT=$((20000 + RANDOM % 30000))
WORK="$(mktemp -d)"
PROJECT="bd-edgelog-state"

# a host path in the form docker.exe takes (Git Bash on Windows) or as it is
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

cleanup() {
    local rc=$?
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
    if docker container inspect "$NAME" >/dev/null 2>&1; then
        echo "FAIL: the container ${NAME} is still there; remove it by name" >&2
        rc=1
    fi
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

mkdir -p "$WORK/cfg" "$WORK/dyn" "$WORK/logs" "$WORK/root/etc/env"

# the static configuration: the access log stanza of docker/traefik/traefik.yml, verbatim in
# its fields; one entry point; the file provider
cat > "$WORK/cfg/traefik.yml" <<'EOF'
log:
  level: ERROR
accessLog:
  filePath: "/logs/access.log"
  format: json
  bufferingSize: 100
  fields:
    defaultMode: keep
    names:
      ClientUsername: drop
    headers:
      defaultMode: drop
entryPoints:
  web:
    address: ":80"
providers:
  file:
    directory: /dyn
    watch: false
EOF

# the services answer 502 at once: the backend is a closed port. The names are the ones of the
# switch file (app, public); test-app is a router named like the loopback test router.
cat > "$WORK/dyn/routes.yml" <<'EOF'
http:
  services:
    app:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9"
    public:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9"
  routers:
    r-app:
      entryPoints: ["web"]
      rule: "Host(`app.example.org`)"
      service: app
    r-public:
      entryPoints: ["web"]
      rule: "Host(`public.example.org`)"
      service: public
    test-app:
      entryPoints: ["web"]
      rule: "Host(`loop.example.org`)"
      service: app
EOF

docker create --name "$NAME" -p "127.0.0.1:${PORT}:80" \
    --label "com.docker.compose.project=${PROJECT}" --label "com.docker.compose.service=traefik" \
    --label "com.docker.compose.oneoff=False" \
    "$IMAGE" --configFile=/cfg/traefik.yml >/dev/null
docker cp "$(hostpath "$WORK/cfg")" "${NAME}:/cfg"
docker cp "$(hostpath "$WORK/dyn")" "${NAME}:/dyn"
docker cp "$(hostpath "$WORK/logs")" "${NAME}:/logs"
docker start "$NAME" >/dev/null

# wait for the edge to answer (a 404 for an unknown host is an answer)
up=0
for _ in $(seq 1 40); do
    code="$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' -H 'Host: nobody.example.org' "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
    if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then up=1; break; fi
    sleep 0.5
done
[[ "$up" == 1 ]] || fail "the edge container never answered"

req() { curl -s -o /dev/null --max-time 5 -H "Host: $1" "http://127.0.0.1:${PORT}/probe-path" || true; }
T0="$(date +%s)"
for _ in 1 2 3; do req app.example.org; done
for _ in 1 2; do req public.example.org; done
for _ in 1 2; do req loop.example.org; done
req unknown.example.org

# the lines land within a short bound
got=0
for _ in $(seq 1 20); do
    got="$(docker exec "$NAME" tail -n 200 /logs/access.log 2>/dev/null | grep -c . || true)"
    [[ "$got" -ge 9 ]] && break
    sleep 0.5
done
[[ "$got" -ge 9 ]] || fail "the access log holds ${got} lines 10 seconds after nine requests"

# `docker exec <traefik> tail` works on the image, and prints JSON lines
log="$WORK/seen.log"
docker exec "$NAME" tail -n 200 /logs/access.log > "$log" || fail "docker exec tail does not work on the image"
jq -e -s 'length >= 9 and all(.[]; type == "object")' >/dev/null <"$log" || fail "the access log lines are not JSON objects"

# the three fields, for the lines of each router
app="$(jq -c 'select(.RouterName == "r-app@file")' <"$log")"
[[ "$(printf '%s\n' "$app" | grep -c .)" -eq 3 ]] || fail "expected three lines of the router r-app@file"
printf '%s\n' "$app" | jq -e -s 'all(.[]; .ServiceName == "app@file" and .DownstreamStatus == 502 and (.DownstreamStatus | type) == "number")' >/dev/null \
    || fail "ServiceName or DownstreamStatus differ from app@file and 502 on the app router"
pub="$(jq -c 'select(.RouterName == "r-public@file")' <"$log")"
printf '%s\n' "$pub" | jq -e -s 'length == 2 and all(.[]; .ServiceName == "public@file" and .DownstreamStatus == 502)' >/dev/null \
    || fail "ServiceName or DownstreamStatus differ from public@file and 502 on the public router"
jq -e -s '[.[] | select((.RouterName // "") | startswith("test-"))] | length == 2' >/dev/null <"$log" \
    || fail "the test router is not named test-app@file in RouterName"
echo "fields ok: ServiceName RouterName DownstreamStatus"

# the start time the counter filters on, parsed with the program's own expression
bad="$(jq -r --argjson now "$T0" '
    (.StartUTC // .time // "") | tostring | sub("\\.[0-9]+"; "") | (try fromdateiso8601 catch null)
    | if . == null then "unparsed" elif (. < $now - 120 or . > $now + 120) then "far" else "ok" end' <"$log" | sort | uniq -c | grep -v ' ok$' || true)"
[[ -z "$bad" ]] || fail "the start time of some lines does not parse or is not within two minutes of now: ${bad}"
echo "time ok: StartUTC parses with the counter's expression"

# the REAL counter against this container, found by its compose labels in a throwaway root
cat > "$WORK/root/etc/env/state.env" <<EOF
COMPOSE_PROJECT_NAME=${PROJECT}
COMPOSE_FILE=docker-compose.yml
EOF
cat > "$WORK/root/etc/cd.env" <<'EOF'
CD_REPO_URL=https://example.org/org/repo
CD_MAIL_TO=ops@example.org
CD_HOST_LABEL=proof
CD_PROBE_HOST=app.example.org
EOF
count="$(unset STACK; GREMION_ROOT="$WORK/root" SINCE="$((T0 - 30))" bash -c '
    set -euo pipefail
    . "'"$REPO_ROOT"'/infra/host/lib/common.sh"
    . "'"$REPO_ROOT"'/infra/host/lib/cd/core.sh"
    . "'"$REPO_ROOT"'/infra/host/lib/cd/docker.sh"
    . "'"$REPO_ROOT"'/infra/host/lib/cd/watch.sh"
    cd_cfg_load
    cd_watch_accesslog_count "$SINCE"')" || fail "the counter of watch.sh could not read the log of the edge"
# five 5xx on the services app@file and public@file; the two lines of the test-app router are
# not counted, and neither is the 404 of the unknown host
[[ "$count" == 5 ]] || fail "the counter says ${count}, expected 5 (3 app + 2 public, no test router, no 404)"
echo "counter ok: 5"

echo "CD-EDGE-LOG-PROOF: ok image=${IMAGE} fields=ok tail=ok time=ok counter=${count}"
