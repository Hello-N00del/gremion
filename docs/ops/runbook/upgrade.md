# Upgrade: one release onto a running installation

- Version: 4.0.0
- Status: provisional (see Known gaps)
- Wall-clock budget: one working day, from step 1 to the asserted post-condition (PRD-PLAT-005)
- Implements: TRD-200 (upgrade), TRD-206 (the pre-migration dump, R18-4), TRD-189 (blue/green as the deploy path)

An upgrade is one run of `gremion-deploy <tag>`: twelve steps, each logged as
`<timestamp> STEP <n> <name> ok|fail` to `runtime/deploy.log`, the new colour
started, verified and switched to while the old colour is kept for rollback. The
procedure around it adds what the program does not do: the check before, the
short-lived pre-migration dump of TRD-206 (R18-4) and its deletion after a
succeeded switch, and the read of the result. The program's own reference is
[host-tooling.md](../host-tooling.md), section 4.

This procedure is provisional: where the program and a requirement disagree it
follows the program, and each divergence is a Known gap below.

Every bash step assumes this preamble:

```bash
export TAG=dist-vX.Y.Z                       # the release being deployed
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
- The administrator holds a registry read token, typed at a prompt, never
  written to disk.
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
stat -c '%U %n' "$REL"                                            # gremion
jq '{tag, overlap, migrations}' "$REL/release.json"
jq -s 'map([.chains | to_entries[] | .key + " " + (.value.files | to_entries[] | .key + " " + .value)]) | .[0] - .[1]' \
  /opt/gremion/current/scripts/migrations/applied.lock.json "$REL/scripts/migrations/applied.lock.json"   # []
kdb="<the kernel database>"
cd /opt/gremion/current
docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
  psql -U postgres -d "$kdb" -tAc "SELECT count(*) FROM schema_migrations WHERE filename = '0001_governance_schema.sql'"   # 1
```

2. **Validate the env files against the new tree (E1).** Once per host, first:
   a `state.env` rendered before the pins layer was split per project (TASK-048b)
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

3. **Take the pre-migration dump (TRD-206, R18-4).** Only when `migrations` is
   not empty: one dump of each database the migration alters, kept until the
   switch has succeeded and not a day longer. This is the interim form, taken by
   hand, until the migration runner takes it itself (see Known gaps). The dump
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
svc="postgres"          # the state project's server holding it: postgres (kernel) or <id>-postgres (module)
dumpdir=/opt/gremion/backups
dump="${dumpdir}/pre-migration-${TAG}-${db}-$(date -u +%Y%m%dT%H%M%SZ).dump"
cd /opt/gremion/current
( umask 077; set -o noclobber; docker compose --env-file /opt/gremion/etc/env/state.env exec -T "$svc" \
  pg_dump -U postgres -Fc "$db" > "${dump}.part" ) && mv -- "${dump}.part" "$dump" && sha256sum "$dump"
stat -c '%a %U' "$dump" && logger -t premigration-dump "taken ${dump} before ${TAG}"   # 600 root; logged only for a dump that exists
```

4. **Deploy.** The token goes to the program on standard input; the program logs
   out of the registry on every exit path and asserts that no credential
   survives.

```bash
read -rs GHCR_TOKEN
printf 'TOKEN %s\n' "$GHCR_TOKEN" | sudo -u gremion /opt/gremion/bin/gremion-deploy "$TAG"
unset GHCR_TOKEN
```

5. **Delete the dumps once the switch has succeeded, and log each.** The switch
   succeeded when `runtime/current-tag` names the new tag and the last deploy
   line is `STEP 12 record ok`. It deletes every `pre-migration-${TAG}-*.dump`
   and `.dump.part` of this tag: the dump of this attempt and those of earlier
   attempts, whose state the switch has now made obsolete. If the switch did
   not succeed, keep them all and follow the failure path below.

```bash
tail -n 1 /opt/gremion/runtime/deploy.log
if grep -Fxq "$TAG" /opt/gremion/runtime/current-tag; then
  for f in "${dumpdir}"/pre-migration-"${TAG}"-*; do [ -e "$f" ] || continue; rm -f -- "$f"; logger -t premigration-dump "deleted ${f} after the switch to ${TAG} succeeded"; done
