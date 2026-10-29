#!/usr/bin/env bash
# services/kernel-api/test/bodies/image-proof.sh -- TASK-080-a round 3 (HIGH, G6): the DEPLOYED relay path, from the
# images. The proof.sh stack runs the relay inside the vitest process against seeds written by the same OS user, so it
# never exercised the image, its uid or the volume subpath mount. This one does:
#
#   * the TENANT-CREATE image (gremion-ui/Dockerfile target builder, root) runs `nats-auth init` / `ensure` on a
#     volume of its own -- the kernel-api/ owner directory must exist (and be uid 1000's) BEFORE any customer;
#   * the KERNEL-API image is started by `docker compose -p t080-<sha8>` from the REAL docker-compose.app.yml
#     `kernel-api` service (its subpath mount of that volume, read_only, cap_drop ALL, USER node), first with NO
#     customer (it must be up and healthy), then with one ZERO-module customer whose relay publishes the operator's
#     writes to the authenticated NATS;
#   * post-conditions are read from inside the stack: `ls -ln` in the container, outbox states, the IDT message count.
#
#   image-proof.sh build     both images from HEAD (own call; a cold build takes minutes; re-run to resume the cache)
#   image-proof.sh up        network, volumes, init, PG18, NATS, world seed, kernel-api via compose with NO customer
#   image-proof.sh customer  customer seed (zero modules), `ensure` by the tenant-create image, migrate by the image
#   image-proof.sh drive     operator writes -> the container relay publishes -> outbox + JetStream post-conditions
#   image-proof.sh evidence  ls -ln in the container and the volume, log lines
#   image-proof.sh down      removes every t080-<sha8> object of this proof BY NAME (never a prune, never gremion_*)
#   image-proof.sh status
#
# Plain `docker` + `docker compose -p t080-<sha8>`; names all start t080-<sha8>; ports on 127.0.0.1 only; one phase per call.
set -euo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && (pwd -W 2>/dev/null || pwd))"
SERVICE="$(cd "$HERE/../.." && (pwd -W 2>/dev/null || pwd))"
REPO="$(cd "$SERVICE/../.." && (pwd -W 2>/dev/null || pwd))"
SDIR="$REPO/.scratch/t080-image"
STATE="$SDIR/state.json"
SHA8="$(git -C "$REPO" rev-parse --short=8 HEAD)"
if [ -f "$STATE" ]; then P="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).prefix)" "$STATE")"; else P="t080-$SHA8"; fi
case "$P" in t080-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) echo "refusing prefix $P" >&2; exit 1;; esac
NET="${P}_state"; VSEC="${P}_nats_secrets"; VACC="${P}_nats_accounts"; VDUMP="${P}-dump"
N_PG="$P-pg"; N_NATS="$P-nats"; N_CP="$P-cp"
API_IMAGE="$P-kernel-api:head"; TC_IMAGE="$P-migrate:head"
API="${P}-kernel-api-1"
PGIMAGE="$(cd "$SERVICE/test/harness" && node --input-type=module -e "import('../../../../packages/tenant-store/test/harness/stack.mjs').then((m) => console.log(m.moduleImage()))")"
NATS_IMAGE="nats:2.12.15-alpine@sha256:b270f5e2428354c0335612694d7dd2fb588148e567a5757fdff325ef9c9332e6"
NODEIMAGE="node:26-alpine@sha256:7c6af15abe4e3de859690e7db171d0d711bf37d27528eddfe625b2fe89e097f8"
SLUG="img-z"
PROXY="proxy-secret-for-the-scratch-stack-0123456789"
COMPOSE=(docker compose -p "$P" --env-file ".scratch/t080-image/app.env" -f docker-compose.app.yml -f ".scratch/t080-image/override.yml")

