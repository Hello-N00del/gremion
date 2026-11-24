# Continuous deployment of the host (`gremion-cd`)

For the platform operator. This document describes what `gremion-cd` does on a host, as the
program is built in this repository, and what the operator does when it stops and asks. It is
the one document to read before the first adoption and the one to open when a mail says a
release was held, rolled back or parked. The host layout and the other host programs are in
[host-tooling.md](host-tooling.md); the install and upgrade procedures that CD does not
replace are in [runbook/](runbook/README.md).

Names in `<angle brackets>` are placeholders. This repository is public, so the document names no
address, host or date: the operator address is `<operator address>`, the agreement date is
`<agreement date>`, a short commit id is `<sha12>`. `scripts/cd/cd-docs-drift.test.mjs` reads the
tables below and compares them with the program, so a verb, flag, hold kind, mail kind or config
key that is renamed in the code fails the build until this document follows.

## What stage 1 does and does not do

**It does.** Every five minutes a timer starts one `gremion-cd tick`. The tick looks at the main
branch of the public repository, takes the newest commit that arrived through a merged pull
request and has a successful CI run, and compares it with the release that is live. A commit
that changes application code only is released without anyone being asked:

1. the new release is built from source on the host, under the tag `pilot-<sha12>`, for the
   colour that does not serve;
2. a dump of the databases it could change is taken, the modules' own databases are migrated by
   the module step, the three leaf services' databases by the leaf step;
3. the new colour starts with its background jobs switched off, passes its readiness, isolation
   and verify gates, and traffic is switched to it;
4. the new colour is watched for twenty minutes of observed time. A failure in that window
   rolls the release back automatically;
5. at the commit point the release becomes the live one, the old colour is stopped, and every
   customer is reconciled once;
6. the operator gets one mail at each decision point.

