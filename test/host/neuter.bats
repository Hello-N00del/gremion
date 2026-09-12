#!/usr/bin/env bats
# Unit tests for infra/host/bin/gremion-neuter.
# No real docker: every docker call goes through the recording shim of
# test/host/test_helper/host.bash.

load 'test_helper/host'

KERNEL_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
NEUTER="${KERNEL_ROOT}/infra/host/bin/gremion-neuter"

setup() {
    setup_host_root
    write_state_env
    write_app_env
    write_release_tree
    # Every test runs from a cwd that carries NO docker-compose.yml. The bats
    # runner's own cwd is the kernel repo root, which DOES carry one, and that
    # is exactly what hid the cwd dependency of the recreate call from this
    # suite: compose resolves the RELATIVE COMPOSE_FILE the rendered env files
    # ship against its OWN cwd, so a call made from the caller's cwd quietly
    # used whatever composition happened to sit there. '/' is used rather than a
    # directory under $GREMION_ROOT so teardown never removes the cwd.
    cd /
}

teardown() {
    teardown_host_root
}

# A state env with one live mail host, one token and one webhook.
write_state_env() {
    cat >"${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=stg
COMPOSE_PROJECT_NAME=stg-state
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
PLATFORM_DOMAIN=example.org
TRAEFIK_CERT_RESOLVER=
POSTGRES_USER=postgres
CONTROL_DB_NAME=control
KEYCLOAK_SMTP_HOST=mail.example.org
KEYCLOAK_SMTP_PORT=587
NEXTCLOUD_MAIL_RELAY=smtp://mail.example.org:465
INSTAGRAM_ACCESS_TOKEN=IGQVJreal
ALERT_WEBHOOK_URL=https://hooks.example.org/abc
EMAIL_HOST_PASSWORD=hunter2
EOF
    chmod 600 "${GREMION_ROOT}/etc/env/state.env"
}

write_app_env() {
    cat >"${GREMION_ROOT}/etc/env/app-blue.env" <<'EOF'
STACK=stg
COLOUR=blue
COMPOSE_PROJECT_NAME=stg-app-blue
COMPOSE_FILE=docker-compose.app.yml:docker-compose.pins.yml
SMTP_HOST=mail.example.org
SMTP_PORT=587
EOF
    chmod 600 "${GREMION_ROOT}/etc/env/app-blue.env"
    echo none >"${GREMION_ROOT}/runtime/active-colour"
}

# A release tree carrying the compositions the rendered env files name by
# RELATIVE path (infra/host/templates/env/state.env.tmpl ships
# COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml). Each file carries a
# marker so a test can tell WHICH docker-compose.yml compose actually resolved.
write_release_tree() {
    mkdir -p "${GREMION_ROOT}/current"
    echo '# marker=release'      >"${GREMION_ROOT}/current/docker-compose.yml"
    echo '# marker=release-prod' >"${GREMION_ROOT}/current/docker-compose.prod.yml"
    echo '# marker=release-app'  >"${GREMION_ROOT}/current/docker-compose.app.yml"
    echo '# marker=release-pins' >"${GREMION_ROOT}/current/docker-compose.pins.yml"
}

# A docker shim with nothing live: exercises the argument and file paths.
shim_docker_empty() {
    shim docker '
args="$*"
case "$args" in
  *"{{.Names}}"*) exit 0 ;;
  *"{{.ID}}"*)    echo "cid1 stg-state postgres"; exit 0 ;;
  "inspect -f {{.State.Running}} stg-null-sink")
      if [ -f "$GREMION_ROOT/runtime/.sink-started" ]; then echo true; exit 0; fi
      exit 1 ;;
  "run -d --name stg-null-sink"*)
      : >"$GREMION_ROOT/runtime/.sink-started"; echo cid-sink; exit 0 ;;
  "exec cid1 env") echo "PATH=/usr/bin"; echo "POSTGRES_USER=postgres"; exit 0 ;;
  *"ps -q postgres"*) echo cid1 ; exit 0 ;;
  *to_regclass*) echo f; exit 0 ;;
  *) exit 0 ;;
