# Go-live gate

**No real users and no real personal data on an instance until every item below
is green.** This document supersedes every earlier gate list.

An item is green only when the command in its **Proof** has been run against the
**running instance** and the named line or artefact was observed. An exit code is
not evidence — a suite that collected no files exits 0, and `apt-get install`
returning 0 does not put a binary on `PATH`. A proof that prints `BLOCKED:` is
not green: record the blocker and stop. Neither is a proof that prints
`deferred`: that word means the tool could not observe the thing it was asked
about, which is not the same as observing that it holds.

Addresses and names in this document are documentation values (`example.org`,
`203.0.113.0/24`, `2001:db8::/32`). A deployment's real values live in
`/opt/gremion/etc/env/state.env` and in that deployment's own private annex; every
command below reads them from the env file instead of naming them.

## How to read an item

| Field | Meaning |
|---|---|
| **Gate:** | the condition that must hold |
| **Proof:** | the exact command, run against the running instance, and the line or artefact it must produce |
| **Owner:** | `OPERATOR` (a decision or an action off the host), `AGENT` (runs the command), or `OPERATOR + AGENT` |
| **Evidence:** | the file in the deployment's private annex where the output is filed |

Every Proof block assumes this preamble:

```bash
. /opt/gremion/current/infra/host/lib/common.sh
load_env /opt/gremion/etc/env/state.env
load_env /opt/gremion/etc/gate-inputs.env
export PATH="/opt/gremion/bin:$PATH"
```

`/opt/gremion/etc/gate-inputs.env` (0600, owner `gremion`) is the operator's
gate input file. It holds no secrets, only the identities the proofs need:
`GATE_TENANT_HOST`, `GATE_TENANT_SLUG`, `GATE_TENANT_LEGAL_ENTITY`,
`GATE_SCRATCH_SLUG`, `GATE_SCRATCH_TENANT_ID`, `GATE_EXTERNAL_MAILBOX_A`,
`GATE_EXTERNAL_MAILBOX_B`, `GATE_OPERATOR_MAILBOX`. `load_env` refuses a
`CHANGE_ME_` value, so an unfilled input fails the preamble rather than the
proof.

## G1-LEGAL

**Gate:** the platform's own Impressum and Datenschutz are served and are owned
by the control plane, not by a hand-edited env file; the pilot tenant's legal
texts name the tenant's own responsible entity; DPIA, ROPA, AVV and the
accessibility statement exist as signed documents; the CRA reporting posture is
written down.

**Proof:**

```bash
curl -fsS "https://${PLATFORM_DOMAIN}/impressum"   | grep -qi 'impressum'   && echo 'G1 platform-impressum=served'
curl -fsS "https://${PLATFORM_DOMAIN}/datenschutz" | grep -qi 'datenschutz' && echo 'G1 platform-datenschutz=served'
curl -fsS "https://${GATE_TENANT_HOST}/impressum"  | grep -qF "${GATE_TENANT_LEGAL_ENTITY}" && echo 'G1 tenant-impressum=named'
# ownership: hash the served page, change one character of the platform
# Impressum in the control plane, re-fetch. The hashes must differ with no
# redeploy and no file edit on the host.
curl -fsS "https://${PLATFORM_DOMAIN}/impressum" | sha256sum
```

The four documents are filed by name and date; a draft is not a document.

**Owner:** OPERATOR + AGENT
**Evidence:** `G1-legal.md`

## G2-RESTORE

**Gate:** a restore from the off-site copy has been proven into a separate stack
and printed its `RTO-SECONDS=` line, and a full release rehearsal — including one
`overlap: false` release and its rollback — has run on staging with that restore
time recorded. The RPO is written down (the daily backup interval plus the
pre-release snapshot).

**Proof:**

```bash
gremion-restore-into --stack staging --snapshot latest --rto
# must print: RTO-SECONDS=<n>
jq -e '.ok == true' /opt/gremion/runtime/last-restore.json
jq -e '.ok == true and .offsite == true' /opt/gremion/runtime/last-backup.json
```

