// src/lib/server/storage/nextcloud.ts
// Nextcloud-WebDAV StorageBackend. Wraps the existing NextcloudClient
// (src/lib/server/files/nextcloud-client.ts) — we do NOT re-implement WebDAV
// here, only adapt the StorageBackend contract on top of it.
//
// Storage layout: all files land under a single system user's WebDAV
// namespace at /remote.php/dav/files/<storageUser>/<relPath>. That user is
// usually NEXTCLOUD_ADMIN_USER (defaults to 'admin'); override via
// STORAGE_NEXTCLOUD_USER. Parent folders are created lazily with MKCOL
// (idempotent — 405 "already exists" is swallowed).
//
// The returned handle is the full WebDAV path so read/delete can act on it
// directly without re-deriving the user / prefix.

import type { StorageBackend } from './types'
import type { NextcloudClient } from '../files/nextcloud-client'

const DAV_PREFIX = '/remote.php/dav/files'

export class NextcloudStorageBackend implements StorageBackend {
  constructor(
    private readonly client: Pick<NextcloudClient, 'upload' | 'download' | 'delete' | 'mkcol'>,
    private readonly storageUser: string
  ) {}

  /** Build the WebDAV path for a relative key.
   *
   *  Defence-in-depth against path traversal (#231): the key is composed from
   *  attacker-influenced data (e.g. an uploaded receipt filename), and the
   *  WHATWG URL parser inside fetch() collapses ".." segments — so an unescaped
   *  "../.." would escape the per-folder namespace into the storage user's whole
   *  tree. Reject any ".." segment outright (mirrors LocalStorageBackend's
   *  safeJoin), and percent-encode every segment so characters like "#", "?" and
   *  spaces address the intended file instead of re-routing the WebDAV URL.
   *  Plain-ASCII keys are left byte-identical, so existing handles need no
   *  migration. */
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
    // Wrap Uint8Array in a Blob so undici / fetch accepts it as BodyInit.
    // Nextcloud has no opinion on the Content-Type for opaque binary uploads —
    // use the generic octet-stream; the mime-type is tracked in the DB row.
    // Copy into a fresh ArrayBuffer so TS sees a BlobPart (Uint8Array<ArrayBufferLike>
    // can be backed by a SharedArrayBuffer, which Blob rejects).
    const ab = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(ab).set(bytes)
    await this.client.upload(fullPath, this.storageUser, new Blob([ab]), 'application/octet-stream')
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
      const msg = err instanceof Error ? err.message : String(err)
      if (/→ 404/.test(msg)) return
      throw err
    }
  }

  /** MKCOL every intermediate folder, swallowing "already exists" (405). */
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
        // 405 = already exists; that's the success-shaped failure mode.
        const msg = err instanceof Error ? err.message : String(err)
        if (/→ 405/.test(msg)) continue
        throw err
      }
    }
  }
}
