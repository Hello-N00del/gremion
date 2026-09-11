#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-backup and infra/host/bin/gremion-snapshot.
# Run: bats test/host/backup.bats
load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
BACKUP="${PROJECT_ROOT}/infra/host/bin/gremion-backup"
SNAPSHOT="${PROJECT_ROOT}/infra/host/bin/gremion-snapshot"
BOOTSTRAP="${PROJECT_ROOT}/infra/host/bootstrap.sh"
UNIT_DIR="${PROJECT_ROOT}/infra/host/templates/systemd"

# ---------------------------------------------------------------------------
# bootstrap base stage: the backup tooling is a host package, not a container
# ---------------------------------------------------------------------------

@test "bootstrap base stage installs restic and rclone" {
    grep -qE '^\s+restic rclone' "$BOOTSTRAP"
}

@test "bootstrap base stage asserts restic and rclone on PATH and restic runs" {
    grep -qF 'assert "restic on PATH"' "$BOOTSTRAP"
    grep -qF 'assert "rclone on PATH"' "$BOOTSTRAP"
    grep -qF 'assert "restic version runs"' "$BOOTSTRAP"
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

write_state_env() {
    mkdir -p "${GREMION_ROOT}/etc/env"
    cat >"${GREMION_ROOT}/etc/env/state.env" <<'ENV'
STACK=staging
COMPOSE_PROJECT_NAME=staging-state
COMPOSE_FILE=docker-compose.yml:docker-compose.pins.yml
POSTGRES_USER=postgres
RESTIC_REPOSITORY=__ROOT__/backups/repo
RESTIC_PASSWORD=test-restic-passphrase-not-a-real-secret
RCLONE_REMOTE=backup
RCLONE_BUCKET=gremion-test
RCLONE_REMOTE_PATH=gremion-restic
RCLONE_CONFIG_BACKUP_TYPE=s3
RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID=test-access-key-id
RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY=test-secret-access-key
RCLONE_CONFIG_BACKUP_ENDPOINT=https://objects.example.org
RCLONE_CONFIG_BACKUP_REGION=eu-central-1
BACKUP_RETENTION_DAILY=14
BACKUP_RETENTION_WEEKLY=8
BACKUP_RETENTION_MONTHLY=6
ALERT_WEBHOOK_URL=https://alerts.example.org/hook
ENV
    sed -i "s|__ROOT__|${GREMION_ROOT}|g" "${GREMION_ROOT}/etc/env/state.env"
}

drop_state_key() {   # $1 = key to remove from the fixture state.env
    local f="${GREMION_ROOT}/etc/env/state.env"
    grep -v "^${1}=" "$f" >"${f}.new"
    mv "${f}.new" "$f"
}

# A release tree whose scripts/backup.sh behaves like the kernel's: it reads
# .env from its own root, honours BACKUP_DIR/POSTGRES_USER, writes the three
# kernel dumps, and records the environment it was handed.
make_release_fixture() {
    RELEASE_DIR="${GREMION_ROOT}/current"
    mkdir -p "${RELEASE_DIR}/scripts"
    cat >"${RELEASE_DIR}/scripts/backup.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "kernel-backup: .env not found" >&2; exit 1; }
# shellcheck disable=SC1091
. ./.env
{
  echo "kernel-backup BACKUP_DIR=${BACKUP_DIR}"
  echo "kernel-backup POSTGRES_USER=${POSTGRES_USER}"
  echo "kernel-backup RESTIC_REPOSITORY=${RESTIC_REPOSITORY}"
  echo "kernel-backup RCLONE_BUCKET=[${RCLONE_BUCKET}]"
  echo "kernel-backup COMPOSE_FILE=${COMPOSE_FILE}"
} >>"$SHIM_LOG"
mkdir -p "${BACKUP_DIR}/current"
for db in keycloak gremion control; do
    printf 'dump-of-%s' "$db" | gzip >"${BACKUP_DIR}/current/${db}.sql.gz"
done
STUB
    chmod +x "${RELEASE_DIR}/scripts/backup.sh"
    export GREMION_RELEASE_DIR="$RELEASE_DIR"
}

# TASK 9 DEVIATION FROM THE BRIEF, deliberate: docker, restic, rclone and curl
# are NOT installed in the bats runner container, and docker IS installed on the
# Windows box. Without an inert recording stub for each, the same test file
# would die in need_cmd here and drive a REAL docker there — the one thing this
# suite's house rule forbids. Every test that cares about a tool's behaviour
# overwrites its stub; these only make the environment the same everywhere.
shim_absent_tools() {
    local c
    for c in docker restic rclone rsync curl; do shim "$c"; done
}

setup() {
    setup_host_root
    shim_absent_tools
    write_state_env
    make_release_fixture
}

# setup_host_root mints a fresh mktemp -d per test; without this every run of
# this file leaves 60-odd directories behind in the system temp.
teardown() {
    teardown_host_root
}

# ---------------------------------------------------------------------------
# Shape and argument validation
# ---------------------------------------------------------------------------

@test "gremion-backup exists and is executable" {
    [ -x "$BACKUP" ]
}

@test "gremion-backup has strict mode set" {
    grep -q 'set -euo pipefail' "$BACKUP"
}

@test "gremion-backup declares its common.sh source for shellcheck" {
    # Task 14's lint gate requires the bare `source=` directive on every
    # infra/host script that sources common.sh through $SCRIPT_DIR.
    grep -qF '# shellcheck source=../lib/common.sh' "$BACKUP"
}

@test "gremion-backup rejects an unknown class with exit 2" {
    run "$BACKUP" --class weekly
    [ "$status" -eq 2 ]
    [[ "$output" == *"invalid --class: weekly"* ]]
}

@test "gremion-backup rejects a label with a path separator with exit 2" {
    run "$BACKUP" --label 'dist-v1.0.0/../etc'
    [ "$status" -eq 2 ]
    [[ "$output" == *"invalid --label"* ]]
}

@test "gremion-backup rejects an unknown flag with exit 2" {
    run "$BACKUP" --prune-everything
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown argument: --prune-everything"* ]]
}

@test "gremion-backup --label without a value exits 2" {
    run "$BACKUP" --label
    [ "$status" -eq 2 ]
    [[ "$output" == *"--label needs a value"* ]]
}

# ---------------------------------------------------------------------------
# Shims — no test in this file touches a real docker, restic, rclone or rsync
# ---------------------------------------------------------------------------

shim_df_plenty() {
    shim df 'echo "Filesystem 1B-blocks Used Available Use% Mounted on"
echo "/dev/vda4 1000000000000 1000000000 990000000000 1% /"'
}

shim_rclone_ok() {
    shim rclone 'case "$1" in
  lsd)    [ -f "$GREMION_ROOT/.offsite-down" ] && exit 1 ; exit 0 ;;
  lsjson) echo "[{\"Name\":\"config\"},{\"Name\":\"data\"}]" ;;
  sync)   exit 0 ;;
