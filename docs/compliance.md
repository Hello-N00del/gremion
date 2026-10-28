# Compliance — Retention, Deletion & Tenant Crypto-Shred Contract

Source of truth for how the Gremion governance kernel honours **GDPR Art. 5(1)(e)**
(storage limitation — personal data kept "no longer than necessary") and how a
whole tenant's personal data is destroyed on delete. When a retention field is
added to the per-tenant config, or a purge / shred step moves, this file changes
with it.

For the project's vision, architecture, licensing and the governance charter,
see [`docs/about-gremion.md`](./about-gremion.md). This document is the
operational compliance layer; it does not restate the architecture.

The admin shell app is `gremion-ui`, so code paths below are under `gremion-ui/`. The kernel ships exactly two non-toggleable module
manifests — `core` and `governance` — so the retention and shred contracts here
cover identity/auth, multi-tenancy, and the governance domain (committees,
members, the org-unit tree, protocols, resolutions, the public portal). Feature
modules (elections, newsletter, calendar, files, messages, board,
users, finance, content, vault, handover) are separate services over a stable
API, each in its own repository; each owns and documents its own retention.

Cross-references:
- Infrastructure-layer log retention (reverse proxy, Keycloak, container
  stdout): [`docs/log-retention-policy.md`](./log-retention-policy.md).
- Auto-generated German-language Löschkonzept (per-tenant controller and
  data-protection-officer details; the deletion periods themselves are the product's
  fixed windows; served to data subjects): [`gremion-ui/src/lib/server/loeschkonzept.ts`](../gremion-ui/src/lib/server/loeschkonzept.ts).

---

## 1. GDPR Art. 5(1)(e) — retention principles

Art. 5(1)(e) requires personal data to be kept in a form which permits
identification of data subjects for no longer than is necessary for the
purposes for which it is processed. In the kernel that obligation is discharged
in three layers:

1. **Configurable retention windows** held per tenant in `GremionConfig.retention`
   ([`gremion-ui/src/lib/server/config.ts`](../gremion-ui/src/lib/server/config.ts)).
   The defaults and caps live in one registry
   ([`gremion-ui/src/lib/retention-tiers.ts`](../gremion-ui/src/lib/retention-tiers.ts))
   and follow the operator ceiling of 30 days for every log class
   [D R29-I6] (R29-RETENTION-30-K); the earlier BSI Mindeststandard 90/180-day
   and BayLDA tiers are superseded.
2. **A scheduled host purge job** (`gremion-purge.timer` -> `tenant-create purge-run`) that
   hard-deletes plumbing and operational rows older than their catalogue window, once per
   customer kernel database, each against that tenant's own data plane. It runs on the host,
   not in the SvelteKit server process, and reads no per-tenant config field: its windows
   are literals tied by a test to `docs/compliance/retention-catalogue.md`. The
   `audit_log` governance record is not purged by it (see §2.1).
3. **Per-tenant crypto-shred on delete** — destroying a tenant voids every
   backup it ever wrote and drops its entire data plane, so deletion is
   complete and irreversible rather than a soft tombstone over live data
   (see §3).

Every retention field has exactly one mechanism that enforces it. The mapping
in §2 and the delete contract in §3 are the contract — if personal data
survives past its configured window, or a deleted tenant's data remains
recoverable, that is a gap, not a feature.

---

## 2. Retention config fields

Schema:
[`gremion-ui/src/lib/server/config.ts`](../gremion-ui/src/lib/server/config.ts)
(`GremionConfig.retention`). Hard caps are enforced by `clampRetentionDays` from the
tier registry: inside `writeConfig`, and **on every read** of the stored config (so a
value persisted before the ceiling, such as 90, is clamped; the clamp logs one warning
per field). Since TASK-033-a the four fields are not editable: the settings API refuses
the whole `retention` key with HTTP 400 and the Settings tab is read-only. The fixed
windows are `RETENTION_DEFAULTS`, tied by a test to the windows the retention registry
renders into the log store (`packages/retention`).

