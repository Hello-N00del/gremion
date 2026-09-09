// src/lib/server/tenant/provisioner/lifecycle.ts
// P2.1c (T17, §8.7) — the tenant DELETE lifecycle: crypto-shred-on-delete with a
// crypto-shred-FIRST ordering (design `2026-06-08-pillar2-tenancy-design.md`
// §3-step-9 / §7.9 / R8). PURE orchestration over INJECTED dependencies (a secret
// shredder, a DB-drop executor, the KC realm-delete, registry fns) so the
// fail-closed ordering is unit-testable with fully-mocked subsystems; the CLI
// (scripts/tenant-provision.ts cmdDelete) supplies the live deps.
//
// The §8.7 contract (design §3-step-9): `delete` destroys the per-tenant backup
// key FIRST — that instantly crypto-shreds EVERY backup the tenant ever wrote (the
// key is the §7.9 exactly-one canonical location) — THEN drops the data-plane DB +
// role, THEN deletes the realm, THEN marks NC/Matrix for MANUAL teardown (silo
// satellites this operator script cannot reach), and FINALLY tombstones the row
// `status='deleted'`. Identifier reuse is forbidden on delete (§7.8,
// subdomain-takeover defence): the tombstone is terminal — a re-provision of a
// deleted slug refuses (guarded in pipeline.provisionTenant), and re-running
// delete on a tombstoned row is a terminal-safe no-op.
//
// Resumability: the row is flipped to 'deleting' BEFORE the first destructive
// step, so a crash mid-sequence leaves a VISIBLE, resumable state in the control
// plane (the row is not 'active', so the resolver 404s it — no stale resolution).
// A re-run from 'deleting' replays every step; each step is idempotent and
// terminal-safe (re-shredding an already-shredded key is harmless; DROP … IF
// EXISTS; DELETE realm tolerates 404), so re-runs converge on 'deleted'.
//
// suspend/resume are the trivial status flips that ALSO evict the runtime — they
// route through registry.updateTenantStatus (the ONE lifecycle seam, P2.1b T8),
// which is wired directly in the CLI (cmdStatusFlip); this module owns only the
// multi-step DELETE that needs the shred/drop/realm-delete ordering.
import { validateSlug, dbNameForSlug } from '$lib/server/tenant/slug'
import { PROVISIONER_SECRET_CLIENTS } from './realm-doc'
import { tenantSecretHostPath } from '$lib/server/tenant/secrets'
import type { Tenant, TenantStatus, TenantSubsystem } from '$lib/server/tenant/registry'

/** Host-side DB admin executor for the delete path — drops the per-tenant DB +
 *  role (the inverse of pipeline.ProvisionDbExecutor.createDatabaseAndRole). */
export interface DeleteDbExecutor {
  /** Idempotent: DROP DATABASE … (WITH FORCE) IF EXISTS + DROP ROLE IF EXISTS. */
  dropDatabaseAndRole(dbName: string, roleName: string): Promise<void>
}

/** The KC Admin-API surface the delete path needs (realm teardown). */
export interface DeleteKc {
  /** Idempotent: DELETE /admin/realms/<realm>; a 404 (already gone) is a no-op. */
  deleteRealm(realm: string): Promise<void>
}

/** The registry surface the delete path needs (real registry.ts fns, or mocks). */
export interface DeleteRegistry {
  getTenantBySlug(slug: string): Promise<Tenant | null>
  updateTenantStatus(tenantId: string, status: TenantStatus): Promise<Tenant | null>
  markTenantResourceFailed(tenantId: string, subsystem: TenantSubsystem, error: string): Promise<void>
  evictTenantRuntime(tenantId: string): void
}

/** T21 (§8.7) — the leaf newsletter-PG shred surface called during tenant delete.
 *  Drops the per-tenant newsletter DB and removes the catalog row from the leaf
 *  control DB. Both operations are idempotent (IF EXISTS / no-op on missing row),
 *  so a re-run after a partial delete is safe. */
export interface LeafShredExecutor {
  /** Idempotent: DROP DATABASE newsletter_<slug> IF EXISTS on the leaf PG. */
  dropNewsletterDb(slug: string): Promise<void>
  /** Idempotent: DELETE FROM tenant_catalog WHERE tenant_id = <tenantId>. */
  deleteCatalogRow(tenantId: string): Promise<void>
}

