#!/usr/bin/env bats
# Unit tests for infra/host/bin/gremion-restore-into.
# restic, docker and scripts/restore.sh are all shimmed: this file never
# restores anything real. The real restore is test/host/integration/restore-proof.sh.

load 'test_helper/host'

KERNEL_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
RESTORE_INTO="${KERNEL_ROOT}/infra/host/bin/gremion-restore-into"

setup() {
    setup_host_root
    write_target_env
    write_release_tree
    stub_neuter
    shim_restic_ok
    shim_docker_ok
}

teardown() {
    teardown_host_root
}

write_target_env() {
    cat >"${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=stg
COMPOSE_PROJECT_NAME=stg-state
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
PLATFORM_DOMAIN=example.org
TRAEFIK_CERT_RESOLVER=
POSTGRES_USER=postgres
CONTROL_DB_NAME=control
RESTIC_REPOSITORY=/opt/gremion/backups/repo
EOF
    chmod 600 "${GREMION_ROOT}/etc/env/state.env"
}

# A release tree whose restore.sh has the current case arms. The unreachable
# `docker compose exec -T postgres` line is the shape of the real kernel script
# (scripts/restore.sh execs its Postgres by name, twice); gremion-restore-into
# reads the SERVICE the script restores into out of that line, exactly the way
# gremion-backup reads the service its dumps came FROM out of scripts/backup.sh.
write_release_tree() {
    mkdir -p "${GREMION_ROOT}/current/scripts"
    cat >"${GREMION_ROOT}/current/scripts/restore.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
read -r CONFIRM
[[ "$CONFIRM" == "yes" ]] || exit 9
if [[ "${RESTORE_SH_NEVER:-}" == "1" ]]; then
    docker compose exec -T postgres psql -U postgres
fi
case "$1" in
    keycloak|gremion|control)
        echo "restored $1 from $2" >>"${GREMION_ROOT}/runtime/restore-sh.log"
        ;;
    *) exit 1 ;;
esac
EOF
    chmod 755 "${GREMION_ROOT}/current/scripts/restore.sh"
}

stub_neuter() {
    cat >"${GREMION_ROOT}/bin/neuter-stub" <<'EOF'
#!/usr/bin/env bash
echo "NEUTER-STUB $*" >>"${GREMION_ROOT}/runtime/neuter.log"
EOF
    chmod 755 "${GREMION_ROOT}/bin/neuter-stub"
    export NEUTER_BIN="${GREMION_ROOT}/bin/neuter-stub"
}

# restic restore materialises the REAL Task 9 layout: backups/current.
shim_restic_ok() {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
[ -n "$target" ] || exit 1
s="$target/opt/gremion/backups/current"
mkdir -p "$s/volumes" "$target/opt/gremion/etc/env"
: >"$s/control.sql.gz"
: >"$s/keycloak.sql.gz"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
printf "x" >"$s/volumes/alpha_traefik_acme.tar"
printf "x" >"$s/volumes/alpha-state_pg-data.tar"
printf "x" >"$s/volumes/alpha-state_files-data.tar"
exit 0'
}

shim_docker_ok() {
    shim docker '
args="$*"
case "$args" in
  "volume inspect stg_traefik_acme") exit 0 ;;
  *"ps -q nextcloud"*) echo cid-nc; exit 0 ;;
  *"ps -q postgres"*)  echo cid-pg; exit 0 ;;
  "exec cid-nc sha256sum /files/proof.txt")
      echo "d0be2dc421be4fcd0172e5afceea3970e2f3d940  /files/proof.txt"; exit 0 ;;
  *"FROM proof_row"*) echo ratified; exit 0 ;;
  *"find /v -type f | wc -l"*) echo 2; exit 0 ;;
  *) exit 0 ;;
esac'
}

PROOF_FILE="/files/proof.txt:d0be2dc421be4fcd0172e5afceea3970e2f3d940"
PROOF_ROW="control:SELECT v FROM proof_row WHERE k='seed':ratified"

@test "gremion-restore-into exists and is executable" {
    [ -x "$RESTORE_INTO" ]
}

@test "gremion-restore-into is strict-mode bash sourcing the host common library" {
    grep -q '^#!/usr/bin/env bash$' "$RESTORE_INTO"
    grep -q '^set -euo pipefail$' "$RESTORE_INTO"
    grep -q '\. "\$SCRIPT_DIR/\.\./lib/common\.sh"' "$RESTORE_INTO"
}

@test "gremion-restore-into carries the shellcheck source directive" {
    grep -q '^# shellcheck source=\.\./lib/common\.sh$' "$RESTORE_INTO"
}

