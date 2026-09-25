// services/files/src/nextcloud/webdav-client.ts
// The files leaf's Nextcloud WebDAV client — the browser-CRUD subset the kernel
// files routes drive (propfind/download/upload/mkcol/delete/move/copy) plus the
// chunked-upload assembly. This is a SEPARATE process from the kernel: it does
// NOT import gremion-ui/src/lib/server/files/nextcloud-client; the relevant subset
// is reproduced here (mirror it if the kernel client changes).
//
// Auth: browser ops authenticate AS the logged-in user via the OIDC access token
// the kernel forwards (x-webdav-bearer → `Bearer <token>`, WI-5b). The chunked
// upload uses the leaf's own Nextcloud admin Basic creds (the kernel's
// upload-chunk route does the same — admin-credentialed DAV upload session).
import { DOMParser } from '@xmldom/xmldom'

/** Body payloads the leaf forwards to Nextcloud. The leaf buffers request bodies
 *  (server.ts readBody → Buffer) and builds XML strings; a broad `BodyInit`
 *  (DOM lib) is unavailable under the leaf's node-only `lib`, so we enumerate
 *  the concrete types actually passed. */
type WebdavBody = Uint8Array | string

export interface DavEntry {
  href: string
  displayName: string
  contentType: string | null
  contentLength: number | null
  lastModified: string
  etag: string | null
  isCollection: boolean
}

/** Non-OK Nextcloud response — carries the upstream status for HTTP mapping. */
export class NextcloudUpstreamError extends Error {
  readonly status: number
  constructor(method: string, path: string, status: number, snippet: string) {
    super(`Nextcloud ${method} ${path} → ${status}: ${snippet}`)
    this.name = 'NextcloudUpstreamError'
    this.status = status
  }
}

export interface WebdavClientConfig {
  baseUrl: string
  adminUser: string
  adminPassword: string
}

async function snippetOf(res: Response): Promise<string> {
  return res.text().then((t) => t.slice(0, 200)).catch(() => '')
}

export class WebdavClient {
  private readonly baseUrl: string
  private readonly adminUser: string
  private readonly adminPassword: string

