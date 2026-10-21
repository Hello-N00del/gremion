// gremion-ui/src/lib/server/vault/backend/resolve.ts
// Consumer-facing resolution helpers that map a backend-construction failure to
// a graceful 503 instead of an uncaught 500.
//
// getVaultBackend() (index.ts) THROWS for an unknown VAULT_BACKEND value. Every
// vault consumer obtains its backend through one of these helpers so a
// misconfiguration surfaces as a retryable 503, NOT a 500 / uncaught exception.
//
//   - resolveVaultBackendOr503()  → for +server.ts handlers (return Response)
//   - resolveVaultBackendForPage() → for +page.server.ts loads (throw error())

import { error } from '@sveltejs/kit'
import { getVaultBackend, type VaultBackendPort } from './index'

const UNAVAILABLE_BODY = 'Vault backend unavailable'

/**
 * API-route resolver: returns the backend, or a 503 Response when the backend
 * cannot be constructed (e.g. VAULT_BACKEND=unknown-value).
 *
 * Usage:
 *   const resolved = resolveVaultBackendOr503()
 *   if (resolved instanceof Response) return resolved
 *   const backend = resolved
 */
export function resolveVaultBackendOr503(): VaultBackendPort | Response {
  try {
    return getVaultBackend()
  } catch (err) {
    console.error('[vault-backend] resolution failed → 503:', err)
    return new Response(UNAVAILABLE_BODY, {
      status: 503,
      headers: { 'Retry-After': '30' },
    })
  }
}

/**
 * Page-load resolver: returns the backend, or throws SvelteKit error(503) when
 * the backend cannot be constructed. The throw is routed to +error.svelte, so
 * the page degrades gracefully instead of rendering a 500.
 */
export function resolveVaultBackendForPage(): VaultBackendPort {
  try {
    return getVaultBackend()
  } catch (err) {
    console.error('[vault-backend] resolution failed → 503:', err)
    error(503, 'Tresor momentan nicht verfügbar')
  }
}
