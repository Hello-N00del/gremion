# Runbook — Tenant lifecycle (create · backup · suspend/resume · crypto-shred delete)

Operator mechanics for the per-tenant lifecycle of a Gremion multi-tenant
deployment: provisioning a new tenant, taking a per-tenant backup, suspending /
resuming, and deleting with a crypto-shred-first guarantee.

For the kernel's multi-tenancy model (tenant-resolver, control-plane registry,
the per-tenant silo, fleet migrations) and the governance domain a tenant runs,
see [About Gremion](../about-gremion.md). This runbook is the operational layer:
the commands, the ordering invariants, and the manual residuals.

The lifecycle verbs run in the **`tenant-create` one-shot** of the app project
(`docker-compose.app.yml`, profile `tenant-create`, never in the `gremion-ui` or
`gremion-public` containers), so the least-privilege provisioner credential is
never reachable from any tenant data-plane. The one-shot runs
`gremion-ui/scripts/tenant-provision.ts` under `tsx`; on a host it is started by
`gremion-tenant` and the executor handlers, which load `tc()` from
`infra/host/lib/customer-ops.sh`. A source checkout can run the same file with
the environment contract of the one-shot (see
[docs/ops/pooled-stack-layout.md](../ops/pooled-stack-layout.md)):

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts <subcommand> …
```

`<subcommand>` is one of `init | phase-a | record-step | phase-b | activate |
render-router | suspend | resume | status | operator-add | reconcile | delete |
bootstrap-provisioner | materialize-config | request-verify`, plus the module-gate,
import, purge, Karenz, export and CD module-step verbs (`enable-module`, `disable-module`,
`dpia-record`, `isolation-record`, `gate-status`, `regate`, `import-validate`,
`import-apply`, `seed-vertical`, `purge-run`, `karenz-run`, `karenz-status`,
`export`, `export-verify`, `module-upgrade --all`); `--help` lists them. `provision` is retired and
exits with a usage error.

<!-- gremion-tenant decommission note (R31-I4) -->
## Decommission note: `gremion-tenant` no longer creates customers

Customers are created, suspended, resumed and reconciled by **requests**: the
control panel ("Neuer Mandant") submits a row through
`plt.submit_provisioning_request`, and the host-side `gremion-executor`
claims, verifies and runs it. The old operator verb `gremion-tenant create` is
gone (it exits 2 and writes nothing); `suspend`, `resume` and `status` are
not documented as operator steps and retire the same way with the panel's
customer screens. The one break-glass path is `gremion-tenant request <kind>
--args-file <0600 json> --operator <uuid> --reason <text>`, which puts the
same request into the same queue, flagged `origin=host`.

One host verb stays a supported operator step: `gremion-tenant reconcile <slug>
[--apply --reason <text>]`. It is audited, a plain run only reports drift, and it is
what an upgrade runs for every customer (`docs/ops/runbook/upgrade.md`, step 8), because
that step needs the report on stdout, which a queued request does not give. The A7 docs
guard (`test/host/executor.bats`) therefore exempts `reconcile` and nothing else.
<!-- /gremion-tenant decommission note -->

## The control plane and the per-tenant silo

Each tenant is one row in the `tenant` table of the **control DB**
(`CONTROL_DATABASE_URL`). The row carries the tenant's status, realm name,
issuer, secret refs, brand ref and `backup_key_ref`. The tenant resolver only
ever resolves a row whose `status='active'`, so any non-active row (provisioning,
suspended, deleting, deleted) is structurally non-resolvable.

A tenant's data plane is a **dedicated** kernel database `t_<tenant id hex>__kernel`
on the kernel's `postgres` server, a dedicated governance database
`t_<tenant id hex>__governance` on `governance-postgres`, one database per enabled
module on that module's own server, plus a dedicated Keycloak realm. There is no
`default` tenant: a fresh platform has no tenant row and serves none
([tenant-edge.md](./tenant-edge.md)). Per-tenant secrets (DB connection URL,
confidential-client secrets, the backup key) live as host files under
`TENANT_SECRETS_DIR` (default `./secrets/tenants`), bind-mounted read-only into
`gremion-ui` at `/run/secrets/tenants`.

## One-time: bootstrap the provisioner service account

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts bootstrap-provisioner
```

Mints a dedicated master-realm Keycloak service account (`tenant-provisioner`,
overridable via `TENANT_PROVISIONER_CLIENT_ID`) holding **only** `create-realm`
— never the admin superuser, never any tenant data-plane credential. The admin
credentials (`KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`) are used exactly once,
here, to create the SA; thereafter the provisioner authenticates as the SA via
`client_credentials`. The SA secret is written to
`TENANT_PROVISIONER_SECRET_FILE` (default `./secrets/tenant_provisioner`),
**outside** the bind-mounted `secrets/tenants/` dir so the app container can never
read it. Idempotent — a re-run reuses the existing SA.

On a pooled host this is not a manual step: `gremion-tenant init` runs
`bootstrap-provisioner` once in the tenant-create one-shot (the Keycloak admin
credential from `etc/env/state.env`, by a name-only `-e`) and moves the secret
to `etc/secrets/tenant-create/tenant_provisioner` (0600). The one-shot reads it
from there as `TENANT_PROVISIONER_SECRET_FILE`, through the read-only
`etc/secrets/tenant-create` mount that no other service has (TASK-043b F1).

