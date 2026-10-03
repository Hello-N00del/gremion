# Install: the from-zero bring-up

- Version: 4.0.0
- Wall-clock budget: one working day, from the start of step 1 to the asserted post-condition (PRD-PLAT-005)
- Implements: TRD-200 (install), TRD-042 (the from-zero rebuild, R15-2), FLOW-OPS-002
- First run: TASK-038, the pilot re-initialisation

This is the bring-up a rebuilt host follows (TRD-042, R15-2): the server is
rebuilt from zero through the provider panel, and its volumes, DNS records and
certificates are created new. Nothing from an earlier installation is carried
over. The procedure ends with the F1 guard set re-run on the rebuilt host
(TRD-004), a dated TRD-340 snapshot of every suite, and the platform's own
backup job installed but disabled (R15-1, see [backup.md](backup.md)).

The stack is the pooled layout ([pooled-stack-layout.md](../pooled-stack-layout.md)):
one stack per host, five compose projects, each named by its own env file under
`/opt/gremion/etc/env/`:

| Env file | Project | Compose files (from the env file's `COMPOSE_FILE`) | Started by |
|---|---|---|---|
| `state.env` | `${STACK}-state`: every database and volume, keycloak, the edge | `docker-compose.yml`, `docker-compose.prod.yml`, `docker-compose.state-pins.yml` | step 12 |
| `app-blue.env`, `app-green.env` | `${STACK}-app-blue`, `${STACK}-app-green`: gremion-ui, gremion-public and the `migrate` one-shot, one colour serving at a time | `docker-compose.app.yml`, `docker-compose.pins.yml` | `gremion-deploy`, step 14 (the first deploy starts blue) |
| `ops.env` | `${STACK}-ops`: on-box monitoring, non-council | `infra/host/ops/docker-compose.yml` | step 15 |
| `mail.env` | `${STACK}-mail`: the platform mail server, non-council | `infra/host/mail/docker-compose.yml` | the go-live gate (see Known gaps) |

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
  array, a manifest digest), both pins layers (`docker-compose.pins.yml` for
  the colours, `docker-compose.state-pins.yml` for the state project) and
  `docs/ops/release-1-waivers.md`.
- The administrator holds, on their own machine: the provider panel login, the
  registrar login, an SSH key the rebuilt server will accept for root, a
  registry token with read access to the release images (typed at a prompt,
  never written to disk), the deploy key's public half, the release-signing
  public key for `bootstrap.sh trust`, and the release signer's `allowed_signers`
  file (ssh public keys only, `namespaces="git"`; how to make it:
  [host-tooling.md](../host-tooling.md), "Authenticating the release tree"),
  copied to `/root/allowed_signers` on the rebuilt server before step 3.
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

3. **Fetch the release tree.** The deploy user does not exist yet, so root
   clones it; step 4 hands it over before anything else reads it.

```bash
apt-get update && apt-get install -y --no-install-recommends git ca-certificates
install -d -m 755 /opt/gremion/releases
git clone --depth 1 --branch "$TAG" "$GREMION_SOURCE_URL" "$REL"
git -C "$REL" describe --tags --exact-match          # prints the tag
# authenticate the tree BEFORE step 4 runs code from it: the release signer's
# allowed_signers file, copied to /root from the workstation (docs/ops/host-tooling.md).
# Step 10 installs this same file as the host's permanent anchor, /opt/gremion/etc/allowed_signers.
git -C "$REL" -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=/root/allowed_signers \
  verify-tag "refs/tags/$TAG"                        # Good "git" signature
```

4. **Base system, deploy user, Docker.** `infra/host/bootstrap.sh`, stages
   `base`, `user` and `docker`; each asserts its own post-conditions. `user`
   creates the deploy user `gremion` and the host layout it owns (`etc/` mode
   0700). Then the release tree is handed to that user: `gremion-deploy` runs
   git in it as `gremion`, and git refuses a checkout another user owns
   ("dubious ownership").

