# Operations runbook

Four procedures for one single-customer Gremion installation on a distribution
host: **install**, **upgrade**, **backup** and **restore**. Each is versioned on
its own, names its preconditions, numbers its steps and ends in a post-condition
the administrator asserts against the running system. An administrator who is
not the vendor must be able to complete all four from these pages alone, within
one working day each, without help from the vendor (PRD-PLAT-005, TRD-200). A
step that cannot be done from this text is a defect in the runbook, and is
recorded as one.

| Procedure | What it does | Version | First run |
|---|---|---|---|
| [install.md](install.md) | the from-zero bring-up a rebuilt host follows (TRD-042, R15-2) | 4.1.0 | TASK-038, the pilot re-initialisation |
| [upgrade.md](upgrade.md) | one release onto a running installation through `gremion-deploy` | 6.0.0 (provisional) | the first pilot release after the re-initialisation |
| [backup.md](backup.md) | the pilot posture: installed, verified once, then disabled (R15-1) | 1.0.0 | TASK-089 |
| [restore.md](restore.md) | three arms: the provider host-backup drill, the platform restore into a non-production stack, the reboot measurement | 2.0.0 | TASK-089 (arms A, B), TASK-123 (arm C) |
| [run-record.md](run-record.md) | the record every run of a procedure leaves | — | — |

`test/host/runbook.bats` keeps these pages honest: every `gremion-*` program they
name exists in `infra/host/bin`, every path exists or is listed as pending,
every step is a script block or a named manual step, and every post-condition
reads state rather than an exit code.

## Conventions

**Where things run.** Every step runs as root on the host unless it says
otherwise. The exception is the deploy user's own programs: `gremion-init-secrets`,
`gremion-backup`, `gremion-deploy`, `gremion-verify`, `gremion-restore-into`,
`gremion-snapshot`, `gremion-switch`, `gremion-rollback` and `gremion-render`
always run as `sudo -u gremion`, as the installed systemd units do. They read
`etc/env/*.env` inside the deploy user's 0700 `etc/`, `gremion-deploy` runs
git in the release checkout, which git refuses when another user owns it, and
re-renders the release tree's host-owned files as `gremion`. So
the env files and every release tree belong to `gremion`: a release tree root
clones is handed over with `chown -R gremion:gremion` before anything reads it,
and `test/host/runbook.bats` fails on a deploy-user program run as root.
The programs and the host layout are described in
[host-tooling.md](../host-tooling.md) and [infra/host/README.md](../../../infra/host/README.md);
this runbook cites them and does not repeat them. `docker compose` is only ever
called as `docker compose --env-file /opt/gremion/etc/env/<project>.env <verb>`,
because each env file carries its project's composition, and from the directory
its relative `COMPOSE_FILE` names: the release tree for `state`, `app-blue` and
`app-green`, `compose/observability/` and `infra/host/mail/` inside it for `ops`
and `mail`. The five projects are the pooled layout of
[pooled-stack-layout.md](../pooled-stack-layout.md); install.md tables them.

**The env contract.** `load_env` in `infra/host/lib/common.sh` is the single
reader of an env file; nothing sources one any other way. `gremion-validate-env`
adds what `load_env` lacks: an absent file is "run setup first", `load_env`'s
refusals (duplicate keys, `CHANGE_ME_` sentinels, empty template-marked secrets)
stop it, and a compose file missing from the release tree or two keys sharing
one generated secret with different values fail it. It never prints a value.
`GREMION_PRODUCTION_STACK` names the production stack on a host that runs one
and is the literal `none` on a host without a production unit; database hosts
are stack-qualified, so two stacks on one machine never share a database.

**Readiness.** A service is ready when `/api/health` answers `200`. `/healthz`
is liveness only (it answers while a process is still booting) and is never a
readiness check in this runbook.

**Step shapes.** A step is either a fenced `bash` block the administrator runs,
or a `MANUAL:` step done outside the host, at the hosting provider's panel or at
the domain registrar. Every `MANUAL:` step is listed below.