@test "gremion-restore-into uses no forbidden compose flag" {
    run grep -nE 'docker compose (-f|-p|--profile| [^-])' "$RESTORE_INTO"
    [ "$status" -ne 0 ]
    grep -q 'docker compose --env-file' "$RESTORE_INTO"
}

@test "gremion-restore-into without arguments exits 2 with usage" {
    run "$RESTORE_INTO"
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: gremion-restore-into --stack S --snapshot ID|latest"* ]]
}

@test "gremion-restore-into demands both proof kinds" {
    run "$RESTORE_INTO" --stack stg --snapshot latest
    [ "$status" -eq 2 ]
    [[ "$output" == *"restore proof requires at least one --proof-file and one --proof-row"* ]]
}

# WATCH IT FAIL: the public-unit refusal.
@test "gremion-restore-into refuses a target with a public certificate resolver" {
    sed -i 's/^TRAEFIK_CERT_RESOLVER=$/TRAEFIK_CERT_RESOLVER=le-http/' \
        "${GREMION_ROOT}/etc/env/state.env"
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 2 ]
    [[ "$output" == *"refusing to restore into stg: TRAEFIK_CERT_RESOLVER=le-http"* ]]
}

@test "gremion-restore-into refuses a --stack that does not match STACK" {
    run "$RESTORE_INTO" --stack other --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 2 ]
    [[ "$output" == *"--stack other does not match STACK=stg"* ]]
}

# WATCH IT FAIL: a restore step that writes into etc/ must be caught.
@test "gremion-restore-into exits 1 when etc/ changed during the restore" {
    shim docker '
args="$*"
case "$args" in
  "run --rm -v"*tar*) printf "leak\n" >>"$GREMION_ROOT/etc/env/state.env"; exit 0 ;;
  "volume inspect stg_traefik_acme") exit 0 ;;
  *) exit 0 ;;
esac'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/ changed during the restore"* ]]
}

@test "gremion-restore-into runs restore.sh for every dump, confirmed, in the target project" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 0 ]
    grep -q "restored control from " "${GREMION_ROOT}/runtime/restore-sh.log"
    grep -q "restored keycloak from " "${GREMION_ROOT}/runtime/restore-sh.log"
    [[ "$output" == *"databases restored: 2"* ]]
}

@test "gremion-restore-into exits 3 when restore.sh cannot target a dump" {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
s="$target/opt/gremion/backups/current"
mkdir -p "$s/volumes" "$target/opt/gremion/etc/env"
: >"$s/t_pilot.sql.gz"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
printf "x" >"$s/volumes/alpha_traefik_acme.tar"
exit 0'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: restore.sh cannot target 't_pilot'"* ]]
}

@test "gremion-restore-into renames every volume into the target stack and skips the database volume" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 0 ]
    assert_recorded docker "volume create stg_traefik_acme"
    assert_recorded docker "volume create stg-state_files-data"
    [[ "$output" == *"SKIP volume alpha-state_pg-data"* ]]
    [[ "$output" == *"volumes restored: 2 (1 skipped)"* ]]
    # the source stack's names never reach docker, and the pg data dir is not written
    run grep -c "volume create alpha" "$SHIM_LOG"
    [ "$status" -ne 0 ]
    run grep -c "volume create stg-state_pg-data" "$SHIM_LOG"
    [ "$status" -ne 0 ]
}

@test "gremion-restore-into exits 3 when a snapshot carries buckets without a pinned mc image" {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
s="$target/opt/gremion/backups/current"
mkdir -p "$s/volumes" "$s/buckets/nextcloud" "$target/opt/gremion/etc/env"
: >"$s/control.sql.gz"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
printf "x" >"$s/volumes/alpha_traefik_acme.tar"
exit 0'
    run env MC_IMAGE= "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: bucket restore needs MC_IMAGE"* ]]
}

# The flat disaster-recovery layout stays supported.
@test "gremion-restore-into also finds the flat backups tree" {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
s="$target/opt/gremion/backups"
mkdir -p "$s/volumes" "$target/opt/gremion/etc/env"
: >"$s/control.sql.gz"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
printf "x" >"$s/volumes/alpha_traefik_acme.tar"
exit 0'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 0 ]
    [[ "$output" == *"databases restored: 1"* ]]
}

