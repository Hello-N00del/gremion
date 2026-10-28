// services/votes/src/polls/polls-client.ts
// Leaf-local THIN Nextcloud Polls client — the read (listPolls) + write
// (createPoll) the /votes page drives. Duplicated from
// gremion-ui/src/lib/server/polls/polls-client.ts (the leaf is a separate process).
// Polls v9 (NC 33) serves its REST API on the OCS mount; OCS responses are
// wrapped in { ocs: { meta, data } } and require Accept: application/json. The
// leaf reads NEXTCLOUD_URL + admin creds from its own env.

import { assertTenantId, scopePoll, tagTitle } from './tenant-scope.js'

const POLLS_BASE = '/ocs/v2.php/apps/polls/api/v1.0'

export interface NcPollOption {
  id: number
  text: string
  votes: { count: number; yes: number; no: number; maybe: number; currentUser: string | null }
}

export interface NcPoll {
  id: number
  /** The NC account the poll was created as (provenance: see scopePoll). */
  owner?: { userId?: string; id?: string; displayName?: string }
  type: string
  configuration: {
    title: string
    description: string
    allowComment: boolean
    anonymous: boolean
    expire: number
  }
  status: { expired: boolean; countOptions: number }
  currentUserStatus: { userRole: string; isLocked: boolean; countVotes: number }
  options?: NcPollOption[]
}

export interface CreatePollDto {
  title: string
  type: 'textPoll' | 'datePoll'
  options: string[]
  anonymous: boolean
  description?: string
  expire?: number
}

function ncBase(): string {
  return (process.env.NEXTCLOUD_URL ?? 'http://nextcloud').replace(/\/$/, '')
}

function adminUser(): string {
  return process.env.NEXTCLOUD_ADMIN_USER ?? 'admin'
}

function authHeader(): string {
  const user = adminUser()
  const pass = process.env.NEXTCLOUD_ADMIN_PASSWORD ?? ''
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

async function ncFetch<T>(
  path: string,
  opts: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`${ncBase()}${POLLS_BASE}${path}`, {
    ...opts,
    headers: {
      'OCS-APIRequest': 'true',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(),
      ...opts.headers,
    },
  })
  if (!res.ok) throw new Error(`Nextcloud Polls ${path} → ${res.status}`)
  // OCS wraps every payload in { ocs: { meta, data } }; unwrap to the data.
  const body = (await res.json()) as { ocs?: { data?: T } }
  return (body.ocs?.data ?? body) as T
}

export const NextcloudPollsClient = {
  /** Only the polls bound to `tenantId` (marker stripped from the titles). */
  async listPolls(tenantId: string): Promise<NcPoll[]> {
    assertTenantId(tenantId)
    const { polls } = await ncFetch<{ polls: NcPoll[] }>('/polls')
    return polls.flatMap((p) => scopePoll(p, tenantId, process.env.VOTES_LEGACY_POLL_TENANT_ID, adminUser()) ?? [])
  },

  /** Create a poll bound to `tenantId` (the marker is written here, server-side). */
  async createPoll(tenantId: string, dto: CreatePollDto): Promise<NcPoll> {
    const created = await createBound(tagTitle(tenantId, dto.title), dto)
    return scopePoll(created, tenantId, undefined, adminUser()) ?? created
  },
}

async function createBound(storedTitle: string, dto: CreatePollDto): Promise<NcPoll> {
  {
    // Step 1: create the poll (NC Polls v9 consumes only { type, title }).
    const { poll } = await ncFetch<{ poll: NcPoll }>('/poll', {
      method: 'POST',
      body: JSON.stringify({ title: storedTitle, type: dto.type }),
    })

    // Step 2: add every option in ONE atomic bulk write (addBulk takes a
    // newline-separated blob). The options arrive already de-duplicated.
    try {
      await ncFetch(`/poll/${poll.id}/options`, {
        method: 'POST',
        body: JSON.stringify({ text: dto.options.join('\n') }),
      })
    } catch (e) {
      // Compensating delete so a failed option write never leaves an unvotable,
      // option-less orphan poll. Best-effort — rethrow the original error.
      try {
        await ncFetch(`/poll/${poll.id}`, { method: 'DELETE' })
      } catch {
        // ignore rollback failure
      }
      throw e
    }

    // Step 3 (H16): apply the configuration. POST /poll consumes ONLY
    // { type, title }; anonymous / description / expire are applied by a follow-up
    // PUT /poll/{id} { pollConfiguration }. Without this an "Anonym" poll was
    // silently created NON-anonymous. Same rollback contract as the options write:
    // a poll whose privacy setting did not take must never be left behind.
    const pollConfiguration: Partial<NcPoll['configuration']> = {}
    if (dto.anonymous) pollConfiguration.anonymous = true
    if (dto.description !== undefined) pollConfiguration.description = dto.description
    if (dto.expire !== undefined) pollConfiguration.expire = dto.expire
    if (Object.keys(pollConfiguration).length === 0) return poll

    try {
      const updated = await ncFetch<{ poll?: NcPoll }>(`/poll/${poll.id}`, {
        method: 'PUT',
        body: JSON.stringify({ pollConfiguration }),
      })
      // Reflect what was applied even if the upstream reply omits the poll.
      return updated.poll ?? { ...poll, configuration: { ...poll.configuration, ...pollConfiguration } }
    } catch (e) {
      try {
        await ncFetch(`/poll/${poll.id}`, { method: 'DELETE' })
      } catch {
        // ignore rollback failure — the original error is what the caller must see
      }
      throw e
    }
  }
}