esac'
}

@test "gremion-neuter exists and is executable" {
    [ -x "$NEUTER" ]
}

@test "gremion-neuter is strict-mode bash sourcing the host common library" {
    grep -q '^#!/usr/bin/env bash$' "$NEUTER"
    grep -q '^set -euo pipefail$' "$NEUTER"
    grep -q '\. "\$SCRIPT_DIR/\.\./lib/common\.sh"' "$NEUTER"
}

# Task 14's guard requires the bare directive on its own line, with no
# 'disable=' suffix. Assert it here so the guard cannot be the first to find out.
@test "gremion-neuter carries the shellcheck source directive" {
    grep -q '^# shellcheck source=\.\./lib/common\.sh$' "$NEUTER"
}

@test "gremion-neuter uses no forbidden compose flag" {
    run grep -nE 'docker compose (-f|-p|--profile| [^-])' "$NEUTER"
    [ "$status" -ne 0 ]
    grep -q 'docker compose --env-file' "$NEUTER"
}

@test "gremion-neuter without --stack exits 2 with usage" {
    run "$NEUTER"
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: gremion-neuter --stack S"* ]]
    # the release tree every compose call is made from is operator-visible
    [[ "$output" == *"--release DIR"* ]]
}

@test "gremion-neuter refuses a --stack that does not match STACK in state.env" {
    shim_docker_empty
    run "$NEUTER" --stack other
    [ "$status" -eq 2 ]
    [[ "$output" == *"--stack other does not match STACK=stg"* ]]
}

@test "gremion-neuter refuses to run while a mail container is up" {
    shim docker '
args="$*"
case "$args" in
  *"{{.Names}}"*) echo "stg-mail stg-mail-stalwart-1"; exit 0 ;;
  *) exit 0 ;;
esac'
    run "$NEUTER" --stack stg
    [ "$status" -eq 1 ]
    [[ "$output" == *"refusing to neuter while the mail project is up"* ]]
}

@test "gremion-neuter rewrites every SMTP host, token and webhook in every env file" {
    shim_docker_empty
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    grep -q '^KEYCLOAK_SMTP_HOST=null-sink$'   "${GREMION_ROOT}/etc/env/state.env"
    grep -q '^KEYCLOAK_SMTP_PORT=1025$'        "${GREMION_ROOT}/etc/env/state.env"
    grep -q '^NEXTCLOUD_MAIL_RELAY=null-sink$' "${GREMION_ROOT}/etc/env/state.env"
    grep -q '^INSTAGRAM_ACCESS_TOKEN=$'        "${GREMION_ROOT}/etc/env/state.env"
    grep -q '^ALERT_WEBHOOK_URL=$'             "${GREMION_ROOT}/etc/env/state.env"
    grep -q '^EMAIL_HOST_PASSWORD=$'           "${GREMION_ROOT}/etc/env/state.env"
    grep -q '^SMTP_HOST=null-sink$'            "${GREMION_ROOT}/etc/env/app-blue.env"
    # non-mail keys are untouched
    grep -q '^PLATFORM_DOMAIN=example.org$'    "${GREMION_ROOT}/etc/env/state.env"
    grep -q '^POSTGRES_USER=postgres$'         "${GREMION_ROOT}/etc/env/state.env"
}

@test "gremion-neuter starts the null sink on the state network with the alias" {
    shim_docker_empty
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    assert_recorded docker "run -d --name stg-null-sink"
    assert_recorded docker "--network stg_state"
    assert_recorded docker "--network-alias null-sink"
}

