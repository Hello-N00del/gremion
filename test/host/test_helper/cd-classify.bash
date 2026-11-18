#!/usr/bin/env bash
# test/host/test_helper/cd-classify.bash -- fixtures for test/host/cd-classify.bats.
#
# Load it AFTER test_helper/host and test_helper/cd:
#     load 'test_helper/host'
#     load 'test_helper/cd'
#     load 'test_helper/cd-classify'
#
# WHAT IT GIVES
#   cls_make_base DIR      a tiny release tree (a committed work tree): the files the
#                          classifier reads, with every address a reserved example name
#   cls_setup / cls_teardown   a throwaway root, the docker shim, two trees OLD and NEW
#   cls_commit TREE        commit every change of a tree
#   cls_chain_file TREE CHAIN FILE PHASE   a new migration file plus its lock entry
#   cls_class TREE CHAIN CLASS             set a chain's class in chain-runners.json
#   cls_compose TREE JQ    edit the canned compose answer of a tree
#   cls_manifest TREE OUT  the host manifest of a tree, computed WITHOUT the library
#   cls_run [ARGS]         cd_classify OLD NEW (real library, stubs only behind it)
#
# THE DOCKER SHIM answers `compose ... config --format json` with the file
# compose.canned.json of the current directory, every @TREE@ in it replaced by the
# directory the call runs in: the answer contains the ABSOLUTE tree path, as the real
# one does, so the prefix normalisation is exercised.

CLS_GIT_NAME=cd-classify-test

# cls_g TREE ARGS... -- the version control tool, spelled once, never the caller's repo.
cls_g() {
    local tree="$1" g=gi
    g="${g}t"
    shift
    env -u GIT_DIR -u GIT_WORK_TREE "$g" -C "$tree" \
        -c user.name="$CLS_GIT_NAME" -c user.email=t@example.org -c commit.gpgsign=false \
        -c core.autocrlf=false "$@" </dev/null
}

cls_commit() {
    cls_g "$1" add -A >/dev/null
    cls_g "$1" commit -q -m "${2:-change}" >/dev/null
}

cls_make_base() {
    local d="$1" g=gi
    g="${g}t"
    mkdir -p "$d"
    env -u GIT_DIR -u GIT_WORK_TREE "$g" init -q -b main "$d" </dev/null
    (
        cd "$d" || exit 1
        mkdir -p gremion-ui/src gremion-ui/migrations gremion-ui/migrations-control platform-migrations \
            services/kernel-api/migrations/core services/governance/migrations services/mail/migrations \
            modules/board/migrations modules/calendar/migrations modules/vault \
            docker/postgres docker/legal docker/traefik docker/pgbouncer \
            infra/host/bin infra/host/lib/cd infra/host/templates/edge infra/host/templates/systemd \
            infra/host/templates/nftables infra/host/templates/env .github/workflows \
            scripts/migrations/runner
        echo 'export const a = 1' >gremion-ui/src/app.ts
        printf '#!/bin/sh\necho init\n' >docker/postgres/init.sh
        chmod +x docker/postgres/init.sh
        printf 'FROM scratch\n' >docker/legal/Dockerfile
        printf 'entryPoints: {}\n' >docker/traefik/traefik.yml
        printf -- '-- auth\n' >docker/pgbouncer/pgbouncer-auth.sql
        printf 'http: {}\n' >infra/host/templates/edge/active.yml.tmpl
        printf '#!/usr/bin/env bash\n# prog\n' >infra/host/bin/prog
        printf '# common\n' >infra/host/lib/common.sh
        printf '# customer ops\n' >infra/host/lib/customer-ops.sh
        printf '# core\n' >infra/host/lib/cd/core.sh
        printf '# bootstrap\n' >infra/host/bootstrap.sh
        printf '[Unit]\n' >infra/host/templates/systemd/x.service
        printf 'table inet x {}\n' >infra/host/templates/nftables/x.nft
        printf 'KEY=1\n' >infra/host/templates/env/x.env.tmpl
        printf 'name: ci\n' >.github/workflows/ci.yml
        printf '{"schemaVersion":1,"id":"board","runtime":{"version":"1.0.0","database":null,"export":null}}\n' >modules/board/module.json
        printf '{"schemaVersion":1,"id":"calendar","runtime":{"version":"1.0.0","database":{"postgresService":"calendar-postgres","migrations":"migrations"},"export":null}}\n' >modules/calendar/module.json
        printf 'data\n' >modules/vault/README.txt
        printf -- '-- gremion:phase expand\nSELECT 1;\n' >gremion-ui/migrations-control/001_a.sql
        printf -- '-- gremion:phase expand\nSELECT 1;\n' >gremion-ui/migrations/0001_a.sql
        printf -- '-- gremion:phase expand\nSELECT 1;\n' >platform-migrations/0001_p.sql
        printf -- '-- gremion:phase expand\nSELECT 1;\n' >services/kernel-api/migrations/core/0001_k.sql
        printf -- '-- gremion:phase expand\nSELECT 1;\n' >services/governance/migrations/0001_g.sql
        printf -- '-- gremion:phase expand\nSELECT 1;\n' >modules/board/migrations/001_init.sql
        printf -- '-- gremion:phase expand\nSELECT 1;\n' >modules/calendar/migrations/001_init.sql
        jq -n -S '{chains: [
            {id: "kernel-data", database: "kernel", dirs: ["gremion-ui/migrations"]},
            {id: "control", database: "control", dirs: ["gremion-ui/migrations-control"]},
            {id: "platform", database: "gremion_platform", dirs: ["platform-migrations"]},
            {id: "kernel-api", database: "service:kernel-api", dirs: ["services/kernel-api/migrations/core"]},
            {id: "governance", database: "service:governance", dirs: ["services/governance/migrations"]},
            {id: "mail", database: "service:mail", dirs: ["services/mail/migrations"]},
            {id: "module-board", database: "module:board", dirs: ["modules/board/migrations"]},
            {id: "module-calendar", database: "module:calendar", dirs: ["modules/calendar/migrations"]}]}' \
            >scripts/migrations/ranges.json
        jq -n -S '{chains: {"kernel-data": "legacy-boot", control: "legacy-boot", platform: "tenant-store",
            "kernel-api": "tenant-store", governance: "fresh-only", mail: "unadopted",
            "module-board": "unadopted", "module-calendar": "module-upgrade"}}' \
            >scripts/migrations/runner/chain-runners.json
        printf '{"waivers":[]}\n' >scripts/migrations/runner/lint-waivers.json
        local lock='{"frozenAt":"2026-01-01","chains":{}}' chain dir file
        while IFS=' ' read -r chain dir file; do
            lock="$(jq -c --arg c "$chain" --arg f "$file" --arg h "$(sha256sum "$dir/$file" | cut -d' ' -f1)" \
                '.chains[$c].files[$f] = $h' <<<"$lock")"
        done <<'EOF'
