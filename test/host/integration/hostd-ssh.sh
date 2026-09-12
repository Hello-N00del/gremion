#!/usr/bin/env bash
#
# INTEGRATION (Docker on this box) — NOT part of `make test-unit`.
#
# Proves the restricted SSH transport against a running sshd: the deploy key
# gets the agent and nothing else, the deploy.yml two-line request works
# end to end, and the forced command itself is watched RED — the `command=`
# prefix is removed, a real shell is observed, and the line is restored.
# Everything runs inside one container, so no key and no port touch this box.
#
# Usage: test/host/integration/hostd-ssh.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE="${HOSTD_ITEST_IMAGE:-debian:trixie-slim}"
CNAME="gremion-hostd-ssh-itest"

# Git Bash rewrites any argument that looks like an absolute path before the
# process sees it, which would turn every /opt/... below into a Windows path.
export MSYS_NO_PATHCONV=1

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "OK   $*"; }
cleanup() { docker rm -f "$CNAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

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
apt-get install -y -qq openssh-server openssh-client >/dev/null
groupadd -r gremion
useradd -m -r -g gremion -d /home/gremion -s /bin/bash gremion
mkdir -p /opt/gremion/bin /opt/gremion/lib /opt/gremion/logs
install -m 0755 /opt/gremion-src/bin/gremion-hostd /opt/gremion/bin/gremion-hostd
install -m 0644 /opt/gremion-src/lib/common.sh /opt/gremion/lib/common.sh
cat > /opt/gremion/bin/gremion-deploy <<\EOS
#!/usr/bin/env bash
read -r tok
echo "deploy-ran tag=$1 token-bytes=${#tok}"
EOS
chmod 0755 /opt/gremion/bin/gremion-deploy
chown -R gremion:gremion /opt/gremion
install -d -m 0700 -o gremion -g gremion /home/gremion/.ssh
ssh-keygen -q -t ed25519 -N "" -f /tmp/deploykey
printf "command=\"/opt/gremion/bin/gremion-hostd --ssh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\n" "$(cat /tmp/deploykey.pub)" > /home/gremion/.ssh/authorized_keys
cp /home/gremion/.ssh/authorized_keys /tmp/authorized_keys.good
chown gremion:gremion /home/gremion/.ssh/authorized_keys
chmod 0600 /home/gremion/.ssh/authorized_keys
ssh-keygen -A
mkdir -p /run/sshd
/usr/sbin/sshd
'

ssh_in() {
    docker exec -i "$CNAME" ssh -q -i /tmp/deploykey \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes gremion@127.0.0.1 "$@"
}

echo "--- phase 1: the forced command answers a permitted verb"
out="$(printf '' | ssh_in noop)"
grep -q 'noop ok' <<<"$out" || fail "noop did not run: $out"
grep -qx 'EXIT 0' <<<"$out" || fail "no EXIT 0 line: $out"
pass "noop over ssh, EXIT 0"

echo "--- phase 2: deploy.yml's two-line request works end to end"
rc=0
out="$(printf 'TOKEN itest-token-0123456789\ndeploy dist-v1.0.0\n' | ssh_in)" || rc=$?
[[ $rc -eq 0 ]] || fail "deploy request exited $rc: $out"
grep -q 'deploy-ran tag=dist-v1.0.0 token-bytes=22' <<<"$out" \
    || fail "tag or token did not arrive: $out"
grep -qx 'EXIT 0' <<<"$out" || fail "no EXIT 0 line: $out"
pass "TOKEN + deploy delivered the tag as argv and the token on stdin"

echo "--- phase 3: an arbitrary command gets no shell"
rc=0
out="$(ssh_in id </dev/null)" || rc=$?
[[ $rc -eq 2 ]] || fail "expected exit 2 for 'id', got $rc: $out"
if grep -q 'uid=' <<<"$out"; then fail "a shell ran: $out"; fi
grep -qx 'EXIT 2' <<<"$out" || fail "no EXIT 2 line: $out"
pass "'id' refused with EXIT 2, no shell"

echo "--- phase 4: RED — drop the command= prefix, watch a shell appear"
docker exec "$CNAME" bash -c '
set -euo pipefail
sed -e "s|^command=\"[^\"]*\",[^ ]* ||" /tmp/authorized_keys.good > /home/gremion/.ssh/authorized_keys
chown gremion:gremion /home/gremion/.ssh/authorized_keys
chmod 0600 /home/gremion/.ssh/authorized_keys
'
rc=0
red="$(ssh_in id </dev/null)" || rc=$?
grep -q 'uid=[0-9]*(gremion)' <<<"$red" \
    || fail "RED did not reproduce: expected a real shell, got rc=$rc out=$red"
pass "RED observed: unrestricted key gave a shell — $(grep -o 'uid=[0-9]*(gremion)' <<<"$red")"

echo "--- phase 5: restore the forced command and re-prove the refusal"
docker exec "$CNAME" bash -c '
set -euo pipefail
cp /tmp/authorized_keys.good /home/gremion/.ssh/authorized_keys
chown gremion:gremion /home/gremion/.ssh/authorized_keys
chmod 0600 /home/gremion/.ssh/authorized_keys
'
rc=0
out="$(ssh_in id </dev/null)" || rc=$?
[[ $rc -eq 2 ]] || fail "restore failed: 'id' exited $rc"
if grep -q 'uid=' <<<"$out"; then fail "restore failed: a shell still runs"; fi
pass "forced command restored, 'id' refused again"

echo "--- phase 6: the audit log names every request"
log="$(docker exec "$CNAME" cat /opt/gremion/logs/hostd.log)"
grep -q 'RECV cmd="noop"' <<<"$log" || fail "noop not logged"
grep -q 'RECV cmd="TOKEN <redacted>"' <<<"$log" || fail "token line not redacted in the log"
grep -q 'RECV cmd="deploy dist-v1.0.0"' <<<"$log" || fail "deploy not logged"
if grep -q 'itest-token-0123456789' <<<"$log"; then fail "the token reached the audit log"; fi
grep -q 'EXIT cmd="id" code=2' <<<"$log" || fail "the refusal was not logged"
pass "audit log complete, token absent"

echo "HOSTD-SSH: ok"
