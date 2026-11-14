#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-operator-ca: the operator's device-certificate
# authority for the control panel's client-certificate gate.
# Run: bats test/host/operator-ca.bats
#
# Real openssl throughout (a throwaway CA per test, never shimmed): the point of
# the tool is what the certificates ARE, so the tests read them back. The
# workstation half (create, issue) runs under a GREMION_ROOT with no
# etc/env/state.env, the host half (install, status) under a root that has one.

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
OPCA="${PROJECT_ROOT}/infra/host/bin/gremion-operator-ca"

setup() {
    setup_host_root
    HOSTROOT="$GREMION_ROOT"
    WS="${BATS_TEST_TMPDIR}/ws"
    mkdir -p "$WS"
    CADIR="${WS}/ca"
    printf 'ca-passphrase-for-tests\n' > "${WS}/ca.pass"
    printf 'p12-passphrase-for-tests\n' > "${WS}/p12.pass"
    export GREMION_OPERATOR_CA_DIR="$CADIR"
}

teardown() {
    teardown_host_root
}

# On the operator's machine: a root that is not a host.
workstation() { export GREMION_ROOT="${BATS_TEST_TMPDIR}/not-a-host"; mkdir -p "$GREMION_ROOT"; }
# On the host.
onhost() { export GREMION_ROOT="$HOSTROOT"; printf 'STACK=test\n' > "${GREMION_ROOT}/etc/env/state.env"; }

make_ca() { workstation; run "$OPCA" create --passfile "${WS}/ca.pass"; [ "$status" -eq 0 ] || { echo "$output"; return 1; }; }

issue() {  # <name> [extra args]
    local n="$1"; shift
    run "$OPCA" issue --name "$n" --out "${WS}/${n}.p12" --passfile "${WS}/ca.pass" --p12-passfile "${WS}/p12.pass" "$@"
}

dev_pem() {  # <name> -> ${WS}/<name>.pem, the leaf certificate out of the bundle
    openssl pkcs12 -in "${WS}/$1.p12" -clcerts -nokeys -passin "file:${WS}/p12.pass" -out "${WS}/$1.pem" 2>/dev/null
}

# ── structure ──────────────────────────────────────────────────────────────

@test "gremion-operator-ca exists, is executable, runs under strict mode and carries a bare shellcheck source directive" {
    [ -x "$OPCA" ]
    sed -n 2p "$OPCA" | grep -qx 'set -euo pipefail'
    grep -qx '# shellcheck source=../lib/common.sh' "$OPCA"
}

@test "no command, an unknown command and --help: usage, 2, 2 and 0" {
    run "$OPCA"
    [ "$status" -eq 2 ]
    run "$OPCA" wat
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown command: wat"* ]]
    run "$OPCA" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"revoc"* || "$output" == *"install"* ]]
}

# ── create ─────────────────────────────────────────────────────────────────

@test "create: an ENCRYPTED EC key (0600) in a 0700 directory and a CA certificate that is a CA, with the key usage a CA needs" {
    workstation
    run "$OPCA" create --passfile "${WS}/ca.pass"
    echo "$output"
    [ "$status" -eq 0 ]
    grep -q 'BEGIN ENCRYPTED PRIVATE KEY' "${CADIR}/ca.key"
    [ "$(stat -c %a "${CADIR}/ca.key")" = "600" ]
    [ "$(stat -c %a "$CADIR")" = "700" ]
    run openssl x509 -in "${CADIR}/ca.pem" -noout -text
    [[ "$output" == *"CA:TRUE"* ]]
    [[ "$output" == *"Certificate Sign, CRL Sign"* ]]
    [[ "$output" == *"Public Key Algorithm: id-ecPublicKey"* ]]
    # the key is unusable without the passphrase
    run openssl pkey -in "${CADIR}/ca.key" -noout -passin pass:wrong
    [ "$status" -ne 0 ]
    run openssl pkey -in "${CADIR}/ca.key" -noout -passin "file:${WS}/ca.pass"
    [ "$status" -eq 0 ]
}