```bash
bash "$REL/infra/host/bootstrap.sh" base
bash "$REL/infra/host/bootstrap.sh" user
bash "$REL/infra/host/bootstrap.sh" docker
chown -R gremion:gremion "$REL"
stat -c '%U %a %n' /opt/gremion /opt/gremion/releases "$REL" /opt/gremion/etc    # gremion, all four
sudo -u gremion git -C "$REL" describe --tags --exact-match                       # the tag, read as gremion
```

5. **Install the host programs.** Real files, copied, never symlinks
   (`infra/host/README.md`).

```bash
install -d -m 755 -o gremion -g gremion /opt/gremion/bin /opt/gremion/lib
install -m 0755 -o gremion -g gremion "$REL"/infra/host/bin/* /opt/gremion/bin/
install -m 0644 -o gremion -g gremion "$REL/infra/host/lib/common.sh" /opt/gremion/lib/common.sh
```

6. **Render the env files and generate every secret.** Run from the release
   tree, where the program finds its templates, and as the deploy user: the
   program writes with umask 077, so the owner of the five files is whoever
   runs it, and every later deploy-user run (the baseline backup, the first
   deploy, the verification, and the installed `gremion-backup.service` and
   `gremion-verify.service`) reads them. Run as
   root, it leaves root-owned 0600 files those runs cannot read. It refuses to
   overwrite an existing file and ends with an `INIT-SECRETS:` line naming how
   many keys the administrator must still fill.

```bash
sudo -u gremion "$REL/infra/host/bin/gremion-init-secrets" --stack gremion
stat -c '%U %a %n' /opt/gremion/etc/env/*.env                 # gremion 600, for each of the five
```

