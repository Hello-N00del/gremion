// services/board/src/index.ts
// Process entrypoint for the board leaf service. Boots the HTTP server (all
// /api/v1/* routes + /healthz). The store is a SINGLE database (BOARD_PG_URL);
// migrations run (manifest-verified) on first store contact. There is no
// scheduler, NATS relay, or CalDAV pipeline here — the board leaf is a thin
// request/response service.
//
// Graceful shutdown (SIGTERM/SIGINT) drains the HTTP server and the pool.

import { createServer } from './http/server.js'
import { buildApiRoutes } from './http/routes.js'
import { getStore, _resetStoreForTests, type TenantRef } from './store/index.js'

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
const SHUTDOWN_TIMEOUT_MS = 10_000

async function main(): Promise<void> {
  const secret = process.env.INTERNAL_BOARD_SECRET
  if (!secret) {
    // Boot anyway (health probe is exempt); every guarded route will 403.
    console.warn('[board] INTERNAL_BOARD_SECRET is unset — all guarded routes will 403')
  }

  // Single-DB store accessor. storeFn ignores the tenant (single BOARD_PG_URL
  // database today); the guard still validates tenant headers for parity + a
  // future per-tenant provisioning step (see docs/runbooks/board-cutover.md).
  const storeFn = (_tenant: TenantRef) => getStore()

  const routes = buildApiRoutes(storeFn)
  const server = createServer({ secret, routes })

  server.listen(PORT, () => {
    console.log(`[board] listening on :${PORT}`)
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[board] ${signal} received — draining connections`)

    const forced = setTimeout(() => {
      console.error('[board] graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forced.unref()

    server.close((err) => {
      void _resetStoreForTests().finally(() => {
        if (err) {
          console.error('[board] error during shutdown', err)
          process.exit(1)
        }
        console.log('[board] shutdown complete')
        process.exit(0)
      })
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('[board] fatal boot error:', err)
  process.exit(1)
})