| Field | Default | Hard cap | Basis | Implementation |
|---|---|---|---|---|
| `access_logs_days` | 14 | **29** | Operator ceiling 30 d [D R29-I6]; Art. 5(1)(e) | none in the application yet (see the note below); the edge files are bounded by `docs/log-retention-policy.md` |
| `app_logs_days` | 28 | **29** | Operator ceiling 30 d [D R29-I6]; Art. 5(1)(e); Art. 6(1)(f) legitimate interest | none in the application yet (see the note below) |
| `security_logs_days` | 27 | **29** | Operator ceiling 30 d [D R29-I6] | none in the application (see the note below); the log store's window (RC-LOG-SEC, 27 d). The `audit_log` table is not this field (see §2.1) |
| `security_nopii_logs_days` | 27 | **30** | Operator ceiling 30 d [D R29-I6]; operator value [R31-I4a] | none in the application yet (see the note below) |

> **Operator ceiling 30 d [D R29-I6] (R29-RETENTION-30-K).** No log class is kept
> longer than 30 days. The caps are 29 d where a daily purge would enforce the
> window (29 d + 24 h tick = 30 d); `security_nopii_logs_days` keeps cap 30.
> **Nothing in gremion-ui purges by any of the four fields** (TASK-033-a): the
> in-process `audit_log` purge tick is gone, and no field is read to delete
> anything. The values are the fixed windows of the log store (Loki, rendered from the
> registry) and Löschkonzept text; the Settings tab and the generated Löschkonzept say
> so. The one database window the daily host purge applies is `plt.job_run`:
> 29 d (RC-OPS-RUN follows RC-LOG-APP, 30 d regular and cap, minus the daily tick).
> The edge and
> identity-provider logs are bounded independently and already obey the ceiling:
> raw access and Traefik logs 14 d, pseudonymised security and retained logs at most
> 29 d 2 h 5 min, Keycloak login and admin events 29 d
> (`docs/log-retention-policy.md`, "Upper bound").

### 2.1 `audit_log` (Postgres) — a governance record, never purged by a timer

The Postgres `audit_log` is the global, tamper-**evident** governance audit
trail consulted by the operator audit UI and by external compliance auditors.
**It is a governance record** (RC-GOV-CHAIN in
[`compliance/retention-catalogue.md`](compliance/retention-catalogue.md); operator
decision 2026-10-28): no timer deletes from it, it is not one of the four log tiers
above, and the application role can only append to it.

- **Table:** `audit_log` (columns: `id`, `created_at`, `user_id`, `field`,
  `old_value`, `new_value`, `correlation_id`, plus the chain columns
  `prev_hash` / `row_hash`).
- **Writer:** `writeAuditEntry` in
  [`gremion-ui/src/lib/server/audit-db.ts`](../gremion-ui/src/lib/server/audit-db.ts).
  Governance-domain writes (settings changes, committee / org-unit
  provisioning, protocol and resolution events) all land here. The actor
  (`user_id`) is a person's uuid or a component's `<token>-service` principal,
  never a name (migration 0061, TRD-147); a session without a `sub` is refused at the
  door (`hooks.server.ts`), so no actor is ever invented.
- **Tamper-evidence (governance invariant INV-1):** a `BEFORE INSERT` trigger
  hash-chains every row — `row_hash = sha256(prev_hash || canonical(row))` —
  serialized per-DB via an advisory xact lock
  ([`gremion-ui/migrations/0043_audit_log_hash_chain.sql`](../gremion-ui/migrations/0043_audit_log_hash_chain.sql)).
  `verifyAuditChain()` (in `audit-db.ts`) calls the in-DB
  `audit_log_verify_chain()` verifier and returns the id of the first broken
  row, or `{ ok: true }` when intact.