# A shim with one live ui container and a postgres container: the full path
# through recreate → configs → rows → assert. Every `inspect -f {{.State.Running}}`
# of a service container answers `true`, so wait_running never spins.
shim_docker_live() {
    cat >"${GREMION_ROOT}/runtime/.ui-env" <<'EOF'
PATH=/usr/bin
SMTP_HOST=mail.example.org
INSTAGRAM_ACCESS_TOKEN=IGQVJreal
EOF
    shim docker '
args="$*"
clean="$GREMION_ROOT/runtime/.cleaned"
case "$args" in
  *"{{.Names}}"*) exit 0 ;;
  *"{{.ID}}"*)
      echo "cid-ui stg-app-blue gremion-ui"
      echo "cid-pg stg-state postgres"
      exit 0 ;;
  "inspect -f {{.State.Running}} stg-null-sink")
      if [ -f "$GREMION_ROOT/runtime/.sink-started" ]; then echo true; exit 0; fi
      exit 1 ;;
  "run -d --name stg-null-sink"*)
      : >"$GREMION_ROOT/runtime/.sink-started"; echo cid-sink; exit 0 ;;
  "inspect -f {{.State.Running}} cid-ui") echo true; exit 0 ;;
  "exec cid-ui env")
      if [ -f "$clean" ]; then echo "PATH=/usr/bin"; echo "SMTP_HOST=null-sink"; echo "INSTAGRAM_ACCESS_TOKEN="; exit 0; fi
      cat "$GREMION_ROOT/runtime/.ui-env"; exit 0 ;;
  "exec cid-pg env") echo "PATH=/usr/bin"; exit 0 ;;
  *"up -d --force-recreate"*)
      # Modelled on the real compose (v5.5.1, verified on this box): the
      # RELATIVE COMPOSE_FILE of the rendered env files is resolved against
      # compose own cwd, so from a cwd without that file the recreate exits 1
      # and recreates nothing, and from a cwd holding a DIFFERENT one it would
      # recreate from the wrong composition under the right project name. The
      # shim records the cwd and the marker of the file it resolved.
      if [ ! -f docker-compose.yml ]; then
        echo "compose file \"docker-compose.yml\" set by COMPOSE_FILE environment variable is invalid: stat docker-compose.yml: cannot find the file" >&2
        exit 1
      fi
      echo "$PWD $(sed -n "s/^# marker=//p" docker-compose.yml)" \
        >>"$GREMION_ROOT/runtime/.recreate-cwd"
      : >"$clean"; exit 0 ;;
  *"ps -q gremion-ui"*) echo cid-ui; exit 0 ;;
  *"ps -q postgres"*)   echo cid-pg; exit 0 ;;
  *"node -"*) cat >/dev/null; echo "changed=2 live=0"; exit 0 ;;
  *to_regclass*) echo t; exit 0 ;;
  # the rewrite asks the server for its own row count and gets it: this
  # fixture has no tenant row carrying a live host, so the answer is 0.
  *"UPDATE tenant"*) echo 0; exit 0 ;;
  *"SELECT count(*) FROM tenant"*) echo 0; exit 0 ;;
  *) exit 0 ;;
esac'
}

# A shim whose minio-mc image ships no `env` binary.
shim_docker_exempt() {
    shim docker '
args="$*"
case "$args" in
  *"{{.Names}}"*) exit 0 ;;
  *"{{.ID}}"*)
      echo "cid-mc stg-state minio-mc"
      echo "cid-pg stg-state postgres"
      exit 0 ;;
  "inspect -f {{.State.Running}} stg-null-sink")
      if [ -f "$GREMION_ROOT/runtime/.sink-started" ]; then echo true; exit 0; fi
      exit 1 ;;
  "run -d --name stg-null-sink"*)
      : >"$GREMION_ROOT/runtime/.sink-started"; echo cid-sink; exit 0 ;;
  "exec cid-mc env") echo "exec: env: not found" >&2; exit 127 ;;
  *Config.Env*cid-mc) echo "PATH=/usr/bin"; echo "MC_HOST_local=http://minio:9000"; exit 0 ;;
  "exec cid-pg env") echo "PATH=/usr/bin"; exit 0 ;;
  *"ps -q postgres"*) echo cid-pg; exit 0 ;;
  *to_regclass*) echo f; exit 0 ;;
  *) exit 0 ;;
