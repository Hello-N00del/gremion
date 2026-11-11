# Upgrade: one release onto a running installation

- Version: 9.0.0
- Status: provisional (see Known gaps)
- Wall-clock budget: one working day, from step 1 to the asserted post-condition (PRD-PLAT-005)
- Implements: TRD-200 (upgrade), TRD-206 (the pre-migration dump, R18-4), TRD-189 (blue/green as the deploy path)

An upgrade is one run of `gremion-deploy <tag>`: twelve steps, each logged as
`<timestamp> STEP <n> <name> ok|fail` to `runtime/deploy.log`, the new colour
started, verified and switched to while the old colour is kept for rollback. The
procedure around it adds what the program does not do: the check before, the
short-lived pre-migration dump of TRD-206 (R18-4) of a database the program does
not dump itself and its deletion after a succeeded switch, and the read of the
result. The program's step 5 (`gremion-migration-dump preflight`, TASK-075)
dumps the kernel and control databases when the release migrates them, and
deletes that dump, logged, at its step 12b (`switched`), after step 11 passed
and step 12 recorded the release. The program's own reference is
[host-tooling.md](../host-tooling.md), section 4.

This procedure is provisional: where the program and a requirement disagree it
follows the program, and each divergence is a Known gap below.

Every bash step assumes this preamble:

```bash
export TAG=dist-vX.Y.Z                       # the release being deployed (cut by scripts/release/cut-dist-tag.sh)
export REL="/opt/gremion/releases/${TAG}"
export GREMION_SOURCE_URL="<the release source repository>"
export PATH="/opt/gremion/bin:$PATH"
. /opt/gremion/lib/common.sh && load_env /opt/gremion/etc/env/state.env
host="$(grep -vE '^[[:space:]]*(#|$)' /opt/gremion/etc/tenant-hosts.txt | head -n 1)"
```

## Preconditions

- The installation passed [install.md](install.md), and its last verification is
  green: `runtime/last-verify.json` has `ok: true`.
- `runtime/last-backup.json` exists with `ok: true` (the install baseline or the
  one verification run of [backup.md](backup.md)); `gremion-deploy` sizes its
  free-space check from it and refuses without it.
- The new tag's tree carries `release.json` (the tag, a boolean `overlap`, the
  `migrations` array, a manifest digest), `docker-compose.pins.yml` and
  `docker-compose.state-pins.yml` with every image pinned by digest, and `docs/ops/release-1-waivers.md`. A missing contract
  stops the deploy at STEP 2, before any colour is touched.
- Every migration in the release is expand/contract (TRD-361): the colour still
  serving can run against the migrated schema.
- Every migration claimed its number from its database chain's register,
  `scripts/migrations/ranges.json` (TRD-344), and was frozen with its sha256 in
  `scripts/migrations/applied.lock.json`. `scripts/migrations/register.mjs check`
  refuses a renumbered, edited or deleted locked migration; it runs in `make lint`
  and in verify's carve-lint, not on the host, which has no node. Step 1 therefore
  reads the running and the new release's lock with `jq`, and the post-condition
  reads them again. At boot the kernel data plane checks every migration file
  against its manifest before any runs (TRD-353, the file half); the applied-row
  half, `verifyApplied` in `scripts/migrations/verify-applied.mjs`, is not yet
  called by any service (see Known gaps).
- The running installation's kernel database was created at or after the
  migration renumber of the register (TASK-029): nothing in the kernel data plane
  refuses a ledger that still records the old three-digit names (see Known gaps).