The rehearsal record published on the release tag must name that exact tag and
carry a green verify output; a release whose tag has no green record does not
pass this item.

**Owner:** AGENT
**Evidence:** `G2-restore.md`

## G3-VERIFY

**Gate:** the verification contract is green on the production instance after the
first deploy, and green again after a deliberate reboot — produced by the reboot
gate itself, not by a human re-running it.

**Proof:**

```bash
gremion-verify
jq -e '.ok == true and (.failures | length) == 0' /opt/gremion/runtime/last-verify.json
# deliberate reboot, then from a fresh session on the rebooted host:
systemctl show -p Result --value gremion-verify.service     # success
boot=$(date -d "$(uptime -s)" +%s)
jq -e --argjson boot "$boot" '.ok == true and ((.ts | fromdateiso8601) > $boot)' \
   /opt/gremion/runtime/last-verify.json
```

The last assertion is the one that matters: a `last-verify.json` older than the
boot means the reboot gate did not run, however green the file looks.

**Owner:** AGENT
**Evidence:** `G3-verify.md`

## G4-MAIL

**Gate:** `gremion-mail-bringup` prints its `MAIL-BRINGUP:` line with every
assert `ok` in the defined order, the real MX is the last record published, and
the reputation programmes (SNDS, JMRP, Postmaster Tools) are enrolled.

**Proof:**

```bash
gremion-mail-bringup --assert all \
  --external-to "${GATE_EXTERNAL_MAILBOX_A},${GATE_EXTERNAL_MAILBOX_B}"
# must print: MAIL-BRINGUP: 1=ok 2=ok 3=ok 4=ok 5=ok 6a=ok 6b=ok
gremion-dns-check --domain "${PLATFORM_DOMAIN}" \
  --edge-ip "${EDGE_BIND_IP}" --edge-ip6 "${EDGE_BIND_IP6}" \
  --mail-ip "${MAIL_BIND_IP}" --mail-ip6 "${MAIL_BIND_IP6}" --edit 4b
# every line OK; no MISSING and no WRONG line
```

`6b=BLOCKED` keeps this item red: the platform's own identity provider must send
its mail through the authenticated submission path like every other sender.

**Owner:** OPERATOR + AGENT
**Evidence:** `G4-mail.md`

## G5-TENANT

**Gate:** the first tenant exists because the control plane created it; no fixture
accounts survive; no development mail catcher and no hostname from a superseded
deployment appears in any container's environment.

**Proof:**

```bash
for c in $(docker ps --format '{{.Names}}'); do
  docker exec "$c" env 2>/dev/null \
    || docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c"
done | sed 's/^/env /' > /tmp/gate-env.txt
grep -Ei 'mailpit|SMTP_HOST=' /tmp/gate-env.txt | grep -v "mail.${PLATFORM_DOMAIN}"
# must print nothing
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://${GATE_TENANT_HOST}/api/setup/seed"
# 401, 403 or 404 — never 200
docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
  psql -U postgres -d "t_${GATE_TENANT_SLUG}" -tAc 'select email from users order by 1'
# every row is a real person named in the annex; no example.org or example.com address
```

**Owner:** AGENT
**Evidence:** `G5-tenant.md`

## G6-OFFBOX

**Gate:** an uptime probe outside the hosting provider and an alert channel
outside the host have both been proven by a deliberate failure and its recovery.
This is the only signal that survives the host being down.

**Proof:**

```bash
docker compose --env-file /opt/gremion/etc/env/state.env stop traefik
# wait one probe interval: the off-box probe must open an incident and the
# operator's channel must receive it. Record both timestamps.
docker compose --env-file /opt/gremion/etc/env/state.env start traefik
# the probe must close the incident. Record the recovery timestamp.
gremion-verify
docker compose --env-file /opt/gremion/etc/env/ops.env exec -T alertmanager \
  amtool --alertmanager.url=http://127.0.0.1:9093 alert add GateProbe severity=critical
# the same channel must receive the synthetic alert
```

