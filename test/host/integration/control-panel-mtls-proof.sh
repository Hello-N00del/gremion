#!/usr/bin/env bash
set -euo pipefail
#
# control-panel-mtls-proof.sh — the client-certificate gate of the control panel
# (docs/runbooks/control-panel-access.md), proved against a REAL Traefik of the
# image the production compose pins, with the FILE PROVIDER ONLY. Not a unit test:
# it starts throwaway containers, makes real TLS connections and reads what comes
# back. Run it before a release that touches infra/host/templates/edge/
# control-panel.yml.tmpl, gremion-operator-ca or the Traefik pin.
#
#   bash test/host/integration/control-panel-mtls-proof.sh
#
# WHAT IT BUILDS (all names start with pm-mtls-, removed by explicit name at the end)
#   - a docker network, one named volume (the dynamic directory: a volume, NOT a
#     bind mount, because Docker Desktop delivers no file-change events for a
#     bind mount and Traefik's watcher would never see an edit), one Traefik of
#     the pinned image, one backend that echoes the request line and the
#     X-Forwarded-Host it received, one client container per probe batch;
#   - the CA and the device certificates come from gremion-operator-ca itself
#     (create, issue, install), so the tool and the edge are proved together;
#   - the router file is the real template with the two tokens replaced; the ONLY
#     difference from what gremion-render writes is `@docker` -> `@file` on the
#     three middleware names (a file-provider-only Traefik has no docker
#     provider), and a proof file declares those three under their real names
#     (pin, HSTS, the portal rate limit's values). The script checks the diff.
#   - the certificate resolver the router names is a dummy ACME resolver pointed
#     at a closed port: the router keeps its resolver (as in production) and no
#     certificate is ever ordered; every host presents Traefik's default
#     certificate, which the client does not verify (-k): the CERTIFICATE of the
#     server is not what is under test, the CLIENT's is.
#
# WHAT IT PROVES (each line is a PASS/FAIL; any FAIL, or fewer checks than
# expected, is exit 1)
#   1  no client certificate: the TLS 1.2 handshake ends in an ALERT (the shape
#      gremion-verify asserts) and under TLS 1.3 no HTTP status ever arrives
#   2  a certificate another CA signed: no HTTP status
#   3  a valid device certificate: reaches the backend, HSTS set, X-Forwarded-Host
#      pinned (a forged one never arrives)
#   4  /healthz and /api/internal/... answer 404 FROM TRAEFIK in every spelling
#      tried, and the backend never sees them
#   5  another host on the same entrypoint is NOT asked for a certificate
#   6  SNI of another host (or no SNI) with Host: control... is 421, never routed,
#      with and without a valid certificate
#   7  the control router is enabled in Traefik's API with the TLS option, the
#      host rule and the chain the verifier expects
#   8  a CA file that is garbage, or missing, does not open the host: the
#      connection is closed (even for a valid certificate), other hosts keep working
#   9  rotation: replacing the CA file ALONE does not take effect; install (which
#      touches the router file) does, the old CA's certificate stops working and
#      the new CA's works
#  10  the chain's rate limit is live on the host and admits a first load of the
#      panel: 30 requests at once all pass (the auth tier, 30/min with burst 10,
#      answered the tail of such a burst with 429: that was this check's first
#      form), and a flood past the burst gets 429
#
# Needs docker, openssl and curl-less hosts are fine: the client runs in a container.
# Exit codes: 0 all proved · 1 a check failed · 2 precondition.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="${PROOF_PREFIX:-pm-mtls}-$(openssl rand -hex 3)"
# The host under test: the default control.<platform domain> of the proof's own state.env, or
# PROOF_CONTROL_HOST, a host OUTSIDE that domain (CONTROL_PANEL_HOST on a real install). The
# gate is per host name, so the proof must hold for either; CHRE is the host as a regex.
CH="${PROOF_CONTROL_HOST:-control.example.test}"
if [[ ! "$CH" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then echo "PROOF_CONTROL_HOST is not a lowercase host name" >&2; exit 2; fi
CHRE="${CH//./\\.}"
NET="${RUN}-net"
VOL="${RUN}-dyn"
TR="${RUN}-tr"
BE="${RUN}-be"
WS="$(mktemp -d)"
export MSYS_NO_PATHCONV=1
PASS=0
FAIL=0

cleanup() {
    docker rm -f "$TR" "$BE" "${RUN}-cl" "${RUN}-sh" >/dev/null 2>&1 || true
    docker volume rm -f "$VOL" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf -- "$WS"
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
# expect <label> <got> <want-regex>
expect() {
    if [[ "$2" =~ $3 ]]; then pass "$1"; else fail "$1: got '${2}', wanted /${3}/"; fi
}

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 2; }
# shellcheck disable=SC2015  # `pwd -W` exists only under Git Bash; the fallback is the plain `pwd`, by design
WSD="$(cd "$WS" && pwd -W 2>/dev/null || pwd)"

# ── the pinned Traefik ─────────────────────────────────────────────────────
PIN="$(grep -m1 -E '^\s+image: traefik:v[0-9.]+@sha256:[0-9a-f]{64}' "${REPO}/docker-compose.yml" | sed -E 's/^\s+image: //')"
[[ -n "$PIN" ]] || { echo "no pinned traefik image in docker-compose.yml" >&2; exit 2; }
DIGEST="${PIN#*@}"
if docker image inspect "traefik@${DIGEST}" >/dev/null 2>&1; then IMG="traefik@${DIGEST}"; else docker pull -q "$PIN" >/dev/null; IMG="$PIN"; fi
CLIENT_IMG="${PROOF_CLIENT_IMAGE:-nginxinc/nginx-unprivileged:1.30-alpine}"   # curl and a plain nginx; any image with both works
echo "traefik: ${PIN}"

# ── certificates, from the tool itself ─────────────────────────────────────
TOOL_IMG="${PROOF_TOOL_IMAGE:-gremion-bats:local}"   # bash, coreutils and openssl 3: the image test/host's bats suites run in
docker image inspect "$TOOL_IMG" >/dev/null 2>&1 || { echo "tool image ${TOOL_IMG} is not present (the image the bats suites use; set PROOF_TOOL_IMAGE)" >&2; exit 2; }
# shellcheck disable=SC2015  # as above
REPOD="$(cd "$REPO" && pwd -W 2>/dev/null || pwd)"
# tool '<shell snippet>' — runs in the tool image with the repo at /repo (read-only) and the work dir at /ws
tool() {
    docker run --rm --name "${RUN}-sh" --entrypoint bash -v "${REPOD}:/repo:ro" -v "${WSD}:/ws" -e GREMION_ROOT=/ws/workstation "$TOOL_IMG" -c "$1"
}
OPCA=/repo/infra/host/bin/gremion-operator-ca
printf 'proof-ca-pass\n' > "${WS}/ca.pass"; printf 'proof-p12-pass\n' > "${WS}/p12.pass"
mkdir -p "${WS}/workstation"
mkca() { tool "GREMION_OPERATOR_CA_DIR=/ws/$1 ${OPCA} create --passfile /ws/ca.pass" >/dev/null; }
mkdev() {  # <ca dir name> <device name> -> /ws/<device>.crt/.key (PEM, for curl)
    tool "GREMION_OPERATOR_CA_DIR=/ws/$1 ${OPCA} issue --name $2 --out /ws/$2.p12 --passfile /ws/ca.pass --p12-passfile /ws/p12.pass >/dev/null
          openssl pkcs12 -in /ws/$2.p12 -clcerts -nokeys -passin file:/ws/p12.pass -out /ws/$2.crt 2>/dev/null
          openssl pkcs12 -in /ws/$2.p12 -nocerts -nodes -passin file:/ws/p12.pass -out /ws/$2.key 2>/dev/null"
}
mkca ca1; mkca ca2; mkca ca3
mkdev ca1 dev1        # the operator's device
mkdev ca2 stranger    # a device of another CA
mkdev ca3 dev3        # the device the ROTATED CA signs

# ── the host root the tool installs into, then synced into the volume ──────
HOSTROOT="${WS}/host"; mkdir -p "${HOSTROOT}/etc/env" "${HOSTROOT}/etc/edge"
printf 'STACK=proof\nPLATFORM_DOMAIN=example.test\n' > "${HOSTROOT}/etc/env/state.env"
inst() { tool "GREMION_ROOT=/ws/host ${OPCA} install --ca /ws/$1/ca.pem" >/dev/null; }
inst ca1

# the router file: the real template, tokens replaced
TMPL="${REPO}/infra/host/templates/edge/control-panel.yml.tmpl"
# shellcheck disable=SC2016  # the dollar-brace tokens are the literal text the template carries
sed -e "s/\\\${CONTROL_HOST}/${CH}/g" -e 's/\${TRAEFIK_CERT_RESOLVER}/le-http/g' "$TMPL" > "${HOSTROOT}/etc/edge/control-panel.yml.prod"
# shellcheck disable=SC2016  # a literal dollar-brace
if grep -q '\${' "${HOSTROOT}/etc/edge/control-panel.yml.prod"; then echo "unsubstituted token in the rendered file" >&2; exit 2; fi
sed 's/@docker/@file/g' "${HOSTROOT}/etc/edge/control-panel.yml.prod" > "${HOSTROOT}/etc/edge/control-panel.yml"
changed="$(diff <(cat "${HOSTROOT}/etc/edge/control-panel.yml.prod") <(cat "${HOSTROOT}/etc/edge/control-panel.yml") | grep -c '^>' || true)"
expect "the proof's router file differs from the production render in exactly the three middleware providers" "$changed" '^3$'
rm "${HOSTROOT}/etc/edge/control-panel.yml.prod"

cat > "${WS}/proof-extra.yml" <<'EOF'
# proof-only: what the docker provider declares in production (docker-compose.prod.yml)
http:
  middlewares:
    edge-hostpin-control:
      headers:
        customRequestHeaders:
          X-Forwarded-Host: "__CH__"
    edge-hsts-platform:
      headers:
        stsSeconds: 31536000
        stsIncludeSubdomains: true
    edge-ratelimit-portal:
      rateLimit:
        average: 100
        burst: 50
        period: 1m
        sourceCriterion:
          ipStrategy:
            depth: 0
  services:
    panel:
      loadBalancer:
        servers:
          - url: "http://control-panel-blue:3000"
  routers:
    other:
      entryPoints: ["websecure"]
      rule: "Host(`other.example.test`)"
      service: "panel@file"
      tls: {}
EOF
sed -i "s/__CH__/${CH}/" "${WS}/proof-extra.yml"
cat > "${WS}/static.yml" <<'EOF'
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
api:
  insecure: true
certificatesResolvers:
  le-http:
    acme:
      email: "proof@example.test"
      storage: /tmp/acme.json
      caServer: "https://127.0.0.1:1/directory"
      httpChallenge:
        entryPoint: web
log:
  level: ERROR
EOF
cat > "${WS}/backend.conf" <<'EOF'
server {
  listen 3000;
  location / { default_type text/plain; return 200 "BACKEND uri=$request_uri xfh=$http_x_forwarded_host\n"; }
}
EOF

docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
# sync <path in $HOSTROOT> ... into the volume, keeping modes; a copy over an existing file is a write event, as `touch` is on the host
sync_vol() {
    docker run --rm --name "${RUN}-sh" -v "${VOL}:/dyn" -v "${WSD}/host:/src:ro" -v "${WSD}:/ws:ro" alpine:3 sh -c "$1"
}
sync_vol 'mkdir -p /dyn/mtls && cp /src/etc/edge/control-panel.yml /dyn/control-panel.yml && cp /src/etc/edge/mtls/operator-ca.pem /dyn/mtls/operator-ca.pem && cp /ws/proof-extra.yml /dyn/proof-extra.yml'
docker run -d --name "$BE" --network "$NET" --network-alias control-panel-blue -v "${WSD}/backend.conf:/etc/nginx/conf.d/default.conf:ro" "$CLIENT_IMG" >/dev/null
docker run -d --name "$TR" --network "$NET" -v "${WSD}/static.yml:/etc/traefik/traefik.yml:ro" -v "${VOL}:/etc/traefik/dynamic:ro" "$IMG" >/dev/null
for _ in $(seq 1 30); do
    if docker exec "$TR" wget -qO- http://127.0.0.1:8080/api/http/routers 2>/dev/null | grep -q 'control-panel@file'; then break; fi
    sleep 1
done

# the address the client containers dial (they have no getent, and need no DNS)
TRIP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${NET}\").IPAddress}}" "$TR")"
[[ -n "$TRIP" ]] || { echo "could not read the traefik container's address" >&2; exit 2; }

# ── the client: one container per batch, parsed here ───────────────────────
cat > "${WS}/probe.sh" <<'EOF'
#!/bin/sh
# probe.sh <label> <curl args...>  ->  label|rc|http_code|first body line|error tail
cd /ws
IP="$TRAEFIK_IP"
C="$CH"
RES="--resolve $C:443:$IP --resolve other.example.test:443:$IP"
req() {
  label="$1"; shift
  out="$(curl -sS -k --max-time 8 -D /tmp/h -o /tmp/b -w '%{http_code}' "$@" 2>/tmp/e)"; rc=$?
  printf '%s|%s|%s|%s|%s|%s\n' "$label" "$rc" "$out" "$(head -n1 /tmp/b 2>/dev/null)" "$(tail -c 160 /tmp/e | tr '\n|' '  ')" "$(grep -i '^strict-transport' /tmp/h 2>/dev/null | tr -d '\r' | tr '|' ' ')"
  : > /tmp/b; : > /tmp/h
}
mode="$1"
case "$mode" in
  basic)
    req nocert12      $RES --tlsv1.2 --tls-max 1.2 "https://$C/"
    req nocert13      $RES --tlsv1.3 "https://$C/"
    req wrongca       $RES --cert stranger.crt --key stranger.key "https://$C/"
    req wrongca12     $RES --tlsv1.2 --tls-max 1.2 --cert stranger.crt --key stranger.key "https://$C/"
    req valid         $RES --cert dev1.crt --key dev1.key "https://$C/"
    req valid12       $RES --tlsv1.2 --tls-max 1.2 --cert dev1.crt --key dev1.key "https://$C/"
    req forged        $RES --cert dev1.crt --key dev1.key -H "X-Forwarded-Host: evil.example" "https://$C/"
    req other         $RES "https://other.example.test/"
    req other-healthz $RES "https://other.example.test/healthz"
    req sni-other     $RES -H "Host: $C" "https://other.example.test/"
    req sni-other-cert $RES -H "Host: $C" --cert dev1.crt --key dev1.key "https://other.example.test/"
    req sni-none      -H "Host: $C" "https://$IP/"
    req sni-none-cert -H "Host: $C" --cert dev1.crt --key dev1.key "https://$IP/"
    req host-other-on-control $RES -H "Host: other.example.test" --cert dev1.crt --key dev1.key "https://$C/"
    for p in /healthz /healthz/ //healthz /%68ealthz /./healthz /x/../healthz /healthzx /api/internal /api/internal/evict /api/internal/evict/x /api/internal%2Fevict /api/internal/ /api/./internal/evict; do
      req "path:$p" $RES --cert dev1.crt --key dev1.key --path-as-is "https://$C$p"
    done
    req path-ok-login $RES --cert dev1.crt --key dev1.key "https://$C/auth/signin"
    ;;
  one)  shift; l="$1"; shift; req "$l" $RES "$@" ;;
  burst)
    for i in $(seq 1 30); do
      req "burst$i" $RES --cert dev3.crt --key dev3.key "https://$C/"
    done
    ;;
  flood)
    for i in $(seq 1 150); do
      req "flood$i" $RES --cert dev3.crt --key dev3.key "https://$C/"
    done
    ;;
