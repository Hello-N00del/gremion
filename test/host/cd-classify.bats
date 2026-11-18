#!/usr/bin/env bats
# test/host/cd-classify.bats -- cd-classify: infra/host/lib/cd/classify.sh, the release
# classifier (cd_classify) and its replay verb (gremion-cd classify FROM TO).
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-classify.bats
#
# Trees are tiny committed work trees built here (test_helper/cd-classify); `docker
# compose config` is a shim that answers with canned JSON holding the absolute tree path.
# Every name is a reserved example name; nothing real is read.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'
load 'test_helper/cd-classify'

setup_file() {
    CLS_BASE="${BATS_FILE_TMPDIR}/base"
    export CLS_BASE
    cls_make_base "$CLS_BASE"
}

setup() { cls_setup; }
teardown() { cls_teardown; }

# ---------------------------------------------------------------------------
# The app tier and the harness itself
# ---------------------------------------------------------------------------

@test "the real classifier answers: the cross-unit stub is not what ran" {
    run cls_run
    [ "$status" -eq 0 ]
    if grep -q '^stub cd_classify' "$SHIM_LOG"; then false; fi
    cls_is '.v == 1'
}

@test "identical trees: nothing is held and nothing is state tier" {
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .state_tier == [] and .holds == [] and .hold == null'
    cls_is '.migrations.total == 0 and .host.changed == 0 and .ci_changed == false and .compose == "checked"'
}

@test "an app-only change (a gremion-ui source file): state_tier empty, app_only true" {
    echo 'export const a = 2' >"$CLS_NEW/gremion-ui/src/app.ts"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .state_tier == [] and .holds == []'
}

# ---------------------------------------------------------------------------
# State tier, one test per reason
# ---------------------------------------------------------------------------

@test "state tier: a state compose service env change names the service" {
    cls_compose "$CLS_NEW" '.services.nats.environment.A = "2"'
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == false and .state_tier == ["compose_state:nats"]'
    cls_is '.hold.kind == "state_tier" and .hold.reason == "compose_state:nats"'
}

@test "state tier: a changed build context of a state service" {
    echo 'LABEL x=1' >>"$CLS_NEW/docker/legal/Dockerfile"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["compose_state:legal"]'
}

@test "state tier: a changed bind-mount source file" {
    echo 'echo more' >>"$CLS_NEW/docker/postgres/init.sh"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["compose_state:postgres"]'
}

@test "state tier: only the mode of a bind-mount source is a change too" {
    chmod -x "$CLS_NEW/docker/postgres/init.sh"
    cls_g "$CLS_NEW" update-index --chmod=-x docker/postgres/init.sh
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["compose_state:postgres"]'
}

@test "state tier: a changed edge template" {
    echo 'http: {x: 1}' >"$CLS_NEW/infra/host/templates/edge/active.yml.tmpl"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["edge"]'
}

@test "state tier: a changed Traefik static config" {
    echo 'api: {}' >>"$CLS_NEW/docker/traefik/traefik.yml"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["edge"]'
}

@test "state tier: a changed file of the host manifest set (bin)" {
    echo '# changed' >>"$CLS_NEW/infra/host/bin/prog"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["host_programs"] and .host.changed == 1 and .host.groups == {"bin": 1}'
}

@test "host_programs is compared with the MANIFEST, not with the old tree" {
    # old and new are identical; the manifest records an older version of one file
    printf '# an older version\n' >"${GREMION_ROOT}/.older"
    jq --arg h "$(sha256sum "${GREMION_ROOT}/.older" | cut -d' ' -f1)" \
        '.files["infra/host/bin/prog"] = $h' "${GREMION_ROOT}/data/cd/host-manifest.json" >"${GREMION_ROOT}/.m"
    mv "${GREMION_ROOT}/.m" "${GREMION_ROOT}/data/cd/host-manifest.json"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["host_programs"]'
}

@test "host_programs: a file that is in the tree and not in the manifest, and the reverse" {
    printf '# new\n' >"$CLS_NEW/infra/host/bin/prog2"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["host_programs"] and .host.groups.bin == 1'
    rm -f "$CLS_NEW/infra/host/bin/prog2"
    cls_commit "$CLS_NEW"
    cls_g "$CLS_NEW" rm -q -r infra/host/templates/env >/dev/null
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["host_programs"] and .host.groups.env == 1'
}

@test "host_programs: a file under infra/host/lib other than common.sh and cd/ counts" {
    echo '# changed' >>"$CLS_NEW/infra/host/lib/customer-ops.sh"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["host_programs"] and .host.groups == {"lib": 1}'
}

@test "host_programs: lib/common.sh, lib/cd, the bootstrap, nftables and env templates are in the set" {
    echo '#' >>"$CLS_NEW/infra/host/lib/common.sh"
    echo '#' >>"$CLS_NEW/infra/host/lib/cd/core.sh"
    echo '#' >>"$CLS_NEW/infra/host/bootstrap.sh"
    echo '#' >>"$CLS_NEW/infra/host/templates/nftables/x.nft"
    echo '#' >>"$CLS_NEW/infra/host/templates/env/x.env.tmpl"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.host.groups == {"lib": 1, "lib_cd": 1, "bootstrap": 1, "nftables": 1, "env": 1} and .host.changed == 5'
}