esac
exit 0'
}

shim_curl_ok() { shim curl 'exit 0'; }

shim_baseline() {
    shim_df_plenty
    shim_rclone_ok
    shim_curl_ok
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

@test "a missing state.env is a precondition failure (exit 2)" {
    shim_baseline
    rm -f "${GREMION_ROOT}/etc/env/state.env"
    run "$BACKUP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"missing ${GREMION_ROOT}/etc/env/state.env"* ]]
}

@test "a state.env without ALERT_WEBHOOK_URL is a precondition failure (exit 2)" {
    shim_baseline
    drop_state_key ALERT_WEBHOOK_URL
    run "$BACKUP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"missing required keys: ALERT_WEBHOOK_URL"* ]]
}

@test "a half-configured rclone remote fails at the start, not at the sync (exit 2)" {
    shim_baseline
    drop_state_key RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY
    run "$BACKUP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"missing required keys: RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY"* ]]
    # Nothing was written: the failure is a precondition, not a partial run.
    [ ! -d "${GREMION_ROOT}/backups/current/volumes" ]
}

@test "an unreachable off-site remote stops the run before anything is written (exit 2)" {
    shim_baseline
    touch "${GREMION_ROOT}/.offsite-down"
    run "$BACKUP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"offsite remote unreachable: backup:gremion-test"* ]]
    [ ! -d "${GREMION_ROOT}/backups/current/volumes" ]
}

@test "an absent release tree is a precondition failure (exit 2)" {
    shim_baseline
    rm -rf "${GREMION_ROOT}/current"
    run "$BACKUP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"release tree absent"* ]]
}

# ---------------------------------------------------------------------------
# Free space (§J: "Both scripts assert free space before writing")
# ---------------------------------------------------------------------------

write_last_backup_json() {   # $1 = bytes, $2 = ok(true|false), $3 = class
    mkdir -p "${GREMION_ROOT}/runtime"
    jq -n --argjson bytes "$1" --argjson ok "$2" --arg class "$3" \
       '{ts:"2026-09-01T02:00:00Z", ok:$ok, label:"prev", class:$class,
         artefacts:{databases:5, volumes:4, buckets:2},
         offsite:true, bytes:$bytes}' \
       >"${GREMION_ROOT}/runtime/last-backup.json"
}

@test "free space below 1.5x the last successful backup fails with both numbers" {
    shim_rclone_ok; shim_curl_ok
    # 100 GB free, previous repository 80 GB -> needs 120 GB.
    shim df 'echo "Filesystem 1B-blocks Used Available Use% Mounted on"
echo "/dev/vda4 1000000000000 900000000000 100000000000 90% /"'
    write_last_backup_json 80000000000 true daily
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"free space 100000000000B below required 120000000000B"* ]]
}

@test "the first run uses the 10 GiB floor, not zero" {
    shim_rclone_ok; shim_curl_ok
    shim df 'echo "Filesystem 1B-blocks Used Available Use% Mounted on"
echo "/dev/vda4 1000000000000 999000000000 1000000000 99% /"'
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"below required 10737418240B"* ]]
}

@test "a failed previous run is not used as the free-space baseline" {
    shim_rclone_ok; shim_curl_ok
    shim df 'echo "Filesystem 1B-blocks Used Available Use% Mounted on"
echo "/dev/vda4 1000000000000 999000000000 1000000000 99% /"'
    write_last_backup_json 80000000000 false daily
    run "$BACKUP"
    [ "$status" -eq 1 ]
    # ok:false -> its .bytes is meaningless, so the floor applies.
    [[ "$output" == *"below required 10737418240B"* ]]
}

# ---------------------------------------------------------------------------
# Volume enumeration (§J: refuses to run if the enumeration fails)
# ---------------------------------------------------------------------------

shim_docker_ok() {
    shim docker 'case "$1 $2" in
  "volume ls")
     case "$*" in
       *"project=staging-state"*) printf "staging-state_pgdata\nstaging-state_nats\n" ;;
       *"project=staging-mail"*)  printf "staging-mail_spool\n" ;;
     esac ;;
  "volume inspect")
     [ -f "$GREMION_ROOT/.volume-missing-$3" ] && exit 1
     exit 0 ;;
esac
exit 0'
}

