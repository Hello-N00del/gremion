#!/usr/bin/env bash
# services/kernel-api/test/bodies/proof.sh -- TASK-080-a live acceptance (plan s.6):
#
#   proof.sh up      PostgreSQL 18 + the authenticated NATS, containers t080-<sha8>-{pg,nats}
#   proof.sh test    builds the bundle, runs test/bodies/live.int.test.ts against the stack
#                    (own call; prints "[bodies-proof] N passing (minimum M)")
#   proof.sh down    removes exactly those containers (and their anonymous volumes) BY NAME
#   proof.sh status
#
# One verb per call (each stays well under 4 minutes). Plain `docker` only; never
# compose, never prune, never a gremion_* object; everything on 127.0.0.1.
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && (pwd -W 2>/dev/null || pwd))"
SERVICE="$(cd "$HERE/../.." && (pwd -W 2>/dev/null || pwd))"
REPO="$(cd "$SERVICE/../.." && (pwd -W 2>/dev/null || pwd))"
STATE="$REPO/.scratch/t080/state.json"
MINIMUM=12

case "${1:-}" in
  up)     node "$SERVICE/test/harness/live-stack.mjs" up ;;
  status) node "$SERVICE/test/harness/live-stack.mjs" status ;;
  down)   node "$SERVICE/test/harness/live-stack.mjs" down ;;
  test)
    [ -f "$STATE" ] || { echo "[bodies-proof] no stack: run proof.sh up first" >&2; exit 1; }
    SHA8="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).sha8)" "$STATE")"
    (cd "$SERVICE" && pnpm build >/dev/null)
    out="$(cd "$SERVICE" && T077_STATE="$STATE" T077_SCRATCH="$SHA8" T080_LIVE=1 pnpm exec vitest run --config vitest.live.config.ts --reporter=default 2>&1)" || { echo "$out"; echo "[bodies-proof] FAILED" >&2; exit 1; }
    echo "$out"
    passed="$(echo "$out" | sed -n 's/^ *Tests  *\([0-9]*\) passed.*/\1/p' | tail -1)"
    [ -n "$passed" ] && [ "$passed" -ge "$MINIMUM" ] || { echo "[bodies-proof] only ${passed:-0} passing (minimum $MINIMUM): a suite that collected too little is RED" >&2; exit 1; }
    echo "[bodies-proof] $passed passing (minimum $MINIMUM)"
    ;;
  *) echo "usage: proof.sh up | test | down | status" >&2; exit 2 ;;
esac
