# Handover: R33 wave 2, cloud session result (for the next local session)

Date: 2026-10-28. Written by the cloud session that worked through `HANDOVER-wave-2-create-harden.md` (2026-10-27) plus open issues, Dependabot, TRD/PRD gaps and two security sweeps. Drop this file before merging if it should not live in the kernel.

Start the next session on the kernel repo. Check PR #37 first, then StuRaOS.

## 0. State (verify with git, do not trust this table)

| What | Where |
|---|---|
| Integration branch | `claude/elegant-bell-u835bz` (pushed to `Hello-N00del/gremion`) |
| Pull request | https://github.com/Hello-N00del/gremion/pull/37 → `main` (not merged) |
| Base | `main` @ `b75ae25` |
| CI on PR #37 | not checked by the cloud session: **check it first** |
| Deployed | nothing. The test env is untouched and the consumer gitlink is not bumped |

```
git fetch origin && git log --oneline origin/main..origin/claude/elegant-bell-u835bz | wc -l
git diff --stat origin/main...origin/claude/elegant-bell-u835bz | tail -1
```

## 1. Done, with where to look

### Handover 1b (create-harden H1–H7)
| Item | Result | Key files |
|---|---|---|
| H1 | The panel mirrors provisioning's printable rule (`PRINTABLE_TEXT`) and `RESERVED_SLUGS`, with a drift test pinning both. ASCII host checked on the raw value. Unknown module ids refused. | `apps/control-panel/src/lib/server/requests.ts`, `packages/provisioning/src/printable-text.ts` |
| H2 | Explicit yes/no per enabled module, and yes needs a document reference. No HTML `required` (the server enforces it). | `customers/new/+page.server.ts` |
| H3 | `phase-b --defer-activation` → `write_router` → `tc activate`. CLI phase-b never activates. | `infra/host/lib/customer-ops.sh`, `packages/provisioning/src/customer.ts` |
| H4 | Migration `0011_plt_lease_fence` (strict renew, 60 s requeue grace). On the host: background renewer (dead-man switch), process groups, INT/TERM/HUP traps, per-request container label kill + confirm, `--loop` flock and startup sweep, monotonic fence, psql timeouts. Two Opus rounds. | `infra/host/bin/gremion-executor`, `infra/host/lib/executor/db.sh` |
| H5 | `/customers/<slug>` shows request state (verifying = running + `evidence_verified_at` null). Executor step labels. Meta refresh stops on a terminal state. | `apps/control-panel/src/lib/request-state.ts`, `routes/(shell)/customers/[slug]` |
| H6 | Every step is idempotent (Opus traced each resource). A re-run binds a missing host. Retry = new idempotency key, `create` only, for failed/refused(evidence)/expired/dead. | `lib/server/retry.ts`, `customer.ts ensureControlRow` |
| H7 | `@@executor-step-failed <step> <rc>` → error event, with FAIL text as fallback. Steps `activate` and `trd-440` added. | `gremion-executor` |

Not done from the handover's "Done means": **no deploy, no live create / status / retry on the test env, no `customer-provision-proof.sh`**.

### Handover 1d, 1f
- 1d: `requestPathHandle` decodes once, and every path gate reads it. Malformed escape → 400. `callbackUrl` keeps the raw path. Opus fuzz: 300k paths, 0 router/gate mismatches.
- 1f recon: done, then the operator approved building it (see §2).

### Beyond the handover (all on the branch)
- **Re-init blockers:**
  - module leaf Dockerfiles build from kernel paths (`lint-module-dockerfile-copy`);
  - ci-local runs without `--vertical`, reporting SKIPPED rows and a `--list` dry run;
  - bind-mount preflight (`scripts/check-bind-sources.sh`) and `render-pgbouncer-userlist.sh`;
  - neutral defaults;
  - backup tag `gremion` / `gremion-restic`, which refuses a silent fresh repo while `stura-restic` holds data;
  - blueprints as vertical data (`verticals/stura`, `verticals/municipal`, approved 2026-10-28), with `KERNEL_BLUEPRINT@1` as the default.
- **Issues:**
  - #7: the CVE-floor guard runs in pre-commit. Closes #7.
  - #6: already done; RELAY_SMTP docs and a guard added.
  - #8: code done. Live NATS 210/210, N-runs 20/20.
- **Dependabot:** #35, #34, #25/#26, #24 and #10 folded in. **#12 (TypeScript 7) blocked** by svelte-check, SvelteKit and openapi-typescript.
- **TRD/PRD:**
  - TRD-044: suspend, resume, enable/disable_module, record_dpia and reconcile go through the queue.
  - TRD-092/191: access record `0013_oac_access_record`, the `/settings/zugriffsprotokoll` view and a 27 d purge timer.
  - TRD-140–142: TOM annex (`scripts/gen-tom-annex.mjs --check`).
  - TRD-144/145: purge runner `0012_plt_purge_run`, logging in as the per-customer purger with a one-run password.
  - TRD-149–151: tenant export (non-superuser reader, all schemas, withhold list, CSV formula guard).
  - TRD-162: record-of-processing template.
  - TRD-196: erasure report `0060_erasure_report` plus hooks for all modules (step-up LoA2; stays `incomplete` until the Keycloak account is gone).
  - TRD-205: alert active hours.
- **Security sweep 1 + 2:**
  - CSRF origin guard, and a failed Authorization header never falls back to the cookie;
  - ADDRESS_HEADER/XFF_DEPTH;
  - member-status rank check;
  - SMTP host vetted on save and on every send;
  - challenge visibility;
  - secrets off argv;
  - pgbouncer `NOT usesuper`;
  - newsletter schedule authz;
  - meeting-room authz;
  - signed media URLs, upload membership and LiveKit room id;
  - Synapse alias rules;
  - realm OTP-or-deny step-up, password policy, refresh rotation, PKCE;
  - votes tenant isolation and vote integrity.