### A realm the service account did not create (#48)

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts bootstrap-provisioner --adopt-realm <realm>
```

Keycloak gives a `create-realm` account admin only on the realms it created. A
realm created before the SA, or by another admin, answers it 403, and
`reconcile` fails naming this command. `--adopt-realm` (admin credentials, once
per realm) maps onto the SA exactly the master `<realm>-realm` client roles
Keycloak grants a realm's creator (`REALM_CREATOR_ROLES`: Keycloak's
`AdminRoles.ALL_REALM_ROLES`, no `impersonation`, no `view-system`), only those
still missing; it touches only master, never the SA's secret, and refuses
`master`. On a pooled host: step 6 of
[docs/ops/runbook/upgrade.md](../ops/runbook/upgrade.md).

> The `pnpm -C gremion-ui check` guard fails the build if the provisioner
> credential resolves *inside* `TENANT_SECRETS_DIR`. Keep that directory a
> dedicated leaf holding only per-tenant secret files.

## Create a tenant

A customer is created by a `create` request (the control panel's "Neuer Mandant";
break-glass: `gremion-tenant request create --args-file <0600 json> --operator
<uuid> --reason <text>`), which the host executor claims, verifies
(`request-verify`) and runs through `infra/host/lib/executor/handlers/create.sh`
and `customer_create` in `infra/host/lib/customer-ops.sh`. The old operator verb
`tenant-provision.ts provision <slug> --config <file>` and its single-process
pipeline are retired (TASK-043); `pipeline.ts` keeps only the provisioner's
Keycloak constants.

The form's brand fields (product name, organisation short name) and the two
semester start months ("Wintersemester beginnt im", "Sommersemester beginnt im";
October and April by default) travel in the request as `brand.product`,
`brand.orgShort` and the optional `brand.termMonths` (`{winter, summer}`, two
different months 1 to 12; request-verify checks them again and an older stored
request without them still verifies). `create.sh` writes them into the tenant
config as `brand.product`, `brand.org_short` and `brand.term_months`. Only the
months are stored: the semester label in the sidebar ("WiSe 26/27", "SoSe 27")
is computed from them and the current date in Europe/Berlin on every request. A
customer without `brand.term_months` keeps the static `brand.term` text. A
customer created earlier sets the two months in the app under Einstellungen,
Organisation (an IT administrator; `PATCH /api/settings` with
`brand.term_months`, the same rule).

The order and the ledger live in `@gremion/provisioning` (`steps.ts`,
`plt.provisioning_step`). Each of the nine steps is ledger-marked, so a retry
resumes from prior state, and the customer stays non-resolvable until the last
step has run:

| Phase | Steps (`EXECUTION_ORDER`) |
|---|---|
| container, phase A (`tenant-create phase-a`) | `realm_created`, `database_created` (kernel database), `governance_database_created`, `domain_bound`, `storage_prefix_reserved`, `first_body_created`, `broker_account_created` |
| host | `mail_principal_issued` (the vendor mail principal and the realm's sender; the one-shot is then told with `record-step`) |
| container, phase B (`tenant-create phase-b`) | `first_accounts_created`, the `--enable` modules through the gate; the customer stays `provisioning` |
| host | the customer's router file `etc/edge/tenant-<slug>.yml` (`render-router`), then `activate` flips `status='active'` once all nine steps are done |

Properties the pipeline keeps:

1. **Slug and host guard.** The slug must match `^[a-z0-9-]{1,30}$`; the host is
   validated, and on a single-customer install it must equal `PILOT_TENANT_HOST` (or, when the operator
   lists extra hosts in `SECONDARY_TENANT_HOSTS`, be one of those, with board and calendar unless the
   install opted further modules in; see [ops/pilot-services.md](../ops/pilot-services.md),
   "Two customers on one install").
2. **Tombstone refusal (§7.8).** A `deleted`/`deleting` slug is a permanent
   tombstone; creating over it is refused before any write (subdomain-takeover
   defence: identifier reuse is forbidden on delete).
3. **Registry row first as `status='provisioning'`**, never `active`, so a
   half-provisioned tenant is structurally non-resolvable.
4. **Data plane.** `ensureKernelDatabase` creates `t_<hex32>__kernel` with its
   roles (and the `pgbouncer.get_auth` lookup stays in place); the governance
   database and its credential file follow. The generated connection URL and the
   per-tenant **backup key** are written as host files under `TENANT_SECRETS_DIR`.
5. **Realm.** The per-tenant realm is composed (identity, issuer, exact redirect
   URIs, confidential-client secrets, `sslRequired:'all'`) and created over the
   Admin API; an existing realm reconciles. The step-up flow is applied and the
   `gremion-admin` service account gets its realm-management role.
6. **No container, no compose project.** `create` takes the container count and
   every project's `config --services` before and after and fails if either moved
   (TRD-440).

The environment contract of the one-shot (every variable is checked before it
connects anywhere; a missing one is a named exit-2 failure) is the table in
[docs/ops/pooled-stack-layout.md](../ops/pooled-stack-layout.md), section "The
tenant-create environment contract".

## Per-tenant backup

```bash
./scripts/tenant-backup.sh <slug>
```

`scripts/backup.sh` is the **whole-stack** backup of the three kernel databases
into one restic repo with one password (a distribution host runs it through
`gremion-backup`, which adds every other database and volume; see
[docs/ops/runbook/backup.md](../ops/runbook/backup.md)) — it cannot crypto-shred
a single tenant. The silo model needs each
tenant's data encrypted under **its own** key so a later `delete` can destroy that
one key and instantly void **only that tenant's** backups.

`tenant-backup.sh` reads the `<slug>` registry row from the control DB, resolves
the tenant's backup key to its one canonical location, then writes per-tenant
artifacts each encrypted under that key, under the tenant's residency zone:

| Artifact | Source |
|---|---|
| `<slug>.dump.age` | `pg_dump -Fc` of the tenant's kernel DB (`t_<tenant id hex>__kernel`), through the running postgres |
| `realm.json.age` | Keycloak Admin API `partial-export` of the tenant's realm |

Output: one dated **generation** per run,
`backups/tenants/<residency_zone>/<slug>/<YYYYmmdd-HHMMSS-pid>/`, holding both
artifacts. `.last-backup` names the newest published generation.

A run stages everything in `.partial-<generation>` and publishes it with a single
rename, only after every artifact exists and is non-empty. A run that fails
anywhere (pg_dump error, empty dump, Keycloak unreachable) leaves no new
generation and never touches an earlier one. Retention prunes generations older
than `TENANT_BACKUP_RETENTION_DAYS` (default 30) but always keeps the newest
`TENANT_BACKUP_KEEP_GENERATIONS` (default 2, minimum 1), so a stopped schedule
cannot age out the last good backup. To restore, use the newest generation
directory (the one `.last-backup` names).

Decisions baked in:

- **Realm export** = Admin API `POST /admin/realms/<realm>/partial-export`
  (`exportClients`/`exportGroupsAndRoles`) via curl — runs operator-side without
  the keycloak container, mirroring the provisioner.
- **Encryption** = `openssl enc -aes-256-cbc -pbkdf2`. The key is passed on a file
  descriptor, never argv/env. Artifacts keep the `.age` suffix (switch to real
  `age` if you later standardise on it).
- The script never runs `docker compose up/restart/--force-recreate`; dumps go
  through `docker compose exec -T` against already-running services.

### Module-owned data

A feature module that holds its own per-tenant store (e.g. a leaf database) backs
that store up through its **own** per-module hook, encrypted under the same
per-tenant key. The kernel script above covers only the kernel-owned governance
DB and realm; module backup steps live with the module.

Required env: `CONTROL_DATABASE_URL`, `POSTGRES_USER`, `KEYCLOAK_ADMIN`,
`KEYCLOAK_ADMIN_PASSWORD`. Optional: `TENANT_SECRETS_DIR`, `KC_BASE_URL` (default
`http://localhost:8080/auth`), `BACKUP_DIR` (default `./backups`),
`TENANT_BACKUP_RETENTION_DAYS`.

### The one canonical key location

The per-tenant backup key MUST exist in **exactly one** canonical location, and
the registry's own backup MUST NOT contain any tenant key — otherwise the
crypto-shred is void (a copy of the key survives the delete). Resolution is
single-sourced in `lib/server/tenant/backup-key.ts` (`backupKeyLocation`):

- `file:/run/secrets/tenants/<name>` → host path
  `${TENANT_SECRETS_DIR:-./secrets/tenants}/<name>` (the crypto-shred target).
- `env:<VAR>` (the `default` tenant) → the operator **root secret** (`.env`/KMS),
  backed up **independently** of any tenant lifecycle; there is no per-tenant file
  to shred or to leak.

The crypto-shred *chain* and the "exactly one physical copy anywhere on media"
guarantee are **operational acceptance (manual audit)**. The automatable slice
(`registryBackupKeyLeaks`, `backup-key.integration.test.ts`): every registry row's
`backup_key_ref` resolves to exactly one location, and the registry's own backup
set excludes every tenant-key target path.

**Manual audit per tenant:**

1. `backup_key_ref` resolves to exactly one host path — no second copy under
   `config/`, `backups/`, SOPS, or a re-backed-up secrets snapshot.
2. The control-DB dump does **not** include any `secrets/tenants/*_backup_key`
   file.
3. Per-tenant backups under `backups/tenants/<residency_zone>/<slug>/` are
   readable **only** with that tenant's key.

## Suspend / resume

**In operation (TRD-044, PRD-OPS-004) this is the control panel.** On
`/customers/<slug>` the page offers "Mandant sperren" for an active customer and
"Mandant fortsetzen" for a suspended one (nothing while a request is queued or
running; after a suspend that did not finish, both). Each button queues a
`suspend` / `resume` request (args: the slug only) with the operator's signed
loa2 sign-in as evidence, exactly like "Neuer Mandant"; the executor runs
`handlers/suspend.sh` / `resume.sh`, which call `customer_suspend` /
`customer_resume` in `infra/host/lib/customer-ops.sh`:

- suspend: the container verb first (status, realm disabled, sessions out,
  broker users evicted), then the mail principal revoked. The router file is not
  touched: the route stays and the app serves the branded 503 for a suspended
  customer. A failed revoke is finished `failed`; triggering "Mandant sperren"
  again converges.
- resume: a fresh mail principal first (never `--rotate`), then the container
  verb (realm, broker users, status `active` last).
