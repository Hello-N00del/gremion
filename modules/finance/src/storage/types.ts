// services/finance/src/storage/types.ts
// #383 Lane E2 (R7) — the finance leaf's StorageBackend interface. Ported VERBATIM
// (contract-identical) from the native oracle gremion-ui/.../server/storage/types.ts so
// the opaque `storage_path` handle the leaf writes is byte-identical to the one the
// kernel wrote pre-cutover (and vice-versa): a receipt uploaded on either side of the
// flip resolves on the other. STORAGE_BACKEND (default 'local') selects the impl.
//
// Method contract:
// - put(relPath, bytes) -> returns an opaque "storage handle" string. Callers persist
//   this handle in finance.expense_attachment.storage_path and pass the SAME handle
//   back to read/delete. Local: the absolute filesystem path; Nextcloud: the WebDAV
//   path (/remote.php/dav/files/<user>/<relPath>). Callers MUST treat it as opaque.
// - read(handle) -> raw bytes (the round-trip download the byte-equality tests assert).
// - delete(handle) -> idempotent removal (a missing object is NOT an error, so a
//   partial upload + DB rollback cleanup is safe).

export interface StorageBackend {
  /** Write bytes at the given relative path; returns an opaque handle. */
  put(relPath: string, bytes: Uint8Array): Promise<string>
  /** Read bytes at the given handle (as returned by put). */
  read(handle: string): Promise<Uint8Array>
  /** Delete the object at the given handle. Idempotent — missing is OK. */
  delete(handle: string): Promise<void>
}
