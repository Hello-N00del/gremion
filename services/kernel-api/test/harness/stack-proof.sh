#!/usr/bin/env bash
# services/kernel-api/test/harness/stack-proof.sh -- TDD 15, the scratch e2e of
# TASK-077: the kernel-api IMAGE at this checkout's HEAD against a real PG18 and a
# real Keycloak 26.6.1 holding two realms made from docker/keycloak/
# realm-export.base.json, the web container stopped.
#
#   stack-proof.sh build   docker build of the image (own call: a cold build can take minutes)
#   stack-proof.sh up      network, PG18, Keycloak (realm-a, realm-b, realm-c), seed, migrate job, kernel-api, web stand-in
#   stack-proof.sh test    the integration suite (test/harness/stack.mjs: its own PG + PgBouncer)
#   stack-proof.sh e2e     every section-1 item that needs the stack, as served responses (stack-e2e.ts)
#   stack-proof.sh down    removes every t077-<sha8>-e2e-* container, the network and the image BY NAME
#   stack-proof.sh status  what exists
#
# Plain `docker` only (never compose, never prune, never a gremion_* object); every
# name t077-<sha8>-e2e-*; everything published on 127.0.0.1; one phase per call
# (each stays well under 4 minutes after `build`). State in <repo>/.scratch/t077-stack/.
set -euo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERE="$(cd "$HERE" && pwd -W 2>/dev/null || pwd)"
SERVICE="$(cd "$HERE/../.." && (pwd -W 2>/dev/null || pwd))"
REPO="$(cd "$SERVICE/../.." && (pwd -W 2>/dev/null || pwd))"
SHA8="$(cd "$HERE" && node --input-type=module -e "import('./stack.mjs').then((m) => console.log(m.sha8))")"
PGIMAGE="$(cd "$HERE" && node --input-type=module -e "import('../../../../packages/tenant-store/test/harness/stack.mjs').then((m) => console.log(m.moduleImage()))")"
KCIMAGE="quay.io/keycloak/keycloak:26.6.1"
NODEIMAGE="node:26-alpine@sha256:7c6af15abe4e3de859690e7db171d0d711bf37d27528eddfe625b2fe89e097f8"
PFX="${T077_PREFIX:-t077}"   # a lane sets T077_PREFIX=t077r so its objects carry the lane prefix
P="${PFX}-${SHA8}-e2e"
N_DUMP="$P-dump"
N_NET="$P-net"; N_PG="$P-pg"; N_KC="$P-kc"; N_API="$P-api"; N_WEB="$P-web"
IMAGE="${PFX}-${SHA8}-kernel-api:head"
SDIR="$REPO/.scratch/t077-stack"
SDIR_M="$SDIR"
STATE="$SDIR/state.json"
PROXY="proxy-secret-for-the-scratch-stack-0123456789"
UIPASS="ui-secret-for-the-scratch-stack-0123456789"
USERPASS="scratch-user-pass-0123"

