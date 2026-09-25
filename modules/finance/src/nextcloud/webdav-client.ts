// services/finance/src/nextcloud/webdav-client.ts
// #383 Lane E2, (R7) — the finance leaf's OWN Nextcloud WebDAV client for the
// receipt-storage backend. Operator-ratified: THE LEAF CARRIES THE WEBDAV CLIENT
// (it does NOT import gremion-ui/.../files/nextcloud-client — separate process). The
// browser-CRUD subset the receipt storage backend drives (upload/download/delete/
// mkcol) is reproduced here; mirror it if the files leaf's client changes.
//
// Auth — MIRRORS the native NextcloudStorageBackend posture EXACTLY. The native
// storage backend is built with `createNextcloudClient()` (NO webdavBearer), so
// every WebDAV op authenticates with the leaf's Nextcloud ADMIN Basic creds and
// impersonates the storage system-user via the `X-Nextcloud-User` header — the
// system-context (admin-Basic) DAV session, NOT a per-request user bearer. Since
// the storage user defaults to NEXTCLOUD_ADMIN_USER, the impersonation is a no-op
// in the default deployment, but we forward it for faithful parity + non-default
// STORAGE_NEXTCLOUD_USER support.
//
// The path passed to every method is the FULL, already-percent-encoded WebDAV path
// (`/remote.php/dav/files/<user>/<encoded-rel>`) the NextcloudStorageBackend builds
// (byte-identical handle to the native oracle — see ../storage/nextcloud.ts).

/** Body payloads the leaf forwards to Nextcloud. The receipt bytes arrive as a `Blob`
 *  (the storage backend wraps its exact-size buffer in one — mirrors the native oracle,
 *  and a Blob is a valid fetch `BodyInit` under BOTH the leaf's node-only `lib` AND the
 *  kernel's DOM `lib`, unlike a bare Uint8Array); string bodies (not used by the storage
 *  subset) would be XML/PROPFIND. We enumerate the concrete types rather than the broad
 *  `BodyInit` so the file compiles under both tsconfigs. */
type WebdavBody = Blob | string

/** Non-2xx Nextcloud response — carries the upstream status so the storage backend
 *  can swallow the idempotent shapes (404 on delete, 405 "already exists" on mkcol)
 *  by `.status` rather than message-scraping. */
export class FinanceWebdavError extends Error {
  readonly status: number
  constructor(method: string, path: string, status: number, snippet: string) {
    super(`Nextcloud ${method} ${path} → ${status}: ${snippet}`)
    this.name = 'FinanceWebdavError'
    this.status = status
  }
}

export interface FinanceWebdavConfig {
  baseUrl: string
  adminUser: string
  adminPassword: string
}

async function snippetOf(res: Response): Promise<string> {
  return res.text().then((t) => t.slice(0, 200)).catch(() => '')
}

export class FinanceWebdavClient {
  private readonly baseUrl: string
  private readonly adminUser: string
  private readonly adminPassword: string

  constructor(cfg: FinanceWebdavConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '')
    this.adminUser = cfg.adminUser
    this.adminPassword = cfg.adminPassword
  }

  private adminAuth(): string {
    return 'Basic ' + Buffer.from(`${this.adminUser}:${this.adminPassword}`).toString('base64')
  }

  /** One WebDAV request as the admin, impersonating `impersonateUser` (native
   *  storage-backend posture: admin Basic + X-Nextcloud-User). Throws
   *  FinanceWebdavError on a non-2xx so the caller can branch on `.status`. */
  private async request(
    method: string,
    path: string,
    impersonateUser: string,
    opts: { headers?: Record<string, string>; body?: WebdavBody } = {},
  ): Promise<Response> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: this.adminAuth(),
        'OCS-APIRequest': 'true',
        'X-Nextcloud-User': impersonateUser,
        ...(opts.headers ?? {}),
      },
      body: opts.body,
    })
    if (!res.ok) throw new FinanceWebdavError(method, path, res.status, await snippetOf(res))
    return res
  }

  /** GET the object bytes (Response streamed; the storage backend reads arrayBuffer). */
  async download(path: string, impersonateUser: string): Promise<Response> {
    return this.request('GET', path, impersonateUser)
  }

  /** PUT the object bytes with an explicit Content-Type. */
  async upload(path: string, impersonateUser: string, body: WebdavBody, contentType: string): Promise<void> {
    await this.request('PUT', path, impersonateUser, { headers: { 'Content-Type': contentType }, body })
  }

  /** MKCOL a collection (409/405 "already exists" is the success-shaped failure the
   *  storage backend swallows). */
  async mkcol(path: string, impersonateUser: string): Promise<void> {
    await this.request('MKCOL', path, impersonateUser)
  }

  /** DELETE the object (404 "already gone" is the idempotent shape the backend swallows). */
  async delete(path: string, impersonateUser: string): Promise<void> {
    await this.request('DELETE', path, impersonateUser)
  }
}

/** Build a FinanceWebdavClient from the leaf's environment (NEXTCLOUD_URL + the shared
 *  admin Basic creds — the SAME NEXTCLOUD_ADMIN_* the files-service already carries). */
export function createFinanceWebdavClient(): FinanceWebdavClient {
  return new FinanceWebdavClient({
    baseUrl: process.env.NEXTCLOUD_URL ?? 'http://nextcloud',
    adminUser: process.env.NEXTCLOUD_ADMIN_USER ?? 'admin',
    adminPassword: process.env.NEXTCLOUD_ADMIN_PASSWORD ?? '',
  })
}