  constructor(cfg: WebdavClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '')
    this.adminUser = cfg.adminUser
    this.adminPassword = cfg.adminPassword
  }

  private adminAuth(): string {
    return 'Basic ' + Buffer.from(`${this.adminUser}:${this.adminPassword}`).toString('base64')
  }

  /** Per-request auth header: prefer the forwarded user bearer (WI-5b), else the
   *  admin Basic fallback (system contexts). */
  private auth(bearer: string | undefined): string {
    return bearer ? `Bearer ${bearer}` : this.adminAuth()
  }

  private async request(
    method: string,
    path: string,
    bearer: string | undefined,
    opts: { headers?: Record<string, string>; body?: WebdavBody } = {},
  ): Promise<Response> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: this.auth(bearer),
        'OCS-APIRequest': 'true',
        ...(opts.headers ?? {}),
      },
      body: opts.body,
    })
    if (!res.ok) throw new NextcloudUpstreamError(method, path, res.status, await snippetOf(res))
    return res
  }

  async propfind(path: string, bearer: string | undefined, depth: '0' | '1' = '1'): Promise<DavEntry[]> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontenttype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:getetag/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`
    const res = await this.request('PROPFIND', path, bearer, {
      headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
      body,
    })
    const xml = await res.text()
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const responses = Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))
    const entries: DavEntry[] = []
    for (const resp of responses) {
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? ''
      if (href === path || href === path + '/' || href.endsWith(path)) continue
      const propstat = resp.getElementsByTagNameNS('DAV:', 'propstat')[0]
      const prop = propstat?.getElementsByTagNameNS('DAV:', 'prop')[0]
      const resourcetype = prop?.getElementsByTagNameNS('DAV:', 'resourcetype')[0]
      const isCollection = (resourcetype?.getElementsByTagNameNS('DAV:', 'collection').length ?? 0) > 0
      const displayName =
        prop?.getElementsByTagNameNS('DAV:', 'displayname')[0]?.textContent ??
        href.split('/').filter(Boolean).pop() ??
        ''
      const contentType = prop?.getElementsByTagNameNS('DAV:', 'getcontenttype')[0]?.textContent ?? null
      const contentLengthStr = prop?.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? null
      const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : null
      const lastModified = prop?.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? ''
      const etag = prop?.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent ?? null
      entries.push({ href, displayName, contentType, contentLength, lastModified, etag, isCollection })
    }
    return entries
  }

  async download(path: string, bearer: string | undefined): Promise<Response> {
    return this.request('GET', path, bearer)
  }

  async upload(path: string, bearer: string | undefined, body: WebdavBody, contentType: string): Promise<void> {
    await this.request('PUT', path, bearer, { headers: { 'Content-Type': contentType }, body })
  }

  async mkcol(path: string, bearer: string | undefined): Promise<void> {
    await this.request('MKCOL', path, bearer)
  }

  async delete(path: string, bearer: string | undefined): Promise<void> {
    await this.request('DELETE', path, bearer)
  }

  async move(fromPath: string, toPath: string, bearer: string | undefined): Promise<void> {
    await this.request('MOVE', fromPath, bearer, {
      headers: { Destination: this.baseUrl + toPath, Overwrite: 'F' },
    })
  }

  async copy(fromPath: string, toPath: string, bearer: string | undefined): Promise<void> {
    await this.request('COPY', fromPath, bearer, {
      headers: { Destination: this.baseUrl + toPath, Overwrite: 'F' },
    })
  }

  /** Chunked-upload assembly (admin Basic — mirrors the kernel upload-chunk
   *  route). PUT the padded chunk; on the last chunk, MOVE-assemble it into the
   *  user's files. `sanitizedPath` is validated by the caller. */
  async uploadChunk(input: {
    userId: string
    uploadId: string
    chunkIndex: number
    totalChunks: number
    sanitizedPath: string
    totalSize: string | null
    body: WebdavBody | null
  }): Promise<{ complete: boolean }> {
    const authHeader = this.adminAuth()
    const { userId } = input
    const chunkPadded = String(input.chunkIndex).padStart(10, '0')
    const chunkUrl = `${this.baseUrl}/remote.php/dav/uploads/${encodeURIComponent(userId)}/${encodeURIComponent(input.uploadId)}/${chunkPadded}`
    const chunkRes = await fetch(chunkUrl, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'OCS-APIRequest': 'true', 'X-Nextcloud-User': userId },
      body: input.body,
    })
    if (!chunkRes.ok) {
      throw new NextcloudUpstreamError('PUT', chunkUrl, chunkRes.status, await snippetOf(chunkRes))
    }

    const isLast = input.chunkIndex === input.totalChunks - 1
    if (isLast) {
      const sourceUrl = `${this.baseUrl}/remote.php/dav/uploads/${encodeURIComponent(userId)}/${encodeURIComponent(input.uploadId)}/.file`
      const destUrl = `${this.baseUrl}/remote.php/dav/files/${encodeURIComponent(userId)}/${input.sanitizedPath}`
      const moveHeaders: Record<string, string> = {
        Authorization: authHeader,
        'OCS-APIRequest': 'true',
        Destination: destUrl,
        Overwrite: 'F',
      }
      if (input.totalSize) moveHeaders['OC-Total-Length'] = input.totalSize
      const moveRes = await fetch(sourceUrl, { method: 'MOVE', headers: moveHeaders })
      if (!moveRes.ok) {
        throw new NextcloudUpstreamError('MOVE', sourceUrl, moveRes.status, await snippetOf(moveRes))
      }
    }
    return { complete: isLast }
  }
}

/** Build a WebdavClient from the leaf's environment (NEXTCLOUD_URL + admin creds). */
export function createWebdavClient(): WebdavClient {
  return new WebdavClient({
    baseUrl: process.env.NEXTCLOUD_URL ?? 'http://nextcloud',
    adminUser: process.env.NEXTCLOUD_ADMIN_USER ?? 'admin',
    adminPassword: process.env.NEXTCLOUD_ADMIN_PASSWORD ?? '',
  })
}