- data is untouched: both verbs take the TRD-440 fingerprint (container count and
  every project's services) before and after their own run and fail if it
  moved. Nothing is compared across requests: a deploy between a suspend and
  its resume is normal. A failed resume revokes the fresh mail principal again.

**Modules and the realm check (TRD-044 remainder).** The same page has a
"Module" section for an ACTIVE customer with no queued or running request: the
enabled modules with "Modul deaktivieren", the available ones with "Modul
aktivieren" plus the DPIA decision (an explicit erforderlich / nicht erforderlich
and a document reference, as in "Neuer Mandant"; vault is shown blocked,
and board is shown as held back, because a council cannot switch it), a "DPIA-Entscheidung festhalten" form per enabled module and the
"Abgleich" buttons. Each queues one request, handled by the executor:

- `enable_module` {slug, module, dpia}: `tenant-create enable-module` (deny list,
  loaded catalogue version, isolation pass on the release tip, the decision
  recorded, enableModule through the gate, broker users). Repeatable.
- `disable_module` {slug, module}: `tenant-create disable-module` (export and
  verify the module database, then BLOCK it and open the 30-day Karenz, see "Module
  Karenz (30 days)" below; nothing is dropped; broker users shrunk). It refuses,
  nothing touched, unless `TENANT_EXPORT_DIR` is a mounted volume
  (`$GREMION_ROOT/data/module-exports`, which must exist and be writable by the
  container user). A failed export leaves the database in place and unblocked; the
  same request again resumes.
- `record_dpia` {slug, module, requiresDpia, documentRef}: `tenant-create
  dpia-record`, identical latest decision reused (no second row on a rerun).
- `reconcile` {slug, apply}: the dry run is `tenant-create reconcile
  --verify-only`; drift fails the request and the report is its event stream,
  shown on the page as "Ergebnis des letzten Abgleichs". `apply` repairs, rotates
  the host mail principal when smtp-server is `repair: host`, and must end green.

A module must be in the catalogue and not in `modules/disabled.json`
(request-verify). enable and disable assert the TRD-440 fingerprint like
suspend/resume.

The library commands below are what the container verbs run.


```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts suspend <slug> --operator <ops-realm user uuid>
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts resume  <slug> --operator <ops-realm user uuid>
```

Both are control-row status flips that route through the **one lifecycle seam**
(`registry.updateTenantStatus` → `evictTenantRuntime`):

- `suspend` sets `status='suspended'` and evicts the tenant's entire runtime
  (resolution cache, DB pool, KC-admin client, JWKS, per-tenant mail, plus every
  module-registered per-tenant handle). The suspended page then serves the branded
  503 from the control-row status alone, touching **no data plane**.
- `resume` sets `status='active'` (also evicts, so the next resolution rebuilds
  cleanly). The data plane, realm and secrets are untouched by suspend, so resume
  is non-destructive.

> ### State-machine guard — resume can never resurrect a tombstone (§7.8)
>
> These flips are a **guarded state machine** (`registry.assertTenantStatusTransition`),
> not a bare `UPDATE`. `resume` (`resumeTenant`) is legal **only from
> `suspended`**; `suspend` (`suspendTenant`) **only from `active`**. Every other
> source status is refused with a loud, named `TenantStatusTransitionError`,
> leaving the row untouched:
> - `resume <deleted-slug>` / `resume <deleting-slug>` is **refused** — a
>   crypto-shredded tombstone is terminal; the slug stays reserved forever.
>   (Without this guard the bare flip would set `status='active'` and the resolver
>   — which filters only on `status!=='active'` — would resolve the shredded
>   tenant live again.)
> - `resume <provisioning-slug>` is **refused** — a half-provisioned row must
>   finish the create (whose final step flips it to `active` itself).

### Cross-process eviction is fleet-wide and immediate

`evictTenantRuntime` busts an **in-process** cache. The CLI runs in a **separate
process** from the long-running app, so its own eviction would not, by itself,
reach a running app replica. The kernel closes this gap:
`updateTenantStatus` issues `pg_notify(tenant_evict, '<tenantId>')` in the
**same transaction** as the status flip, and every app process subscribes to that
channel (`evict-listener.ts`, `startTenantEvictListener`). On commit, every
replica calls `evictTenantRuntime` locally — so a CLI `suspend`/`delete` is
**instant, fleet-wide**.

The resolution-cache TTL (`RESOLUTION_CACHE_TTL_MS`, ~30 s) remains only as a
backstop for a `NOTIFY` missed during a listener reconnect; it is not the normal
path.

Suspend/resume never touch the DB, realm or secret files — only `delete` does.

## Delete — crypto-shred-first

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts delete <slug>
```

The pure ordering lives in `gremion-ui/src/lib/server/tenant/provisioner/lifecycle.ts`
(`deleteTenant`); the CLI supplies the live shredder, DB-drop executor, KC
realm-delete and registry deps. `delete` has no control-panel request: it is an
operator verb in the one-shot. It refuses, before shredding anything, while the
customer still has the pre-TASK-043 database `t_<slug>` (drop it and its role by
hand first) or any live module database, a **blocked** one inside its Karenz
included (a module database is dropped only by the day-30 `karenz-run`, see
"Module Karenz"); it needs `PLATFORM_DATABASE_URL` for that proof.
The sequence is **crypto-shred FIRST** so an interrupted delete can never leave a
recoverable backup:

1. **`status='deleting'`** — flipped before any destructive step, so a crash
   mid-sequence leaves a **visible, resumable** state (the resolver already 404s
   any non-`active` row).
2. **Crypto-shred the per-tenant backup key FIRST** — destroying the
   exactly-one-location key instantly voids **every** backup the tenant ever wrote
   — together with every live per-tenant credential file
   (`tenant_<slug>_backup_key`, `tenant_<slug>_db`,
   `tenant_<slug>_client_<client>`) under `${TENANT_SECRETS_DIR}`. Idempotent: a
   missing file is a no-op.
3. **Drop the data-plane DB + roles** — the kernel database `t_<hex32>__kernel`
   and its roles, dropped by tenant id (`dropKernelDatabase`; idempotent).
   Since TASK-084-a the customer's **governance database**
   `t_<hex32>__governance` and its three roles are dropped in the same step
   (idempotent; a customer made before the governance server existed has neither,
   and the log line says `no governance database was present`), and the customer's
   credential file under `${GOVERNANCE_SECRETS_DIR}` is shredded with the other
   secrets in step 2. The `delete` verb therefore needs `GOVERNANCE_PG_ADMIN_FILE`
   (the governance server's admin URL, direct, not the pooler) and
   `GOVERNANCE_SECRETS_DIR` besides the kernel variables, and refuses before
   shredding anything when either is missing.
4. **Module leaf-shred (optional)** — if a feature module registered a leaf store,
   the delete drops the tenant's leaf data through that module-supplied
   dependency. A module that registered such a hook propagates real failures
   (aborting the delete before the tombstone is written, leaving the row at
   `deleting` for a retry); a module that did not contributes nothing and the
   delete proceeds.
5. **Delete the realm** — `DELETE /admin/realms/<realm>` (a 404 is tolerated —
   idempotent).
6. **Tombstone** — `status='deleted'` + evict the runtime. The slug is now a
   permanent tombstone: **identifier reuse is forbidden** (§7.8) — a `create` of a
   deleted/deleting slug is refused, and re-running `delete` on a
   tombstone is a terminal-safe no-op.

**Rolling back past TASK-084-a:** platform migration `0015` adds the ledger step
kind `governance_database_created`. The previous release's ledger reader throws on
a step kind it does not know, so after the new colour created a customer,
switching back to the old colour breaks `tenant-create` for that customer until
the new colour runs again. Roll forward, not back, once a customer was created
by this release.

**Resumability:** a failure at any step leaves the row at `deleting`; re-run
`delete <slug>` and it replays from the top — each step is idempotent, so re-runs
converge on `deleted`.

**There is no bootstrap tenant** (TRD-042): every tenant is deletable, a slug
spelled `default` included.

### Module satellites — manual teardown residual

`deleteTenant` cannot reach per-tenant resources that a feature module
provisioned **out-of-band** in an external system (e.g. files/storage or
messaging spaces provisioned by an org-unit worker). For each such subsystem the
delete flags the ledger row `status='failed'` with `last_error="crypto-shred
delete: manual teardown required"`. **After every delete, the operator must
manually tear down those external spaces** for any module that registered such a
satellite, and purge their media.

These leave no copy encrypted under the shredded key, so they are a separate
data-erasure-completion step the crypto-shred does not cover. Track them off the
failed ledger rows until done.

### A customer on the shared Nextcloud and Synapse: manual teardown

Files, polls and the calendar's CalDAV mirror of a customer live in the install's
ONE Nextcloud, and chat in its ONE Synapse. `delete` drops the customer's own
databases and shreds its keys; it does not reach these two services, and their
backups are per install (no per-customer restore), so a deleted customer's data
stays in those backups until they rotate out. On an install with two customers
the teardown is therefore a hand step, and it must not touch the other
customer. Nothing here is a verb of this repository unless it says so.

**1. Capture first, before `delete`.** The identifiers live in places `delete`
removes: the provisioning ledger is in the customer's kernel database, which
step 3 above drops, and the member list is in the realm, which step 5 deletes.
Write down, for the customer only:

- the ledger's `matrix` rows (`external_id` = the Matrix room id) and `nextcloud`
  rows (`external_id` = `<folderId>:<groupId>`, the group being `ou-<unit id>`),
  from `provisioning_resources` in the customer's kernel database;
- the realm's members: Keycloak id, username and e-mail;
- the tenant id (the retained-records folder is `Aufbewahrung-<tenant id>`, its
  groups `gremion-retained-<tenant id>` and `gremion-retained-<tenant id>-w`);
- for a customer on a secondary host: its slug (the provider `Keycloak-<slug>`, the
  CalDAV collection named by the leaf's `CALDAV_CALENDAR_TEMPLATE`, by default
  `gremion-<slug>`, under the leaf's shared account, and the namespaced chat
  names below).

Run what follows through the running containers on the host, the way
`gremion-services` does: `occ` as `docker exec -u www-data <nextcloud> php occ ...`;
the Synapse admin API from inside the `matrix` container (`/_synapse` is never
routed at the edge) with the admin bot's token handed to `docker exec` by name and
the header read from curl's stdin config, never on an argv.

**2. Nextcloud.**

- Group folders: for each ledger folder id and for the retained folder, confirm
  with `occ groupfolders:list --output=json` that the folder carries the
  customer's own group (`ou-<unit id>` or the retained groups) and no other
  customer's, then delete it. The app does this itself per unit with the group
  folders REST route (`DELETE /index.php/apps/groupfolders/folders/<id>`), then
  deletes the group; the matching `occ` verbs and the folders' trash bin are not
  used anywhere in this repository: read `occ list groupfolders` and `occ list
  group` on the installed version and confirm the verb before using it. A folder
  is identified by its id and groups, never by its mount name, which is the unit
  name and can exist in another customer.
- Groups: `ou-<unit id>` for each unit, `gremion-retained-<tenant id>` and its `-w`
  group.
- Accounts: the members' Nextcloud accounts. The first customer's accounts carry
  the raw Keycloak id; accounts of a customer under its own provider carry an id
  `user_oidc` derives, so find each with `occ user:info <id> --output=json`, tie it
  to a captured member, and delete only those. Never delete by prefix or display
  name. The `occ` verb for deleting an account is not used in this repository:
  confirm it with `occ list user`.
- Calendar: the customer's collection (`occ dav:list-calendars <owner>` lists it;
  the delete verb is not used here: confirm it with `occ list dav`).