@test "create: the CA certificate is valid for the requested number of days" {
    workstation
    run "$OPCA" create --passfile "${WS}/ca.pass" --days 400
    [ "$status" -eq 0 ]
    run openssl x509 -in "${CADIR}/ca.pem" -noout -checkend $(( 399 * 86400 ))
    [ "$status" -eq 0 ]
    run openssl x509 -in "${CADIR}/ca.pem" -noout -checkend $(( 402 * 86400 ))
    [ "$status" -ne 0 ]
}

@test "create: refuses to run on a host (a root with etc/env/state.env), and writes nothing" {
    onhost
    run "$OPCA" create --passfile "${WS}/ca.pass"
    [ "$status" -eq 2 ]
    [[ "$output" == *"runs on your own machine, not on this host"* ]]
    [ ! -e "$CADIR" ]
}

@test "create: refuses an unencrypted key (no passfile and no terminal) and writes nothing" {
    workstation
    run "$OPCA" create
    [ "$status" -eq 2 ]
    [[ "$output" == *"the CA key must be encrypted"* ]]
    [ ! -e "${CADIR}/ca.key" ]
}

@test "create: never overwrites an existing CA" {
    make_ca
    cp "${CADIR}/ca.key" "${WS}/key.before"
    run "$OPCA" create --passfile "${WS}/ca.pass"
    [ "$status" -eq 2 ]
    [[ "$output" == *"a CA already exists"* ]]
    cmp -s "${CADIR}/ca.key" "${WS}/key.before"
}

# ── issue ──────────────────────────────────────────────────────────────────

@test "issue: a PKCS#12 bundle (0600) whose certificate is a client certificate valid for 90 days, signed by the CA, with no CA flag" {
    make_ca
    issue alices-laptop
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(stat -c %a "${WS}/alices-laptop.p12")" = "600" ]
    dev_pem alices-laptop
    run openssl x509 -in "${WS}/alices-laptop.pem" -noout -text
    [[ "$output" == *"CA:FALSE"* ]]
    [[ "$output" == *"TLS Web Client Authentication"* ]]
    [[ "$output" == *"CN = alices-laptop"* ]]
    [[ "$output" == *"Digital Signature"* ]]
    # 90 days: still valid at 89, gone by 91
    run openssl x509 -in "${WS}/alices-laptop.pem" -noout -checkend $(( 89 * 86400 ))
    [ "$status" -eq 0 ]
    run openssl x509 -in "${WS}/alices-laptop.pem" -noout -checkend $(( 91 * 86400 ))
    [ "$status" -ne 0 ]
    # the chain, with the CA the bundle carries and with the CA file alone
    run openssl verify -CAfile "${CADIR}/ca.pem" -purpose sslclient "${WS}/alices-laptop.pem"
    [ "$status" -eq 0 ]
    # the private key is in the bundle and nowhere beside it
    run openssl pkcs12 -in "${WS}/alices-laptop.p12" -nocerts -nodes -passin "file:${WS}/p12.pass"
    [[ "$output" == *"PRIVATE KEY"* ]]
}

@test "issue: the bundle is unreadable without its passphrase" {
    make_ca
    issue d1
    [ "$status" -eq 0 ]
    run openssl pkcs12 -in "${WS}/d1.p12" -nokeys -passin pass:wrong
    [ "$status" -ne 0 ]
}

@test "issue: every device gets its own key and serial, and issued.log lists them without a secret" {
    make_ca
    issue d1; [ "$status" -eq 0 ]
    issue d2; [ "$status" -eq 0 ]
    dev_pem d1; dev_pem d2
    [ "$(openssl x509 -in "${WS}/d1.pem" -noout -serial)" != "$(openssl x509 -in "${WS}/d2.pem" -noout -serial)" ]
    [ "$(openssl x509 -in "${WS}/d1.pem" -noout -pubkey)" != "$(openssl x509 -in "${WS}/d2.pem" -noout -pubkey)" ]
    [ "$(wc -l < "${CADIR}/issued.log")" -eq 2 ]
    grep -q ' d1 serial=' "${CADIR}/issued.log"
    grep -q ' d2 serial=' "${CADIR}/issued.log"
    assert_absent 'PRIVATE|[Pp]ass' "${CADIR}/issued.log"
}