# WATCH IT FAIL: a stale flat tree beside the staged one must not win.
@test "gremion-restore-into prefers the deepest backups tree when both layouts are present" {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
old="$target/opt/gremion/backups"
new="$target/opt/gremion/backups/current"
mkdir -p "$old/volumes" "$new/volumes" "$target/opt/gremion/etc/env"
: >"$old/gremion.sql.gz"
printf "x" >"$old/volumes/alpha_traefik_acme.tar"
: >"$new/control.sql.gz"
: >"$new/keycloak.sql.gz"
printf "x" >"$new/volumes/alpha_traefik_acme.tar"
printf "x" >"$new/volumes/alpha-state_files-data.tar"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
exit 0'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 0 ]
    [[ "$output" == *"databases restored: 2"* ]]
    grep -q "restored keycloak from " "${GREMION_ROOT}/runtime/restore-sh.log"
    run grep -c "restored gremion from " "${GREMION_ROOT}/runtime/restore-sh.log"
    [ "$status" -ne 0 ]
}

# Task 9 stages a NON-kernel dump as <service>__<database>.sql.gz, split at the
# FIRST '__'. A dump of the service restore.sh itself restores into is restorable
# under its database name — the case gremion-backup's header calls out, where the
# kernel script did not write a dump it enumerated.
@test "gremion-restore-into splits a service__database staged name at the first __" {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
s="$target/opt/gremion/backups/current"
mkdir -p "$s/volumes" "$target/opt/gremion/etc/env"
: >"$s/postgres__control.sql.gz"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
printf "x" >"$s/volumes/alpha_traefik_acme.tar"
exit 0'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 0 ]
    [[ "$output" == *"postgres__control.sql.gz -> service postgres database control"* ]]
    grep -q "restored control from " "${GREMION_ROOT}/runtime/restore-sh.log"
    [[ "$output" == *"databases restored: 1"* ]]
}

# WATCH IT FAIL: a dump taken from a SECOND Postgres server cannot be addressed
# by a restore.sh that restores into one fixed compose service.
@test "gremion-restore-into exits 3 for a dump from a Postgres service restore.sh cannot address" {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
s="$target/opt/gremion/backups/current"
mkdir -p "$s/volumes" "$target/opt/gremion/etc/env"
: >"$s/analytics__control.sql.gz"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
printf "x" >"$s/volumes/alpha_traefik_acme.tar"
exit 0'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: restore.sh cannot target 'control'"* ]]
    [[ "$output" == *"compose service 'analytics'"* ]]
    [ ! -f "${GREMION_ROOT}/runtime/restore-sh.log" ]
}

# WATCH IT FAIL: the exact shape Task 9's round-5 finding was about — ONE
# database name present on TWO Postgres servers. Keyed on the database name
# alone the two dumps collapse onto one target and one server's data is lost
# without a word; here each stays its own (service, database) pair.
@test "gremion-restore-into keeps two same-named databases from different services distinct" {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
s="$target/opt/gremion/backups/current"
mkdir -p "$s/volumes" "$target/opt/gremion/etc/env"
: >"$s/postgres__shared.sql.gz"
: >"$s/analytics__shared.sql.gz"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
printf "x" >"$s/volumes/alpha_traefik_acme.tar"
exit 0'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 3 ]
    [[ "$output" == *"postgres__shared.sql.gz -> service postgres database shared"* ]]
    [[ "$output" == *"analytics__shared.sql.gz -> service analytics database shared"* ]]
    [ ! -f "${GREMION_ROOT}/runtime/restore-sh.log" ]
}

# WATCH IT FAIL: every dump name is resolved and checked BEFORE the first one is
# restored, so a snapshot that cannot be fully restored leaves the target
# untouched rather than half-restored.
@test "gremion-restore-into restores nothing when a later dump is unaddressable" {
    shim restic '
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
s="$target/opt/gremion/backups/current"
mkdir -p "$s/volumes" "$target/opt/gremion/etc/env"
: >"$s/control.sql.gz"
: >"$s/zz_unsupported.sql.gz"
printf "STACK=alpha\n" >"$target/opt/gremion/etc/env/state.env"
printf "x" >"$s/volumes/alpha_traefik_acme.tar"
exit 0'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: restore.sh cannot target 'zz_unsupported'"* ]]
    [ ! -f "${GREMION_ROOT}/runtime/restore-sh.log" ]
}

@test "gremion-restore-into neuters the target before it proves anything" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 0 ]
    grep -q -- "NEUTER-STUB --stack stg --root ${GREMION_ROOT}" "${GREMION_ROOT}/runtime/neuter.log"
}

@test "gremion-restore-into asserts the file checksum, the row and the ACME volume" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 0 ]
    assert_recorded docker "exec cid-nc sha256sum /files/proof.txt"
    assert_recorded docker "volume inspect stg_traefik_acme"
    [[ "$output" == *"PROOF-FILE /files/proof.txt"* ]]
    [[ "$output" == *"PROOF-ROW control ratified"* ]]
    [[ "$output" == *"PROOF-ACME stg_traefik_acme carries 2 file(s)"* ]]
    [[ "$output" == *"RESTORE-PROOF: stack=stg snapshot=latest databases=2 volumes=2 buckets=0 files=1 rows=1 acme=present"* ]]
}

