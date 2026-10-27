#!/usr/bin/env bash
# infra/host/lib/executor/handlers/seed_vertical.sh — the `seed_vertical`
# request (TASK-031): adopt a customer's single root and create a vertical's
# other organisational units, merge the vertical's wording. SOURCED, NEVER
# EXECUTED.
#
# handle_seed_vertical <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json>: slug, vertical. The container's seed-vertical verb is
#   idempotent (a rerun creates nothing); it takes no member list, so no dump.
#   Whether a matrix room / Nextcloud folder is asked for is decided inside the
#   container from the tenant's enabled modules (D-8), never here.
handle_seed_vertical() {
    # shellcheck disable=SC2034  # the handler signature is the registry's: <id> <slug> <operator> <args> <work>
    local id="$1" slug="$2" operator="$3" args="$4" work="$5" vertical out line rc=0
    [[ -f "$args" ]] || die "seed_vertical ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "seed_vertical ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    vertical="$(jq -r '.vertical' "$args")"
    if declare -F executor_step >/dev/null; then executor_step seed; fi
    out="$(tc seed-vertical "$slug" --vertical "$vertical" < /dev/null)" || rc=$?
    line="$(grep '^{' <<< "$out" | tail -n 1 || true)"
    [[ -n "$line" ]] || die "seed_vertical ${id}: seed-vertical printed no result (exit ${rc})" "$GREMION_EXIT_ASSERT"
    jq -r '"seed: status=\(.status) units_created=\(.units.created // 0) units_adopted=\(.units.adopted // 0) units_present=\(.units.present // 0) kinds_upserted=\(.kinds.upserted // 0) seats_created=\(.seats.created // 0) terms_written=\(.terms_written // false)"' <<< "$line"
    jq -r 'select(.error) | "  error: \(.error)"' <<< "$line"
    if [[ "$rc" -ne 0 ]] || ! jq -e '.status == "applied"' <<< "$line" >/dev/null; then
        die "seed_vertical ${id}: the seed did not apply (exit ${rc})" "$GREMION_EXIT_ASSERT"
    fi
    ok "vertical ${vertical} seeded for ${slug}"
}
