// The StorageBackend contract every backend satisfies (TRD-065/066).
//
// A backend instance is BOUND TO ONE TENANT. It is only ever obtained through
// getStorageFor(tenantId), and every handle it produces begins with that
// tenant's segment: `<tenantId>/<relPath>` (TRD-067, DB-IDT-BRANDING's
// logo_asset_key shape). Handles are opaque to callers — persist them as-is
// and hand them back to the SAME tenant's backend. A handle from another tenant
// (or any handle outside `<tenantId>/`) is refused before any I/O.
//
// - put(relPath, bytes) -> handle. relPath is relative to the tenant's root;
//   a leading `/` is stripped, `..` escapes, drive letters, backslashes and NUL
//   are refused.
// - read(handle)        -> bytes. Rejects when the object does not exist.
// - delete(handle)      -> idempotent removal (missing is not an error, so a
//   partial upload + DB rollback cleanup is safe).
// - list(prefix?)       -> read-only listing of this tenant's handles (sorted),
//   optionally under a relative directory prefix. Never crosses tenants (Q6).
//
// Every method validates its input SYNCHRONOUSLY and returns a rejected promise
// on failure without touching storage; no I/O happens before validation.

export interface StorageBackend {
  /** The tenant this backend is bound to (assertTenantId-validated). */
  readonly tenantId: string
  /** Write bytes at a tenant-relative path; returns the tenant-prefixed handle. */
  put(relPath: string, bytes: Uint8Array): Promise<string>
  /** Read bytes at a handle this tenant's backend produced. */
  read(handle: string): Promise<Uint8Array>
  /** Delete the object at a handle. Idempotent — missing is OK. */
  delete(handle: string): Promise<void>
  /** List this tenant's handles, optionally under a relative directory prefix. */
  list(prefix?: string): Promise<string[]>
}

/** The filesystem operations the local backend performs — injectable so the
 *  tests can prove, with a spy, that a refused call made ZERO of them. */
export interface StorageFs {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>
  writeFile(path: string, data: Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  unlink(path: string): Promise<void>
  /** lstat — used to refuse symlinks on the way to an object, and to tell a
   *  directory apart from an object when unlink answers EPERM. */
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>
  /** Recursive listing: every entry below `path`, as paths relative to it,
   *  regular files only. Symlinks are neither returned nor descended into. */
  listFiles(path: string): Promise<string[]>
  /** Synchronous text read — used only for the mount table. */
  readTextSync(path: string): string
}

/** The seam's configuration. `backend` is the STORAGE_BACKEND value; selecting
 *  a backend is configuration alone (TRD-066). */
export interface StorageConfig {
  /** 'local' (filesystem, the pilot backend) or 'memory' (the test double). */
  backend: string
  /** Local backend root (RECEIPT_STORAGE_DIR). Must be a mount point. */
  root?: string
  /** Mount table to consult; defaults to /proc/self/mountinfo. */
  mountinfoPath?: string
  /** Filesystem operations; defaults to node:fs. */
  fs?: StorageFs
  /** Must be true to select 'memory': the double loses every object on
   *  restart, so it is never selectable by a stray STORAGE_BACKEND alone. */
  allowTestDouble?: boolean
  /** Host platform for the mount check; defaults to process.platform (tests). */
  platform?: string
}