- Provider (secondary host only): the customer's `Keycloak-<slug>` login provider
  (`occ user_oidc:provider <identifier> --output=json` reads it; confirm the delete
  verb with `occ list user_oidc`). Never remove `Keycloak`: it is the first
  customer's provider (id 1), which every secondary wire reads.
- Polls: they are created by the install's one Nextcloud admin account and carry
  the title marker `[gt:<tenant id>] `. No `occ` verb lists them by customer: use
  the Polls app as that account, delete exactly the polls whose title starts with
  that marker, and confirm none is left.

**3. Synapse.**

- Rooms: the ledger room ids. For each, read the room's `org.gremion.tenant` state
  event and continue only when it names this customer's tenant id and was written
  by the admin bot (a room without it is not provably the customer's: leave it and
  report it). Delete with `DELETE /_synapse/admin/v1/rooms/<room id>` and the body
  `{"block": true, "purge": true}`, which is what the app's own room delete sends.
  Also look for the customer's rooms that the ledger lacks (a room whose unit was
  removed): aliases `#stura.<slug>.`, `#stura-archiv.<slug>.` and `#meeting.<slug>.`,
  accepted only with the same marker check.
- Accounts: on an install in the namespaced identity, the customer's members are
  `@<slug>.<escaped username>:<server>` (escaping: `a-z 0-9 . = / -` stay, every
  other UTF-8 byte becomes `_hh` in lower-case hex, `_` included). Erase each with
  `POST /_synapse/admin/v1/deactivate/<user id>` and the body `{"erase": true}`,
  which is what the app's erasure hook sends. In the legacy identity the accounts
  are the bare usernames of the FIRST customer: never erase one on behalf of a
  second customer's teardown, and on the first customer's own teardown only after
  confirming that no other customer is on the homeserver.
- Media: the room delete does not remove files that members uploaded. Delete the
  accounts' uploaded media with the admin API's per-user media delete; it is not
  used in this repository, so confirm the route in the installed Synapse's admin
  documentation.

**4.** Then run `delete <slug>`.

**5. Read it back** from the running services, not from the exit codes: the
`groupfolders:list` output holds no folder with the customer's groups, `user:info`
answers not found for each captured account, the room list holds no room with
the customer's marker, and the erased accounts read deactivated. Keep the lists
from step 1 until this passes, and name any object you could not identify as left
over in the handover.

## Module self-service by the council

A council admin switches a feature module **on** from Settings > Module. The switch is a
provisioning request of a third origin, `council` (next to `panel` and `host`), that goes
through the same queue and the same host executor as every other request, without operator
approval and with the actor recorded as a person (`actor_kind = person`), not as an
operator. It writes no `oac.access_record`: that record is vendor and operator access.

**Scope: on and off.** The database accepts `enable_module` and `disable_module` for the
council origin, and since the 30-day Karenz exists (next section) the application accepts both.
Phase 1 refused a council `disable_module` with `DISABLE_NOT_YET` because the switch-off
dropped the module database at once; the constant `COUNCIL_DISABLE_ALLOWED` in
`@gremion/provisioning` is now `true` and that refusal is gone. A switch-off is recoverable for
30 days, and a switch-on inside those days is the same `enable_module` request as a first
switch-on, without a new DPIA input.

**Switchable set.** Catalogue ids that own a toggleable manifest and are not denied:
`calendar`, `elections`, `votes`. Every other id is refused with `MODULE_NOT_SWITCHABLE`
(`files`, `messaging`, `publishing`, `handover` and `board` are held back (the board as `MODULE_NOT_SWITCHABLE`, like the others); `vault` is
`MODULE_DENIED` by name; a module in `modules/disabled.json` is `MODULE_NOT_SHIPPED`). The
refusal comes before anything is queued and again from the executor's `request-verify`.

**Who may switch.** The realm role `council-admin` (`it-admin` includes it through the role
hierarchy). The `vorstand` role does not confer this right.

