// gremion-ui/src/lib/server/files/backend/port.ts
// Branch-by-abstraction seam for the files (Nextcloud WebDAV) browser subsystem.
//
// FilesBackendPort is the interface the files-browser route handlers
// (routes/api/files/[...path] + routes/api/files/upload-chunk) call once the
// seam is wired in. The method set is the exact browser-CRUD subset the routes
// drive against the kernel `createNextcloudClient` (propfind/download/upload/
// mkcol/delete/move/copy), plus the chunked-upload assembly the upload-chunk
// route performs with raw admin-Basic fetches.
//
// The ops are webdav-path-level (they take the pre-built `/remote.php/dav/…`
// fragment + username, exactly like NextcloudClient) so the route keeps
// buildWebdavPath — the InprocessFilesClient is then a transparent delegate and
// behavior stays byte-identical to the pre-seam monolith. The WOPI/edit-token
// and Collabora/newsletter uses of nextcloud-client are NOT part of this seam
// (they stay in-process, out of scope of the browser extraction).
//
// This file has NO runtime deps beyond the DavEntry type re-export — it is a
// near-pure TypeScript interface.

// DavEntry is the NC-level PROPFIND row shape. Re-exported from the (unmoved)
// kernel nextcloud-client so the route + service-client reference the seam,
// never nextcloud-client directly (see boundary rule no-files-route-to-nc).
export type { DavEntry } from '../nextcloud-client'
import type { DavEntry } from '../nextcloud-client'

/** Logical inputs for one chunked-upload PUT (+ MOVE assemble on the last chunk).
 *  `sanitizedPath` and `uploadId` are already validated by the route BEFORE the
 *  port is called; the implementation only performs the NC round-trips. */
export interface UploadChunkInput {
  /** Nextcloud user id (= Keycloak sub) — namespaces the DAV upload session. */
  userId: string
  /** Client-supplied upload session id (format-validated by the route). */
  uploadId: string
  chunkIndex: number
  totalChunks: number
  /** finalPath after sanitizeRelPath() — relative to the user webdav root. */
  sanitizedPath: string
  /** OC-Total-Length for the final assemble MOVE (optional). */
  totalSize: string | null
  /** The chunk bytes. Null is legal only for a single-chunk (totalChunks===1). */
  body: ReadableStream<Uint8Array> | null
}

export interface UploadChunkResult {
  /** True when this was the last chunk (assemble MOVE ran). */
  complete: boolean
}

export interface FilesBackendPort {
  /**
   * Discriminant identifying which implementation is in use.
   * 'inprocess' = in-process createNextcloudClient calls (byte-identical to the
   * monolith); 'service' = HTTP ACL calls to the files-service leaf.
   */
  readonly kind: 'inprocess' | 'service'

  // ── Browser WebDAV ops (webdav-path-level, mirror NextcloudClient) ──────────
  /** PROPFIND a directory (Depth:1) → the DAV entry rows. */
  propfind(webdavPath: string, uname: string): Promise<DavEntry[]>
  /** GET a file → the raw upstream streaming Response. */
  download(webdavPath: string, uname: string): Promise<Response>
  /** PUT a file body. */
  upload(webdavPath: string, uname: string, body: BodyInit, contentType: string): Promise<void>
  /** MKCOL a collection (folder). */
  mkcol(webdavPath: string, uname: string): Promise<void>
  /** DELETE a resource. */
  delete(webdavPath: string, uname: string): Promise<void>
  /** MOVE (rename) a resource. */
  move(fromPath: string, toPath: string, uname: string): Promise<void>
  /** COPY a resource. */
  copy(fromPath: string, toPath: string, uname: string): Promise<void>

  // ── Chunked upload assembly ─────────────────────────────────────────────────
  /** PUT one chunk into the DAV upload session; on the last chunk, MOVE-assemble
   *  it into the user's files. Returns { complete } — true iff the assemble ran. */
  uploadChunk(input: UploadChunkInput): Promise<UploadChunkResult>
}
