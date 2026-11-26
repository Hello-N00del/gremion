#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-files-namespace: the operator program that moves the Nextcloud group
# folders and groups of every customer into the per-customer namespace. Unit only: docker is a stand-in
# (test/host/fixtures/files-namespace/fake-docker) that plays the state postgres and the Nextcloud
# container from files in a throwaway directory, so what is asserted is what the program asked for and
# what state it left behind. Nothing here needs root or a real daemon.
# Run: bats test/host/files-namespace.bats

load 'test_helper/host'

# two customers on one install, and the key of each (sha256 of the tenant id, 10 hex digits; the same
# vector is asserted by modules/files/app/lib/server/files/namespace.test.ts)
TA='0192f0c4-0000-7000-8000-000000000001'; HA='0192f0c4000070008000000000000001'; KA='1efb7da1c9'
TB='0192f0c4-0000-7000-8000-000000000002'; HB='0192f0c4000070008000000000000002'; KB='f6ddcbee9b'

UA1='aaaaaaaa-0000-4000-8000-0000000000a1'   # alpha: "Vorstand", legacy folder 12
UA2='aaaaaaaa-0000-4000-8000-0000000000a2'   # alpha: "Referat Finanzen", legacy folder 13, permissions 15
UA3='aaaaaaaa-0000-4000-8000-0000000000a3'   # alpha: a unit whose binding a module switch-off keeps (folder 16)
UB1='bbbbbbbb-0000-4000-8000-0000000000b1'   # beta: legacy folder 14
UB2='bbbbbbbb-0000-4000-8000-0000000000b2'   # beta: made after the namespace, folder 15

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    mkdir -p "${REL}/infra/host/bin" "${REL}/infra/host/lib/executor"
    cp "${HOST_SRC}/lib/common.sh" "${HOST_SRC}/lib/customer-ops.sh" "${HOST_SRC}/lib/access-log.sh" "${REL}/infra/host/lib/"
    cp "${HOST_SRC}/lib/executor/db.sh" "${REL}/infra/host/lib/executor/"
    cp "${HOST_SRC}/bin/gremion-files-namespace" "${REL}/infra/host/bin/"
    PROG="${REL}/infra/host/bin/gremion-files-namespace"
    export GREMION_EXECUTOR_PG_CONTAINER=fx-pg
    printf 'STACK=fxstack\nPOSTGRES_USER=postgres\nCONTROL_DB_NAME=control\n' > "${GREMION_ROOT}/etc/env/state.env"

    FAKE="${GREMION_ROOT}/fake"; export FAKE
    mkdir -p "$FAKE"
    cp "${KERNEL_ROOT}/test/host/fixtures/files-namespace/fake-docker" "${SHIM_DIR}/docker"
    chmod +x "${SHIM_DIR}/docker"
    seed_world
}

teardown() {
    teardown_host_root
}

# seed_world -- the install before the migration. Folder 12 and 13 are alpha's, 14 is beta's, 15 is beta's
# and already in the namespace, 16 is alpha's and only a Karenz binding names it.
seed_world() {
    printf '%s alpha\n%s beta\n' "$TA" "$TB" > "$FAKE/tenants.txt"
    cat > "$FAKE/folders.json" <<JSON
[
  {"id": 12, "mount_point": "Vorstand",          "groups": {"ou-${UA1}": 31}},
  {"id": 13, "mount_point": "Referat Finanzen",  "groups": {"ou-${UA2}": 15}},
  {"id": 14, "mount_point": "Studierendenrat",   "groups": {"ou-${UB1}": 31}},
  {"id": 15, "mount_point": "Vorstand (${KB})",  "groups": {"ou-${KB}-${UB2}": 31}},
  {"id": 16, "mount_point": "Archiv",            "groups": {"ou-${UA3}": 31}}
]
JSON
    cat > "$FAKE/groups.json" <<JSON
{
  "ou-${UA1}": ["m1", "m2"],
  "ou-${UA2}": ["m3"],
  "ou-${UA3}": ["m6"],
  "ou-${UB1}": ["m4"],
  "ou-${KB}-${UB2}": ["m5"]
}
JSON
    printf '%s 12:ou-%s\n%s 13:ou-%s\n' "$UA1" "$UA1" "$UA2" "$UA2" > "$FAKE/ledger-$HA.txt"
    printf '%s 14:ou-%s\n%s 15:ou-%s-%s\n' "$UB1" "$UB1" "$UB2" "$KB" "$UB2" > "$FAKE/ledger-$HB.txt"
    printf '%s 12:ou-%s\n%s 16:ou-%s\n' "$UA1" "$UA1" "$UA3" "$UA3" > "$FAKE/karenz-$HA.txt"
    : > "$FAKE/karenz-$HB.txt"
}