@test "enumeration unions both project queries and the three external volumes" {
    shim_baseline; shim_docker_ok
    run "$BACKUP"
    [[ "$output" == *"volumes enumerated: 6"* ]]
    # Repeated --filter label= is ANDed by docker, so the two projects MUST be
    # two calls; one call with both filters returns nothing.
    assert_recorded docker "label=com.docker.compose.project=staging-state"
    assert_recorded docker "label=com.docker.compose.project=staging-mail"
}

@test "an enumeration that returns zero volumes refuses to back up" {
    shim_baseline
    shim docker 'exit 0'
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"volume enumeration returned zero volumes"* ]]
}

@test "a declared external volume that is absent fails by name" {
    shim_baseline; shim_docker_ok
    touch "${GREMION_ROOT}/.volume-missing-staging_tenant_secrets"
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"enumerated volume absent: staging_tenant_secrets"* ]]
}

# ---------------------------------------------------------------------------
# Kernel dump driver
# ---------------------------------------------------------------------------

@test "the kernel dump script is handed BACKUP_DIR and POSTGRES_USER" {
    shim_baseline; shim_docker_ok
    run "$BACKUP"
    grep -qF "kernel-backup BACKUP_DIR=${GREMION_ROOT}/backups" "$SHIM_LOG"
    grep -qF "kernel-backup POSTGRES_USER=postgres" "$SHIM_LOG"
    # The staged tree is …/backups/current — the path Task 10 searches for.
    [ -s "${GREMION_ROOT}/backups/current/keycloak.sql.gz" ]
    [ ! -d "${GREMION_ROOT}/backups/staging" ]
}

@test "the kernel dump script never gets this repository or the off-site bucket" {
    shim_baseline; shim_docker_ok
    run "$BACKUP"
    # Its own `restic forget --keep-within 30d --prune` must not be able to
    # reach the real repository, and its rclone phase must be skipped.
    [ -s "$SHIM_LOG" ]
    ! grep -qF "kernel-backup RESTIC_REPOSITORY=${GREMION_ROOT}/backups/repo" "$SHIM_LOG"
    grep -qF "kernel-backup RESTIC_REPOSITORY=${GREMION_ROOT}/runtime/kernel-backup/scratch-repo" "$SHIM_LOG"
    grep -qF "kernel-backup RCLONE_BUCKET=[]" "$SHIM_LOG"
}

@test "the kernel dump script gets an absolute COMPOSE_FILE" {
    shim_baseline; shim_docker_ok
    run "$BACKUP"
    grep -qF "kernel-backup COMPOSE_FILE=${GREMION_ROOT}/current/docker-compose.yml:${GREMION_ROOT}/current/docker-compose.pins.yml" "$SHIM_LOG"
}

@test "the driver leaves no generated .env and no scratch repository behind" {
    shim_baseline; shim_docker_ok
    run "$BACKUP"
    [ ! -f "${GREMION_ROOT}/runtime/kernel-backup/.env" ]
    [ ! -d "${GREMION_ROOT}/runtime/kernel-backup/scratch-repo" ]
}

@test "an absent kernel dump script is a precondition failure (exit 2)" {
    shim_baseline; shim_docker_ok
    rm -f "${GREMION_ROOT}/current/scripts/backup.sh"
    run "$BACKUP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"kernel dump script absent"* ]]
}

# ---------------------------------------------------------------------------
# Database coverage (§J: enumerated from the running system)
# ---------------------------------------------------------------------------

shim_docker_with_pg() {   # $1 = extra databases beyond the kernel three
    local extra="${1:-t_pilot}"
    shim docker "case \"\$1 \$2\" in
  \"volume ls\")
     case \"\$*\" in
       *\"project=staging-state\"*) printf \"staging-state_pgdata\nstaging-state_nats\n\" ;;
       *\"project=staging-mail\"*)  printf \"staging-mail_spool\n\" ;;
     esac ;;
  \"volume inspect\") exit 0 ;;
  \"compose exec\"|\"compose \"*)
     case \"\$*\" in
       *count*)       printf \"5\n\" ;;
       *pg_database*) printf \"control\ngremion\nkeycloak\npostgres\n${extra}\n\" ;;
       *pg_dump*)     [ -f \"\$GREMION_ROOT/.empty-dump\" ] || printf \"PGDUMP\" ;;
     esac ;;
  \"image inspect\") echo \"alpine@sha256:0000000000000000000000000000000000000000000000000000000000000001\" ;;
  run) exit 0 ;;
esac
exit 0"
}

@test "every database the running Postgres reports is dumped, not just the kernel three" {
    shim_baseline; shim_docker_with_pg "t_pilot"
    run "$BACKUP"
    [[ "$output" == *"every enumerated database has a non-empty dump (5)"* ]]
    [ -s "${GREMION_ROOT}/backups/current/t_pilot.sql.gz" ]
    [ -s "${GREMION_ROOT}/backups/current/postgres.sql.gz" ]
}

@test "the kernel three are not dumped twice" {
    shim_baseline; shim_docker_with_pg "t_pilot"
    run "$BACKUP"
    # keycloak/gremion/control came from the kernel script; pg_dump must only
    # have been asked for the databases it did not produce.
    ! assert_recorded docker "pg_dump -U postgres keycloak"
    assert_recorded docker "pg_dump -U postgres t_pilot"
}

@test "an empty dump for an enumerated database fails by name" {
    shim_baseline; shim_docker_with_pg "t_pilot"
    touch "${GREMION_ROOT}/.empty-dump"
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no dump for enumerated database: postgres"* ]]
}

@test "an enumeration that returns zero databases refuses to back up" {
    shim_baseline
    shim docker 'case "$1 $2" in
  "volume ls")
     case "$*" in
       *"project=staging-state"*) printf "staging-state_pgdata\n" ;;
     esac ;;
  "volume inspect") exit 0 ;;