7. **Fill the operator keys.** Every key the previous step listed, in every file
   the search names: the platform domain, the edge and mail addresses, the ACME
   contact, the alert sinks, `GREMION_PRODUCTION_STACK`, and in `ops.env`
   `OPS_UID` and `OPS_GID` (the deploy user's ids, printed below). Edit as the
   deploy user, so each file keeps its owner.

```bash
grep -n 'CHANGE_ME_OPERATOR_' /opt/gremion/etc/env/*.env     # the keys still to fill
id -u gremion; id -g gremion                                  # OPS_UID and OPS_GID
sudo -u gremion "${EDITOR:-vi}" /opt/gremion/etc/env/state.env   # and each other file named above
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

10. **Release trust and the deploy agent.** Two anchors, both written only by
    `bootstrap.sh`, both `root:root` 0644 (the deploy user reads them and cannot
    rewrite them): `etc/cosign.pub` (the image half, TRD-441) and
    `etc/allowed_signers` (the release-tree half, H10). `gremion-deploy` refuses
    the first deploy without either. The `signers` stage installs the file step 3
    already verified the tag with.

```bash
bash "$REL/infra/host/bootstrap.sh" --cosign-pubkey "<release public key file>" trust
bash "$REL/infra/host/bootstrap.sh" --allowed-signers /root/allowed_signers signers
bash "$REL/infra/host/bootstrap.sh" --deploy-pubkey "<deploy public key file>" agent
stat -c '%U:%G %a %n' /opt/gremion/etc/cosign.pub /opt/gremion/etc/allowed_signers   # root:root 644, both
```

11. **Check the published DNS records.** Every line `OK`; no `MISSING`, no
    `WRONG`.

```bash
. /opt/gremion/lib/common.sh && load_env /opt/gremion/etc/env/state.env
gremion-dns-check --domain "$PLATFORM_DOMAIN" \
  --edge-ip "$EDGE_BIND_IP" --edge-ip6 "$EDGE_BIND_IP6" \
  --mail-ip "$MAIL_BIND_IP" --mail-ip6 "$MAIL_BIND_IP6" --edit 1
```

12. **Render the host-owned files, then start the state project.** The state
    project bind-mounts files only `gremion-render` writes into the release
    tree: the pgbouncer `userlist.txt` and the Keycloak certificate and key
    under `docker/keycloak/certs/`. Started without them, Docker creates the
    missing `userlist.txt` as a root-owned directory, Keycloak has no
    certificate, and the first deploy's own render (its step 4, as the deploy
    user) dies on that directory. The render runs as the deploy user, because it
    keeps the Keycloak CA in `etc/secrets/keycloak` for every later release,
    and it ends with a `RENDER:` line. The log pipeline's `ipcrypt_key` secret
    is read from the release tree's `secrets/ipcrypt_key.txt`, while the render
    keeps that key in `etc/secrets/ipcrypt_key.txt`; a hard link made as the
    deploy user puts the same key into the tree (one inode, so an in-place key
    rotation reaches both names; see Known gaps). No program starts the state
    project; `gremion-deploy` only pulls it. The registry token is read at a
    prompt and the login is removed again at once. Before the first up,
    `nats-auth init` (TASK-024, Q12) writes the NATS SYS reload seed and the
    SYS-only accounts file into the two nats volumes bootstrap created: the
    broker's config includes that file and does not start without it. It runs
    in the `tenant-create` one-shot of the blue colour, with no dependency
    started, and is idempotent (`gremion-deploy` repeats it in its step 4).

```bash
sudo -u gremion /opt/gremion/bin/gremion-render --release "$REL"
stat -c '%U %F %n' "$REL/docker/pgbouncer/userlist.txt" "$REL/docker/keycloak/certs/keycloak.crt"   # gremion regular file, both
sudo -u gremion ln /opt/gremion/etc/secrets/ipcrypt_key.txt "$REL/secrets/ipcrypt_key.txt"
stat -c '%i %U %n' /opt/gremion/etc/secrets/ipcrypt_key.txt "$REL/secrets/ipcrypt_key.txt"         # one inode, gremion, both
cd "$REL"
read -rs GHCR_TOKEN
printf '%s\n' "$GHCR_TOKEN" | docker login ghcr.io -u x-access-token --password-stdin
docker compose --env-file /opt/gremion/etc/env/app-blue.env run --rm --no-deps --entrypoint pnpm tenant-create exec nats-auth init   # [nats-auth] init: sys reload seed created; ... written
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

15. **Start the ops project.** On-box monitoring, non-council, in its own
    project and network (`infra/host/ops/README.md`). `render-ops.sh` runs as
    the deploy user, because it refuses to render unless `OPS_UID` and
    `OPS_GID` in `ops.env` (step 7) are the ids it runs as; it writes the scrape
    targets, the Alertmanager config and the ops credential files and ends with
    an `OPS-RENDER:` line. Compose runs from the project's own directory,
    because `ops.env` names its `COMPOSE_FILE` relative to it.

```bash
sudo -u gremion /opt/gremion/current/infra/host/ops/render-ops.sh
cd /opt/gremion/current/infra/host/ops
docker compose --env-file /opt/gremion/etc/env/ops.env up -d
docker compose --env-file /opt/gremion/etc/env/ops.env ps
```

16. **Edge and verification contract.** Work through the pilot-host edge
    checklist in `docs/deployment.md` (items 1 to 7): nothing listens on all
    interfaces, the Traefik API answers on loopback only, and every certificate
    is newly issued by the ACME CA into the empty `${STACK}_traefik_acme`. Then
    run the verification contract.

```bash
sudo -u gremion /opt/gremion/bin/gremion-verify
jq -e '.ok == true and (.failures | length) == 0' /opt/gremion/runtime/last-verify.json
```

17. **Create the pilot customer.** `gremion-tenant create` (TASK-043, `packages/provisioning/`)
    creates the customer's realm, databases and broker account and invites its first
    administrators. Its first running proof on a pooled stack (R29) found five defects
    in the create path (TASK-043b: the provisioner secret mount, the realm-smtp read-back,
    the one-shot's role-grant credential, CONNECT for pgbouncer_auth, the state template
    keys); this step stays blocked until TASK-043b's customer proof is green.

```bash
test -d /opt/gremion/current/packages/provisioning \
  || echo 'BLOCKED: TASK-043 provisioning orchestrator not in this release'
```

18. **Re-run the F1 guard set and take the TRD-340 snapshot** with
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

19. **Close SSH to keys only.** Only after a key-based login as the deploy user
    succeeded from a second session; `harden-ssh` is not part of `all` on
    purpose.

```bash
bash "$REL/infra/host/bootstrap.sh" harden-ssh
```

20. **Install the timers and the reboot gate.** `bootstrap.sh timers` installs
    `gremion-backup.service`, `gremion-backup.timer` and `gremion-verify.service`,
    and enables the timer (see Known gaps).

```bash
bash "$REL/infra/host/bootstrap.sh" timers
```

21. **Disable the backup timer (R15-1).** The job stays installed, so turning
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

The deploy user owns what its programs and units read, so the next timer run,
reboot gate or deploy does not die on a root-owned file:

```bash
stat -c '%U %a %n' /opt/gremion/etc/env/*.env                                 # gremion 600, for each of the five
stat -c '%U %n' "$REL" "$(readlink -f /opt/gremion/current)"                    # gremion, both
find /opt/gremion/etc/env "$REL" ! -user gremion | wc -l                        # 0
stat -c '%U:%G %a %n' /opt/gremion/etc/cosign.pub /opt/gremion/etc/allowed_signers   # root:root 644, both: the trust anchors stay root's on purpose
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
for f in /root/.docker/config.json /home/gremion/.docker/config.json; do    # step 12 logs in as root, step 14 as gremion
  [ -f "$f" ] && jq -e '(.auths // {}) | length == 0' "$f"                     # no registry credential left
done
```

Every running container declares a healthcheck and reports `healthy`; a
container reporting none fails (TRD-178). `scripts/verify/census/running.mjs`
(TASK-036) takes the same reading per compose project with a bounded wait, and
fails on a project with no container, wherever Node and the host's Docker socket
meet. Every first-party database answers on PostgreSQL 18 (TRD-425):

```bash
docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' \
  $(docker ps -q)                                                              # every line: healthy
docker ps --format '{{.Label "com.docker.compose.project"}}' | sort -u          # ${STACK}-state, ${STACK}-app-blue, ${STACK}-ops; no app-green
cat /opt/gremion/runtime/active-colour                                         # blue
(cd /opt/gremion/current && docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
  psql -U postgres -tAc 'SHOW server_version_num')                             # 18xxxx
```

The pilot customer's first administrator has signed in (blocked on TASK-043b until
step 17 runs): the customer's realm holds a `LOGIN` event.

