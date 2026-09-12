#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-hostd — the host's only remote command surface.
# Run: bats test/host/hostd.bats
#
# Nothing here touches a real docker, nft, ssh or socat: every program hostd may
# invoke is a recording shim on PATH. The socket and the forced command are
# proven against running systems in test/host/integration/hostd-{socket,ssh}.sh.

load 'test_helper/host'

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
HOSTD="${REPO_ROOT}/infra/host/bin/gremion-hostd"
BOOTSTRAP="${REPO_ROOT}/infra/host/bootstrap.sh"
UNIT_TMPL="${REPO_ROOT}/infra/host/templates/systemd/gremion-hostd.service"

setup() {
    setup_host_root
    unset SSH_ORIGINAL_COMMAND
}

# setup_host_root mints a fresh mktemp -d per test; without this every run of
# this file leaves 40-odd directories behind in the system temp.
teardown() {
    teardown_host_root
}

# Feed one or more protocol lines to `gremion-hostd --ssh` on stdin.
hostd_stdin() {
    printf '%s\n' "$@" | "$HOSTD" --ssh
}

# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------

@test "gremion-hostd exists and carries a shebang" {
    [ -f "$HOSTD" ]
    head -n1 "$HOSTD" | grep -qF '#!/usr/bin/env bash'
}

@test "gremion-hostd runs under strict mode" {
    grep -qF 'set -euo pipefail' "$HOSTD"
}

@test "gremion-hostd sources the common library relative to its own directory" {
    grep -qF 'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"' "$HOSTD"
    grep -qF '. "$SCRIPT_DIR/../lib/common.sh"' "$HOSTD"
    # Task 14 Step 8 requires the bare directive form on its own line.
    grep -qxF '# shellcheck source=../lib/common.sh' "$HOSTD"
}

@test "gremion-hostd never evaluates a request" {
    # `! grep -q` on a MISSING file is vacuously true, so the negative assertion
    # below only means something once the file is known to exist.
    [ -f "$HOSTD" ]
    ! grep -qE '(^|[^[:alnum:]_])eval[[:space:]]' "$HOSTD"
}

@test "gremion-hostd without a mode is a usage error" {
    run "$HOSTD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: gremion-hostd --ssh | --socket | --serve"* ]]
}

# ---------------------------------------------------------------------------
# The allow-list is closed
# ---------------------------------------------------------------------------

@test "noop runs no program and answers EXIT 0" {
    shim gremion-deploy 'echo SHOULD-NOT-RUN'
    shim gremion-backup 'echo SHOULD-NOT-RUN'
    run hostd_stdin 'noop'
    [ "$status" -eq 0 ]
    [[ "$output" == *"noop ok"* ]]
    [[ "$output" == *"EXIT 0"* ]]
    [[ "$output" != *"SHOULD-NOT-RUN"* ]]
}

@test "commands outside the allow-list never reach a program" {
    shim gremion-deploy 'echo SHOULD-NOT-RUN'
    shim gremion-backup 'echo SHOULD-NOT-RUN'
    local bad
    for bad in 'bash -c id' 'sh' 'scp -t /opt/gremion/etc' 'rm -rf /' \
               'deploy;backup' 'backup && id' 'BACKUP' '../bin/gremion-backup' \
               'gremion-backup' '$(backup)'; do
        run hostd_stdin "$bad"
        [ "$status" -eq 2 ]
        [[ "$output" == *"EXIT 2"* ]]
        [[ "$output" == *"not permitted"* ]]
        [[ "$output" != *"SHOULD-NOT-RUN"* ]]
    done
}

@test "an empty request is refused" {
    run bash -c 'printf "" | "$1" --ssh' _ "$HOSTD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"empty request"* ]]
    [[ "$output" == *"EXIT 2"* ]]
}

@test "an unprintable or overlong request line is refused" {
    run bash -c 'printf "noop\x01\n" | "$1" --ssh' _ "$HOSTD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"malformed request line"* ]]

    run bash -c 'printf "noop %04097d\n" 1 | "$1" --ssh' _ "$HOSTD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"malformed request line"* ]]
}