**Step-up.** Every switch needs a fresh LoA 2 sign-in (`STEPUP_FRESHNESS_SECONDS`, default
300 s). A stale session gets `401 STEP_UP_REQUIRED` and the settings page runs the step-up
flow. The sign-in time recorded with the request is the ID token's own `auth_time` (its `iat`
when the realm emits none), the value the executor compares it with, not the gremion-ui
server's clock; an ID token without either, or older than the 3600 s evidence window, also
gets `401 STEP_UP_REQUIRED`.

**The second factor comes before the switch-off warning.** `GET /api/settings/modules?preview=<id>`
(what the warning shows) answers the same `401 STEP_UP_REQUIRED` for a stale session, so the
page goes to the second factor first and opens the warning when it is back; the admin then
confirms once, and there is nothing to carry across the round trip. The POST still checks the
second factor itself.

**The confirmed switch survives the step-up** (a switch-on, the restore, or a switch-off whose
second factor lapsed while the warning was open). With that `401` the server keeps the confirmed
input for the round trip (tenant table `module_switch_pending`, migration `0065`): one row per
person, found by the SHA-256 of a random handle that the browser holds in an HttpOnly,
SameSite=Strict cookie scoped to `/api/settings/modules`. Back on the settings page, the page
sends `POST /api/settings/modules {"resume": true}` once. The server removes the row as it
reads it (single use) and carries the switch out only for the person who confirmed it, within
300 s, and with a second factor newer than the one of the confirming session; the unchanged
switch service then runs every check again, the fresh LoA 2 included. A resume that cannot be
carried out is a `409` (`RESUME_GONE`, `RESUME_EXPIRED`, `RESUME_UNCONFIRMED`) that the page
shows; it never starts a second step-up, and the admin triggers the switch again.

**How the request is submitted.** gremion-ui connects to `gremion_platform` as the
least-privilege role `gremion_ui_modules` (LOGIN, member of `plt_council_requester`, EXECUTE
on the three council request functions, no table privilege) through
`PLATFORM_MODULES_DATABASE_URL`, and calls `plt.submit_council_module_request`. The request
carries the admin's signed id and access token. One request per customer slug runs at a
time: a second submit while one is queued or running gets `409 IN_FLIGHT`.

**`UI_MODULES_DB_PASSWORD` is the optional off switch.** When it is unset or empty, `init`
does not create the role, compose renders an empty `PLATFORM_MODULES_DATABASE_URL`, and the
settings section answers "nicht konfiguriert" (HTTP 503 `NOT_CONFIGURED`). Do not turn this
variable into a required one. To switch the feature on, set it, run `init` and recreate the
app containers.

**What the executor verifies** (`request-verify`, fail closed, in this order): the kind and
args (`enable_module` or `disable_module`; no token is read for a refused kind); the module is
council-switchable; the customer exists in the registry; the signed token pair against that
customer's own Keycloak realm only (issuer and keys of that realm, client `gremion-ui`,
role `council-admin` or `it-admin`, `acr` `loa2`, sign-in within the 3600 s evidence
window; the admin is bound through the access token's `sub`, the real user id, because the
gremion-ui ID token's `sub` is pairwise or absent), so a pair signed by council A can never carry a request for the customer of
council B; and finally the admin read back from the realm now (exists, enabled, still
holds the role). Then the unchanged `enable_module` or `disable_module` handler runs with `--actor-kind person`.
Every existing enable gate still applies: deny list by name, `modules/disabled.json`, a
loaded `plt.module_version`, the isolation pass and a written DPIA decision with a document
reference. The admin may carry the DPIA decision with the request (reason code
`council_decision`, `decided_by_kind = person`); without one, the recorded decision is used;
with neither, the enable is refused (`DPIA_REQUIRED` in the settings page,
`NO_DPIA_DECISION` from the gate).

**What changes in the customer.** The request finishing is not the end: a reconciler in
gremion-ui reads the finished request and writes `config.modules`. Where a platform
enablement row exists, it is the source of truth for "is a module on". A module without a
row (every module of a customer that predates the switch) is *unmanaged* and keeps following
`config.modules`, which defaults every toggleable module to on.

**When the module's routes turn off.** The route gate and the navigation read `config.modules`
from the customer's `config.json` on every request: there is no cache of module state in the
app, so no TTL to wait out. The file changes when the reconciler applies the request, and
that follows the host: not when the switch-off is accepted (the request is `queued`, then
`running`), but when the request has `succeeded`. The Karenz steps (archive, publish the read-only copies) start after that, from
the applied switch. From then on the lag is the reconciler's own: at most one 10 s timer tick
(`MODULE_SWITCH_INTERVAL_MS`), or, while the settings page is open, at most one poll (5 s),
because `GET /api/settings/modules` runs the same pass first. That on-demand pass goes through
the worker seam: a colour whose worker gate is `off`, or a pass already running for the
customer in that process, runs nothing from the request and the page shows what is stored. The
gate is deliberately not switched at acceptance: the platform enablement, which the host
changes, is the source of truth, and a request that fails, is refused or expires must leave the
module exactly as it was; a gate that went off ahead of the host would have to be taken back.

**Reading a failed switch.** The settings section shows the failure text of the newest
switch of each module. The states of the tenant-side record are `queued`, `succeeded`,
`applying`, `applied` and the failures `failed`, `refused`, `expired` and `dead`. The
control panel's request list for the customer shows the origin as "Gremium".

| Symptom | Reading |
|---|---|
| `refused`, reason starting `evidence:` | The token pair did not verify against the customer's realm (wrong realm, wrong client, no `loa2`, sign-in too old). The executor log has `request-verify <id>: refused: <reason>`. |
| `refused`, `council admin ... no longer holds council-admin` or `is disabled` | The admin lost the role or the account between submit and claim. |
| `refused`, `MODULE_NOT_SWITCHABLE` or a gate code | The module is outside the set or a gate said no; the text carries the code. |
| `expired` | No executor claimed the request within 30 minutes. Check that the host executor is running, then submit again. |
| `failed` or `dead` | The `enable_module` handler failed; read the request's events in the control panel. |
| stays `applying`, with an error text | The platform enablement succeeded but `config.json` could not be written (a customer created before the `TENANT_SECRETS_UID` fix has it `root:root 0640`). Run `materialize-config <slug>` as described below; the reconciler retries on its own and nothing reads as switched until the write works. |

A failed or refused switch never changes `config.modules`.

## Module Karenz (30 days)

Switching a module off destroys nothing for 30 days. Every disable, from any origin (the council's
Settings > Module, the control panel, the host break-glass), opens one row in `plt.module_karenz`
in the same transaction that turns the enablement off. That row is the only clock: `final_at` is
`switched_off_at` plus 30 days (`KARENZ_DAYS`), and neither the tenant nor a council report can move it.

### What a switch-off does

