#!/usr/bin/env bash
# infra/host/lib/executor/handlers/disable_module.sh — the `disable_module`
# request (TRD-044, PRD-OPS-004: "Modul deaktivieren"). SOURCED, NEVER EXECUTED.
#
# handle_disable_module <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args: {slug, module} and, for a
#   council admin's request, actorKind "person" (forwarded as --actor-kind;
#   request-verify refuses a council disable until phase 2). The SAME
#   customer_disable_module the break-glass path runs: the container's
#   disable-module verb (the level-1 switch off, the module database EXPORTED
#   and verified, only then BLOCKED, not dropped: the 30-day Karenz opens and
#   gremion-karenz.timer drops the database on day 30 once KARENZ_FINAL_DELETION
#   is on; the broker users shrunk), with the TRD-440 fingerprint asserted
#   around it. The verb refuses, nothing touched, when the export directory is
#   not a mounted volume. A failed export leaves the database in place and the
#   row `disabling`; the same request again resumes with a fresh export, and a
#   disabled module is a no-op (idempotent: a second disable keeps the first
#   Karenz and its final day).
handle_disable_module() {
    # shellcheck disable=SC2034  # the handler signature is the registry's: <id> <slug> <operator> <args> <work>
    local id="$1" slug="$2" operator="$3" args="$4" work="$5"
    [[ -f "$args" ]] || die "disable_module ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "disable_module ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    local module actor_kind
    module="$(jq -er '.module | strings' "$args")" \
        || die "disable_module ${id}: the verified args carry no module" "$GREMION_EXIT_ASSERT"
    actor_kind="$(jq -r '.actorKind // "operator"' "$args")"
    [[ "$actor_kind" =~ ^(operator|person)$ ]] \
        || die "disable_module ${id}: the verified args carry an unknown actor kind" "$GREMION_EXIT_ASSERT"
    local -a argv=("$slug" "$module" --operator "$operator")
    if [[ "$actor_kind" == person ]]; then argv+=(--actor-kind person); fi
    customer_disable_module "${argv[@]}"
}