@test "only the first command line of a connection is executed" {
    shim gremion-backup 'echo backup-ran'
    run hostd_stdin 'noop' 'backup'
    [ "$status" -eq 0 ]
    [[ "$output" == *"noop ok"* ]]
    [[ "$output" != *"backup-ran"* ]]
}

# ---------------------------------------------------------------------------
# deploy and the registry token
# ---------------------------------------------------------------------------

@test "deploy passes the tag as argv and the token on stdin (TOKEN first)" {
    shim gremion-deploy 'cat > "$BATS_TEST_TMPDIR/deploy-stdin"; echo deploy-ran'
    run hostd_stdin 'TOKEN itest-token-0123456789' 'deploy dist-v1.2.3'
    [ "$status" -eq 0 ]
    [[ "$output" == *"deploy-ran"* ]]
    [[ "$output" == *"EXIT 0"* ]]
    assert_recorded gremion-deploy "dist-v1.2.3"
    [ "$(cat "$BATS_TEST_TMPDIR/deploy-stdin")" = "itest-token-0123456789" ]
}

@test "deploy reads the token from the next line when none preceded it" {
    shim gremion-deploy 'cat > "$BATS_TEST_TMPDIR/deploy-stdin"; echo deploy-ran'
    run hostd_stdin 'deploy dist-v1.2.3' 'TOKEN itest-token-0123456789'
    [ "$status" -eq 0 ]
    [[ "$output" == *"deploy-ran"* ]]
    [ "$(cat "$BATS_TEST_TMPDIR/deploy-stdin")" = "itest-token-0123456789" ]
}

@test "deploy without any TOKEN line is refused and runs nothing" {
    shim gremion-deploy 'echo SHOULD-NOT-RUN'
    run hostd_stdin 'deploy dist-v1.2.3'
    [ "$status" -eq 2 ]
    [[ "$output" == *"deploy needs a TOKEN line"* ]]
    [[ "$output" != *"SHOULD-NOT-RUN"* ]]
}

@test "a token of the wrong shape is refused without echoing it" {
    shim gremion-deploy 'echo SHOULD-NOT-RUN'
    run hostd_stdin 'TOKEN short' 'deploy dist-v1.2.3'
    [ "$status" -eq 2 ]
    [[ "$output" == *"refused token: shape"* ]]
    [[ "$output" != *"short"* ]]
    [[ "$output" != *"SHOULD-NOT-RUN"* ]]
}

@test "malformed tags never reach gremion-deploy" {
    shim gremion-deploy 'echo SHOULD-NOT-RUN'
    local bad
    for bad in 'dist-v1.2' 'v1.2.3' 'dist-v1.2.3-rc1' '../../etc/passwd' \
               'dist-v1.2.3;id' 'main'; do
        run hostd_stdin 'TOKEN itest-token-0123456789' "deploy $bad"
        [ "$status" -eq 2 ]
        [[ "$output" == *"refused tag: $bad"* ]]
        [[ "$output" != *"SHOULD-NOT-RUN"* ]]
    done
}

@test "deploy with the wrong argument count is a usage error" {
    shim gremion-deploy 'echo SHOULD-NOT-RUN'
    run hostd_stdin 'TOKEN itest-token-0123456789' 'deploy dist-v1.2.3 extra'
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: deploy <dist-vX.Y.Z>"* ]]
    [[ "$output" != *"SHOULD-NOT-RUN"* ]]
}

# ---------------------------------------------------------------------------
# switch / rollback / snapshot / verify / backup
# ---------------------------------------------------------------------------

@test "switch accepts exactly blue and green" {
    shim gremion-switch 'echo switch-ran "$@"'
    run hostd_stdin 'switch blue'
    [ "$status" -eq 0 ]
    [[ "$output" == *"switch-ran blue"* ]]
    assert_recorded gremion-switch "blue"

    run hostd_stdin 'switch green'
    [ "$status" -eq 0 ]
    [[ "$output" == *"switch-ran green"* ]]

    local bad
    for bad in purple '' 'blue green' 'blue;id' 'BLUE'; do
        run hostd_stdin "switch $bad"
        [ "$status" -eq 2 ]
    done
}