fi
```

## Post-condition

The new release serves, the deploy logged twelve good steps and no failed one,
the serving release keeps every migration the previous one locked, and no dump
is left on the host:

```bash
grep -Fx "$TAG" /opt/gremion/runtime/current-tag
prev="$(cat /opt/gremion/runtime/previous-tag)"
jq -s 'map([.chains | to_entries[] | .key + " " + (.value.files | to_entries[] | .key + " " + .value)]) | .[0] - .[1]' \
  "/opt/gremion/releases/${prev}/scripts/migrations/applied.lock.json" /opt/gremion/current/scripts/migrations/applied.lock.json   # []
tail -n 12 /opt/gremion/runtime/deploy.log | grep -cE ' STEP [0-9]+ [a-z-]+ ok$'     # 12
tail -n 12 /opt/gremion/runtime/deploy.log | grep -cE ' STEP [0-9]+ [a-z-]+ fail$'   # 0
jq -r '.ts, .ok, (.failures | length)' /opt/gremion/runtime/last-verify.json        # now, true, 0
curl -s -o /dev/null -w '%{http_code}\n' "https://${host}/api/health"               # 200
find /opt/gremion/backups -maxdepth 1 -name 'pre-migration-*' | wc -l               # 0
journalctl -t premigration-dump --since today                                       # one taken line per attempt, one deleted line per file
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

## Known gaps

- (a) TRD-348: `gremion-deploy` pulls digest-pinned, signature-verified images from the registry and refuses a `build:` key in production; TRD-348 keeps building from source at redeploy time until the build-versus-registry decision is taken. TASK-123 measures build and redeploy time and decides TRD-348/TRD-349.
- (b) R15-1 and TRD-206: the deploy's step 5 runs `gremion-snapshot`, which runs `gremion-backup --class snapshot`. That needs a reachable off-site remote and keeps a restic snapshot until it is forgotten, which contradicts both the no-backup posture (R15-1) and the single dump deleted after the switch (TRD-206). With the remote unreachable an upgrade stops at `STEP 5 snapshot fail`, before any colour is stopped.
- (b) continued: PENDING TASK-075 (`scripts/migrations/runner/`) takes the pre-migration dump inside the migration runner; until then step 3 is the TRD-206 dump, taken by hand.
- (d) TRD-344 and TRD-353: the migration register (`scripts/migrations/ranges.json`, `scripts/migrations/applied.lock.json`) is enforced by `scripts/migrations/register.mjs check` in `make lint`, not on the host, so step 1 compares the two releases' locks with `jq`. A running release older than the register has no lock to compare; its upgrade compares the two releases' `migrations` arrays by hand instead. At boot the kernel data plane checks every migration file against its manifest (the file half of TRD-353), but its ledger has no sha256 column, so the applied-row half, `verifyApplied` (`scripts/migrations/verify-applied.mjs`), runs in no service yet (`scripts/migrations/README.md`, Known limits).
- (e) The register renumbered the kernel chain from three to four digits. The kernel data plane compares its ledger by name only and refuses no ledger that still records the old names: on a kernel database created before the renumber it treats every migration as pending and stops at the first `already exists` error without naming the cause. Such a database is re-initialised, not upgraded; step 1's ledger count observes it.
- (c) TRD-189: a release with `overlap: false` makes the deploy's step 6 stop the old colour before the migration, so that release has downtime, where TRD-189 asks for a zero-downtime switch. The idle-colour test against live council data with its records marked as test data and removed afterwards (TRD-179) is not done by `gremion-deploy`, whose step 9 checks health and the verification contract only.

## Changelog

- 4.0.0 (2026-09-30): TASK-048b. Step 2 first moves a `state.env` rendered before the pins layer split onto `docker-compose.state-pins.yml` by editing its `COMPOSE_FILE` line only (never `gremion-init-secrets --force`, which rotates every live secret); `gremion-deploy` STEP 2 refuses the old layering and names this step. Major: a step changed.
- 3.0.0 (2026-09-30): R29-MAIN-DEFECTS (R29-MD-A). Step 3 creates the pre-migration dump private from its first byte (`umask 077` in the subshell that holds the redirect, `.part` then `mv`) and writes one UTC-stamped file per attempt, so no attempt overwrites the dump an earlier one took; step 5 deletes every dump of the tag after the success check, one logged line per file; the failure path restores the dump the failing attempt took. Major: a step and the post-condition changed (Q9).
- 2.0.0 (2026-09-28): the migration register landed (TASK-029). Step 1 compares the running and the new release's `applied.lock.json` and reads the kernel ledger's naming; the post-condition compares the previous and the serving release's locks. Preconditions and Known gaps (d), (e) describe the landed register instead of a PENDING one. Major: a step and the post-condition changed (Q8).
- 1.0.0 (2026-09-27): first version, provisional (TASK-037).