esac
exit 0'
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"database enumeration returned zero databases"* ]]
}

# ---------------------------------------------------------------------------
# Volume archives
# ---------------------------------------------------------------------------

shim_docker_full() {   # everything above plus a `docker run … tar` that writes
    shim docker 'out="$GREMION_ROOT/backups/current/volumes"
case "$1 $2" in
  "volume ls")
     case "$*" in
       *"project=staging-state"*) printf "staging-state_pgdata\nstaging-state_nats\n" ;;
       *"project=staging-mail"*)  printf "staging-mail_spool\n" ;;
     esac ;;
  "volume inspect") exit 0 ;;
  "image inspect") echo "alpine@sha256:0000000000000000000000000000000000000000000000000000000000000001" ;;
  "compose exec"|"compose "*)
     case "$*" in
       *count*)       printf "5\n" ;;
       *pg_database*) printf "control\ngremion\nkeycloak\npostgres\nt_pilot\n" ;;
       *pg_dump*)     [ -f "$GREMION_ROOT/.empty-dump" ] || printf "PGDUMP" ;;
     esac ;;
  pull*) [ -f "$GREMION_ROOT/.pull-fails" ] && exit 1 ; exit 0 ;;
  run*)
     prev=""; tarfile=""
     for a in "$@"; do [ "$prev" = "-cf" ] && tarfile="$a"; prev="$a"; done
     mkdir -p "$out"
     printf "tar-stub" > "${out}/${tarfile#/out/}"
     ;;
esac
exit 0'
}

@test "one archive is written per enumerated volume" {
    shim_baseline; shim_docker_full
    run "$BACKUP"
    local d="${GREMION_ROOT}/backups/current/volumes"
    [ -s "${d}/staging-state_pgdata.tar" ]
    [ -s "${d}/staging-state_nats.tar" ]
    [ -s "${d}/staging-mail_spool.tar" ]
    [ -s "${d}/staging_traefik_acme.tar" ]
    [ -s "${d}/staging_tenant_secrets.tar" ]
    [ -s "${d}/staging_mail_data.tar" ]
    [[ "$output" == *"archived 6 volume(s) with alpine@sha256:00000000"* ]]
}

@test "the archive container mounts each volume read-only" {
    shim_baseline; shim_docker_full
    run "$BACKUP"
    assert_recorded docker "-v staging-state_pgdata:/v:ro"
}

@test "an archive image that cannot be pulled fails the run" {
    shim_baseline; shim_docker_full
    touch "${GREMION_ROOT}/.pull-fails"
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot pull archive image alpine:3.22"* ]]
}

# ---------------------------------------------------------------------------
# Object storage buckets
# ---------------------------------------------------------------------------

@test "without MINIO_ENDPOINT the bucket class is zero and the reason is printed" {
    shim_baseline; shim_docker_full
    run "$BACKUP"
    [[ "$output" == *"MINIO_ENDPOINT unset"* ]]
    [[ "$output" == *"covered by the volume class"* ]]
    [ "$(jq -r '.artefacts.buckets' "${GREMION_ROOT}/runtime/last-backup.json")" = "0" ]
}

@test "MINIO_ENDPOINT without BACKUP_MC_IMAGE is a precondition failure (exit 2)" {
    shim_baseline; shim_docker_full
    echo 'MINIO_ENDPOINT=http://127.0.0.1:9000' >>"${GREMION_ROOT}/etc/env/state.env"
    run "$BACKUP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"MINIO_ENDPOINT is set but BACKUP_MC_IMAGE is not"* ]]
}

@test "MINIO_ENDPOINT set but no bucket found fails rather than reporting zero" {
    shim_baseline; shim_docker_full
    {
        echo 'MINIO_ENDPOINT=http://127.0.0.1:9000'
        echo 'MINIO_ACCESS_KEY=testaccess'
        echo 'MINIO_SECRET_KEY=testsecret'
        echo 'BACKUP_MC_IMAGE=minio/mc@sha256:0000000000000000000000000000000000000000000000000000000000000002'
    } >>"${GREMION_ROOT}/etc/env/state.env"
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"bucket enumeration returned nothing"* ]]
}

# ---------------------------------------------------------------------------
# etc copy + the N21 backup-key guard
# ---------------------------------------------------------------------------

plant_etc_tree() {
    mkdir -p "${GREMION_ROOT}/etc/secrets/tenants/pilot"
    echo 'platform-secret' >"${GREMION_ROOT}/etc/secrets/platform.env"
    echo 'tenant-key'      >"${GREMION_ROOT}/etc/secrets/tenants/pilot.backup-key"
    echo 'nested-key'      >"${GREMION_ROOT}/etc/secrets/tenants/pilot/rotated.backup-key"
}

# An rsync that ignores every --exclude: the guard, not rsync, is under test.
# `*backup-key` is skipped with the flags because the EXCLUDE PATTERNS are
# passed as their own argv words; without that this shim would mistake the
# first pattern for the source path and fail before the guard ever ran.
shim_rsync_ignoring_excludes() {
    shim rsync 'src=""; dst=""
for a in "$@"; do case "$a" in -*|*backup-key) ;; *) if [ -z "$src" ]; then src="$a"; else dst="$a"; fi ;; esac; done
mkdir -p "$dst"
cp -a "${src%/}/." "$dst/"'
}

shim_rsync_honouring_excludes() {
    shim rsync 'src=""; dst=""
for a in "$@"; do case "$a" in -*|--exclude|*backup-key) ;; *) if [ -z "$src" ]; then src="$a"; else dst="$a"; fi ;; esac; done
mkdir -p "$dst"
( cd "${src%/}" && find . -type f ! -name "*.backup-key" -exec cp --parents {} "$dst" \; )'
}

