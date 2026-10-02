import { DOMParser } from '@xmldom/xmldom'
import { serviceEnv } from '$lib/server/env/service-env'

export interface DavEntry {
  href: string
  displayName: string
  contentType: string | null
  contentLength: number | null
  lastModified: string
  etag: string | null
  isCollection: boolean
}

export interface CalendarInfo {
  href: string
  displayName: string
  color: string | null
  enabled: boolean
}

export interface CalendarEvent {
  uid: string
  href: string
  etag: string | null
  icsData: string
}

export interface GroupFolderResult {
  id: number
  mountPoint: string
}

/**
 * Typed error for a non-OK Nextcloud response. Carries the structured fields the
 * files API needs to instrument the intermittent "<!DOCTYPE … is not valid JSON"
 * failure (#161): the upstream status, the response Content-Type, a body snippet,
 * and whether that body is an HTML page (login/401/error) returned where JSON or
 * WebDAV XML was expected. `message` keeps the legacy
 * "Nextcloud <method> <path> → <status>: <snippet>" format so existing callers
 * (and the `/→ (40[34]):/` status-extraction regex in the files route) keep
 * working unchanged.
 */
export class NextcloudResponseError extends Error {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly contentType: string | null
  readonly bodySnippet: string
  /** True when the upstream body looks like an HTML document (leading <!DOCTYPE
   *  or <html), or the Content-Type is text/html — the exact shape that makes a
   *  downstream `res.json()` throw "Unexpected token '<'". */
  readonly isHtml: boolean

  constructor(opts: {
    method: string
    path: string
    status: number
    contentType: string | null
    bodySnippet: string
  }) {
    super(`Nextcloud ${opts.method} ${opts.path} → ${opts.status}: ${opts.bodySnippet}`)
    this.name = 'NextcloudResponseError'
    this.method = opts.method
    this.path = opts.path
    this.status = opts.status
    this.contentType = opts.contentType
    this.bodySnippet = opts.bodySnippet
    this.isHtml =
      /^\s*<(?:!doctype|html)/i.test(opts.bodySnippet) ||
      (opts.contentType?.toLowerCase().includes('text/html') ?? false)
  }
}

/** Build a NextcloudResponseError from a failed Response (reads its body). */
async function responseError(method: string, path: string, res: Response): Promise<NextcloudResponseError> {
  const bodySnippet = await res
    .text()
    .then((t) => t.slice(0, 200))
    .catch(() => '')
  return new NextcloudResponseError({
    method,
    path,
    status: res.status,
    contentType: res.headers?.get('Content-Type') ?? null,
    bodySnippet,
  })
}