control gremion-ui/migrations-control 001_a.sql
kernel-data gremion-ui/migrations 0001_a.sql
platform platform-migrations 0001_p.sql
kernel-api services/kernel-api/migrations/core 0001_k.sql
governance services/governance/migrations 0001_g.sql
module-board modules/board/migrations 001_init.sql
module-calendar modules/calendar/migrations 001_init.sql
EOF
        lock="$(jq -c '.chains.mail = {files: {}}' <<<"$lock")"
        jq -S . <<<"$lock" >scripts/migrations/applied.lock.json
        cat >compose.canned.json <<'EOF'
{"name":"stack-state","services":{
 "postgres":{"image":"postgres:16","environment":{"POSTGRES_DB":"main","ROOT_HINT":"@TREE@/data"},
   "volumes":[{"type":"bind","source":"@TREE@/docker/postgres/init.sh","target":"/docker-entrypoint-initdb.d/init.sh","read_only":true},
              {"type":"volume","source":"pgdata","target":"/var/lib/postgresql/data"}]},
 "legal":{"image":"legal:dev","build":{"context":"@TREE@/docker/legal"},"environment":{"MODE":"static"}},
 "nats":{"image":"nats:2","environment":{"A":"1"}}},
 "networks":{"default":{"name":"stack_default"}},"volumes":{"pgdata":{"name":"stack_pgdata"}}}
EOF
    ) || return 1
    cls_commit "$d" base
}

cls_setup() {
    cd_setup
    export STACK=teststack
    export TMPDIR="${GREMION_ROOT}/tmp"
    mkdir -p "$TMPDIR" "${GREMION_ROOT}/releases"
    printf 'COMPOSE_PROJECT_NAME=teststack-state\n' >"${GREMION_ROOT}/etc/env/state.env"
    chmod 600 "${GREMION_ROOT}/etc/env/state.env"
    CLS_OLD="${GREMION_ROOT}/releases/aaaaaaaaaaaa"
    CLS_NEW="${GREMION_ROOT}/releases/bbbbbbbbbbbb"
    cp -a "${CLS_BASE}" "$CLS_OLD"
    cp -a "${CLS_BASE}" "$CLS_NEW"
    # The shim is the real compose in the two ways the classifier depends on: a missing
    # env_file is an error unless --no-env-resolution is given (the rendered env files are
    # written by gremion-render, after classify), and a tree may ask for a slow answer.
    # shellcheck disable=SC2016  # the shim body is a script, expanded when the shim runs
    shim docker 'case "$1" in
  compose)
    if [ -f "$PWD/.compose.fail" ]; then echo "boom" >&2; exit 1; fi
    f="$PWD/compose.canned.json"
    [ -f "$f" ] || exit 1
    out="$(sed "s#@TREE@#$PWD#g" "$f")"
    case " $* " in
      *" --no-env-resolution "*) ;;
      *)
        for p in $(printf "%s" "$out" | jq -r "[.services[]?.env_file[]?.path] | .[]" 2>/dev/null); do
          if [ ! -f "$p" ]; then echo "env file $p not found" >&2; exit 1; fi
        done ;;
    esac
    printf "%s\n" "$out"
    if [ -f "$PWD/.compose.slow" ]; then sleep 8; fi
    exit 0 ;;