@test "a backup-key that reaches the staged tree fails the run (guard watched RED)" {
    shim_baseline; shim_docker_full; plant_etc_tree
    shim_rsync_ignoring_excludes
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"backup-key present in staged tree"* ]]
    [[ "$output" == *"per-tenant backup keys must never enter a backup (N21)"* ]]
}

@test "an etc tree with the keys excluded passes the guard" {
    shim_baseline; shim_docker_full; plant_etc_tree
    shim_rsync_honouring_excludes
    run "$BACKUP"
    [[ "$output" == *"no *.backup-key in the staged etc tree"* ]]
    [ -s "${GREMION_ROOT}/backups/current/etc/secrets/platform.env" ]
}

@test "the etc copy excludes backup-keys at any depth, not only directly under tenants/" {
    shim_baseline; shim_docker_full
    # `--exclude 'secrets/tenants/*.backup-key'` alone leaves nested keys in;
    # both patterns must be passed.
    run "$BACKUP"
    assert_recorded rsync "--exclude secrets/tenants/*.backup-key"
    assert_recorded rsync "--exclude *.backup-key"
}

# ---------------------------------------------------------------------------
# restic
# ---------------------------------------------------------------------------

# `.release-snap`   -> one class=snapshot snapshot exists before the forget
# `.keeps-tag`      -> the shim's forget is class-scoped and spares it
# `.snapclass-count`-> N class=snapshot snapshots exist, stable across forget
shim_restic_ok() {
    shim restic 'json_ids() { n="$1"; i=1; sep=""; printf "["
  while [ "$i" -le "$n" ]; do printf "%s{\"short_id\":\"rel%05d\"}" "$sep" "$i"; sep=","; i=$((i+1)); done
  printf "]\n"; }
case "$1" in
  snapshots)
     [ -f "$RESTIC_REPOSITORY/.inited" ] || exit 1
     case "$*" in
       *"class=snapshot"*)
          if [ -f "$GREMION_ROOT/.release-snap" ]; then
            if [ -f "$GREMION_ROOT/.forgot" ] && [ ! -f "$GREMION_ROOT/.keeps-tag" ]; then
              json_ids 0
            else
              json_ids 1
            fi
          elif [ -f "$GREMION_ROOT/.snapclass-count" ]; then
            json_ids "$(cat "$GREMION_ROOT/.snapclass-count")"
          else
            json_ids 0
          fi ;;
       *"label="*) echo "[{\"short_id\":\"aaaaaaaa\"}]" ;;
       *)          echo "[]" ;;
     esac ;;
  init)   mkdir -p "$RESTIC_REPOSITORY"; : > "$RESTIC_REPOSITORY/.inited" ;;
  forget) touch "$GREMION_ROOT/.forgot" ;;
esac
exit 0'
}

@test "the restic snapshot carries label= and class= and its presence is read back" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP" --label dist-v1.2.3 --class snapshot
    assert_recorded restic "--tag label=dist-v1.2.3"
    assert_recorded restic "--tag class=snapshot"
    [[ "$output" == *"restic snapshot present for label=dist-v1.2.3"* ]]
}

@test "class=daily forgets only class=daily, with the env retention" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP" --class daily
    assert_recorded restic "forget --tag class=daily"
    assert_recorded restic "--keep-daily 14"
    assert_recorded restic "--keep-weekly 8"
    assert_recorded restic "--keep-monthly 6"
}

@test "class=snapshot runs no forget at all" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP" --label dist-v1.2.3 --class snapshot
    ! assert_recorded restic "forget"
    [[ "$output" == *"retention untouched"* ]]
}

@test "retention that drops a release snapshot fails the run (guard watched RED)" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    touch "${GREMION_ROOT}/.release-snap"        # rel00001 exists before forget
    run "$BACKUP" --class daily                  # and the shim's forget drops it
    [ "$status" -eq 1 ]
    [[ "$output" == *"retention dropped release snapshot(s): rel00001"* ]]
}

@test "a class-scoped forget leaves release snapshots alone" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    touch "${GREMION_ROOT}/.release-snap" "${GREMION_ROOT}/.keeps-tag"
    run "$BACKUP" --class daily
    [[ "$output" == *"every class=snapshot restic snapshot survived retention"* ]]
}

@test "restic check runs with the 5% read-data subset" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP"
    assert_recorded restic "check --read-data-subset=5%"
}

# ---------------------------------------------------------------------------
# Off-site mirror (N14)
# ---------------------------------------------------------------------------

@test "the off-site copy is verified by reading the remote, not by rclone's exit code" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP"
    assert_recorded rclone "sync ${GREMION_ROOT}/backups/repo backup:gremion-test/gremion-restic"
    [[ "$output" == *"offsite copy verified at backup:gremion-test/gremion-restic"* ]]
}

@test "a sync that reports success but leaves no repository config fails the run" {
    shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    shim_df_plenty; shim_curl_ok
    shim rclone 'case "$1" in
  lsd)    exit 0 ;;
  lsjson) echo "[]" ;;
  sync)   exit 0 ;;
esac
exit 0'
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"offsite copy has no restic config object after sync"* ]]
}

# ---------------------------------------------------------------------------
# class=snapshot backlog: nothing forgets these, so say so out loud
# ---------------------------------------------------------------------------

@test "a class=snapshot backlog past the threshold names the exact forget command" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    echo 21 >"${GREMION_ROOT}/.snapclass-count"
    run "$BACKUP" --class daily
    [ "$status" -eq 0 ]
    [[ "$output" == *"BACKUP-WARN: 21 class=snapshot restic snapshots retained (threshold 20)"* ]]
    [[ "$output" == *"restic -r ${GREMION_ROOT}/backups/repo forget --tag class=snapshot --tag label=<label> --prune"* ]]
}

