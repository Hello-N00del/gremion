// modules/board/src/index.ts
// Process entrypoint for the board leaf service. Builds the leaf through the
// one construction path (buildApp, src/app.ts) and boots its HTTP server (all
// /api/v1/* routes + /healthz). There is no scheduler, NATS relay, or CalDAV
// pipeline here — the board leaf is a thin request/response service.
//
// Graceful shutdown (SIGTERM/SIGINT) drains the HTTP server and the pool.

import { buildApp } from './app.js'

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
const SHUTDOWN_TIMEOUT_MS = 10_000

async function main(): Promise<void> {
  if (!process.env.INTERNAL_BOARD_SECRET) {
    // Boot anyway (health probe is exempt); every guarded route will 403.
    console.warn('[board] INTERNAL_BOARD_SECRET is unset — all guarded routes will 403')
  }

  const app = buildApp(process.env)

  app.server.listen(PORT, () => {
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

    app.close().then(
      () => {
        console.log('[board] shutdown complete')
        process.exit(0)
      },
      (err: unknown) => {
        console.error('[board] error during shutdown', err)
        process.exit(1)
      },
    )
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  // buildApp refuses with one line naming the variable (GREMION_BOARD_PG_URL,
  // the migrations manifest): log that line, exit 1, never listen.
  console.error(`[board] fatal boot error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
