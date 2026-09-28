# Backup: installed, verified once, then off

- Version: 1.0.0
- Wall-clock budget: one working day, from step 1 to the asserted post-condition (PRD-PLAT-005)
- Implements: TRD-200 (backup), TRD-170 and TRD-174 in their pilot form (R15-1), FLOW-OPS-005
- First run: TASK-089, on the rebuilt host, before any council data exists

**The pilot posture (R15-1).** The platform's own backup job is installed and
verified exactly once, by a full backup and a timed restore of it, and is then
disabled for the whole pilot; the hosting provider's backup product is switched
off with it once its own drill has passed ([restore.md](restore.md), arm A). No
backup of any kind runs for the rest of the pilot. That means the 24-hour
recovery point is **not** met during the pilot: a host, disk or migration failure
or an operator mistake loses the customer's data, and the customer's own exports
are the only continuity left. The job stays installed, so turning it back on is
a configuration change, not a build.

**The one exception (R18-4, TRD-206).** Before each schema migration one dump of
the database it alters is taken, and deleted once the blue/green switch has
succeeded. It is a short-lived safety copy, not a backup regime, and it lives in
[upgrade.md](upgrade.md), step 3, not here.

**Off-site.** The off-site mirror is in code and off: `gremion-backup` mirrors
its restic repository to the remote named by `RCLONE_REMOTE`, `RCLONE_BUCKET` and
`RCLONE_REMOTE_PATH` and reads it back, but in the pilot that happens only in the
verification run. A current off-site copy at a second provider is the north
star for the 12-month form, once paying councils exist (R13-4, TRD-171).

## Preconditions

- [install.md](install.md) passed: `gremion-backup.service` and
  `gremion-backup.timer` are installed from
  `infra/host/templates/systemd/gremion-backup.timer` and its service, and the
  timer is disabled.
- The state project and the serving colour are up, so the backup enumerates
  every database, volume and bucket from the running system.
- `BACKUP_POSTGRES_SERVICES` (every PostgreSQL server of the state project,
  see Known gaps), `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` and the three
  `RCLONE_*` keys are filled in `/opt/gremion/etc/env/state.env`, and the remote
  answers for this one run (see Known gaps).
- A non-production unit is ready for [restore.md](restore.md), arm B, which is
  the timed-restore half of this verification.

## Steps

1. **Confirm the job is installed and off.**

```bash
systemctl cat gremion-backup.service | grep -E '^ExecStart='
systemctl is-enabled gremion-backup.timer          # disabled
```

2. **Run the one verification through the installed unit.** Starting the
   service, not the program, proves the unit as installed. The unit is a
   oneshot, so the command returns when the run ends; the run writes
   `runtime/last-backup.json` and appends to `logs/backup.log`.

```bash
systemctl start gremion-backup.service
tail -n 20 /opt/gremion/logs/backup.log
jq '{ts, ok, label, class, artefacts, offsite, bytes}' /opt/gremion/runtime/last-backup.json
```

3. **Check the snapshot holds every database.** One dump per database of the
   kernel and of every enabled module (TRD-170's inspection); a missing one fails
   the verification.

```bash
. /opt/gremion/lib/common.sh && load_env /opt/gremion/etc/env/state.env
restic snapshots --latest 1
restic ls latest | grep -E '\.sql\.gz$'
```

4. **Restore it, timed, into the non-production unit.** Follow
   [restore.md](restore.md), arm B, with this snapshot. On that unit:

```bash
jq -e '.ok == true and .rtoSeconds != null and .proofs.files >= 1 and .proofs.rows >= 1' \
  /opt/gremion/runtime/last-restore.json
```

5. **Switch the provider's backup product off.** MANUAL: at the provider panel,
   once [restore.md](restore.md) arm A has passed, disable the provider-side
   host backup product (TRD-174, R13-4). Record the time and the panel's own
   confirmation in the run record.

## Post-condition

The one verification succeeded and nothing is scheduled to run again:

```bash
jq -e '.ok == true and .artefacts.databases > 0' /opt/gremion/runtime/last-backup.json
systemctl is-enabled gremion-backup.timer          # disabled
systemctl is-active gremion-backup.timer           # inactive
systemctl show gremion-backup.service -p ExecMainStartTimestamp -p ExecMainExitTimestamp
```

The size (`bytes`) and the duration (the two timestamps) of this run are the
figures TRD-383 publishes per council and per module. The provider product's
state is not visible from the host; the run record carries the panel's
confirmation instead.

## Turning it back on

The 12-month form runs the job nightly with an off-site copy (TRD-170,
TRD-171). Turning it on is one command, and its post-condition is a real next
run, not "enabled":

```bash
systemctl enable --now gremion-backup.timer
systemctl show gremion-backup.timer -p NextElapseUSecRealtime --value      # a date, not n/a
```

## Known gaps

- `gremion-backup` refuses without a reachable off-site remote, while the pilot keeps off-site copies off; the verification run therefore needs a remote for that one run.
- The pooled layout (TASK-040, [pooled-stack-layout.md](../pooled-stack-layout.md)) puts the kernel's databases on the state project's `postgres` and each enabled module's on its own `<id>-postgres` (D14). `BACKUP_POSTGRES_SERVICES` must name every one of them for step 3 to find one dump per database; the release's restore script still restores into `postgres` only, so `gremion-restore-into` stops with `BLOCKED:` on a module server's dump ([restore.md](restore.md), arm B), until PENDING TASK-089 (`scripts/backup/`) lands the per-module path.
- PENDING TASK-089 (`scripts/backup/`): the per-module verification (one database per module server, D14) and the pilot's verification path replace today's enumeration; TASK-089 also runs this procedure first.

## Changelog

- 1.0.0 (2026-09-27): first version (TASK-037).