Stopping the edge is safe here precisely because this gate runs before any real
user exists.

**Owner:** OPERATOR + AGENT
**Evidence:** `G6-offbox.md`

## G7-ERASURE

**Gate:** a scratch tenant has been erased through the control plane; its
per-tenant export artefacts decrypted with their own key **before** the erasure
and can no longer be decrypted with any surviving key **after** it; the ledger
records every subsystem including the skipped ones, the key destruction as its
own row, and the date on which the last retained snapshot containing that
tenant's rows expires.

**Proof:** two phases, in this order. The positive control runs *before* the
erasure: once the tenant is gone, a decryptor that cannot read anything is
indistinguishable from a successful erasure.

**Phase 1 — BEFORE the erasure (the positive control):**

```bash
# The decryptor must match what the kernel actually wrote. scripts/tenant-backup.sh
# names its artefacts *.age but, per its own DECISIONS header, encrypts with
# `openssl enc -aes-256-cbc -pbkdf2 -pass fd:3`. Dispatch on the magic bytes so
# this stays true if the kernel later standardises on real age; the positive
# control below is what makes a wrong decryptor fail loudly instead of making
# the negative control pass silently.
decrypt_artefact() {                       # <artefact> <key-file>
    local art="$1" key="$2"
    case "$(head -c 24 "$art" | tr -d '\0')" in
        Salted__*)
            openssl enc -d -aes-256-cbc -pbkdf2 -pass fd:3 3<"$key" \
                    -in "$art" -out /dev/null 2>/dev/null ;;
        age-encryption.org*)
            command -v age >/dev/null 2>&1 \
              || { echo "BLOCKED: age not installed, cannot evaluate G7" >&2; return 2; }
            age -d -i "$key" "$art" >/dev/null 2>&1 ;;
        *)  echo "G7 FAIL unknown artefact format in $art" >&2; return 2 ;;
    esac
}

art="$(find /opt/gremion/backups/tenants -type f \
           -name "${GATE_SCRATCH_SLUG}.dump.age" | head -n 1)"
[ -n "$art" ] || { echo 'G7 FAIL no export artefact for the scratch tenant'; exit 1; }
own_key="/opt/gremion/etc/secrets/tenants/${GATE_SCRATCH_SLUG}.backup-key"
other_key="$(find /opt/gremion/etc/secrets/tenants -name '*.backup-key' \
               ! -name "${GATE_SCRATCH_SLUG}.backup-key" | head -n 1)"
[ -n "$other_key" ] || { echo 'G7 FAIL no surviving tenant key to test against'; exit 1; }

cp "$art" /tmp/g7-artefact.copy            # the erasure removes the live tree

decrypt_artefact "$art" "$own_key" \
  && echo 'G7 positive-control=decrypts-with-own-key' \
  || { echo 'G7 FAIL the decryptor cannot read a live artefact — every result below is meaningless'; exit 1; }

decrypt_artefact "$art" "$other_key" \
  && echo 'G7 FAIL another tenant key already decrypts this artefact' \
  || echo 'G7 cross-key=refused'
```

**Phase 2 — AFTER erasing the scratch tenant through the control plane:**

```bash
test ! -e "$own_key" && echo 'G7 key=destroyed'
decrypt_artefact /tmp/g7-artefact.copy "$other_key" \
  && echo 'G7 FAIL artefact decrypted with a surviving key' \
  || echo 'G7 artefact=undecryptable'
shred -u /tmp/g7-artefact.copy

docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
  psql -U postgres -d gremion -tAc \
  "select subsystem, status from tenant_provisioning_resource where tenant_id = '${GATE_SCRATCH_TENANT_ID}' order by subsystem"
```