# The keyed grammar must carry a cast through untouched.
@test "gremion-restore-into accepts a keyed --proof-row whose SQL carries a cast" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" \
        --proof-row db=control "sql=SELECT v::text FROM proof_row WHERE k='seed'" want=ratified
    [ "$status" -eq 0 ]
    assert_recorded docker "SELECT v::text FROM proof_row"
    [[ "$output" == *"PROOF-ROW control ratified"* ]]
}

# WATCH IT FAIL: the colon form must REFUSE a cast rather than truncate it.
@test "gremion-restore-into refuses a colon-form --proof-row carrying a cast" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" \
        --proof-row "control:SELECT v::text FROM proof_row WHERE k='seed':ratified"
    [ "$status" -eq 2 ]
    [[ "$output" == *"contains '::'"* ]]
    [[ "$output" == *"--proof-row db=<db> sql=<sql> want=<v>"* ]]
}

# WATCH IT FAIL: a wrong checksum must fail the restore proof.
@test "gremion-restore-into exits 1 on a proof-file mismatch" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "/files/proof.txt:0000000000000000000000000000000000000000" \
        --proof-row "$PROOF_ROW"
    [ "$status" -eq 1 ]
    [[ "$output" == *"PROOF-FILE mismatch /files/proof.txt"* ]]
}

# WATCH IT FAIL: a wrong row value must fail the restore proof.
@test "gremion-restore-into exits 1 on a proof-row mismatch" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" \
        --proof-row "control:SELECT v FROM proof_row WHERE k='seed':rejected"
    [ "$status" -eq 1 ]
    [[ "$output" == *"PROOF-ROW mismatch control"* ]]
}

# WATCH IT FAIL: an empty ACME volume is not a restored ACME volume.
@test "gremion-restore-into exits 1 when the ACME volume restored empty" {
    shim docker '
args="$*"
case "$args" in
  "volume inspect stg_traefik_acme") exit 0 ;;
  *"ps -q nextcloud"*) echo cid-nc; exit 0 ;;
  *"ps -q postgres"*)  echo cid-pg; exit 0 ;;
  "exec cid-nc sha256sum /files/proof.txt")
      echo "d0be2dc421be4fcd0172e5afceea3970e2f3d940  /files/proof.txt"; exit 0 ;;
  *"FROM proof_row"*) echo ratified; exit 0 ;;
  *"find /v -type f | wc -l"*) echo 0; exit 0 ;;
  *) exit 0 ;;
esac'
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 1 ]
    [[ "$output" == *"ACME volume stg_traefik_acme restored empty"* ]]
}

@test "gremion-restore-into prints RTO-SECONDS and writes runtime/last-restore.json" {
    run "$RESTORE_INTO" --stack stg --snapshot latest --rto \
        --proof-file "$PROOF_FILE" --proof-row "$PROOF_ROW"
    [ "$status" -eq 0 ]
    [[ "$output" =~ RTO-SECONDS=[0-9]+ ]]
    run cat "${GREMION_ROOT}/runtime/last-restore.json"
    [[ "$output" == *'"ok":true'* ]]
    [[ "$output" == *'"stack":"stg"'* ]]
    [[ "$output" == *'"srcStack":"alpha"'* ]]
    [[ "$output" == *'"databases":2,"volumes":2,"volumesSkipped":1,"buckets":0'* ]]
    [[ "$output" == *'"acme":true'* ]]
}

@test "gremion-restore-into records a failed run in runtime/last-restore.json" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "/files/proof.txt:0000000000000000000000000000000000000000" \
        --proof-row "$PROOF_ROW"
    [ "$status" -eq 1 ]
    run cat "${GREMION_ROOT}/runtime/last-restore.json"
    [[ "$output" == *'"ok":false'* ]]
    [[ "$output" == *'"exit":1'* ]]
}

# WATCH IT FAIL: the colon form cannot tell a MISSING expected value from a cast.
# `control:SELECT v::text` splits into sql='SELECT v:' and want='text' — a proof
# against an expectation nobody wrote, which the `rest != want` check cannot see.
# Refusing every '::' spec is the only split-safe rule.
@test "gremion-restore-into refuses a colon-form --proof-row whose cast hides a missing expected value" {
    run "$RESTORE_INTO" --stack stg --snapshot latest \
        --proof-file "$PROOF_FILE" --proof-row "control:SELECT v::text"
    [ "$status" -eq 2 ]
    [[ "$output" == *"contains '::'"* ]]
}
