#!/bin/bash
# test-log-rotation.sh — static checks for #242 (log rotation actually executes).
# No-harness: logrotate itself is NOT installed locally, so these are static
# assertions over the in-scope files. The in-container `logrotate -d` proof is
# documented in the task handoff and run in CI against the built image.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
fail=0

check() {
  # check "<exit-code>" "<description>"
  if [ "$1" -eq 0 ]; then
    echo "PASS: $2"
  else
    echo "FAIL: $2"
    fail=1
  fi
}

# 1. logrotate.conf covers the appended security.log with copytruncate.
grep -qE '/logs/processed/security\.log' "$DIR/logrotate.conf"
check $? "logrotate.conf covers /logs/processed/security.log"

grep -qE 'copytruncate' "$DIR/logrotate.conf"
check $? "logrotate.conf uses copytruncate (in-place rotation, no signal)"

# 2. logrotate.conf also provides the raw access.log rotation rule.
grep -qE 'access\.log' "$DIR/logrotate.conf"
check $? "logrotate.conf covers the raw Traefik access.log"

# 3. entrypoint.sh schedules logrotate via a running process wired into wait -n.
grep -qE 'logrotate' "$DIR/entrypoint.sh"
check $? "entrypoint.sh invokes logrotate (scheduled invoker)"

grep -qE 'wait -n' "$DIR/entrypoint.sh"
check $? "entrypoint.sh keeps wait -n supervising the processes"

# 4. Dockerfile installs logrotate in the final image. The install spans lines
#    (RUN apt-get install ... \ <newline> logrotate \), so check the two facts
#    independently: an apt-get install directive exists AND logrotate appears as
#    an installed package token (a continuation line, not the COPY path/comment).
grep -qE 'apt-get install' "$DIR/Dockerfile" \
  && grep -qE '^[[:space:]]+logrotate([[:space:]]|\\|$)' "$DIR/Dockerfile"
check $? "Dockerfile installs logrotate in the final image"

# 5. The dead retained-*.log-only state is replaced/augmented (more than one rule).
rules=$(grep -cE '^[[:space:]]*/logs/.*\{' "$DIR/logrotate.conf")
[ "${rules:-0}" -ge 2 ]
check $? "logrotate.conf has >=2 rotation rules (retained-only state replaced/augmented)"

if [ "$fail" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
