// gremion-ui/src/lib/server/vault/backend/index.ts
// Factory: selects the vault backend implementation based on the VAULT_BACKEND
// environment variable.
//
//   unset / 'service' → ServiceVaultClient (HTTP ACL to VAULT_SERVICE_URL)
//   anything else     → throws (fail-closed)
//
// The vault is the KERNEL half of a two-part subsystem: the data plane lives in
// the vault leaf, so 'service' is the only supported mode (there is no
// in-process implementation, unlike board). Call sites obtain the backend once
// per request scope:  const backend = getVaultBackend(event.locals.correlationId)

import { ServiceVaultClient } from './service-client'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'
import type { VaultBackendPort } from './port'

export type {
  VaultBackendPort,
  VaultItem,
  CreateVaultItemInput,
  UpdateVaultItemInput,
  VaultAccessLogEntry,
  RevealedSecret,
} from './port'

/**
 * Resolve the vault backend for the current VAULT_BACKEND env.
 *
 * Default is 'service': the vault data plane (secret storage + reveal-audit)
 * lives in the vault leaf, reached over HTTP via ServiceVaultClient.
 *
 * @param correlationId Optional per-request correlation id forwarded as
 *   x-correlation-id to the leaf AND used to bind vault.acl.<op> spans emitted
 *   when TRACE_EXPORTER=log (default 'none' → noopTracer).
 */
export function getVaultBackend(correlationId?: string): VaultBackendPort {
  const backend = process.env.VAULT_BACKEND ?? 'service'

  if (backend === 'service') {
    const traceExporter = process.env.TRACE_EXPORTER ?? 'none'
    const tracer =
      traceExporter === 'log' && correlationId ? makeLogTracer(correlationId) : noopTracer
    return new ServiceVaultClient({ correlationId, tracer })
  }

  throw new Error(
    `[vault-backend] Unknown VAULT_BACKEND value: '${backend}'. ` +
      "The only supported value is 'service' (the vault data plane lives in the vault leaf).",
  )
}
