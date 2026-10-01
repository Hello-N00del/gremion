// services/calendar/src/caldav/pusher.ts
//
// Thin, direct WebDAV pusher for the calendar leaf — CalDAV-DIRECT per design
// §8 / global constraints: the leaf carries its own minimal WebDAV verbs and
// talks to Nextcloud directly with admin Basic auth from its own env. It does
// NOT import the kernel's files/nextcloud-client (that would re-introduce a
// kernel-internal import).
//
// The pusher targets a "shared calendar" owned by an admin/shared account:
//   /remote.php/dav/calendars/{CALDAV_SHARED_USER}/{CALDAV_SHARED_CALENDAR}/
//
// Env (leaf-local, see calendar-global-constraints.md):
//   NEXTCLOUD_URL, NEXTCLOUD_ADMIN_USER, NEXTCLOUD_ADMIN_PASSWORD,
//   CALDAV_SHARED_USER, CALDAV_SHARED_CALENDAR

import { buildIcs, type IcsEvent } from './client.js'

export type FetchImpl = typeof fetch

export interface CalDavPusher {
  /** Computed CalDAV collection path, e.g. /remote.php/dav/calendars/admin/stura/ */
  readonly calPath: string
  /** Upload a new event (PUT to CalDAV). */
  pushCreate(event: IcsEvent): Promise<void>
  /** Update an existing event (PUT replaces). Same wire call as create. */
  pushUpdate(event: IcsEvent): Promise<void>
  /** Remove an event by UID (DELETE). */
  pushDelete(uid: string): Promise<void>
}

interface CalDavPusherOptions {
  nextcloudUrl?: string
  adminUser?: string
  adminPassword?: string
  sharedUser?: string
  sharedCalendar?: string
  /** Injectable for test isolation; defaults to globalThis.fetch in production. */
  fetchImpl?: FetchImpl
  /** Per-request budget in ms (K4#7). Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number
}

/** One hung Nextcloud request must not stall the tenant tick (K4#7). */
export const DEFAULT_TIMEOUT_MS = 10_000

class DirectCalDavPusher implements CalDavPusher {
  private readonly baseUrl: string
  private readonly adminUser: string
  private readonly adminPassword: string
  private readonly userId: string
  private readonly calendarName: string
  private readonly fetchImpl: FetchImpl
  private readonly timeoutMs: number

  constructor(opts: {
    baseUrl: string
    adminUser: string
    adminPassword: string
    userId: string
    calendarName: string
    fetchImpl: FetchImpl
    timeoutMs: number
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.adminUser = opts.adminUser
    this.adminPassword = opts.adminPassword
    this.userId = opts.userId
    this.calendarName = opts.calendarName
    this.fetchImpl = opts.fetchImpl
    this.timeoutMs = opts.timeoutMs
  }

  get calPath(): string {
    return (
      '/remote.php/dav/calendars/' +
      encodeURIComponent(this.userId) +
      '/' +
      encodeURIComponent(this.calendarName) +
      '/'
    )
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(this.adminUser + ':' + this.adminPassword).toString('base64')
  }

  private eventPath(uid: string): string {
    return this.calPath.replace(/\/$/, '') + '/' + uid + '.ics'
  }

  private async put(uid: string, icsData: string): Promise<void> {
    const eventPath = this.eventPath(uid)
    const url = this.baseUrl + eventPath
    const res = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: this.authHeader(),
        'OCS-APIRequest': 'true',
        'Content-Type': 'text/calendar; charset=utf-8',
      },
      body: icsData,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) {
      const snippet = await res
        .text()
        .then((t) => t.slice(0, 200))
        .catch(() => '')
      throw new Error(`Nextcloud PUT event ${eventPath} → ${res.status}: ${snippet}`)
    }
  }

  async pushCreate(event: IcsEvent): Promise<void> {
    await this.put(event.uid, buildIcs(event))
  }

  async pushUpdate(event: IcsEvent): Promise<void> {
    await this.put(event.uid, buildIcs(event))
  }

  async pushDelete(uid: string): Promise<void> {
    const eventPath = this.eventPath(uid)
    const url = this.baseUrl + eventPath
    const res = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: {
        Authorization: this.authHeader(),
        'OCS-APIRequest': 'true',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    // K4#6: the object is already gone (never pushed, or removed by someone
    // else). That is the desired end state, not a failure: without this a
    // create-then-delete pair parks in the failed list forever.
    if (res.status === 404 || res.status === 410) return
    if (!res.ok) {
      const snippet = await res
        .text()
        .then((t) => t.slice(0, 200))
        .catch(() => '')
      throw new Error(`Nextcloud DELETE event ${eventPath} → ${res.status}: ${snippet}`)
    }
  }
}

export function createCalDavPusher(opts: CalDavPusherOptions = {}): CalDavPusher {
  const nextcloudUrl = opts.nextcloudUrl ?? process.env.NEXTCLOUD_URL ?? 'http://nextcloud'
  const adminUser = opts.adminUser ?? process.env.NEXTCLOUD_ADMIN_USER ?? 'admin'
  const adminPassword = opts.adminPassword ?? process.env.NEXTCLOUD_ADMIN_PASSWORD ?? ''
  const sharedUser = opts.sharedUser ?? process.env.CALDAV_SHARED_USER ?? adminUser
  const sharedCalendar = opts.sharedCalendar ?? process.env.CALDAV_SHARED_CALENDAR ?? 'stura'
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  return new DirectCalDavPusher({
    baseUrl: nextcloudUrl,
    adminUser,
    adminPassword,
    userId: sharedUser,
    calendarName: sharedCalendar,
    fetchImpl,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
}
