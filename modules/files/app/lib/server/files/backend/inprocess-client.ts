// gremion-ui/src/lib/server/files/backend/inprocess-client.ts
// Branch-by-abstraction default path; byte-identical to the pre-seam files
// browser behavior until the deliberate (HELD) cutover to 'service'.
//
// The 7 browser WebDAV ops are thin delegates to a single per-request
// createNextcloudClient (constructed once with the caller's OIDC bearer, exactly
// like the pre-seam route which did `const nc = createNextcloudClient({...})`
// once per request). The chunked-upload assembly reproduces the upload-chunk
// route's raw admin-Basic fetch path verbatim (env via defaultTenantEnv →
// $env/dynamic/private, PUT the chunk, MOVE-assemble on the last chunk).
//
// No logic lives here beyond that delegation — callers use FilesBackendPort.

import { error } from '@sveltejs/kit'
import { createNextcloudClient } from '../nextcloud-client'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import type { DavEntry, FilesBackendPort, UploadChunkInput, UploadChunkResult } from './port'

export class InprocessFilesClient implements FilesBackendPort {
  readonly kind = 'inprocess' as const

  private readonly webdavBearer: string | undefined
  private _nc: ReturnType<typeof createNextcloudClient> | undefined

  constructor(opts: { webdavBearer?: string } = {}) {
    this.webdavBearer = opts.webdavBearer
  }

  /** The per-request Nextcloud client, built lazily on first WebDAV op with the
   *  logged-in user's Keycloak access token (WI-5b OIDC bearer) — identical to
   *  the pre-seam route's single `const nc = createNextcloudClient({...})`.
   *  Lazy so the chunked-upload path (which uses raw admin-Basic fetches, never
   *  createNextcloudClient — exactly like the pre-seam upload-chunk route) does
   *  not construct an unused client. */
  private get nc(): ReturnType<typeof createNextcloudClient> {
    if (!this._nc) this._nc = createNextcloudClient({ webdavBearer: this.webdavBearer })
    return this._nc
  }

  // ── Browser WebDAV ops ───────────────────────────────────────────────────────

  propfind(webdavPath: string, uname: string): Promise<DavEntry[]> {
    return this.nc.propfind(webdavPath, uname)
  }

  download(webdavPath: string, uname: string): Promise<Response> {
    return this.nc.download(webdavPath, uname)
  }

  async upload(webdavPath: string, uname: string, body: BodyInit, contentType: string): Promise<void> {
    await this.nc.upload(webdavPath, uname, body, contentType)
  }

  async mkcol(webdavPath: string, uname: string): Promise<void> {
    await this.nc.mkcol(webdavPath, uname)
  }

  async delete(webdavPath: string, uname: string): Promise<void> {
    await this.nc.delete(webdavPath, uname)
  }

  async move(fromPath: string, toPath: string, uname: string): Promise<void> {
    await this.nc.move(fromPath, toPath, uname)
  }

  async copy(fromPath: string, toPath: string, uname: string): Promise<void> {
    await this.nc.copy(fromPath, toPath, uname)
  }

  // ── Chunked upload assembly ───────────────────────────────────────────────────
  // Byte-identical to routes/api/files/upload-chunk/+server.ts steps 4–6: env
  // resolution via $env/dynamic/private, PUT the padded chunk, MOVE-assemble on
  // the last chunk. Auth + param/path validation stay in the route handler
  // (thrown BEFORE this is called), so no fetch runs on a rejected request.
  async uploadChunk(input: UploadChunkInput): Promise<UploadChunkResult> {
    // G-023: env via `$env/dynamic/private`, not `process.env`.
    const ncUrl = defaultTenantEnv('NEXTCLOUD_URL')?.replace(/\/$/, '')
    const ncUser = defaultTenantEnv('NEXTCLOUD_ADMIN_USER')
    const ncPass = defaultTenantEnv('NEXTCLOUD_ADMIN_PASSWORD')
    if (!ncUrl || !ncUser || !ncPass) throw error(500, 'Nextcloud env vars not configured')

    const authHeader = 'Basic ' + Buffer.from(ncUser + ':' + ncPass).toString('base64')
    const userId = input.userId

    const chunkPadded = String(input.chunkIndex).padStart(10, '0')
    const chunkUrl = `${ncUrl}/remote.php/dav/uploads/${encodeURIComponent(userId)}/${encodeURIComponent(input.uploadId)}/${chunkPadded}`

    const chunkRes = await fetch(chunkUrl, {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'OCS-APIRequest': 'true',
        'X-Nextcloud-User': userId,
      },
      body: input.body,
    })
    if (!chunkRes.ok) {
      const snippet = await chunkRes.text().then((t) => t.slice(0, 200)).catch(() => '')
      throw error(502, `Chunk upload failed: ${chunkRes.status} ${snippet}`)
    }

    const isLast = input.chunkIndex === input.totalChunks - 1
    if (isLast) {
      const sourceUrl = `${ncUrl}/remote.php/dav/uploads/${encodeURIComponent(userId)}/${encodeURIComponent(input.uploadId)}/.file`
      const destUrl = `${ncUrl}/remote.php/dav/files/${encodeURIComponent(userId)}/${input.sanitizedPath}`
      const moveHeaders: Record<string, string> = {
        Authorization: authHeader,
        'OCS-APIRequest': 'true',
        Destination: destUrl,
        Overwrite: 'F',
      }
      if (input.totalSize) {
        // OC-Total-Length tells Nextcloud the final assembled file size for validation
        moveHeaders['OC-Total-Length'] = input.totalSize
      }
      // Note: Nextcloud upload sessions expire after 24 hours; ensure upload completes within that window.
      const moveRes = await fetch(sourceUrl, { method: 'MOVE', headers: moveHeaders })
      if (!moveRes.ok) {
        const snippet = await moveRes.text().then((t) => t.slice(0, 200)).catch(() => '')
        throw error(502, `Chunk assembly failed: ${moveRes.status} ${snippet}`)
      }
    }

    return { complete: isLast }
  }
}
