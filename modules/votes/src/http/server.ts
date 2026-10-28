// services/votes/src/http/server.ts
// The node:http server for the votes leaf (NO web framework). Request lifecycle:
//   /healthz          → guard-EXEMPT, returns {"status":"ok"}
//   /api/v1/votes     → checkGuard() then compose the /votes list: settle a
//                       Helios getElection per uuid, list Nextcloud polls, map +
//                       merge via the aggregator. Unreachable ballots come back as
//                       degradedUuids (never dropped) — the kernel renders their
//                       degraded card from its OWN committee_elections row.
//   /api/v1/polls     → checkGuard() then create a Nextcloud quick-poll.
//   everything else   → 404
// The leaf owns NO database — it is a stateless thin proxy over Helios + Nextcloud
// Polls. The Helios ADMIN lifecycle stays on the kernel by design.
//
// TENANT ISOLATION (K5#29 / S4#18, CLOSED): Nextcloud Polls is one shared instance
// reached with ONE admin credential, so each poll is bound to the calling tenant
// (x-tenant-id) by a server-written marker on create (polls/tenant-scope.ts) and
// the list is filtered by it; tenant A can neither see nor receive tenant B's polls.
// This leaf exposes no by-id poll route; the by-id routes (read/options/vote) live in
// the app's polls client, which enforces the same marker. Unmarked legacy polls
// belong to no tenant unless VOTES_LEGACY_POLL_TENANT_ID claims them for one.
// Request validation: malformed bodies answer 400, not 502. A non-UUID election id
// degrades its own card (never Helios-fetched, never interpolated into a path).
import http from 'node:http'
import { checkGuard, isHealthzPath } from './auth.js'
import {
  HeliosClient,
  isHeliosUnavailable,
  isHeliosUuid,
  type HeliosElection,
} from '../helios/helios-client.js'
import { NextcloudPollsClient, type CreatePollDto, type NcPoll } from '../polls/polls-client.js'
import { mapHeliosToVoteItem, mapPollToVoteItem, mergeVoteItems } from '../aggregator/aggregator.js'
import type { VoteItem } from '../aggregator/types.js'

/** The Helios read surface the leaf drives (injectable for tests). */
export interface HeliosPort {
  getElection(uuid: string): Promise<HeliosElection>
}
/** The Nextcloud Polls surface the leaf drives (injectable for tests). */
export interface PollsPort {
  listPolls(tenantId: string): Promise<NcPoll[]>
  createPoll(tenantId: string, dto: CreatePollDto): Promise<NcPoll>
}

export interface ServerOptions {
  /** Shared secret expected in x-internal-auth (INTERNAL_VOTES_SECRET). */
  secret: string | undefined
  /** Helios read client. Defaults to the env-configured HeliosClient. */
  helios?: HeliosPort
  /** Nextcloud Polls client. Defaults to the env-configured NextcloudPollsClient. */
  polls?: PollsPort
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** A client error: mapped to HTTP 400, never to the 502 "upstream" bucket. */
class BadRequest extends Error {}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const buf = await readBody(req)
  try {
    return JSON.parse(buf.toString('utf8') || '{}') as T
  } catch {
    throw new BadRequest('invalid JSON body')
  }
}

/** Internal marker: the tracked id is not a Helios UUID, so it was never looked up. */
class NotAHeliosUuid extends Error {}

/** Upper bound on elections one /votes call may settle (one Helios fetch each). */
const MAX_ELECTION_UUIDS = 100

/** Shape check only: an array of at most MAX_ELECTION_UUIDS strings (else 400).
 *  A string that is not a Helios UUID is NOT a request error (R29-VOTES-DEGRADE-K):
 *  a tracked row may carry a non-UUID helios_uuid (seed fixtures), and one such row
 *  must degrade its own card, not 400 the whole /votes call. K5#41 / S4#25: such a
 *  string is never interpolated into a Helios path — composeVotes degrades it
 *  without any fetch, and HeliosClient.getElection refuses it again. */
function parseElectionUuids(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new BadRequest('electionUuids must be an array')
  if (raw.length > MAX_ELECTION_UUIDS) {
    throw new BadRequest(`electionUuids may hold at most ${MAX_ELECTION_UUIDS} entries`)
  }
  for (const u of raw) {
    if (typeof u !== 'string') throw new BadRequest('electionUuids must be an array of strings')
  }
  return raw as string[]
}

