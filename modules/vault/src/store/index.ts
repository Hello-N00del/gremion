// services/vault/src/store/index.ts
//
// The vault leaf's Postgres store: domain types, the re-exported migration runner
// (defined in ../migrations.ts), a single-DB connection accessor, and the
// vault-item / secret-reveal / access-log query ops.
//
// The ops take an explicit `sql` handle as their first argument so tests can inject
// a pre-seeded pool (mirrors the services/board leaf store-op shape). This leaf owns
// a SINGLE database (VAULT_PG_URL). Secrets are stored ONLY as AES-256-GCM
// ciphertext (src/crypto.ts encrypts at the route layer); the metadata surface
// (list/get/create responses) NEVER selects the ciphertext column, so a secret can
// leave the process only through the explicit GET /items/:id/secret reveal path,
// which also records an access_log row.

import postgres from 'postgres'
import { runMigrations, _resetMigrationCacheForTests } from '../migrations.js'

// Re-export the migration runner (relocated to src/migrations.ts at depth 1 so its
// MIGRATIONS_DIR resolves correctly from the depth-1 esbuild bundle as well as the
// source tree) so existing `store/index` importers keep working.
export { runMigrations }

/**
 * Resolve the runtime Postgres URL, failing closed. In production VAULT_PG_URL is
 * set; we deliberately DO NOT fall back to localhost:5432 — on the staging host
 * that port is the LIVE kernel Postgres (#394 require-explicit-env posture). Fires
 * only when neither an explicit pgUrl nor the env var is set (a misconfiguration).
 */
export function requireRuntimePgUrl(explicit: string | undefined, envName: string): string {
  const url = explicit || process.env[envName]
  if (!url) {
    throw new Error(
      `[vault] no Postgres URL configured — set ${envName} (or pass options.pgUrl). ` +
        'Refusing to default to localhost:5432 (the LIVE kernel Postgres on the staging host).',
    )
  }
  return url
}

// ── types ─────────────────────────────────────────────────────────────────────

export type Sql = ReturnType<typeof postgres>

/** Minimal tenant identity carried on guard-validated headers (kept for HTTP
 *  handler-signature parity with the other leaves; the single-DB store ignores
 *  it today). */
export interface TenantRef {
  readonly id: string
  readonly slug: string
}

/**
 * A vault item as returned on the METADATA surface — deliberately has NO
 * secret_ciphertext field. The secret only ever leaves via revealSecret().
 */
export interface VaultItem {
  readonly id: string
  readonly org_unit_id: string
  readonly name: string
  readonly username: string | null
  readonly url: string | null
  readonly notes: string | null
  readonly created_by: string | null
  readonly created_at: Date
}

// Every metadata query below selects the EXPLICIT non-secret column list inline
// (never `*` and never the secret_ciphertext column), so a secret can never
// accidentally ride along on the list / get / create surface.

// ── single-DB connection accessor ────────────────────────────────────────────

let _pool: Sql | null = null

export interface StoreOptions {
  pgUrl?: string
}

/**
 * Return the leaf's single ready postgres-js pool, creating it (and running the
 * manifest-verified migrations) on first contact. Identity guarantee: repeated
 * calls return the SAME pool until _resetStoreForTests() drains it.
 */
export async function getStore(options: StoreOptions = {}): Promise<Sql> {
  if (_pool) return _pool
  const pgUrl = requireRuntimePgUrl(options.pgUrl, 'VAULT_PG_URL')
  await runMigrations(pgUrl)
  _pool = postgres(pgUrl, { max: 4, prepare: true, idle_timeout: 20, connect_timeout: 10 })
  return _pool
}

/** TEST-ONLY: drain the pool + clear the manifest cache. */
export async function _resetStoreForTests(): Promise<void> {
  if (_pool !== null) {
    await _pool.end().catch(() => {})
    _pool = null
  }
  _resetMigrationCacheForTests()
}

// ── store ops ─────────────────────────────────────────────────────────────────

export async function createItem(
  sql: Sql,
  data: {
    orgUnitId: string
    name: string
    secretCiphertext: string
    username?: string | null
    url?: string | null
    notes?: string | null
    createdBy?: string | null
  },
): Promise<VaultItem> {
  const rows = await sql<VaultItem[]>`
    INSERT INTO vault_item (org_unit_id, name, username, url, notes, secret_ciphertext, created_by)
    VALUES (${data.orgUnitId}, ${data.name}, ${data.username ?? null}, ${data.url ?? null},
            ${data.notes ?? null}, ${data.secretCiphertext}, ${data.createdBy ?? null})
    RETURNING id, org_unit_id, name, username, url, notes, created_by, created_at`
  return rows[0]!
}

export async function listItemsForOrgUnits(sql: Sql, orgUnitIds: readonly string[]): Promise<readonly VaultItem[]> {
  if (orgUnitIds.length === 0) return []
  return sql<VaultItem[]>`
    SELECT id, org_unit_id, name, username, url, notes, created_by, created_at FROM vault_item
    WHERE org_unit_id IN ${sql(orgUnitIds as string[])} ORDER BY name`
}