esac
exit 0'
    cls_manifest "$CLS_OLD" "${GREMION_ROOT}/data/cd/host-manifest.json"
}

cls_teardown() { cd_teardown; }

# cls_manifest TREE OUT -- the host manifest of a tree, computed here with find (an oracle
# independent of the library's own listing).
cls_manifest() {
    local tree="$1" out="$2"
    (
        cd "$tree" || exit 1
        { find infra/host/bin infra/host/lib infra/host/templates/systemd infra/host/templates/nftables \
            infra/host/templates/env -type f 2>/dev/null
          echo infra/host/bootstrap.sh; } | LC_ALL=C sort | while IFS= read -r f; do
            printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
        done
    ) | jq -R -s -c '{v: 1, applied_at: "2026-01-01T00:00:00Z", sha12: "aaaaaaaaaaaa",
        files: (split("\n") | map(select(length > 0) | capture("^(?<h>[0-9a-f]{64})  (?<p>.+)$")) | map({key: .p, value: .h}) | from_entries)}' \
        >"$out"
}

# cls_chain_file TREE CHAIN FILE PHASE [CLASS_LOCK_ONLY] -- a new migration file (header
# line PHASE; PHASE `none` writes no header) in the first directory of the chain, and its
# entry in the lock.
cls_chain_file() {
    local tree="$1" chain="$2" file="$3" phase="$4" dir sum
    dir="$(jq -r --arg c "$chain" '.chains[] | select(.id == $c) | .dirs[0]' "${tree}/scripts/migrations/ranges.json")"
    mkdir -p "${tree}/${dir}"
    if [[ "$phase" == none ]]; then
        printf 'SELECT 2;\n' >"${tree}/${dir}/${file}"
    else
        printf -- '-- gremion:phase %s\nSELECT 2;\n' "$phase" >"${tree}/${dir}/${file}"
    fi
    sum="$(sha256sum "${tree}/${dir}/${file}" | cut -d' ' -f1)"
    jq -S --arg c "$chain" --arg f "$file" --arg h "$sum" '.chains[$c].files[$f] = $h' \
        "${tree}/scripts/migrations/applied.lock.json" >"${tree}/.lock.tmp"
    mv "${tree}/.lock.tmp" "${tree}/scripts/migrations/applied.lock.json"
}

cls_class() {
    local tree="$1"
    jq -S --arg c "$2" --arg k "$3" '.chains[$c] = $k' "${tree}/scripts/migrations/runner/chain-runners.json" >"${tree}/.cls.tmp"
    mv "${tree}/.cls.tmp" "${tree}/scripts/migrations/runner/chain-runners.json"
}

# cls_compose TREE JQ_FILTER -- edit the canned compose answer of a tree.
cls_compose() {
    jq -c "$2" "$1/compose.canned.json" >"$1/.cc.tmp"
    mv "$1/.cc.tmp" "$1/compose.canned.json"
}

# the script of cls_run: one place, so the signal test runs the very same one
# shellcheck disable=SC2016  # the script is expanded by the bash that runs it
CLS_SCRIPT='set -euo pipefail
. "${HOST_SRC}/lib/common.sh"
. "${HOST_SRC}/lib/cd/core.sh"
. "${HOST_SRC}/lib/cd/docker.sh"
. "${HOST_SRC}/lib/cd/classify.sh"
. "${GREMION_CD_STUBS_DIR}/cd-stubs.sh"
cd_paths_init
cd_classify "$@"'

# cls_run [ARGS...] -- cd_classify OLD NEW ARGS, against the real library files.
cls_run() {
    bash -c "$CLS_SCRIPT" cls-run "$CLS_OLD" "$CLS_NEW" "$@"
}

# cls_is JQ_EXPR -- the last `run` output is exactly one JSON document and satisfies the jq
# expression (slurped, because jq 1.6 answers 0 for -e on empty input: an empty output
# would pass every assertion).
# shellcheck disable=SC2154  # $output is set by bats' `run`
cls_is() { jq -e -s "length == 1 and (.[0] | ${1})" <<<"$output" >/dev/null; }