| Where | At switch-off | Switch-on inside the 30 days | Day 30 |
|---|---|---|---|
| Module database (calendar, content, finance, publishing, vault) | exported and verified, then BLOCKED: the app role loses CONNECT, the database stays alive | unblocked, the data is back | dropped, and the row's own export is deleted with it |
| `board` in its own module database (a customer created with board ticked) | exported and verified, then BLOCKED like the rows above; the board is hidden through `config.modules.board` | unblocked, the same boards are back | the database is dropped and the export is KEPT: it stays 365 days after day 30 (provisional until the DPO confirms the length: `EXPORT_KEEP_DAYS` in `packages/provisioning/src/export-hold.ts`, retention catalogue rows RC-BRD and RC-MOD-EXPORT), the date is written to `export_kept_until`, and the day-30 job deletes the dump only after that date; every other module in this table keeps the 30-day rule |
| `board` still in the kernel tables (a customer created without board ticked, or before board had its own database) | where the customer had a board enablement: hidden by the module-switch reconciler through `config.modules.board`, and the 30-day clock opens; no export is taken, because there is no database to export | refused by the same gate as a later enable of board (it would create an empty database beside the kernel rows), and while the platform row is disabled the reconciler puts a hand-set `config.modules.board` back to false: a platform switch-off of a kernel board is one-way in this release, so hide such a board with `config.modules.board = false` and do not switch it off | nothing is deleted (`registerNoRetention`); the rows stay in the customer's kernel database, and how long they may be kept is decided under the module's processing record (`rp-brd-module-data`) |
| `votes` (Nextcloud Polls) | every open poll is locked by moving its deadline into the past, the remaining time is stored | the deadline becomes "now plus the stored remaining time"; a poll without a deadline gets none again; a poll that had already expired or been closed is never reopened | polls are deleted unless a protocol references them; a poll without a sealed line is kept and reported |
| `elections` (Helios) | open elections are paused through the pause port | unpaused with the stored remaining time | nothing is deleted in Helios; an election with a sealed result is archived in the tenant table |
| `messaging` (Matrix) | every org unit's room is archived (read-only) | unarchived | rooms the Karenz archived are deleted, except meeting-linked rooms (RC-MSG-LINK) |
| `files` (Nextcloud) | only the Gremion binding of each org unit is released; folders, groups and files are untouched | the same folder is bound again and the group membership is brought up to date | nothing is deleted in Nextcloud |
| Retained records | sealed as read-only encrypted copies at switch-off | stay | stay (`retained_record` is append-only and `finalize` never touches it) |

A deadline is never closed silently. A refused lock or unlock leaves the item locked (or flagged
`lock_failed` / `unlock_failed`) and is reported on the settings page and in the ops alert.

**Helios pause mode.** The Helios source is not part of this repository, so whether an election can
be paused is a fact of the deployed instance. `HELIOS_PAUSE_MODE` in
`modules/elections/app/lib/server/elections/helios-pause.ts` ships `unsupported`. In that mode the
switch-off guard refuses to switch `elections` off while an election is open
(`SWITCH_OFF_BLOCKED`, HTTP 409); with no open election the switch-off goes through. Probe the
running Helios (list the admin endpoints of an unfrozen and a frozen election), record the result,
and only then change the mode together with its implementation.

**Notice.** The holders of the realm roles `council-admin` and `vorstand` are mailed once at
switch-off and again on day 23 and day 29, de-duplicated, one mail per person. The mail, the
reminders, the settings page and every API response name no actor; the person who switched exists
only in `audit_log`, in the tenant's own `module_switch_request.actor_user_id` and in
`plt.module_karenz.actor_*` (read by `karenz-status` below, never by the shared council role).
When nobody can be told (Keycloak down, SMTP unconfigured, no holder with an address) the
switch-off stays in force, the notice step fails loudly and is retried, and skipped holders are
listed on the settings page.

**Retained records.** Readable by `council-admin`, `vorstand`, `finance`, `auditor` and `it-admin`:
always as a download behind `GET /api/settings/modules/retained?id=<id>` (the list is
`?module=<catalogue id>`), and through a read-only group folder in the files module when it is on.
The Nextcloud is one shared instance, so the folder and its groups are named per tenant and are
never adopted by name. The copies are served redacted for persons erased under Art. 17 after the
copy was sealed; the stored bytes never change, and an erasure during the Karenz is replayed
before a restore. After day 30 a module switched on afresh shows the earlier period's sealed copies,
still read-only.

### States

`plt.module_karenz.state`:

| State | Meaning |
|---|---|
| `open` | the module is off, the clock runs |
| `restoring` | switched on inside the 30 days; the tenant pass is still restoring the external items. A new switch-off is refused `KARENZ_RESTORE_PENDING` until it has finished |
| `restored` | the restore finished; a later switch-off starts a fresh 30 days and fresh reminders |
| `finalizing` | the day-30 job has claimed the row. A switch-on is refused `KARENZ_FINALIZING` until the job has finished, after which it is a fresh start, not a restore |
| `finalized` | the platform side (`platform_done_at`) and the tenant side (`tenant_done_at`) are both done |

A switch-on after `final_at` but before the job has run is still a restore: nothing was deleted yet.

### The day-30 job and the deletion switch

`gremion-karenz.timer` runs `infra/host/ops/karenz.sh` hourly (minute 17 UTC) under
`runtime/hostd.lock`. It calls `tenant-create karenz-run` in the active colour, which finalizes the
due rows (see `infra/host/ops/README.md` for the exit codes and the one JSON line it prints). Every
sub-step is keyed on persisted state, so a crash or a skipped hour converges on the next run.

`KARENZ_FINAL_DELETION` ships `off`. Only the exact string `on` deletes; `ON`, `true`, `1` and empty
are off. It is read by `karenz-run` only; gremion-ui takes the mode from the row (`final_mode`) and
never from its own environment. `off` is a dry run on both sides: the platform side records the mode
and counts what is due, the tenant pass writes one info event per 24 hours that starts with
"deletion off: would delete:".

Procedure to turn the deletion on, per environment:

1. Re-date check. `node --test scripts/check-karenz-catalogue.test.mjs` is green and the rows RC-MOD-EXPORT,
   RC-MOD-DATA, RC-MSG-ROOM and A-G/A-MOD in `docs/compliance/retention-catalogue.md` carry the
   30-day reading.
2. Finance. The per-class extraction of finance records (phase 3) must be verified first: the finance
   export is deleted with the blocked database on day 30. Do not turn deletion on for an environment
   that has the finance module in use before that.
3. Read one dry-run line. Run `infra/host/ops/karenz.sh` with the switch `off` (or wait for the
   timer) and read its JSON line: `due`, `errors` (must be empty) and `orphanedExports`. Then wait for
   one tenant pass and read the tenant-side "would delete: ..." info event. Both must list what you
   expect and nothing else.
4. Set `KARENZ_FINAL_DELETION=on` in the active colour's app env file (`etc/env/app-<colour>.env`),
   run one `karenz.sh` by hand and read the line again (`deletion":"on"`, `finalized`, empty
   `errors`). `TENANT_EXPORT_DIR` must be its own mount; otherwise `karenz-run` refuses with exit 2
   and touches nothing.
5. Check the gauges: `gremion_module_karenz_*` in `runtime/textfile/gremion.prom`, and that
   `gremion:cond:module_karenz` is 0.

**Orphaned exports.** `orphanedExports` lists dumps under `TENANT_EXPORT_DIR/<tenant>/<module>/` that
no Karenz row and no `plt.module_database` row references: strays of an attempt that failed before
it was recorded. They are listed on every run, dry or live, and never deleted automatically,
because one may be a backup you still want. Read the list, then delete the files you do not need by
hand, each together with its `.sha256` sidecar.

### Reading the state: `karenz-status`

```bash
source infra/host/lib/customer-ops.sh   # defines tc(), the tenant-create one-shot; once per shell
tc karenz-status <slug>
```

One JSON line with the live rows and the rows of the last 90 days of one customer: module, state,
`switchedOffAt`, `finalAt`, the actor, the export path, `finalMode` and the done marks. It includes
the actor and is therefore for the operator only. The council sees the same rows without actor and
export columns on Settings > Module: days left, the restore button, problems in an alert,
the retained downloads and the link to the backup export (`/settings/sicherungen`).

Alerting: `gremion:cond:module_karenz` is the sum of four conditions, all derived from platform
columns only: `gremion_module_karenz_failed` (the newest event of a step is an error),
`gremion_module_karenz_stale` (a notice or reminder is overdue because the tenant pass never ran),
`gremion_module_karenz_overdue` (a row is more than 6 hours past `final_at` while the deletion switch
is on) and an absent `gremion_module_karenz_live` (the collector could not read the platform table).
Any of them pages through the normal ops alert path.

### A stuck restore

