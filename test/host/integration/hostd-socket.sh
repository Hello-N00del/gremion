#!/usr/bin/env bash
#
# INTEGRATION (Docker on this box) — NOT part of `make test-unit`.
#
# Proves the socket transport against a running system: a real socat listener
# owned by a real unprivileged user inside a Debian container, a real client
# connection, the real audit log, and the runtime-directory guard watched RED
# in band on every run.
#
# Usage: test/host/integration/hostd-socket.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE="${HOSTD_ITEST_IMAGE:-debian:trixie-slim}"
CNAME="gremion-hostd-socket-itest"

# Git Bash rewrites any argument that looks like an absolute path before the
# process sees it, which would turn every /opt/... below into a Windows path.
export MSYS_NO_PATHCONV=1

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "OK   $*"; }
cleanup() { docker rm -f "$CNAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# Docker takes a native path for a bind mount; on Git Bash that is not the
# /c/... form the shell reports.
mount_src="$REPO_ROOT/infra/host"
if command -v cygpath >/dev/null 2>&1; then
    mount_src="$(cygpath -m "$mount_src")"
fi

docker run -d --name "$CNAME" \
    -v "${mount_src}:/opt/gremion-src:ro" \
    "$IMAGE" sleep 900 >/dev/null

docker exec "$CNAME" bash -c '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq socat >/dev/null
groupadd -r gremion
useradd -r -g gremion -d /opt/gremion -s /usr/sbin/nologin gremion
mkdir -p /opt/gremion/bin /opt/gremion/lib /opt/gremion/logs /run/gremion
install -m 0755 /opt/gremion-src/bin/gremion-hostd /opt/gremion/bin/gremion-hostd
install -m 0644 /opt/gremion-src/lib/common.sh /opt/gremion/lib/common.sh
cat > /opt/gremion/bin/gremion-backup <<\EOS
#!/usr/bin/env bash
echo "backup-ran args=$*"
EOS
chmod 0755 /opt/gremion/bin/gremion-backup
chown -R gremion:gremion /opt/gremion
# Exactly what RuntimeDirectory=gremion + User=gremion gives the unit on the
# host: OWNED by the deploy user, not merely group-readable. A group-only
# /run/gremion is 0750 with no write bit for the group, and the bind fails.
chown gremion:gremion /run/gremion
chmod 0750 /run/gremion
'

echo "--- phase 1: the listener comes up"
docker exec -d -u gremion "$CNAME" /opt/gremion/bin/gremion-hostd --socket
for _ in $(seq 1 60); do
    if docker exec "$CNAME" test -S /run/gremion/hostd.sock; then break; fi
    sleep 0.25
done
docker exec "$CNAME" test -S /run/gremion/hostd.sock || fail "socket never appeared"
perms="$(docker exec "$CNAME" stat -c '%a %G' /run/gremion/hostd.sock)"
[[ "$perms" == "660 gremion" ]] || fail "socket is '$perms', expected '660 gremion'"
pass "hostd.sock is 660 gremion"

echo "--- phase 2: an allowed verb runs and answers EXIT 0"
out="$(docker exec -i "$CNAME" socat -T 10 - UNIX-CONNECT:/run/gremion/hostd.sock <<<'backup')"
grep -q '^backup-ran args=$' <<<"$out" || fail "backup did not run: $out"
grep -qx 'EXIT 0' <<<"$out" || fail "no EXIT 0 line: $out"
pass "backup over the socket, EXIT 0"

echo "--- phase 3: an arbitrary command is refused over the socket"
out="$(docker exec -i "$CNAME" socat -T 10 - UNIX-CONNECT:/run/gremion/hostd.sock <<<'bash -c id')"
grep -qx 'EXIT 2' <<<"$out" || fail "arbitrary command not refused: $out"
if grep -q 'uid=' <<<"$out"; then fail "a shell ran over the socket: $out"; fi
pass "arbitrary command refused with EXIT 2"

echo "--- phase 4: the audit log holds both connections"
log="$(docker exec "$CNAME" cat /opt/gremion/logs/hostd.log)"
grep -q 'RECV cmd="backup"' <<<"$log" || fail "no RECV line for backup"
grep -q 'EXIT cmd="backup" code=0' <<<"$log" || fail "no EXIT line for backup"
grep -q 'EXIT cmd="bash" code=2' <<<"$log" || fail "the refusal was not logged"
pass "audit log records both connections"

echo "--- phase 5: RED — break the runtime directory, watch the guard fire"
docker exec "$CNAME" rm -rf /run/gremion
rc=0
red="$(docker exec -u gremion "$CNAME" /opt/gremion/bin/gremion-hostd --socket 2>&1)" || rc=$?
[[ $rc -eq 2 ]] || fail "expected exit 2 with the runtime directory gone, got $rc"
grep -q 'socket directory /run/gremion does not exist' <<<"$red" \
    || fail "guard did not name the missing directory: $red"
pass "RED observed: $(grep -o 'socket directory .* does not exist' <<<"$red")"

echo "--- phase 6: restore the precondition and re-prove the listener"
docker exec "$CNAME" bash -c 'mkdir -p /run/gremion && chown gremion:gremion /run/gremion && chmod 0750 /run/gremion'
docker exec -d -u gremion "$CNAME" /opt/gremion/bin/gremion-hostd --socket
for _ in $(seq 1 60); do
    if docker exec "$CNAME" test -S /run/gremion/hostd.sock; then break; fi
    sleep 0.25
done
docker exec "$CNAME" test -S /run/gremion/hostd.sock || fail "socket did not come back"
pass "listener restored"

echo "HOSTD-SOCKET: ok"
