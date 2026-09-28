// services/vault/src/index.ts
// Process entrypoint for the vault leaf service. Boots the HTTP server (the pinned
// /items* routes + /health + /healthz). The store is a SINGLE database
// (VAULT_PG_URL); migrations run (manifest-verified) on first store contact.
// Secrets are encrypted at rest with AES-256-GCM using VAULT_ENCRYPTION_KEY.
//
// Graceful shutdown (SIGTERM/SIGINT) drains the HTTP server and the pool.

import { createServer } from './http/server.js'
import { buildApiRoutes } from './http/routes.js'
import { getStore, _resetStoreForTests, type TenantRef } from './store/index.js'
import { resolveKey } from './crypto.js'

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
const SHUTDOWN_TIMEOUT_MS = 10_000

async function main(): Promise<void> {
  const secret = process.env.INTERNAL_VAULT_SECRET
  if (!secret) {
    // Boot anyway (health probe is exempt); every guarded route will 403.
    console.warn('[vault] INTERNAL_VAULT_SECRET is unset — all guarded routes will 403')
  }

  // AES-256-GCM key for at-rest secrets. Required: a missing or malformed key
  // fails closed — resolveKey throws (naming VAULT_ENCRYPTION_KEY and the
  // 64-hex/32-byte format) and boot exits non-zero via main().catch below,
  // rather than booting keyless and accepting secret writes it cannot protect.
  const key = resolveKey(undefined, 'VAULT_ENCRYPTION_KEY')

  // Single-DB store accessor. storeFn ignores the tenant (single VAULT_PG_URL
  // database today); the guard still validates tenant headers for parity + a
  // future per-tenant provisioning step (see docs/runbooks/vault-native.md).
  const storeFn = (_tenant: TenantRef) => getStore()

  const routes = buildApiRoutes(storeFn, key)
  const server = createServer({ secret, routes })

  server.listen(PORT, () => {
    console.log(`[vault] listening on :${PORT}`)
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[vault] ${signal} received — draining connections`)

    const forced = setTimeout(() => {
      console.error('[vault] graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forced.unref()

    server.close((err) => {
      void _resetStoreForTests().finally(() => {
        if (err) {
          console.error('[vault] error during shutdown', err)
          process.exit(1)
        }
        console.log('[vault] shutdown complete')
        process.exit(0)
      })
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('[vault] fatal boot error:', err)
  process.exit(1)
})