log() { echo "[t077-proof] $*" >&2; }
free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
exists() { docker inspect --format '{{.Name}}' "$1" >/dev/null 2>&1; }
jget() { node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(process.argv[2].split('.').reduce((o,k)=>o?.[k],s))" "$STATE" "$1"; }

phase_build() {
  log "building $IMAGE from HEAD $(git -C "$REPO" rev-parse --short=8 HEAD)"
  docker build -q -f "$SERVICE/Dockerfile" -t "$IMAGE" "$REPO" >/dev/null
  docker image inspect --format '{{.Id}}' "$IMAGE"
}

wait_ready_pg() {
  local i
  for i in $(seq 1 90); do
    docker exec "$N_PG" pg_isready -h 127.0.0.1 -U t077_admin -d t077_admin >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 2
  for i in $(seq 1 30); do
    docker exec "$N_PG" psql -h 127.0.0.1 -U t077_admin -d t077_admin -c 'SELECT 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

write_envs() {
  cat > "$SDIR/api.env" <<ENV
COLOUR=blue
KERNEL_API_ALLOW_ENV_SECRET_REFS=1
PLATFORM_DOMAIN=example.org
TENANT_PROXY_SHARED_SECRET=$PROXY
GREMION_RELEASE_REF=dist-v1.0.0
KERNEL_API_CONTROL_DB_URL=$(jget readerControlUrl)
KERNEL_API_PLATFORM_DB_URL=$(jget readerPlatformUrl)
ENV
  cat > "$SDIR/migrate.env" <<ENV
COLOUR=blue
KERNEL_API_ALLOW_ENV_SECRET_REFS=1
GREMION_RELEASE_REF=dist-v1.0.0
GREMION_MIGRATION_DUMP_DIR=/var/lib/gremion/migration-dump
KERNEL_API_CONTROL_DB_URL=$(jget readerControlUrl)
GREMION_KERNEL_PG_DIRECT_URL=postgresql://t077_admin:$(jget password)@$N_PG:5432/postgres
ENV
}

run_migrate() {
  docker run --rm --network "$N_NET" --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp \
    --tmpfs /var/lib/gremion/migration-dump:mode=0700,uid=1000,gid=1000,size=256m --env-file "$SDIR/migrate.env" \
    -v "$SDIR_M/tenants:/run/secrets/tenants:ro" "$IMAGE" node services/kernel-api/dist/index.js migrate "$@"
}

phase_up() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { log "image $IMAGE missing: run 'build' first"; exit 1; }
  local n
  for n in "$N_PG" "$N_KC" "$N_API" "$N_WEB"; do
    if exists "$n"; then log "$n already exists: run 'down' first"; exit 1; fi
  done
  rm -rf "$SDIR"; mkdir -p "$SDIR/tenants" "$SDIR/realms"
  local pgport kcport apiport pgpw
  pgport="$(free_port)"; kcport="$(free_port)"; apiport="$(free_port)"
  pgpw="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
  cat > "$STATE" <<JSON
{ "sha8": "$SHA8", "port": $pgport, "poolerPort": $pgport, "user": "t077_admin", "password": "$pgpw", "db": "t077_admin",
  "image": "$PGIMAGE", "container": "$N_PG", "kcPort": $kcport, "apiPort": $apiport, "proxy": "$PROXY", "uiSecret": "$UIPASS", "userPass": "$USERPASS",
  "tenantsDir": "$SDIR_M/tenants", "apiImage": "$IMAGE",
  "names": { "net": "$N_NET", "pg": "$N_PG", "kc": "$N_KC", "api": "$N_API", "web": "$N_WEB" } }
JSON
  log "network + PG18 ($PGIMAGE)"
  docker network create "$N_NET" >/dev/null
  docker run -d --name "$N_PG" --network "$N_NET" --network-alias "$N_PG" -p "127.0.0.1:$pgport:5432" \
    -e POSTGRES_USER=t077_admin -e "POSTGRES_PASSWORD=$pgpw" -e POSTGRES_DB=t077_admin "$PGIMAGE" >/dev/null
  log "Keycloak 26.6.1 with realm-a, realm-b, realm-c (real realm-export.base.json)"
  node "$HERE/keycloak/make-realms.mjs" "$SDIR/realms" "$UIPASS" "$USERPASS" >&2
  docker create --name "$N_KC" --network "$N_NET" --network-alias "$N_KC" -p "127.0.0.1:$kcport:8080" \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=a -e KC_BOOTSTRAP_ADMIN_PASSWORD=a "$KCIMAGE" start-dev --import-realm >/dev/null
  docker cp "$SDIR_M/realms" "$N_KC:/opt/keycloak/data/import"
  docker start "$N_KC" >/dev/null
  wait_ready_pg
  log "seeding control, gremion_platform, reader role, customers A and B"
  (cd "$SERVICE" && T077_SEED_MODE=world T077_STATE="$STATE" T077_SCRATCH="$SHA8" node node_modules/vitest/vitest.mjs run --config vitest.proof.config.ts test/harness/stack-seed.ts) >&2
  write_envs
  log "kernel-api-migrate (the image's own migrate command)"
  if ! run_migrate > "$SDIR/migrate-1.log" 2>&1; then cat "$SDIR/migrate-1.log" >&2; exit 1; fi
  cat "$SDIR/migrate-1.log" >&2
  log "kernel-api (read-only, cap_drop ALL, like the compose service) on 127.0.0.1:$apiport"
  docker run -d --name "$N_API" --network "$N_NET" --network-alias "$N_API" -p "127.0.0.1:$apiport:3000" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --tmpfs /tmp --env-file "$SDIR/api.env" -v "$SDIR_M/tenants:/run/secrets/tenants:ro" "$IMAGE" >/dev/null
  # stand-in for gremion-ui (its image is not built here): started so that `docker stop` has something to stop
  docker run -d --name "$N_WEB" --network "$N_NET" "$NODEIMAGE" sleep 3600 >/dev/null
  local i
  for i in $(seq 1 60); do
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$N_API")" = healthy ] && break
    sleep 2
  done
  log "kernel-api health: $(docker inspect --format '{{.State.Health.Status}}' "$N_API")"
  for i in $(seq 1 90); do
    curl -fsS "http://127.0.0.1:$kcport/realms/realm-b/.well-known/openid-configuration" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -fsS "http://127.0.0.1:$kcport/realms/realm-a/.well-known/openid-configuration" >/dev/null && log "keycloak realms answer"
}

