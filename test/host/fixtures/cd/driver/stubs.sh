#!/usr/bin/env bash
# test/host/fixtures/cd/driver/stubs.sh -- appended to the helper's stub file by cd-driver.bats.
#
# The helper's stubs return one fixed code per process and write no state. A driver test needs
# more: "fail, then succeed", a kill at a boundary, a commit that writes committed_at, a probe
# of the locks from inside a stage. This file redefines the stub body (a later definition wins)
# so that a stub can also
#   - run a HOOK: CD_STUB_HOOK_<fn> is a string of shell, evaluated inside the stub (it may
#     `return N`; falling through goes on to the default answer);
#   - answer from a SEQUENCE: CD_STUB_SEQ_<fn>="4 0" returns 4 the first time and 0 after
#     (the last word repeats).
# The hooks do the writes that the real units own (commit step 5, switch_started, ...), so the
# driver is tested against a stand-in that behaves like the contract in the plan.

_cd_stub_call() {
    local fn="$1" rcv outv hookv seqv n f
    local -a words=()
    shift
    printf 'stub %s %s\n' "$fn" "$*" >> "${SHIM_LOG:-/dev/null}"
    hookv="CD_STUB_HOOK_${fn}"
    if [[ -n "${!hookv:-}" ]]; then
        eval "${!hookv}"
    fi
    outv="CD_STUB_OUT_${fn}"
    if [[ -n "${!outv:-}" ]]; then
        printf '%s\n' "${!outv}"
    fi
    seqv="CD_STUB_SEQ_${fn}"
    if [[ -n "${!seqv:-}" ]]; then
        f="${GREMION_ROOT}/.seq-${fn}"
        n=0
        [[ -r "$f" ]] && read -r n < "$f"
        printf '%s\n' "$((n + 1))" > "$f"
        read -r -a words <<< "${!seqv}"
        ((n >= ${#words[@]})) && n=$((${#words[@]} - 1))
        return "${words[n]}"
    fi
    rcv="CD_STUB_RC_${fn}"
    return "${!rcv:-0}"
}

# -- what a hook may call ---------------------------------------------------------------

# drv_lockstate -- "host=HELD|FREE cd=HELD|FREE", read through fresh opens of the lock files, so
# it sees what this very process holds.
drv_lockstate() {
    local h=HELD c=HELD
    if ( exec 9>>"${GREMION_ROOT}/runtime/hostd.lock"; flock -n 9 ); then h=FREE; fi
    if ( exec 8>>"${GREMION_ROOT}/runtime/cd/cd.lock"; flock -n 8 ); then c=FREE; fi
    printf 'host=%s cd=%s' "$h" "$c"
}

# drv_probe NAME -- one line in the shim log: the lock state at this point of the pipeline.
drv_probe() { printf 'probe %s %s\n' "$1" "$(drv_lockstate)" >> "${SHIM_LOG}"; }

# drv_switch_started -- what cd_traffic_switch writes before it calls gremion-switch.
drv_switch_started() { cd_state_set '.release.switch_started = true'; }

# drv_step5 -- commit step 5: live = the release, previous = the old live, committed_at.
drv_step5() {
    cd_state_set '.previous = (.live | if . == null then null else {sha: .sha, sha12: .sha12, tag: .tag, colour: .colour, tree: .tree, startable: true} end)
        | .live = {sha: .release.sha, sha12: .release.sha12, tag: .release.tag, colour: .release.colour,
                   tree: .release.tree, since: $t, proof: false, modules: null, leaves: null, reconcile: null}
        | .release.committed_at = $t' --arg t "$(cd_iso)"
}

# drv_killme -- kill -9 of the whole program, from inside a stub.
drv_killme() { kill -9 $$; }