- **Baseline repair:**
  - migration lint waivers (`scripts/migrations/runner/lint-waivers.json`);
  - lint-js 107 → 39 (baseline lowered to 39);
  - backup.test socket path;
  - module-scan, hygiene h2/e7, check-sops fixture, trd199 scan, ci-local claims;
  - new workflow `.github/workflows/control-panel.yml`.

## 2. Order of work for the local session

1. **CI on PR #37.** Fix red. Expected risk areas: the new `control-panel.yml` workflow (first run), `test/pgbouncer-auth.bats` (needs docker in the unit job, pinned digest), the gremion-ui unit suite in full (never run end to end in one go in the cloud), and `make lint` targets needing kubectl or `.env` (lint-hygiene e3/e4/g2).
2. **Local gates the cloud could not run:**
   ```
   make test-unit
   ```
   ```
   make lint
   ```
   ```
   pnpm -C gremion-ui test:unit
   ```
   ```
   pnpm -C gremion-ui check
   ```
   ```
   pnpm -C gremion-ui exec tsx scripts/boundary-lint.ts --all
   ```
   ```
   pnpm -C gremion-ui exec tsx scripts/boundary-lint.ts --contracts
   ```
3. **Live Keycloak check** for the OTP-or-deny step-up (the cloud proxy blocked quay.io):
   ```
   python3 test/integration/fixtures/render-realm-fixture.py --realm x --apex ci.local
   ```
   Import the realm, GET `/authentication/flows/stepup-2fa/executions`, then do a step-up as a user with OTP (passes) and without OTP (denied, no enrollment offered).
4. **Second-round Opus verify** (skipped for budget) on: export-fix, purge-fix, erasure-fix, trd044 r2, sec-realm, sec-modules r2, ops-wiring (0013 owner/insert trigger). Use the house reviewer `orch-review.local.js`.
5. **Merge #37** (kernel first), then **lane 033**: rebase onto the new main and **renumber its platform migration off 0011** (0011–0013 are taken).
6. **StuRaOS:** bump the `upstream/gremion` gitlink, run unit, svelte-check and parity, merge. New env to supply on hosts:
   - `UI_OAC_DB_PASSWORD` (gremion-init-secrets generates it), `PLATFORM_ACCESS_DATABASE_URL`
   - `SYNAPSE_ADMIN_BOT_USER_ID` (default `@gremion-admin-bot:${PLATFORM_DOMAIN}`)
   - `ADDRESS_HEADER` / `XFF_DEPTH`, `OPS_ACTIVE_HOURS_*`, `BACKUP_TAG*`, `GREMION_VERTICALS_DIR`, `VOTES_LEGACY_POLL_TENANT_ID`
   - host dir `$GREMION_ROOT/data/module-exports` (disable-module)
   - re-run `docker/pgbouncer/pgbouncer-auth.sql` per routed DB (runbook `docs/runbooks/pgbouncer.md` step 3)
   - existing backups: set `RCLONE_REMOTE_PATH=stura-restic` or `rclone moveto` (runbook `docs/ops/restore-runbook.md`)
   - existing customers: run `ensureKernelPurgeGrants` (no backfill verb yet), or their purge is refused
7. **Deploy to the test env** with a rollback point, then verify on the running system:
   - a bad brand gives a form error;
   - a real create end to end;
   - the status page through each state;
   - a forced phase B failure, then a retry;
   - suspend/resume;
   - an export with `export-verify`;
   - a purge run.

   Record `.deployed-sha`.
8. **Handover items still open:** 1a (re-tier `lanes-r33.js`, local only), 1c (033 fix r1, needs `r33d-verify-findings-2026-10-23.md`), vault sync note.

## 3. Operator decisions still open
1. Loki app logs 28 d vs the retention catalogue's 30 d (the TOM annex shows both).
2. Löschkonzept legal wording still says "verfasste Studierendenschaft".
3. Auditor is outside the member-status rank ladder: may a council-admin disable the auditor?
4. Elections erasure: the Helios roll is treated as an integrity hold and reported as erased. Should it be skipped?
5. Votes erasure deletes the whole Nextcloud account even if files is disabled.
6. Mandatory first-login OTP for members, now that step-up no longer allows enrollment.
7. Erasure does not delete the Keycloak account, so reports stay `incomplete`. Who removes it, and when?

Decisions made in the cloud session (do not re-ask):
- No dev-only realm switch. Dev realms are created on the server through the create tooling; KNOWN_ISSUES is closed.
- The municipal vertical is approved for the core.

## 4. Known residuals (from lane reports)
- Votes: polls made before the change need `VOTES_LEGACY_POLL_TENANT_ID`; isolation is in-module only (Nextcloud admins see all).
- Publishing erasure cannot reach the unsubscribe list or ledger through the port.
- Reconcile dry-run with drift ends as `failed`.
- Export: the reader wiring was never run against a live multi-server stack.
- H4: a wedged docker daemon or total host loss is fenced only by the DB grace.
- `tenant-provision.ts` must be run through `tenant-provision.mjs` (env shim); calling the `.ts` directly fails on `$env`.
- Commits have no DCO sign-off.
- The H10 deploy.bats failures in the cloud were sandbox-only (its git signing helper); re-check locally.

## 5. Tiering used (per the 10-27 rule)
- Haiku: recon.
- Sonnet: every implementer.
- Opus: every verify and every CRIT/HIGH fix.
- Escalated to Opus after HIGHs on two consecutive units (H1/H2 then H4).