@test "issue: more than 90 days is refused" {
    make_ca
    issue d1 --days 91
    [ "$status" -eq 2 ]
    [[ "$output" == *"valid at most 90 days"* ]]
    [ ! -e "${WS}/d1.p12" ]
    issue d1 --days 30
    [ "$status" -eq 0 ]
    dev_pem d1
    run openssl x509 -in "${WS}/d1.pem" -noout -checkend $(( 31 * 86400 ))
    [ "$status" -ne 0 ]
}

@test "issue: a device name that is not a plain name is refused" {
    make_ca
    local n
    for n in "" "-x" "a b" "../x" 'a;b' "$(printf 'x%.0s' $(seq 1 64))"; do
        run "$OPCA" issue --name "$n" --out "${WS}/x.p12" --passfile "${WS}/ca.pass" --p12-passfile "${WS}/p12.pass"
        [ "$status" -eq 2 ] || { echo "name '${n}': exit ${status}"; return 1; }
    done
    [ ! -e "${WS}/x.p12" ]
}

@test "issue: a wrong CA passphrase fails and leaves no bundle" {
    make_ca
    printf 'not-the-passphrase\n' > "${WS}/bad.pass"
    run "$OPCA" issue --name d1 --out "${WS}/d1.p12" --passfile "${WS}/bad.pass" --p12-passfile "${WS}/p12.pass"
    [ "$status" -eq 1 ]
    [[ "$output" == *"could not sign the device certificate"* ]]
    [ ! -e "${WS}/d1.p12" ]
}

@test "issue: a bundle that fails its read-back is REMOVED (it holds the device key), exits 1, and is not logged" {
    make_ca
    local real; real="$(command -v openssl)"
    # the real openssl for everything but `openssl verify`, which is the read-back's chain check
    shim openssl "if [ \"\$1\" = verify ]; then echo 'forced: chain does not verify' >&2; exit 2; fi; exec '${real}' \"\$@\""
    issue d1
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not verify against the CA, so it was removed and nothing was logged"* ]]
    [ ! -e "${WS}/d1.p12" ]
    # the log names only what passed the read-back
    [ ! -s "${CADIR}/issued.log" ] || ! grep -q ' d1 ' "${CADIR}/issued.log"
}

# The runbook's default form: no --p12-passfile, a person at a terminal. The read-back runs
# with stderr captured, which is not a terminal, so it must not need one: every other case
# here passes --p12-passfile and so never touched this path.
@test "issue: at a terminal, with no --p12-passfile, it asks for the bundle passphrase twice, writes the bundle, passes its read-back and logs it" {
    make_ca
    command -v script >/dev/null || skip "util-linux script is needed to give the tool a terminal"
    printf 'typed-bundle-passphrase\ntyped-bundle-passphrase\n' > "${WS}/typed.in"
    run bash -c "script -qec \"'$OPCA' issue --name tty1 --out '${WS}/tty1.p12' --passfile '${WS}/ca.pass'\" /dev/null < '${WS}/typed.in'"
    echo "$output"
    [ "$status" -eq 0 ]
    [ -s "${WS}/tty1.p12" ]
    grep -q ' tty1 ' "${CADIR}/issued.log"
    # the bundle opens with the passphrase that was typed, and with no other
    run openssl pkcs12 -in "${WS}/tty1.p12" -clcerts -nokeys -passin 'pass:typed-bundle-passphrase'
    [ "$status" -eq 0 ]
    run openssl pkcs12 -in "${WS}/tty1.p12" -clcerts -nokeys -passin 'pass:p12-passphrase-for-tests'
    [ "$status" -ne 0 ]
}