@test "state tier: a systemd template change" {
    echo 'Type=oneshot' >>"$CLS_NEW/infra/host/templates/systemd/x.service"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["host_programs"] and .host.groups == {"systemd": 1}'
}

@test "state tier: a changed docker/pgbouncer/pgbouncer-auth.sql is shared_sql" {
    echo '-- more' >>"$CLS_NEW/docker/pgbouncer/pgbouncer-auth.sql"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["shared_sql"]'
}

@test "state tier: a new file in the platform chain is platform_migration" {
    cls_chain_file "$CLS_NEW" platform 0002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["platform_migration"] and .migrations.chains.platform == {"class": "tenant-store", "expand": 1, "migrate": 0, "contract": 0}'
}

@test "state tier: every reason of one range is listed, sorted, once" {
    echo '#' >>"$CLS_NEW/infra/host/bin/prog"
    echo '-- x' >>"$CLS_NEW/docker/pgbouncer/pgbouncer-auth.sql"
    echo 'api: {}' >>"$CLS_NEW/docker/traefik/traefik.yml"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["edge", "host_programs", "shared_sql"]'
}

# ---------------------------------------------------------------------------
# Normalisation, trees as git objects
# ---------------------------------------------------------------------------

@test "a pure tree-prefix difference in the rendered compose JSON is not a difference" {
    # the shim writes each tree's own absolute path into bind sources, build contexts and an
    # environment value: the two renders differ in nothing else
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == [] and .app_only == true'
    run bash -c "cd '$CLS_OLD' && PATH='$PATH' docker compose --env-file x config --format json | jq -r '.services.postgres.environment.ROOT_HINT'"
    [[ "$output" == "$CLS_OLD/data" ]]
    run bash -c "cd '$CLS_NEW' && PATH='$PATH' docker compose --env-file x config --format json | jq -r '.services.postgres.environment.ROOT_HINT'"
    [[ "$output" == "$CLS_NEW/data" ]]
}

@test "state tier: a service that is added or removed is named, and a change outside the services is _project" {
    cls_compose "$CLS_NEW" '.services.extra = {"image": "extra:1"}'
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["compose_state:extra"]'
    cls_compose "$CLS_NEW" 'del(.services.extra) | del(.services.nats)'
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.state_tier == ["compose_state:nats"]'
    cls_compose "$CLS_NEW" '.services.nats = {"image":"nats:2","environment":{"A":"1"}} | .networks.default.name = "other"'
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.state_tier == ["compose_state:_project"]'
}

@test "the live tree may be given through a symbolic link (the current link)" {
    ln -s "$CLS_OLD" "${GREMION_ROOT}/current"
    CLS_OLD="${GREMION_ROOT}/current"
    echo 'export const a = 5' >"$CLS_NEW/gremion-ui/src/app.ts"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .holds == []'
}

@test "a sibling path that merely starts with the tree prefix is not stripped" {
    cls_compose "$CLS_NEW" '.services.nats.environment.PEER = "@TREE@-other/x"'
    cls_commit "$CLS_NEW"
    cls_compose "$CLS_OLD" '.services.nats.environment.PEER = "@TREE@-other/x"'
    cls_commit "$CLS_OLD"
    run cls_run
    [ "$status" -eq 0 ]
    # old and new carry different absolute prefixes in a value the normaliser must NOT touch
    cls_is '.state_tier == ["compose_state:nats"]'
}

@test "a file that git does not track, inside a build context or bind source, is not a difference" {
    echo 'rendered later' >"$CLS_NEW/docker/legal/generated.txt"
    echo 'rendered later' >"$CLS_OLD/docker/postgres/other.txt"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == [] and .app_only == true'
}

@test "a tree with a tracked change is classify_failed, not read from the work copy" {
    echo 'dirty' >>"$CLS_NEW/gremion-ui/src/app.ts"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.hold.kind == "classify_failed" and .hold.reason == "classify_failed:tree_unreadable:new"'
}

@test "a directory that is not a work tree of its own is classify_failed" {
    rm -rf "$CLS_OLD/.git"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds | map(.reason) | index("classify_failed:tree_unreadable:old") != null'
}

# ---------------------------------------------------------------------------
# Compose failures and secrets
# ---------------------------------------------------------------------------

@test "a compose render that fails is classify_failed, never 'no difference'" {
    : >"$CLS_NEW/.compose.fail"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == false and .hold.kind == "classify_failed" and .hold.reason == "classify_failed:compose_render"'
}

@test "a compose answer that is not JSON, or has no services, is classify_failed" {
    echo 'not json' >"$CLS_NEW/compose.canned.json"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "classify_failed:compose_render"'
    echo '{"name":"x"}' >"$CLS_NEW/compose.canned.json"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "classify_failed:compose_render"'
    : >"$CLS_NEW/compose.canned.json"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "classify_failed:compose_render"'
}