esac
EOF
probe() {  # <mode> [args]: run a batch in a fresh client, print its lines
    docker run --rm --user 0 --name "${RUN}-cl" --network "$NET" -e "TRAEFIK=${TR}" -e "TRAEFIK_IP=${TRIP}" -e "CH=${CH}" -v "${WSD}:/ws:ro" "$CLIENT_IMG" sh /ws/probe.sh "$@"
}
field() {  # <batch output> <label> <n> -> the n-th pipe field of that line (1 label, 2 rc, 3 code, 4 body, 5 err, 6 hsts)
    printf '%s\n' "$1" | awk -F'|' -v l="$2" -v n="$3" '$1 == l { print $n; exit }'
}

# ── 1-6: the handshake batch ───────────────────────────────────────────────
B="$(probe basic)"
expect "1a no client certificate, TLS 1.2: the handshake ends in an alert, no HTTP status (rc 35)" "$(field "$B" nocert12 2)|$(field "$B" nocert12 3)|$(field "$B" nocert12 5)" '^35\|000\|.*alert (handshake failure|certificate required|bad certificate|unknown ca)'
expect "1b no client certificate, TLS 1.3: no HTTP status ever arrives" "$(field "$B" nocert13 3)" '^000$'
expect "2a a certificate another CA signed, TLS 1.3: no HTTP status" "$(field "$B" wrongca 3)" '^000$'
expect "2b a certificate another CA signed, TLS 1.2: a handshake alert, no HTTP status" "$(field "$B" wrongca12 2)|$(field "$B" wrongca12 3)" '^35\|000$'
expect "3a a valid device certificate reaches the backend (TLS 1.3 and 1.2)" "$(field "$B" valid 3) $(field "$B" valid 4)|$(field "$B" valid12 3)" "^200 BACKEND uri=/ xfh=${CHRE}\|200\$"
expect "3b HSTS is set on the control host" "$(field "$B" valid 6)" 'max-age=31536000'
expect "3c a forged X-Forwarded-Host never reaches the backend: the pin overwrites it" "$(field "$B" forged 4)" "xfh=${CHRE}\$"
for p in '/healthz' '/healthz/' '//healthz' '/%68ealthz' '/./healthz' '/x/../healthz' '/healthzx' '/api/internal' '/api/internal/evict' '/api/internal/evict/x' '/api/internal%2Fevict' '/api/internal/' '/api/./internal/evict'; do
    expect "4  ${p}: 404 from the edge, the backend never answers" "$(field "$B" "path:${p}" 3)|$(field "$B" "path:${p}" 4)" '^404\|404 page not found$'