@test "issue: at a terminal with no passfile at all, the CA passphrase is asked by openssl and the bundle passphrase by the tool" {
    make_ca
    command -v script >/dev/null || skip "util-linux script is needed to give the tool a terminal"
    printf 'typed-bundle-passphrase\ntyped-bundle-passphrase\nca-passphrase-for-tests\n' > "${WS}/typed.in"
    run bash -c "script -qec \"'$OPCA' issue --name tty4 --out '${WS}/tty4.p12'\" /dev/null < '${WS}/typed.in'"
    echo "$output"
    [ "$status" -eq 0 ]
    [ -s "${WS}/tty4.p12" ]
    grep -q ' tty4 ' "${CADIR}/issued.log"
}

@test "issue: at a terminal, two different bundle passphrases or an empty one write nothing" {
    make_ca
    command -v script >/dev/null || skip "util-linux script is needed to give the tool a terminal"
    printf 'one-passphrase\nanother-passphrase\n' > "${WS}/typed.in"
    run bash -c "script -qec \"'$OPCA' issue --name tty2 --out '${WS}/tty2.p12' --passfile '${WS}/ca.pass'\" /dev/null < '${WS}/typed.in'"
    [ "$status" -ne 0 ]
    [[ "$output" == *"did not match"* ]]
    [ ! -e "${WS}/tty2.p12" ]
    printf '\n\n' > "${WS}/typed.in"
    run bash -c "script -qec \"'$OPCA' issue --name tty3 --out '${WS}/tty3.p12' --passfile '${WS}/ca.pass'\" /dev/null < '${WS}/typed.in'"
    [ "$status" -ne 0 ]
    [[ "$output" == *"empty"* ]]
    [ ! -e "${WS}/tty3.p12" ]
}

@test "issue: never overwrites a bundle, and refuses on a host" {
    make_ca
    issue d1; [ "$status" -eq 0 ]
    issue d1
    [ "$status" -eq 2 ]
    [[ "$output" == *"never overwritten"* ]]
    onhost
    issue d3
    [ "$status" -eq 2 ]
    [[ "$output" == *"runs on your own machine, not on this host"* ]]
}

@test "issue: without a terminal and without the passphrase files it refuses instead of hanging" {
    make_ca
    run "$OPCA" issue --name d1 --out "${WS}/d1.p12"
    [ "$status" -eq 2 ]
    [[ "$output" == *"pass --passfile"* ]]
    run "$OPCA" issue --name d1 --out "${WS}/d1.p12" --passfile "${WS}/ca.pass"
    [ "$status" -eq 2 ]
    [[ "$output" == *"pass --p12-passfile"* ]]
}

@test "issue --compat writes a bundle with the old 3DES/SHA1 encryption, still verifying" {
    make_ca
    issue d1 --compat
    [ "$status" -eq 0 ]
    run bash -c "openssl pkcs12 -in '${WS}/d1.p12' -info -nokeys -passin 'file:${WS}/p12.pass' 2>&1 >/dev/null | head -5"
    [[ "$output" == *"TripleDES"* || "$output" == *"3DES"* || "$output" == *"des-ede3"* ]]
    run "$OPCA" verify "${WS}/d1.p12" --ca "${CADIR}/ca.pem" --p12-passfile "${WS}/p12.pass"
    [ "$status" -eq 0 ]
}

# ── verify ─────────────────────────────────────────────────────────────────

@test "verify: a device certificate of this CA passes, in a bundle and as a PEM" {
    make_ca
    issue d1; [ "$status" -eq 0 ]
    dev_pem d1
    run "$OPCA" verify "${WS}/d1.p12" --p12-passfile "${WS}/p12.pass"
    [ "$status" -eq 0 ]
    [[ "$output" == *"signed by"* && "$output" == *"a client certificate, valid until"* ]]
    run "$OPCA" verify "${WS}/d1.pem" --ca "${CADIR}/ca.pem"
    [ "$status" -eq 0 ]
}

