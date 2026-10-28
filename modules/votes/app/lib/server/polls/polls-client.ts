import { env } from '$env/dynamic/private'
import { serviceEnv } from '$lib/server/env/service-env'
import { getTenant } from '$lib/server/tenant/context'
import { assertTenantId, PollAccessError, scopePoll, tagTitle } from './tenant-scope'

export { PollAccessError } from './tenant-scope'

// Polls v9 (NC 33) serves its REST API on the OCS mount. The legacy
// index.php/apps/polls/api/v1.0 mount now only registers the OPTIONS preflight
// route, so a GET against it returns 405 — the symptom that broke /votes. OCS
// responses are wrapped in { ocs: { meta, data } } (see ncFetch) and require an
// `Accept: application/json` header, or OCS defaults to XML.
const POLLS_BASE = '/ocs/v2.php/apps/polls/api/v1.0'

export interface NcPollOption {
  id: number
  text: string
  votes: {
    count: number
    yes: number
    no: number
    maybe: number
    currentUser: string | null
  }
}

export interface NcPoll {
  id: number
  type: string
  configuration: {
    title: string
    description: string
    allowComment: boolean
    anonymous: boolean    // API field (not isAnonymous)
    expire: number        // unix timestamp or 0
  }
  status: {
    expired: boolean      // API field (not isExpired)
    countOptions: number
  }
  currentUserStatus: {
    userRole: string
    isLocked: boolean     // API field (not in status)
    countVotes: number    // >0 means user has voted
  }
  options?: NcPollOption[]  // only populated after fetching /poll/{id}/options
}

export interface CreatePollDto {
  title: string
  type: 'textPoll' | 'datePoll'
  options: string[]
  anonymous: boolean
  description?: string
  expire?: number
}

/** The user-requested poll settings that NC Polls only accepts through the
 * `PUT /poll/{id}` pollConfiguration (F1-FIX-08, H16). `anonymous` is always
 * explicit; description/expire only when the caller supplied them. */
function requestedSettings(
  dto: CreatePollDto,
): Pick<NcPoll['configuration'], 'anonymous'> & Partial<Pick<NcPoll['configuration'], 'description' | 'expire'>> {
  return {
    anonymous: dto.anonymous,
    ...(dto.description !== undefined ? { description: dto.description } : {}),
    ...(dto.expire !== undefined ? { expire: dto.expire } : {}),
  }
}

function ncBase(): string {
  return (serviceEnv('NEXTCLOUD_URL') ?? 'http://nextcloud').replace(/\/$/, '')
}