done
expect "4z a path the panel serves is routed (the exclusion is exactly the two probes)" "$(field "$B" path-ok-login 3)" '^200$'
expect "5a another host on the same entrypoint is not asked for a certificate" "$(field "$B" other 3)" '^200$'
expect "5b ... and serves /healthz like any host (the exclusion is the control host's alone)" "$(field "$B" other-healthz 3)" '^200$'
expect "6a SNI of another host + Host: control, no certificate: 421" "$(field "$B" sni-other 3)" '^421$'
expect "6b SNI of another host + Host: control, with a valid certificate: 421" "$(field "$B" sni-other-cert 3)" '^421$'
expect "6c no SNI + Host: control, no certificate: 421" "$(field "$B" sni-none 3)" '^421$'
expect "6d no SNI + Host: control, with a valid certificate: 421" "$(field "$B" sni-none-cert 3)" '^421$'
expect "6e SNI control + Host of another host, with a valid certificate: 421 (the option is per host, so is the check)" "$(field "$B" host-other-on-control 3)" '^421$'

# ── 7: what traefik loaded ─────────────────────────────────────────────────
R="$(docker exec "$TR" wget -qO- http://127.0.0.1:8080/api/http/routers/control-panel@file)"
R="$(printf '%s' "$R" | sed 's/\\u0026/\&/g')"   # the API writes an ampersand as a JSON escape
expect "7a the control router is enabled" "$R" '"status":"enabled"'
expect "7b its TLS option is control-panel-mtls (the verifier accepts the bare or the @file spelling)" "$R" '"options":"control-panel-mtls(@file)?"'
# shellcheck disable=SC2016  # backticks are literal characters of the Traefik rule
expect "7c its rule is the host without the two probe paths" "$R" "Host\\(\`${CHRE}\`\\) && !PathPrefix\\(\`/healthz\`\\) && !PathPrefix\\(\`/api/internal\`\\)"
expect "7d its chain is pin, HSTS, portal rate limit, in that order" "$R" '"middlewares":\["edge-hostpin-control@file","edge-hsts-platform@file","edge-ratelimit-portal@file"\]'
expect "7e it listens on websecure alone and names its resolver" "$R" '"entryPoints":\["websecure"\].*"certResolver":"le-http"'