@test "verify: a certificate another CA signed fails (the edge would refuse it)" {
    make_ca
    cp -r "$CADIR" "${WS}/ca-one"
    rm -rf "$CADIR"
    run "$OPCA" create --passfile "${WS}/ca.pass"
    [ "$status" -eq 0 ]
    issue stranger; [ "$status" -eq 0 ]
    run "$OPCA" verify "${WS}/stranger.p12" --ca "${WS}/ca-one/ca.pem" --p12-passfile "${WS}/p12.pass"
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not verify against"* ]]
}

@test "verify: an EXPIRED device certificate fails" {
    make_ca
    # a device certificate the real CA signed with a validity window in the past
    cat > "${WS}/ca.cnf" <<EOF
[ca]
default_ca = CA_default
[CA_default]
database = ${WS}/index.txt
new_certs_dir = ${WS}
serial = ${WS}/serial
default_md = sha256
policy = pol
unique_subject = no
[pol]
commonName = supplied
EOF
    : > "${WS}/index.txt"; printf '1000\n' > "${WS}/serial"
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' > "${WS}/ext.cnf"
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "${WS}/old.key" -out "${WS}/old.csr" -subj "/CN=old-device" 2>/dev/null
    openssl ca -config "${WS}/ca.cnf" -batch -notext -in "${WS}/old.csr" -cert "${CADIR}/ca.pem" -keyfile "${CADIR}/ca.key" \
        -passin "file:${WS}/ca.pass" -startdate 20200101000000Z -enddate 20200401000000Z -extfile "${WS}/ext.cnf" -out "${WS}/old.pem" 2>/dev/null
    [ -s "${WS}/old.pem" ]
    run "$OPCA" verify "${WS}/old.pem" --ca "${CADIR}/ca.pem"
    [ "$status" -eq 1 ]
    [[ "$output" == *"expired"* || "$output" == *"does not verify"* ]]
}

@test "verify: a certificate with no client-auth purpose (a server leaf) fails" {
    make_ca
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "${WS}/s.key" -out "${WS}/s.csr" -subj "/CN=srv" 2>/dev/null
    printf 'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > "${WS}/s.ext"
    openssl x509 -req -in "${WS}/s.csr" -CA "${CADIR}/ca.pem" -CAkey "${CADIR}/ca.key" -passin "file:${WS}/ca.pass" \
        -set_serial 77 -days 30 -extfile "${WS}/s.ext" -out "${WS}/s.pem" 2>/dev/null
    run "$OPCA" verify "${WS}/s.pem" --ca "${CADIR}/ca.pem"
    [ "$status" -eq 1 ]
}

@test "verify: a missing file, a wrong bundle passphrase and no CA are usage errors or failures, never a pass" {
    make_ca
    run "$OPCA" verify "${WS}/nope.pem" --ca "${CADIR}/ca.pem"
    [ "$status" -eq 2 ]
    issue d1; [ "$status" -eq 0 ]
    printf 'wrong\n' > "${WS}/wrong.pass"
    run "$OPCA" verify "${WS}/d1.p12" --ca "${CADIR}/ca.pem" --p12-passfile "${WS}/wrong.pass"
    [ "$status" -eq 1 ]
    rm -rf "$CADIR"
    dev_pem d1
    run "$OPCA" verify "${WS}/d1.pem"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no CA certificate"* ]]
}

# ── install (host) ─────────────────────────────────────────────────────────

@test "install: places the CA certificate at etc/edge/mtls/operator-ca.pem (0644), and the host never gets the key" {
    make_ca
    onhost
    run "$OPCA" install --ca "${CADIR}/ca.pem"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"no etc/edge/control-panel.yml yet"* ]]
    dest="${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    cmp -s "${CADIR}/ca.pem" "$dest"
    [ "$(stat -c %a "$dest")" = "644" ]
    [ "$(stat -c %a "${GREMION_ROOT}/etc/edge/mtls")" = "755" ]
    run grep -rq 'PRIVATE KEY' "${GREMION_ROOT}/etc/edge"
    [ "$status" -ne 0 ]
}