```bash
kc="$(cd /opt/gremion/current && docker compose --env-file /opt/gremion/etc/env/state.env ps -q keycloak)"
KC_CLI_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" docker exec -e KC_CLI_PASSWORD "$kc" /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080/auth --realm master --user "$KEYCLOAK_ADMIN"
docker exec "$kc" /opt/keycloak/bin/kcadm.sh get events -r "<customer realm>" -q type=LOGIN -q max=1
docker exec "$kc" rm -f /opt/keycloak/.keycloak/kcadm.config
```

The password reaches kcadm through `KC_CLI_PASSWORD`, handed to `docker exec` by
name, so it is on no command line of the host (and, unlike `--password`, on none
inside the container either). The `--server` URL carries Keycloak's relative
path `/auth` (`KC_HTTP_RELATIVE_PATH` in `docker-compose.yml`); without it the
login answers 404. The last command removes the token kcadm cached in the
container.

The two snapshot files of step 18 read PASS for every row:

```bash
jq -e '.overallExit == 0 and (.suites | length) > 0 and all(.suites[]; .status == "PASS" and .collected > 0)' \
  "<evidence dir>"/*.json
```

Record the run (`finished_at`, the wall-clock time, the F1 result) as described
in [run-record.md](run-record.md).

## Known gaps