phase_test() { (cd "$SERVICE" && pnpm test:integration); }

phase_e2e() {
  [ -f "$STATE" ] || { log "no stack: run 'up' first"; exit 1; }
  (cd "$SERVICE" && T077_STATE="$STATE" T077_SCRATCH="$SHA8" T077_SDIR="$SDIR" T077_PROOF="$HERE/stack-proof.sh" node node_modules/vitest/vitest.mjs run --config vitest.proof.config.ts test/harness/stack-e2e.ts)
}

phase_late() { (cd "$SERVICE" && T077_SEED_MODE=late T077_STATE="$STATE" T077_SCRATCH="$SHA8" node node_modules/vitest/vitest.mjs run --config vitest.proof.config.ts test/harness/stack-seed.ts) >&2; }

phase_status() {
  echo "containers: $(docker ps -a --filter "name=${PFX}-${SHA8}" --format '{{.Names}}' | tr '\n' ' ')"
  echo "volumes:    $(docker volume ls -q --filter "name=${PFX}-${SHA8}" | tr '\n' ' ')"
  echo "networks:   $(docker network ls --filter "name=${PFX}-${SHA8}" --format '{{.Name}}' | tr '\n' ' ')"
  echo "images:     $(docker images --format '{{.Repository}}:{{.Tag}}' | grep "${PFX}-${SHA8}" | tr '\n' ' ')"
}

phase_down() {
  local left=0 n
  for n in "$N_WEB" "$N_API" "$N_KC" "$N_PG"; do
    if exists "$n"; then docker rm -f -v "$n" >/dev/null || left=1; fi
  done
  if docker network inspect "$N_NET" >/dev/null 2>&1; then docker network rm "$N_NET" >/dev/null || left=1; fi
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then docker rmi "$IMAGE" >/dev/null || left=1; fi
  if docker volume inspect "$N_DUMP" >/dev/null 2>&1; then docker volume rm "$N_DUMP" >/dev/null || left=1; fi
  rm -rf "$SDIR"
  phase_status
  [ "$left" = 0 ]
}

case "${1:-}" in
  build) phase_build ;;
  up) phase_up ;;
  test) phase_test ;;
  e2e) phase_e2e ;;
  down) phase_down ;;
  status) phase_status ;;
  late) phase_late ;;
  migrate) shift; write_envs; run_migrate "$@" ;;
  *) echo "usage: stack-proof.sh build|up|test|e2e|down|status" >&2; exit 2 ;;
esac