@test "install: refuses a file that carries the private key, and a CA directory's key file" {
    make_ca
    onhost
    cat "${CADIR}/ca.pem" "${CADIR}/ca.key" > "${WS}/both.pem"
    run "$OPCA" install --ca "${WS}/both.pem"
    [ "$status" -eq 2 ]
    [[ "$output" == *"contains a private key"* ]]
    run "$OPCA" install --ca "${CADIR}/ca.key"
    [ "$status" -eq 2 ]
    [ ! -e "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem" ]
}

@test "install: refuses a certificate that is not a CA, and one that is not PEM" {
    make_ca
    issue d1; [ "$status" -eq 0 ]
    dev_pem d1
    onhost
    run "$OPCA" install --ca "${WS}/d1.pem"
    [ "$status" -eq 2 ]
    [[ "$output" == *"is not a CA certificate"* ]]
    printf 'garbage\n' > "${WS}/g.pem"
    run "$OPCA" install --ca "${WS}/g.pem"
    [ "$status" -eq 2 ]
    [[ "$output" == *"holds no PEM certificate"* ]]
    [ ! -e "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem" ]
}

@test "install: replaces the CA (the rotation that revokes), and --add keeps the old one beside the new, once" {
    make_ca
    mv "$CADIR" "${WS}/ca-old"
    run "$OPCA" create --passfile "${WS}/ca.pass"
    [ "$status" -eq 0 ]
    onhost
    dest="${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "$OPCA" install --ca "${WS}/ca-old/ca.pem"
    [ "$status" -eq 0 ]
    run "$OPCA" install --ca "${CADIR}/ca.pem" --add
    [ "$status" -eq 0 ]
    [ "$(grep -c 'BEGIN CERTIFICATE' "$dest")" -eq 2 ]
    run "$OPCA" install --ca "${CADIR}/ca.pem" --add
    [ "$status" -eq 2 ]
    [[ "$output" == *"already installed"* ]]
    [ "$(grep -c 'BEGIN CERTIFICATE' "$dest")" -eq 2 ]
    # a plain install REPLACES: only the new CA is left
    run "$OPCA" install --ca "${CADIR}/ca.pem"
    [ "$status" -eq 0 ]
    [ "$(grep -c 'BEGIN CERTIFICATE' "$dest")" -eq 1 ]
    cmp -s "${CADIR}/ca.pem" "$dest"
}

# A CA certificate whose validity ended in the past, as a PEM at $1 (signed by its own key).
expired_ca() {
    cat > "${WS}/exp.cnf" <<EOF
[ca]
default_ca = CA_default
[CA_default]
database = ${WS}/exp-index.txt
new_certs_dir = ${WS}
serial = ${WS}/exp-serial
default_md = sha256
policy = pol
unique_subject = no
x509_extensions = v3
[pol]
commonName = supplied
[v3]
basicConstraints = critical,CA:TRUE
EOF
    : > "${WS}/exp-index.txt"; printf '2000\n' > "${WS}/exp-serial"
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "${WS}/exp.key" -out "${WS}/exp.csr" -subj "/CN=expired operator CA" 2>/dev/null
    openssl ca -config "${WS}/exp.cnf" -batch -notext -selfsign -in "${WS}/exp.csr" -keyfile "${WS}/exp.key" \
        -startdate 20200101000000Z -enddate 20200401000000Z -out "$1" 2>/dev/null
    [ -s "$1" ]
}

