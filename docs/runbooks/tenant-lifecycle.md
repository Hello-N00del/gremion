# Runbook — Tenant lifecycle (provision · backup · suspend/resume · crypto-shred delete)

Operator mechanics for the per-tenant lifecycle of a Gremion multi-tenant
deployment: provisioning a new tenant, taking a per-tenant backup, suspending /
resuming, and deleting with a crypto-shred-first guarantee.

For the kernel's multi-tenancy model (tenant-resolver, control-plane registry,
the per-tenant silo, fleet migrations) and the governance domain a tenant runs,
see [About Gremion](../about-gremion.md). This runbook is the operational layer:
the commands, the ordering invariants, and the manual residuals.

All subcommands run **operator-side**, never inside the app container, so the
least-privilege provisioner credential is never reachable from any tenant
data-plane:

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts <subcommand> …
```

`<subcommand>` is one of `provision | suspend | resume | delete |
bootstrap-provisioner | reconcile | materialize-config`.

## The control plane and the per-tenant silo

Each tenant is one row in the `tenant` table of the **control DB**
(`CONTROL_DATABASE_URL`). The row carries the tenant's status, realm name,
issuer, secret refs, brand ref and `backup_key_ref`. The tenant resolver only
ever resolves a row whose `status='active'`, so any non-active row (provisioning,
suspended, deleting, deleted) is structurally non-resolvable.

A tenant's data plane is a **dedicated** governance database `t_<slug>` (the
`default` bootstrap tenant uses the shared `gremion` DB) plus a dedicated Keycloak
realm. Per-tenant secrets (DB connection URL, confidential-client secrets, the
backup key) live as host files under `TENANT_SECRETS_DIR` (default
`./secrets/tenants`), bind-mounted read-only into `gremion-ui` at
`/run/secrets/tenants`.

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

> The `pnpm -C gremion-ui check` guard fails the build if the provisioner
> credential resolves *inside* `TENANT_SECRETS_DIR`. Keep that directory a
> dedicated leaf holding only per-tenant secret files.

## Provision a tenant

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts provision <slug> \
  --config <file> [--realm <name>] [--blueprint <ref>]
```

The idempotent, registry-row-driven pipeline (`provisioner/pipeline.ts`) runs a
fail-closed ordering, each step ledger-marked so a retry resumes from prior
state:

1. **Slug guard + multi-tenant gate** — the slug must match `^[a-z0-9-]{1,30}$`;
   the deployment's default config must have multi-tenancy enabled.
2. **Tombstone refusal (§7.8)** — a `deleted`/`deleting` slug is a permanent
   tombstone; provisioning over it is refused before any write (subdomain-takeover
   defence — identifier reuse is forbidden on delete).
3. **Registry INSERT-FIRST as `status='provisioning'`** — never `active`, so a
   half-provisioned tenant is structurally non-resolvable.
4. **Data plane** — `CREATE DATABASE t_<slug>` + role, write the generated DB
   connection URL and the per-tenant **backup key** to host files under
   `TENANT_SECRETS_DIR`.
5. **Realm** — compose the per-tenant realm (identity / issuer / exact redirect
   URIs / confidential-client secrets / `sslRequired:'all'`), `POST
   /admin/realms`; an existing realm reconciles.
6. **Step-up flow apply** + grant the admin service account its
   realm-management role(s) (Keycloak imports do not carry SA role mappings
   reliably).
7. **Activate** — flip `status='active'` (which also evicts the runtime so the
   next resolution rebuilds cleanly).

`--blueprint <ref>` stamps the row's `blueprint_ref` so the per-tenant seed path
feeds this tenant its own governance blueprint (committees / org-unit tree /
roles). Omitted, the pipeline default is used.

### Required environment