/** H16: validate the quick-poll body; description/expire are optional. */
function parseCreatePoll(dto: Partial<CreatePollDto> | null): CreatePollDto {
  if (!dto || typeof dto !== 'object') throw new BadRequest('missing title or options')
  if (typeof dto.title !== 'string' || !dto.title || !Array.isArray(dto.options)) {
    throw new BadRequest('missing title or options')
  }
  const type = dto.type ?? 'textPoll'
  if (type !== 'textPoll' && type !== 'datePoll') {
    throw new BadRequest('type must be textPoll or datePoll')
  }
  if (dto.description !== undefined && typeof dto.description !== 'string') {
    throw new BadRequest('description must be a string')
  }
  if (dto.expire !== undefined && (!Number.isInteger(dto.expire) || (dto.expire as number) < 0)) {
    throw new BadRequest('expire must be a non-negative unix timestamp')
  }
  const out: CreatePollDto = {
    title: dto.title,
    type,
    options: dto.options,
    anonymous: Boolean(dto.anonymous),
  }
  if (dto.description !== undefined) out.description = dto.description
  if (dto.expire !== undefined) out.expire = dto.expire
  return out
}

/** Compose the /votes list: settle each Helios election (one 5xx must not blank
 *  the page), list Nextcloud polls (non-fatal), map + merge via the aggregator. */
async function composeVotes(
  helios: HeliosPort,
  polls: PollsPort,
  tenantId: string,
  electionUuids: string[],
): Promise<{ votes: VoteItem[]; degradedUuids: string[]; pollError: string | null }> {
  // A non-UUID id (K5#41 / S4#25) never reaches Helios: no fetch, no path
  // interpolation. It is degraded in place, so input order is preserved.
  const settled = await Promise.allSettled(
    electionUuids.map((u) => (isHeliosUuid(u) ? helios.getElection(u) : Promise.reject(new NotAHeliosUuid()))),
  )
  const reachable: VoteItem[] = []
  const degradedUuids: string[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') reachable.push(mapHeliosToVoteItem(r.value))
    else {
      // K5#17: only a tracked-but-unreachable Helios (or an id that was never
      // a Helios uuid) degrades quietly; anything else is a real bug and must
      // not vanish into an unlogged "degraded" row.
      if (!(r.reason instanceof NotAHeliosUuid) && !isHeliosUnavailable(r.reason)) {
        console.error(`[votes] helios getElection ${electionUuids[i]} failed`, r.reason)
      }
      degradedUuids.push(electionUuids[i])
    }
  })

  let pollItems: VoteItem[] = []
  let pollError: string | null = null
  try {
    const ncPolls = await polls.listPolls(tenantId)
    pollItems = ncPolls.map((p) => mapPollToVoteItem(p))
  } catch (e) {
    pollError = e instanceof Error ? e.message : 'Umfragen konnten nicht geladen werden'
  }

  return { votes: mergeVoteItems(reachable, pollItems), degradedUuids, pollError }
}

export function createServer(opts: ServerOptions): http.Server {
  const helios: HeliosPort = opts.helios ?? HeliosClient
  const polls: PollsPort = opts.polls ?? NextcloudPollsClient

  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[votes] unhandled request error', err)
      if (!res.headersSent) sendJson(res, 500, { success: false, error: 'internal error' })
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    // Health probe: exempt from the guard, no tenant context.
    if (isHealthzPath(path)) {
      if (method !== 'GET') return sendJson(res, 405, { success: false, error: 'method not allowed' })
      return sendJson(res, 200, { status: 'ok' })
    }

    // Internal guard: shared secret (constant-time) + tenant headers.
    const guard = checkGuard({
      path,
      headers: req.headers as Record<string, string | undefined>,
      secret: opts.secret,
    })
    if (!guard.ok) return sendJson(res, guard.status, { success: false, error: guard.message })

    if (method !== 'POST') return sendJson(res, 405, { success: false, error: 'method not allowed' })

    try {
      switch (path) {
        case '/api/v1/votes': {
          const body = await readJson<{ electionUuids?: unknown }>(req)
          const result = await composeVotes(helios, polls, guard.tenant.id, parseElectionUuids(body.electionUuids))
          return sendJson(res, 200, result)
        }
        case '/api/v1/polls': {
          const dto = parseCreatePoll(await readJson<Partial<CreatePollDto>>(req))
          await polls.createPoll(guard.tenant.id, dto)
          return sendJson(res, 200, { success: true })
        }
        default:
          return sendJson(res, 404, { success: false, error: 'not found' })
      }
    } catch (err) {
      if (err instanceof BadRequest) return sendJson(res, 400, { success: false, error: err.message })
      console.error('[votes] upstream error', err)
      return sendJson(res, 502, { success: false, error: err instanceof Error ? err.message : 'upstream error' })
    }
  }
}