@test "a backlog under the threshold reports the count and does not warn" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    echo 3 >"${GREMION_ROOT}/.snapclass-count"
    run "$BACKUP" --class daily
    [ "$status" -eq 0 ]
    [[ "$output" == *"class=snapshot snapshots retained: 3 (threshold 20)"* ]]
    [[ "$output" != *"BACKUP-WARN:"* ]]
}

@test "the threshold is configurable and the warning never fails the run" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    echo 4 >"${GREMION_ROOT}/.snapclass-count"
    echo 'BACKUP_SNAPSHOT_CLASS_WARN=3' >>"${GREMION_ROOT}/etc/env/state.env"
    run "$BACKUP" --class daily
    [ "$status" -eq 0 ]
    [[ "$output" == *"BACKUP-WARN: 4 class=snapshot restic snapshots retained (threshold 3)"* ]]
}

# ---------------------------------------------------------------------------
# Report + alert
# ---------------------------------------------------------------------------

@test "a successful daily writes the full report and the daily baseline" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP" --label nightly-1
    [ "$status" -eq 0 ]
    local f="${GREMION_ROOT}/runtime/last-backup.json"
    [ "$(jq -r '.ok'                  "$f")" = "true" ]
    [ "$(jq -r '.label'               "$f")" = "nightly-1" ]
    [ "$(jq -r '.class'               "$f")" = "daily" ]
    [ "$(jq -r '.artefacts.databases' "$f")" = "5" ]
    [ "$(jq -r '.artefacts.volumes'   "$f")" = "6" ]
    [ "$(jq -r '.artefacts.buckets'   "$f")" = "0" ]
    [ "$(jq -r '.offsite'             "$f")" = "true" ]
    [ -f "${GREMION_ROOT}/runtime/last-backup-daily.json" ]
    [[ "$output" == *"BACKUP: label=nightly-1 class=daily databases=5 volumes=6 buckets=0 offsite=true ok=true"* ]]
}

@test "a failed run still writes ok:false and still alerts" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    touch "${GREMION_ROOT}/.empty-dump"
    run "$BACKUP" --label nightly-2
    [ "$status" -eq 1 ]
    [ "$(jq -r '.ok' "${GREMION_ROOT}/runtime/last-backup.json")" = "false" ]
    assert_recorded curl "https://alerts.example.org/hook"
}

@test "a failed run does not become the daily baseline" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    touch "${GREMION_ROOT}/.empty-dump"
    run "$BACKUP" --class daily
    [ ! -f "${GREMION_ROOT}/runtime/last-backup-daily.json" ]
}

@test "a class=snapshot run does not overwrite the daily baseline" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP" --class daily --label nightly-3
    run "$BACKUP" --class snapshot --label dist-v1.2.3
    [ "$(jq -r '.label' "${GREMION_ROOT}/runtime/last-backup-daily.json")" = "nightly-3" ]
    [ "$(jq -r '.label' "${GREMION_ROOT}/runtime/last-backup.json")" = "dist-v1.2.3" ]
}

@test "an undeliverable alert makes the run exit 1 even when the backup succeeded" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    shim curl 'exit 7'
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"BACKUP-ALERT: delivery failed to ALERT_WEBHOOK_URL"* ]]
    # The report itself still records the successful backup.
    [ "$(jq -r '.ok' "${GREMION_ROOT}/runtime/last-backup.json")" = "true" ]
}

# ---------------------------------------------------------------------------
# gremion-snapshot
# ---------------------------------------------------------------------------

@test "gremion-snapshot exists and is executable" {
    [ -x "$SNAPSHOT" ]
}

@test "gremion-snapshot declares its common.sh source for shellcheck" {
    grep -qF '# shellcheck source=../lib/common.sh' "$SNAPSHOT"
}

@test "gremion-snapshot requires exactly one label (exit 2)" {
    run "$SNAPSHOT"
    [ "$status" -eq 2 ]
    [[ "$output" == *"exactly one <label> argument required"* ]]
}

@test "gremion-snapshot rejects a malformed label (exit 2)" {
    run "$SNAPSHOT" 'dist v1.2.3'
    [ "$status" -eq 2 ]
    [[ "$output" == *"invalid label"* ]]
}

@test "gremion-snapshot runs gremion-backup with class snapshot and the label" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$SNAPSHOT" dist-v1.2.3
    [ "$status" -eq 0 ]
    assert_recorded restic "--tag label=dist-v1.2.3"
    assert_recorded restic "--tag class=snapshot"
    [ "$(jq -r '.class' "${GREMION_ROOT}/runtime/last-backup.json")" = "snapshot" ]
    [[ "$output" == *"SNAPSHOT: label=dist-v1.2.3 ok=true"* ]]
}

@test "gremion-snapshot without a prior daily proceeds and says the comparison was skipped" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$SNAPSHOT" dist-v1.2.3
    [ "$status" -eq 0 ]
    [[ "$output" == *"no prior daily backup: artefact-class comparison skipped"* ]]
}

@test "gremion-snapshot fails when an artefact class is below the last daily (guard watched RED)" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    # A daily that saw 6 volumes...
    run "$BACKUP" --class daily --label nightly-4
    [ "$(jq -r '.artefacts.volumes' "${GREMION_ROOT}/runtime/last-backup-daily.json")" = "6" ]
    # ...then a snapshot taken while the mail project's volumes are gone.
    shim docker 'out="$GREMION_ROOT/backups/current/volumes"
