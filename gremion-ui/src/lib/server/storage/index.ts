// src/lib/server/storage/index.ts
// gremion-ui's CONFIG ADAPTER over @gremion/storage (TASK-117). The seam itself
// — tenant-bound backends, key composition, the mount-point check — lives in
// packages/storage; this file only turns env into its configuration:
//
//   STORAGE_BACKEND      'local' (default) | 'memory' (test double, vitest only)
//   RECEIPT_STORAGE_DIR  local root (default ./var/storage); must be a mount point
//
// The one export is getStorageFor(tenantId): request handlers pass the tenant
// explicitly (e.g. requireTenant().id at the call site). No zero-arg accessor,
// no ambient tenant read here — scripts/check-storage-seam.mjs guards both.

import { env } from '$env/dynamic/private'
import { assertTenantId, configureStorage, getStorageFor as seamFor, isStorageConfigured } from '@gremion/storage'
import type { StorageBackend } from '@gremion/storage'

/** SvelteKit's dynamic env first, then process.env: the dynamic env stays empty
 *  under vitest, so the fallback is what lets tests set process.env.X. */
function readEnv(name: string): string | undefined {
  return env[name] ?? process.env[name]
}

export function getStorageFor(tenantId: string): StorageBackend {
  assertTenantId(tenantId) // fail closed before any configuration or I/O
  if (!isStorageConfigured()) {
    configureStorage({
      backend: readEnv('STORAGE_BACKEND') ?? 'local',
      root: readEnv('RECEIPT_STORAGE_DIR'),
      // the in-memory double loses every object on restart: vitest only
      allowTestDouble: Boolean(process.env.VITEST),
    })
  }
  return seamFor(tenantId)
}