A restore that is still `restoring` after an hour is reported as the failed step `restore:stuck`.
Read the failing steps on the settings page, or the tenant pass log, for the named item (a kind and an
external id, never a title). A permanently failing unlock of a Polls or Helios item is fixed by hand in
Nextcloud or Helios; the pass observes the live state and completes. Do not switch the module off
again meanwhile: that is refused (`KARENZ_RESTORE_PENDING`) so that locked items are never adopted by
a second Karenz.

### AUTH_SECRET rotation

Retained records are sealed with a per-tenant data key that is wrapped by a key derived from
`AUTH_SECRET`. Rotating `AUTH_SECRET` therefore has two consequences:

1. **Re-wrap the data keys, as part of the rotation.** Call `rewrapDataKeys(db, tenantId, oldSecret,
   newSecret)` (`gremion-ui/src/lib/server/module-karenz/retained/crypto.ts`) for every tenant before
   the old secret is dropped. It is safe to run again; it stops, guessing nothing, at a key that opens
   under neither secret. Without it every sealed copy becomes unreadable, possibly years from now.
2. **Redaction of earlier erasures silently stops.** The `subjectRef` hashes that recognise an erased
   person in a retained copy and in the files sink are keyed with `AUTH_SECRET`. After a rotation the
   hashes of earlier erasures no longer match, so those persons become legible again in retained
   copies and in the republished documents unless the references are re-derived. There is no warning.
   Re-derive them, or hold the rotation until that is done.

### Open items of this runbook

Owed after the kernel is deployed to the test environment (never proved in the repository): the
timer and the platform table on the running host, a real-browser switch-off and switch-on of
`votes`, the delivered mail, the day-30 simulation, the forced failure and its alert, the Polls
lock, the Helios pause probe and the Nextcloud read-only group folder, the two-tenant folder
separation, and the retained list after a fresh start.

## Board: where a customer's board lives

A customer's board is in one of two places: its own database `t_<hex32>__board` on `board-postgres`
(the flag `module`), or the tables `board`, `stack` and `card` of its kernel database `t_<hex32>__kernel`
(the flag `kernel`, which is also what a customer with no flag row reads). The flag is the one row of
the table `board_location` in the customer's kernel database; the board README
([modules/board](../../modules/board/README.md)) has the table of readings. The Karenz table above says
what a switch-off does in each case.

**What this release does.** A customer created with board ticked gets its own board database in the
create flow and the flag `module` at once, so its board never lives in the kernel. A customer created
without board ticked keeps its board in the kernel tables, and board cannot be ticked for it later:
the enable is refused before anything is written, because it would create an empty database beside the
kernel rows. Board has to be ticked when the customer is created.

**What is not available yet.** Moving an existing customer's board from the kernel tables into its own
database is not available yet. There is no verb for it in this release, and nothing here may be
followed as a move procedure. Do not copy the rows by hand: nothing would stop a writer during the copy,
and the flag is written by the create flow alone. A customer that already holds its board in the kernel
keeps it there until the move exists.

### Check where every customer's board lives (read-only)

This reads one row and three counts per customer database, in a read-only session, and prints counts
only: no database name, no slug, no board or card text.

```bash
cd /opt/gremion/current
pg() {
  docker compose --env-file /opt/gremion/etc/env/state.env exec -T \
    -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
    psql -U postgres -tA -v ON_ERROR_STOP=1 "$@" </dev/null
}
dbs=$(pg -c "SELECT datname FROM pg_database WHERE datname ~ '^t_[0-9a-f]{32}__kernel\$' ORDER BY datname") || echo "listing failed: stop"
echo "customer databases found: $(printf '%s\n' "$dbs" | grep -c .)"
for db in $dbs; do
  pg -d "$db" -c "SELECT coalesce((SELECT location FROM board_location WHERE id), 'kernel') || ' ' || CASE WHEN (SELECT count(*) FROM board) + (SELECT count(*) FROM stack) + (SELECT count(*) FROM card) > 0 THEN 'rows' ELSE 'empty' END" 2>/dev/null || echo unreadable
done | sort | uniq -c
# first line: how many customer databases exist; then one line per distinct answer with the number of
# customers that gave it, for example:
# customer databases found: 2
#       2 module empty
```

The number on the first line must not be 0, and the numbers in front of the answers must add up to it.
A 0, or a sum that differs, means the listing or a read failed: stop, and do not take the rest as an
all-clear.

How to read each line:

| Line | Meaning | What to do |
|---|---|---|
| `module empty` | the board is in the customer's own database and the kernel tables are empty | nothing: this is the answer for every customer created on this release with board ticked |
| `module rows` | the flag says `module` but the kernel tables hold rows | stop: those rows are not served; do not touch them and raise it |
| `kernel empty` | the board is in the kernel and there is no board data yet | a customer created without board ticked, or one that never used it; it cannot be given a board database in this release |
| `kernel rows` | the board data is in the kernel tables | expected only for a customer created before board had its own database; it stays there until the move exists |
| `moving ...` | a move marked the customer | no step of this release writes this value: stop and raise it |
| `unreadable` | the table `board_location` does not exist in that database (the kernel migration 0066 is not applied to it) or the database could not be read | apply the release's migrations for that customer, then run the check again |

"No customer has its board located in the kernel" is the case in which the first line is not 0, the
numbers in front of the answers add up to it, no answer starts with `kernel` or `moving`, and none
reads `unreadable`.

### Order for the real customer

1. Deploy the release and confirm the check above has no `unreadable` line.
2. Create the real customer, with board ticked, from the panel's create form or the create request.
3. Run the check again. The number in front of `module empty` is one higher than before, the first
   line is one higher too, and no `kernel` or `moving` answer appeared or changed.
4. Enter the real data only after that. A customer created before this release stays in the kernel and
   is not the real customer; a placeholder customer that should have its own board database is created
   again (staging only), never moved.

### Releasing or re-dating a kept board export by hand

The day-30 job keeps the board export until the date in `export_kept_until` of the Karenz row, and a
later change of the period does not re-date an export that is already kept. Releasing an export early,
or moving its date once the DPO has set the final period, is a hand statement on the platform database.
It is irreversible once the job has run: after day 30 the dump is the only copy of that customer's
board, so do it only on a recorded decision.

```bash
source infra/host/lib/customer-ops.sh
tc karenz-status <slug>
# find the row with moduleKey board; note its karenzId. exportKeptUntil must be set and exportDeletedAt empty.
cd /opt/gremion/current
docker compose --env-file /opt/gremion/etc/env/state.env exec -T postgres \
  psql -U postgres -d gremion_platform -v ON_ERROR_STOP=1 -tA \
  -c "UPDATE plt.module_karenz SET export_kept_until = now() - interval '1 second' WHERE karenz_id = '<karenzId>' AND export_deleted_at IS NULL AND export_kept_until IS NOT NULL" </dev/null
# UPDATE 1 took effect; UPDATE 0 means the id is wrong or the row is not a kept export
```

To move the date instead of releasing the export, set `export_kept_until` to the new timestamp in the
same statement. A release takes effect on the next hourly `karenz-run` with `KARENZ_FINAL_DELETION` set
to `on`; with it `off` the run is a dry run and the dump stays. The run then deletes the dump and its
`.sha256` sidecar and sets `export_deleted_at`; read it back with `tc karenz-status <slug>`. The dumps
are under `TENANT_EXPORT_DIR/<customer id>/board/`, on the host in `data/module-exports`, which the
nightly `gremion-backup` stages.

### Lifecycle verbs and a release in progress

A deploy, a switch, a rollback, a snapshot and a backup each hold the host lock `runtime/hostd.lock`
(`gremion-hostd`). The executor, `karenz.sh`, `purge.sh` and `gremion-tenant` take that lock too and
skip, wait or answer busy (exit 3). The raw one-shot `tc <verb>` of `infra/host/lib/customer-ops.sh`
takes no lock. So while a release is being deployed, run only read-only verbs through it
(`karenz-status`, `status`) and no raw verb that writes (`enable-module`, `disable-module`,
`karenz-run`, `purge-run`, `import-apply`, `delete`): such a write races the
migrations and the colour switch of the release. Wait for the deploy to end, or go through the
executor or `gremion-tenant`, which respect the lock.