export async function getItem(sql: Sql, id: string): Promise<VaultItem | null> {
  const rows = await sql<VaultItem[]>`
    SELECT id, org_unit_id, name, username, url, notes, created_by, created_at FROM vault_item WHERE id = ${id}`
  return rows[0] ?? null
}

/**
 * Reveal the stored ciphertext for an item AND record one access_log row. Returns
 * the raw ciphertext (the route layer decrypts it) or null when the item does not
 * exist — in which case NO access_log row is written. Exactly one row is written
 * per successful reveal.
 *
 * The audit row is complete: actor (accessedBy — a required caller user-id the
 * route layer enforces), item, collection (the item's org_unit_id, read here so
 * the caller cannot spoof it), tenant (from the guard-validated header), the
 * DB-default timestamp, AND the item name (snapshotted at reveal time, mig 002,
 * so the audit row stays readable after the item is deleted).
 */
export async function revealSecret(
  sql: Sql,
  id: string,
  accessedBy: string,
  tenantId: string,
): Promise<string | null> {
  const rows = await sql<
    { secret_ciphertext: string; org_unit_id: string; name: string }[]
  >`SELECT secret_ciphertext, org_unit_id, name FROM vault_item WHERE id = ${id}`
  const row = rows[0]
  if (!row) return null
  await sql`
    INSERT INTO access_log (item_id, org_unit_id, tenant_id, accessed_by, item_name)
    VALUES (${id}, ${row.org_unit_id}, ${tenantId}, ${accessedBy}, ${row.name})`
  return row.secret_ciphertext
}

/**
 * Update an item's metadata (org_unit_id / name / username / url / notes) and —
 * when a new ciphertext is provided — its stored secret (#405 design v11: the
 * former "no edit route" runbook residual). Semantics per field: absent = keep,
 * null = clear (nullable columns only). Returns the updated item's METADATA (no
 * secret column, matching every other surface) or null when the id does not
 * exist. An empty patch is a no-op read.
 */
export async function updateItem(
  sql: Sql,
  id: string,
  patch: {
    orgUnitId?: string
    name?: string
    username?: string | null
    url?: string | null
    notes?: string | null
    secretCiphertext?: string
  },
): Promise<VaultItem | null> {
  const cols: Record<string, string | null> = {}
  if (patch.orgUnitId !== undefined) cols['org_unit_id'] = patch.orgUnitId
  if (patch.name !== undefined) cols['name'] = patch.name
  if (patch.username !== undefined) cols['username'] = patch.username
  if (patch.url !== undefined) cols['url'] = patch.url
  if (patch.notes !== undefined) cols['notes'] = patch.notes
  if (patch.secretCiphertext !== undefined) cols['secret_ciphertext'] = patch.secretCiphertext
  if (Object.keys(cols).length === 0) return getItem(sql, id)
  const rows = await sql<VaultItem[]>`
    UPDATE vault_item SET ${sql(cols)} WHERE id = ${id}
    RETURNING id, org_unit_id, name, username, url, notes, created_by, created_at`
  return rows[0] ?? null
}

/** One reveal-audit row (#405 design v11: the Zugriffsprotokoll read surface).
 *  item_name is SNAPSHOTTED onto the row at reveal time (mig 002) so the audit
 *  trail SURVIVES item deletion — the append-only promise the /vault surface
 *  makes; pre-002 rows fall back to the live item name via LEFT JOIN. */
export interface AccessLogEntry {
  readonly id: string
  readonly item_id: string
  readonly item_name: string
  readonly org_unit_id: string
  readonly accessed_by: string
  readonly accessed_at: Date
}

/**
 * List reveal-audit rows for the given org-unit scope, newest first, paginated
 * by limit/offset. Empty scope → [] (mirrors listItemsForOrgUnits). The leaf
 * trusts the caller's orgUnitIds — the KERNEL enforces the org-unit scope gate
 * (resolveVaultOrgUnitScope) before calling this, exactly like the /items list.
 */
export async function listAccessLog(
  sql: Sql,
  orgUnitIds: readonly string[],
  opts: { limit: number; offset: number },
): Promise<readonly AccessLogEntry[]> {
  if (orgUnitIds.length === 0) return []
  return sql<AccessLogEntry[]>`
    SELECT al.id, al.item_id,
           COALESCE(al.item_name, vi.name) AS item_name,
           al.org_unit_id, al.accessed_by, al.accessed_at
    FROM access_log al
    LEFT JOIN vault_item vi ON vi.id = al.item_id
    WHERE al.org_unit_id IN ${sql(orgUnitIds as string[])}
    ORDER BY al.accessed_at DESC, al.id DESC
    LIMIT ${opts.limit} OFFSET ${opts.offset}`
}

/** Delete an item. Its access_log rows SURVIVE (mig 002 dropped the CASCADE and
 *  snapshots item_name at reveal time) — deleting an item never erases the audit
 *  trail of its reveals. Returns true when a row was removed, false when the id
 *  did not exist. */
export async function deleteItem(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`DELETE FROM vault_item WHERE id = ${id} RETURNING id`
  return rows.length > 0
}
