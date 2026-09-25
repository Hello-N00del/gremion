// @gremion/storage — the ONE seam through which every tenant file, draft and
// media object is resolved (PRD-PLAT-012, TRD-065/066/067).
//
//   configureStorage({ backend, root })   once per process (the app adapter
//                                         reads STORAGE_BACKEND /
//                                         RECEIPT_STORAGE_DIR and calls this)
//   getStorageFor(tenantId)               a backend bound to that tenant,
//                                         memoised per tenant
//
// There is deliberately NO zero-argument accessor and NO ambient-context read:
// the tenant is always an explicit argument, and a missing or malformed one
// throws synchronously before anything else happens (spec-b S1/S2).
//
// Memoisation (Q1): an unbounded per-process Map<tenantId, StorageBackend>,
// no eviction — sized for the pilot's handful of tenants. Residual for the
// north-star object-store cutover (TRD-223): bound or drop it there.

import type { StorageBackend, StorageConfig, StorageFs } from './types.js'
import { LocalStorageBackend } from './local.js'
import { MemoryStorageBackend } from './memory.js'
import { assertTenantId } from './tenant.js'

export type { StorageBackend, StorageConfig, StorageFs } from './types.js'
export { LocalStorageBackend, DEFAULT_LOCAL_ROOT } from './local.js'
export { MemoryStorageBackend } from './memory.js'
export { assertMountedRoot, parseMountPoints, DEFAULT_MOUNTINFO_PATH, type MountCheck } from './assertMountedRoot.js'
export { assertTenantId, LEGACY_DEFAULT_TENANT_ID } from './tenant.js'

/** The backends selectable by configuration alone (STORAGE_BACKEND). */
export const STORAGE_BACKENDS = ['local', 'memory'] as const
export type StorageBackendName = (typeof STORAGE_BACKENDS)[number]

interface ActiveSeam {
  readonly backend: StorageBackendName
  readonly root: string | undefined
  readonly mountinfoPath: string | undefined
  readonly fs: StorageFs | undefined
  readonly perTenant: Map<string, StorageBackend>
  /** The memory double's single shared store (unused by 'local'). */
  readonly memoryStore: Map<string, Uint8Array>
}

let active: ActiveSeam | null = null

function parseBackendName(value: unknown): StorageBackendName {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : value
  if (typeof name === 'string' && (STORAGE_BACKENDS as readonly string[]).includes(name)) {
    return name as StorageBackendName
  }
  throw new Error(
    `storage: unknown STORAGE_BACKEND=${JSON.stringify(value)} (expected one of ${STORAGE_BACKENDS.join(', ')})`,
  )
}

/** Select and configure the backend for this process. Replaces any previous
 *  configuration and drops every memoised per-tenant backend. Does no I/O. */
export function configureStorage(config: StorageConfig): void {
  active = {
    backend: parseBackendName(config.backend),
    root: config.root,
    mountinfoPath: config.mountinfoPath,
    fs: config.fs,
    perTenant: new Map(),
    memoryStore: new Map(),
  }
}

/** True once configureStorage() has run (and resetStorageForTest() has not). */
export function isStorageConfigured(): boolean {
  return active !== null
}

/** The storage backend bound to `tenantId`, memoised per tenant.
 *  Throws SYNCHRONOUSLY — before any I/O — on a missing/malformed tenant id,
 *  and when the seam has not been configured. */
export function getStorageFor(tenantId: string): StorageBackend {
  const id = assertTenantId(tenantId)
  if (active === null) {
    throw new Error('storage: not configured — call configureStorage({ backend, root }) first')
  }
  const cached = active.perTenant.get(id)
  if (cached !== undefined) return cached
  const built: StorageBackend =
    active.backend === 'local'
      ? new LocalStorageBackend(id, { root: active.root, mountinfoPath: active.mountinfoPath, fs: active.fs })
      : new MemoryStorageBackend(id, active.memoryStore)
  active.perTenant.set(id, built)
  return built
}

/** Test-only: forget the configuration and every memoised per-tenant backend,
 *  so the next configureStorage()/getStorageFor() starts from nothing. */
export function resetStorageForTest(): void {
  active = null
}