@test "rollback takes no arguments" {
    shim gremion-rollback 'echo rollback-ran'
    run hostd_stdin 'rollback'
    [ "$status" -eq 0 ]
    [[ "$output" == *"rollback-ran"* ]]

    run hostd_stdin 'rollback --to-tag dist-v1.0.0'
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: rollback"* ]]
}

@test "snapshot validates the label" {
    shim gremion-snapshot 'echo snapshot-ran "$@"'
    run hostd_stdin 'snapshot dist-v1.2.3'
    [ "$status" -eq 0 ]
    assert_recorded gremion-snapshot "dist-v1.2.3"

    run hostd_stdin 'snapshot ../escape'
    [ "$status" -eq 2 ]
    [[ "$output" == *"refused label: ../escape"* ]]

    run hostd_stdin "snapshot $(printf 'a%.0s' $(seq 1 65))"
    [ "$status" -eq 2 ]
    [[ "$output" == *"refused label:"* ]]
}

@test "verify accepts no flag or exactly --colour <blue|green>" {
    shim gremion-verify 'echo verify-ran "$@"'
    run hostd_stdin 'verify'
    [ "$status" -eq 0 ]
    [[ "$output" == *"verify-ran"* ]]

    run hostd_stdin 'verify --colour green'
    [ "$status" -eq 0 ]
    assert_recorded gremion-verify "--colour green"

    run hostd_stdin 'verify --colour purple'
    [ "$status" -eq 2 ]
    [[ "$output" == *"refused colour: purple"* ]]

    run hostd_stdin 'verify --hosts /etc/passwd'
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: verify [--colour <blue|green>]"* ]]

    run hostd_stdin 'verify --colour blue --hosts /etc/passwd'
    [ "$status" -eq 2 ]
}

@test "backup takes no arguments" {
    shim gremion-backup 'echo backup-ran'
    run hostd_stdin 'backup'
    [ "$status" -eq 0 ]
    [[ "$output" == *"backup-ran"* ]]

    run hostd_stdin 'backup --now'
    [ "$status" -eq 2 ]
}

@test "an allowed program that is not installed is a precondition failure" {
    run hostd_stdin 'backup'
    [ "$status" -eq 2 ]
    [[ "$output" == *"gremion-backup is not installed on this host"* ]]
}

@test "the invoked program's exit code is passed through unchanged" {
    shim gremion-backup 'exit 1'
    run hostd_stdin 'backup'
    [ "$status" -eq 1 ]
    [[ "$output" == *"EXIT 1"* ]]

    shim gremion-backup 'echo "BLOCKED: offsite remote unreachable"; exit 3'
    run hostd_stdin 'backup'
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: offsite remote unreachable"* ]]
    [[ "$output" == *"EXIT 3"* ]]
}

@test "a program's stderr reaches the client ahead of the EXIT line" {
    shim gremion-verify 'echo "router app@file missing" >&2; exit 1'
    run hostd_stdin 'verify'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router app@file missing"* ]]
    [[ "${lines[-1]}" == "EXIT 1" ]]
}

# ---------------------------------------------------------------------------
# --ssh forced-command mode
# ---------------------------------------------------------------------------

@test "--ssh dispatches SSH_ORIGINAL_COMMAND when it is set" {
    shim gremion-verify 'echo verify-ran "$@"'
    SSH_ORIGINAL_COMMAND='verify --colour blue' run "$HOSTD" --ssh
    [ "$status" -eq 0 ]
    [[ "$output" == *"verify-ran --colour blue"* ]]
}

@test "--ssh refuses an arbitrary SSH_ORIGINAL_COMMAND" {
    SSH_ORIGINAL_COMMAND='bash -lc id' run "$HOSTD" --ssh
    [ "$status" -eq 2 ]
    [[ "$output" == *"not permitted: bash"* ]]
    [[ "$output" != *"uid="* ]]
}

@test "--ssh with a deploy command still reads the TOKEN line from stdin" {
    shim gremion-deploy 'cat > "$BATS_TEST_TMPDIR/deploy-stdin"; echo deploy-ran'
    run bash -c 'printf "TOKEN itest-token-0123456789\n" | SSH_ORIGINAL_COMMAND="deploy dist-v9.9.9" "$1" --ssh' _ "$HOSTD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"deploy-ran"* ]]
    [ "$(cat "$BATS_TEST_TMPDIR/deploy-stdin")" = "itest-token-0123456789" ]
}

