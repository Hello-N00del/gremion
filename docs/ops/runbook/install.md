# Install: the from-zero bring-up

- Version: 1.0.0
- Wall-clock budget: one working day, from the start of step 1 to the asserted post-condition (PRD-PLAT-005)
- Implements: TRD-200 (install), TRD-042 (the from-zero rebuild, R15-2), FLOW-OPS-002
- First run: TASK-038, the pilot re-initialisation

This is the bring-up a rebuilt host follows (TRD-042, R15-2): the server is
rebuilt from zero through the provider panel, and its volumes, DNS records and
certificates are created new. Nothing from an earlier installation is carried
over. The procedure ends with the F1 guard set re-run on the rebuilt host
(TRD-004), a dated TRD-340 snapshot of every suite, and the platform's own
backup job installed but disabled (R15-1, see [backup.md](backup.md)).

Every bash step assumes this preamble, typed once per shell:

```bash
export TAG=dist-vX.Y.Z                       # the release being installed
export REL="/opt/gremion/releases/${TAG}"    # its tree on the host
export GREMION_SOURCE_URL="<the release source repository>"
export PATH="/opt/gremion/bin:$PATH"
```

## Preconditions

- Gate F1 is closed: TRD-004's guard set ran green on the release tip, dated
  (FLOW-OPS-002, "F1 behoben").
- The tag exists and its tree carries the contracts `gremion-deploy` checks at
  its step 2: `release.json` (the tag, a boolean `overlap`, a `migrations`
  array, a manifest digest), `docker-compose.pins.yml` and
  `docs/ops/release-1-waivers.md`.
- The administrator holds, on their own machine: the provider panel login, the
  registrar login, an SSH key the rebuilt server will accept for root, a
  registry token with read access to the release images (typed at a prompt,
  never written to disk), the deploy key's public half, and the release-signing
  public key for `bootstrap.sh trust`.
- The host's public addresses (edge and mail, IPv4 and IPv6) are known from the
  provider panel, for example `203.0.113.10` and `2001:db8::a`.
- Decided before the first `docker compose up`, because none of them can be
  changed cheaply afterwards (lessons of an earlier cutover, E1, E10, E11):
  - every env file passes `gremion-validate-env` before any `up` (step 8);
  - `PLATFORM_DOMAIN` is final: the identity provider's realm URLs and the
    homeserver name are derived from it at first start and do not follow a later
    change;
  - `STACK=gremion` on this production host, so every compose project is
    `${STACK}-<project>` and every shared volume `${STACK}_<name>`, and two
    stacks on one machine never touch each other's resources;
    `GREMION_PRODUCTION_STACK=gremion` here (the literal `none` on a host with
    no production unit).
- An off-site restic remote is reachable for the one baseline backup of step 13
  (see Known gaps).

## Steps

1. **Rebuild the server from zero.** MANUAL: at the provider panel, reinstall
   the server with a fresh Debian image and the administrator's SSH key for
   root, delete every snapshot and extra volume the earlier installation left,
   and set the reverse DNS (PTR) of the edge and mail addresses to the host
   FQDN. Record the time the rebuild started: it is the run's `started_at`.

2. **Publish DNS edit 1.** MANUAL: at the registrar, delete every record of the
   earlier installation, then publish the address records (A and AAAA) of the
   platform domain and each tenant host, pointing at the edge addresses. Record
   the time.

3. **Fetch the release tree.**

```bash
apt-get update && apt-get install -y --no-install-recommends git ca-certificates
install -d -m 755 /opt/gremion/releases
git clone --depth 1 --branch "$TAG" "$GREMION_SOURCE_URL" "$REL"
git -C "$REL" describe --tags --exact-match          # prints the tag
```

4. **Base system, deploy user, Docker.** `infra/host/bootstrap.sh`, stages
   `base`, `user` and `docker`; each asserts its own post-conditions.

```bash
bash "$REL/infra/host/bootstrap.sh" base
bash "$REL/infra/host/bootstrap.sh" user
bash "$REL/infra/host/bootstrap.sh" docker
```

5. **Install the host programs.** Real files, copied, never symlinks
   (`infra/host/README.md`).

```bash
install -d -m 755 -o gremion -g gremion /opt/gremion/bin /opt/gremion/lib
install -m 0755 -o gremion -g gremion "$REL"/infra/host/bin/* /opt/gremion/bin/
install -m 0644 -o gremion -g gremion "$REL/infra/host/lib/common.sh" /opt/gremion/lib/common.sh
```

6. **Render the env files and generate every secret.** Run from the release
   tree, where the program finds its templates. It refuses to overwrite an
   existing file and ends with an `INIT-SECRETS:` line naming how many keys the
   administrator must still fill.

```bash
"$REL/infra/host/bin/gremion-init-secrets" --stack gremion
```

7. **Fill the operator keys.** Every key the previous step listed, in every file
   the search names: the platform domain, the edge and mail addresses, the ACME
   contact, the alert sinks, `GREMION_PRODUCTION_STACK`.

