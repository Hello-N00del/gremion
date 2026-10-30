// services/messages/src/index.ts
// Process entrypoint for the messages+video leaf service — a stateless Matrix /
// LiveKit proxy. Boots ONLY the HTTP server (no PG, no NATS, no scheduler: the
// leaf owns no state). Graceful shutdown (SIGTERM/SIGINT) closes the server.
import { createServer } from './http/server.js'
import { missingLeafSecrets } from './http/deps.js'

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
const SHUTDOWN_TIMEOUT_MS = 10_000

function main(): void {
  // Fail closed at boot instead of minting LiveKit tokens with an empty secret
  // or calling Synapse admin with an empty bearer.
  const missing = missingLeafSecrets(process.env)
  if (missing.length > 0) {
    console.error(`[messages] refusing to boot: ${missing.join(', ')} unset or empty`)
    process.exit(1)
  }

  const secret = process.env.INTERNAL_MESSAGES_SECRET
  if (!secret) {
    console.warn('[messages] INTERNAL_MESSAGES_SECRET is unset — all guarded routes will 403')
  }
  if (!process.env.MATRIX_URL) {
    console.warn('[messages] MATRIX_URL is unset — falling back to http://matrix:8008')
  }

  const server = createServer({ secret })
  server.listen(PORT, () => {
    console.log(`[messages] listening on :${PORT}`)
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[messages] ${signal} received — draining connections`)

    const forced = setTimeout(() => {
      console.error('[messages] graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forced.unref()

    server.close((err) => {
      if (err) {
        console.error('[messages] error during shutdown', err)
        process.exit(1)
      }
      console.log('[messages] shutdown complete')
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