# ---------------------------------------------------------------------------
# The audit log
# ---------------------------------------------------------------------------

@test "every invocation is appended to logs/hostd.log" {
    shim gremion-backup 'echo backup-ran'
    run hostd_stdin 'backup'
    [ "$status" -eq 0 ]
    run hostd_stdin 'bash -c id'
    [ "$status" -eq 2 ]

    local log="$GREMION_ROOT/logs/hostd.log"
    [ -f "$log" ]
    grep -q 'mode=ssh pid=[0-9]* RECV cmd="backup"' "$log"
    grep -q 'mode=ssh pid=[0-9]* EXIT cmd="backup" code=0' "$log"
    grep -q 'RECV cmd="bash -c id"' "$log"
    grep -q 'EXIT cmd="bash" code=2' "$log"
    grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ' "$log"
}

@test "the registry token is never written to the audit log" {
    shim gremion-deploy 'echo deploy-ran'
    run hostd_stdin 'TOKEN itest-token-0123456789' 'deploy dist-v1.2.3'
    [ "$status" -eq 0 ]

    local log="$GREMION_ROOT/logs/hostd.log"
    grep -q 'RECV cmd="TOKEN <redacted>"' "$log"
    grep -q 'RECV cmd="deploy dist-v1.2.3"' "$log"
    ! grep -q 'itest-token-0123456789' "$log"
}

@test "a refused token is logged without its value" {
    run hostd_stdin 'TOKEN short' 'deploy dist-v1.2.3'
    [ "$status" -eq 2 ]
    local log="$GREMION_ROOT/logs/hostd.log"
    [ -f "$log" ]
    grep -q 'EXIT cmd="TOKEN" code=2' "$log"
    ! grep -q 'TOKEN short' "$log"
}

@test "hostd refuses to serve when the audit log cannot be appended to" {
    shim gremion-backup 'echo SHOULD-NOT-RUN'
    mkdir -p "$GREMION_ROOT/logs/hostd.log"
    run hostd_stdin 'backup'
    [ "$status" -eq 2 ]
    [[ "$output" == *"audit log is not writable"* ]]
    [[ "$output" != *"SHOULD-NOT-RUN"* ]]
}

# ---------------------------------------------------------------------------
# --socket
# ---------------------------------------------------------------------------

@test "--socket refuses when the runtime directory is missing" {
    shim socat 'exit 0'
    HOSTD_SOCKET="$GREMION_ROOT/run/hostd.sock" run "$HOSTD" --socket
    [ "$status" -eq 2 ]
    [[ "$output" == *"socket directory $GREMION_ROOT/run does not exist"* ]]
}

@test "--socket refuses when socat is absent" {
    mkdir -p "$GREMION_ROOT/run"
    HOSTD_SOCKET="$GREMION_ROOT/run/hostd.sock" \
      HOSTD_SOCAT="socat-not-installed" run "$HOSTD" --socket
    [ "$status" -eq 2 ]
    [[ "$output" == *"socat-not-installed is not installed"* ]]
}

@test "--socket listens 0660 group gremion and hands connections to --serve" {
    mkdir -p "$GREMION_ROOT/run"
    shim socat 'exit 0'
    HOSTD_SOCKET="$GREMION_ROOT/run/hostd.sock" run "$HOSTD" --socket
    [ "$status" -eq 0 ]
    assert_recorded socat "UNIX-LISTEN:$GREMION_ROOT/run/hostd.sock"
    assert_recorded socat "fork"
    assert_recorded socat "unlink-early"
    assert_recorded socat "mode=0660"
    assert_recorded socat "group=gremion"
    assert_recorded socat "gremion-hostd --serve"
    assert_recorded socat "stderr"
}

@test "--socket honours HOSTD_SOCKET_GROUP" {
    mkdir -p "$GREMION_ROOT/run"
    shim socat 'exit 0'
    HOSTD_SOCKET="$GREMION_ROOT/run/hostd.sock" HOSTD_SOCKET_GROUP="deployers" \
      run "$HOSTD" --socket
    [ "$status" -eq 0 ]
    assert_recorded socat "group=deployers"
}