export interface DeleteDeps {
  /** Crypto-shred: securely delete the given HOST secret-file paths. Idempotent
   *  (a missing path is a no-op) so a re-run after a partial shred is safe. */
  shredSecretFiles(paths: readonly string[]): Promise<void>
  db: DeleteDbExecutor
  kc: DeleteKc
  registry: DeleteRegistry
  /** The HOST root for per-tenant secret files (mirrors tenantSecretHostPath). */
  tenantSecretsDir: string
  /** T21 (§8.7) — optional: if the newsletter leaf PG is provisioned, shred its
   *  per-tenant DB + catalog row. A missing dep (leaf === undefined/null) means the
   *  leaf is not configured; the delete succeeds without it (no error).
   *  When `leaf` IS set, shred errors PROPAGATE — `DROP DATABASE IF EXISTS` and a
   *  catalog DELETE that affects 0 rows are already benign (no throw), so a real
   *  throw means a genuine failure that must ABORT the delete before the tombstone
   *  is written, leaving the tenant in 'deleting' and the delete retryable. */
  leaf?: LeafShredExecutor
}

export interface DeleteResult {
  slug: string
  /** True when this run actually performed the destructive sequence; false when
   *  the tenant was already a tombstone (terminal-safe no-op). */
  shredded: boolean
  /** The host secret paths that were shredded (empty on the no-op path). */
  shreddedPaths: readonly string[]
}

/** The default tenant is the bootstrap root (env-keyed secrets, the global stack);
 *  its data + key are NEVER tenant-lifecycle-managed (design §3 bootstrap caveat). */
const DEFAULT_SLUG = 'default'

/**
 * Translate a per-tenant `file:` secret REF to its HOST path, or null for a
 * non-file ref (e.g. the default tenant's `env:` refs — nothing to shred). Reuses
 * tenantSecretHostPath so the shred target is the SAME path the backup script
 * (T16) and provisioner (T10) write.
 */
function hostPathForRef(ref: string | null | undefined): string | null {
  if (!ref || !ref.startsWith('file:')) return null
  return tenantSecretHostPath(ref)
}

/**
 * Collect EVERY per-tenant secret-file host path to crypto-shred for `tenant`:
 * the backup key FIRST (the §7.9 exactly-one location — shredding it voids all
 * backups), then the data-plane DB credential and every confidential-client
 * secret, so no live credential outlives the tenant. Deterministic file names
 * mirror pipeline.provisionTenant; refs that are not `file:` (default-tenant
 * `env:` refs) contribute nothing. De-duplicated, backup key first.
 */
function shredTargets(tenant: Tenant, tenantSecretsDir: string): string[] {
  const root = tenantSecretsDir.replace(/\/$/, '')
  const fromName = (name: string) => `${root}/${name}`
  const paths: string[] = []
  // (1) the backup key FIRST — the crypto-shred that voids all backups. Resolve it
  // BOTH via the registry ref (the §7.9 exactly-one-location source of truth) AND
  // via the deterministic name on the PASSED tenantSecretsDir: tenantSecretHostPath
  // resolves the ref RELATIVE to CWD (`./secrets/tenants`), which silently misses
  // the real absolute file when the CLI runs from a different CWD (e.g. under
  // `pnpm -C gremion-ui`) — leaving the key un-shredded and §7.9 violated. The
  // name-based path uses the same absolute base as the db/client secrets below.
  const keyPath = hostPathForRef(tenant.backupKeyRef)
  if (keyPath) paths.push(keyPath)
  paths.push(fromName(`tenant_${tenant.slug}_backup_key`))
  // (2) the data-plane DB credential + every confidential-client secret. These
  // are deterministic per-tenant file names (pipeline.provisionTenant), placed
  // here directly so a ref the registry never stored (e.g. extra clients) is
  // still covered by the slug-derived name set.
  paths.push(fromName(`tenant_${tenant.slug}_db`))
  for (const client of PROVISIONER_SECRET_CLIENTS) {
    paths.push(fromName(`tenant_${tenant.slug}_client_${client}`))
  }
  // De-dup while preserving order (the backup key stays first).
  return [...new Set(paths)]
}

/**
 * Crypto-shred-on-delete (§8.7). See the file header for the full contract.
 * Order: status->deleting → KEY SHRED (first) → DB drop → realm delete → NC/Matrix
 * marked for manual teardown → tombstone status='deleted' + evict runtime.
 * Idempotent + resumable; the default tenant is hard-refused; a tombstoned slug
 * is a terminal-safe no-op (§7.8 — the slug is never reusable).
 */