@test "the rendered config resolves secrets: none reaches the output, a stream, argv or a leftover file" {
    local canary="CANARY-s3cret-$$"
    cls_compose "$CLS_OLD" ".services.nats.environment.PASSWORD = \"${canary}\""
    cls_compose "$CLS_NEW" ".services.nats.environment.PASSWORD = \"${canary}-2\""
    cls_commit "$CLS_OLD"
    cls_commit "$CLS_NEW"
    run --separate-stderr cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == ["compose_state:nats"]'
    [[ "$output" != *"$canary"* ]]
    [[ "$stderr" != *"$canary"* ]]
    if grep -q "$canary" "$SHIM_LOG"; then false; fi
    # no temporary directory of the classifier is left behind (it held the rendered config)
    [ -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -name 'cd-classify*' 2>/dev/null)" ]
}

@test "the docker calls are the one compose shape: config --format json, no -f, no -p" {
    run cls_run
    [ "$status" -eq 0 ]
    grep -q 'docker compose --env-file .*/etc/env/state.env .*config --format json' "$SHIM_LOG"
    ! grep -E 'docker compose .* (-f|-p|--file|--project-name) ' "$SHIM_LOG"
}

@test "the compose render does not resolve env files: a state service whose env_file a later stage writes is classified" {
    local t
    for t in "$CLS_OLD" "$CLS_NEW"; do
        cls_compose "$t" '.services.legal.env_file = [{"path":"@TREE@/legal/legal.env","required":true}]'
        cls_commit "$t"
    done
    [ ! -e "$CLS_OLD/legal/legal.env" ] && [ ! -e "$CLS_NEW/legal/legal.env" ]
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.hold == null and .state_tier == [] and .app_only == true'
    grep -q 'config --format json --no-env-resolution' "$SHIM_LOG"
}

@test "state tier: a rendered bind source that git does not track is followed to its tracked template" {
    local t
    for t in "$CLS_OLD" "$CLS_NEW"; do
        mkdir -p "$t/docker/livekit"
        printf 'port: 7880\n' >"$t/docker/livekit/livekit.yaml.tmpl"
        printf 'other: 1\n' >"$t/docker/livekit/other.yaml.tmpl"
        cls_compose "$t" '.services.livekit = {image: "livekit:dev", volumes: [{type: "bind", source: "@TREE@/docker/livekit/livekit.yaml", target: "/etc/livekit/livekit.yaml"}]}'
        cls_commit "$t"
    done
    # rendered in the live tree only: that is not a difference, the template is the input
    printf 'port: 7880\nkey: rendered\n' >"$CLS_OLD/docker/livekit/livekit.yaml"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.state_tier == [] and .app_only == true'
    # the template of ANOTHER file of the directory does not count
    printf 'other: 2\n' >"$CLS_NEW/docker/livekit/other.yaml.tmpl"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.state_tier == [] and .app_only == true'
    # the template of the source does
    printf 'port: 7881\n' >"$CLS_NEW/docker/livekit/livekit.yaml.tmpl"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.state_tier == ["compose_state:livekit"] and .app_only == false'
}

@test "state tier: the example file of a rendered credential list counts as its template" {
    local t
    for t in "$CLS_OLD" "$CLS_NEW"; do
        mkdir -p "$t/docker/pgbouncer"
        printf '"u" "x"\n' >"$t/docker/pgbouncer/userlist.txt.example"
        cls_compose "$t" '.services.pgbouncer = {image: "pgbouncer:dev", volumes: [{type: "bind", source: "@TREE@/docker/pgbouncer/userlist.txt", target: "/etc/pgbouncer/userlist.txt", read_only: true}]}'
        cls_commit "$t"
    done
    run cls_run
    cls_is '.state_tier == []'
    printf '"u" "y"\n' >"$CLS_NEW/docker/pgbouncer/userlist.txt.example"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.state_tier == ["compose_state:pgbouncer"]'
}

@test "a jq failure while diffing the two compose views is classify_failed, not 'no difference'" {
    local real
    real="$(command -v jq)"
    cls_compose "$CLS_NEW" '.services.nats.environment.A = "2"'
    cls_commit "$CLS_NEW"
    # shellcheck disable=SC2016  # the shim body is a script, expanded when the shim runs
    shim jq 'case "$*" in *cmp.old.json*) exit 5 ;; esac
exec '"$real"' "$@"'
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == false and .hold.kind == "classify_failed" and .hold.reason == "classify_failed:compose_diff"'
}

@test "a classifier that is terminated removes its temporary directory, the rendered config with it" {
    local canary="CANARY-term-$$" pid i
    cls_compose "$CLS_OLD" ".services.nats.environment.PASSWORD = \"${canary}\""
    cls_commit "$CLS_OLD"
    : >"$CLS_OLD/.compose.slow"
    ( exec bash -c "$CLS_SCRIPT" cls-run "$CLS_OLD" "$CLS_NEW" ) >"$BATS_TEST_TMPDIR/term.out" 2>&1 3>&- &
    pid=$!
    for i in $(seq 1 50); do
        grep -rqs "$canary" "$TMPDIR" && break
        sleep 0.2
    done
    # the test is real: the rendered config is on disk while the classifier waits for compose
    grep -rqs "$canary" "$TMPDIR"
    kill -TERM "$pid"
    wait "$pid" || true
    [ -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -name 'cd-classify*' 2>/dev/null)" ]
    if grep -rqs "$canary" "$TMPDIR"; then false; fi
    if grep -q "$canary" "$BATS_TEST_TMPDIR/term.out"; then false; fi
}