- `bash infra/host/bootstrap.sh timers` (`stage_timers`, also run by `all`) does `systemctl enable --now gremion-backup.timer`, while R15-1 wants the job installed and disabled; step 21 therefore disables it again. Owner: TASK-040 (`infra/**`), which merged with `stage_timers` unchanged, so the change is still open. `test/host/runbook.bats` fails the day `stage_timers` stops enabling the timer, so step 21 and this entry change in the same commit.
- `gremion-deploy` step 3 refuses without `runtime/last-backup.json`, and `gremion-backup` refuses without a reachable off-site remote (`RCLONE_REMOTE`), while the pilot keeps off-site copies off as the north star (R13-4). Step 13 therefore needs a remote for that one run. PENDING TASK-089 (`scripts/backup/`) decides the pilot's verification path.
- `docker-compose.yml` declares the log pipeline's `ipcrypt_key` secret as `./secrets/ipcrypt_key.txt` in the release tree, while `gremion-render` generates the key once in `etc/secrets/ipcrypt_key.txt` under the host root and nothing in `infra/host` puts it into a release tree; step 12 links it by hand. Every later release tree the state project is started from needs the same link first. Owner: the host tooling of TASK-040 (`infra/**`, `docker-compose*.yml`), merged with this divergence, so it needs a follow-up task. `test/host/runbook.bats` stops asking for the link the day `gremion-render` writes the key into the release tree.
- Customer creation and the first administrator's sign-in: `gremion-tenant create` exists (TASK-043, `packages/provisioning/`); blocked on TASK-043b's green customer proof, step 17 and the post-condition.
- The ops project of step 15 (`infra/host/ops/`) is the on-box monitoring until the observability stack moves into its own project: PENDING TASK-039 (`compose/observability/`).
- The pooled layout (TASK-040, [pooled-stack-layout.md](../pooled-stack-layout.md)) carries a deploy ordering hazard until TASK-034's 34b block lands: neither the apex nor `public.<domain>` has a websecure router, so the first deploy's public verification (step 14) and the post-condition's `/api/health` answer 404. No install is scheduled before 34b; TASK-038's waits carry it.
- [A] Step 18's end-to-end suites run against the stack its `--stack-env` marker names; which stack that is for the rebuilt host is decided by TASK-038's first run.
- Mail bring-up is not part of this procedure: it is the go-live gate's item G4-MAIL (`gremion-mail-bringup`), see [go-live-gate.md](../go-live-gate.md).

## Changelog

- 4.0.0 (2026-10-03): H10 (F1 sweep K6#19, TASK-048b relay). Step 3 authenticates the release tag against the release signer's `allowed_signers` before step 4 runs code from the tree; step 10 installs that same file as the host's anchor `etc/allowed_signers` (`bootstrap.sh --allowed-signers PATH signers`, `root:root` 0644 like `etc/cosign.pub`), and the post-condition reads both anchors' owner and mode. `gremion-deploy` refuses a tag that is unsigned, signed by an unlisted key or not an ssh signature. Major: a step changed.
- 3.0.0 (2026-09-30): R29-MAIN-DEFECTS (R29-MD-A). The post-condition's sign-in observation passes the Keycloak admin password to kcadm as `KC_CLI_PASSWORD` by name (no `--password` on any command line), uses `--server` with Keycloak's `/auth` relative path (the URL without it answered 404) and removes kcadm's cached token afterwards. Major: a post-condition changed (Q9).
- 2.0.0 (2026-09-28): step 12 runs `gremion-render` as the deploy user before the state project's first `up`, links the ipcrypt key into the release tree, and observes both (TASK-037 review).
- 1.0.0 (2026-09-27): first version (TASK-037).