## Reconcile (drift guard)

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts reconcile [--verify-only] <slug>
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts reconcile [--verify-only] --all
```

Re-checks each tenant's realm against the base realm contract (identity, issuer,
exact URIs, step-up flow) and, without `--verify-only`, replays repairable drift.
With `--verify-only` (the host verb `gremion-tenant reconcile <slug>` without `--apply`) it only
reports drift and changes nothing.
`--all` walks the whole fleet, skips non-realm-bearing rows
(deleted/deleting/provisioning), and exits non-zero on any genuine failure.

Besides the realm contract, each report carries one **kernel database** check,
`audit-append-only` (TASK-033-a): the app and owner roles must hold no DELETE, UPDATE
or TRUNCATE on `audit_log`, and no write on `audit_log_chain_anchor`. The kernel audit
table is a governance record (RC-GOV-CHAIN) that no timer purges. `--verify-only` reads
the effective privileges (`has_table_privilege`) and fails the report if one is held;
without it the verb re-asserts the REVOKE and reads again. Provisioning applies the same
REVOKE after the kernel chain (the migrate step fails when `audit_log` is missing or a
privilege is still held). A customer provisioned before this check shows it RED until
one `reconcile <slug>` (apply) has run.

Three more checks re-apply provisioning that a later release added and that customers
created earlier never received (`purger-connect` and `kernel-api-nats-seed` are kernel
issues #88 and #89; `vorstand-role` is Karenz phase 1; the root cause is the same:
create-time provisioning is not re-run on an upgrade). Each is read by a plain
reconcile (`gremion-tenant reconcile <slug>` without `--apply`, or the library verb with
`--verify-only`), which **only reports drift and changes nothing** (RED when the customer is
behind). Only `gremion-tenant reconcile <slug> --apply --reason <text>` (the library verb
without `--verify-only`) repairs, idempotently; a second apply changes nothing:

| Check | What must hold | What apply does |
|---|---|---|
| `purger-connect` | the customer's `k_<hex>_purger` role holds `CONNECT` on its kernel database, `USAGE` on schema `public` and `SELECT`, `DELETE` on every kernel purge table that exists (the scheduled purge logs in as it; without `CONNECT` the purge fails with `permission denied for database`, with `CONNECT` alone every table is refused) | `GRANT CONNECT` (exactly `CONNECT`), then the same schema and table grants customer creation gives, then reads all of it back. It never creates a role: a customer without one has no kernel database provisioned |
| `kernel-api-nats-seed` | the NATS seed `kernel-api/tenant_<slug>.nk` exists, every seed of the customer's current module set exists, **no seed is held for a module outside that set** (the declarative apply would revoke and delete it, so it is reported as drift before apply does it), and the broker serves the customer's account (the kernel API event relay publishes as that identity). The check reads seeds and the accounts file only; it never looks at JetStream streams | the same `nats-auth` ensure the lifecycle verbs use, over the customer's **current** module set read from the registry (`plt.module_enablement`) plus the `kernel-api` identity, then the account reload; a hand-written module list is never needed |
| `vorstand-role` | the standard realm role `vorstand` exists AND is listed in the `gremion-ui` client's realm-role scope mappings (`fullScopeAllowed` is false, so a role missing there never reaches a token); a realm created before the role was added to the realm template shows it RED | creates the role and the scope mapping; both steps are idempotent |

Two realm checks cover the e-mail change in Settings > Profil. `update-email-action` holds when
the required action `UPDATE_EMAIL` is registered and enabled (Keycloak ships it disabled; the Profil
page offers the button only while it is enabled). `update-email-verification` holds when the action's
own config `verifyEmail` is `true`: Keycloak 26.6.1 then mails the new address a confirmation link
and keeps the old address until it is opened, and without it (and without a realm-wide `verifyEmail`)
the new address applies at once. The action's config is used on purpose, not the realm's `verifyEmail`,
which would send every user with an unverified address through the verify-email step at login.
A realm created before this change shows both RED. Apply writes the config first, then enables the
action on its live representation with the merged config in the same body (Keycloak's action PUT replaces
the stored config with its body, so a body without it would erase the verification), so the action is
never enabled without verification; a realm that
does not register the action at all stays RED, since apply cannot register it. Customer creation
does the same on every pass. These repairs need `manage-realm` in the customer realm, which the
provisioner holds on a realm it created or adopted and which `realm-admin` (the `gremion-admin`
service account's role) contains.

A third realm check, `account-console-disabled`, holds when Keycloak's built-in `account-console` client
is disabled: a customer realm gives it no client scopes, so its page is broken, and the app edits the
profile itself. Apply disables it (a partial client update; it is never deleted, Keycloak recreates a
deleted built-in client) and creation does the same. The `account` client is left alone: the default
role references its roles, and Keycloak's mailed invitation links fall back to it when they name no
client. Such an invitation (`execute-actions-email` without a client) therefore still works: it runs
under `account`, and its completion page carries no link into the console.

A suspended customer is ensured with the empty module set (suspension evicts the
modules; reconcile does not restore them) and keeps the `kernel-api` identity like the
kernel. A customer that is neither active nor suspended has no `kernel-api-nats-seed`
check. Every later `ensure` of a customer account (create, enable, disable, suspend,
resume) carries `kernel-api` as well, so the seed is not removed again. An upgrade runs
`reconcile --apply` for every customer (`docs/ops/runbook/upgrade.md`).

**Operator note, chain anchor:** with `INSERT` on `audit_log_chain_anchor` revoked from
the app role, the migration-0059 *adopt* path (`gremion.audit_chain_adopt_head`, only
needed for a database whose first rows were purged before 0059 existed) cannot write
the anchor from the boot migration. Run the acknowledgement as the database superuser
on that one customer, or apply 0059 before the first `reconcile` apply. No new database
needs it: nothing purges the chain any more.

## Materialize config

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts materialize-config <slug> [--config <path>]
```

Reads the tenant's stored `config.json`, merges in the effective defaults, and
writes the fully-merged config back atomically. A brand-identity guard refuses
(loud, non-zero exit) a still-blank institution identity — no silent blank
render.

The file and its `<data root>/<slug>` directory are written as the config reader
(`TENANT_SECRETS_UID`/`GID`, default 1000), not root (#49). This is also the repair for a
customer created before that fix, whose `config.json` is `root:root 0640`: gremion-ui gets
`EACCES`, readiness fails and the customer host answers 503. A tenant-create re-run does NOT
repair it (its ledger skips the finished step); run `materialize-config <slug>` once, then check
`stat -c '%u:%g %a' <data root>/<slug>/config.json` shows `1000:1000 640`.

## Tenant export in open formats (TRD-149/150/151)

```
sudo gremion-tenant export <slug> <absolute-dir>
```

Writes `<dir>` (created 0700; refused when it already holds anything) with
`kernel/<table>.csv|json` for the org units, roles, assignments (+ history),
memberships, elections, caucuses, protocols with attendance, resolutions,
action items and challenges and the audit log, `<module>/<table>.csv|json`
for every enabled module whose `module.json` declares `runtime.export`, and
`manifest.json` (schema version, tenant slug, `generated_at`, every file with
sha256, bytes and row count, `modules` and `excluded_systems` /
`excluded_tables` each with a reason: Nextcloud files and Matrix history are
never exported by this verb). Files are 0600. A second container run then
re-reads the directory: a missing, empty, altered or unlisted file prints
`EXPORT INCOMPLETE <code> <path>` and the verb exits 1 -- treat the directory
as unusable. `gremion-tenant` runs the check alone through the container's
`export-verify <dir>`. This is an export for the customer, not a backup:
restic (`gremion-backup`) remains the restore path.
