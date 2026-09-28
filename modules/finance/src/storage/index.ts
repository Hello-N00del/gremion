// services/finance/src/storage/index.ts
// #383 Lane E2 (R7) — the finance leaf's storage singleton, selected at first use from
// the environment. Mirrors the native oracle gremion-ui/.../server/storage/index.ts (the
// SAME env var NAMES, so kernel + leaf stay in lock-step at cutover):
//
//   STORAGE_BACKEND=local      -> LocalStorageBackend (default, dev-friendly)
//     RECEIPT_STORAGE_DIR      -> root dir (default ./var/storage)
//   STORAGE_BACKEND=nextcloud  -> NextcloudStorageBackend over the leaf WebDAV client
//     STORAGE_NEXTCLOUD_USER   -> system user (default NEXTCLOUD_ADMIN_USER or 'admin')
//     NEXTCLOUD_URL / NEXTCLOUD_ADMIN_USER / NEXTCLOUD_ADMIN_PASSWORD -> WebDAV target
//
// Construction is lazy via getStorage() so import order / env timing don't matter; the
// `storage` proxy keeps the ergonomic `import { storage } from '../storage'` shape.
// resetStorageForTest() drops the cache so a test can flip STORAGE_BACKEND per case.

import type { StorageBackend } from './types.js'
import { LocalStorageBackend } from './local.js'
import { NextcloudStorageBackend } from './nextcloud.js'
import { createFinanceWebdavClient } from '../nextcloud/webdav-client.js'

export type { StorageBackend } from './types.js'

let cached: StorageBackend | null = null

function build(): StorageBackend {
  const backend = (process.env.STORAGE_BACKEND ?? 'local').toLowerCase()
  if (backend === 'nextcloud') {
    const user = process.env.STORAGE_NEXTCLOUD_USER ?? process.env.NEXTCLOUD_ADMIN_USER ?? 'admin'
    return new NextcloudStorageBackend(createFinanceWebdavClient(), user)
  }
  if (backend !== 'local') {
    throw new Error(
      `storage: unknown STORAGE_BACKEND='${backend}' (expected 'local' or 'nextcloud')`,
    )
  }
  return new LocalStorageBackend(process.env.RECEIPT_STORAGE_DIR)
}

/** Lazily build & cache the storage backend. */
export function getStorage(): StorageBackend {
  if (cached === null) cached = build()
  return cached
}

/** Test-only: drop the cached singleton so the next access reads env afresh. */
export function resetStorageForTest(): void {
  cached = null
}

/** Ergonomic proxy: `storage.put(...)` forwards to the cached singleton. */
export const storage: StorageBackend = {
  put: (relPath, bytes) => getStorage().put(relPath, bytes),
  read: (handle) => getStorage().read(handle),
  delete: (handle) => getStorage().delete(handle),
}
