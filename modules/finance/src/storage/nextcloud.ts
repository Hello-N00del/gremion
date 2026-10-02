// services/finance/src/storage/nextcloud.ts
// #383 Lane E2 (R7) — Nextcloud-WebDAV StorageBackend. Ported from the native oracle
// gremion-ui/.../server/storage/nextcloud.ts, wrapping the LEAF's own WebDAV client
// (../nextcloud/webdav-client.ts) instead of the kernel NextcloudClient — the leaf is
// a separate process and carries its own client (operator-ratified). The davPath /
// ensureParents logic is byte-for-byte the native oracle's so the storage_path handle
// the leaf writes is IDENTICAL to the one the kernel wrote pre-cutover.
//
// Storage layout: all files land under a single system user's WebDAV namespace at
// /remote.php/dav/files/<storageUser>/<relPath>. That user is usually the Nextcloud
// admin (STORAGE_NEXTCLOUD_USER, defaulting to NEXTCLOUD_ADMIN_USER). Parent folders
// are created lazily with MKCOL (idempotent — a 405/409 "already exists" is swallowed).
//
// The returned handle is the full WebDAV path so read/delete act on it directly.
//
// DIVERGENCE from the native oracle (behaviour-identical): the native backend scrapes
// the client's error MESSAGE for `→ 404` / `→ 405`; the leaf client raises a typed
// FinanceWebdavError with a `.status`, so we branch on that (cleaner, same swallow set —
// plus a 409, which some Nextcloud builds return for MKCOL-already-exists).

import type { StorageBackend } from './types.js'
import { FinanceWebdavError } from '../nextcloud/webdav-client.js'

const DAV_PREFIX = '/remote.php/dav/files'

/** The subset of the leaf WebDAV client the storage backend drives. The upload body is a
 *  Blob (native-oracle parity; a valid fetch BodyInit under both the leaf + kernel tsconfigs). */
export interface StorageWebdavClient {
  upload(
    path: string, impersonateUser: string, body: Blob, contentType: string,
    opts?: { createOnly?: boolean },
  ): Promise<void>
  download(path: string, impersonateUser: string): Promise<Response>
  delete(path: string, impersonateUser: string): Promise<void>
  mkcol(path: string, impersonateUser: string): Promise<void>
}

export class NextcloudStorageBackend implements StorageBackend {
  constructor(
    private readonly client: StorageWebdavClient,
    private readonly storageUser: string,
  ) {}

  /** Build the WebDAV path for a relative key.
   *
   *  Defence-in-depth against path traversal (#231): the key is composed from
   *  attacker-influenced data (the uploaded receipt filename), and the WHATWG URL
   *  parser inside fetch() collapses ".." segments — so an unescaped "../.." would
   *  escape the per-folder namespace into the storage user's whole tree. Reject any
   *  ".." segment outright (mirrors LocalStorageBackend's safeJoin), and
   *  percent-encode every segment so characters like "#", "?" and spaces address the
   *  intended file instead of re-routing the WebDAV URL. Plain-ASCII keys are left
   *  byte-identical, so existing handles need no migration. Byte-for-byte the native
   *  oracle's davPath. */
  private davPath(relPath: string): string {
    const stripped = relPath.replace(/^[/\\]+/, '').replace(/\\/g, '/')
    const segments = stripped.split('/')
    if (segments.includes('..')) {
      throw new Error(`storage(nextcloud): path escapes root: ${relPath}`)
    }
    const encoded = segments.map((seg) => encodeURIComponent(seg)).join('/')
    return `${DAV_PREFIX}/${encodeURIComponent(this.storageUser)}/${encoded}`
  }

  async put(relPath: string, bytes: Uint8Array): Promise<string> {
    const fullPath = this.davPath(relPath)
    await this.ensureParents(fullPath)
    // Nextcloud has no opinion on the Content-Type for opaque binary uploads — use the
    // generic octet-stream; the mime-type is tracked in the DB row. Copy into a fresh
    // ArrayBuffer and wrap in a Blob (native-oracle parity): the request body never
    // aliases a pooled/subarray buffer, and a Blob is a valid fetch BodyInit under both
    // the leaf's node-only lib AND the kernel's DOM lib (a bare Uint8Array is not).
    const ab = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(ab).set(bytes)
    // F1-FIX-05-K r2: create-only, parity with LocalStorageBackend's 'wx'. Keys are
    // server-built with a UUID, so a collision means a bug -- fail it (412), never
    // replace another receipt's bytes.
    await this.client.upload(fullPath, this.storageUser, new Blob([ab]), 'application/octet-stream', {
      createOnly: true,
    })
    return fullPath
  }

  async read(handle: string): Promise<Uint8Array> {
    const res = await this.client.download(handle, this.storageUser)
    const buf = Buffer.from(await res.arrayBuffer())
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async delete(handle: string): Promise<void> {
    try {
      await this.client.delete(handle, this.storageUser)
    } catch (err) {
      // Idempotent: a 404 means the file is already gone — that's fine.
      if (err instanceof FinanceWebdavError && err.status === 404) return
      throw err
    }
  }

  /** MKCOL every intermediate folder, swallowing "already exists" (405/409). */
  private async ensureParents(fullPath: string): Promise<void> {
    // Walk: /remote.php/dav/files/<user>/a/b/c.pdf
    //   ->  /remote.php/dav/files/<user>/a, then /a/b
    const userPrefix = `${DAV_PREFIX}/${encodeURIComponent(this.storageUser)}`
    const rel = fullPath.slice(userPrefix.length).replace(/^\//, '')
    const parts = rel.split('/')
    parts.pop() // drop filename
    let cur = userPrefix
    for (const seg of parts) {
      cur = `${cur}/${seg}`
      try {
        await this.client.mkcol(cur, this.storageUser)
      } catch (err) {
        // 405/409 = already exists; that's the success-shaped failure mode.
        if (err instanceof FinanceWebdavError && (err.status === 405 || err.status === 409)) continue
        throw err
      }
    }
  }
}