| Var | Purpose |
|---|---|
| `DOMAIN` | deployment apex domain — issuer/host derivation |
| `DATABASE_URL` | app DB URL — its scheme + host:port authority is reused to build each tenant's runtime DB URL |
| `ADMIN_DATABASE_URL` | postgres superuser / CREATEDB connection for `CREATE`/`DROP DATABASE` |
| `AUTH_KEYCLOAK_INTERNAL` | in-cluster Keycloak base persisted as the tenant's `kc_internal` (default internal-TLS `https://keycloak:8443/auth`) |
| `KC_ADMIN_URL` | operator-reachable KC admin REST base (default `https://$DOMAIN/auth`) |
| `TENANT_SECRETS_DIR` | host root for per-tenant secret files (default `./secrets/tenants`) |

## Per-tenant backup

```bash
./scripts/tenant-backup.sh <slug>
```

`scripts/backup.sh` is the **whole-stack** backup (all DBs into one restic repo,
one password) — it cannot crypto-shred a single tenant. The silo model needs each
tenant's data encrypted under **its own** key so a later `delete` can destroy that
one key and instantly void **only that tenant's** backups.

`tenant-backup.sh` reads the `<slug>` registry row from the control DB, resolves
the tenant's backup key to its one canonical location, then writes per-tenant
artifacts each encrypted under that key, under the tenant's residency zone:

| Artifact | Source |
|---|---|
| `<slug>.dump.age` | `pg_dump -Fc` of the tenant governance DB (`t_<slug>`; `gremion` for `default`), through the running postgres |
| `realm.json.age` | Keycloak Admin API `partial-export` of the tenant's realm |

Output: `backups/tenants/<residency_zone>/<slug>/`, run timestamp in
`.last-backup`. Retention = `TENANT_BACKUP_RETENTION_DAYS` (default 30).

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

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts suspend <slug>
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts resume  <slug>
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
>   finish the provision pipeline (which flips it to `active` itself).

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

The pure ordering lives in `provisioner/lifecycle.ts` (`deleteTenant`); the CLI
supplies the live shredder, DB-drop executor, KC realm-delete and registry deps.
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
3. **Drop the data-plane DB + role** — `DROP DATABASE IF EXISTS "t_<slug>" WITH
   (FORCE)` + `DROP ROLE IF EXISTS` (idempotent).
4. **Module leaf-shred (optional)** — if a feature module registered a leaf store,
   the delete drops the tenant's leaf data through that module-supplied
   dependency. A module that registered such a hook propagates real failures
   (aborting the delete before the tombstone is written, leaving the row at
   `deleting` for a retry); a module that did not contributes nothing and the
   delete proceeds.
5. **Delete the realm** — `DELETE /admin/realms/<realm>` (a 404 is tolerated —
   idempotent).
6. **Tombstone** — `status='deleted'` + evict the runtime. The slug is now a
   permanent tombstone: **identifier reuse is forbidden** (§7.8) — `provision
   <slug>` of a deleted/deleting slug is refused, and re-running `delete` on a
   tombstone is a terminal-safe no-op.

**Resumability:** a failure at any step leaves the row at `deleting`; re-run
`delete <slug>` and it replays from the top — each step is idempotent, so re-runs
converge on `deleted`.

**The `default` tenant is hard-refused** — it is the bootstrap root (env-keyed
secrets, the shared stack); `delete default` throws before touching anything.

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

## Reconcile (drift guard)

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts reconcile [--verify-only] <slug>
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts reconcile [--verify-only] --all
```

Re-checks each tenant's realm against the base realm contract (identity, issuer,
exact URIs, step-up flow) and, without `--verify-only`, replays repairable drift.
`--all` walks the whole fleet, skips non-realm-bearing rows
(deleted/deleting/provisioning), and exits non-zero on any genuine failure.

## Materialize config

```bash
pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts materialize-config [<slug>] [--config <path>]
```

Reads the tenant's stored `config.json`, merges in the effective defaults, and
writes the fully-merged config back atomically. A brand-identity guard refuses
(loud, non-zero exit) a still-blank institution identity — no silent blank
render.