case "$1 $2" in
  "volume ls")
     case "$*" in
       *"project=staging-state"*) printf "staging-state_pgdata\n" ;;
     esac ;;
  "volume inspect") exit 0 ;;
  "image inspect") echo "alpine@sha256:0000000000000000000000000000000000000000000000000000000000000001" ;;
  "compose exec"|"compose "*)
     case "$*" in
       *count*)       printf "5\n" ;;
       *pg_database*) printf "control\ngremion\nkeycloak\npostgres\nt_pilot\n" ;;
       *pg_dump*)     printf "PGDUMP" ;;
     esac ;;
  pull*) exit 0 ;;
  run*)
     prev=""; tarfile=""
     for a in "$@"; do [ "$prev" = "-cf" ] && tarfile="$a"; prev="$a"; done
     mkdir -p "$out"; printf "tar-stub" > "${out}/${tarfile#/out/}" ;;
esac
exit 0'
    run "$SNAPSHOT" dist-v1.2.4
    [ "$status" -eq 1 ]
    [[ "$output" == *"snapshot artefact class volumes: 4 < last daily 6"* ]]
}

# ---------------------------------------------------------------------------
# systemd wiring (templates created by Task 2, rendered by its `timers` stage)
# ---------------------------------------------------------------------------

@test "gremion-backup.service is a template that runs the daily class as the deploy user" {
    local u="${UNIT_DIR}/gremion-backup.service"
    [ -f "$u" ]
    grep -qF 'Type=oneshot'                                            "$u"
    grep -qF 'User=${DEPLOY_USER}'                                     "$u"
    grep -qF 'ExecStart=${GREMION_ROOT}/bin/gremion-backup --class daily' "$u"
    grep -qF 'After=docker.service'                                    "$u"
    # No literal root may be baked in: Task 2 renders it per stack.
    ! grep -qF 'ExecStart=/opt/gremion' "$u"
}

@test "gremion-backup.service allows a run longer than the default timeout" {
    # A full run copies volumes, mirrors buckets and reads 5% of the
    # repository back; systemd's 90 s default would kill it mid-restic.
    grep -qE '^TimeoutStartSec=(6h|21600)$' "${UNIT_DIR}/gremion-backup.service"
}

@test "gremion-backup.timer is a template with the OnCalendar token" {
    local u="${UNIT_DIR}/gremion-backup.timer"
    [ -f "$u" ]
    grep -qF 'OnCalendar=${BACKUP_ONCALENDAR}' "$u"
    grep -qF 'Persistent=true'                 "$u"
    grep -qF 'Unit=gremion-backup.service'     "$u"
    grep -qF 'WantedBy=timers.target'          "$u"
}

@test "the backup service logs where the runbook and gremion-hostd look for it" {
    # Task 15's runbook and the RED drill of Step 26 both read
    # ${GREMION_ROOT}/logs/backup.log; a unit that logs only to the journal
    # makes both of them a lie.
    local u="${UNIT_DIR}/gremion-backup.service"
    grep -qF 'StandardOutput=append:${GREMION_ROOT}/logs/backup.log' "$u"
    grep -qF 'StandardError=append:${GREMION_ROOT}/logs/backup.log'  "$u"
}

@test "render_unit substitutes a staging root into both backup units" {
    # Task 2's render_unit <unit-name> <dest>, with its documented default
    # DEPLOY_USER=gremion. BACKUP_ONCALENDAR's default is Task 2's to own, so
    # it is read back from the sourced script rather than hard-coded here.
    export DEPLOY_USER=gremion-staging
    # shellcheck disable=SC1090
    source "$BOOTSTRAP"
    render_unit gremion-backup.service "${GREMION_ROOT}/gremion-backup.service"
    render_unit gremion-backup.timer   "${GREMION_ROOT}/gremion-backup.timer"
    grep -qF "ExecStart=${GREMION_ROOT}/bin/gremion-backup --class daily" \
             "${GREMION_ROOT}/gremion-backup.service"
    grep -qF "User=gremion-staging" "${GREMION_ROOT}/gremion-backup.service"
    grep -qF "StandardOutput=append:${GREMION_ROOT}/logs/backup.log" \
             "${GREMION_ROOT}/gremion-backup.service"
    grep -qF "OnCalendar=${BACKUP_ONCALENDAR}" "${GREMION_ROOT}/gremion-backup.timer"
    # Nothing unsubstituted survives in either rendered unit.
    ! grep -q '\${' "${GREMION_ROOT}/gremion-backup.service"
    ! grep -q '\${' "${GREMION_ROOT}/gremion-backup.timer"
}

@test "neither unit carries a prune" {
    # §K: no automated prune, ever. restic's own forget --prune inside
    # gremion-backup is scoped to class=daily and is not a docker prune.
    ! grep -qE 'docker (system|volume|image) prune' "${UNIT_DIR}/gremion-backup.service"
    ! grep -qE 'docker (system|volume|image) prune' "${UNIT_DIR}/gremion-backup.timer"
}

# ---------------------------------------------------------------------------
# Regressions found by the Step 25 integration run (real docker, real psql)
# ---------------------------------------------------------------------------

# The first integration run enumerated four of the five databases that existed
# on the server and still reported ok: `docker compose exec -T` had handed back
# its last name WITHOUT a trailing newline, and a plain `while read` drops an
# unterminated final line. The coverage guard could not see it, because it only
# checks the set the enumeration produced.
shim_docker_pg_no_trailing_newline() {
    shim docker 'out="$GREMION_ROOT/backups/current/volumes"
case "$1 $2" in
  "volume ls")
     case "$*" in
       *"project=staging-state"*) printf "staging-state_pgdata\nstaging-state_nats\n" ;;
       *"project=staging-mail"*)  printf "staging-mail_spool\n" ;;
     esac ;;
  "volume inspect") exit 0 ;;
  "image inspect") echo "alpine@sha256:0000000000000000000000000000000000000000000000000000000000000001" ;;
  "compose exec"|"compose "*)
     case "$*" in
       *count*)       printf "5\n" ;;
       *pg_database*) printf "control\ngremion\nkeycloak\npostgres\nt_pilot" ;;
       *pg_dump*)     printf "PGDUMP" ;;
     esac ;;
  pull*) exit 0 ;;
  run*)
     prev=""; tarfile=""
     for a in "$@"; do [ "$prev" = "-cf" ] && tarfile="$a"; prev="$a"; done
     mkdir -p "$out"; printf "tar-stub" > "${out}/${tarfile#/out/}" ;;
