// services/votes/src/polls/polls-client.ts
// Leaf-local THIN Nextcloud Polls client — the read (listPolls) + write
// (createPoll) the /votes page drives. Duplicated from
// gremion-ui/src/lib/server/polls/polls-client.ts (the leaf is a separate process).
// Polls v9 (NC 33) serves its REST API on the OCS mount; OCS responses are
// wrapped in { ocs: { meta, data } } and require Accept: application/json. The
// leaf reads NEXTCLOUD_URL + admin creds from its own env.

const POLLS_BASE = '/ocs/v2.php/apps/polls/api/v1.0'

export interface NcPollOption {
  id: number
  text: string
  votes: { count: number; yes: number; no: number; maybe: number; currentUser: string | null }
}

export interface NcPoll {
  id: number
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

function authHeader(): string {
  const user = process.env.NEXTCLOUD_ADMIN_USER ?? 'admin'
  const pass = process.env.NEXTCLOUD_ADMIN_PASSWORD ?? ''
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

async function ncFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
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
  listPolls: (): Promise<NcPoll[]> =>
    ncFetch<{ polls: NcPoll[] }>('/polls').then((r) => r.polls),

  async createPoll(dto: CreatePollDto): Promise<NcPoll> {
    // Step 1: create the poll (NC Polls v9 consumes only { type, title }).
    const { poll } = await ncFetch<{ poll: NcPoll }>('/poll', {
      method: 'POST',
      body: JSON.stringify({ title: dto.title, type: dto.type }),
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

    return poll
  },
}
