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
- Auto-generated German-language Löschkonzept (per-tenant, served to data
  subjects): [`gremion-ui/src/lib/server/loeschkonzept.ts`](../gremion-ui/src/lib/server/loeschkonzept.ts).

---

## 1. GDPR Art. 5(1)(e) — retention principles

Art. 5(1)(e) requires personal data to be kept in a form which permits
identification of data subjects for no longer than is necessary for the
purposes for which it is processed. In the kernel that obligation is discharged
in three layers:

1. **Configurable retention windows** held per tenant in `GremionConfig.retention`
   ([`gremion-ui/src/lib/server/config.ts`](../gremion-ui/src/lib/server/config.ts)).
   The defaults track the BSI Mindeststandard Protokollierung v2.1 (Nov 2024)
   and the BayLDA recommendation for access logs.
2. **Scheduled purge jobs** that hard-delete rows older than the configured
   window. The scheduler runs inside the SvelteKit server process so it picks
   up live config changes without a redeploy, and runs once per **active**
   tenant against that tenant's own data plane (see §2.1).
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
(`GremionConfig.retention`). Hard caps are enforced inside `writeConfig`
(`Math.min` clamp) so a malicious or careless PATCH cannot lengthen retention
beyond policy.

| Field | Default | Hard cap | Legal basis | Implementation |
|---|---|---|---|---|
| `access_logs_days` | 14 | **30** | BayLDA recommendation; Art. 5(1)(e) | reverse-proxy / container log rotation — see `docs/log-retention-policy.md` |
| `app_logs_days` | 30 | **90** | Art. 5(1)(e); Art. 6(1)(f) legitimate interest | Vector retention filter + logrotate backstop |
| `security_logs_days` | 90 | **180** | BSI Mindeststandard Protokollierung v2.1 | `purgeAuditLogsOlderThan` (see §2.1) |
| `security_nopii_logs_days` | 90 | **365** | BSI Mindeststandard exception (no PII) | Vector retention filter |

### 2.1 `audit_log` (Postgres) — security-log retention

The Postgres `audit_log` is the global, tamper-**evident** governance audit
trail consulted by the operator audit UI and by external compliance auditors.
Its retention window must be controlled by policy, not by an ops tool.

- **Table:** `audit_log` (columns: `id`, `created_at`, `user_id`, `field`,
  `old_value`, `new_value`, `correlation_id`, plus the chain columns
  `prev_hash` / `row_hash`).
- **Writer:** `writeAuditEntry` in
  [`gremion-ui/src/lib/server/audit-db.ts`](../gremion-ui/src/lib/server/audit-db.ts).
  Governance-domain writes (settings changes, committee / org-unit
  provisioning, protocol and resolution events) all land here.
- **Tamper-evidence (governance invariant INV-1):** a `BEFORE INSERT` trigger
  hash-chains every row — `row_hash = sha256(prev_hash || canonical(row))` —
  serialized per-DB via an advisory xact lock
  ([`gremion-ui/migrations/043_audit_log_hash_chain.sql`](../gremion-ui/migrations/043_audit_log_hash_chain.sql)).
  `verifyAuditChain()` (in `audit-db.ts`) calls the in-DB
  `audit_log_verify_chain()` verifier and returns the id of the first broken
  row, or `{ ok: true }` when intact. Retention prunes from the chain tail
  (oldest first), so pruning never breaks the live chain.
- **Purge function:** `purgeAuditLogsOlderThan(days)` (in `audit-db.ts`)
  hard-deletes rows with `created_at < now() - $days * INTERVAL '1 day'` and
  returns the row count.
- **Scheduler:**
  [`gremion-ui/src/hooks.server.ts`](../gremion-ui/src/hooks.server.ts) runs every
  24 h. The interval callback iterates **every active tenant**
  (`forEachActiveTenant('audit-retention', …)`), establishes that tenant's
  context, reads its `config.retention.security_logs_days` (fallback 90), and
  calls `purgeAuditLogsOlderThan` against that tenant's data plane. The
  interval is `.unref()`-ed so it does not keep the process alive during
  graceful shutdown / test teardown.

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
requests is **generated on demand** from the live config so it can never drift
from the retention windows the system actually enforces.

- **Generator:** `generateLoeschkonzept(config, asOf)` in
  [`gremion-ui/src/lib/server/loeschkonzept.ts`](../gremion-ui/src/lib/server/loeschkonzept.ts).
- **Inputs:** the full per-tenant config (retention windows + the
  `compliance.controller_*` / `compliance.dpo_*` / `compliance.purpose_description`
  fields).
- **Output:** a Markdown document covering: responsible party (`§1`),
  processing purpose + Art. 6 GDPR lawful basis (`§2`), retention table per
  data category (`§3`), technical deletion mechanisms (`§4` — IP
  pseudonymisation, Vector + logrotate, encrypted backups with automatic
  cleanup, daily pseudonymisation-key rotation), and a change-history pointer to
  the `audit_log` table (`§5`).

If a new retention category is added to `GremionConfig.retention`, the
Löschkonzept template **must** be extended in the same change — otherwise the
generated document under-reports retention to data subjects.

---

## 6. Hard caps

`writeConfig` ([`config.ts`](../gremion-ui/src/lib/server/config.ts)) clamps every
retention field to its policy maximum on every PATCH:

```ts
mergedRetention.access_logs_days         = Math.min(..., 30)   // BayLDA
mergedRetention.app_logs_days            = Math.min(..., 90)
mergedRetention.security_logs_days       = Math.min(..., 180)  // BSI v2.1
mergedRetention.security_nopii_logs_days = Math.min(..., 365)
```

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

There is no UI surface for raising a cap. To change a cap, edit `config.ts`,
extend the Löschkonzept template (§5), and update §2 of this document.