function adminAuthHeader(): string {
  const user = serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'
  const pass = serviceEnv('NEXTCLOUD_ADMIN_PASSWORD') ?? ''
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/** Build a Polls client. Pass `oidcBearer` (the logged-in user's Keycloak
 * access token, `locals.accessToken`) so NC's user_oidc bearer provisioning
 * attributes votes and `currentUserStatus` to the acting user (#411) — without
 * it every call runs as the shared NC admin, so the first vote locks the poll
 * for everyone. Omit for admin/system operations (poll creation, aggregators). */
export function createPollsClient(opts: { oidcBearer?: string; tenantId?: string } = {}) {
  const { oidcBearer } = opts

  // TENANT ISOLATION (K5#29 / S4#18): one shared Nextcloud, so every poll is bound
  // to its tenant (tenant-scope.ts) and every list / by-id route checks it. The
  // tenant is read per call from the request context (getTenant() THROWS without
  // one: fail closed), or pinned via opts.tenantId. Another tenant's poll answers
  // exactly like a missing one (pollsStatus 404).
  const tenant = (): string => assertTenantId(opts.tenantId ?? getTenant().id)
  // A platform-wide operator setting, not a service endpoint: read lazily from the env (env-guard).
  const legacy = (): string | undefined => env.VOTES_LEGACY_POLL_TENANT_ID || undefined
  const notFound = () => new PollAccessError(404, 'poll not found')

  async function ncFetch<T>(
    path: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await fetch(`${ncBase()}${POLLS_BASE}${path}`, {
      ...init,
      headers: {
        'OCS-APIRequest': 'true',
        'Content-Type': 'application/json',
        // OCS defaults to an XML envelope unless the client asks for JSON.
        Accept: 'application/json',
        // Admin creds stay lazy (per-fetch) so the module-load singleton never
        // reads $env/dynamic/private at import time.
        Authorization: oidcBearer ? `Bearer ${oidcBearer}` : adminAuthHeader(),
        ...init.headers,
      },
    })
    if (!res.ok) throw new Error(`Nextcloud Polls ${path} → ${res.status}`)
    // OCS wraps every payload in { ocs: { meta, data } }; unwrap to the data the
    // callers expect (e.g. { polls }, { poll }, { options }). Fall back to the raw
    // body if an upstream ever returns an un-enveloped response.
    const body = (await res.json()) as { ocs?: { data?: T } }
    return (body.ocs?.data ?? body) as T
  }

  return {
    async listPolls(): Promise<NcPoll[]> {
      const t = tenant()
      const { polls } = await ncFetch<{ polls: NcPoll[] }>('/polls')
      return polls.flatMap((p) => scopePoll(p, t, legacy()) ?? [])
    },

    /** The poll, only if it belongs to the calling tenant (else pollsStatus 404). */
    async getPoll(id: number): Promise<NcPoll> {
      const t = tenant()
      let raw: NcPoll
      try {
        raw = (await ncFetch<{ poll: NcPoll }>(`/poll/${id}`)).poll
      } catch (e) {
        // NC answers 403/404 for polls this user cannot see: same answer as foreign.
        if (e instanceof Error && /→\s*(403|404)\b/.test(e.message)) throw notFound()
        throw e
      }
      return scopePoll(raw, t, legacy()) ?? Promise.reject(notFound())
    },

    async getPollWithOptions(id: number): Promise<NcPoll> {
      // Ownership first: a foreign poll's options are never even requested.
      const poll = await this.getPoll(id)
      const optionsResult = await ncFetch<{ options: NcPollOption[] }>(`/poll/${id}/options`)
      return { ...poll, options: optionsResult.options }
    },

    async createPoll(dto: CreatePollDto): Promise<NcPoll> {
      // Step 1: create the poll. NC Polls v9.1.4 `POST /poll` (PollApiController::add)
      // consumes ONLY { type, title } — anonymous/description/expire are not read
      // here; step 3 applies them with the `PUT /poll/{id}` pollConfiguration.
      const { poll } = await ncFetch<{ poll: NcPoll }>('/poll', {
        method: 'POST',
        body: JSON.stringify({ title: tagTitle(tenant(), dto.title), type: dto.type }),
      })

      // Step 2: add every option in ONE atomic bulk write. v9.1.4
      // OptionApiController::addBulk (`POST /poll/{id}/options`, plural) takes a
      // newline-separated `text` blob. The previous code POSTed a legacy
      // `pollOptionText` field to the singular `/option` route, which actually
      // expects an `{ option: { text } }` array param — so every option write was
      // rejected and the poll was left with zero options, unvotable (#156). The
      // options are already de-duplicated by the create action before they arrive.
      try {
        await ncFetch(`/poll/${poll.id}/options`, {
          method: 'POST',
          body: JSON.stringify({ text: dto.options.join('\n') }),
        })
      } catch (e) {
        // Compensating delete so a failed option write never leaves an unvotable,
        // option-less orphan poll in the list (#156, data-integrity half).
        // Best-effort — the original error is what the caller must surface.
        try {
          await ncFetch(`/poll/${poll.id}`, { method: 'DELETE' })
        } catch {
          // ignore rollback failure; rethrow the original create error below
        }
        throw e
      }

      // Step 3: configure the poll NC-side in ONE pollConfiguration PUT.
      // - access 'open' (#411): polls default to access=private (creator-only),
      //   which 400s every per-user bearer read/vote — the app gates /polls
      //   itself and all members are NC users, so 'open' is the NC mapping.
      // - anonymous / description / expire (F1-FIX-08, H16): `POST /poll` reads
      //   only { type, title }, so these MUST travel here. anonymous is always
      //   sent explicitly so the privacy setting never rides on NC's default.
      // Same rollback contract as the options write: never leave behind a poll
      // that is unvotable or that broke the requested privacy setting.
      const settings = requestedSettings(dto)
      let configured: NcPoll | undefined
      try {
        const res = await ncFetch<{ poll?: NcPoll }>(`/poll/${poll.id}`, {
          method: 'PUT',
          body: JSON.stringify({ pollConfiguration: { access: 'open', ...settings } }),
        })
        configured = res?.poll
        // Fail closed on privacy: when Nextcloud echoes the stored poll, its
        // anonymity MUST match the request. A named-voter poll that the user
        // created as "Anonym" is worse than no poll.
        if (configured?.configuration && Boolean(configured.configuration.anonymous) !== dto.anonymous) {
          throw new Error(
            `Nextcloud Polls /poll/${poll.id} did not apply anonymous=${dto.anonymous}`,
          )
        }
      } catch (e) {
        try {
          await ncFetch(`/poll/${poll.id}`, { method: 'DELETE' })
        } catch {
          // ignore rollback failure; rethrow the original error below
        }
        throw e
      }

      // Return what Nextcloud stored; without an echo, overlay the applied
      // configuration so callers never see the stale POST defaults.
      const stored = configured ?? { ...poll, configuration: { ...poll.configuration, ...settings } }
      return scopePoll(stored, tenant(), legacy()) ?? stored
    },

    /** Cast the acting user's vote. Integrity, in order: acting-user bearer (never
     *  the shared admin), poll belongs to the calling tenant, the option belongs to
     *  THAT poll (no smuggling another poll's option through this id), voting window
     *  open, and one vote per member. */
    async vote(pollId: number, optionId: number): Promise<unknown> {
      if (!oidcBearer) throw new PollAccessError(401, 'acting user required')
      const poll = await this.getPollWithOptions(pollId)
      if (!(poll.options ?? []).some((o) => o.id === optionId)) throw notFound()
      const expired =
        poll.status?.expired === true ||
        (poll.configuration.expire > 0 && poll.configuration.expire * 1000 <= Date.now())
      if (expired) throw new PollAccessError(409, 'poll closed')
      if ((poll.currentUserStatus?.countVotes ?? 0) > 0) throw new PollAccessError(409, 'already voted')
      return ncFetch<unknown>(`/option/${optionId}/vote/yes`, { method: 'PUT' })
    },
  }
}

// Admin-credentialed singleton for system callers (protocols publish/submit,
// committees/beschluesse, elections, votes aggregator, poll creation).
export const NextcloudPollsClient = createPollsClient()