```bash
grep -n 'CHANGE_ME_OPERATOR_' /opt/gremion/etc/env/*.env     # the keys still to fill
"${EDITOR:-vi}" /opt/gremion/etc/env/state.env                # and each other file named above
```

8. **Validate every env file (E1).** Nothing is started until all five pass.

```bash
for p in state app-blue app-green; do
  gremion-validate-env --env-file "/opt/gremion/etc/env/${p}.env" --release "$REL"
done
gremion-validate-env --env-file /opt/gremion/etc/env/mail.env --release "$REL/infra/host/mail"
gremion-validate-env --env-file /opt/gremion/etc/env/ops.env --release "$REL/infra/host/ops"
```

9. **Addresses, networks and volumes, firewall.** `networks` creates the
   shared networks and the three shared volumes new (`${STACK}_traefik_acme`,
   `${STACK}_tenant_secrets`, `${STACK}_mail_data`); `--expect-ptr` checks the
   reverse DNS set in step 1.

```bash
bash "$REL/infra/host/bootstrap.sh" --fqdn "<host FQDN>" --expect-ptr addresses
bash "$REL/infra/host/bootstrap.sh" networks
bash "$REL/infra/host/bootstrap.sh" firewall
```

10. **Release trust and the deploy agent.**

```bash
bash "$REL/infra/host/bootstrap.sh" --cosign-pubkey "<release public key file>" trust
bash "$REL/infra/host/bootstrap.sh" --deploy-pubkey "<deploy public key file>" agent
```

11. **Check the published DNS records.** Every line `OK`; no `MISSING`, no
    `WRONG`.

```bash
. /opt/gremion/lib/common.sh && load_env /opt/gremion/etc/env/state.env
gremion-dns-check --domain "$PLATFORM_DOMAIN" \
  --edge-ip "$EDGE_BIND_IP" --edge-ip6 "$EDGE_BIND_IP6" \
  --mail-ip "$MAIL_BIND_IP" --mail-ip6 "$MAIL_BIND_IP6" --edit 1
```

12. **Start the state project.** No program starts it; `gremion-deploy` only
    pulls it. The registry token is read at a prompt and the login is removed
    again at once.

```bash
cd "$REL"
read -rs GHCR_TOKEN
printf '%s\n' "$GHCR_TOKEN" | docker login ghcr.io -u x-access-token --password-stdin
docker compose --env-file /opt/gremion/etc/env/state.env up -d
docker logout ghcr.io; unset GHCR_TOKEN
docker compose --env-file /opt/gremion/etc/env/state.env ps
```

13. **Take the baseline backup.** `gremion-deploy` refuses its step 3 without
    `runtime/last-backup.json`, so one backup of the fresh state project runs
    before the first deploy (see Known gaps).

```bash
sudo -u gremion /opt/gremion/bin/gremion-backup --label install-baseline
jq -e '.ok == true' /opt/gremion/runtime/last-backup.json
```

14. **First deploy.** Twelve steps, each logged to `runtime/deploy.log`; the
    program logs out of the registry on every exit path.

```bash
read -rs GHCR_TOKEN
printf 'TOKEN %s\n' "$GHCR_TOKEN" | sudo -u gremion /opt/gremion/bin/gremion-deploy "$TAG"
unset GHCR_TOKEN
```

15. **Edge and verification contract.** Work through the pilot-host edge
    checklist in `docs/deployment.md` (items 1 to 7): nothing listens on all
    interfaces, the Traefik API answers on loopback only, and every certificate
    is newly issued by the ACME CA into the empty `${STACK}_traefik_acme`. Then
    run the verification contract.

```bash
sudo -u gremion /opt/gremion/bin/gremion-verify
jq -e '.ok == true and (.failures | length) == 0' /opt/gremion/runtime/last-verify.json
```

16. **Create the pilot customer.** PENDING TASK-043 (`packages/provisioning/`):
    the customer is created through the provisioning orchestrator, which creates
    its realm, databases and broker account and invites its first
    administrators. Until that lands, this step is recorded as blocked.

```bash
test -d /opt/gremion/current/packages/provisioning \
  || echo 'BLOCKED: TASK-043 provisioning orchestrator not in this release'
```

17. **Re-run the F1 guard set and take the TRD-340 snapshot** with
    `scripts/ci-local/snapshot.mjs`. On the
    administrator's workstation, in a clean checkout of this tag beside a clean
    checkout of the vertical, with `--stack-env` naming the marker of the stack
    the end-to-end suites run against. The first run records the three F1 suites
    of `scripts/ci-local/suites.json`, the second every suite of both
    repositories (TRD-340, "again on the re-initialised host").

```bash
node scripts/ci-local/snapshot.mjs --kernel . --vertical "<vertical checkout>" \
  --out "<evidence dir>" --stack-env "<stack marker>" \
  --only kernel-f1-defect-guards,vertical-f1-defect-guards,vertical-f1-defect-e2e
node scripts/ci-local/snapshot.mjs --kernel . --vertical "<vertical checkout>" \
  --out "<evidence dir>" --stack-env "<stack marker>"
```

