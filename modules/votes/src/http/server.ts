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
import http from 'node:http'
import { checkGuard, isHealthzPath } from './auth.js'
import { HeliosClient, type HeliosElection } from '../helios/helios-client.js'
import { NextcloudPollsClient, type CreatePollDto, type NcPoll } from '../polls/polls-client.js'
import { mapHeliosToVoteItem, mapPollToVoteItem, mergeVoteItems } from '../aggregator/aggregator.js'
import type { VoteItem } from '../aggregator/types.js'

/** The Helios read surface the leaf drives (injectable for tests). */
export interface HeliosPort {
  getElection(uuid: string): Promise<HeliosElection>
}
/** The Nextcloud Polls surface the leaf drives (injectable for tests). */
export interface PollsPort {
  listPolls(): Promise<NcPoll[]>
  createPoll(dto: CreatePollDto): Promise<NcPoll>
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

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const buf = await readBody(req)
  return JSON.parse(buf.toString('utf8') || '{}') as T
}

/** Compose the /votes list: settle each Helios election (one 5xx must not blank
 *  the page), list Nextcloud polls (non-fatal), map + merge via the aggregator. */
async function composeVotes(
  helios: HeliosPort,
  polls: PollsPort,
  electionUuids: string[],
): Promise<{ votes: VoteItem[]; degradedUuids: string[]; pollError: string | null }> {
  const settled = await Promise.allSettled(electionUuids.map((u) => helios.getElection(u)))
  const reachable: VoteItem[] = []
  const degradedUuids: string[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') reachable.push(mapHeliosToVoteItem(r.value))
    else degradedUuids.push(electionUuids[i])
  })

  let pollItems: VoteItem[] = []
  let pollError: string | null = null
  try {
    const ncPolls = await polls.listPolls()
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
          const { electionUuids } = await readJson<{ electionUuids?: string[] }>(req)
          const result = await composeVotes(helios, polls, electionUuids ?? [])
          return sendJson(res, 200, result)
        }
        case '/api/v1/polls': {
          const dto = await readJson<CreatePollDto>(req)
          if (!dto.title || !Array.isArray(dto.options)) {
            return sendJson(res, 400, { success: false, error: 'missing title or options' })
          }
          await polls.createPoll({
            title: dto.title,
            type: dto.type,
            options: dto.options,
            anonymous: Boolean(dto.anonymous),
          })
          return sendJson(res, 200, { success: true })
        }
        default:
          return sendJson(res, 404, { success: false, error: 'not found' })
      }
    } catch (err) {
      console.error('[votes] upstream error', err)
      return sendJson(res, 502, { success: false, error: err instanceof Error ? err.message : 'upstream error' })
    }
  }
}