# state_sum -- every file that is Nextcloud's or the ledger's state, as one hash.
state_sum() {
    ( cd "$FAKE" && cat folders.json groups.json ledger-*.txt karenz-*.txt | sha256sum )
}

apply() { run "$PROG" --apply --backed-up --reason "namespace migration for the shared Nextcloud" "$@"; }
mount_of() { jq -r --argjson id "$1" '.[] | select(.id == $id) | .mount_point' "$FAKE/folders.json"; }
groups_of() { jq -r --argjson id "$1" '.[] | select(.id == $id) | .groups | keys | join(",")' "$FAKE/folders.json"; }
bits_of() { jq -r --argjson id "$1" --arg g "$2" '.[] | select(.id == $id) | .groups[$g]' "$FAKE/folders.json"; }
members_of() { jq -r --arg g "$1" '.[$g] // [] | sort | join(",")' "$FAKE/groups.json"; }
# group_gone <gid> -- fails, saying so, when Nextcloud still has the group
group_gone() {
    if jq -e --arg g "$1" 'has($g)' "$FAKE/groups.json" >/dev/null; then
        echo "the group $1 still exists"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# the key
# ---------------------------------------------------------------------------

@test "--key-of prints the same key as namespace.ts: sha256 of the lower-case tenant id, 10 hex digits" {
    run "$PROG" --key-of "$TA"
    [ "$status" -eq 0 ]
    [ "$output" = "$KA" ]
    run "$PROG" --key-of "${TB^^}"
    [ "$status" -eq 0 ]
    [ "$output" = "$KB" ]
}

# ---------------------------------------------------------------------------
# the dry run
# ---------------------------------------------------------------------------

@test "the dry run lists the renames and the group moves of every customer and changes nothing" {
    before="$(state_sum)"
    run "$PROG"
    [ "$status" -eq 0 ]
    [[ "$output" == *"mode: dry run"* ]]
    [[ "$output" == *"PLAN alpha unit ${UA1} folder 12: mount point \"Vorstand\" -> \"Vorstand (${KA})\""* ]]
    [[ "$output" == *"PLAN alpha unit ${UA1} folder 12: group ou-${UA1} -> ou-${KA}-${UA1} (permissions 31)"* ]]
    [[ "$output" == *"PLAN alpha unit ${UA1} folder 12: ledger and binding 12:ou-${UA1} -> 12:ou-${KA}-${UA1}"* ]]
    [[ "$output" == *"PLAN alpha unit ${UA2} folder 13: mount point \"Referat Finanzen\" -> \"Referat Finanzen (${KA})\""* ]]
    [[ "$output" == *"group ou-${UA2} -> ou-${KA}-${UA2} (permissions 15)"* ]]
    [[ "$output" == *"PLAN alpha unit ${UA3} folder 16: mount point \"Archiv\" -> \"Archiv (${KA})\""* ]]
    [[ "$output" == *"PLAN beta unit ${UB1} folder 14: mount point \"Studierendenrat\" -> \"Studierendenrat (${KB})\""* ]]
    [[ "$output" == *"OK   beta unit ${UB2} folder 15: already in the namespace"* ]]
    [[ "$output" == *"files-namespace: mode=dry-run tenants=2 folders=5 to-move=4 already=1 problems=0"* ]]
    [ "$(state_sum)" = "$before" ]
    [ ! -s "$FAKE/nc-changes.log" ]
    [ ! -s "$FAKE/sql-changes.log" ]
    [ ! -s "$FAKE/access.log" ]
}

@test "the dry run reads the same whichever shape Nextcloud answers the folder list in" {
    touch "$FAKE/array-shape"
    run "$PROG"
    [ "$status" -eq 0 ]
    [[ "$output" == *"to-move=4 already=1 problems=0"* ]]
}

@test "--slug limits the run to one customer" {
    run "$PROG" --slug beta
    [ "$status" -eq 0 ]
    [[ "$output" == *"tenants=1 folders=2 to-move=1 already=1"* ]]
    [[ "$output" != *"PLAN alpha"* ]]
}

# ---------------------------------------------------------------------------
# --apply: its guards
# ---------------------------------------------------------------------------

@test "--apply is refused without --backed-up, and without a reason; nothing is changed" {
    before="$(state_sum)"
    run "$PROG" --apply --reason "namespace migration for the shared Nextcloud"
    [ "$status" -eq 2 ]
    [[ "$output" == *"--backed-up"* ]]
    run "$PROG" --apply --backed-up
    [ "$status" -eq 2 ]
    [[ "$output" == *"--reason"* ]]
    run "$PROG" --apply --backed-up --reason short
    [ "$status" -eq 2 ]
    [ "$(state_sum)" = "$before" ]
    [ ! -s "$FAKE/nc-changes.log" ]
}

@test "--apply refuses while another host operation holds the host lock (exit 3, nothing changed)" {
    hold_host_lock 8
    before="$(state_sum)"
    FILES_NAMESPACE_LOCK_WAIT=1 apply
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED"* ]]
    [ "$(state_sum)" = "$before" ]
}

# ---------------------------------------------------------------------------
# --apply: what it does
# ---------------------------------------------------------------------------

@test "--apply renames every mount point, moves every group with its members and permission bits, and repoints the ledger and the Karenz binding" {
    apply
    [ "$status" -eq 0 ]
    [[ "$output" == *"files-namespace: mode=apply tenants=2 folders=5 to-move=4 already=1 problems=0"* ]]
    # the mount points carry the key of the folder's own customer
    [ "$(mount_of 12)" = "Vorstand (${KA})" ]
    [ "$(mount_of 13)" = "Referat Finanzen (${KA})" ]
    [ "$(mount_of 14)" = "Studierendenrat (${KB})" ]
    [ "$(mount_of 15)" = "Vorstand (${KB})" ]
    [ "$(mount_of 16)" = "Archiv (${KA})" ]
    # each folder carries only its new group, with the bits the old group had
    [ "$(groups_of 12)" = "ou-${KA}-${UA1}" ]
    [ "$(bits_of 13 "ou-${KA}-${UA2}")" = "15" ]
    [ "$(groups_of 14)" = "ou-${KB}-${UB1}" ]
    [ "$(groups_of 15)" = "ou-${KB}-${UB2}" ]
    # the members came along, the old groups are gone
    [ "$(members_of "ou-${KA}-${UA1}")" = "m1,m2" ]
    [ "$(members_of "ou-${KA}-${UA2}")" = "m3" ]
    [ "$(members_of "ou-${KB}-${UB1}")" = "m4" ]
    [ "$(members_of "ou-${UA1}")" = "" ]
    group_gone "ou-${UA1}"
    # the ledger and the Karenz binding name the new group; the folder id never changed
    grep -qx "${UA1} 12:ou-${KA}-${UA1}" "$FAKE/ledger-$HA.txt"
    grep -qx "${UA2} 13:ou-${KA}-${UA2}" "$FAKE/ledger-$HA.txt"
    grep -qx "${UA1} 12:ou-${KA}-${UA1}" "$FAKE/karenz-$HA.txt"
    grep -qx "${UA3} 16:ou-${KA}-${UA3}" "$FAKE/karenz-$HA.txt"
    grep -qx "${UB1} 14:ou-${KB}-${UB1}" "$FAKE/ledger-$HB.txt"
    # the access record of each customer was written, and the pre-change state kept
    [ "$(grep -c 'files_namespace' "$FAKE/access.log")" -eq 2 ]
    backup="$(ls "${GREMION_ROOT}"/runtime/files-namespace/*.json)"
    [ "$(stat -c %a "$backup")" = "600" ]
    jq -e '.folders | length == 5' "$backup" >/dev/null
}

@test "--apply a second time changes nothing: every folder is found already in the namespace" {
    apply
    [ "$status" -eq 0 ]
    after_first="$(state_sum)"
    : > "$FAKE/nc-changes.log"
    : > "$FAKE/sql-changes.log"
    apply
    [ "$status" -eq 0 ]
    [[ "$output" == *"to-move=0 already=5 problems=0"* ]]
    [ "$(state_sum)" = "$after_first" ]
    [ ! -s "$FAKE/nc-changes.log" ]
    [ ! -s "$FAKE/sql-changes.log" ]
}

@test "a folder whose move stopped after the ledger moved is finished by the next run (the old group is taken off and deleted)" {
    apply
    [ "$status" -eq 0 ]
    # put the old group back, as an interrupted run would have left it
    jq --arg g "ou-${UA1}" '.[$g] = ["m1"]' "$FAKE/groups.json" > "$FAKE/g.tmp" && mv "$FAKE/g.tmp" "$FAKE/groups.json"
    jq --arg g "ou-${UA1}" 'map(if .id == 12 then .groups[$g] = 31 else . end)' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    apply
    [ "$status" -eq 0 ]
    [ "$(groups_of 12)" = "ou-${KA}-${UA1}" ]
    group_gone "ou-${UA1}"
}

# ---------------------------------------------------------------------------
# --apply: the cases it must not guess about
# ---------------------------------------------------------------------------

@test "a folder carrying ANOTHER customer's key is a PROBLEM and is left alone" {
    jq --arg m "Vorstand (${KB})" 'map(if .id == 12 then .mount_point = $m else . end)' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    apply
    [ "$status" -eq 1 ]
    [[ "$output" == *"PROBLEM alpha unit ${UA1}: folder 12 (\"Vorstand (${KB})\") carries another customer's key; left alone"* ]]
    [ "$(mount_of 12)" = "Vorstand (${KB})" ]
    [ "$(groups_of 12)" = "ou-${UA1}" ]
    # the others were still moved
    [ "$(mount_of 14)" = "Studierendenrat (${KB})" ]
}

@test "a ledger folder that is not on Nextcloud is a PROBLEM, not a guess" {
    jq 'map(select(.id != 13))' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    run "$PROG"
    [ "$status" -eq 1 ]
    [[ "$output" == *"folder 13 is not on Nextcloud"* ]]
}

@test "a folder that does not carry its recorded group is a PROBLEM and keeps its name" {
    jq 'map(if .id == 14 then .groups = {} else . end)' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    apply
    [ "$status" -eq 1 ]
    [[ "$output" == *"folder 14 does not carry the recorded group"* ]]
    [ "$(mount_of 14)" = "Studierendenrat" ]
}

@test "a target name that another folder already holds is a PROBLEM" {
    jq --arg m "Vorstand (${KA})" 'map(if .id == 14 then .mount_point = $m else . end)' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    run "$PROG" --slug alpha
    [ "$status" -eq 1 ]
    [[ "$output" == *"the name \"Vorstand (${KA})\" is already taken by another folder"* ]]
}

@test "a group whose members cannot be read stops the run before anything is removed" {
    touch "$FAKE/group-unreadable"
    apply
    [ "$status" -eq 1 ]
    # nothing was deleted: not a group, not a folder's group
    [ "$(groups_of 12)" = "ou-${UA1}" ]
    [ "$(members_of "ou-${UA1}")" = "m1,m2" ]
    if grep -q '^DELETE' "$FAKE/nc-changes.log"; then echo 'something was deleted'; return 1; fi
}

@test "a refused rename stops the run and leaves the ledger as it was" {
    touch "$FAKE/refuse-rename"
    apply
    [ "$status" -eq 1 ]
    [ "$(mount_of 12)" = "Vorstand" ]
    grep -qx "${UA1} 12:ou-${UA1}" "$FAKE/ledger-$HA.txt"
}

@test "a customer database that cannot be read is a PROBLEM for that customer; the others are still planned" {
    touch "$FAKE/db-missing-$HA"
    run "$PROG"
    [ "$status" -eq 1 ]
    [[ "$output" == *"PROBLEM alpha: the ledger in t_${HA}__kernel could not be read"* ]]
    [[ "$output" == *"PLAN beta unit ${UB1} folder 14"* ]]
}

@test "--apply refuses to start while any customer's ledger cannot be read, selected or not; nothing is changed" {
    seed_one_folder_in_both_ledgers
    touch "$FAKE/db-missing-$HA"
    before="$(state_sum)"
    apply --slug beta
    [ "$status" -ne 0 ]
    [[ "$output" == *"alpha"* ]]
    [[ "$output" == *"could not be read"* ]]
    [ "$(state_sum)" = "$before" ]
    [ "$(mount_of 20)" = "Vorstand (Demo)" ]
    [ "$(groups_of 20)" = "ou-${SEED}" ]
    [ "$(members_of "ou-${SEED}")" = "ua,ub" ]
    apply
    [ "$status" -ne 0 ]
    [ "$(state_sum)" = "$before" ]
    [ ! -e "${GREMION_ROOT}/runtime/files-namespace" ] || [ -z "$(ls -A "${GREMION_ROOT}/runtime/files-namespace")" ]
}

@test "a group carried by two customers' folders is copied by roster and deleted only after the last one" {
    SEED='aaaaaaaa-0000-0000-0000-000000000002'
    jq --arg g "ou-${SEED}" '. + [{"id": 20, "mount_point": "Vorstand (Demo)", "groups": {($g): 31}}]' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    jq --arg g "ou-${SEED}" '. + [{"id": 21, "mount_point": "Gremium (Demo)", "groups": {($g): 31}}]' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    jq --arg g "ou-${SEED}" '.[$g] = ["ua", "ub"]' "$FAKE/groups.json" > "$FAKE/g.tmp" && mv "$FAKE/g.tmp" "$FAKE/groups.json"
    printf '%s 20:ou-%s\n' "$SEED" "$SEED" >> "$FAKE/ledger-$HA.txt"
    printf '%s 21:ou-%s\n' "$SEED" "$SEED" >> "$FAKE/ledger-$HB.txt"
    printf 'ua\n' > "$FAKE/roster-$HA-$SEED.txt"
    printf 'ub\n' > "$FAKE/roster-$HB-$SEED.txt"
    apply
    [ "$status" -eq 0 ]
    # each new group holds ONLY its own customer's person
    [ "$(members_of "ou-${KA}-${SEED}")" = "ua" ]
    [ "$(members_of "ou-${KB}-${SEED}")" = "ub" ]
    # the shared old group went with the last folder that carried it
    group_gone "ou-${SEED}"
    [[ "$output" == *"KEPT alpha unit ${SEED}: group ou-${SEED} stays, another folder still carries it"* ]]
}

# two customers built from the same seed carry the same unit id, and the old adopt rule could leave both
# ledgers on ONE folder (20): nobody can say whose it is
seed_one_folder_in_both_ledgers() {
    SEED='aaaaaaaa-0000-0000-0000-000000000002'
    jq --arg g "ou-${SEED}" '. + [{"id": 20, "mount_point": "Vorstand (Demo)", "groups": {($g): 31}}]' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    jq --arg g "ou-${SEED}" '.[$g] = ["ua", "ub"]' "$FAKE/groups.json" > "$FAKE/g.tmp" && mv "$FAKE/g.tmp" "$FAKE/groups.json"
    printf '%s 20:ou-%s\n' "$SEED" "$SEED" >> "$FAKE/ledger-$HA.txt"
    printf '%s 20:ou-%s\n' "$SEED" "$SEED" >> "$FAKE/ledger-$HB.txt"
    printf 'ua\n' > "$FAKE/roster-$HA-$SEED.txt"
    printf 'ub\n' > "$FAKE/roster-$HB-$SEED.txt"
}

@test "a folder that the ledgers of two customers both name is a PROBLEM for both, in the dry run and with --apply, and is left as it is" {
    seed_one_folder_in_both_ledgers
    run "$PROG"
    [ "$status" -eq 1 ]
    [[ "$output" == *"PROBLEM alpha unit ${SEED}: folder 20 is named in the ledgers of more than one customer (alpha, beta); left alone"* ]]
    [[ "$output" == *"PROBLEM beta unit ${SEED}: folder 20 is named in the ledgers of more than one customer (alpha, beta); left alone"* ]]
    [[ "$output" == *"to-move=4 already=1 problems=2"* ]]
    if [[ "$output" == *"PLAN alpha unit ${SEED}"* || "$output" == *"PLAN beta unit ${SEED}"* ]]; then echo 'the shared folder was planned'; return 1; fi
    apply
    [ "$status" -eq 1 ]
    [ "$(mount_of 20)" = "Vorstand (Demo)" ]
    [ "$(groups_of 20)" = "ou-${SEED}" ]
    [ "$(members_of "ou-${SEED}")" = "ua,ub" ]
    grep -qx "${SEED} 20:ou-${SEED}" "$FAKE/ledger-$HA.txt"
    grep -qx "${SEED} 20:ou-${SEED}" "$FAKE/ledger-$HB.txt"
    # the folders that only one customer names were still moved
    [ "$(mount_of 12)" = "Vorstand (${KA})" ]
    [ "$(mount_of 14)" = "Studierendenrat (${KB})" ]
}

@test "--slug does not hide a folder that another customer's ledger also names" {
    seed_one_folder_in_both_ledgers
    apply --slug alpha
    [ "$status" -eq 1 ]
    [[ "$output" == *"PROBLEM alpha unit ${SEED}: folder 20 is named in the ledgers of more than one customer (alpha, beta)"* ]]
    [ "$(mount_of 20)" = "Vorstand (Demo)" ]
    [ "$(groups_of 20)" = "ou-${SEED}" ]
}

@test "a ledger row that changed under the run is caught before the old group is taken off the folder" {
    touch "$FAKE/ledger-stale"
    apply
    [ "$status" -eq 1 ]
    [[ "$output" == *"held no row for folder 12:ou-${UA1}"* ]]
    # the old group is still on the folder and still has its members: nothing was removed
    [[ "$(groups_of 12)" == *"ou-${UA1}"* ]]
    [ "$(members_of "ou-${UA1}")" = "m1,m2" ]
    if grep -q '^DELETE' "$FAKE/nc-changes.log"; then echo 'something was deleted'; return 1; fi
}

@test "a shared old group whose members cannot be matched to the unit roster is not removed" {
    # a customer whose Nextcloud accounts carry a derived id: its roster holds the raw ids, so none of the
    # group's members matches and nothing is copied. That must stop the run, not read as "nobody is in it".
    SEED='aaaaaaaa-0000-0000-0000-000000000002'
    jq --arg g "ou-${SEED}" '. + [{"id": 20, "mount_point": "Vorstand (Demo)", "groups": {($g): 31}}, {"id": 21, "mount_point": "Gremium (Demo)", "groups": {($g): 31}}]' "$FAKE/folders.json" > "$FAKE/f.tmp" && mv "$FAKE/f.tmp" "$FAKE/folders.json"
    jq --arg g "ou-${SEED}" '.[$g] = ["derived-ua", "derived-ub"]' "$FAKE/groups.json" > "$FAKE/g.tmp" && mv "$FAKE/g.tmp" "$FAKE/groups.json"
    printf '%s 20:ou-%s\n' "$SEED" "$SEED" >> "$FAKE/ledger-$HA.txt"
    printf '%s 21:ou-%s\n' "$SEED" "$SEED" >> "$FAKE/ledger-$HB.txt"
    printf 'raw-ua\n' > "$FAKE/roster-$HA-$SEED.txt"
    printf 'raw-ub\n' > "$FAKE/roster-$HB-$SEED.txt"
    apply
    [ "$status" -ne 0 ]
    [[ "$output" == *"none of the members of ou-${SEED} is on the roster of unit ${SEED}"* ]]
    [ "$(members_of "ou-${SEED}")" = "derived-ua,derived-ub" ]
    [[ "$(groups_of 20)" == *"ou-${SEED}"* ]]
    grep -qx "${SEED} 20:ou-${SEED}" "$FAKE/ledger-$HA.txt"
}

@test "the Nextcloud admin password is never on an argv: curl reads its credentials from a stdin config" {
    run "$PROG"
    [ "$status" -eq 0 ]
    # the stand-in runs the program's own script with the container's environment; what curl was given:
    if grep -qxF -- '-u' "$FAKE/curl-args.last"; then echo 'curl was given -u'; return 1; fi
    if grep -qF 'p"w' "$FAKE/curl-args.last"; then echo 'the password is on curl argv'; return 1; fi
    grep -qxF -- '-K' "$FAKE/curl-args.last"
    grep -qxF 'user = "nc-admin:p\"w\\d"' "$FAKE/curl-stdin.last"
}
