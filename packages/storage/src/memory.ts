// In-memory StorageBackend — the TEST DOUBLE second backend (TRD-066).
//
// It exists to prove backend selectability: the shared contract suite runs
// against it and against the local backend with nothing but the configured
// `backend` name changed. It is not a production backend (no durability).
//
// All tenants of one configured seam share ONE store map, the way all tenants
// of an object-store deployment share one bucket — so the isolation it shows
// comes from the handle checks, not from giving each tenant its own map.

import type { StorageBackend } from './types.js'
import { assertHandleInTenant, assertKeyInTenant, assertTenantId, composeKey } from './tenant.js'

export class MemoryStorageBackend implements StorageBackend {
  readonly tenantId: string
  private readonly store: Map<string, Uint8Array>

  constructor(tenantId: string, store: Map<string, Uint8Array> = new Map()) {
    this.tenantId = assertTenantId(tenantId)
    this.store = store
  }

  put(relPath: string, bytes: Uint8Array): Promise<string> {
    let key: string
    try {
      key = composeKey('memory', this.tenantId, relPath)
      assertKeyInTenant('memory', this.tenantId, key)
      if (!(bytes instanceof Uint8Array)) throw new TypeError('storage(memory): bytes must be a Uint8Array')
    } catch (err) {
      return Promise.reject(err)
    }
    this.store.set(key, bytes.slice())
    return Promise.resolve(key)
  }

  read(handle: string): Promise<Uint8Array> {
    let key: string
    try {
      key = assertHandleInTenant('memory', this.tenantId, handle)
    } catch (err) {
      return Promise.reject(err)
    }
    const bytes = this.store.get(key)
    if (bytes === undefined) {
      return Promise.reject(
        Object.assign(new Error(`storage(memory): no object at ${JSON.stringify(key)}`), { code: 'ENOENT' }),
      )
    }
    return Promise.resolve(bytes.slice())
  }

  delete(handle: string): Promise<void> {
    let key: string
    try {
      key = assertHandleInTenant('memory', this.tenantId, handle)
    } catch (err) {
      return Promise.reject(err)
    }
    this.store.delete(key)
    return Promise.resolve()
  }

  list(prefix?: string): Promise<string[]> {
    let keyPrefix: string
    try {
      keyPrefix = prefix === undefined ? this.tenantId : composeKey('memory', this.tenantId, prefix)
    } catch (err) {
      return Promise.reject(err)
    }
    const start = `${keyPrefix}/`
    return Promise.resolve([...this.store.keys()].filter((k) => k.startsWith(start)).sort())
  }
}