esac'
}

@test "gremion-neuter recreates only the services whose running env was live" {
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    shim_docker_live
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    assert_recorded docker "--env-file ${GREMION_ROOT}/etc/env/app-blue.env up -d --force-recreate gremion-ui"
    run grep -c "force-recreate" "$SHIM_LOG"
    [ "$output" -eq 1 ]
}

@test "gremion-neuter rewrites the restored tenant config files through gremion-ui" {
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    shim_docker_live
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    assert_recorded docker "-e NEUTER_SINK_HOST=null-sink"
    assert_recorded docker "cid-ui node -"
    [[ "$output" == *"tenant config files rewritten: 2"* ]]
}

@test "gremion-neuter rewrites the control registry SMTP host" {
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    shim_docker_live
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    assert_recorded docker "UPDATE tenant SET domain_profile = jsonb_set"
    assert_recorded docker "SELECT count(*) FROM tenant"
}

@test "gremion-neuter prints its proof line" {
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    shim_docker_live
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    [[ "$output" == *"NEUTER: env-files=2 changed=2 configs=2 rows=0 containers=2 ok"* ]]
}

# The exec-exempt fallback must be TAKEN and ANNOUNCED, not merely declared.
@test "gremion-neuter falls back to docker inspect for a declared exempt service and says so" {
    shim_docker_exempt
    export NEUTER_EXEC_EXEMPT="minio-mc"
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARN inspect-fallback for minio-mc"* ]]
    assert_recorded docker "{{range .Config.Env}}"
    [[ "$output" == *"NEUTER: env-files=2 changed=2 configs=0 rows=0 containers=2 ok"* ]]
}

# WATCH IT FAIL: an UNdeclared service that cannot be read is a hard failure,
# never an empty env silently treated as clean.
@test "gremion-neuter exits 1 when an undeclared service cannot be read with docker exec env" {
    shim_docker_exempt
    run "$NEUTER" --stack stg
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot read env from minio-mc"* ]]
}

# WATCH IT FAIL: the env assert must reject a container that still names the
# real mail host after the rewrite and the recreate.
@test "gremion-neuter exits 1 when a container still names the live mail host" {
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    shim docker '
args="$*"
case "$args" in
  *"{{.Names}}"*) exit 0 ;;
  *"{{.ID}}"*) echo "cid-ui stg-app-blue gremion-ui"; exit 0 ;;
  "inspect -f {{.State.Running}} stg-null-sink")
      if [ -f "$GREMION_ROOT/runtime/.sink-started" ]; then echo true; exit 0; fi
      exit 1 ;;
  "run -d --name stg-null-sink"*)
      : >"$GREMION_ROOT/runtime/.sink-started"; echo cid-sink; exit 0 ;;
  "inspect -f {{.State.Running}} cid-ui") echo true; exit 0 ;;
  "exec cid-ui env") echo "SMTP_HOST=mail.example.org"; exit 0 ;;
  *"ps -q gremion-ui"*) echo cid-ui; exit 0 ;;
  *"ps -q postgres"*) echo cid-pg; exit 0 ;;
  *"node -"*) cat >/dev/null; echo "changed=0 live=0"; exit 0 ;;
  *to_regclass*) echo f; exit 0 ;;
  *) exit 0 ;;
esac'
    run "$NEUTER" --stack stg
    [ "$status" -eq 1 ]
    [[ "$output" == *"gremion-ui: SMTP_HOST still names mail.example.org"* ]]
    [[ "$output" == *"live mail/token value(s) survive neutering"* ]]
}

