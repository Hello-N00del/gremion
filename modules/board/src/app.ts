// modules/board/src/app.ts
//
// The board leaf's single construction path (R29-BOARD-STORE-K §3.2): index.ts
// and every suite build the leaf through buildApp(env), so a test exercises the
// exact wiring the process runs.
//
// One database per (tenant, board) (D13): every guarded route gets its pool
// from ONE createTenantStore() as openTenantDb(tenant.id, 'board'), resolved
// from GREMION_BOARD_PG_URL (the module server; the path is replaced by
// t_<hex32>__board), behind ONE schemaGate over this module's migrations. The
// leaf never creates or migrates a database: enableModule does (B21).

import type http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTenantStore, envResolveTarget, moduleUrlVariable, schemaGate } from '@gremion/tenant-store'
import { createServer } from './http/server.js'
import { buildApiRoutes } from './http/routes.js'
import type { Sql, TenantRef } from './store/index.js'
import { createBoardTenantDb, MODULE_ID, type Refusal } from './store/tenant-db.js'

// The board module's migrations directory — resolved HERE, at src/ DEPTH 1, on
// purpose (moved verbatim from the retired src/migrations.ts):
// esbuild bundles the whole leaf into a
// SINGLE depth-1 file (dist/index.js): a depth-1 source location + one '..'
// resolves MIGRATIONS_DIR to <leaf>/migrations from the source tree AND to
// /app/migrations from the bundle under WORKDIR /app (Dockerfile copies
// migrations → /app/migrations). A depth-2 location (src/store/index.ts, two
// '..') is correct from source but resolves to /migrations from the bundle,
// which fails ENOENT on the first getStore() call in BOARD_BACKEND=service mode.
// (Today the failure is at boot: the schema gate loads manifest.json when
// buildApp constructs it.) test/store-seam.test.ts and test/bundle-smoke.mjs
// guard this.
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export type BoardEnv = Readonly<Record<string, string | undefined>>

export interface BoardApp {
  /** node:http server, not yet listening. */
  server: http.Server
  /** The exact store function handed to buildApiRoutes. */
  storeFor(tenant: TenantRef): Promise<Sql | Refusal>
  /** server.close + every tenant pool. */
  close(): Promise<void>
}

export interface BuildAppOptions {
  /** Where the schema gate's lines go (default console.warn). */
  log?: (line: string) => void
}

/** A well-formed v7 id, used only to prove at boot that the module server url resolves. */
const PROBE_TENANT = '00000000-0000-7000-8000-000000000000'

/**
 * Builds the leaf. Throws (one line naming the variable) when
 * GREMION_BOARD_PG_URL is unset or unusable: a leaf that boots healthy and then
 * fails every call is a silent failure, and there is no localhost:5432 default
 * (#394). Also throws when the migrations manifest cannot be read (the gate
 * loads it here).
 */
export function buildApp(env: BoardEnv, opts: BuildAppOptions = {}): BoardApp {
  const variable = moduleUrlVariable(MODULE_ID)
  if (!env[variable]) {
    throw new Error(`[board] ${variable} is not set: refusing to start (the leaf opens t_<tenant>__board on that server; there is no default)`)
  }
  const resolveTarget = envResolveTarget(env)
  try {
    resolveTarget(PROBE_TENANT, MODULE_ID)
  } catch (err) {
    throw new Error(`[board] ${variable} is unusable: ${(err as Error).message}`)
  }
  const store = createTenantStore({ resolveTarget, maxPools: 64 })
  const gate = schemaGate({
    dir: MIGRATIONS_DIR,
    openDb: (tenantId) => store.openTenantDb(tenantId, MODULE_ID),
    ...(opts.log ? { log: opts.log } : {}),
  })
  const tenantDb = createBoardTenantDb({ store, gate })
  const storeFor = (tenant: TenantRef): Promise<Sql | Refusal> => tenantDb.resolve(tenant.id)
  const server = createServer({ secret: env.INTERNAL_BOARD_SECRET, routes: buildApiRoutes(storeFor) })
  return {
    server,
    storeFor,
    async close() {
      const closed = await new Promise<Error | undefined>((resolve) => {
        if (!server.listening) return resolve(undefined)
        server.close((err) => resolve(err))
      })
      await store.close()
      if (closed) throw closed
    },
  }
}