@test "install: a file with several certificates is refused unless --add, and every certificate in it is held to the CA and expiry rules" {
    make_ca
    mv "$CADIR" "${WS}/ca-old"
    run "$OPCA" create --passfile "${WS}/ca.pass"
    [ "$status" -eq 0 ]
    cat "${WS}/ca-old/ca.pem" "${CADIR}/ca.pem" > "${WS}/two.pem"
    onhost
    dest="${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "$OPCA" install --ca "${WS}/two.pem"
    [ "$status" -eq 2 ]
    [[ "$output" == *"holds 2 certificates"* ]]
    [ ! -e "$dest" ]
    run "$OPCA" install --ca "${WS}/two.pem" --add
    [ "$status" -eq 0 ]
    [ "$(grep -c 'BEGIN CERTIFICATE' "$dest")" -eq 2 ]
    # a good CA FIRST and a certificate that is not a CA behind it
    cat "${CADIR}/ca.pem" > "${WS}/mixed.pem"
    workstation
    issue d1; [ "$status" -eq 0 ]
    dev_pem d1
    cat "${WS}/d1.pem" >> "${WS}/mixed.pem"
    onhost
    run "$OPCA" install --ca "${WS}/mixed.pem" --add
    [ "$status" -eq 2 ]
    [[ "$output" == *"(#2 of 2) that is not a CA certificate"* ]]
    # a good CA first and an expired one behind it
    expired_ca "${WS}/expired.pem"
    cat "${CADIR}/ca.pem" "${WS}/expired.pem" > "${WS}/stale.pem"
    run "$OPCA" install --ca "${WS}/stale.pem" --add
    [ "$status" -eq 2 ]
    [[ "$output" == *"(#2 of 2) that has expired"* ]]
    # what was installed before is untouched by every refusal
    [ "$(grep -c 'BEGIN CERTIFICATE' "$dest")" -eq 2 ]
}

@test "install --add refuses a result with an expired certificate in it, and changes nothing" {
    make_ca
    onhost
    dest="${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    expired_ca "${WS}/expired.pem"
    mkdir -p "${GREMION_ROOT}/etc/edge/mtls"
    cp "${WS}/expired.pem" "$dest"
    cp "$dest" "${WS}/before.pem"
    run "$OPCA" install --ca "${CADIR}/ca.pem" --add
    [ "$status" -eq 2 ]
    [[ "$output" == *"nothing was changed"* ]]
    cmp -s "${WS}/before.pem" "$dest"
}

@test "install: makes traefik re-read the CA by rewriting the router file's timestamp (measured: it does not watch the CA file)" {
    make_ca
    onhost
    printf 'http:\n  routers: {}\n' > "${GREMION_ROOT}/etc/edge/control-panel.yml"
    touch -d '2020-01-01 00:00:00' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    run "$OPCA" install --ca "${CADIR}/ca.pem"
    [ "$status" -eq 0 ]
    [[ "$output" == *"touched etc/edge/control-panel.yml"* ]]
    [ "$(stat -c %Y "${GREMION_ROOT}/etc/edge/control-panel.yml")" -gt "$(date -d '2021-01-01' +%s)" ]
}

@test "install: without etc/edge it is a usage error, without --ca too" {
    make_ca
    onhost
    run "$OPCA" install
    [ "$status" -eq 2 ]
    rmdir "${GREMION_ROOT}/etc/edge"
    run "$OPCA" install --ca "${CADIR}/ca.pem"
    [ "$status" -eq 2 ]
    [[ "$output" == *"install runs on the host"* ]]
}

# ── status (host) ──────────────────────────────────────────────────────────

@test "status: says whether the install opted in, whether the router file exists, and what CA is installed" {
    make_ca
    onhost
    run "$OPCA" status
    [ "$status" -eq 0 ]
    [[ "$output" == *"opt-in (CONTROL_PANEL_ORIGIN in state.env): off"* ]]
    [[ "$output" == *"operator CA: none installed"* ]]
    run "$OPCA" install --ca "${CADIR}/ca.pem"
    [ "$status" -eq 0 ]
    printf 'CONTROL_PANEL_ORIGIN=https://control.example.org\n' >> "${GREMION_ROOT}/etc/env/state.env"
    run "$OPCA" status
    [ "$status" -eq 0 ]
    [[ "$output" == *"opt-in (CONTROL_PANEL_ORIGIN in state.env): https://control.example.org"* ]]
    [[ "$output" == *"operator CA #1: subject"* || "$output" == *"operator CA #1:"* ]]
    [[ "$output" == *"Gremion operator CA"* ]]
}