@test "a caller whose own TERM handler returns keeps that handler after the classifier was terminated" {
    local canary="CANARY-trap-$$" pid i
    cls_compose "$CLS_OLD" ".services.nats.environment.PASSWORD = \"${canary}\""
    cls_commit "$CLS_OLD"
    : >"$CLS_OLD/.compose.slow"
    ( exec bash -c "${CLS_SCRIPT%cd_classify \"\$@\"}"'trap "stop=1" TERM
cd_classify "$@"
echo "after=[$(trap -p TERM)]"' cls-run "$CLS_OLD" "$CLS_NEW" ) >"$BATS_TEST_TMPDIR/trap.out" 2>&1 3>&- &
    pid=$!
    for i in $(seq 1 50); do
        grep -rqs "$canary" "$TMPDIR" && break
        sleep 0.2
    done
    grep -rqs "$canary" "$TMPDIR"
    kill -TERM "$pid"
    wait "$pid" || true
    # the verdict is the fail-closed one, the directory is gone and the handler is still the caller's
    [ -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -name 'cd-classify*' 2>/dev/null)" ]
    grep -q 'classify_failed:internal' "$BATS_TEST_TMPDIR/trap.out"
    grep -qF "after=[trap -- 'stop=1' SIGTERM]" "$BATS_TEST_TMPDIR/trap.out"
}

# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------

@test "migrations: a new control expand file is automatic, with chain and phase counted" {
    cls_chain_file "$CLS_NEW" control 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .holds == [] and .migrations.total == 1'
    cls_is '.migrations.chains.control == {"class": "legacy-boot", "expand": 1, "migrate": 0, "contract": 0}'
}

@test "migrations: kernel-data and kernel-api files are automatic, migrate phase counted" {
    cls_chain_file "$CLS_NEW" kernel-data 0002_x.sql migrate
    cls_chain_file "$CLS_NEW" kernel-api 0002_k.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .migrations.total == 2'
    cls_is '.migrations.chains["kernel-data"].migrate == 1 and .migrations.chains["kernel-api"].expand == 1'
}

@test "migrations: a new module-calendar file in a chain of class module-upgrade is automatic" {
    cls_chain_file "$CLS_NEW" module-calendar 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .holds == []'
    cls_is '.migrations.chains["module-calendar"] == {"class": "module-upgrade", "expand": 1, "migrate": 0, "contract": 0}'
}

@test "migrations: the same file with the class unadopted is unsupported_chain chain_unadopted" {
    cls_class "$CLS_OLD" module-calendar unadopted
    cls_class "$CLS_NEW" module-calendar unadopted
    cls_commit "$CLS_OLD"
    cls_chain_file "$CLS_NEW" module-calendar 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.hold == {"kind": "unsupported_chain", "reason": "chain_unadopted:module-calendar"}'
}

@test "migrations: a new module-board file (class unadopted in the real tree) is unsupported_chain" {
    cls_chain_file "$CLS_NEW" module-board 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds == [{"kind": "unsupported_chain", "reason": "chain_unadopted:module-board"}]'
}

@test "migrations: a mail file is unsupported_chain (the chain has no runner)" {
    cls_chain_file "$CLS_NEW" mail 0001_m.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds == [{"kind": "unsupported_chain", "reason": "chain_unadopted:mail"}]'
}

@test "migrations: a second governance file is unsupported_chain chain_fresh_only" {
    cls_chain_file "$CLS_NEW" governance 0002_g.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds == [{"kind": "unsupported_chain", "reason": "chain_fresh_only:governance"}]'
}

@test "migrations: an unknown class, or a chain missing from the file, is classify_failed" {
    cls_class "$CLS_OLD" control future-class
    cls_class "$CLS_NEW" control future-class
    cls_commit "$CLS_OLD"
    cls_chain_file "$CLS_NEW" control 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == false and (.holds | map(.reason) | index("classify_failed:class_unknown:control") != null) and .hold.kind == "classify_failed"'

    # a chain the live runners file has and the new one lost
    run bash -c "cd '$CLS_NEW' && jq 'del(.chains.control)' scripts/migrations/runner/chain-runners.json > .x && mv .x scripts/migrations/runner/chain-runners.json"
    cls_class "$CLS_OLD" control legacy-boot
    cls_commit "$CLS_OLD"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.holds | map(.reason) | index("classify_failed:chain_missing:control") != null'
}

@test "the signal handlers of the caller are back in place after a classification, and none appears that it had not" {
    run bash -c "${CLS_SCRIPT%cd_classify \"\$@\"}"'trap "echo mine" TERM
cd_classify "$@" >/dev/null
trap -p TERM
echo "int=[$(trap -p INT)]"' cls-run "$CLS_OLD" "$CLS_NEW"
    [ "$status" -eq 0 ]
    [[ "$output" == *"echo mine"* ]]
    [[ "$output" == *"int=[]"* ]]
}

@test "migrations: a chain that is in neither chain-runners.json is classify_failed, not an automatic file" {
    local t
    for t in "$CLS_OLD" "$CLS_NEW"; do
        jq 'del(.chains.control)' "$t/scripts/migrations/runner/chain-runners.json" >"$t/.x"
        mv "$t/.x" "$t/scripts/migrations/runner/chain-runners.json"
    done
    cls_commit "$CLS_OLD"
    cls_chain_file "$CLS_NEW" control 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == false and .hold.kind == "classify_failed" and (.holds | map(.reason) | index("classify_failed:chain_missing:control") != null)'
}

@test "migrations: an unknown class in both chain-runners.json is classify_failed, with no new file in that chain" {
    cls_class "$CLS_OLD" mail bogus
    cls_class "$CLS_NEW" mail bogus
    cls_commit "$CLS_OLD"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == false and .hold.kind == "classify_failed" and (.holds | map(.reason) | index("classify_failed:class_unknown:mail") != null)'
}

@test "the class document has exactly the documented keys, and no reconcile field" {
    run cls_run
    [ "$status" -eq 0 ]
    cls_is 'keys == ["app_only","ci_changed","compose","hold","holds","host","migrations","state_tier","v"] and (has("reconcile") | not)'
}

@test "migrations: a chain and class pair the program cannot apply is classify_failed (allow-list)" {
    # governance flipped to tenant-store in both trees: no runner of this program applies it
    cls_class "$CLS_OLD" governance tenant-store
    cls_class "$CLS_NEW" governance tenant-store
    cls_commit "$CLS_OLD"
    cls_chain_file "$CLS_NEW" governance 0002_g.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds | map(.reason) | index("classify_failed:chain_class_pair:governance") != null'
}

@test "migrations: the module-upgrade arm of the allow-list is for module chains only (control flipped to module-upgrade)" {
    cls_class "$CLS_OLD" control module-upgrade
    cls_class "$CLS_NEW" control module-upgrade
    cls_commit "$CLS_OLD"
    cls_chain_file "$CLS_NEW" control 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds | map(.reason) | index("classify_failed:chain_class_pair:control") != null'
    cls_is '.app_only == false'
}

@test "module declaration: runtime.database that differs between the trees is unsupported_chain" {
    jq '.runtime.database = {"postgresService":"board-postgres","migrations":"migrations"}' "$CLS_NEW/modules/board/module.json" >"$CLS_NEW/.m"
    mv "$CLS_NEW/.m" "$CLS_NEW/modules/board/module.json"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds == [{"kind": "unsupported_chain", "reason": "module_declaration_changed:board"}]'
}

@test "module declaration: the next tick, with that release as the live tree, does not hold for it" {
    jq '.runtime.database = {"postgresService":"board-postgres","migrations":"migrations"}' "$CLS_NEW/modules/board/module.json" >"$CLS_NEW/.m"
    mv "$CLS_NEW/.m" "$CLS_NEW/modules/board/module.json"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "module_declaration_changed:board"'
    # the board release is live now: old = it, new = it plus an app change
    rm -rf "$CLS_OLD"
    cp -a "$CLS_NEW" "$CLS_OLD"
    echo 'export const a = 3' >"$CLS_NEW/gremion-ui/src/app.ts"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .holds == []'
}

@test "module declaration: a change of export or version alone does not hold" {
    jq '.runtime.version = "2.0.0" | .runtime.export = {"kind":"pg_dump"}' "$CLS_NEW/modules/calendar/module.json" >"$CLS_NEW/.m"
    mv "$CLS_NEW/.m" "$CLS_NEW/modules/calendar/module.json"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .holds == []'
}

@test "module declaration: a database that goes back to null, or an unreadable module.json" {
    jq '.runtime.database = null' "$CLS_NEW/modules/calendar/module.json" >"$CLS_NEW/.m"
    mv "$CLS_NEW/.m" "$CLS_NEW/modules/calendar/module.json"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "module_declaration_changed:calendar"'
    echo '{broken' >"$CLS_NEW/modules/calendar/module.json"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.holds | map(.reason) | index("classify_failed:module_json_invalid") != null'
    : >"$CLS_NEW/modules/calendar/module.json"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.holds | map(.reason) | index("classify_failed:module_json_invalid") != null'
}

@test "migrations: a contract-phase file is held contract_migration" {
    cls_chain_file "$CLS_NEW" control 002_x.sql contract
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.hold == {"kind": "contract_migration", "reason": "contract_migration:control"}'
    cls_is '.migrations.chains.control.contract == 1'
}

@test "migrations: a new lint-waivers.json entry is held waived_migration" {
    jq '.waivers += [{"chain":"control","file":"001_a.sql","sha256":"00","rules":["revoke"],"reason":"x"}]' \
        "$CLS_NEW/scripts/migrations/runner/lint-waivers.json" >"$CLS_NEW/.w"
    mv "$CLS_NEW/.w" "$CLS_NEW/scripts/migrations/runner/lint-waivers.json"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds == [{"kind": "waived_migration", "reason": "waived_migration"}]'
}

@test "migrations: a locked file whose hash changed is an error, not a migration" {
    echo '-- tampered' >>"$CLS_NEW/gremion-ui/migrations-control/001_a.sql"
    cls_commit "$CLS_NEW"
    # the lock still pins the old hash, and the new tree's lock says so
    jq -S '.chains.control.files["001_a.sql"] = "ffff"' "$CLS_NEW/scripts/migrations/applied.lock.json" >"$CLS_NEW/.l"
    mv "$CLS_NEW/.l" "$CLS_NEW/scripts/migrations/applied.lock.json"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.hold == {"kind": "classify_failed", "reason": "classify_failed:locked_file_changed:control"}'
    cls_is '.migrations.total == 0'
}

@test "migrations: a locked file that disappeared from the lock is classify_failed" {
    jq -S 'del(.chains.control.files["001_a.sql"])' "$CLS_NEW/scripts/migrations/applied.lock.json" >"$CLS_NEW/.l"
    mv "$CLS_NEW/.l" "$CLS_NEW/scripts/migrations/applied.lock.json"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "classify_failed:locked_file_removed:control"'
}

@test "migrations: a new file without a readable phase header, or not on disk, is classify_failed" {
    cls_chain_file "$CLS_NEW" control 002_x.sql none
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "classify_failed:phase_header:control" and .app_only == false'
    rm "$CLS_NEW/gremion-ui/migrations-control/002_x.sql"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "classify_failed:file_not_located:control"'
}

# ---------------------------------------------------------------------------
# The class comes from the LIVE tree, and a class change is held
# ---------------------------------------------------------------------------

@test "chain_class_changed: a new module-board file AND the chain flipped to module-upgrade in the new tree" {
    cls_chain_file "$CLS_NEW" module-board 002_x.sql expand
    cls_class "$CLS_NEW" module-board module-upgrade
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds != [] and .state_tier == []'
    cls_is '.holds | map(.reason) | index("chain_class_changed:module-board") != null'
    # the file is judged by the LIVE class: it must not pass as automatic
    cls_is '.holds | map(.reason) | index("chain_unadopted:module-board") != null'
    cls_is '.migrations.chains["module-board"].class == "unadopted"'
}

@test "chain_class_changed: a range that only flips a class is held, and nothing else" {
    cls_class "$CLS_NEW" module-board module-upgrade
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds == [{"kind": "chain_class_changed", "reason": "chain_class_changed:module-board"}]'
    cls_is '.state_tier == []'
}

@test "chain_class_changed: a chain that only the new files have is held" {
    run bash -c "cd '$CLS_NEW' && jq '.chains[\"module-vault\"] = \"module-upgrade\"' scripts/migrations/runner/chain-runners.json > .x && mv .x scripts/migrations/runner/chain-runners.json"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds == [{"kind": "chain_class_changed", "reason": "chain_class_changed:module-vault"}]'
}

@test "chain_class_changed: when both trees give the same class nothing changes" {
    cls_class "$CLS_OLD" module-board module-upgrade
    cls_class "$CLS_NEW" module-board module-upgrade
    cls_commit "$CLS_OLD"
    cls_chain_file "$CLS_NEW" module-board 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .holds == []'
    cls_is '.migrations.chains["module-board"].class == "module-upgrade"'
}

@test "a board schema file is chain_unadopted until its chain flips to module-upgrade, and automatic after it" {
    cls_chain_file "$CLS_NEW" module-board 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.hold.reason == "chain_unadopted:module-board"'
    # the flip lands in an ordinary release (held, class change only) ...
    rm -rf "$CLS_NEW"
    cp -a "${CLS_BASE}" "$CLS_NEW"
    cls_class "$CLS_NEW" module-board module-upgrade
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.holds == [{"kind": "chain_class_changed", "reason": "chain_class_changed:module-board"}]'
    # ... and from then on, with the flipped tree live, a board file is automatic
    rm -rf "$CLS_OLD"
    cp -a "$CLS_NEW" "$CLS_OLD"
    cls_chain_file "$CLS_NEW" module-board 002_x.sql expand
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.app_only == true and .holds == []'
}

# ---------------------------------------------------------------------------
# ci_changed, accumulation, determinism, fail closed
# ---------------------------------------------------------------------------

@test "ci_changed: a range that changes a file under .github/workflows is held" {
    echo '# x' >>"$CLS_NEW/.github/workflows/ci.yml"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.holds == [{"kind": "ci_changed", "reason": "ci_changed"}] and .ci_changed == true and .app_only == true'
    cls_is '.state_tier == []'
}

@test "app_only is about the state tier: a hold leaves it true, a state reason or a failed classification makes it false" {
    echo '# x' >>"$CLS_NEW/.github/workflows/ci.yml"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.app_only == true and .state_tier == [] and (.holds | length) == 1'
    echo '#' >>"$CLS_NEW/infra/host/bin/prog"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.app_only == false and .state_tier == ["host_programs"]'
    : >"$CLS_NEW/.compose.fail"
    run cls_run
    cls_is '.app_only == false and (.holds | map(.kind) | index("classify_failed") != null)'
}

@test "ci_changed: a new workflow file counts, a range that does not touch the directory does not" {
    echo 'name: more' >"$CLS_NEW/.github/workflows/more.yml"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.ci_changed == true'
    rm -rf "$CLS_NEW"
    cp -a "${CLS_BASE}" "$CLS_NEW"
    echo 'export const a = 9' >"$CLS_NEW/gremion-ui/src/app.ts"
    cls_commit "$CLS_NEW"
    run cls_run
    cls_is '.ci_changed == false and .holds == []'
}

@test "holds accumulate and a weaker one never masks a stronger one" {
    echo '# x' >>"$CLS_NEW/.github/workflows/ci.yml"
    cls_chain_file "$CLS_NEW" mail 0001_m.sql expand
    echo '#' >>"$CLS_NEW/infra/host/bin/prog"
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '[.holds[].kind] == ["unsupported_chain", "ci_changed", "state_tier"]'
    cls_is '.hold.kind == "unsupported_chain" and .state_tier == ["host_programs"]'
}

@test "every reason is a code the state file accepts" {
    echo '# x' >>"$CLS_NEW/.github/workflows/ci.yml"
    cls_chain_file "$CLS_NEW" mail 0001_m.sql expand
    cls_chain_file "$CLS_NEW" control 002_c.sql contract
    cls_commit "$CLS_NEW"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '[.holds[].reason | test("^[A-Za-z0-9_:./+-]{1,120}$")] | all'
    cls_is '[.holds[].kind | IN("state_tier","unsupported_chain","contract_migration","waived_migration","ci_changed","chain_class_changed","classify_failed")] | all'
}

@test "determinism: the same two trees give byte-identical JSON" {
    cls_chain_file "$CLS_NEW" control 002_c.sql expand
    cls_chain_file "$CLS_NEW" module-calendar 002_k.sql migrate
    echo '#' >>"$CLS_NEW/infra/host/lib/customer-ops.sh"
    cls_compose "$CLS_NEW" '.services.nats.environment.A = "3"'
    cls_commit "$CLS_NEW"
    run cls_run
    local first="$output"
    cls_is '.v == 1 and (.state_tier | length) == 2 and .migrations.total == 2'
    run cls_run
    [ "$output" = "$first" ]
    run cls_run
    [ "$output" = "$first" ]
    [ "$(printf '%s\n' "$first" | wc -l)" -eq 1 ]
}

@test "fail closed: a missing applied.lock.json or ranges.json in either tree is classify_failed" {
    local side f
    for side in old new; do
        for f in applied.lock.json ranges.json; do
            rm -rf "$CLS_OLD" "$CLS_NEW"
            cp -a "${CLS_BASE}" "$CLS_OLD"
            cp -a "${CLS_BASE}" "$CLS_NEW"
            if [[ "$side" == old ]]; then
                rm -f "$CLS_OLD/scripts/migrations/$f"
                cls_commit "$CLS_OLD"
            else
                rm -f "$CLS_NEW/scripts/migrations/$f"
                cls_commit "$CLS_NEW"
            fi
            run cls_run
            [ "$status" -eq 0 ]
            cls_is '.app_only == false and .hold.kind == "classify_failed"'
            [[ "$output" == *"classify_failed:unreadable:${f}:${side}"* ]]
        done
    done
}

@test "fail closed: an unparseable, empty or wrongly shaped applied.lock.json, ranges.json, chain-runners.json or lint-waivers.json" {
    local f body
    for f in applied.lock.json ranges.json runner/chain-runners.json runner/lint-waivers.json; do
        for body in '{nope' '' '{}' '[]' 'null'; do
            rm -rf "$CLS_NEW"
            cp -a "${CLS_BASE}" "$CLS_NEW"
            printf '%s' "$body" >"$CLS_NEW/scripts/migrations/$f"
            cls_commit "$CLS_NEW"
            run cls_run
            [ "$status" -eq 0 ]
            cls_is '.hold.kind == "classify_failed" and .app_only == false'
        done
    done
}

@test "fail closed: the same files emptied in the OLD (live) tree" {
    local f
    for f in applied.lock.json ranges.json runner/chain-runners.json runner/lint-waivers.json; do
        rm -rf "$CLS_OLD"
        cp -a "${CLS_BASE}" "$CLS_OLD"
        : >"$CLS_OLD/scripts/migrations/$f"
        cls_commit "$CLS_OLD"
        run cls_run
        [ "$status" -eq 0 ]
        cls_is '.hold.kind == "classify_failed" and .app_only == false'
    done
}

@test "fail closed: a missing or unreadable host manifest is classify_failed" {
    rm -f "${GREMION_ROOT}/data/cd/host-manifest.json"
    run cls_run
    [ "$status" -eq 0 ]
    cls_is '.hold.reason == "classify_failed:manifest_unreadable" and .app_only == false'
    echo '{"v":2,"files":{}}' >"${GREMION_ROOT}/data/cd/host-manifest.json"
    run cls_run
    cls_is '.hold.reason == "classify_failed:manifest_unreadable"'
    echo 'garbage' >"${GREMION_ROOT}/data/cd/host-manifest.json"
    run cls_run
    cls_is '.hold.reason == "classify_failed:manifest_unreadable"'
    : >"${GREMION_ROOT}/data/cd/host-manifest.json"
    run cls_run
    cls_is '.hold.reason == "classify_failed:manifest_unreadable"'
}

@test "usage: a missing tree is exit 2 and prints no verdict" {
    run bash -c ". '${HOST_SRC}/lib/common.sh'; . '${HOST_SRC}/lib/cd/core.sh'; . '${HOST_SRC}/lib/cd/docker.sh'; . '${HOST_SRC}/lib/cd/classify.sh'; cd_classify '$CLS_OLD' '${GREMION_ROOT}/nope'"
    [ "$status" -eq 2 ]
    [[ "$output" != *'"v"'* ]]
}

@test "classify.sh sets no shell option and runs nothing when it is sourced" {
    run bash -c 'set +e; set +u; set +o pipefail; . "$1/lib/cd/classify.sh"; case $- in *e*) echo e;; esac; case $- in *u*) echo u;; esac; set -o | grep -q "pipefail *on" && echo p; true' x "$HOST_SRC"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

# ---------------------------------------------------------------------------
# The replay verb: gremion-cd classify FROM TO
# ---------------------------------------------------------------------------

# cls_mirror -- a bare mirror at data/cd/mirror.git with C1..C5 on main:
#   C1 base, C2 app change, C3 a lib file (host_programs), C4 a new module-calendar
#   file (automatic), C5 a new mail file (unsupported_chain)
cls_mirror() {
    local work="${GREMION_ROOT}/.replay-work" bare="${GREMION_ROOT}/data/cd/mirror.git" g=gi
    g="${g}t"
    rm -rf "$work" "$bare"
    cp -a "${CLS_BASE}" "$work"
    C1="$(cls_g "$work" rev-parse HEAD)"
    echo 'export const a = 2' >"$work/gremion-ui/src/app.ts"
    cls_commit "$work" c2
    C2="$(cls_g "$work" rev-parse HEAD)"
    echo '#' >>"$work/infra/host/lib/customer-ops.sh"
    cls_commit "$work" c3
    C3="$(cls_g "$work" rev-parse HEAD)"
    cls_chain_file "$work" module-calendar 002_x.sql expand
    cls_commit "$work" c4
    C4="$(cls_g "$work" rev-parse HEAD)"
    cls_chain_file "$work" mail 0001_m.sql expand
    cls_commit "$work" c5
    C5="$(cls_g "$work" rev-parse HEAD)"
    env -u GIT_DIR "$g" clone -q --bare "$work" "$bare" </dev/null
    export C1 C2 C3 C4 C5
}

@test "replay: per commit pair the class, then the counts, and host_programs through lib is reported separately" {
    cls_mirror
    run cd_prog classify "$C1" "$C5"
    [ "$status" -eq 0 ]
    [[ "$output" == *"${C1:0:12}..${C2:0:12} automatic"* ]]
    [[ "$output" == *"${C2:0:12}..${C3:0:12} held host_programs"* ]]
    [[ "$output" == *"${C3:0:12}..${C4:0:12} automatic"* ]]
    [[ "$output" == *"${C4:0:12}..${C5:0:12} held chain_unadopted:mail"* ]]
    [[ "$output" == *"classified 4 pairs: automatic 2, held 2"* ]]
    [[ "$output" == *"held only by host_programs through infra/host/lib/** (lib and lib/cd): 1"* ]]
    [[ "$output" == *"of which no file of lib/cd is among them: 1"* ]]
    [[ "$output" == *"held with state_tier: 1"* ]]
    [[ "$output" == *"held with unsupported_chain: 1"* ]]
}

@test "replay: --no-compose skips the compose leg and says so; a range of one commit is one pair" {
    cls_mirror
    run cd_prog classify "$C2" "$C3" --no-compose
    [ "$status" -eq 0 ]
    [[ "$output" == *"classified 1 pairs: automatic 0, held 1"* ]]
    [[ "$output" == *"compose_state was not evaluated"* ]]
    ! grep -q '^docker compose' "$SHIM_LOG"
}

@test "replay: with the compose leg the state project is rendered for both trees of each pair" {
    cls_mirror
    run cd_prog classify "$C1" "$C2"
    [ "$status" -eq 0 ]
    [ "$(grep -c '^docker compose' "$SHIM_LOG")" -eq 2 ]
}

@test "replay is read-only: it writes no state, history, lock or request" {
    cls_mirror
    local before after
    before="$(cd "$GREMION_ROOT" && find data runtime etc -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum)"
    run cd_prog classify "$C1" "$C5"
    [ "$status" -eq 0 ]
    [[ "$output" == *"classified 4 pairs"* ]]
    after="$(cd "$GREMION_ROOT" && find data runtime etc -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum)"
    [ "$before" = "$after" ]
    [ ! -e "${GREMION_ROOT}/data/cd/state.json" ]
    [ -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -name 'cd-classify*' 2>/dev/null)" ]
}

@test "replay: bad usage is exit 2 with a reason" {
    run cd_prog classify
    [ "$status" -eq 2 ]
    run cd_prog classify abc
    [ "$status" -eq 2 ]
    cls_mirror
    run cd_prog classify "$C1" "$C2" --nope
    [ "$status" -eq 2 ]
    run cd_prog classify "$C2" "$C1"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not an ancestor"* ]]
    run cd_prog classify nosuchrev "$C2"
    [ "$status" -eq 2 ]
}

@test "replay: the verb is in help, and with no mirror it stops with exit 2" {
    run cd_prog help
    [[ "$output" == *"classify"* ]]
    run cd_prog classify aaaa bbbb
    [ "$status" -eq 2 ]
    [[ "$output" == *"mirror"* ]]
}