@test "gremion-neuter exits 1 when the tenant config read-back still shows a live host" {
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    shim docker '
args="$*"
case "$args" in
  *"{{.Names}}"*) exit 0 ;;
  *"{{.ID}}"*) echo "cid-ui stg-app-blue gremion-ui"; exit 0 ;;
  "inspect -f {{.State.Running}} stg-null-sink")
      if [ -f "$GREMION_ROOT/runtime/.sink-started" ]; then echo true; exit 0; fi
      exit 1 ;;
  "run -d --name stg-null-sink"*)
      : >"$GREMION_ROOT/runtime/.sink-started"; echo cid-sink; exit 0 ;;
  "inspect -f {{.State.Running}} cid-ui") echo true; exit 0 ;;
  "exec cid-ui env") echo "PATH=/usr/bin"; exit 0 ;;
  *"ps -q gremion-ui"*) echo cid-ui; exit 0 ;;
  *"node -"*) cat >/dev/null; echo "changed=1 live=3"; exit 0 ;;
  *) exit 0 ;;
esac'
    run "$NEUTER" --stack stg
    [ "$status" -eq 1 ]
    [[ "$output" == *"3 tenant config file(s) still name a live SMTP host"* ]]
}

# --- review round 2: the rewritten-row count must be the REAL count ----------
#
# `psql -q` suppresses the "UPDATE n" completion tag entirely, so a program that
# parses that tag reports 0 after genuinely rewriting rows. This shim behaves
# like the real psql: a bare UPDATE prints NOTHING, and only a query that asks
# the server for its own row count sees the number. The count the shim serves
# lives in runtime/.rowcount so one shim can drive both the happy path and the
# unreadable-count guard.
shim_docker_rows() {
    shim docker '
args="$*"
sql=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-c" ]; then sql="$a"; fi
  prev="$a"
done
case "$args" in
  *"{{.Names}}"*) exit 0 ;;
  *"{{.ID}}"*) echo "cid-pg stg-state postgres"; exit 0 ;;
  "inspect -f {{.State.Running}} stg-null-sink")
      if [ -f "$GREMION_ROOT/runtime/.sink-started" ]; then echo true; exit 0; fi
      exit 1 ;;
  "run -d --name stg-null-sink"*)
      : >"$GREMION_ROOT/runtime/.sink-started"; echo cid-sink; exit 0 ;;
  "exec cid-pg env") echo "PATH=/usr/bin"; exit 0 ;;
  *"ps -q postgres"*) echo cid-pg; exit 0 ;;
esac
case "$sql" in
  *to_regclass*)            echo t; exit 0 ;;
  UPDATE*)                  exit 0 ;;
  WITH*RETURNING*count*)    cat "$GREMION_ROOT/runtime/.rowcount"; exit 0 ;;
  *"count(*) FROM tenant"*) echo 0; exit 0 ;;
esac
exit 0'
}

@test "gremion-neuter reports the real number of registry rows it rewrote" {
    echo 6 >"${GREMION_ROOT}/runtime/.rowcount"
    shim_docker_rows
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    [[ "$output" == *"control registry rows rewritten: 6"* ]]
    [[ "$output" == *"NEUTER: env-files=2 changed=2 configs=0 rows=6 containers=1 ok"* ]]
    # the count is asked of the server; psql -q never prints the "UPDATE n" tag
    assert_recorded docker "RETURNING"
}

# WATCH IT FAIL: a count that cannot be read is a hard failure, never a silent
# 0 — a restore proof that reports rows=0 after rewriting rows is a lie.
@test "gremion-neuter exits 1 when the rewritten-row count cannot be read" {
    printf 'ERROR:  relation "tenant" does not exist\n' >"${GREMION_ROOT}/runtime/.rowcount"
    shim_docker_rows
    run "$NEUTER" --stack stg
    [ "$status" -eq 1 ]
    [[ "$output" == *"unreadable rewritten-row count"* ]]
}

