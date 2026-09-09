#!/bin/bash
# Test that security paths are processed and non-security paths are dropped.
set -e

TMP_DIR=$(mktemp -d)
export RAW_LOG_PATH="$TMP_DIR/raw.log"
export PROCESSED_LOG_PATH="$TMP_DIR/processed.log"
export IPCRYPT_KEY="test-key-1234abcd"
export IPCRYPT_KEY_EPOCH="0"

# Write test log lines
# The 4th line carries a synthetic query-string credential (#258-F2) to verify
# the query is redacted before persistence.
cat > "$RAW_LOG_PATH" <<'EOF'
{"RequestPath":"/api/users","ClientHost":"192.168.1.100","RequestMethod":"GET"}
{"RequestPath":"/files/document.pdf","ClientHost":"10.0.0.1","RequestMethod":"GET"}
{"RequestPath":"/auth/realms/stura","ClientHost":"172.16.0.5","RequestMethod":"POST"}
{"RequestPath":"/auth/callback/keycloak?code=SECRETCODE&state=xyz","ClientHost":"172.16.0.6","RequestMethod":"GET"}
EOF

# Run for a moment then kill (uses tail -F so will block otherwise)
timeout 3 bash "$(dirname "$0")/process-logs.sh" 2>/dev/null || true

PROCESSED=$(cat "$TMP_DIR/processed.log" 2>/dev/null || echo "")

# Should have 3 lines (api + auth/realms + auth/callback), not the /files line
COUNT=$(echo "$PROCESSED" | grep -c '"RequestPath"' 2>/dev/null || echo 0)
if [ "$COUNT" -ne 3 ]; then
    echo "FAIL: expected 3 processed lines, got $COUNT"
    rm -rf "$TMP_DIR"
    exit 1
fi
echo "PASS: routing test"

# Raw IPs should not appear in processed log
if grep -q "192.168.1.100" "$TMP_DIR/processed.log" 2>/dev/null; then
    echo "FAIL: raw IP written to processed log"
    rm -rf "$TMP_DIR"
    exit 1
fi
echo "PASS: no raw IPs in processed log"

# #258-F2: query-string credentials must be redacted, not persisted verbatim
if grep -q "SECRETCODE" "$TMP_DIR/processed.log" 2>/dev/null; then
    echo "FAIL: query-string credential written to processed log"
    rm -rf "$TMP_DIR"
    exit 1
fi
if ! grep -q '"/auth/callback/keycloak?<redacted>"' "$TMP_DIR/processed.log" 2>/dev/null; then
    echo "FAIL: query string not redacted on RequestPath"
    rm -rf "$TMP_DIR"
    exit 1
fi
echo "PASS: query string redacted on RequestPath"

rm -rf "$TMP_DIR"
