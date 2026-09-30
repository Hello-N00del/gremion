// modules/board/src/app.ts
//
// The board leaf's single construction path (R29-BOARD-STORE-K §3.2): index.ts
// and every suite build the leaf through buildApp(env), so a test exercises the
// exact wiring the process runs.
//
// Item 4 (behaviour-preserving extraction): buildApp wraps today's single-DB
// wiring unchanged — storeFor ignores the tenant and returns the one pool.

import type http from 'node:http'
import { createServer } from './http/server.js'
import { buildApiRoutes } from './http/routes.js'
import { getStore, _resetStoreForTests, type Sql, type TenantRef } from './store/index.js'

export type BoardEnv = Readonly<Record<string, string | undefined>>

export interface BoardApp {
  /** node:http server, not yet listening. */
  server: http.Server
  /** The exact store function handed to buildApiRoutes. */
  storeFor(tenant: TenantRef): Promise<Sql>
  /** server.close + the store's pools. */
  close(): Promise<void>
}

export function buildApp(env: BoardEnv): BoardApp {
  const storeFor = (_tenant: TenantRef): Promise<Sql> => getStore({ pgUrl: env.BOARD_PG_URL })
  const server = createServer({ secret: env.INTERNAL_BOARD_SECRET, routes: buildApiRoutes(storeFor) })
  return {
    server,
    storeFor,
    async close() {
      const closed = await new Promise<Error | undefined>((resolve) => {
        if (!server.listening) return resolve(undefined)
        server.close((err) => resolve(err))
      })
      await _resetStoreForTests()
      if (closed) throw closed
    },
  }
}