18. **Close SSH to keys only.** Only after a key-based login as the deploy user
    succeeded from a second session; `harden-ssh` is not part of `all` on
    purpose.

```bash
bash "$REL/infra/host/bootstrap.sh" harden-ssh
```

19. **Install the timers and the reboot gate.** `bootstrap.sh timers` installs
    `gremion-backup.service`, `gremion-backup.timer` and `gremion-verify.service`,
    and enables the timer (see Known gaps).

```bash
bash "$REL/infra/host/bootstrap.sh" timers
```

20. **Disable the backup timer (R15-1).** The job stays installed, so turning
    it back on is a configuration change, not a build ([backup.md](backup.md)).

```bash
systemctl disable --now gremion-backup.timer
```

## Post-condition

The installation is up, verified and reachable, its state is new, and the backup
job is installed and off:

```bash
. /opt/gremion/lib/common.sh && load_env /opt/gremion/etc/env/state.env
systemctl is-enabled gremion-backup.timer          # disabled
systemctl is-active gremion-backup.timer           # inactive
systemctl is-enabled gremion-verify.service        # enabled: the reboot gate runs at every boot
jq -r '.ts, .ok, (.failures | length)' /opt/gremion/runtime/last-verify.json    # today, true, 0
grep -Fx "$TAG" /opt/gremion/runtime/current-tag
```

Readiness, fresh volumes and fresh certificates:

```bash
host="$(grep -vE '^[[:space:]]*(#|$)' /opt/gremion/etc/tenant-hosts.txt | head -n 1)"
curl -s -o /dev/null -w '%{http_code}\n' "https://${host}/api/health"          # 200
for v in traefik_acme tenant_secrets mail_data; do
  docker volume inspect --format '{{.Name}} {{.CreatedAt}}' "${STACK}_${v}"     # created by this run
done
openssl s_client -connect "${EDGE_BIND_IP}:443" -servername "$host" </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -startdate                                     # the ACME CA, issued today
jq -e '(.auths // {}) | length == 0' /root/.docker/config.json                 # no registry credential left
```

Every running container declares a healthcheck and reports `healthy`; a
container reporting none fails (TRD-178). `scripts/verify/census/running.mjs`
(TASK-036) takes the same reading per compose project with a bounded wait, and
fails on a project with no container, wherever Node and the host's Docker socket
meet. Every first-party database answers on PostgreSQL 18 (TRD-425):

```bash
docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' \
  $(docker ps -q)                                                              # every line: healthy
(cd /opt/gremion/current && docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
  psql -U postgres -tAc 'SHOW server_version_num')                             # 18xxxx
```

The pilot customer's first administrator has signed in (PENDING TASK-043 until
step 16 runs): the customer's realm holds a `LOGIN` event.

```bash
kc="$(cd /opt/gremion/current && docker compose --env-file /opt/gremion/etc/env/state.env ps -q keycloak)"
docker exec "$kc" /opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080 \
  --realm master --user "$KEYCLOAK_ADMIN" --password "$KEYCLOAK_ADMIN_PASSWORD"
docker exec "$kc" /opt/keycloak/bin/kcadm.sh get events -r "<customer realm>" -q type=LOGIN -q max=1
```

The two snapshot files of step 17 read PASS for every row:

```bash
jq -e '.overallExit == 0 and (.suites | length) > 0 and all(.suites[]; .status == "PASS" and .collected > 0)' \
  "<evidence dir>"/*.json
```

Record the run (`finished_at`, the wall-clock time, the F1 result) as described
in [run-record.md](run-record.md).

## Known gaps

- `bash infra/host/bootstrap.sh timers` (`stage_timers`, also run by `all`) does `systemctl enable --now gremion-backup.timer`, while R15-1 wants the job installed and disabled; step 20 therefore disables it again. Owner: TASK-040 (`infra/**`). `test/host/runbook.bats` fails the day `stage_timers` stops enabling the timer, so step 20 and this entry change in the same commit.
- `gremion-deploy` step 3 refuses without `runtime/last-backup.json`, and `gremion-backup` refuses without a reachable off-site remote (`RCLONE_REMOTE`), while the pilot keeps off-site copies off as the north star (R13-4). Step 13 therefore needs a remote for that one run. PENDING TASK-089 (`scripts/backup/`) decides the pilot's verification path.
- Customer creation and the first administrator's sign-in: PENDING TASK-043 (`packages/provisioning/`), steps 16 and the post-condition.
- The operator-only observability stack is not brought up here: PENDING TASK-039 (`compose/observability/`).
- The pooled compose layout: PENDING TASK-040 (`compose/README.md`); the state and app projects cited here may change shape in that wave.
- [A] Step 17's end-to-end suites run against the stack its `--stack-env` marker names; which stack that is for the rebuilt host is decided by TASK-038's first run.
- Mail bring-up is not part of this procedure: it is the go-live gate's item G4-MAIL (`gremion-mail-bringup`), see [go-live-gate.md](../go-live-gate.md).

## Changelog

- 1.0.0 (2026-09-27): first version (TASK-037).