The item is green only with **all four** of `positive-control=decrypts-with-own-key`,
`cross-key=refused`, `key=destroyed` and `artefact=undecryptable` observed, in
that order. The ledger must show one row per subsystem the tenant touched, a
`backup-key` row whose status is `destroyed`, and the retention horizon. The
`backup-key` subsystem value and the horizon record are added by the control
plane's ledger widening; until that lands this item stays
`BLOCKED: erasure ledger widening`.

**Owner:** AGENT
**Evidence:** `G7-erasure.md`

## G8-GUARDS-RED

**Gate:** every guard in the host tooling has been watched RED by a process other
than the one that wrote it — including the firewall drills, the
no-surviving-registry-credential guard and the stack-isolation guard. The
firewall proof must be the fully-green `FW-PROOF:` line; a run that reports
`egress25-app=deferred` or `egress25-mail=deferred` is **not green** — `deferred`
means the provider firewall's outbound-25 state was never opened or never
asserted, and `gremion-fw-proof` exits 3 saying so. The `--scp-smtp-unblocked`
flag is the operator's statement that the provider firewall has been opened; it
may only be passed after that has actually been done.

**Proof:**

```bash
gremion-fw-proof --scp-smtp-unblocked
# must print: FW-PROOF: egress25-app=refused egress25-mail=allowed snat-mail=<mail bind address> docker-nat-table=present
grep -cE '^STEP [0-9]+ [a-z-]+ ok$'   /opt/gremion/runtime/deploy.log   # 12
grep -cE '^STEP [0-9]+ [a-z-]+ fail$' /opt/gremion/runtime/deploy.log   # 0
grep -q '"auths": {[^}]' /home/gremion/.docker/config.json
echo "auths-present exit=$?    # 1 means no registry credential survived the deploy"
bats test/host                 # from a checkout of the deployed tag: every guard suite green
```

The annex's RED register lists, per guard, the break command, the observed
failure text, and who watched it. The author of a guard may not be its witness.

**Owner:** OPERATOR + AGENT
**Evidence:** `G8-guards.md`

## Sequence

Each step is its own spec → plan → build. The gate is passed at step 8, not
before.

| Step | What | Feeds |
|---|---|---|
| 0 | Operator: addresses, reverse DNS, the provider firewall's real state | G4-MAIL, G8-GUARDS-RED |
| 1 | Kernel port-back and relocatability: images, pins, migration job, healthchecks | G5-TENANT |
| 2 | SDK, module repositories, assembler, migration ranges; the first assembled release | G5-TENANT |
| 3 | Control plane, storage seam, per-tenant isolation or refusal, fail-closed erasure, evict fan-out | G5-TENANT, G7-ERASURE |
| 4 | Host build: bootstrap, mail unit, backups, ops project, deploy transport | G6-OFFBOX, G8-GUARDS-RED |
| 5 | Staging rehearsal: first-run seed, restore-into, migration job, switch, an `overlap: false` release, rollback | G2-RESTORE |
| 6 | DNS edits 1–3 | G4-MAIL |
| 7 | First production deploy; platform init; tenant #1; mail bring-up through the MX edit | G3-VERIFY, G4-MAIL, G5-TENANT |
| 8 | Legal artefacts with the named organisation; this gate; real names | G1-LEGAL, G7-ERASURE |

## The private annex

A deployment's real addresses, hostnames, operator inputs and recorded evidence
never enter this repository. They live in that deployment's own private annex,
which holds the eight evidence files named above, the filled
`/opt/gremion/etc/gate-inputs.env`, and the RED register.

## What this gate deliberately does not hold

- Capacity numbers and retention sizing: measured and recorded, not gating.
- The DMARC ramp beyond `p=none`: it needs fourteen clean days per step and
  therefore cannot precede launch.
- Off-box probe vendor choice and alert channel: the operator's, proven by
  G6-OFFBOX rather than prescribed.