export class NextcloudClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminUser: string,
    private readonly adminPassword: string,
    /** CalDAV per-user tokens: "user1:token1,user2:token2" */
    private readonly caldavUserTokens: string = '',
    /** WebDAV / Files per-user credentials: "user1:password1,user2:password2"
     *  Used because X-Nextcloud-User impersonation does not expose user files via WebDAV.
     *  Legacy/fallback path — the durable mechanism is the per-request OIDC bearer below. */
    private readonly webdavUserTokens: string = '',
    /** WI-5b durable per-user WebDAV auth: the logged-in user's Keycloak access
     *  token. When set, it is used as a `Bearer` for WebDAV (NC `user_oidc` validates
     *  it as that user), so no per-user app token needs minting/storing and every
     *  provisioned user is covered automatically. Falls back to webdavUserTokens
     *  when unset (e.g. system/admin contexts that have no user session). */
    private readonly webdavBearer: string = ''
  ) {}

  private authHeader(): string {
    return 'Basic ' + Buffer.from(this.adminUser + ':' + this.adminPassword).toString('base64')
  }

  /** Validate that the configured admin Basic credentials are accepted by
   *  Nextcloud. Used by the setup health check to surface a bad/empty
   *  NEXTCLOUD_ADMIN_PASSWORD distinctly from mere reachability. Returns false
   *  on any auth/transport failure rather than throwing, so the caller can
   *  treat it as a boolean probe. Calls GET ocs/v2.php/cloud/user (whoami) with
   *  admin Basic auth + OCS-APIRequest header. Nextcloud answers an
   *  authentication failure with HTTP 401 (and/or OCS meta statuscode 997), so
   *  both signals are checked. */
  async validateCredentials(timeoutMs = 3000): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const url = this.baseUrl.replace(/\/$/, '') + '/ocs/v2.php/cloud/user?format=json'
      const res = await fetch(url, {
        headers: {
          Authorization: this.authHeader(),
          'OCS-APIRequest': 'true',
          Accept: 'application/json'
        },
        signal: controller.signal
      })
      clearTimeout(timer)
      if (!res.ok) return false
      // Some Nextcloud versions return HTTP 200 with an OCS error envelope on
      // bad credentials — treat a non-2xx OCS meta statuscode as invalid.
      try {
        const body = (await res.json()) as { ocs?: { meta?: { statuscode?: number } } }
        const code = body.ocs?.meta?.statuscode
        if (code !== undefined && (code < 200 || code >= 300)) return false
      } catch {
        // Non-JSON 2xx body — accept HTTP-level success.
      }
      return true
    } catch {
      return false
    }
  }

  /** Look up a per-user auth header from a comma-separated "user:secret" string. */
  private lookupUserAuth(userId: string, tokenString: string): string | null {
    for (const entry of tokenString.split(',')) {
      const colon = entry.indexOf(':')
      if (colon < 1) continue
      const u = entry.slice(0, colon).trim()
      const t = entry.slice(colon + 1).trim()
      if (u === userId && t) return 'Basic ' + Buffer.from(`${u}:${t}`).toString('base64')
    }
    return null
  }

  /** Per-user CalDAV token (app password). */
  private userAuthHeader(userId: string): string | null {
    return this.lookupUserAuth(userId, this.caldavUserTokens)
  }

  /** Per-user WebDAV auth. Prefers the logged-in user's OIDC bearer (WI-5b —
   *  durable, covers every provisioned user); falls back to a configured app
   *  token, then null (caller decides). The bearer is always the current
   *  request's user, which is also the `userId` every files-route call passes. */
  private webdavUserAuth(userId: string): string | null {
    if (this.webdavBearer) return `Bearer ${this.webdavBearer}`
    return this.lookupUserAuth(userId, this.webdavUserTokens)
  }

  private async request(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: string; impersonate?: string; userAuth?: string }
  ): Promise<Response> {
    const url = this.baseUrl.replace(/\/$/, '') + path
    const headers: Record<string, string> = {
      Authorization: opts?.userAuth ?? this.authHeader(),
      'OCS-APIRequest': 'true',
      ...opts?.headers
    }
    // X-Nextcloud-User only works for WebDAV files, not CalDAV — skip when userAuth is set
    if (opts?.impersonate && !opts.userAuth) {
      headers['X-Nextcloud-User'] = opts.impersonate
    }
    const res = await fetch(url, { method, headers, body: opts?.body })
    if (!res.ok) {
      throw await responseError(method, path, res)
    }
    return res
  }

  async propfind(path: string, userId: string, depth: '0' | '1' = '1'): Promise<DavEntry[]> {
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
    const userAuth = this.webdavUserAuth(userId)
    const res = await this.request('PROPFIND', path, {
      headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      ...(userAuth ? { userAuth } : { impersonate: userId })
    })
    const xml = await res.text()
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const responses = Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))
    const entries: DavEntry[] = []
    for (const resp of responses) {
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? ''
      // Skip the root entry. Nextcloud may prefix hrefs with the configured
      // webroot (e.g. /cloud), so match on suffix as well as the exact path.
      if (href === path || href === path + '/' || href.endsWith(path)) continue
      const propstat = resp.getElementsByTagNameNS('DAV:', 'propstat')[0]
      const prop = propstat?.getElementsByTagNameNS('DAV:', 'prop')[0]
      const resourcetype = prop?.getElementsByTagNameNS('DAV:', 'resourcetype')[0]
      const isCollection =
        (resourcetype?.getElementsByTagNameNS('DAV:', 'collection').length ?? 0) > 0
      const displayName =
        prop?.getElementsByTagNameNS('DAV:', 'displayname')[0]?.textContent ??
        href.split('/').filter(Boolean).pop() ??
        ''
      const contentType =
        prop?.getElementsByTagNameNS('DAV:', 'getcontenttype')[0]?.textContent ?? null
      const contentLengthStr =
        prop?.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? null
      const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : null
      const lastModified =
        prop?.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? ''
      const etag = prop?.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent ?? null
      entries.push({ href, displayName, contentType, contentLength, lastModified, etag, isCollection })
    }
    return entries
  }

  async download(path: string, userId: string): Promise<Response> {
    const userAuth = this.webdavUserAuth(userId)
    return this.request('GET', path, userAuth ? { userAuth } : { impersonate: userId })
  }

  async upload(
    path: string,
    userId: string,
    body: BodyInit,
    contentType: string
  ): Promise<void> {
    const url = this.baseUrl.replace(/\/$/, '') + path
    const userAuth = this.webdavUserAuth(userId)
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: userAuth ?? this.authHeader(),
        'OCS-APIRequest': 'true',
        'Content-Type': contentType,
        ...(!userAuth ? { 'X-Nextcloud-User': userId } : {})
      },
      body
    })
    if (!res.ok) {
      throw await responseError('PUT', path, res)
    }
  }

  async delete(path: string, userId: string): Promise<void> {
    const userAuth = this.webdavUserAuth(userId)
    await this.request('DELETE', path, userAuth ? { userAuth } : { impersonate: userId })
  }

  async move(fromPath: string, toPath: string, userId: string): Promise<void> {
    const destination = this.baseUrl.replace(/\/$/, '') + toPath
    const userAuth = this.webdavUserAuth(userId)
    await this.request('MOVE', fromPath, {
      headers: { Destination: destination, Overwrite: 'F' },
      ...(userAuth ? { userAuth } : { impersonate: userId })
    })
  }

  async copy(fromPath: string, toPath: string, userId: string): Promise<void> {
    const destination = this.baseUrl.replace(/\/$/, '') + toPath
    const userAuth = this.webdavUserAuth(userId)
    await this.request('COPY', fromPath, {
      headers: { Destination: destination, Overwrite: 'F' },
      ...(userAuth ? { userAuth } : { impersonate: userId })
    })
  }

  async mkcol(path: string, userId: string): Promise<void> {
    const userAuth = this.webdavUserAuth(userId)
    await this.request('MKCOL', path, userAuth ? { userAuth } : { impersonate: userId })
  }

  /** List all group folders known to this NC instance.
   *  NC returns an id-keyed object on older versions and an array on newer ones —
   *  both shapes are normalised.  A `null`/`false` data field (empty install)
   *  is treated as an empty list. */
  async listGroupFolders(): Promise<GroupFolderResult[]> {
    const res = await this.request('GET', '/index.php/apps/groupfolders/folders?format=json')
    const json = await res.json()
    const data = json?.ocs?.data ?? null
    if (!data) return []
    const entries: Array<{ id: number; mount_point: string }> = Array.isArray(data)
      ? data
      : Object.values(data)
    return entries.map((e) => ({ id: Number(e.id), mountPoint: e.mount_point }))
  }

  async createGroupFolder(mountPoint: string): Promise<GroupFolderResult> {
    const res = await this.request(
      'POST',
      '/index.php/apps/groupfolders/folders?format=json',
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `mountpoint=${encodeURIComponent(mountPoint)}`
      }
    )
    const json = await res.json()
    return {
      id: json.ocs.data.id as number,
      mountPoint: json.ocs.data.mount_point as string
    }
  }

  async assignGroupFolderPermissions(
    folderId: number,
    groupId: string,
    permissions = 31
  ): Promise<void> {
    // 1. Add the group to the folder (groupfolders Folder#addGroup route).
    await this.request(
      'POST',
      `/index.php/apps/groupfolders/folders/${folderId}/groups`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `group=${encodeURIComponent(groupId)}`
      }
    )
    // 2. Set its permission level (groupfolders Folder#setPermissions route).
    await this.request(
      'POST',
      `/index.php/apps/groupfolders/folders/${folderId}/groups/${encodeURIComponent(groupId)}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `permissions=${permissions}`
      }
    )
  }

  /** Create a Nextcloud group via the OCS provisioning API. Idempotent: an
   *  "already exists" response (OCS status 102) is treated as success. */
  async createGroup(groupId: string): Promise<void> {
    try {
      await this.request('POST', '/ocs/v1.php/cloud/groups', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `groupid=${encodeURIComponent(groupId)}`
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already exists') || msg.includes('102')) return
      throw err
    }
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.request('DELETE', `/ocs/v1.php/cloud/groups/${encodeURIComponent(groupId)}`)
  }

  async addUserToGroup(userId: string, groupId: string): Promise<void> {
    await this.request('POST', `/ocs/v1.php/cloud/users/${encodeURIComponent(userId)}/groups`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `groupid=${encodeURIComponent(groupId)}`
    })
  }

  async removeUserFromGroup(userId: string, groupId: string): Promise<void> {
    await this.request('DELETE', `/ocs/v1.php/cloud/users/${encodeURIComponent(userId)}/groups`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `groupid=${encodeURIComponent(groupId)}`
    })
  }

  async deleteGroupFolder(folderId: number): Promise<void> {
    await this.request('DELETE', `/index.php/apps/groupfolders/folders/${folderId}`)
  }

  /** Pre-create (or update) a Nextcloud account managed by the user_oidc app
   *  so a committee member has a working account before their first SSO login.
   *  `userId` is the raw Keycloak UUID — it matches the NC user id because the
   *  user_oidc provider is configured with --unique-uid=0. Idempotent:
   *  user_oidc's createUser is create-or-update. */
  async provisionOidcUser(data: {
    providerId: number
    userId: string
    displayName?: string | null
    email?: string | null
  }): Promise<void> {
    await this.request('POST', '/ocs/v2.php/apps/user_oidc/api/v1/user?format=json', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: data.providerId,
        userId: data.userId,
        displayName: data.displayName ?? undefined,
        email: data.email ?? undefined
      })
    })
  }

  async listCalendars(userId: string): Promise<CalendarInfo[]> {
    const path = `/remote.php/dav/calendars/${encodeURIComponent(userId)}/`
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:apple="http://apple.com/ns/ical/">
  <D:prop>
    <D:displayname/>
    <cal:calendar-enabled/>
    <apple:calendar-color/>
  </D:prop>
</D:propfind>`
    const res = await this.request('PROPFIND', path, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      impersonate: userId,
      userAuth: this.userAuthHeader(userId) ?? undefined,
    })
    const xml = await res.text()
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const responses = Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))
    const calendars: CalendarInfo[] = []
    for (const resp of responses) {
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? ''
      if (href === path) continue
      const prop = resp.getElementsByTagNameNS('DAV:', 'propstat')[0]
        ?.getElementsByTagNameNS('DAV:', 'prop')[0]
      const enabledText = prop
        ?.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'calendar-enabled')[0]
        ?.textContent ?? '0'
      if (enabledText !== '1') continue
      const displayName = prop?.getElementsByTagNameNS('DAV:', 'displayname')[0]?.textContent ?? ''
      const color =
        prop?.getElementsByTagNameNS('http://apple.com/ns/ical/', 'calendar-color')[0]
          ?.textContent ?? null
      calendars.push({ href, displayName, color, enabled: true })
    }
    return calendars
  }

  async listEvents(
    calPath: string,
    userId: string,
    rangeStart: string,
    rangeEnd: string
  ): Promise<CalendarEvent[]> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${rangeStart}" end="${rangeEnd}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`
    const res = await this.request('REPORT', calPath, {
      headers: {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body,
      impersonate: userId,
      userAuth: this.userAuthHeader(userId) ?? undefined,
    })
    const xml = await res.text()
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const responses = Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))
    const events: CalendarEvent[] = []
    for (const resp of responses) {
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? ''
      const prop = resp.getElementsByTagNameNS('DAV:', 'propstat')[0]
        ?.getElementsByTagNameNS('DAV:', 'prop')[0]
      const etag = prop?.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent ?? null
      const icsData =
        prop
          ?.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'calendar-data')[0]
          ?.textContent ?? ''
      if (!icsData) continue
      const uidMatch = icsData.match(/^UID:(.+)$/m)
      const uid = uidMatch ? uidMatch[1].trim() : href.split('/').pop()?.replace('.ics', '') ?? ''
      events.push({ uid, href, etag, icsData })
    }
    return events
  }

  async getEvent(eventPath: string, userId: string): Promise<CalendarEvent> {
    const res = await this.request('GET', eventPath, {
      impersonate: userId,
      userAuth: this.userAuthHeader(userId) ?? undefined,
    })
    const icsData = await res.text()
    const etag = res.headers.get('ETag')
    const uidMatch = icsData.match(/^UID:(.+)$/m)
    const uid = uidMatch ? uidMatch[1].trim() : eventPath.split('/').pop()?.replace('.ics', '') ?? ''
    return { uid, href: eventPath, etag, icsData }
  }

  async createOrUpdateEvent(
    calPath: string,
    uid: string,
    userId: string,
    icsData: string
  ): Promise<void> {
    const eventPath = calPath.replace(/\/$/, '') + '/' + uid + '.ics'
    const url = this.baseUrl.replace(/\/$/, '') + eventPath
    const userAuth = this.userAuthHeader(userId)
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: userAuth ?? this.authHeader(),
        'OCS-APIRequest': 'true',
        'Content-Type': 'text/calendar; charset=utf-8',
        ...(!userAuth ? { 'X-Nextcloud-User': userId } : {})
      },
      body: icsData
    })
    if (!res.ok) {
      const snippet = await res.text().then((t) => t.slice(0, 200)).catch(() => '')
      throw new Error(`Nextcloud PUT event ${eventPath} → ${res.status}: ${snippet}`)
    }
  }

  async deleteEvent(eventPath: string, userId: string): Promise<void> {
    await this.request('DELETE', eventPath, {
      impersonate: userId,
      userAuth: this.userAuthHeader(userId) ?? undefined,
    })
  }

  /** Get the Nextcloud internal fileId for a WebDAV path.
   *  Uses PROPFIND Depth:0 with the {http://owncloud.org/ns}fileid property.
   *  Used by the collaborative editor (WOPI) flow to resolve a path to the
   *  numeric identifier that richdocuments expects. */
  async getFileId(path: string, userId: string): Promise<number> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns">
  <D:prop><oc:fileid/></D:prop>
</D:propfind>`
    const userAuth = this.webdavUserAuth(userId)
    const res = await this.request('PROPFIND', path, {
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      ...(userAuth ? { userAuth } : { impersonate: userId })
    })
    const xml = await res.text()
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const fileIdEl = doc.getElementsByTagNameNS('http://owncloud.org/ns', 'fileid')[0]
    const fileId = parseInt(fileIdEl?.textContent ?? '', 10)
    if (isNaN(fileId)) {
      throw new Error(`Could not parse fileId from PROPFIND response for ${path}`)
    }
    return fileId
  }

  /** Create a short-lived direct-edit session via richdocuments OCS API.
   *  Returns the Nextcloud direct-view page URL (single-use token embedded in path).
   *  fileId must come from getFileId(). Calls as the user (per-user token). */
  async getDirectEditUrl(fileId: number, userId: string): Promise<string> {
    const userAuth = this.webdavUserAuth(userId)
    const res = await this.request(
      'POST',
      '/ocs/v2.php/apps/richdocuments/api/v1/document?format=json',
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `fileId=${fileId}`,
        ...(userAuth ? { userAuth } : { impersonate: userId })
      }
    )
    const data = (await res.json()) as { ocs?: { data?: { url?: string } } }
    const url = data.ocs?.data?.url
    if (!url) throw new Error('createDirect: missing url in response')
    return url
  }

  /** Resolve a full browser-ready Collabora editor URL for the given file.
   *
   * Nextcloud's createDirect API returns a single-use page URL that is blocked
   * by Nextcloud's own CSP when embedded in an iframe from a different origin.
   * This method fetches that page server-side (consuming the one-time token),
   * extracts the WOPI token and urlsrc from the embedded initial state, and
   * constructs the direct Collabora URL that the browser CAN embed.
   *
   * Returns { editorUrl, tokenTtl } where:
   *   - editorUrl: full Collabora URL with WOPISrc + access_token + access_token_ttl
   *   - tokenTtl:  Unix seconds timestamp when the WOPI token expires */
  async getCollaboraEditorUrl(
    fileId: number,
    userId: string
  ): Promise<{ editorUrl: string; tokenTtl: number }> {
    const directUrl = await this.getDirectEditUrl(fileId, userId)

    const pageRes = await fetch(directUrl)
    if (!pageRes.ok) {
      const snippet = await pageRes.text().then((t) => t.slice(0, 200)).catch(() => '')
      throw new Error(`Nextcloud direct view page → ${pageRes.status}: ${snippet}`)
    }
    const html = await pageRes.text()

    const doc = extractInitialState<{
      token: string
      token_ttl: number
      urlsrc: string
      fileId: string
    }>(html, 'richdocuments-document')

    const callbackUrl = extractInitialState<string>(html, 'richdocuments-wopi_callback_url')

    if (!doc?.token || !doc?.urlsrc || !doc?.fileId || !callbackUrl) {
      throw new Error('Collabora editor data missing from Nextcloud direct view page')
    }

    const wopiSrc =
      callbackUrl.replace(/\/$/, '') +
      `/index.php/apps/richdocuments/wopi/files/${doc.fileId}`

    const editorUrl =
      `${doc.urlsrc}WOPISrc=${encodeURIComponent(wopiSrc)}` +
      `&access_token=${encodeURIComponent(doc.token)}` +
      `&access_token_ttl=${doc.token_ttl * 1000}`

    return { editorUrl, tokenTtl: doc.token_ttl }
  }
}