@test "--socket logs the listener before handing over" {
    mkdir -p "$GREMION_ROOT/run"
    shim socat 'exit 0'
    HOSTD_SOCKET="$GREMION_ROOT/run/hostd.sock" run "$HOSTD" --socket
    [ "$status" -eq 0 ]
    grep -q "mode=socket pid=[0-9]* LISTEN socket=$GREMION_ROOT/run/hostd.sock group=gremion" \
        "$GREMION_ROOT/logs/hostd.log"
}

@test "--serve serves exactly one request from stdin" {
    shim gremion-backup 'echo backup-ran'
    run bash -c 'printf "backup\nbackup\n" | "$1" --serve' _ "$HOSTD"
    [ "$status" -eq 0 ]
    [ "$(grep -c 'backup-ran' <<<"$output")" -eq 1 ]
    [[ "${lines[-1]}" == "EXIT 0" ]]
    grep -q 'mode=serve ' "$GREMION_ROOT/logs/hostd.log"
}

# ---------------------------------------------------------------------------
# The unit and the forced-command line
# ---------------------------------------------------------------------------

@test "the hostd unit runs --socket unprivileged with a RuntimeDirectory" {
    grep -qF 'ExecStart=${GREMION_ROOT}/bin/gremion-hostd --socket' "$UNIT_TMPL"
    grep -qF 'User=${DEPLOY_USER}' "$UNIT_TMPL"
    grep -qxF 'SupplementaryGroups=docker' "$UNIT_TMPL"
    grep -qF 'Environment=HOSTD_SOCKET_GROUP=${DEPLOY_USER}' "$UNIT_TMPL"
    grep -qF 'Environment=GREMION_ROOT=${GREMION_ROOT}' "$UNIT_TMPL"
    grep -qxF 'RuntimeDirectory=gremion' "$UNIT_TMPL"
    grep -qxF 'RuntimeDirectoryMode=0750' "$UNIT_TMPL"
    grep -qxF 'NoNewPrivileges=true' "$UNIT_TMPL"
    grep -qxF 'Type=exec' "$UNIT_TMPL"
    # 128+SIGTERM. The listener exits 143 when systemd stops it, which systemd
    # otherwise records as ActiveState=failed after a clean `systemctl stop`.
    grep -qxF 'SuccessExitStatus=143' "$UNIT_TMPL"
    # Negative assertions are written as `if grep; then false; fi`, never as
    # `! grep`: a !-negated command is exempt from the ERR trap bats detects a
    # failed assertion with, so it asserts nothing anywhere but the last line.
    if grep -q '^ProtectHome=' "$UNIT_TMPL"; then
        echo "ProtectHome would break gremion-deploy's ~/.docker/config.json"; false
    fi
    # The template is rendered, never literal: no host path may appear.
    if grep -q '/opt/gremion' "$UNIT_TMPL"; then
        echo "the unit template hard-codes /opt/gremion instead of the token"; false
    fi
}

@test "authorized_keys_line forces the agent and drops every other channel" {
    # A real key, not a fabricated blob: authorized_keys_line validates the file
    # with ssh-keygen -l, so a hand-written 'ssh-ed25519 AAAA…' fixture would
    # fail for the wrong reason.
    ssh-keygen -q -t ed25519 -N '' -C deploy@ci -f "$BATS_TEST_TMPDIR/id" </dev/null
    run bash -c '. "$1"; authorized_keys_line "$2"' _ "$BOOTSTRAP" "$BATS_TEST_TMPDIR/id.pub"
    [ "$status" -eq 0 ]
    [[ "$output" == "command=\"${GREMION_ROOT}/bin/gremion-hostd --ssh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA"* ]]
}

@test "authorized_keys_line refuses an empty or keyless file" {
    : > "$BATS_TEST_TMPDIR/empty.pub"
    run bash -c '. "$1"; authorized_keys_line "$2"' _ "$BOOTSTRAP" "$BATS_TEST_TMPDIR/empty.pub"
    [ "$status" -eq 2 ]
    [[ "$output" == *"expected exactly one public key"* ]]

    printf 'not a key\n' > "$BATS_TEST_TMPDIR/junk.pub"
    run bash -c '. "$1"; authorized_keys_line "$2"' _ "$BOOTSTRAP" "$BATS_TEST_TMPDIR/junk.pub"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not a valid public key file"* ]]
}