# ── the release tree every compose call is made from (fix round 3) ─────────
# The rendered env files carry a RELATIVE COMPOSE_FILE
# (infra/host/templates/env/state.env.tmpl:22, app.env.tmpl:18), so every
# compose call has to be made FROM the release tree — the convention every
# sibling host program already follows (gremion-deploy's compose(),
# gremion-backup, gremion-render, gremion-mail-bringup).

# WATCH IT FAIL: run from the caller's cwd, the one MUTATING compose call of
# this unit exits 1 with compose's own "cannot find the file" — and it does so
# AFTER neuter_env_files has already rewritten etc/env/*.env, i.e. it leaves a
# half-neutered instance behind.
@test "gremion-neuter recreates from the release tree so the relative COMPOSE_FILE resolves" {
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    shim_docker_live
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    assert_recorded docker "--env-file ${GREMION_ROOT}/etc/env/app-blue.env up -d --force-recreate gremion-ui"
    # the cwd and the composition compose really resolved, from the shim record
    run cat "${GREMION_ROOT}/runtime/.recreate-cwd"
    [ "$output" = "${GREMION_ROOT}/current release" ]
}

# WATCH IT FAIL: the silent half of the same defect. A cwd that happens to hold
# ANOTHER docker-compose.yml (another release tree, the repo root) does not fail
# — it recreates services from the wrong composition under the right project
# name, which no exit code can reveal.
@test "gremion-neuter ignores a docker-compose.yml in the caller's cwd" {
    echo blue >"${GREMION_ROOT}/runtime/active-colour"
    mkdir -p "${GREMION_ROOT}/decoy"
    printf '# marker=decoy\n' >"${GREMION_ROOT}/decoy/docker-compose.yml"
    shim_docker_live
    cd "${GREMION_ROOT}/decoy"
    run "$NEUTER" --stack stg --release "${GREMION_ROOT}/current"
    [ "$status" -eq 0 ]
    run cat "${GREMION_ROOT}/runtime/.recreate-cwd"
    [ "$output" = "${GREMION_ROOT}/current release" ]
    [[ "$output" != *decoy* ]]
}

# WATCH IT FAIL: a release tree that is not there is a precondition failure
# BEFORE the first mutation, not a compose error after the env files are gone.
@test "gremion-neuter refuses before it rewrites anything when the release tree is absent" {
    local before after
    shim_docker_empty
    before="$(sha256sum <"${GREMION_ROOT}/etc/env/state.env")"
    run "$NEUTER" --stack stg --release "${GREMION_ROOT}/no-such-release"
    [ "$status" -eq 2 ]
    [[ "$output" == *"release tree absent: ${GREMION_ROOT}/no-such-release"* ]]
    after="$(sha256sum <"${GREMION_ROOT}/etc/env/state.env")"
    [ "$before" = "$after" ]
    grep -q '^KEYCLOAK_SMTP_HOST=mail.example.org$' "${GREMION_ROOT}/etc/env/state.env"
    refute_recorded docker "force-recreate"
}

# ---------------------------------------------------------------------------
# Round-4 finding: ONE definition of "live", shared by the file rewrite, the
# recreate decision and the post-condition.
#
# rewrite_env_stream retargets an SMTP host/port key by NAME
# (NEUTER_HOST_KEYS_RE, NEUTER_PORT_KEYS_RE) whatever its value is. The
# recreate decision (env_line_is_live, via find_affected) and the documented
# post-condition (assert_env_clean) used to ask a NARROWER question — does the
# VALUE contain mail.${PLATFORM_DOMAIN}, or is the key a token key — so a
# running container whose SMTP_HOST/EMAIL_HOST/SMTP_SERVER held anything else
# (an internal service name, a raw IP, a third-party relay) was never selected
# for recreation and never flagged as an offender, while its env file had been
# rewritten to the null sink underneath it: the program printed
# "docker exec env clean" and "NEUTER: ... ok" while the container kept
# relaying through the real host from memory. Task 1's own
# infra/host/templates/env/ops.env.tmpl ships exactly such a pair
# (ALERT_SMTP_HOST=<the operator's relay>, ALERT_SMTP_PORT=587).