# ── 8: a broken CA closes the host ─────────────────────────────────────────
sync_vol 'echo garbage > /dyn/mtls/operator-ca.pem; touch /dyn/control-panel.yml'; sleep 3
B="$(docker run --rm --user 0 --name "${RUN}-cl" --network "$NET" -e "TRAEFIK=${TR}" -e "TRAEFIK_IP=${TRIP}" -e "CH=${CH}" -v "${WSD}:/ws:ro" "$CLIENT_IMG" sh -c '
  cd /ws; IP="$TRAEFIK_IP"
  for t in 1.2 1.3; do
    out="$(curl -sS -k --max-time 8 -o /dev/null -w "%{http_code}" --resolve ${CH}:443:$IP --tlsv$t --tls-max $t --cert dev1.crt --key dev1.key https://${CH}/ 2>/tmp/e)"; rc=$?
    echo "garbage-$t|$rc|$out|$(tail -c 120 /tmp/e | tr "\n|" "  ")"
  done
  out="$(curl -sS -k --max-time 8 -o /dev/null -w "%{http_code}" --resolve other.example.test:443:$IP https://other.example.test/ 2>/dev/null)"; echo "garbage-other|0|$out|"')"
expect "8a garbage CA file, TLS 1.2: the connection is closed with no alert, even for a valid certificate (the verifier tells this apart from a refusal)" "$(field "$B" garbage-1.2 2)|$(field "$B" garbage-1.2 3)|$(field "$B" garbage-1.2 4)" '^35\|000\|.*unexpected eof'
expect "8b garbage CA file, TLS 1.3: closed too" "$(field "$B" garbage-1.3 3)" '^000$'
expect "8c garbage CA file: another host on the entrypoint still answers" "$(field "$B" garbage-other 3)" '^200$'
sync_vol 'rm /dyn/mtls/operator-ca.pem; touch /dyn/control-panel.yml'; sleep 3
B="$(docker run --rm --user 0 --name "${RUN}-cl" --network "$NET" -e "TRAEFIK=${TR}" -e "TRAEFIK_IP=${TRIP}" -e "CH=${CH}" -v "${WSD}:/ws:ro" "$CLIENT_IMG" sh -c '
  cd /ws; IP="$TRAEFIK_IP"
  out="$(curl -sS -k --max-time 8 -o /dev/null -w "%{http_code}" --resolve ${CH}:443:$IP --tlsv1.2 --tls-max 1.2 --cert dev1.crt --key dev1.key https://${CH}/ 2>/tmp/e)"; rc=$?
  echo "missing|$rc|$out|$(tail -c 120 /tmp/e | tr "\n|" "  ")"')"