@test "the same deploy key present unrestricted is refused" {
    # THE failure this guard exists for: sshd consults the FIRST matching entry
    # it finds, so a second, option-less copy of the same key further down the
    # file hands CI a full login shell and the forced command above it is never
    # reached.
    ssh-keygen -q -t ed25519 -N '' -C deploy@ci -f "$BATS_TEST_TMPDIR/id" </dev/null
    local ak="$BATS_TEST_TMPDIR/authorized_keys" line
    line="$(bash -c '. "$1"; authorized_keys_line "$2"' _ "$BOOTSTRAP" "$BATS_TEST_TMPDIR/id.pub")"
    printf '%s\n' "$line" > "$ak"
    # the SAME key material again, unrestricted, under a DIFFERENT comment —
    # which is what made the old "${line##* }" form of this check unable to fire.
    printf '%s ci-runner\n' "$(cut -d' ' -f1,2 "$BATS_TEST_TMPDIR/id.pub")" >> "$ak"

    run bash -c '. "$1"; assert_key_forced_only "$2" "$3"' _ "$BOOTSTRAP" "$ak" "$line"
    [ "$status" -ne 0 ]
    [[ "$output" == *"also appears in"* ]]
    [[ "$output" == *"without the forced command"* ]]
}

@test "a single forced-command entry is accepted" {
    ssh-keygen -q -t ed25519 -N '' -C deploy@ci -f "$BATS_TEST_TMPDIR/id" </dev/null
    local ak="$BATS_TEST_TMPDIR/authorized_keys" line
    line="$(bash -c '. "$1"; authorized_keys_line "$2"' _ "$BOOTSTRAP" "$BATS_TEST_TMPDIR/id.pub")"
    # An unrelated admin key alongside it must NOT trip the guard.
    ssh-keygen -q -t ed25519 -N '' -C admin -f "$BATS_TEST_TMPDIR/admin" </dev/null
    cat "$BATS_TEST_TMPDIR/admin.pub" > "$ak"
    printf '%s\n' "$line" >> "$ak"

    run bash -c '. "$1"; assert_key_forced_only "$2" "$3"' _ "$BOOTSTRAP" "$ak" "$line"
    [ "$status" -eq 0 ]
    [[ "$output" == *"reachable only through"* ]]
}

@test "the agent stage installs socat, renders the unit and asserts the socket from stat" {
    grep -qF 'apt-get install -y socat' "$BOOTSTRAP"
    grep -qF 'render_unit gremion-hostd.service /etc/systemd/system/gremion-hostd.service' "$BOOTSTRAP"
    grep -qF "stat -c '%a %G' /run/gremion/hostd.sock" "$BOOTSTRAP"
    grep -qF 'assert_key_forced_only "$ak" "$line"' "$BOOTSTRAP"

    # render_unit takes the unit NAME, never a path (Task 2): a path as the
    # first argument resolves ${TEMPLATE_DIR}/systemd/<abs path>, dies, and
    # writes nothing.
    if grep -qE 'render_unit[[:space:]]+"\$SCRIPT_DIR' "$BOOTSTRAP"; then
        echo "render_unit is called with a path instead of a unit name"; false
    fi

    # bootstrap.sh runs under `set -u` and never SETS GREMION_ROOT, so a bare
    # ${GREMION_ROOT} inside a stage aborts it with 'unbound variable' on a real
    # host. The root comes from the gremion_root function. Scoped to this
    # task's function: render_unit legitimately EXPORTS the name for
    # render_template, in a subshell it assigns first.
    local agent_body
    agent_body="$(awk '/^stage_agent\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$BOOTSTRAP")"
    [ -n "$agent_body" ]
    if grep -n 'GREMION_ROOT' <<<"$agent_body"; then
        echo "stage_agent reads GREMION_ROOT directly; use \$(gremion_root)"; false
    fi
}