# One ui container whose live mail values never name mail.example.org: a
# third-party relay host and a submission port. The recreate picks up the
# rewritten env file, so after it the container carries the sink.
shim_docker_relay() {
    shim docker '
args="$*"
clean="$GREMION_ROOT/runtime/.cleaned"
case "$args" in
  *"{{.Names}}"*) exit 0 ;;
  *"{{.ID}}"*)
      echo "cid-ui stg-app-blue gremion-ui"
      echo "cid-pg stg-state postgres"
      exit 0 ;;
  "inspect -f {{.State.Running}} stg-null-sink")
      if [ -f "$GREMION_ROOT/runtime/.sink-started" ]; then echo true; exit 0; fi
      exit 1 ;;
  "run -d --name stg-null-sink"*)
      : >"$GREMION_ROOT/runtime/.sink-started"; echo cid-sink; exit 0 ;;
  "inspect -f {{.State.Running}} cid-ui") echo true; exit 0 ;;
  "exec cid-ui env")
      echo "PATH=/usr/bin"
      if [ -f "$clean" ]; then
        echo "ALERT_SMTP_HOST=null-sink"; echo "ALERT_SMTP_PORT=1025"; exit 0
      fi
      echo "ALERT_SMTP_HOST=relay.mailprovider.example.net"
      echo "ALERT_SMTP_PORT=587"
      exit 0 ;;
  "exec cid-pg env") echo "PATH=/usr/bin"; exit 0 ;;
  *"up -d --force-recreate"*)
      if [ ! -f docker-compose.yml ]; then
        echo "COMPOSE_FILE is invalid from this cwd" >&2; exit 1
      fi
      : >"$clean"; exit 0 ;;
  *"ps -q gremion-ui"*) echo cid-ui; exit 0 ;;
  *"ps -q postgres"*)   echo cid-pg; exit 0 ;;
  *to_regclass*) echo f; exit 0 ;;
  *) exit 0 ;;
esac'
}

# A ui container whose mail key CANNOT be fixed by a recreate, because the value
# comes from the composition rather than from the env file the rewrite owns:
# whatever runtime/.stuck-env holds is what `docker exec cid-ui env` answers,
# before and after the recreate. The post-condition read from the running
# container is therefore the only thing left that can catch it.
shim_docker_stuck() {
    shim docker '
args="$*"
case "$args" in
  *"{{.Names}}"*) exit 0 ;;
  *"{{.ID}}"*)
      echo "cid-ui stg-app-blue gremion-ui"
      echo "cid-pg stg-state postgres"
      exit 0 ;;
  "inspect -f {{.State.Running}} stg-null-sink")
      if [ -f "$GREMION_ROOT/runtime/.sink-started" ]; then echo true; exit 0; fi
      exit 1 ;;
  "run -d --name stg-null-sink"*)
      : >"$GREMION_ROOT/runtime/.sink-started"; echo cid-sink; exit 0 ;;
  "inspect -f {{.State.Running}} cid-ui") echo true; exit 0 ;;
  "exec cid-ui env")
      echo "PATH=/usr/bin"; cat "$GREMION_ROOT/runtime/.stuck-env"; exit 0 ;;
  "exec cid-pg env") echo "PATH=/usr/bin"; exit 0 ;;
  *"up -d --force-recreate"*) exit 0 ;;
  *"ps -q gremion-ui"*) echo cid-ui; exit 0 ;;
  *"ps -q postgres"*)   echo cid-pg; exit 0 ;;
  *to_regclass*) echo f; exit 0 ;;
  *) exit 0 ;;
esac'
}