expect "8d missing CA file: closed, no HTTP status" "$(field "$B" missing 2)|$(field "$B" missing 3)" '^35\|000$'

# ── 9: rotation ────────────────────────────────────────────────────────────
inst ca1
sync_vol 'cp /src/etc/edge/mtls/operator-ca.pem /dyn/mtls/operator-ca.pem; touch /dyn/control-panel.yml'; sleep 3
B="$(probe one restored --cert dev1.crt --key dev1.key https://"${CH}"/ | head -1)"
expect "9a the CA file restored (and the router file touched): the operator's device works again" "$(field "$B" restored 3)" '^200$'
# a new CA, copied in WITHOUT touching anything: the old one is still in force
inst ca3
sync_vol 'cp /src/etc/edge/mtls/operator-ca.pem /dyn/mtls/operator-ca.pem'; sleep 4
B="$(probe one old --cert dev1.crt --key dev1.key https://"${CH}"/ | head -1)"
C3="$(probe one new --cert dev3.crt --key dev3.key https://"${CH}"/ | head -1)"
expect "9b replacing the CA file ALONE changes nothing: the old CA's certificate still works (this is why install touches the router file)" "$(field "$B" old 3)|$(field "$C3" new 3)" '^200\|000$'
# what `install` did (it replaced the file and touched the router file): now the router file is rewritten
sync_vol 'touch /dyn/control-panel.yml'; sleep 4
B="$(probe one old --cert dev1.crt --key dev1.key https://"${CH}"/ | head -1)"
C3="$(probe one new --cert dev3.crt --key dev3.key https://"${CH}"/ | head -1)"
expect "9c after the router file is rewritten the old CA's certificate is refused and the new CA's works" "$(field "$B" old 3)|$(field "$C3" new 3)" '^000\|200$'

