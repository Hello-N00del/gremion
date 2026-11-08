// packages/tenant-store/src/lifecycle/export-remove.ts
//
// Removal of one module export (the dump and its .sha256 sidecar) THROUGH the storage seam. The export tree
// <exportDir>/<tenant>/<module>/<utc>.dump has exactly the seam's shape (<root>/<tenantId>/<relPath>), so the
// export volume is a tenant-bound LocalStorageBackend rooted at exportDir: a handle of another tenant, a
// traversal and a symlink on the way are refused by the seam before any I/O, and no raw fs delete exists
// here (scripts/check-storage-seam.mjs, guard s3).
//
// A missing object is success (the backend's own rule), which the day-30 job needs to converge after a crash
// between the delete and the row update.
import { basename, resolve } from 'node:path'
import { LocalStorageBackend, type StorageBackend } from '@gremion/storage'
import { assertKarenzExportPath, LifecycleError } from './guards.js'

/** The tenant-bound storage over the export volume. */
export type ExportStorageFactory = (tenantId: string) => StorageBackend

export interface ExportRemoveDeps {
  exportDir: string
  /**
   * The storage backend over the export volume, one per tenant. Default: a LocalStorageBackend rooted at
   * `exportDir` (which, like every local storage root, must be a mount point: the switch-off and the
   * day-30 gates already demand that of TENANT_EXPORT_DIR). Tests inject their own.
   */
  exportStorage?: ExportStorageFactory
}

export function exportStorageFor(deps: ExportRemoveDeps, tenantId: string): StorageBackend {
  if (!deps.exportStorage) return new LocalStorageBackend(tenantId, { root: deps.exportDir })
  const storage = deps.exportStorage(tenantId)
  // One source of truth for where the exports live: the path is checked against exportDir, the delete goes
  // through the injected storage, and a missing object is success. A storage rooted elsewhere would therefore
  // answer every delete with success while the dump stays on disk. A backend that exposes its root must
  // agree with exportDir (one that has none, such as the in-memory one, has nothing to compare).
  const root = (storage as { root?: unknown }).root
  if (typeof root === 'string' && resolve(root) !== resolve(deps.exportDir)) {
    throw new LifecycleError('TARGET_REFUSED', `the export storage is rooted at ${JSON.stringify(root)}, not at the export directory ${JSON.stringify(deps.exportDir)}; refusing to delete through it`)
  }
  return storage
}

/**
 * Deletes the dump at `path` and its sidecar. `path` must be a `*.dump` directly under
 * <exportDir>/<tenant>/<module>/ (assertKarenzExportPath, checked before the storage is touched).
 */
export async function removeKarenzExport(path: string, deps: ExportRemoveDeps, tenantId: string, moduleId: string): Promise<void> {
  const valid = assertKarenzExportPath(path, deps.exportDir, tenantId, moduleId)
  const storage = exportStorageFor(deps, tenantId)
  // the file name of the path the guard RESOLVED and approved ('x.dump/.' is 'x.dump' to the guard)
  const handle = `${tenantId}/${moduleId}/${basename(resolve(valid))}`
  await storage.delete(handle)
  await storage.delete(`${handle}.sha256`)
}