**It holds, and asks, for everything else.** A release that changes a host program or one of the
host's systemd, firewall or env templates, the compose configuration of the state project, the edge,
a migration chain the program cannot apply, a contract migration, the CI workflows, or the database
declaration of a module is not released by itself:
the tick sets a hold, mails the one command that applies it (or says that stage 1 cannot), and
waits. See [Holds](#holds).

**It does not.**

- It never restores a database. A rollback switches traffic back; the data stays where the new
  release left it. The dump set is the operator's restore point, and restoring from it is a
  manual act (see [Rollback](#rollback) and [Dump set](#dump-set)).
- It never rolls a committed release back by itself. After the commit point only the operator's
  explicit `gremion-cd rollback` goes back one release.
- It has no trial cohort: the switch moves all traffic. Cookie routing and a job lease are not
  part of stage 1.
- It does not dump the data of the messaging, governance and file-sync servers, and it does not
  dump the login server's database in an application release (see [Dump set](#dump-set)).
- It writes nothing to GitHub. It reads the repository; a token file is optional and only raises
  the rate limit.
- It never updates itself unattended. A change to its own programs is a held release that the
  operator applies in a window ([Applying host programs](#applying-host-programs-and-the-state-tier-in-a-window)).

**Where things live.** `ROOT` is `/opt/gremion`.

| Path | What it is |
|---|---|
| `etc/cd.env` | the configuration, parsed and never sourced; an unknown key stops the program with exit 2 |
| `etc/cd.disabled` | the kill switch: while the file exists, automation is off |
| `data/cd/state.json` | the state (phase, hold, live and previous release, the release in flight, the last poll); mode 0600, written atomically |
| `data/cd/blocked.json` | the open and cleared blocks |
| `data/cd/history.jsonl` | one line per event, names and counts only |
| `data/cd/host-manifest.json` | the hash of every host program as last applied |
| `data/cd/outbox/` | mails that are queued and not yet sent |
| `data/cd/ALERT` | present when a fatal exit or a dead mail path needs a human |
| `data/cd/mirror.git` | the mirror of the main branch that releases are fetched from |
| `data/cd/host-backup/` | the installed host programs, copied before an apply |
| `runtime/cd/` | the heartbeat, the lock file and the queue of operator requests |
| `runtime/hostd.lock` | the host's mutating lock (shared with the executor, backup and purge) |
| `runtime/workers/<colour>` | the worker gate file of a colour: `off` stops its background jobs |
| `releases/<sha12>` | the release trees; `current` points at the live one |
| `logs/` | 0600 files with the tails of failed builds and one-shots; they name customers and are never printed or mailed |

The program logs and mails names of components and stages, counts, durations and codes. It never
puts a customer slug, a host name, member data or an address into a log, a mail or the state; the
one place a slug leaves the process is the argument of the reconcile child (see
[Reconcile](#reconcile-after-the-commit-point)).

## How a release moves

### Stages

The stages run in this order. `host_apply` and `state_apply` run only for
`release-now <sha12> --with-state`; every other stage runs for every release. The stage that a
release is in, and whether it started, finished or failed, is in `status`.

| Stage | What it does |
|---|---|
| `select` | writes the release record (id `<sha12>-<n>`) and makes the colour that does not serve the target |
| `fetch` | fetches the commit into the mirror by a named ref and checks out a clean tree under `releases/<sha12>` |
| `classify` | compares the live tree with the new tree and the host manifest, and decides the class of the release and its holds |
| `host_apply` | copies the installed host programs to `data/cd/host-backup/`, then installs the new ones through the root unit (see [Applying host programs](#applying-host-programs-and-the-state-tier-in-a-window)) |
| `state_apply` | applies the state tier: dump set, retag of `state.env`, build, render, the platform step when the release has one, `up`, healthy, edge answering |
| `retag` | sets `IMAGE_TAG` of the target colour's env file to `pilot-<sha12>` and records the old value so a teardown can put it back |
| `render` | renders the target colour's env and config from the new tree |
| `build` | builds the images, with a timeout and retries; a failure is classified as the host's (retry, no block) or the commit's (block) |
| `snapshot` | checks the lock span against the backup and purge timers, takes the host lock, takes the dump set |
| `migrate` | runs the two kernel one-shots, then the module step, then the leaf step |
| `start` | starts the target colour with its worker gate `off` and waits until every container is healthy |
| `gates` | the readiness gate (public and internal `/readyz`, image identity, the routing test), the isolation evidence and verify |
| `switch` | records `switch_started`, switches traffic from the new tree, and confirms the router graph for all services |
| `watch` | the watch window of `CD_WATCH_MINUTES` of observed time |
| `commit` | the commit point and the steps around it (see below) |
| `reconcile` | reconciles every customer once, after the commit point |

Before `switch_started` is written a failure is a teardown: the target colour is stopped, its
env tag is put back, the live colour and everything of it are untouched. After it, a failure is
a rollback. After the commit point it is a hold and nothing else.

### Phases

| Phase | Meaning |
|---|---|
| `idle` | nothing in flight; a hold, if any, is in the state |
| `releasing` | a release is running before its switch, or its watch has not started |
| `watching` | the new colour serves and is being watched |
| `rolling_back` | the rollback sequence is running |
| `parked` | a shared outage outlasted the pause cap: the new colour serves, `current` is still the old tree, the host lock is free, and a critical mail says so |

### Pick-up

A commit is releasable only when a successful push run of the CI workflow exists for it on the
main branch, with a successful "Verify gate" job, and a merged pull request accounts for every
first-parent commit between the live release and it. The program walks back at most
`CD_WALKBACK` commits from the tip for a green one. Anything it cannot read, a rate limit, a
truncated page, an exhausted budget of `CD_API_BUDGET_PER_HOUR` calls, is "no verdict", never
green. It also checks, on every pick-up, that the branch rules are in force and that the
repository allows squash merges only with a linear history (unless `CD_ALLOW_ANY_MERGE_METHOD` is
1).

A tick does not start a release when any start gate is closed, and says which one in
`status` and in the history: the kill switch exists, `CD_POLICY_ACK` or `CD_MAIL_TO` is unset,
the mail path is not the relay (unless `CD_ALLOW_NO_MAIL` is 1), `data/cd/ALERT` exists, a queued
mail is older than an hour, the clock is in a quiet window (`CD_QUIET_WINDOWS`, host time), the
cd lock or the host lock is held, the live colour does not answer ready through the real edge,
the state project is unhealthy, or free disk is below `CD_MIN_FREE_GB`. An infrastructure
failure before the switch is retried by later ticks: the second attempt at the same commit waits 60
seconds after the first failure and the third waits 300 seconds after the second; the third failure
of the same commit sets the hold `failure` with the reason `infra_retries`.

### The commit point

When the watch window has ended clean, the commit steps run under the host lock, in this order:

1. the isolation record of the new tip is written;
2. `current` is pointed at the new tree and read back;
3. `runtime/current-tag` and `previous-tag` are written from the state;
4. the executor is restarted so it re-reads its handlers from `current` (a failure here is a
   warning);
5. one atomic state write makes the new release `live`, the old one `previous`, and sets
   `release.committed_at`. **This write is the commit point.** Steps 1 to 5 retry as one
   sequence for at most `CD_COMMIT_MAX_MIN`; at the cap the release is rolled back, without a
   block, under the rule `commit_stuck`;
6. the dump set of this release is retired (deleted and logged);
7. the old colour's project is stopped;
8. the `released` mail is queued.

Steps 6 to 8 retry every minute; if one is given up, the hold is `failure` with a reason
`post_commit_<n>` and the release stays committed. Then the driver prunes old images and release
trees, lets go of the host lock, and runs the reconcile stage under the cd lock.

From the write in step 5 on, no failure, crash, kill, retry or resume calls a rollback. That is
the line the whole design keeps.

## Commands

All verbs exit 0 on success, 1 when an assertion about the running system failed, 2 for usage, a
missing precondition, a bad config or an unknown state version, and 3 when busy or blocked (retry
later). Four verbs, `hold`, `resume`, `release-now` and `rollback`, do not act themselves: each writes
a request file under `runtime/cd/requests/` and then tries `sudo -n systemctl start --no-block
gremion-cd.service`. A running process drains requests at every sample, an idle one at the next
tick, so a request is taken within five minutes at the latest. The other verbs act at once.

| Verb | Usage | What it does |
|---|---|---|
| `help` | `gremion-cd help` | lists the verbs; needs no config |
| `version` | `gremion-cd version` | the program version and the state schema version |
| `status` | `gremion-cd status [--json]` | read-only; see below |
| `hold` | `gremion-cd hold [--reason TEXT]` | sets the hold `operator`; no pick-up until `resume` |
| `resume` | `gremion-cd resume [--reason TEXT] [--discard-dump] [--accept-descendants]` | clears a hold of the kinds that `resume` can clear (see [Holds](#holds)); refused while a block is open unless `--accept-descendants` is given with a reason; refused while a failed release's dump set is live unless `--discard-dump` is given |
| `release-now` | `gremion-cd release-now <sha12 or main> [--with-state] [--force-blocked] [--accept-range --reason TEXT] [--ref BRANCH --unverified]` | releases the named commit now. Every normal check still applies; the verb waives only the hold of that candidate, per the table in [Holds](#holds). `main` means the newest verified candidate |
| `rollback` | `gremion-cd rollback [--reason TEXT]` | before the switch: aborts the release (teardown, hold `operator`, no block); after the switch: the rollback sequence; after the commit point: back one release, only when `previous` is startable |
| `reconcile` | `gremion-cd reconcile` | re-runs the reconcile stage for the live release; needs `phase` idle; refused while parked |
| `adopt` | `gremion-cd adopt [--re-adopt --reason TEXT]` | first adoption, or the re-read of the running system after a hand intervention |
| `selftest` | `gremion-cd selftest [--post-apply]` | the host's readiness checks (see [Adoption](#adoption)); `--post-apply` is used by the apply unit |
| `tick` | `gremion-cd tick [--resume-only]` | one cycle; started by the timer and, with `--resume-only`, by the boot unit |
| `watchdog` | `gremion-cd watchdog` | the dead-man check; started by its own timer |
| `poll` | `gremion-cd poll [SHA]` | dry run of the pick-up: prints the verdict, sends no mail, writes no state |
| `classify` | `gremion-cd classify FROM TO [--no-compose]` | read-only replay of the classifier over a range of the mirror |

`status` prints, in this order: a PROOF MODE banner if proof mode is on; whether automation is on
or off; the phase (a parked release says what serves); the hold with its reason and age; the live
and previous release (short id, tag, colour, and whether the previous one is startable); the
release in flight and its stage; the minutes left in the watch; the last poll and its verdict; the
open blocks by rule; the counts of the last reconcile, module step and leaf step; how long the
last release held the host lock; the live dump sets; the drift of the installed host programs
against the manifest; the mail transport and the age of the oldest queued mail; the `ALERT`
file; whether the lock span fits before the next backup and purge; the keys of `etc/cd.env` that
differ from the default, by name only (the operator values show as `set` or `unset`, never their
value); and the next timer elapse.

## Configuration

`etc/cd.env` is written once by `bootstrap.sh cd` from the template and is never overwritten
afterwards: it is the operator's file. A line is `KEY=VALUE`, the value is taken literally (one
pair of quotes is stripped), an unknown key stops the program, and so does a value that still
carries a `CHANGE_ME_OPERATOR_` marker. A key that is deleted falls back to its default.

### Operator values

These have no default. A tick refuses to run on a placeholder.

| Key | Needed | Meaning |
|---|---|---|
| `CD_REPO_URL` | always | the https address of the public repository the releases come from |
| `CD_MAIL_TO` | unless `CD_ALLOW_NO_MAIL` is 1 | the one address every mail goes to; it is set on the host by the install and appears in no file of this repository |
| `CD_HOST_LABEL` | unless `CD_ALLOW_NO_MAIL` is 1 | a short label for this host in mails and logs: lower case letters, digits and `-`, at most 32; it must not be a host name or an address |
| `CD_PROBE_HOST` | no | a customer host name the probes use; empty means the first line of `etc/tenant-hosts.txt` |
| `CD_PING_URL` | no | an optional dead-man URL called once per successful tick, never logged; empty switches the ping off |
| `CD_POLICY_ACK` | for any release | the date the release-cadence agreement was recorded; empty means no release starts |
| `CD_GITHUB_TOKEN_FILE` | no | the absolute path of a file that holds a GitHub token; it is read as a file and never appears on an argument list |
| `CD_PROOF_REPO` | proof mode only | where the proof branches are fetched from: an https address, or the absolute path of a local bare repository; a local path is accepted only with `CD_PROOF_MODE=1` and the program refuses to load the config otherwise |

### Tunable keys

| Key | Default | Meaning |
|---|---|---|
| `CD_ALLOW_NO_MAIL` | `0` | 1 lets a host without a working relay release; the status says so |
| `CD_ALLOW_ANY_MERGE_METHOD` | `0` | 1 accepts a repository that allows more than squash merges; leave it at 0 |
| `CD_VERIFY_ENFORCE` | `0` | 0: a failed verify is only reported; 1: it fails the release. Set 1 after verify has passed by hand on this host |
| `CD_PROOF_MODE` | `0` | the only value a host runs on; 1 is for the proof run and shows in every status line and mail |
| `CD_ALIVE_HOUR` | `8` | the hour of day (host time) of the daily `alive` mail |
| `CD_API_BUDGET_PER_HOUR` | `30` | GitHub API calls the program may spend per hour |
| `CD_MAX_BATCH` | `50` | the most commits one release may carry; a bigger batch is held |
| `CD_WALKBACK` | `10` | how far back the walk over the main branch goes for a green commit |
| `CD_PENDING_MAX_MIN` | `90` | how long a pending CI run is waited for |
| `CD_QUIET_WINDOWS` | `01:45-03:15` | windows (`HH:MM-HH:MM`, comma separated, host time) in which no release starts |
| `CD_LOCK_SPAN_MIN` | `60` | minutes of host-lock time after which the `released` mail notes that the lock was held long |
| `CD_LOCK_SPAN_MAX_MIN` | `180` | the worst-case host-lock span the timer guard plans for; it must not be below the floor (see [Locks](#locks-the-timer-guard-and-the-reboot-case)) |
| `CD_BACKUP_MAX_MIN` | `90` | the longest the nightly backup is taken to run |
| `CD_PURGE_MAX_MIN` | `5` | the longest the daily purge is taken to run |
| `CD_LOCK_WAIT_S` | `300` | seconds a command waits for the host lock before it reports busy |
| `CD_MIN_FREE_GB` | `15` | free disk below which no release starts |
| `CD_BUILD_CACHE_KEEP_GB` | `12` | the build cache kept after a prune |
| `CD_BUILD_TIMEOUT_MIN` | `60` | minutes one image build may take |
| `CD_BUILD_RETRIES` | `2` | how often an infrastructure failure of a build is retried |
| `CD_DUMP_POLICY` | `always` | what is dumped before a release changes a database; `always` is the only value accepted |
| `CD_MODULE_UPGRADE_TIMEOUT_S` | `900` | seconds the module step may take |
| `CD_LEAF_MIGRATE_TIMEOUT_S` | `600` | seconds one leaf service's migrate-only run may take |
| `CD_WATCH_MINUTES` | `20` | minutes of observed time the new colour is watched |
| `CD_WATCH_INTERVAL_S` | `15` | the sample rhythm |
| `CD_SAMPLE_TIMEOUT_S` | `12` | the bound of one sample |
| `CD_PAUSE_MAX_MIN` | `15` | the longest a shared outage pauses the watch |
| `CD_FAIL_SAMPLES` | `3` | consecutive samples with a failed readiness probe that roll the release back |
| `CD_5XX_WINDOW_S` | `300` | the window of the 5xx rule |
| `CD_5XX_MIN` | `10` | the least number of 5xx answers in that window that can trigger the rule |
| `CD_5XX_FACTOR` | `3` | the factor over the live colour's baseline rate |
| `CD_BASELINE_S` | `3600` | seconds of the live colour's traffic the baseline is taken over |
| `CD_STALL_MINUTES` | `360` | minutes without a poll verdict after which the watchdog mails |
| `CD_COMMIT_MAX_MIN` | `30` | minutes the commit point may retry before the release is rolled back |
| `CD_POST_ROLLBACK_S` | `180` | seconds the old colour is watched after a rollback |
| `CD_RECONCILE` | `1` | 1 reconciles every customer once a release is committed; 0 skips the stage and the mail says so |
| `CD_RECONCILE_TIMEOUT_S` | `300` | seconds one customer may take |
| `CD_RECONCILE_MAX_MIN` | `20` | minutes the whole stage may take |
| `CD_RECONCILE_LOCK_WAIT_S` | `120` | seconds one customer waits for the host lock |
| `CD_POST_RECONCILE_S` | `120` | seconds the public edge is probed after the stage ends |

The operator values are checked on every load; the tunables are whole numbers (or `0` and `1`)
with the minimum the parser enforces, and `CD_LEAF_MIGRATE_TIMEOUT_S` is not accepted below 60.

## Holds

A hold is a fact in the state: the tick does not start a release while one stands. `status` shows
it with its reason and age. "Held" means the phase is `idle` or `parked` and the hold is set.
Every kind has a named way out.

### Hold kinds

| Kind | Set by | Way out |
|---|---|---|
| `operator` | `gremion-cd hold` | `resume` |
| `blocked` | a rollback or a failure that the commit caused; the commit is added to the block list | `release-now <sha12>` of a candidate that fixes it, or `resume --accept-descendants --reason TEXT` (see below) |
| `state_tier` | the classifier: the release changes the compose state project, the edge, a host program, shared SQL or the platform database chain | `release-now <sha12> --with-state` (see the platform migration case in [Hand procedures](#hand-procedures)) |
| `unsupported_chain` | the classifier: a new file in a migration chain no runner of stage 1 applies, or a changed `runtime.database` declaration of a module | a hand upgrade, then `adopt --re-adopt --reason TEXT` |
| `contract_migration` | the classifier: a contract-phase migration file | a hand upgrade, then `adopt --re-adopt --reason TEXT`; it cannot be waived |
| `waived_migration` | the classifier: the new tree carries a migration-lint waiver (`scripts/migrations/runner/lint-waivers.json`) that the live tree does not | a hand upgrade, then `adopt --re-adopt --reason TEXT`; it cannot be waived |
| `ci_changed` | the classifier: the range changes `.github/workflows` | `release-now <sha12>` |
| `chain_class_changed` | the classifier: the class of a migration chain differs between the live tree and the new tree | `release-now <sha12>` |
| `batch_too_large` | the pick-up: more than `CD_MAX_BATCH` commits | `release-now <sha12>` |
| `not_ancestor` | the pick-up: the candidate does not descend from the live release | fix the cause; it cannot be waived |
| `ruleset_missing` | the pick-up: the branch rules are not in force | restore the rules; the next tick goes on once they hold |
| `range_unverified` | the pick-up: a commit of the range is not accounted for by a merged pull request | `release-now <sha12> --accept-range --reason TEXT` after reading the commits the mail names |
| `classify_failed` | the classifier could not judge the tree | fix the cause; a later clean candidate ends it |
| `failure` | an infrastructure or host-configuration failure, a parked watch (`watch_pause_cap`), a leaf-step timeout, a commit step given up after the commit point, or the retry budget | fix the cause, then `resume` (after `adopt --re-adopt` if the host was changed by hand) |
| `proof` | a proof release ended its window clean and was rolled back (rule `proof_end`) | `resume` |
| `rollback_failed` | the rollback sequence did not complete | repair by hand, `adopt --re-adopt`, then `resume` |
| `killswitch` | the kill switch aborted a release before its switch | remove the file, then `resume` |
| `stuck_stage` | a stage was started three times and never finished | `resume` once the cause is fixed |
| `reconcile_failed` | the reconcile stage ended with a customer not ok, or was cut short | `gremion-cd reconcile`, or `resume` after a hand reconcile |

**Classifier holds are the verdict on the newest candidate.** `resume` does not clear them: it
would classify the same tree again and hold again at the next tick. A classifier hold ends when
`release-now` commits the candidate, or when a later commit removes the cause (every tick
classifies the newest candidate again), or, for `unsupported_chain`, when the operator upgrades
the host by hand and runs `adopt --re-adopt`.

**A block** is added for every failure that the commit caused. Automatic pick-up stops for all
commits, because every later commit contains the bad one. A plain `resume` is refused while a block
is open. The operator either releases a fix with `release-now <sha12>` (the blocks it contains are
closed as superseded when it commits), or closes every open block with `resume
--accept-descendants --reason TEXT` (logged and mailed), after which pick-up continues with the
next commit. The blocked commit itself is refused unless `release-now` is given `--force-blocked`.

### What release-now waives

| Hold on the candidate | Bare `release-now <sha12>` | With a flag |
|---|---|---|
| `blocked` | takes a candidate that contains the block; closes the blocks when it commits | the blocked commit itself needs `--force-blocked` |
| `ci_changed`, `batch_too_large`, `chain_class_changed` | takes it | none needed |
| `range_unverified` | refused | `--accept-range --reason TEXT` |
| `state_tier` | refused | `--with-state` |
| `unsupported_chain`, `contract_migration`, `waived_migration` | refused, not waivable | none: a hand upgrade, then `adopt --re-adopt` |
| `not_ancestor`, `ruleset_missing`, `classify_failed` | refused, not waivable | none: fix the cause |
| `operator`, `failure`, `proof`, `rollback_failed`, `killswitch`, `stuck_stage`, `reconcile_failed` | refused | `resume` first |

`--ref BRANCH --unverified` works only in proof mode (`CD_PROOF_MODE=1`); a proof release names a
full 40 character id.

### Block rules

The rule is the reason a block was written; `status` lists the open ones.

| Rule | Written when |
|---|---|
| `build_failed` | the image build failed for a reason of the commit |
| `migrate_failed` | a migration step failed: the kernel one-shots, the module step or the leaf step |
| `start_failed` | the new colour did not start or did not get healthy |
| `readiness_failed` | a readiness gate failed before the switch |
| `isolation_failed` | the isolation evidence of the new release failed |
| `verify_failed` | verify failed while `CD_VERIFY_ENFORCE` is 1 |
| `post_switch_verify` | the switch call failed after `switch_started` |
| `watch_readiness` | `CD_FAIL_SAMPLES` consecutive samples failed the readiness probe |
| `watch_crash` | a container of the new colour restarted twice or more beyond its baseline |
| `watch_5xx` | at least `CD_5XX_MIN` 5xx answers in the window and `CD_5XX_FACTOR` times the live colour's baseline rate |
| `watch_pause_cap` | a shared outage paused the watch for `CD_PAUSE_MAX_MIN` while the old colour was ready and the new one was not |
| `manual_rollback` | the operator's `gremion-cd rollback` |

### Rollback rules that write no block

| Rule | Written when |
|---|---|
| `proof_end` | a proof release's window ended clean (the hold is `proof`) |
| `commit_stuck` | steps 1 to 5 of the commit point did not finish within `CD_COMMIT_MAX_MIN` |

## Kill switch

The kill switch is the file `etc/cd.disabled`. While it exists the program does not poll, does
not start a release and does not roll back by itself. Create it with `touch` and remove it with
`rm`; there is no verb.

- A tick with nothing in flight exits 0 and mails once that the kill switch is on.
- A release that has not switched is aborted and torn down at the next stage boundary, with the hold
  `killswitch` and no block.
- A release that has switched but not committed is **parked in place**: the process stays alive,
  keeps the cd lock and the host lock, keeps the new colour serving, stops evaluating triggers,
  keeps its heartbeat and looks every 15 seconds for the file to be gone (the watch resumes where
  it was) or for an operator `rollback`. No unit timeout ends it. A critical mail says that
  automatic rollback is off and that the host lock is held, and it repeats every hour for as long
  as the release stays parked. The cost is the one every release has: the executor waits.
- `status`, `gremion-cd rollback` and the watchdog keep working. The watchdog reminds once a week
  while the file exists.
- A committed release in its reconcile stage is the exception: after the commit point there is
  nothing left to protect, so the stage stops at the next customer, the remaining customers are
  `skipped` with reason `killswitch`, and the hold is `reconcile_failed`.

If the CD process itself is killed in the middle of a release, both locks are free until the next
tick (at most five minutes) takes them again. In that gap the executor could run one customer
operation from the old tree against the new schema. Stage 1 narrows this (the boot unit, the
five-minute tick) and does not close it.

## Locks, the timer guard and the reboot case

Two locks. `runtime/cd/cd.lock` allows one `gremion-cd` process. `runtime/hostd.lock` is the host's
mutating lock, shared with the executor, backup, purge and the Karenz runs. A release takes the
host lock at `snapshot` and holds it until the commit point, including the whole watch, and never
gives it back between commit retries. The reason: customer operations run from `current` while the
new colour already serves the migrated schema, and `current` moves only at the commit point. The
cost: customer operations from the panel queue (the executor claims nothing while the lock is
held), and the nightly backup, the purge and the hourly Karenz run exit 3 if they meet it.

The lock is let go earlier only when the release ends before the commit point (a teardown or a
completed rollback) or when the phase becomes `parked`. A `rollback` request is drained by the process that holds the locks, within one sample;
a `rollback` that meets a process holding only the cd lock, or nothing, takes the host lock first
and waits up to `CD_LOCK_WAIT_S`.

**The timer guard.** Before it takes the host lock, `snapshot` asks whether a span of
`CD_LOCK_SPAN_MAX_MIN` minutes from now would overlap the next elapse of the backup timer or the
purge timer, each widened by its longest run (`CD_BACKUP_MAX_MIN`, `CD_PURGE_MAX_MIN`). If it
would, the release waits for the next tick: that is waiting, not a failure. If the timers cannot
be read, the answer is "unknown", which is also a stop. The reconcile stage asks the same question
before each customer, with the cap of one child plus a minute.

**The Karenz exception.** The hourly Karenz run (minute 17) cannot be avoided by a span of this
length and is not guarded. It exits 3 if it meets the held lock and runs again an hour later.

**The lock span default.** `CD_LOCK_SPAN_MAX_MIN` is 180. It must not be below the sum of the stage
caps that run under the host lock: the module step, three leaf runs, the two kernel one-shots, one
60-second kill confirmation for every container-running step and service, the watch, the longest
pause, the commit, and a fixed allowance of 30 minutes for dump, start and gates. With the
defaults that is a floor of 166 minutes. The dump precheck and `selftest` both refuse a value
below the floor, naming it.

**Reboot.** `gremion-executor` starts at boot, and CD's own timer starts three minutes later.
`gremion-cd-resume.service` runs `gremion-cd tick --resume-only` before the executor: when a
release was in flight it takes the host lock first and runs the release to its end in that very
process, so the executor's start waits; in any other phase it exits at once. Under the kill switch
it parks, holding the lock. Two exceptions after the commit point: a release committed and in the
`commit` stage has its steps 6 to 8 finished and is then ended with the hold `reconcile_failed`
(reason `interrupted`) without running the stage, and a release in the `reconcile` stage is ended
the same way at once. The watch's observed time ignores the gap of a reboot, and the first two
samples after a resume are never a trigger.

## Rollback

**What it does.** One sequence, resumable, for an automatic and a manual rollback:

1. record the rule and the time, phase `rolling_back`;
2. make sure the old colour is serving or startable: it is started from its own tree, env file
   and tag when its project is not all running and healthy. A colour that the traffic truth
   still names as serving, which is the old colour of a rollback before the switch, is never
   started: the sequence waits for it to be healthy for up to 180 seconds, and a colour that
   does not get healthy ends the rollback (`old_unhealthy`). A colour that was retagged for a
   later release is not startable;
3. prove it is the old release: image identity, three consecutive internal answers naming the
   old colour and release, the portal list page (the old image must read the migrated schema),
   and the ready answer through the next route;
4. switch traffic back from the old tree, three tries; a switch the router already shows as done is
   not written again. Three failures end in `rollback_failed`, a critical mail, and the new colour
   is **left running**;
5. confirm all services and the public ready probe, then watch the old colour for
   `CD_POST_ROLLBACK_S`; a bad streak there is a critical mail (`rollback_failed`, note
   `unhealthy_after_rollback`) and nothing else;
6. switch the new colour's worker gate off, then the old colour's on;
7. stop the new colour (keeping a 0600 tail of its log), put the env tag back, write the block and
   the hold, move `current` and the tag files back when they had moved, record the isolation
   evidence of the old tip again when the new tip had been recorded (a committed release, and a
   `commit_stuck` rollback; a failure there is only a mail), and queue the `rolled_back` mail.

**What it does not undo.** Databases are never restored. A rollback leaves every migration that
ran in place: the old colour has to live with the new schema, which is what the expand-only rule of
the migration chains is for. After a module-step rollback there is one further consequence: the
old image's runner rejects the ledger rows of a file it does not carry, so a customer who switches
a module off and on again within the Karenz period, while the old colour serves, gets a failed
restore, the database stays blocked, and the module stays off until a release that carries the file
is live. The enable catch-up of the new image does not help on the old colour.

A rollback that is asked for a committed release is refused for every rule except
`manual_rollback`, with nothing touched. After the commit point `gremion-cd rollback` goes back one
release and only when `previous` is startable; otherwise use `gremion-rollback` by hand, then
`gremion-cd adopt --re-adopt --reason TEXT`.

**The watch rules.** Each sample checks the public `/readyz` through the real edge, the internal
`/readyz` of the new colour (ready, the right colour and release, and not more customers not ready
than the live colour had), the routing test, image identity, the portal list page and the
containers. Before any rule fires, a sample asks whether a shared service (the state project, the
edge, docker) is down: if so the observed clock stops, the paused clock runs, and one mail says
`paused`. At the pause cap the release is rolled back when the old colour is ready and the new
one is not, and parked otherwise. A reboot, a slow sample and a 5xx window that overlaps an
outage are not counted against the release.

## Dump set

Before the migrate stage the program takes one dump per database that a release could change, into
the dump directory (mode 0700, owned by the deploy user, never printed, never mailed: only sizes and
labels are). It is taken by `gremion-migration-dump take`, one database at a time, under a ledger
that refuses a second live label.

**What is in it.** On the main database server: every database except the maintenance database and,
for an application release, the login server's database. That includes `control`, the gremion
database, `gremion_platform`, and one kernel database per customer; a customer registered as active
without a kernel database in the listing is a refusal, and so is a listing that lacks one of the
three platform databases. On each module database server that the release tree declares and that is
running: every database, which means the module's gate databases for customers who have the module
enabled, and the leaf services' own per-customer databases. An enabled gate database whose server
is not running is a refusal.

**What it leaves out, and why.**

- A gate database whose state is `blocked` (the customer switched the module off and the Karenz
  period runs) or `dropped`. Releases never touch a blocked database, so it is unchanged since its
  verified export, and that export is an equivalent restore point. The module step skips it too.
- The login server's database in an application release. A state-tier apply takes it, under the
  label `state-<tag>`, and never takes a module server.
- The data of the messaging, governance and file-sync servers, and chat media and shared files. No
  local dump covers them. This is an accepted gap: their protection is the nightly backup, and a
  release does not migrate them.

**Lifecycle.** The set is kept from `snapshot` to commit step 6, then deleted. It is not kept longer,
because a live set blocks every other dump (the ledger allows one label at a time), including the
member import. The nightly backup is the longer restore point.

**The discard rule.** A rolled-back release's set stays live until the operator decides: a restore
by hand, or `gremion-cd resume --discard-dump`, which logs the discard. While a set is live no
release starts and `status` says why. A release that failed before its switch does not hold the host
lock any more, so its set stays live and the executor can still switch off a gate database that was
`enabled` when the set was taken. That database is then blocked with a live dump of the failed
release: its switch-on refuses with `DUMP_SERIES` until the set is discarded. The discard is safe for
it, because the verified export of its switch-off is an equivalent restore point. The day-30 job
that drops a blocked database after its Karenz period retires a live migration dump of that database
itself.

**Who writes the files.** The dump directory is written by `gremion-migration-dump` as the deploy
user. The tenant-create one-shot runs as root, so it is told the directory's owner through
`GREMION_MIGRATION_DUMP_OWNER_UID`: a root process is accepted only on a directory that exactly that
uid owns, and it hands every file it writes to that uid. The files are the deploy user's, so the
program can retire them.

## Module step

After the two kernel one-shots, still in the migrate stage, the module step runs
`tenant-create module-upgrade --all` as a one-shot of the target colour, under the label
`gremion.cd=<release id>`. It opens the gate database of every customer that has a module enabled,
as the owner role, applies the pending files of the module's migration chain, re-grants the app
role, and stops at the first failure. Its output is one JSON line of counts (total, upgraded,
unchanged, skipped, failed, files applied); the counts are in `status` and in the mails, the names
never are.

- It only runs for databases that were in a live dump of this release. A missing ledger line is a
  refusal, not a skip.
- It does not touch a blocked or half-enabled database. A blocked one is counted as skipped.
- It is bounded by `CD_MODULE_UPGRADE_TIMEOUT_S`; on a timeout the program kills the container by its
  label and confirms it gone before it returns. A timeout is a stop on the host's side (the hold
  `failure`), not a block.
- A failure is a `migrate_failed` block with the detail `module_upgrade`; exit 3 of the one-shot (a
  connection error before any change) is an infrastructure failure, retried, not a block.
- Only chains of the class `module-upgrade` are applied. A file in a chain of the class `unadopted`
  or `fresh-only` is held as `unsupported_chain`.

**The enable catch-up.** A customer who switches a module on again inside the Karenz period gets the
blocked database back, and the release may have moved on. So `enableModule` applies the pending
files before it unblocks: it first dumps that one database (the dump is of that database only, taken
once, before the first change, and not at all when nothing is pending), applies the files, and
unblocks it. The dump is retired when the enable commits. If the dump, the apply or the
unblock fails, the database stays blocked, nothing is half applied, and the dump stays live as the
restore point; that live dump makes the next release's snapshot refuse, so the next release is held
with the reason `failure`, naming the discard command. The operator discards after fixing, or the
day-30 job retires it when it drops the database.

## Leaf step

The calendar, content and publishing leaf services keep their customers' data in databases of their
own, which the module step does not reach. Before the new colour starts, the host runs one
`node dist/index.js --migrate-only` container per leaf service of the target colour, with the
label `gremion.cd=<release id>`, and only when every leaf database has a live dump of this release.
The entry goes through every catalogued customer inside the one container (the host never loops
over customers and never sees a name), runs the leaf's own migration runner on each existing
database, prints one JSON line of counts (`total`, `migrated`, `skipped`, `failed`) and exits. It
starts no web server, no scheduler and no message client, creates no database and no control
database, and takes no customer argument. The counts are in `status` and in the mails.

**Exit codes of the entry.** 0 ok, 1 a migration file raised SQL or its hash differs from the
manifest, 2 usage, a missing connection variable or a refused login, 3 a connection that was refused
or dropped before any change, a lock wait that timed out, or a catalog race that persisted. The host
maps them: 1 is a `migrate_failed` block with the detail `leaf_migrate`; 2 is a host precondition;
3 and anything else the entry cannot answer is an infrastructure failure (reason `leaf_infra`):
retried later, no block.

**The lock wait is bounded.** Each customer database is migrated under a session advisory lock on
its own connection, so two entries on one database run one after the other. The wait for that lock
is bounded: the connection carries a lock timeout of 60 seconds and a statement timeout 5 seconds larger, so a stuck holder ends the wait and the entry exits 3 instead of hanging the step. The
customers after the stuck one are still migrated. The host also bounds the whole run with
`CD_LEAF_MIGRATE_TIMEOUT_S`; on a timeout it kills by label and confirms the container gone, and the
release stops with the hold `failure` and the reason `leaf_timeout` (not a block). A container that
cannot be confirmed gone leaves the reason `leaf_container_alive`, and the teardown waits so no
change runs beside it.

**The scheduler's first-contact migration is redundant and ordered after.** The new colour starts
only after the step has ended, so the leaf scheduler's first tick (within about a minute of the
leaf starting) and any later cold start of a customer's pool run the same idempotent files on a
database that already has them and change nothing. If the step fails, the release stops before `start`, so no
scheduler ever migrates a half-migrated set.

**The race with the old colour.** The old colour keeps serving during the step, and its leaf runs
every old migration file on a cold start with no advisory lock. Two consequences, each with a
defence. Concurrent `IF NOT EXISTS` statements can raise a catalog-race error in the entry or in the
old runner: the entry retries it up to three times, two seconds apart, per database, and when it
persists it counts the database as failed and exits 3, so a race is never recorded as a commit
failure. And an old file that runs after a new file redefined the same object would revert the new
body during the overlap: a lint (`scripts/leaf-migration-lint.test.mjs`) forbids a new leaf file from
redefining an object that an older file of the same leaf creates.

**What the step does not cover.**

- A leaf customer created after the step ran: its database is created and migrated by the new
  colour's scheduler at first contact, with no dump of its own.
- A leaf whose compose profile is off on the target colour: it is not in the step.
- The leaf databases of a customer whose module is switched off are still migrated: the step goes
  through the leaf's own catalogue, not through the module's enablement.
- A leaf whose scheduler is switched off migrates at first contact after the commit, with no dump, and
  a failed first-contact tick is only logged.

**The overlap of two schedulers.** From the new colour's `start` until the old colour is stopped at
the commit, both colours' leaf schedulers run (the worker gate reaches only the main application).
Whether a duplicate dispatch is prevented, leaf by leaf, read from the code:

- **Newsletter (publishing leaf): prevented.** `claimNewsletterForSending` is one atomic update that
  only succeeds when the status is neither `sending` nor `sent` (`modules/publishing/src/store/newsletters.ts`,
  lines 178 to 187), and each recipient is claimed once through `claimRecipient`
  (`modules/publishing/src/store/deliveries.ts`, line 52): a recipient already `sent` is never sent
  again, a live claim is skipped. A crash between send and record leaves a claim that is taken over
  after 15 minutes, so the guarantee is at most once per live claim, at least once after a crash
  (`modules/publishing/src/dispatch.ts`, lines 33 to 48). The pass that loses the newsletter claim
  returns at once, with no status written and no event queued (`modules/publishing/src/dispatch.ts`,
  line 531).
- **Content (scheduled publication): prevented per recipient, not per post.** The scheduler does not use
  the whole-post claim (`claimPostForPublish`, `modules/content/src/store/posts.ts`, lines 199 to 208:
  that belongs to the publish request of the API). It lists the due channels with a plain select
  (`listDueScheduledChannels`, `modules/content/src/store/posts.ts`, lines 242 to 262) and publishes
  each one through `publishChannel` (`dispatchDueChannels`, `modules/content/src/scheduler.ts`, lines 245
  to 300), so both
  schedulers can take the same due channel. For e-mail every recipient is claimed first through
  `claimDelivery` (`modules/content/src/store/deliveries.ts`, line 74; used at
  `modules/content/src/publish-channel.ts`, line 305): the pass that loses a recipient skips it as
  already sent or in flight, so no recipient is mailed twice while a claim is live (a claim that is
  older than 15 minutes is taken over). No recipient is mailed twice by either pass, but the losing
  pass does not stay silent. What it reports is read from `publishChannel`
  (`modules/content/src/publish-channel.ts`). A pass that finds every recipient in flight has
  delivered nothing, so it takes the all-failed branch (lines 455 to 468): `flagChannelFailed` writes
  the channel status `failed` and the result says `all sends failed`, although no send failed. If the
  other pass finishes after that, its own finish writes `sent` again, so the status is wrong for a
  short time; if the other pass dies, the channel stays `failed` until it is published again. A pass
  that finds only recipients that are already sent, or already sent and in flight, and has no failure
  of its own, takes the success branch (lines 488 to 498). The caller then writes the status `sent`
  and queues a second `channel.email.sent` event, with a delivered count of 0, beside the event of the
  winning pass (lines 202 to 211). So during the overlap a consumer of that event can see it twice for
  one post, and a channel can read `failed` for a moment. Portal publication is idempotent at the
  kernel by the post's origin id (`modules/content/src/publish-channel.ts`, header).
- **Content (Instagram queue): not prevented, and dormant.** `drainPublishOps` is a plain select
  with no claim (`modules/content/src/store/publish-ops.ts`, lines 128 to 139), so two schedulers can
  read the same pending operation. With no credentials, which is the default, every operation is
  marked failed with no network call (`modules/content/src/instagram/drain.ts`, header). The residual
  is real only once the channel is activated.
- **Calendar (CalDAV push): not prevented, harmless in effect.** `listPendingCaldavSync` is a plain
  select (`modules/calendar/src/store/caldav-queue.ts`, lines 56 to 67), so both schedulers can push
  the same queue entry. The two wire calls are idempotent: a push is a PUT to a path derived from the
  event's uid, which replaces (`modules/calendar/src/caldav/pusher.ts`, lines 91 to 113), and a delete
  treats 404 and 410 as success (same file, line 139). The one visible effect: a failing entry can
  count an attempt in both schedulers, so it reaches its limit of three attempts sooner
  (`recordCaldavSyncFailure`, `modules/calendar/src/store/caldav-queue.ts`, lines 74 to 81, and
  `modules/calendar/src/caldav/sync.ts`, line 28).
- The outbox relays of all three leaves lock their rows with `FOR UPDATE SKIP LOCKED`
  (`outbox.ts` of each leaf), so an event is published once.

## Reconcile after the commit point

After the commit point, the stage runs once for the release: for each customer, with a canary first (the
customer the probe host belongs to) and the rest in sorted order, one `gremion-tenant reconcile` child
under the host lock, which is taken and freed for every customer, with a fresh request id and a kill
by label after every child. After each customer the public edge is probed, and after the stage it is
probed for `CD_POST_RECONCILE_S`. The stage is bounded per customer by `CD_RECONCILE_TIMEOUT_S`, as a
whole by `CD_RECONCILE_MAX_MIN`, and each customer waits at most `CD_RECONCILE_LOCK_WAIT_S` for the
lock. The kill switch and a `rollback` request are looked at between two customers.

- **It never rolls back and never blocks.** The release stays committed whatever happens here. A stage
  that stops on its canary, a timeout, a busy lock or a failed probe leaves the hold
  `reconcile_failed` and a mail, and `gremion-cd rollback` is the operator's way back.
- **Slugs.** The customer slugs are read from the registry into the process and kept there. They
  reach no state file, history line, log, mail or command line of CD's own; only the child's argument
  carries one.
- **Access-record rows.** Every reconcile call writes one row into the vendor access record of the
  platform database before it acts, and a customer whose row cannot be written is not reconciled. The
  council administrator of that customer reads the row in the product. The row names the deploy user
  as actor and holds one fixed German sentence of the verb plus a reason constant of the stage:
  `Automatischer Abgleich nach dem Release <tag> (gremion-cd)`. The tag is public. So every release
  adds one visible row per customer, and a retry, a re-run by `gremion-cd reconcile` and a call by
  hand add rows of their own: the number of rows per customer is the number of committed releases plus
  the number of re-runs and hand calls.
- **Counts.** `status` and the `reconciled` or `reconcile_failed` mail carry total, ok, failed,
  skipped and seconds, never a name.

## Mail and dead-man signals

The program sends mail through the relay only, to the single address `CD_MAIL_TO`. A mail is built
from an allow-list of fields, each checked against the shape of its field; a value that does not
match is written as `<redacted>`. The queue is `data/cd/outbox/`; a send that fails stops the pass and
keeps every unsent file for the next flush. A mail never delays a rollback. The notifier sends at most
20 mails an hour and 60 a day, and says so with a `summary` mail when it holds mails back.

### Mail kinds

| Kind | Sent when |
|---|---|
| `released` | a release is committed: counts of modules, leaves, requests, timing and the dump size |
| `rolled_back` | a release was rolled back, with the rule and the one command to read |
| `rejected` | a release stopped before its switch because of the commit, and a block was written |
| `held` | a candidate is held, once per candidate, with the one command that applies it |
| `stopped` | a release stopped for a reason that is not the commit's (infrastructure, host, a stuck stage) |
| `paused` | the first paused sample of a shared outage during the watch |
| `parked` | the pause cap was reached and the release is parked |
| `stalled` | the watchdog found the program stuck, silent or unable to mail |
| `alive` | the daily digest, once per day after `CD_ALIVE_HOUR` |
| `rollback_failed` | the rollback did not complete, or its target is unusable, or an operator rollback was refused |
| `killswitch` | the kill switch is on: once when idle, every hour while a release is parked, and weekly from the watchdog |
| `adopted` | `adopt` or `adopt --re-adopt` ran |
| `proof_on` | proof mode is on |
| `selftest` | the result of a self-test run |
| `reconciled` | the reconcile stage ended with every customer ok |
| `reconcile_failed` | the reconcile stage ended with a customer not ok or was cut short |
| `summary` | the mail caps held mails back |

In proof mode every subject carries `[PROOF]`.

### The dead-man signals, and how to read their absence

The watchdog runs on its own timer every ten minutes, in a unit separate from the tick it watches,
and it does not load the pick-up or the pipeline: the dead-man check does not live in the code it
watches. Its liveness checks read only the heartbeat file, a probe of the cd lock, the age of the
oldest queued mail, `data/cd/ALERT` and the kill switch, never the state file, so an unreadable
state is itself an alert (`stalled`, detail `state_unreadable`), never a silence.

A `stalled` mail carries a detail: `no_heartbeat` and `heartbeat_unreadable` (the heartbeat file is
missing or not a heartbeat), `no_tick` (no process holds the lock and the heartbeat is older than
three timer intervals), `release_stuck` (a process holds the lock but its beat is older than three
minutes), `release_over_budget` (a stage ran past its budget), `state_unreadable`, `poll_stale` (the
last successful poll is older than `CD_STALL_MINUTES` while the remote shows a new tip), `main_red`
(the main branch has been red for six hours) and `outbox_old` (a queued mail is older than an hour:
the mail path is dead, so no mail can say so) and `alert`.

What the absence of a signal means:

- **No `alive` mail for a day** (kill switch off): the tick, the mail path or the host is down. It is
  the first thing to look at, because every other signal depends on the same mail path.
- **The off-host ping** (`CD_PING_URL`) is called once at the end of each successful tick. Point it at a
  service that alerts when pings stop: that is the only signal that does not need this host's mail path.
- **`data/cd/ALERT`** is written by a fatal exit or by a mail path that cannot send, together with a
  line to the system journal. While it exists a release on the relay transport does not start.
  `status` shows it.
- **A silent timer** shows in `systemctl list-timers` and in `status` ("next timer"). A silent timer
  and a healthy-looking `status` is the case the ping is for.

## Adoption

Adoption is done once, by hand, on the live host. Nothing is enabled until the last step.

1. Merge the stage 1 change set. The first release that contains the program, its libraries, its units,
   the `cd` bootstrap stage, the `/readyz` path and the worker gate is the first release under CD.
2. As root, create the worker gate directory: `install -d -m 755 -o <deploy user> -g <deploy user>
   /opt/gremion/runtime/workers` (the compose file bind-mounts it, and a missing bind source is
   created root-owned by docker; the `cd` stage repeats this idempotently). Then bring the host to
   that release with the host's own upgrade procedure and its switch step, so that the release is the
   live colour and answers ready on `/readyz`: it becomes the first rollback target. The procedure
   that does this is the pilot host's own and is not carried in this repository.
3. As root, run `bash /opt/gremion/current/infra/host/bootstrap.sh cd`. It installs, as real files, every
   host program of `bin/`, `lib/common.sh` and `lib/cd/*.sh` (the apply script is root-owned), renders
   the six systemd units (`gremion-cd.service` and `.timer`, `gremion-cd-watchdog.service` and
   `.timer`, `gremion-cd-resume.service`, `gremion-cd-apply@.service`), creates `data/cd`, `runtime/cd`
   and `runtime/workers`, and writes `etc/cd.env` from the template when it is absent. It enables and
   starts nothing.
4. Edit `etc/cd.env` as the deploy user: `CD_REPO_URL`, `CD_MAIL_TO=<operator address>`,
   `CD_HOST_LABEL`, `CD_PROBE_HOST`, `CD_POLICY_ACK=<agreement date>` (the date the council agreed to
   continuous upgrades, see [the amendment](#release-cadence-amendment)), and optionally
   `CD_GITHUB_TOKEN_FILE` and `CD_PING_URL`. The branch rules (squash only, linear history, the four
   rules of the protected branch) must already be in force: `adopt` and `selftest` check them.
5. `gremion-cd adopt`. It reads the truth from the running system: the active colour (the file and the
   router must agree), the image of every first-party container against the colour's env tag, the
   release tree `releases/<sha12>` (a clean checkout whose head is that commit), the `current` link,
   the public `/readyz`, and the other colour's tag and tree (so `previous` is startable or recorded as
   absent). It refuses on any mismatch, refuses when the state file exists, and writes `state.json` and
   `host-manifest.json`.
6. `gremion-cd selftest`. It checks the config, the state schema, the dump directory (a plain
   directory, mode 0700, owned by the deploy user), the lock span against its floor, the mirror, one
   `git ls-remote`, the branch rules and merge methods, docker, disk, both locks, that the probe host
   resolves and maps to an active customer, the timers of the timer guard, the mail transport, a
   test mail to `<operator address>`, and the ping once.
7. By hand, run `gremion-verify`. When it is green, set `CD_VERIFY_ENFORCE=1`.
8. `sudo systemctl enable --now gremion-cd.timer gremion-cd-watchdog.timer` and `sudo systemctl enable
   gremion-cd-resume.service`.

Before any release starts, the program also needs `CD_POLICY_ACK`, a working relay, and no `ALERT`
file. The first real release is a good moment to watch: `gremion-cd status` in one terminal and the
mails in another.

## Applying host programs and the state tier in a window

A release that changes any file of the host manifest (every host program, `lib/**` including
`lib/cd`, `bootstrap.sh`, the systemd, nftables and env templates) is classified `state_tier` with the
reason `host_programs` and held; so is a change of the compose state project, the edge, shared SQL or
the platform database chain. The operator applies it in a window, with `gremion-cd release-now
<sha12> --with-state`:

- The deploy-user side copies the installed host programs to `data/cd/host-backup/<time>/` (a real
  directory under `data/cd`, mode 0700, never a symlink) and points `data/cd/host-backup/pending` at
  it.
- It then runs `sudo -n systemctl start --wait gremion-cd-apply@<sha12>.service`. The apply is not
  done inside `gremion-cd.service`: that unit protects `/etc`, and the units are written there. The
  apply unit is a root oneshot started only through `sudo -n systemctl start` by the deploy user, and
  its one command is `apply-root.sh <sha12>`.
- `apply-root.sh` validates the instance (twelve hex digits; `releases/<sha12>` is a real clean
  checkout whose head is that commit; the backup is sound and is the installed set), runs the `cd`
  stage of that tree's `bootstrap.sh` (files go in through a temporary file and a rename, so the inode
  a running shell holds is never changed), reloads systemd if a unit changed, and runs
  `gremion-cd selftest --post-apply` with the new installed program as the deploy user. The flag
  matters: `release-now` holds both locks, so a plain self-test would find them held and fail every
  apply; `--post-apply` asserts the opposite and sends no test mail.
- On any non-zero exit of any step it puts the backup back byte for byte (checked with `cmp`) and
  exits non-zero: half-installed is not an end state.
- Only on success does the deploy side rewrite the manifest. The old `apply-root.sh` is the one that
  runs the apply, so a change to it takes effect at the next apply.

The state-tier part (`state_apply`) takes the state dump set under `state-<tag>` first, records the
previous state tag, retags `state.env`, pulls and builds, renders, runs the platform step when the
release carries a platform migration, brings the project up and waits for it to be healthy and the
edge to answer. It is not rolled back automatically: the previous tag is kept for a hand restore.
Read the platform migration case in [Hand procedures](#hand-procedures) before you apply a release
that carries one.

## Hand procedures

### A release that carries a platform migration

A release with a new file in the platform database chain is classified `state_tier` with the reason
`platform_migration`, and `release-now <sha12> --with-state` is the command the mail offers. **The
pipeline cannot carry it.** The platform step of the state tier runs `gremion-tenant init` from the
release tree, and that command starts the one-shot of the *active* colour, from the image its env file
names. Until traffic has moved, the active colour is the old release, so the step would run the old
release's migrations and report success for work that never ran. The apply therefore refuses before it
changes anything, and every release the pipeline can reach is in that case (the state apply runs
before the new colour exists).

What you see: the release stops in `state_apply` with the message that the release carries a platform
migration, no dump set was taken (the refusal comes first), the hold is `failure` with the reason
`state_apply_failed`, no block is written, and the mail is `stopped`. The `host_apply` stage ran before
it, so the host programs of that release may already be installed; `status` shows no drift in that
case. After `resume`, the next tick classifies the newest candidate again and holds it again for the same
reason.

The hand procedure, in a window:

1. Hold automation so no tick starts a release while you work: `gremion-cd hold --reason TEXT`.
   (`touch etc/cd.disabled` also stops releases, but it is not quiet: an idle tick still queues the
   `killswitch` mail and the watchdog still sends its weekly reminder. What the kill switch turns
   off is the daily digest and the alarms for a poll that grows old and for a red main branch.)
2. Take a restore point for the platform database by hand: `gremion-migration-dump take --release
   pilot-<sha12> --db gremion_platform`, under the tag the new colour's env file will carry (that is
   the release reference the one-shots dump under). Check `gremion-migration-dump status` first: it
   refuses a second live label, so the host must have no other live set.
3. Bring the host to the release with the host's own upgrade procedure (the one used for the first
   adoption, see [Adoption](#adoption) step 2). It must leave the end state that the next step reads:
   the new release is the active colour, the colour's env file names `pilot-<sha12>`, its containers
   run that tag's images, `releases/<sha12>` is a clean checkout whose head is that commit, `current`
   points at it, and the public `/readyz` answers ready. Between steps 3 and 4 the new release serves
   traffic on a platform schema that does not yet carry its migration. The order is forced: step 4
   runs from the image of the active colour, so the new release must be active first. Go to step 4
   straight after the readiness check, and do not read a failure inside that interval as a verdict on
   the release. The expand-only rule protects the old release on a new schema; nothing in this
   repository says what the new release does on the old one.
4. With the new colour active, apply the platform migration with the call the state tier itself makes
   as its platform step: `gremion-tenant init`, run from the new release tree with
   `GREMION_RELEASE_DIR` naming that tree, so that it starts the one-shot of the active colour and runs
   the new image's migrations. The call does more than migrate: it renders the panel and one-shot
   secrets, creates or checks the ops realm, sets the ops realm's sender, and restarts the executor,
   and the upgrade runbook describes the refusals of its realm and governance parts. This repository
   does not say that a second run is harmless; the only evidence is that the state tier repeats the
   call on a retry. Run it once, read what it prints, and skip it only if your upgrade procedure has
   just run it.
5. Verify on the running system, not on the repository: `gremion-verify`, the public `/readyz`, one
   customer's login page.
6. `gremion-cd adopt --re-adopt --reason TEXT`. It needs `phase` idle or parked, re-reads the truth
   as `adopt` does, rewrites `live`, `previous` and the manifest, keeps the blocks, the history and
   the mail marks, and is logged and mailed (`adopted`).
7. `gremion-cd resume` to clear the hold you set. Then retire your hand dump with
   `gremion-migration-dump switched --release pilot-<sha12>`, or discard it.

A hand upgrade takes no CD watch window: nothing watches it for twenty minutes and nothing rolls it
back. Watch it yourself with `gremion-cd status` and `gremion-verify` for as long as a watch would
have taken. If you want the customers reconciled, `gremion-cd reconcile` does it (and adds one access
record row per customer).

### After a classifier hold that needs a hand upgrade

For `unsupported_chain`, `contract_migration` and `waived_migration` the pipeline will not apply the
release. When you apply it by hand, the module databases it migrates have no dump from CD, because the
dump set of a release is taken by the pipeline. The manual-dump marker that a new file of such a chain
carries names exactly this step, so take it: for each module database the release changes,
`gremion-migration-dump take --release pilot-<sha12> --db <database> --pg-service <service> --pg-user
<role>` (the label is the tag the colour's env file carries), where the service is the module's database server (a name ending in `-postgres`) and the role
is that server's superuser role (the two options come together or not at all). Then apply the files
with `tenant-create module-upgrade --all`, run as a one-shot of the target colour with the compose
shape the host fixes, `docker compose --env-file /opt/gremion/etc/env/app-<colour>.env run --rm
--no-deps -T tenant-create module-upgrade --all` from the release tree. Retire the dump with
`gremion-migration-dump switched --release pilot-<sha12>` once the switch has succeeded, then `adopt
--re-adopt --reason TEXT` and `resume`.

### The board declaration release and the freeze window

The classifier compares the new tree with the live tree and with the host manifest, and it compares
every module's `runtime.database` declaration. A change of that declaration (the board module's
declaration is the case that matters) is held as `unsupported_chain` with the reason
`module_declaration_changed:<module>`. It is not waivable: a hand upgrade, then `adopt --re-adopt`.
Afterwards the module's data is in a gate database like the other gate-database modules, and the
module step applies its chain.

**The freeze window.** A hold that comes from the host manifest, the state tier or a declaration is a
property of the newest candidate against the *live* release, and every later candidate contains the
change. So from the first merge of a change that touches a host program or template of the manifest, the
compose configuration of the state project or a module declaration, until the hand upgrade has been done and `adopt --re-adopt` has recorded it, CD
holds every candidate. Ordinary fixes merged inside the window are not lost: they ship in the first
release after it, because the first tick after the re-adopt classifies the newest candidate against the
new live release. Keep the window to one sitting. When a series of changes ends in such a release, the ones that touch only application code ship as
ordinary releases before it, and the one that changes the declaration comes last. The code cannot
tell the order in which a series is merged: the order is the series' own release note. The hand
upgrade of the last one takes no CD watch window, so the operator watches it by hand.

**A gap, named as one.** A customer's existing board rows are in its kernel database (the location
`kernel` of `board_location`), and the board module's README says the step that moves a board is
reserved: nothing at this base writes the location `moving`, and `gremion-ui/scripts/tenant-provision.ts`
has no verb that moves board rows. This document therefore names no procedure and no runbook for moving
existing boards in the hand upgrade of the declaration release. That procedure depends on the board
plan, which has to supply it; until it does, the hand upgrade of this release is the operator's own
work, and what it does to boards that already exist is not something this document can say from the
code.

### A change of a chain class

The class of a migration chain says which runner applies it (`tenant-store`, `legacy-boot`,
`module-upgrade`, `unadopted`, `fresh-only`). A pull request that changes a class, or adds a chain, is
held as `chain_class_changed` with the reason `chain_class_changed:<chain>`. The class is read from the
live tree and the new tree must agree, so a class flip never lands in the same release as its first file.
The operator takes it with a bare `gremion-cd release-now <sha12>`; the flip of the board chain to
`module-upgrade` is such a release.

### After any hand intervention

Anything done by hand to the colours, the tags, `current`, the host programs or the state project makes
`state.json` stale. `gremion-cd adopt --re-adopt --reason TEXT` is the way back to a true state. It
refuses while a release is in flight (exit 3), and it clears nothing but `live`, `previous` and the
manifest. Run it before `resume` when the hold's cause was fixed by hand.

## Proof

Proof mode exists to prove the mechanism on a host with one placeholder customer before the first real
one. `CD_PROOF_MODE=1` plus `CD_PROOF_REPO=<the absolute path of a local bare repository on the host>`
plus the flags `--ref BRANCH --unverified` of `release-now`: the proof commits are fetched from that
local repository (a local path is accepted only in proof mode; with `CD_PROOF_MODE=0` the config is
refused), nothing is pushed to the public repository and no API call is made for them.

- `status` prints a PROOF MODE banner as its first line and every mail subject carries `[PROOF]`.
- A proof release that adds a migration file is refused, and so is one whose migration count is unknown.
- A proof release is never committed: when its window ends clean it is rolled back under the rule
  `proof_end` (no block, the hold is `proof`), and it never becomes `live` as the base for pick-up.
- `CD_PROOF_MODE` is 0 in the template and a guard test pins it. The last step of the proof is to turn it
  off and prove that `status` shows nothing of it.

The steps are in `scripts/cd-proof/run-sheet.md`: the setup checks, a release that fails readiness, a
release that passes readiness and fails in the window, a 5xx spike, a good release with a migration, the
module step, a reconcile after a good release, a reconcile that fails, a canary that fails, the leaf step,
the enable catch-up, and a held release, a dump failure, the kill switch, the dead-man, a manual rollback,
the worker gate, a reboot in a window and a shared-outage pause. Each has the exact commands and a "Passed
when" block read off the running system. Run them on the host before the real customer exists; the
results prove the mechanism, not production numbers. The proof owes one measurement that no test can give:
a Karenz restore on the old colour after a module-step rollback, so that the failure of that case is
seen once.

## Accepted gaps

- **Whoever can merge to the main branch can run code as root or as the deploy user on the next
  release.** A range that changes `.github/workflows` is held (`ci_changed`) and needs the operator. Any
  other path whose code runs on the host is decided by the merge gate and the CI gate, not by CD.
- **The data of the messaging, governance and file-sync servers, chat media and shared files** are in no
  local dump. The nightly backup is their protection.
- **A tick in flight at the worker gate.** The gate stops every background tick at its top; a tick that
  already started when the file changed finishes. Request-driven work is not gated. The leaf schedulers
  run in both colours during the overlap (see [Leaf step](#leaf-step)).
- **The counts-only readiness baseline.** The readiness comparison with the live colour is a count of
  customers not ready; a baseline that was never taken falls back to the fixed minimum.
- **The migrated schema and the old colour.** After the migrate stage only two signals can see a
  migration that the old colour cannot live with: the portal list page of the live colour, which reads the
  gremion database, and the 5xx count. Nothing unauthenticated reaches the customers' silo databases or
  `control`. The protection is the expand-only rule of the chains plus the dump.
- **The quiet-night window.** `CD_QUIET_WINDOWS` keeps releases away from the nightly jobs; the Karenz
  run at minute 17 is not guarded.
- **A release in flight when the CD process dies** leaves a gap of up to five minutes with both locks
  free (see [Kill switch](#kill-switch)).
- **One rollback residual after a module-step rollback**: a Karenz restore on the old colour fails until a
  release that carries the file is live (see [Rollback](#rollback)).

## Release cadence amendment

This section is the amendment to [release-cadence.md](release-cadence.md) that continuous deployment
needs. It is a clearly marked part of this document; the policy itself stays in that file.

While the named pilot runs, rules 1 and 2 of the cadence are suspended by agreement with the pilot
council. For the releases that CD carries:

- **Fixes ship continuously.** A commit that has been merged and has a green CI run is released by the
  program without a further request, at any time outside the quiet windows.
- **A feature pull request carries its change list as a file.** The change list in German and in English
  is a file of the pull request, so it reaches the main branch in the same commit that CD releases.
- **`CD_POLICY_ACK` records the agreement date.** The program does not start a release while the key is
  empty. The value is the date on which the pilot council agreed to full adoption and continuous support
  and upgrades. It is set by the install on the host (`<agreement date>`), and the template ships it
  empty because a pilot-specific value does not belong in a public repository.
- **Every release adds one visible row per customer.** The reconcile stage writes one row into the access
  record that the council administrator reads (see [Reconcile](#reconcile-after-the-commit-point)), so
  continuous fixes mean one such row per customer per release, plus one for every re-run and hand call.
  The rows are automatic and carry the release tag.