- The administrator holds a registry read token, typed at a prompt and never
  written to disk, or installed once as the host's token file
  (`/opt/gremion/etc/registry-token`, named by `GREMION_REGISTRY_TOKEN_FILE` in
  `state.env`; [host-tooling.md](../host-tooling.md), "The registry token on the
  host"). A token near its expiry is replaced before the upgrade, not during it.
- The deploy user is in a group with gid 70, the gid the PgBouncer container
  reads its userlist as: `id -G gremion | tr ' ' '\n' | grep -x 70` prints `70`.
  The deploy's step 4 re-renders the userlist 0640 group 70 as the deploy user,
  and under `gremion-hostd` (`NoNewPrivileges`) only a group the user already
  belongs to can be set. A host installed before this requirement runs
  `bootstrap.sh user` once as root (it adds the user to the group) and then
  `systemctl restart gremion-hostd`, because a running agent keeps the groups it
  started with; without both, the deploy fails at its step 4 with `cannot hand`
  naming the group and leaves the previous userlist in place.
- No other deploy, rollback or switch is running on the host; the agent's log,
  `logs/hostd.log`, names the last call it served.

## Steps

1. **Read the running state and the new release.** `gremion-deploy` reuses a
   checkout at the same tag, so cloning it here costs nothing later. The deploy
   user clones it: `gremion-deploy` runs as `gremion` and runs git in this
   checkout, which git refuses ("dubious ownership") when root owns it. Then
   compare the two releases' migration locks: every migration the running
   release locked must be locked in the new release under the same chain, name
   and sha256, so no applied migration was renumbered, edited or deleted
   (TRD-344). A non-empty list stops the upgrade here. The kernel database's
   ledger must record the four-digit names of the register (the first kernel
   migration is `0001_governance_schema.sql`); a count of 0 means the database
   predates the renumber and stops the upgrade (see Known gaps).

```bash
cat /opt/gremion/runtime/current-tag /opt/gremion/runtime/active-colour
sudo -u gremion git clone --depth 1 --branch "$TAG" "$GREMION_SOURCE_URL" "$REL"
sudo -u gremion git -C "$REL" -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=/opt/gremion/etc/allowed_signers \
  verify-tag "refs/tags/$TAG"                                     # Good "git" signature; read nothing from the tree before it
stat -c '%U %n' "$REL"                                            # gremion
jq '{tag, overlap, migrations}' "$REL/release.json"
jq -s 'map([.chains | to_entries[] | .key + " " + (.value.files | to_entries[] | .key + " " + .value)]) | .[0] - .[1]' \
  /opt/gremion/current/scripts/migrations/applied.lock.json "$REL/scripts/migrations/applied.lock.json"   # []
kdb="<the kernel database>"
cd /opt/gremion/current
docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
  psql -U postgres -d "$kdb" -tAc "SELECT count(*) FROM schema_migrations WHERE filename = '0001_governance_schema.sql'"   # 1
```

2. **Refresh the host programs, then validate the env files against the new tree
   (E1).** The programs under `/opt/gremion/bin` are copies, and nothing in a
   deploy replaces them: `gremion-deploy` runs the installed sibling programs
   only. A program that this release changed (the `--init-legal-env` flag of
   `gremion-render` below, the legal env staging in `gremion-deploy`'s step 2)
   does not exist on the host until it is copied in, so copy them first, with the
   same command as install.md step 5.

```bash
install -m 0755 -o gremion -g gremion "$REL"/infra/host/bin/* /opt/gremion/bin/
install -m 0644 -o gremion -g gremion "$REL/infra/host/lib/common.sh" /opt/gremion/lib/common.sh
```

   Once per host, then: a `state.env` rendered before the pins layer was split per project (TASK-048b)
   still layers the app pins `docker-compose.pins.yml` onto the state project.
   `gremion-deploy` refuses it at STEP 2 (exit 2, nothing pulled). Edit only the
   `COMPOSE_FILE` line; do not re-render the env files: `gremion-init-secrets
   --force` regenerates every secret they hold. An `app-<colour>.env` never names
   `docker-compose.state-pins.yml`; if one does, remove that entry the same way.
   The file holds secrets: run the edit as `gremion`, its owner (GNU `sed -i`
   writes a new file that keeps the mode but takes the owner of whoever runs it),
   and check owner and mode afterwards.

```bash
f=/opt/gremion/etc/env/state.env
stat -c '%U %a %n' "$f"            # gremion 600
grep -n '^COMPOSE_FILE=' "$f"      # ...:docker-compose.pins.yml means rendered before the split
sudo -u gremion sed -i '/^COMPOSE_FILE=/s/docker-compose\.pins\.yml/docker-compose.state-pins.yml/' "$f"
stat -c '%U %a %n' "$f"            # still gremion 600
grep -n '^COMPOSE_FILE=' "$f"      # docker-compose.yml:docker-compose.prod.yml:docker-compose.state-pins.yml
grep -n 'state-pins' /opt/gremion/etc/env/app-blue.env /opt/gremion/etc/env/app-green.env   # nothing
```

   Then validate:

```bash
for p in state app-blue app-green; do
  gremion-validate-env --env-file "/opt/gremion/etc/env/${p}.env" --release "$REL"
done
```

   Once per host (kernel #84): the state project's `legal` service reads
   `legal/legal.env` from the release tree, and `gremion-deploy` now writes it
   there from `/opt/gremion/etc/legal.env` in its step 2. A host installed
   before this change has no such file, and the deploy stops at step 2 (exit 2,
   nothing pulled or stopped) until it exists and holds no placeholder. Create
   it from the release's example and fill it with the values the running
   release's own `legal/legal.env` holds; `--init-legal-env` keeps a file that
   is already there.

```bash
sudo -u gremion /opt/gremion/bin/gremion-render --release "$REL" --init-legal-env   # LEGAL-ENV: file=... unfilled=5
sudo -u gremion "${EDITOR:-vi}" /opt/gremion/etc/legal.env
grep -c '=CHANGE_ME_OPERATOR_' /opt/gremion/etc/legal.env                          # 0
sudo -u gremion /opt/gremion/bin/gremion-render --release "$REL" --legal-env-only   # RENDER: outputs=1 ... legal-env-only=yes
```

3. **Take the pre-migration dump (TRD-206, R18-4).** Only when `migrations` is
   not empty: one dump of each database the migration alters, kept until the
   switch has succeeded and not a day longer. The kernel and control databases
   are not dumped here: `gremion-deploy` step 5 runs `gremion-migration-dump`
   preflight, which dumps them itself (from `scripts/migrations/runner/` of the
   new tree) and refuses while another release's dump is still live. This
   step takes, by hand, the dump of every other database the release migrates
   (a module database `<id>-postgres` holds, or `gremion_platform` on `postgres`);
   a new migration of such a chain names this step in its
   `-- gremion:manual-dump` line (see Known gaps). The dump
   is personal data, so its file is created private (`umask 077`) and is only
   ever written under a `.part` name: it takes its final name when `pg_dump` has
   finished, so a failed dump leaves no file that looks restorable. Every
   attempt writes its own file, named by the UTC second it started. A
   `pre-migration-${TAG}-${db}-*.dump` from an earlier attempt is the state the
   old colour was serving when that attempt began: keep it. No step here removes
   or overwrites one (`noclobber` refuses a `.part` of the same second), and step
   5 deletes them only after a switch has succeeded.

```bash
db="<the database the migration alters>"
svc="postgres"          # the state project's server holding it: <id>-postgres (module) or postgres (gremion_platform)
dumpdir=/opt/gremion/backups
dump="${dumpdir}/pre-migration-${TAG}-${db}-$(date -u +%Y%m%dT%H%M%SZ).dump"
cd /opt/gremion/current
( umask 077; set -o noclobber; docker compose --env-file /opt/gremion/etc/env/state.env exec -T "$svc" \
  pg_dump -U postgres -Fc "$db" > "${dump}.part" ) && mv -- "${dump}.part" "$dump" && sha256sum "$dump"
stat -c '%a %U' "$dump" && logger -t premigration-dump "taken ${dump} before ${TAG}"   # 600 root; logged only for a dump that exists
```

4. **Deploy.** The token goes to the program on standard input; the program logs
   out of the registry on every exit path and asserts that no credential
   survives. Where the host's token file is installed, the program reads the
   token from it instead and stdin is not read; a token file that is missing,
   not owned by `gremion`, readable by group or others, empty or not one token
   stops the run at once with exit 2, before step 1 of the deploy, with nothing
   pulled and no colour touched.

```bash
read -rs GHCR_TOKEN
printf 'TOKEN %s\n' "$GHCR_TOKEN" | sudo -u gremion /opt/gremion/bin/gremion-deploy "$TAG"
unset GHCR_TOKEN
```

   With the token file installed instead:

```bash
stat -c '%U:%G %a %n' /opt/gremion/etc/registry-token                                                    # gremion:gremion 600
grep -c '^GREMION_REGISTRY_TOKEN_FILE=/opt/gremion/etc/registry-token$' /opt/gremion/etc/env/state.env   # 1
sudo -u gremion /opt/gremion/bin/gremion-deploy "$TAG" </dev/null
```

5. **Delete the dumps once the switch has succeeded, and log each.** The switch
   succeeded when `runtime/current-tag` names the new tag and this run logged
   `STEP 12 record ok` (step 12 records the release right after step 11
   verified the public edge; 12b deletes the program's own dump, 12c is the
   soak). It deletes every `pre-migration-${TAG}-*.dump`
   and `.dump.part` of this tag: the dump of this attempt and those of earlier
   attempts, whose state the switch has now made obsolete. If the switch did
   not succeed, keep them all and follow the failure path below. The dump
   `gremion-deploy` took at its step 5 is not touched here: the program deleted
   it at its step 12b, one `deleted` line each. A failure there ends the deploy
   with exit 1, a `DUMP-NOT-DELETED` line and `STEP 12b dump-delete fail`; the
   new release is already recorded and serving, the soak (12c) did not run, so
   the old colour is still up: `gremion-migration-dump` status names what is
   left, rerun `gremion-migration-dump switched --release "$TAG"`, then stop the
   old colour once rollback to it is no longer wanted (`docker compose
   --env-file /opt/gremion/etc/env/app-<old>.env down` from
   `/opt/gremion/current`, then remove `runtime/colour-<old>-tag`, which is
   what the soak does), or let the next deploy's step 8 do it.

```bash
tail -n 3 /opt/gremion/runtime/deploy.log
if grep -Fxq "$TAG" /opt/gremion/runtime/current-tag; then
  for f in "${dumpdir}"/pre-migration-"${TAG}"-*; do [ -e "$f" ] || continue; rm -f -- "$f"; logger -t premigration-dump "deleted ${f} after the switch to ${TAG} succeeded"; done
fi
```

6. **Adopt each realm the provisioner did not create (existing installs, once
   per realm; kernel #48).** The provisioner service account
   (`tenant-provisioner`) holds only master `create-realm`, and Keycloak gives
   it admin on the realms it created. A realm created before the account
   existed, or by another admin, answers it 403, so reconcile can neither
   verify nor repair it (the step-up gate, the password policy, PKCE, the
   bearer `sub` mapper, the audit REVOKE). A reconcile request (the control
   panel, or the break-glass `gremion-tenant request reconcile`) then fails
   with `was most likely not created by the provisioner service account` and
   names the realm. For each realm it names, grant the account the roles
   Keycloak gives a realm's creator, exactly: the 17 roles of
   `AdminRoles.ALL_REALM_ROLES` on the master client `<realm>-realm`, never
   `impersonation`, `view-system` or master `admin`
   (`REALM_CREATOR_ROLES` in
   `gremion-ui/src/lib/server/tenant/provisioner/kc-admin-api.ts`). The step
   uses the Keycloak admin credential (from `state.env`, through name-only
   `-e`, never an argv), touches only master, leaves the provisioner's secret
   file alone, and refuses `master`. A rerun grants nothing and says so.
   Skip this step when reconcile passes for every customer.

```bash
realm="<the realm reconcile named>"
colour="$(cat /opt/gremion/runtime/active-colour)"
cd /opt/gremion/current
KEYCLOAK_ADMIN="$KEYCLOAK_ADMIN" KEYCLOAK_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" \
  docker compose --env-file "/opt/gremion/etc/env/app-${colour}.env" run --rm -T \
  -e KEYCLOAK_ADMIN -e KEYCLOAK_ADMIN_PASSWORD tenant-create bootstrap-provisioner --adopt-realm "$realm"
# [tenant-create] bootstrap-provisioner --adopt-realm <realm>: ... GRANTED [create-client, ...] (a rerun: nothing to grant)
```

   Then reconcile the realm's customer again (the control panel's reconcile
   request): its checks run, without the 403, and apply repairs the drift they
   report.

7. **Recreate PgBouncer from the new release (installations first brought up
   before kernel #83, once).** PgBouncer belongs to the state project, and the
   deploy only pulls that project's images (its step 3): nothing in the twelve
   steps recreates a state container. A running PgBouncer therefore keeps the
   `userlist.txt` it was started with. On an installation that predates #83 that
   is the file of the release tree it was created from, mode 0600 owned by the
   deploy user, which the container's uid 70 cannot open; the new file the
   deploy's step 4 rendered (0640, group 70) is in the NEW tree and is never
   seen by the running container, and a restart of the container re-mounts the
   same file. Every login routed through PgBouncer then fails with `password
   authentication failed for user "pgbouncer_auth"`, and the first customer
   create stops in its first phase. Recreate the container from the new tree,
   after the deploy has recorded the release (`current` names it). Only
   `pgbouncer` is recreated (`--no-deps`; no other state container is touched);
   the app's database connections through it reset and reconnect, a matter of
   seconds. The step is idempotent: run it when in doubt, skip it only on an
   installation whose first `up` of the state project already ran with a
   release that renders the userlist 0640 group 70 (an install by install.md
   5.0.0 or later). The post-condition's PgBouncer lines observe the result.

```bash
cd /opt/gremion/current
stat -c '%a %g %n' docker/pgbouncer/userlist.txt                       # 640 70: the file the deploy rendered
docker compose --env-file /opt/gremion/etc/env/state.env up -d --force-recreate --no-deps pgbouncer
docker compose --env-file /opt/gremion/etc/env/state.env ps pgbouncer  # running, then healthy within about a minute
```

8. **Reconcile every customer (every upgrade; kernel #88, #89).** A release can
   extend what creating a customer provisions, and the deploy migrates databases
   but does not re-run customer creation, so a customer created by an earlier
   release lacks the extension until reconcile re-applies it. Two such pieces
   exist today: the purger role's access to the customer's kernel database
   (`CONNECT`, `USAGE` on schema `public`, `SELECT` and `DELETE` on the purge
   tables; without `CONNECT` the scheduled purge fails for that customer with
   `permission denied for database`, and with `CONNECT` alone it is refused on
   every table) and the customer's NATS seed for the kernel API
   (`kernel-api/tenant_<slug>.nk`; without it the kernel API's event relay fails
   every pass for that customer, forever, while its health check stays green).
   `reconcile --apply` re-ensures both, idempotently, from the registry's current
   state (the customer's real module set, never a list typed by hand), and the
   report names them as the checks `purger-connect` and `kernel-api-nats-seed`.
   Run it for every customer after the switch (the control panel's reconcile
   request does the same), and again whenever a later release names a new check.
   A customer that is suspended is ensured without its modules (reconcile does
   not resume it); a repair that does not take leaves its check RED and the
   command exits non-zero.

```bash
slug="<the customer's slug>"
gremion-tenant reconcile "$slug" --apply --reason "upgrade to ${TAG}: re-ensure what customer creation added since"
# [tenant-create] reconcile realm "<realm>" ... ok  purger-connect ... ok  kernel-api-nats-seed ... applied repairs: purger-connect, kernel-api-nats-seed (a rerun: no repairs)
```

9. **Bring the governance server up (installations first brought up before
   TASK-084-a, once).** Creating a customer makes it a governance database on
   its own server, `governance-postgres`, and deleting one drops it. That server
   belongs to the state project, which the deploy never recreates, and
   `state.env.tmpl` feeds only new installs, so an older host has none of the
   four things the two verbs read: the keys `GOVERNANCE_PG_USER` and
   `GOVERNANCE_PG_PASSWORD` in `state.env`, the running container, the admin
   login file `etc/secrets/tenant-create/governance_pg_admin` and the credential
   directory `etc/secrets/governance` (0700). Without them `gremion-tenant`
   exits 2 on a customer create or delete, naming `GOVERNANCE_PG_ADMIN_FILE`;
   suspend, resume, the Karenz timer, module enable and disable and imports do
   not read the governance server and keep running. Run it after the deploy has
   recorded the release (`current` names it); it adds only these things, apart
   from the executor restart and the ops-realm template check `init` always
   does, and is idempotent: a key that is there is kept, `gremion-tenant init`
   keeps every credential file it already wrote and derives the admin login
   from `state.env`, and `up -d --no-deps` creates the one missing container.
   Keep the key lines out of the shell history: the password is generated
   inside the command and never printed.

   Ownership matters here. The directory `etc/secrets/governance` is bind-mounted
   into every customer-create container, and a bind source that does not exist
   when a container starts is made by the docker daemon as `root:root`, which the
   deploy user can neither chmod nor write credential files into. Two host
   programs make it first (0700, the deploy user) so the daemon never does:
   `gremion-deploy` at the start of its step 4, before the `nats-auth init` run
   (the first `tenant-create` container of a deploy, which also covers a host
   upgraded from a release that never made the directory), and `gremion-tenant`
   before every later `tenant-create` run, including the reconcile of step 8.
   `bootstrap.sh` makes it on a new host. The credential files `tenant-create`
   writes into it are handed to the deploy user's uid and gid (0600), which is
   what lets the nightly `gremion-backup` copy `etc/` as the deploy user.

   A directory that already exists and is not owned by the deploy user (the
   daemon made it, or an earlier release's run did) makes `gremion-deploy` stop
   at step 4 with exit 1, before it renders anything, naming the path. Nothing
   has been switched; repair it once and run the deploy again:
   `sudo chown gremion: /opt/gremion/etc/secrets/governance && sudo chmod 700 /opt/gremion/etc/secrets/governance`.

```bash
f=/opt/gremion/etc/env/state.env
grep -c '^GOVERNANCE_PG_PASSWORD=.' "$f"      # 1: the keys are already there, skip the next line
sudo -u gremion sh -c 'umask 077; printf "\nGOVERNANCE_PG_USER=governance\nGOVERNANCE_PG_PASSWORD=%s\n" "$(openssl rand -hex 16)" >> /opt/gremion/etc/env/state.env'
stat -c '%U %a %n' "$f"                       # still gremion 600
cd /opt/gremion/current
docker compose --env-file "$f" up -d --no-deps governance-postgres
docker compose --env-file "$f" ps governance-postgres                    # running, then healthy within about a minute
gremion-tenant init                           # renders etc/secrets/tenant-create/governance_pg_admin and etc/secrets/governance
```

## Post-condition

The new release serves, the deploy logged fourteen good lines (steps 1-12,
12b, 12c) and no failed one, every customer's reconcile report is green,
the serving release keeps every migration the previous one locked, no dump
is left on the host, and PgBouncer reads the userlist the release rendered
(observed in the container, as its own user, and by a login routed through it):

```bash
grep -Fx "$TAG" /opt/gremion/runtime/current-tag
prev="$(cat /opt/gremion/runtime/previous-tag)"
jq -s 'map([.chains | to_entries[] | .key + " " + (.value.files | to_entries[] | .key + " " + .value)]) | .[0] - .[1]' \
  "/opt/gremion/releases/${prev}/scripts/migrations/applied.lock.json" /opt/gremion/current/scripts/migrations/applied.lock.json   # []
tail -n 14 /opt/gremion/runtime/deploy.log | grep -cE ' STEP [0-9]+[a-z]? [a-z-]+ ok$'     # 14 (1-12, 12b, 12c)
tail -n 14 /opt/gremion/runtime/deploy.log | grep -cE ' STEP [0-9]+[a-z]? [a-z-]+ fail$'   # 0
jq -r '.ts, .ok, (.failures | length)' /opt/gremion/runtime/last-verify.json        # now, true, 0
curl -s -o /dev/null -w '%{http_code}\n' "https://${host}/api/health"               # 200
find /opt/gremion/backups -maxdepth 1 -name 'pre-migration-*' | wc -l               # 0
slug="<each customer's slug, in turn>"
report="$(gremion-tenant reconcile "$slug")" && printf '%s\n' "$report" | grep '^{' | jq -es 'length > 0 and all(.[]; .ok == true and (.checks | type == "array" and length > 0) and all(.checks[]; .ok == true) and any(.checks[]; .name == "purger-connect") and any(.checks[]; .name == "kernel-api-nats-seed"))'     # true; a failed reconcile, no report line, a check not ok:true or a report without the checks purger-connect and kernel-api-nats-seed (an active customer has both) is no pass
cd /opt/gremion/current
docker compose --env-file /opt/gremion/etc/env/state.env exec -T pgbouncer head -c1 /etc/pgbouncer/userlist.txt   # ": PgBouncer's own user (uid 70) reads the file; "Permission denied" means step 7 is owed
PGPASSWORD="$PGBOUNCER_AUTH_PASSWORD" docker compose --env-file /opt/gremion/etc/env/state.env exec -T -e PGPASSWORD postgres \
  psql -h pgbouncer -p 6432 -U pgbouncer_auth -d postgres -Atc 'SELECT current_user'                             # pgbouncer_auth: a login routed through PgBouncer succeeds
grep -c '^GOVERNANCE_PG_PASSWORD=.' /opt/gremion/etc/env/state.env                   # 1: the governance server's key exists (step 9)
sec=/opt/gremion/etc/secrets
stat -c '%U %a %n' "$sec/tenant-create/governance_pg_admin" "$sec/governance"    # gremion 600 ...governance_pg_admin, then gremion 700 ...secrets/governance (root as owner: the daemon made the directory, chown it as step 9 says)
docker compose --env-file /opt/gremion/etc/env/state.env ps --format '{{.Service}} {{.State}} {{.Health}}' governance-postgres   # governance-postgres running healthy
journalctl -t premigration-dump --since today                                       # one taken/created line per dump, one deleted line per file (step 3 and gremion-migration-dump)
for f in /root/.docker/config.json /home/gremion/.docker/config.json; do
  [ -f "$f" ] && jq -e '(.auths // {}) | length == 0' "$f"                          # no registry credential left
done
```

## Failure path

When the deploy stopped before or at the switch, traffic is still on the old
colour or `gremion-rollback` returns it there (`gremion-rollback`, section 4 of
[host-tooling.md](../host-tooling.md)). The dumps are kept. Where the migration
left its database unusable for the old colour, restore that database from the
dump the failing attempt took (`$dump` of its step 3): that file is the state
the old colour was serving when the attempt began. Dumps of earlier attempts are
kept as well; `ls` lists them all, oldest first. Then run the verification
contract:

```bash
cd /opt/gremion/current
ls -1 "${dumpdir}"/pre-migration-"${TAG}"-"${db}"-*.dump    # every attempt's dump, oldest first; $dump is the failing attempt's
docker compose --env-file /opt/gremion/etc/env/state.env exec -T "$svc" \
  pg_restore -U postgres --clean --if-exists -d "$db" < "$dump"
sudo -u gremion /opt/gremion/bin/gremion-verify
jq -e '.ok == true' /opt/gremion/runtime/last-verify.json
```

The dumps are deleted, and each deletion logged as in step 5, only after a later
switch has succeeded.

The kernel or control database is restored from the dump `gremion-deploy` took
at its step 5 instead: `gremion-migration-dump` status names it, restore with
`--release`, `--db` and `--accept-loss-since` (the attempt's start: everything
written since is lost, stated explicitly) recreates the database, and the dump
stays live until the operator's logged discard with `--reason`. While it is
live, a deploy of any other tag stops at its step 5 and prints both commands.

## Known gaps

- (a) TRD-348: `gremion-deploy` pulls digest-pinned, signature-verified images from the registry and refuses a `build:` key in production; TRD-348 keeps building from source at redeploy time until the build-versus-registry decision is taken. TASK-123 measures build and redeploy time and decides TRD-348/TRD-349.
- (b) R15-1 and TRD-206: since TASK-075 (`scripts/migrations/runner/`) the deploy's step 5 is `gremion-migration-dump` preflight, no longer `gremion-snapshot` (no restic snapshot, no off-site remote). It dumps only the databases of the `legacy-boot` chains (kernel, control) of `scripts/migrations/runner/chain-runners.json`. The module chains and `gremion_platform` are migrated by `enableModule` / `gremion-tenant` init, which take no dump on the host yet, so step 3 still dumps those databases by hand (TASK-077/084 wire the runner's dump hook there).
- (d) TRD-344 and TRD-353: the migration register (`scripts/migrations/ranges.json`, `scripts/migrations/applied.lock.json`) is enforced by `scripts/migrations/register.mjs check` in `make lint`, not on the host, so step 1 compares the two releases' locks with `jq`. A running release older than the register has no lock to compare; its upgrade compares the two releases' `migrations` arrays by hand instead. At boot the kernel data plane checks every migration file against its manifest (the file half of TRD-353), but its ledger has no sha256 column, so the applied-row half, `verifyApplied` (`scripts/migrations/verify-applied.mjs`), runs in no service yet (`scripts/migrations/README.md`, Known limits).
- (e) The register renumbered the kernel chain from three to four digits. The kernel data plane compares its ledger by name only and refuses no ledger that still records the old names: on a kernel database created before the renumber it treats every migration as pending and stops at the first `already exists` error without naming the cause. Such a database is re-initialised, not upgraded; step 1's ledger count observes it.
- (c) TRD-189: a release with `overlap: false` makes the deploy's step 6 stop the old colour before the migration, so that release has downtime, where TRD-189 asks for a zero-downtime switch. The idle-colour test against live council data with its records marked as test data and removed afterwards (TRD-179) is not done by `gremion-deploy`, whose step 9 checks health and the verification contract only.
- (f) Kernel #47: whether the GHCR packages are public or the host pulls with a token is not decided; this procedure is written for the token. `gremion-deploy` logs in whatever the answer, and the `deploy` verb of `gremion-hostd` still takes a `TOKEN` line even where the token file is configured ([host-tooling.md](../host-tooling.md), "The registry token on the host").
- (g) TASK-084-a: a customer made before the governance server existed has no governance database and no ledger row of the kind `governance_database_created`, so the control panel counts its setup as eight of nine kinds. Neither reconcile (step 8) nor this runbook creates it afterwards, and no backfill exists yet; it has to exist before TASK-084-b, the first consumer of that database, can serve such a customer. Deleting such a customer is not affected (the drop is a no-op and the log line says `no governance database was present`).

## Changelog

- 9.0.0 (2026-11-08): TASK-084-a. New step 9, after the reconcile: bring the governance server up on an installation first brought up before it existed (the two `GOVERNANCE_PG_*` keys in `state.env`, the `governance-postgres` container of the state project, and `gremion-tenant init` for the admin login file and the credential directory), with its post-condition lines. Only a customer create and delete read the governance server; every other `gremion-tenant` verb runs without it. Major: a step added and the post-condition changed.
- 8.0.0 (2026-11-03): kernel #88, #89, on top of 7.0.0. New step 8, after the PgBouncer recreate: `gremion-tenant reconcile <slug> --apply` for every customer after the switch, which re-ensures what customer creation added since the customer was made (the purger role's `CONNECT` on its kernel database, `USAGE` on schema `public` and `SELECT` + `DELETE` on the purge tables, and the kernel API NATS seed) and reports it as the checks `purger-connect` and `kernel-api-nats-seed`. The post-condition keeps the PgBouncer observations and reads every customer's reconcile report, failing closed: a reconcile that exits non-zero, prints no report line, reports a check without `ok: true` or lacks the checks `purger-connect` and `kernel-api-nats-seed` is no pass. Major: a step added and the post-condition changed.
- 7.0.0 (2026-11-03): kernel #84, on top of 6.3.0. Step 2 creates, fills and renders `etc/legal.env` once per host, the file `gremion-deploy` now copies into every release tree as `legal/legal.env` (the state project's `legal` service reads it for every compose command); an existing host stops at that step until the file is filled, with values copied by hand from the running release. Major: an existing step changed.
- 6.3.0 (2026-11-02): kernel #83. A precondition: the deploy user is in a group with gid 70 (PgBouncer's gid), because the deploy's render step now writes the pgbouncer userlist 0640 group 70 as the deploy user; an older host runs `bootstrap.sh user` once and restarts `gremion-hostd`. Step 7 (existing installs, once): the deploy pulls but never recreates the state project, so a running PgBouncer keeps the unreadable 0600 userlist of the release it was created from; `up -d --force-recreate --no-deps pgbouncer` from the new tree replaces it. The post-condition observes, in the container, that PgBouncer's own user reads the userlist and that a login routed through PgBouncer succeeds. Minor: a conditional step and post-condition observations added, no existing step changed.
- 6.2.0 (2026-10-30): kernel #47 decision (a). Step 4 (and the registry-token precondition) names the optional host token file `etc/registry-token` that `gremion-deploy` reads when `GREMION_REGISTRY_TOKEN_FILE` is set, with the commands that observe it; the prompt stays the default. Minor: an alternative added to a step, no post-condition changed.
- 6.1.0 (2026-10-29): kernel #48. Step 6 (existing installs, once per realm): a realm the provisioner service account did not create (older than the account, or made by another admin) is adopted with `tenant-create bootstrap-provisioner --adopt-realm <realm>`, which grants the account exactly the realm-creator roles on master `<realm>-realm`; reconcile names the step when it meets such a realm. Minor: a conditional step added, no post-condition changed.
- 6.0.0 (2026-10-03): TASK-075. `gremion-deploy` step 5 is `gremion-migration-dump` preflight (no longer `gremion-snapshot`): it dumps the kernel and control databases a release migrates and deletes that dump, logged, at step 12b (`switched`), after step 11 passed and step 12 recorded the release; a failed deletion exits 1 with `DUMP-NOT-DELETED` before the soak (12c). The post-condition counts fourteen step lines. Step 3 now dumps by hand only the other databases a release migrates (module databases, `gremion_platform`); step 5 leaves the deploy's own dump to the program; the failure path restores the kernel or control database from it (restore, then a logged discard). Known gap (b) describes what landed. Major: a step changed.
- 5.0.0 (2026-10-03): H10 (F1 sweep K6#19, TASK-048b relay). Step 1 verifies the release tag with `git verify-tag` against the host anchor `/opt/gremion/etc/allowed_signers` before anything in the clone is read (`gremion-deploy` STEP 2 repeats the check, and also refuses a tag whose signature is not an ssh signature). Major: a step changed.
- 4.0.0 (2026-09-30): TASK-048b. Step 2 first moves a `state.env` rendered before the pins layer split onto `docker-compose.state-pins.yml` by editing its `COMPOSE_FILE` line only (never `gremion-init-secrets --force`, which rotates every live secret); `gremion-deploy` STEP 2 refuses the old layering and names this step. Major: a step changed.
- 3.0.0 (2026-09-30): R29-MAIN-DEFECTS (R29-MD-A). Step 3 creates the pre-migration dump private from its first byte (`umask 077` in the subshell that holds the redirect, `.part` then `mv`) and writes one UTC-stamped file per attempt, so no attempt overwrites the dump an earlier one took; step 5 deletes every dump of the tag after the success check, one logged line per file; the failure path restores the dump the failing attempt took. Major: a step and the post-condition changed (Q9).
- 2.0.0 (2026-09-28): the migration register landed (TASK-029). Step 1 compares the running and the new release's `applied.lock.json` and reads the kernel ledger's naming; the post-condition compares the previous and the serving release's locks. Preconditions and Known gaps (d), (e) describe the landed register instead of a PENDING one. Major: a step and the post-condition changed (Q8).
- 1.0.0 (2026-09-27): first version, provisional (TASK-037).