**Post-conditions.** A post-condition reads state: `docker inspect`,
`docker exec ... env`, `curl`, `psql`, `systemctl is-enabled`/`is-active`,
`journalctl`, or `jq` on a `runtime/*.json` file the host tooling writes. An exit
code is not evidence; a suite that collected nothing also exits 0.

**Pending.** Where a procedure needs something another task has not landed yet,
it says `PENDING TASK-nnn` next to the path that task will create. The step is
then recorded as blocked in the run record, never skipped silently. The guard
fails the day that path appears, so the citation is rewritten in the same change.

**Known gaps.** Where the host tooling and a requirement disagree, the procedure
follows the tooling as it is, and its `## Known gaps` names the divergence and
the task that owns it. No step invents a program that does not exist.

**Versioning.** Each procedure carries `Version: X.Y.Z` and a changelog entry
per version, semantic-versioned from 1.0.0: a major version changes a step or
the post-condition, a minor version changes a precondition or the wall-clock
budget, a patch changes wording only. A run record cites the version it followed.

**Dates and records.** Each run leaves one record in the shape of
[run-record.md](run-record.md), filed in the deployment's private annex, never in
this repository. Addresses and names on these pages are documentation values
(`example.org`, `203.0.113.0/24`, `2001:db8::/32`).

## Manual steps

- `install.md` step 1 — rebuild the server from zero at the provider panel and set reverse DNS.
- `install.md` step 2 — remove the old records and publish DNS edit 1 at the registrar.
- `backup.md` step 5 — switch the provider's backup product off at the provider panel.
- `restore.md` arm A step 2 — take or select the provider-side host backup at the provider panel.
- `restore.md` arm A step 3 — restore that backup onto the same server at the provider panel.

## Pending dependencies

Each of these is named at the step that needs it:

- TASK-043b: creating the pilot customer with `gremion-tenant create` (TASK-043, `packages/provisioning/`) and its first administrator's sign-in waits for the green customer proof (install.md step 17).
- PENDING TASK-089 (`scripts/backup/`): the per-module backup verification that replaces today's enumeration (backup.md).
- PENDING TASK-119 (`services/kernel-api/export/`): the tenant export, and its restore on a clean host by someone who is not the vendor (restore.md).

Landed since the first version: TASK-029's per-chain migration register
(`scripts/migrations/ranges.json`, its frozen hashes in
`scripts/migrations/applied.lock.json`, `scripts/migrations/register.mjs` and the
boot-check library `scripts/migrations/verify-applied.mjs`). upgrade.md step 1 and
its post-condition read the lock with `jq`; its Known gaps (d) and (e) name what
the register does not yet enforce on a running host. TASK-075's expand/contract
runner and pre-migration dump (`scripts/migrations/runner/`,
`gremion-migration-dump`): `gremion-deploy` step 5 dumps the kernel and control
databases and deletes that dump after the switch; upgrade.md step 3 dumps the
other databases by hand.

## What this runbook is not

- It is not the go-live gate: [go-live-gate.md](../go-live-gate.md) lists what an
  instance must prove before real users. Mail bring-up (`gremion-mail-bringup`,
  gate item G4-MAIL) is part of that gate, not of these four procedures.
- It supersedes [restore-runbook.md](../restore-runbook.md), which describes the
  retired restic/rclone recovery of three kernel databases and is kept only as a
  historical reference.

## Grounding

ISO/IEC 27001:2022 Annex A 5.37 (documented operating procedures); BSI
IT-Grundschutz OPS.1.1.2 (ordnungsgemäße IT-Administration); NIST SP 800-34
Rev. 1 (contingency planning). The requirements are TRD-200, TRD-042, TRD-170,
TRD-174, TRD-175, TRD-180, TRD-189, TRD-206 and PRD-PLAT-005, PRD-OPS-001,
PRD-OPS-007.