log() { echo "[image-proof] $*" >&2; }
exists() { docker inspect --format '{{.Name}}' "$1" >/dev/null 2>&1; }
free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
jget() { node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(process.argv[2].split('.').reduce((o,k)=>o?.[k],s))" "$STATE" "$1"; }
vitest_image() { (cd "$SERVICE" && T080_IMAGE_MODE="$1" T080_IMAGE_STATE="$STATE" T077_STATE="$STATE" T077_SCRATCH="$SHA8" node node_modules/vitest/vitest.mjs run --config vitest.image.config.ts) >&2; }
wait_pg() {
  local i
  for i in $(seq 1 90); do docker exec "$N_PG" pg_isready -h 127.0.0.1 -U t080_admin -d t080_admin >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  for i in $(seq 1 30); do docker exec "$N_PG" psql -h 127.0.0.1 -U t080_admin -d t080_admin -c 'SELECT 1' >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
# the tenant-create image as the compose service runs it (root, working_dir /repo/gremion-ui), on the state network
tenant_create() {
  docker run --rm --network "$NET" -v "$VSEC:/run/secrets/nats" -v "$VACC:/etc/nats/accounts" -e "NATS_URL=nats://nats-$P:4222" \
    -w /repo/gremion-ui --entrypoint pnpm "$TC_IMAGE" exec nats-auth "$@"
}
volume_ls() { docker run --rm -v "$VSEC:/s:ro" "$NODEIMAGE" sh -c "$1"; }

phase_build() {
  log "building $API_IMAGE and $TC_IMAGE from HEAD $SHA8 (re-run if the call times out: the layer cache resumes)"
  docker build -q -f "$SERVICE/Dockerfile" -t "$API_IMAGE" "$REPO" >/dev/null
  docker build -q -f "$REPO/gremion-ui/Dockerfile" --target builder -t "$TC_IMAGE" "$REPO" >/dev/null
  docker image inspect --format '{{.Id}}' "$API_IMAGE" "$TC_IMAGE"
}

write_compose_files() {
  mkdir -p "$SDIR/tenants"
  # the fixture env the pooled-stack guard renders the app project with: every required variable is set (placeholders)
  grep -vE '^(STACK|COLOUR|COMPOSE_[A-Z_]*|COMPOSE_PROFILES|APP_V4_SUBNET|APP_V6_SUBNET|IMAGE_TAG|PLATFORM_DOMAIN|TENANT_PROXY_SHARED_SECRET|KERNEL_API_DB_PASSWORD|GREMION_MIGRATION_DUMP_DIR)=' \
    "$REPO/test/host/fixtures/pooled-stack/app-blue.env" > "$SDIR/app.env"
  cat >> "$SDIR/app.env" <<ENV
STACK=$P
COLOUR=blue
COMPOSE_PROJECT_NAME=$P
IMAGE_TAG=dist-v1.0.0
PLATFORM_DOMAIN=example.org
TENANT_PROXY_SHARED_SECRET=$PROXY
APP_V4_SUBNET=10.80.$((16#${SHA8:0:2} % 200 + 20)).0/24
APP_V6_SUBNET=fd80:${SHA8:0:4}::/64
GREMION_MIGRATION_DUMP_DIR=/tmp/t080-unused
TENANT_SECRETS_DIR=./.scratch/t080-image/tenants
KERNEL_API_DB_USER=$(jget reader.user)
KERNEL_API_DB_PASSWORD=$(jget reader.password)
CONTROL_DB_NAME=$(jget reader.controlDb)
ENV
  # the local image, never a pull; everything else (the subpath mount, read_only, cap_drop, user) is the real service
  cat > "$SDIR/override.yml" <<YML
services:
  kernel-api:
    image: $API_IMAGE
    pull_policy: never
    build: !reset null
YML
}

phase_up() {
  local n
  docker image inspect "$API_IMAGE" "$TC_IMAGE" >/dev/null 2>&1 || { log "images missing: run 'build' first"; exit 1; }
  for n in "$N_PG" "$N_NATS"; do if exists "$n"; then log "$n exists: run 'down' first"; exit 1; fi; done
  rm -rf "$SDIR"; mkdir -p "$SDIR/tenants" "$SDIR/secrets"
  local pgport natsport pgpw
  pgport="$(free_port)"; natsport="$(free_port)"
  pgpw="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
  cat > "$STATE" <<JSON
{ "prefix": "$P", "sha8": "$SHA8", "port": $pgport, "poolerPort": $pgport, "user": "t080_admin", "password": "$pgpw", "db": "t080_admin",
  "image": "$PGIMAGE", "container": "$N_PG", "natsPort": $natsport, "tenantsDir": "$SDIR/tenants", "secretsCopy": "$SDIR/secrets",
  "hosts": { "pg": "postgres-$P", "nats": "nats-$P" } }
JSON
  log "network $NET, volumes $VSEC $VACC"
  docker network create "$NET" >/dev/null
  docker volume create "$VSEC" >/dev/null
  docker volume create "$VACC" >/dev/null
  log "tenant-create image: nats-auth init on the EMPTY volume (no customer yet)"
  tenant_create init
  log "volume as the tenant-create image left it (ls -lnA):"
  volume_ls 'ls -lnA /s; echo ---; ls -lnA /s/kernel-api' | sed 's/^/[image-proof]   /' >&2
  log "PG18 and the authenticated NATS on the state network"
  docker run -d --name "$N_PG" --network "$NET" --network-alias "postgres-$P" -p "127.0.0.1:$pgport:5432" \
    -e POSTGRES_USER=t080_admin -e "POSTGRES_PASSWORD=$pgpw" -e POSTGRES_DB=t080_admin "$PGIMAGE" >/dev/null
  docker run -d --name "$N_NATS" --network "$NET" --network-alias "nats-$P" -p "127.0.0.1:$natsport:4222" \
    -v "$REPO/docker/nats/nats.conf:/etc/nats/nats.conf:ro" -v "$VACC:/etc/nats/accounts:ro" "$NATS_IMAGE" -c /etc/nats/nats.conf >/dev/null
  wait_pg
  log "world seed (control, gremion_platform, reader role): NO customer"
  vitest_image world
  write_compose_files
  log "docker compose -p $P up kernel-api (the real service block, NO customer yet, no broker account yet)"
  (cd "$REPO" && "${COMPOSE[@]}" up -d --no-deps kernel-api) >&2
  local i
  for i in $(seq 1 60); do [ "$(docker inspect --format '{{.State.Health.Status}}' "$API" 2>/dev/null)" = healthy ] && break; sleep 2; done
  log "kernel-api container $API: state=$(docker inspect --format '{{.State.Status}}' "$API") health=$(docker inspect --format '{{.State.Health.Status}}' "$API")"
  log "docker exec $API ls -ln /run/secrets/nats/kernel-api (no customer yet):"
  docker exec "$API" ls -lnd /run/secrets/nats/kernel-api | sed 's/^/[image-proof]   /' >&2
  docker exec "$API" id | sed 's/^/[image-proof]   id: /' >&2
}

phase_customer() {
  [ -f "$STATE" ] || { log "no stack: run 'up' first"; exit 1; }
  log "customer seed ($SLUG, zero modules)"
  vitest_image customer
  local cid; cid="$(jget customer.id)"
  log "tenant-create image: nats-auth ensure $SLUG --modules kernel-api"
  tenant_create ensure "$SLUG" --modules kernel-api >&2
  log "volume after ensure (ls -lnA /s/kernel-api):"
  volume_ls 'ls -lnA /s/kernel-api' | sed 's/^/[image-proof]   /' >&2
  # the admin seed, copied out for the host-side broker read (stream message count)
  docker create --name "$N_CP" -v "$VSEC:/s:ro" "$NODEIMAGE" >/dev/null
  docker cp "$N_CP:/s/_admin" "$SDIR/secrets/_admin" >/dev/null
  docker rm -f "$N_CP" >/dev/null
  # the migrate job: the image's own command, a durable dump dir owner-fixed to uid 1000 like the compose bind
  docker volume inspect "$VDUMP" >/dev/null 2>&1 || {
    docker volume create "$VDUMP" >/dev/null
    docker run --rm -v "$VDUMP:/d" "$NODEIMAGE" sh -c 'chown 1000:1000 /d && chmod 700 /d'
  }
  cat > "$SDIR/migrate.env" <<ENV
COLOUR=blue
GREMION_RELEASE_REF=dist-v1.0.0
GREMION_MIGRATION_DUMP_DIR=/var/lib/gremion/migration-dump
KERNEL_API_CONTROL_DB_URL=$(jget readerControlUrl)
GREMION_KERNEL_PG_DIRECT_URL=postgresql://postgres-$P:5432/postgres
ENV
  log "kernel-api-migrate (the image's migrate command) for $cid"
  docker run --rm --network "$NET" --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp \
    -v "$VDUMP:/var/lib/gremion/migration-dump" --env-file "$SDIR/migrate.env" -v "$SDIR/tenants:/run/secrets/tenants:ro" \
    "$API_IMAGE" node services/kernel-api/dist/index.js migrate --customer "$cid" >&2
  log "the customer's relay starts at the next reconcile (<= 30 s)"
}

phase_drive() {
  [ -f "$STATE" ] || { log "no stack: run 'up' first"; exit 1; }
  vitest_image drive
  cat "$SDIR/evidence.log" >&2
}

phase_evidence() {
  [ -f "$STATE" ] || { log "no stack"; exit 1; }
  echo "== docker exec $API ls -ln /run/secrets/nats/kernel-api"
  docker exec "$API" ls -ln /run/secrets/nats/kernel-api
  echo "== docker exec $API ls -ln /run/secrets/nats   (only the kernel-api subtree is visible, no other identity)"
  docker exec "$API" ls -ln /run/secrets/nats
  echo "== docker exec $API id"
  docker exec "$API" id
  echo "== mounts of $API (the subpath, read-only)"
  docker inspect --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}' "$API" | grep nats || true
  echo "== docker inspect: user / read-only rootfs / cap_drop"
  docker inspect --format 'user={{.Config.User}} readonly_rootfs={{.HostConfig.ReadonlyRootfs}} cap_drop={{.HostConfig.CapDrop}}' "$API"
  echo "== kernel-api log lines (relay)"
  docker logs "$API" 2>&1 | grep -iE "relay|nats" | tail -12
  echo "== relay errors in the log (want 0)"
  docker logs "$API" 2>&1 | grep -ciE "relay pass failed|no seed" || true
  echo "== volume (root view)"
  volume_ls 'ls -lnA /s; ls -lnA /s/kernel-api'
}

phase_status() {
  echo "containers: $(docker ps -a --filter "name=$P" --format '{{.Names}}' | tr '\n' ' ')"
  echo "volumes:    $(docker volume ls -q --filter "name=$P" | tr '\n' ' ')"
  echo "networks:   $(docker network ls --filter "name=$P" --format '{{.Name}}' | tr '\n' ' ')"
  echo "images:     $(docker images --format '{{.Repository}}:{{.Tag}}' | grep "$P" | tr '\n' ' ')"
}

phase_down() {
  local left=0 n
  if [ -f "$SDIR/app.env" ]; then (cd "$REPO" && "${COMPOSE[@]}" down --remove-orphans -v >/dev/null 2>&1) || true; fi
  for n in "$API" "$N_CP" "$N_NATS" "$N_PG"; do if exists "$n"; then docker rm -f -v "$n" >/dev/null || left=1; fi; done
  local net
  for net in "$NET" "${P}_app"; do if docker network inspect "$net" >/dev/null 2>&1; then docker network rm "$net" >/dev/null || left=1; fi; done
  for n in "$VSEC" "$VACC" "$VDUMP"; do if docker volume inspect "$n" >/dev/null 2>&1; then docker volume rm "$n" >/dev/null || left=1; fi; done
  for n in "$API_IMAGE" "$TC_IMAGE"; do if docker image inspect "$n" >/dev/null 2>&1; then docker rmi "$n" >/dev/null || left=1; fi; done
  rm -rf "$SDIR"
  phase_status
  [ "$left" = 0 ]
}

case "${1:-}" in
  build) phase_build ;;
  up) phase_up ;;
  customer) phase_customer ;;
  drive) phase_drive ;;
  evidence) phase_evidence ;;
  status) phase_status ;;
  down) phase_down ;;
  *) echo "usage: image-proof.sh build|up|customer|drive|evidence|status|down" >&2; exit 2 ;;
esac
