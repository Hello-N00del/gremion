// src/lib/server/storage/types.ts
// Common StorageBackend interface. WP-Write Task 22 (receipt storage adapter)
// switches between local-disk and Nextcloud-WebDAV backends behind this
// interface via the STORAGE_BACKEND env var (default 'local').
//
// Method contract:
// - put(relPath, bytes) -> returns an opaque "storage handle" string. Callers
//   persist this handle in DB columns (e.g. expense_attachment.storage_path)
//   and pass the SAME handle back to read/delete. For the local backend the
//   handle is the absolute filesystem path; for the Nextcloud backend it is
//   the WebDAV path (/remote.php/dav/files/<user>/<relPath>). Callers MUST
//   treat the handle as opaque — only the backend that produced it knows
//   how to interpret it.
// - read(handle) -> raw bytes, used by route layer to stream downloads.
// - delete(handle) -> idempotent removal (missing file is not an error, so
//   that a partial upload + DB rollback cleanup is safe).

export interface StorageBackend {
  /** Write bytes at the given relative path; returns an opaque handle. */
  put(relPath: string, bytes: Uint8Array): Promise<string>
  /** Read bytes at the given handle (as returned by put). */
  read(handle: string): Promise<Uint8Array>
  /** Delete the object at the given handle. Idempotent — missing is OK. */
  delete(handle: string): Promise<void>
}
