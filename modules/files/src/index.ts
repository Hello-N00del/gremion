// services/files/src/index.ts
// Process entrypoint for the files leaf service — a stateless Nextcloud WebDAV
// proxy. Boots ONLY the HTTP server (no PG, no NATS, no scheduler: the leaf owns
// no state). Graceful shutdown (SIGTERM/SIGINT) closes the server.
import { createServer } from './http/server.js'

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
const SHUTDOWN_TIMEOUT_MS = 10_000

function main(): void {
  const secret = process.env.INTERNAL_FILES_SECRET
  if (!secret) {
    console.warn('[files] INTERNAL_FILES_SECRET is unset — all guarded routes will 403')
  }
  if (!process.env.NEXTCLOUD_URL) {
    console.warn('[files] NEXTCLOUD_URL is unset — falling back to http://nextcloud')
  }

  const server = createServer({ secret })
  server.listen(PORT, () => {
    console.log(`[files] listening on :${PORT}`)
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[files] ${signal} received — draining connections`)

    const forced = setTimeout(() => {
      console.error('[files] graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forced.unref()

    server.close((err) => {
      if (err) {
        console.error('[files] error during shutdown', err)
        process.exit(1)
      }
      console.log('[files] shutdown complete')
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
