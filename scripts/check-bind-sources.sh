#!/usr/bin/env bash
# ============================================================
# check-bind-sources.sh -- fail loudly, BEFORE `compose up`, when a compose
# file bind-mounts a host path that is not there.
#
# Why: compose creates a missing bind source as a root-owned DIRECTORY. A
# missing internal-ca.pem or userlist.txt therefore does not stop the stack, it
# starts it broken (a directory where a certificate or an auth file belongs).
#
# Usage:  scripts/check-bind-sources.sh [--root DIR] [--all] [compose-file...]
#   --root DIR   the tree the compose files live in (default: this checkout)
#   --all        check every compose file (docker-compose*.yml, compose/**)
#                instead of the dev set. Default dev set: docker-compose.yml,
#                docker-compose.override.yml, docker-compose.app.yml,
#                docker-compose.app.dev.yml (what `make up` runs).
#   files        explicit compose files, relative to --root
#
# Judged: bind sources written as a relative path (./x, ../x), resolved against
# the compose file's own directory. Not judged: named volumes, absolute paths,
# and ${VAR}-based sources (host-provisioned; gremion-init-secrets/bootstrap
# own those).
#
# A source that is missing is reported with the command that generates it, or
# "no generator" when the repo has none (a tracked file that was deleted).
#
# EXIT: 0 every source present - 1 something missing - 2 usage.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALL=0
FILES=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --root) [[ $# -ge 2 ]] || { echo "check-bind-sources: --root needs a value" >&2; exit 2; }
                ROOT="$(cd "$2" && pwd)"; shift 2 ;;
        --all)  ALL=1; shift ;;
        -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
        -*) echo "check-bind-sources: unknown option: $1" >&2; exit 2 ;;
        *)  FILES+=("$1"); shift ;;
    esac
done

if [[ ${#FILES[@]} -eq 0 ]]; then
    if [[ $ALL -eq 1 ]]; then
        while IFS= read -r f; do FILES+=("$f"); done < <(
            cd "$ROOT" && { ls docker-compose*.yml 2>/dev/null; find compose -name '*.yml' -path '*docker-compose*' -o -name 'standalone.yml' -o -name 'ops-link.yml' 2>/dev/null; } | sort -u)
    else
        FILES=(docker-compose.yml docker-compose.override.yml docker-compose.app.yml docker-compose.app.dev.yml)
    fi
fi

# source (root-relative) -> the command that makes it
generator_for() {
    case "$1" in
        docker/keycloak/certs/internal-ca.pem|docker/keycloak/certs/internal-ca.crt|docker/keycloak/certs/keycloak.crt|docker/keycloak/certs/keycloak.key)
            echo "bash docker/keycloak/certs/gen-internal-ca.sh   (make setup runs it)" ;;
        docker/pgbouncer/userlist.txt)
            echo "bash scripts/render-pgbouncer-userlist.sh   (make setup runs it; hosts: gremion-render)" ;;
        *) return 1 ;;
    esac
}

missing=0
checked=0
for rel in "${FILES[@]}"; do
    file="$ROOT/$rel"
    [[ -f "$file" ]] || continue
    dir="$(dirname "$rel")"
    # volume short syntax lines whose source starts with ./ or ../
    while IFS= read -r src; do
        [[ -n "$src" ]] || continue
        # normalise dir/src to a root-relative path without ./ and ../
        norm="$(cd "$ROOT" && realpath -m --relative-to="$ROOT" "$dir/$src")"
        checked=$((checked + 1))
        path="$ROOT/$norm"
        if [[ -d "$path" && -n "$(basename "$norm" | grep -E '\.[A-Za-z0-9]+$' || true)" ]]; then
            echo "MISSING $norm is a directory (compose created it?) -- a file belongs there; remove it, then: $(generator_for "$norm" || echo "no generator")   [$rel]"
            missing=$((missing + 1))
        elif [[ ! -e "$path" ]]; then
            if gen="$(generator_for "$norm")"; then
                echo "MISSING $norm -- generate with: $gen   [$rel]"
            else
                echo "MISSING $norm -- no generator in this repo (a tracked file was removed?)   [$rel]"
            fi
            missing=$((missing + 1))
        fi
    done < <(sed -nE 's/^[[:space:]]*-[[:space:]]+["'"'"']?(\.{1,2}\/[^:"'"'"'$]+):.*/\1/p' "$file" | sort -u)
done

if [[ $missing -gt 0 ]]; then
    echo "check-bind-sources: $missing bind-mount source(s) missing -- compose would create them as directories. Not starting." >&2
    exit 1
fi
echo "check-bind-sources: OK ($checked bind-mount source(s) present)"