export async function deleteTenant(slugInput: string, deps: DeleteDeps): Promise<DeleteResult> {
  // (0) slug guard before ANY subsystem touch.
  const v = validateSlug(slugInput)
  if (!v.ok) throw new Error(`invalid slug "${slugInput}": ${v.reason}`)
  const slug = v.slug

  // (0a) the default tenant is NEVER deletable (bootstrap root — hard guard).
  if (slug === DEFAULT_SLUG) {
    throw new Error('refusing to delete the default tenant (bootstrap root — not lifecycle-managed)')
  }

  const tenant = await deps.registry.getTenantBySlug(slug)
  if (!tenant) throw new Error(`unknown tenant "${slug}"`)
  // Belt-and-braces: the RESOLVED ROW must not be the default tenant either —
  // compare the row's SLUG (the identifier) to DEFAULT_SLUG, not its id (a UUID
  // that is never the literal 'default'). This defends in depth if a registry
  // lookup ever returned the default row for a non-`default` input slug; the
  // (0a) guard above already covers the input-slug==='default' path.
  if (tenant.slug === DEFAULT_SLUG) {
    throw new Error('refusing to delete the default tenant (bootstrap root — not lifecycle-managed)')
  }

  // (0b) §7.8 tombstone is terminal — a re-run on an already-deleted tenant is a
  // no-op (the destructive work is done; the slug stays reserved forever).
  if (tenant.status === 'deleted') {
    return { slug, shredded: false, shreddedPaths: [] }
  }

  const tenantId = tenant.id

  // (1) flip to 'deleting' BEFORE the first destructive step, so a mid-sequence
  // crash leaves a VISIBLE resumable state (the resolver already 404s non-active
  // rows). Idempotent — a re-run from 'deleting' just re-sets it.
  await deps.registry.updateTenantStatus(tenantId, 'deleting')

  // (2) CRYPTO-SHRED FIRST — destroy the per-tenant backup key (voids all backups
  // instantly) plus every live per-tenant credential file. Idempotent: shredding
  // an already-gone file is a no-op, so a re-run is terminal-safe.
  const shreddedPaths = shredTargets(tenant, deps.tenantSecretsDir)
  await deps.shredSecretFiles(shreddedPaths)

  // (3) drop the data-plane DB + role (idempotent: DROP … IF EXISTS).
  const dbName = dbNameForSlug(slug) // t_<slug>
  await deps.db.dropDatabaseAndRole(dbName, dbName)

  // (3b) T21 §8.7 — leaf shred: drop the newsletter_<slug> DB on the leaf PG +
  // delete the tenant_catalog row. A missing `deps.leaf` means the leaf is not
  // configured — skip cleanly, no error. When `deps.leaf` IS set, do NOT swallow
  // errors: `DROP DATABASE IF EXISTS` + a catalog DELETE on a missing row are
  // already no-ops, so a real throw signals a genuine failure (transient PG
  // connection, permission, etc.) that MUST abort the delete before the tombstone
  // is written. The tenant remains in 'deleting', and a re-run re-attempts the
  // leaf shred (deleteTenant is idempotent up to the tombstone).
  if (deps.leaf) {
    await deps.leaf.dropNewsletterDb(slug)
    await deps.leaf.deleteCatalogRow(tenantId)
  }

  // (4) delete the realm (idempotent: 404 tolerated).
  await deps.kc.deleteRealm(tenant.realmName)

  // (5) NC/Matrix are silo satellites the operator script cannot reach — flag them
  // for MANUAL teardown in the ledger (the runbook documents the residual).
  await deps.registry.markTenantResourceFailed(tenantId, 'nextcloud', 'crypto-shred delete: manual teardown required')
  await deps.registry.markTenantResourceFailed(tenantId, 'matrix', 'crypto-shred delete: manual teardown required')

  // (6) TOMBSTONE — status='deleted' (terminal; the slug stays reserved, §7.8) and
  // evict the runtime (updateTenantStatus also evicts, but evict again so a CLI
  // mock of updateTenantStatus that skips eviction still drops the handles).
  await deps.registry.updateTenantStatus(tenantId, 'deleted')
  deps.registry.evictTenantRuntime(tenantId)

  return { slug, shredded: true, shreddedPaths }
}
