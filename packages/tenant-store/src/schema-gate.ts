// packages/tenant-store/src/schema-gate.ts
//
// The runtime half: is this tenant's database at its manifest? Read-only by
// construction — checkSchemaCurrent runs in a READ ONLY transaction, so it
// cannot execute DDL or write the ledger even by mistake — and a service
// never migrates on a request or at boot (B21). A database behind its
// manifest answers 503 for THAT tenant only; the runner, not the service,
// brings it current.
import type { ServerResponse } from 'node:http'
import type { Sql } from '@gremion/db'
import { loadManifest } from './manifest.js'
import { assertTenantId, isUuidV7 } from './names.js'
import { LEDGER } from './runner.js'

export type SchemaState = 'current' | 'behind' | 'diverged'

export interface SchemaStatus {
  /** current: ledger == manifest. behind: files pending. diverged: the ledger disagrees with the manifest. */
  state: SchemaState
  /** Manifest files with no ledger row. */
  pending: string[]
  /** Ledger rows with no manifest entry. */
  unknown: string[]
  /** Ledger rows whose sha256 differs from the manifest's. */
  mismatched: string[]
}

export interface CheckSchemaOptions {
  sql: Sql
  /** The module's migrations directory (manifest.json is read). */
  dir?: string
  /** Or the manifest itself, already loaded (schemaGate loads it once). */
  manifest?: ReadonlyMap<string, string>
}

export async function checkSchemaCurrent({ sql, dir, manifest }: CheckSchemaOptions): Promise<SchemaStatus> {
  const expected = manifest ?? (dir !== undefined ? loadManifest(dir) : undefined)
  if (!expected) throw new TypeError('checkSchemaCurrent needs dir or manifest')
  // An empty manifest would call every database current.
  if (expected.size === 0) throw new TypeError('checkSchemaCurrent: the manifest lists no migration')
  type Row = { filename: string; sha256: string }
  const rows = (await sql.begin('read only', async (tx) => {
    const [reg] = await tx<{ present: boolean }[]>`SELECT to_regclass(${LEDGER}) IS NOT NULL AS present`
    if (!reg?.present) return []
    return [...(await tx<Row[]>`SELECT filename, sha256 FROM public.schema_migrations`)]
  })) as Row[]
  const inLedger = new Map(rows.map((r) => [r.filename, r.sha256]))
  const pending = [...expected.keys()].filter((f) => !inLedger.has(f)).sort()
  const unknown = [...inLedger.keys()].filter((f) => !expected.has(f)).sort()
  const mismatched = [...inLedger].filter(([f, h]) => expected.has(f) && expected.get(f) !== h).map(([f]) => f).sort()
  const state: SchemaState = unknown.length || mismatched.length ? 'diverged' : pending.length ? 'behind' : 'current'
  return { state, pending, unknown, mismatched }
}

export type GateResult = { ok: true } | { ok: false; reason: SchemaState | 'unavailable'; retryAfterSeconds: number }

export interface SchemaGateOptions {
  /** The module's migrations directory; manifest.json is loaded ONCE, here. */
  dir: string
  /** The tenant's database for this gate's module (usually store.openTenantDb(t, module)). */
  openDb: (tenantId: string) => Promise<Sql>
  /** Retry-After on a 503. Default 30. */
  retryAfterSeconds?: number
  /** How long a verdict is reused per tenant. Default 5000 ms; 0 checks every request. */
  cacheTtlMs?: number
  log?: (line: string) => void
  now?: () => number
}

export interface SchemaGate {
  check(tenantId: string): Promise<GateResult>
  /**
   * Answers 503 (Retry-After) and returns false when the tenant is not
   * current; answers 404 and returns false for an id that is not a UUIDv7;
   * else returns true.
   */
  guard(tenantId: string, res: ServerResponse): Promise<boolean>
}

/**
 * ONE GATE PER MODULE (per migrations directory): the verdict cache is keyed
 * by tenant within that module, so a gate shared by two modules would answer
 * one module's verdict for the other. A check that fails (database down) is
 * a 503 too and is never cached.
 */
export function schemaGate(options: SchemaGateOptions): SchemaGate {
  const manifest = loadManifest(options.dir)
  const retryAfterSeconds = options.retryAfterSeconds ?? 30
  const ttl = options.cacheTtlMs ?? 5000
  const log = options.log ?? ((l) => console.warn(`[tenant-store] ${l}`))
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; result: GateResult }>()

  async function check(tenantId: string): Promise<GateResult> {
    assertTenantId(tenantId)
    const hit = cache.get(tenantId)
    if (hit && now() - hit.at < ttl) return hit.result
    let result: GateResult
    try {
      const status = await checkSchemaCurrent({ sql: await options.openDb(tenantId), manifest })
      result = status.state === 'current' ? { ok: true } : { ok: false, reason: status.state, retryAfterSeconds }
      if (!result.ok) {
        log(`tenant ${tenantId} schema ${status.state}: pending [${status.pending.join(', ')}] unknown [${status.unknown.join(', ')}] mismatched [${status.mismatched.join(', ')}]`)
      }
      if (ttl > 0) cache.set(tenantId, { at: now(), result })
    } catch (err) {
      log(`tenant ${tenantId} schema check failed: ${(err as Error).message}`)
      cache.delete(tenantId)
      result = { ok: false, reason: 'unavailable', retryAfterSeconds }
    }
    return result
  }

  return {
    check,
    async guard(tenantId, res) {
      if (!isUuidV7(tenantId)) {
        // Not a tenant: answer, never throw into the caller's handler.
        res.writeHead(404, { 'cache-control': 'no-store' }).end()
        return false
      }
      const result = await check(tenantId)
      if (result.ok) return true
      // The body names no file and no other tenant; details go to the log.
      res
        .writeHead(503, { 'retry-after': String(result.retryAfterSeconds), 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ error: 'schema_not_current' }))
      return false
    },
  }
}
