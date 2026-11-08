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
import { assertKarenzExportPath } from './guards.js'

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
  return deps.exportStorage ? deps.exportStorage(tenantId) : new LocalStorageBackend(tenantId, { root: deps.exportDir })
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