/** Extract and JSON-parse a Nextcloud initial-state value from HTML.
 *  Initial states are encoded as base64 JSON in hidden input fields. */
function extractInitialState<T>(html: string, key: string): T | null {
  const match = html.match(
    new RegExp(`id="initial-state-${key.replace(/[-[\]{}()*+?.\\^$|]/g, '\\$&')}" value="([^"]+)"`)
  )
  if (!match) return null
  try {
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf-8')) as T
  } catch {
    return null
  }
}

/**
 * Build a NextcloudClient. Pass `webdavBearer` (the logged-in user's Keycloak
 * access token, from `locals.accessToken`) on per-user file requests so WebDAV
 * authenticates as that user via OIDC bearer (WI-5b). System/admin contexts
 * (provisioning, newsletter, protocol publishing) omit it and keep admin Basic.
 */
export function createNextcloudClient(opts: { webdavBearer?: string } = {}): NextcloudClient {
  return new NextcloudClient(
    serviceEnv('NEXTCLOUD_URL') ?? 'http://nextcloud',
    serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin',
    serviceEnv('NEXTCLOUD_ADMIN_PASSWORD') ?? '',
    serviceEnv('NEXTCLOUD_CALDAV_USER_TOKENS') ?? '',
    serviceEnv('NEXTCLOUD_USER_TOKENS') ?? '',
    opts.webdavBearer ?? ''
  )
}