esac
exit 0'
}

# The same shim, but the server's own count disagrees with the names it listed:
# four names for a server that reports five databases.
shim_docker_pg_count_mismatch() {
    shim docker 'out="$GREMION_ROOT/backups/current/volumes"
case "$1 $2" in
  "volume ls")
     case "$*" in
       *"project=staging-state"*) printf "staging-state_pgdata\nstaging-state_nats\n" ;;
       *"project=staging-mail"*)  printf "staging-mail_spool\n" ;;
     esac ;;
  "volume inspect") exit 0 ;;
  "image inspect") echo "alpine@sha256:0000000000000000000000000000000000000000000000000000000000000001" ;;
  "compose exec"|"compose "*)
     case "$*" in
       *count*)       printf "5\n" ;;
       *pg_database*) printf "control\ngremion\nkeycloak\npostgres\n" ;;
       *pg_dump*)     printf "PGDUMP" ;;
     esac ;;
  pull*) exit 0 ;;
  run*)
     prev=""; tarfile=""
     for a in "$@"; do [ "$prev" = "-cf" ] && tarfile="$a"; prev="$a"; done
     mkdir -p "$out"; printf "tar-stub" > "${out}/${tarfile#/out/}" ;;
esac
exit 0'
}

@test "a name list without a trailing newline still backs up its last database" {
    shim_baseline; shim_docker_pg_no_trailing_newline
    shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP" --label trunc-1
    [ "$status" -eq 0 ]
    [[ "$output" == *"every enumerated database has a non-empty dump (5)"* ]]
    [ -s "${GREMION_ROOT}/backups/current/t_pilot.sql.gz" ]
    [ "$(jq -r '.artefacts.databases' "${GREMION_ROOT}/runtime/last-backup.json")" = "5" ]
}

@test "an enumeration shorter than the server's own count fails by number" {
    shim_baseline; shim_docker_pg_count_mismatch
    shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"database enumeration truncated: 4 name(s) for service postgres, server reports 5"* ]]
}

# The integration's RED step (off-site remote removed) exited 1, not 2: the
# undeliverable alert overwrote the precondition code. An alert that cannot be
# delivered must not hide WHY the run stopped.
@test "an undeliverable alert does not overwrite a precondition exit code" {
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    shim curl 'exit 7'
    touch "${GREMION_ROOT}/.offsite-down"
    run "$BACKUP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"offsite remote unreachable"* ]]
    [[ "$output" == *"BACKUP-ALERT: delivery failed to ALERT_WEBHOOK_URL"* ]]
}

@test "the enumerated database names are printed, not only their count" {
    # The integration run reported four databases for a server that had five.
    # A count alone cannot be triaged after the fact; the names can.
    shim_baseline; shim_docker_full; shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP"
    [[ "$output" == *"databases enumerated for postgres: control gremion keycloak postgres t_pilot"* ]]
}

# The real cause of the integration run's "databases=4 for a five-database
# server": `docker compose exec -T` forwards ITS STDIN to the container, and
# inside `while read -r db; do … done <<<"$names"` that stdin is the list of
# databases still to process. The first database that actually needed a dump
# (postgres — the kernel script had already produced the other three) swallowed
# the rest of the list, and t_pilot was never backed up. The run still reported
# ok, because every database it still knew about had a dump.
shim_docker_pg_stdin_eater() {
    shim docker 'out="$GREMION_ROOT/backups/current/volumes"
case "$1 $2" in
  "volume ls")
     case "$*" in
       *"project=staging-state"*) printf "staging-state_pgdata\nstaging-state_nats\n" ;;
       *"project=staging-mail"*)  printf "staging-mail_spool\n" ;;
     esac ;;
  "volume inspect") exit 0 ;;
  "image inspect") echo "alpine@sha256:0000000000000000000000000000000000000000000000000000000000000001" ;;
  "compose exec"|"compose "*)
     case "$*" in
       *count*)       printf "5\n" ;;
       *pg_database*) printf "control\ngremion\nkeycloak\npostgres\nt_pilot\n" ;;
       *pg_dump*)     cat >/dev/null 2>&1; printf "PGDUMP" ;;
     esac ;;
  pull*) exit 0 ;;
  run*)
     prev=""; tarfile=""
     for a in "$@"; do [ "$prev" = "-cf" ] && tarfile="$a"; prev="$a"; done
     mkdir -p "$out"; printf "tar-stub" > "${out}/${tarfile#/out/}" ;;
esac
exit 0'
}

@test "a dump that reads stdin cannot swallow the rest of the database list" {
    shim_baseline; shim_docker_pg_stdin_eater
    shim_rsync_honouring_excludes; shim_restic_ok
    run "$BACKUP" --label stdin-1
    [ "$status" -eq 0 ]
    [[ "$output" == *"every enumerated database has a non-empty dump (5)"* ]]
    [ -s "${GREMION_ROOT}/backups/current/t_pilot.sql.gz" ]
    [ "$(jq -r '.artefacts.databases' "${GREMION_ROOT}/runtime/last-backup.json")" = "5" ]
}