- **Append-only:** `ensureKernelAuditAppendOnly` (`packages/tenant-store`) revokes
  DELETE, UPDATE and TRUNCATE on `audit_log` (and every write on the chain anchor)
  from PUBLIC, the app role and the owner role, through the hardened admin path
  (pinned `search_path`, server-side `format('%I')`, qualified names), at
  provisioning and on `reconcile` (check `audit-append-only`). Until TASK-192 the
  app role is a member of the owner role, so this is a speed bump against a bug or
  a stray statement, not isolation from a tenant that runs arbitrary SQL as its
  own owner.
- **Erasure:** answered by redaction, not by deleting the chain (catalogue §8).
- **Not a purge:** gremion-ui schedules no purge (`purgeAuditLogsOlderThan` and the
  in-process `audit-retention` tick are removed), and neither does the host job
  `gremion-purge.timer` (`purge-run`): `PURGE_RULES` has no `audit_log` rule, and a
  test fails if one appears. The SQL function `audit_log_purge_before` of migration
  0059 stays defined but has no caller.

### 2.2 Per-module retention

The kernel does not own the data of feature modules. A module that persists
personal data ships its own retention windows and purge jobs alongside its
schema, and registers its teardown hook so a tenant delete reaches it (§3).
The kernel only guarantees the windows in the table above and the
tenant-delete crypto-shred contract.

---

## 3. Tenant delete — crypto-shred contract

Deleting a tenant must make every piece of that tenant's personal data
unrecoverable, including data already written to backups. The kernel achieves
this with **crypto-shred-first** ordering rather than a soft status flip.

- **Implementation:**
  [`gremion-ui/src/lib/server/tenant/provisioner/lifecycle.ts`](../gremion-ui/src/lib/server/tenant/provisioner/lifecycle.ts)
  (`deleteTenant`). It is pure orchestration over injected dependencies (a
  secret shredder, a DB-drop executor, the Keycloak realm-delete, registry
  functions, and an optional per-module / leaf shred hook); the operator CLI
  (`scripts/tenant-provision.ts`) supplies the live dependencies.

The ordering is fail-closed and each step is idempotent and terminal-safe:

1. **Status → `deleting`** *before* the first destructive step, so a crash
   mid-sequence leaves a visible, resumable control-plane state. The tenant
   resolver only resolves `active` rows, so a `deleting` tenant is immediately
   non-resolvable — no stale resolution during teardown.
2. **Crypto-shred the per-tenant backup key first.** The backup key is the
   single canonical location for that tenant's backup encryption; destroying it
   instantly voids **every** backup the tenant ever wrote. The same step shreds
   every live per-tenant credential file (the data-plane DB connection secret
   and every confidential-client secret). Shredding an already-gone file is a
   no-op, so a re-run is safe.
3. **Drop the data-plane DB + role** (`DROP DATABASE … IF EXISTS`).
4. **Run registered module / leaf shred hooks** (optional dependency). A module
   that owns per-tenant storage supplies a hook that drops its per-tenant
   database and removes its catalog row; both are idempotent. If the hook is
   not configured the delete still succeeds. When it *is* configured, a real
   error propagates and aborts the delete **before** the tombstone is written,
   leaving the tenant in `deleting` and the delete retryable.
5. **Delete the Keycloak realm** (`DELETE /admin/realms/<realm>`; a 404 is a
   no-op), removing the tenant's identities, sessions and event tables.
6. **Tombstone:** status → `deleted` (terminal) and the runtime is evicted.

**Identifier reuse is forbidden (subdomain-takeover defence).** The tombstone is
terminal: re-provisioning a deleted slug is refused (guarded in
`pipeline.provisionTenant`), and re-running delete on a tombstoned row is a
terminal-safe no-op. The slug stays reserved forever.

**The default (bootstrap) tenant is never deletable** — it is the global stack
root and is not tenant-lifecycle-managed. `deleteTenant` hard-refuses both the
input slug `default` and any resolved row whose slug is `default`.

---

## 4. Per-tenant data isolation

Crypto-shred-on-delete is only complete because each tenant's data is physically
isolated up front. The provision pipeline
([`gremion-ui/src/lib/server/tenant/provisioner/pipeline.ts`](../gremion-ui/src/lib/server/tenant/provisioner/pipeline.ts),
`provisionTenant`) gives every tenant:

- its **own Postgres database + role** (`t_<slug>`), with the full connection
  URL written to a per-tenant secret file (never the shared control-plane DB);
- its **own Keycloak realm** (identities, sessions, OIDC clients, event tables),
  stamped `sslRequired:'all'`;
- its **own backup encryption key** — the §3 crypto-shred target;
- its own confidential-client secrets.

Because the data, the credentials and the backup key are all per-tenant, one
tenant's purge or delete can never touch another's, and a single crypto-shred
voids exactly one tenant's backups.

---

## 5. Löschkonzept reference

The German-language Löschkonzept (deletion concept) required for data-subject
requests is **generated on demand**. The controller, data-protection-officer and
purpose fields come from the live per-tenant config; the **deletion periods are the
product's fixed windows** (`RETENTION_DEFAULTS`, tied by tests to the log-store registry
and to the catalogue), so a stored `config.retention.*` value, which nothing enforces,
can never be printed as a period that is not applied.

- **Generator:** `generateLoeschkonzept(config, asOf)` in
  [`gremion-ui/src/lib/server/loeschkonzept.ts`](../gremion-ui/src/lib/server/loeschkonzept.ts).
- **Inputs:** the per-tenant `compliance.controller_*` / `compliance.dpo_*` /
  `compliance.purpose_description` fields. The stored `retention` block is **not** read.
- **Output:** a Markdown document covering: responsible party (`§1`),
  processing purpose + Art. 6 GDPR lawful basis (`§2`), retention table per
  data category (`§3`; the basis column names the operator ceiling, and a tier
  without a purge consumer carries the `RETENTION_CAVEATS` hint that it is
  configuration, not an enforced deletion window; one further row states that the
  `audit_log` table is a governance record (RC-GOV-CHAIN) that no timer deletes),
  technical deletion mechanisms (`§4` — IP pseudonymisation, Vector + logrotate,
  encrypted backups with automatic cleanup, daily pseudonymisation-key rotation, the
  host job's daily deletion of operational rows), and the statement that the periods
  are fixed and change only with a program version (`§5`).

If a new retention category is added to `GremionConfig.retention`, the
Löschkonzept template **must** be extended in the same change — otherwise the
generated document under-reports retention to data subjects.

---

## 6. Hard caps

`writeConfig` ([`config.ts`](../gremion-ui/src/lib/server/config.ts)) clamps every
retention field to its policy maximum on every PATCH, and `readConfig` does the same
for a stored value:

```ts
// gremion-ui/src/lib/retention-tiers.ts — the one place the numbers live
RETENTION_CAPS = { access_logs_days: 29, app_logs_days: 29,
                   security_logs_days: 29, security_nopii_logs_days: 30 }
```

Operator ceiling 30 d [D R29-I6]: the caps are 29 d where a daily purge would enforce
the window (29 d + 24 h = 30 d), 30 d for the no-PII tier (§2). The caps bound what
`writeConfig` stores; the settings API accepts no `retention` key (§2), so they guard a
hand-edited config file, not a UI.

Additional non-retention hard limits enforced in the same function:

- `backups.retention_days` is floored at **7** (`Math.max(7, ...)`) — a tenant
  cannot disable backups by setting the window to zero.
- `REQUIRED_MODULES` ids are force-pinned to `true` on every write. In the
  governance-only kernel this set is **empty** (`core` and `governance` are
  non-toggleable manifests, not entries in `REQUIRED_MODULES`), so no feature
  module is forced on by the kernel; a feature module contributes its own
  required ids when present.
- `setup_complete` is append-only (`current.setup_complete || update === true`)
  — once setup is finished, the wizard cannot be re-entered via a config write.

There is no UI surface for raising a cap. To change a cap, edit
`gremion-ui/src/lib/retention-tiers.ts` (the settings API, the Settings tab and
`infra/hardening/values.yaml` follow it; a guard test fails if one keeps a private
copy), extend the Löschkonzept template (§5), and update §2 of this document.