# WATCH IT FAIL: the recreate decision. A relay host that is not
# mail.${PLATFORM_DOMAIN} is still a live mail host, and the env file has just
# been rewritten to the sink underneath the running container.
@test "gremion-neuter recreates a container whose live SMTP host is not mail.example.org" {
    shim_docker_relay
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    assert_recorded docker "--env-file ${GREMION_ROOT}/etc/env/app-blue.env up -d --force-recreate gremion-ui"
    [[ "$output" == *"recreated in stg-app-blue: gremion-ui"* ]]
    [[ "$output" == *"NEUTER: env-files=2 changed=2 configs=0 rows=0 containers=2 ok"* ]]
}

# WATCH IT FAIL: the post-condition. A raw IP in an SMTP host key is a value no
# mail.example.org substring can see.
@test "gremion-neuter exits 1 when a container still carries a non-sink SMTP host" {
    printf '%s\n' "EMAIL_HOST=203.0.113.25" >"${GREMION_ROOT}/runtime/.stuck-env"
    shim_docker_stuck
    run "$NEUTER" --stack stg
    [ "$status" -eq 1 ]
    [[ "$output" == *"gremion-ui: EMAIL_HOST still names 203.0.113.25, not the null sink null-sink"* ]]
    [[ "$output" == *"live mail/token value(s) survive neutering"* ]]
}

# WATCH IT FAIL: the port arm on its own — the host key is already the sink, so
# only the port can fail this run.
@test "gremion-neuter exits 1 when a container still carries a non-sink SMTP port" {
    printf '%s\n' "SMTP_HOST=null-sink" "KEYCLOAK_SMTP_PORT=587" \
        >"${GREMION_ROOT}/runtime/.stuck-env"
    shim_docker_stuck
    run "$NEUTER" --stack stg
    [ "$status" -eq 1 ]
    [[ "$output" == *"gremion-ui: KEYCLOAK_SMTP_PORT still carries port 587, not the null sink port 1025"* ]]
}

# The other direction: "live" must not widen into "anything the rewrite would
# touch". An EMPTY host, port or token key reaches nothing — the rule the token
# arm has always applied — and a key the composition supplies empty cannot be
# changed by any recreate, so treating it as live would make the post-condition
# unsatisfiable. Such a container is neither recreated nor flagged.
@test "gremion-neuter treats an empty or already-sunk mail key as clean" {
    printf '%s\n' "SMTP_HOST=null-sink" "SMTP_PORT=1025" "EMAIL_HOST=" \
        "SMTP_SERVER=" "INSTAGRAM_ACCESS_TOKEN=" >"${GREMION_ROOT}/runtime/.stuck-env"
    shim_docker_stuck
    run "$NEUTER" --stack stg
    [ "$status" -eq 0 ]
    [[ "$output" == *"no running container carried a live value"* ]]
    [[ "$output" == *"docker exec env clean on 2 container(s)"* ]]
    refute_recorded docker "force-recreate"
}

# WATCH IT FAIL: the real relay is live whatever the sink is said to be. The
# restore proof's RED 3 drives the env assert by pointing --null-sink-host AT
# mail.example.org, so neither the rewrite nor the recreate can clean the value
# up and only the post-condition can catch it. A "live" rule expressed purely as
# "the rewrite would change this" loses that case — the rewrite writes the sink
# host the operator asked for, and the value already equals it. The integration
# found this; the unit suite pins it here.
@test "gremion-neuter flags the real mail host even when the sink is pointed at it" {
    printf '%s\n' "SMTP_HOST=mail.example.org" >"${GREMION_ROOT}/runtime/.stuck-env"
    shim_docker_stuck
    run "$NEUTER" --stack stg --null-sink-host mail.example.org
    [ "$status" -eq 1 ]
    [[ "$output" == *"gremion-ui: SMTP_HOST still names mail.example.org"* ]]
    [[ "$output" == *"live mail/token value(s) survive neutering"* ]]
}