# ── 10: the rate limit of the chain is live ────────────────────────────────
sleep 40   # the bucket refills at 100 a minute: start the burst from a full one
B="$(probe burst)"
n200="$(printf '%s\n' "$B" | awk -F'|' '$3 == 200' | wc -l | tr -d ' ')"
n429="$(printf '%s\n' "$B" | awk -F'|' '$3 == 429' | wc -l | tr -d ' ')"
if (( n200 == 30 && n429 == 0 )); then pass "10a a first load's worth of requests (30 at once) all pass the chain's rate limit: ${n200} x 200, ${n429} x 429"; else fail "10a the rate limit throttled a first load: ${n200} x 200, ${n429} x 429"; fi
sleep 40
B="$(probe flood)"
n200="$(printf '%s\n' "$B" | awk -F'|' '$3 == 200' | wc -l | tr -d ' ')"
n429="$(printf '%s\n' "$B" | awk -F'|' '$3 == 429' | wc -l | tr -d ' ')"
if (( n200 >= 50 && n429 >= 1 )); then pass "10b the rate limit is live on the host: 150 quick requests gave ${n200} x 200 then ${n429} x 429"; else fail "10b the rate limit did not bite: ${n200} x 200, ${n429} x 429"; fi

echo
echo "control-panel-mtls-proof: ${PASS} passed, ${FAIL} failed"
(( FAIL == 0 && PASS >= 43 ))