@test "status: a quoted CONTROL_PANEL_ORIGIN is shown as the origin, and a quoted empty one as off (the same reading the render and the deploy use)" {
    make_ca
    onhost
    printf 'CONTROL_PANEL_ORIGIN="https://control.example.org"
' >> "${GREMION_ROOT}/etc/env/state.env"
    run "$OPCA" status
    [ "$status" -eq 0 ]
    [[ "$output" == *"opt-in (CONTROL_PANEL_ORIGIN in state.env): https://control.example.org"* ]]
    sed -i '/^CONTROL_PANEL_ORIGIN=/d' "${GREMION_ROOT}/etc/env/state.env"
    printf 'CONTROL_PANEL_ORIGIN=""
' >> "${GREMION_ROOT}/etc/env/state.env"
    run "$OPCA" status
    [ "$status" -eq 0 ]
    [[ "$output" == *"opt-in (CONTROL_PANEL_ORIGIN in state.env): off"* ]]
}

# ── the whole chain, the way the host uses it ──────────────────────────────

@test "a CA made here is accepted by the real gremion-render, and so is a rotated one (the router file changes with it)" {
    make_ca
    onhost
    # an opted-in host: state.env, both app envs with the overlay, a release tree with the router template, the panel service in the edge
    local rel="${GREMION_ROOT}/releases/r1" c
    mkdir -p "${rel}/docker" "${rel}/infra/host/templates/edge"
    cp "${PROJECT_ROOT}/infra/host/templates/edge/control-panel.yml.tmpl" "${rel}/infra/host/templates/edge/"
    optin_state() { printf 'STACK=test\nPLATFORM_DOMAIN=example.org\nTRAEFIK_CERT_RESOLVER=le-http\nCONTROL_PANEL_ORIGIN=https://control.example.org\n' > "${GREMION_ROOT}/etc/env/state.env"; }
    optin_state
    for c in blue green; do
        printf 'COLOUR=%s\nCOMPOSE_FILE=docker-compose.app.yml:docker-compose.control-public.yml\nCONTROL_PANEL_ORIGIN=https://control.example.org\n' "$c" > "${GREMION_ROOT}/etc/env/app-${c}.env"
    done
    printf 'http:\n  services:\n    panel:\n      loadBalancer: {}\n' > "${GREMION_ROOT}/etc/edge/active.yml"
    run "$OPCA" install --ca "${CADIR}/ca.pem"
    [ "$status" -eq 0 ]
    dest="${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "${PROJECT_ROOT}/infra/host/bin/gremion-render" --release "$rel" --control-panel-only
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"public at https://control.example.org behind the operator CA (1 certificate(s)"* ]]
    [ -s "${GREMION_ROOT}/etc/edge/control-panel.yml" ]
    first="$(fingerprint_of "$dest")"
    # the rotation: a NEW CA in a new directory replaces the old one, and the render accepts it too
    mv "$CADIR" "${WS}/ca-old"
    workstation
    run "$OPCA" create --passfile "${WS}/ca.pass"
    [ "$status" -eq 0 ]
    onhost; optin_state
    run "$OPCA" install --ca "${CADIR}/ca.pem"
    [ "$status" -eq 0 ]
    second="$(fingerprint_of "$dest")"
    [ "$first" != "$second" ]
    [ "$second" = "$(fingerprint_of "${CADIR}/ca.pem")" ]
    run "${PROJECT_ROOT}/infra/host/bin/gremion-render" --release "$rel" --control-panel-only
    echo "$output"
    [ "$status" -eq 0 ]
    # a certificate the OLD CA signed does not verify against what the host now holds
    # (the old CA's key is still on this workstation: issue with it, then check against the host's file)
    workstation
    run "$OPCA" issue --name olddev --out "${WS}/olddev.p12" --passfile "${WS}/ca.pass" --p12-passfile "${WS}/p12.pass" --dir "${WS}/ca-old"
    [ "$status" -eq 0 ]
    run "$OPCA" verify "${WS}/olddev.p12" --ca "$dest" --p12-passfile "${WS}/p12.pass"
    [ "$status" -eq 1 ]
}

fingerprint_of() { openssl x509 -in "$1" -noout -fingerprint -sha256; }
