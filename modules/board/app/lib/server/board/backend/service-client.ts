// gremion-ui/src/lib/server/board/backend/service-client.ts
// T1 — HTTP ACL client: implements BoardBackendPort over the board leaf
// service (BOARD_SERVICE_URL). Mirrors the calendar/newsletter service clients.
//
// Retry policy: ONE retry on idempotent GET/HEAD requests only (never on
// POST/PATCH/DELETE). Retry only on network errors or 503. Timeout 5000ms/attempt.

import { getTenant } from '$lib/server/tenant/context'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import type {
  BoardBackendPort,
  Board,
  Card,
  CreateCardInput,
  MoveCardTarget,
  PromoteActionItemInput,
  Deck,
  CreateBoardInput,
  CreatedBoard,
  CreateStackInput,
  Stack,
} from './port'

// ── Error class ───────────────────────────────────────────────────────────────

/** Thrown when the board leaf returns a non-2xx response. `status` mirrors the
 *  HTTP status so callers can map it to SvelteKit errors / Responses. */
export class BoardServiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`[board-service-client] Leaf returned ${status}: ${message}`)
    this.name = 'BoardServiceError'
    this.status = status
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ServiceBoardClientOptions {
  /** Optional correlation-id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
  /** Optional TracerPort for span emission. Defaults to noopTracer. */
  tracer?: TracerPort
  /** Optional injectable fetch implementation (for testing). Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch
}

const REQUEST_TIMEOUT_MS = 5000
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function resolveServiceUrl(): string {
  const url = process.env.BOARD_SERVICE_URL
  if (!url) {
    throw new Error(
      '[board-service-client] BOARD_SERVICE_URL is not set. ' +
        "Configure it to point to the board leaf service (e.g. 'http://board-service:8080').",
    )
  }
  return url.replace(/\/$/, '')
}

function resolveSecret(): string {
  const secret = process.env.INTERNAL_BOARD_SECRET
  if (!secret) {
    throw new Error(
      '[board-service-client] INTERNAL_BOARD_SECRET is not set. ' +
        'The board leaf requires this shared secret in x-internal-auth.',
    )
  }
  return secret
}

// ── Deserialization ──────────────────────────────────────────────────────────
// The leaf returns ISO strings for TIMESTAMPTZ columns; coerce them back to Date
// so callers get the same Board/Card shape as the inprocess client. due_date is
// a bare YYYY-MM-DD string (or null) on both sides — passed straight through.

function deserializeBoard(raw: Record<string, unknown>): Board {
  return {
    id: raw.id as string,
    org_unit_id: raw.org_unit_id as string,
    name: raw.name as string,
    archived: raw.archived as boolean,
    created_at: new Date(raw.created_at as string),
  }
}

/** Read the `{ data: [...] }` list envelope the leaf's list routes return.
 *  Throws on an unexpected shape instead of coercing a malformed 200 into an
 *  empty list. For listPromotedActionItemIds (a filter-OUT op) an empty coercion
 *  silently fails OPEN — already-promoted items would reappear as promotable and
 *  could be double-promoted — so a malformed leaf response must fail loud (#387).
 *  Kept identical for listBoardsForOrgUnits so the two list callers stay
 *  consistent. */
function readDataArray(res: unknown, op: string): unknown[] {
  const data = (res as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new Error(
      `[board-service-client] malformed ${op} response: expected { data: [...] } from the board leaf`,
    )
  }
  return data
}

function deserializeStack(raw: Record<string, unknown>): Stack {
  return {
    id: raw.id as string,
    board_id: raw.board_id as string,
    name: raw.name as string,
    sort_order: raw.sort_order as number,
  }
}

function deserializeCard(raw: Record<string, unknown>): Card {
  return {
    id: raw.id as string,
    stack_id: raw.stack_id as string,
    title: raw.title as string,
    description: (raw.description as string | null) ?? null,
    assignee_keycloak_id: (raw.assignee_keycloak_id as string | null) ?? null,
    due_date: (raw.due_date as string | null) ?? null,
    label: (raw.label as string | null) ?? null,
    sort_order: raw.sort_order as number,
    protocol_action_item_id: (raw.protocol_action_item_id as string | null) ?? null,
    created_by: (raw.created_by as string | null) ?? null,
    created_at: new Date(raw.created_at as string),
  }
}

// ── ServiceBoardClient ────────────────────────────────────────────────────────

export class ServiceBoardClient implements BoardBackendPort {
  readonly kind = 'service' as const

  private readonly correlationId: string | undefined
  private readonly tracer: TracerPort
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: ServiceBoardClientOptions = {}) {
    this.correlationId = opts.correlationId
    this.tracer = opts.tracer ?? noopTracer
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private buildHeaders(): Record<string, string> {
    const secret = resolveSecret()
    const tenant = getTenant()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-internal-auth': secret,
      'x-tenant-id': tenant.id,
      'x-tenant-slug': tenant.slug,
    }
    if (this.correlationId) headers['x-correlation-id'] = this.correlationId
    return headers
  }

  private async doLeafFetch(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const url = `${resolveServiceUrl()}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`
        try {
          const errBody = (await res.json()) as { error?: string }
          if (errBody.error) errMsg = errBody.error
        } catch {
          /* ignore JSON parse failure */
        }
        throw new BoardServiceError(res.status, errMsg)
      }
      return res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /** Execute a leaf HTTP call wrapped in a 'board.acl.<op>' span. Retries once on
   *  idempotent GET/HEAD for network errors or 503. */
  private async leafFetch(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers = this.buildHeaders()
    const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase())
    const span = this.tracer.startSpan(`board.acl.${method} ${path}`, {
      correlationId: this.correlationId ?? 'none',
    })
    try {
      let result: unknown
      try {
        result = await this.doLeafFetch(method, path, body, headers)
      } catch (err) {
        if (isIdempotent && (!(err instanceof BoardServiceError) || err.status === 503)) {
          result = await this.doLeafFetch(method, path, body, headers)
        } else {
          throw err
        }
      }
      span.end()
      return result
    } catch (err) {
      span.end(err)
      throw err
    }
  }

  async listBoardsForOrgUnits(orgUnitIds: readonly string[]): Promise<readonly Board[]> {
    // Mirror boardDb.listBoardsForOrgUnits: empty scope short-circuits to [].
    if (orgUnitIds.length === 0) return []
    const params = new URLSearchParams()
    for (const id of orgUnitIds) params.append('orgUnitId', id)
    const res = await this.leafFetch('GET', `/api/v1/boards?${params.toString()}`)
    return readDataArray(res, 'listBoardsForOrgUnits').map((b) =>
      deserializeBoard(b as Record<string, unknown>),
    )
  }

  async getBoard(id: string): Promise<Board | null> {
    try {
      const res = (await this.leafFetch('GET', `/api/v1/boards/${encodeURIComponent(id)}`)) as Record<
        string,
        unknown
      >
      return deserializeBoard(res)
    } catch (err) {
      if (err instanceof BoardServiceError && err.status === 404) return null
      throw err
    }
  }

  async deckFor(boardId: string): Promise<Deck> {
    // deckFor THROWS on not-found (byte-identical to boardDb.deckFor) — no 404→null.
    const res = (await this.leafFetch('GET', `/api/v1/boards/${encodeURIComponent(boardId)}/deck`)) as {
      board: Record<string, unknown>
      stacks: Record<string, unknown>[]
      cards: Record<string, unknown>[]
    }
    return {
      board: deserializeBoard(res.board),
      stacks: (res.stacks ?? []) as unknown as Deck['stacks'],
      cards: (res.cards ?? []).map(deserializeCard),
    }
  }

  async createCard(data: CreateCardInput): Promise<Card> {
    const res = (await this.leafFetch('POST', '/api/v1/cards', data)) as Record<string, unknown>
    return deserializeCard(res)
  }

  async moveCard(id: string, to: MoveCardTarget): Promise<Card | null> {
    try {
      const res = (await this.leafFetch(
        'PATCH',
        `/api/v1/cards/${encodeURIComponent(id)}/move`,
        to,
      )) as Record<string, unknown>
      return deserializeCard(res)
    } catch (err) {
      if (err instanceof BoardServiceError && err.status === 404) return null
      throw err
    }
  }

  async promoteActionItem(
    boardId: string,
    item: PromoteActionItemInput,
    createdBy: string,
  ): Promise<Card> {
    const res = (await this.leafFetch(
      'POST',
      `/api/v1/boards/${encodeURIComponent(boardId)}/promote`,
      { item, createdBy },
    )) as Record<string, unknown>
    return deserializeCard(res)
  }

  async listPromotedActionItemIds(candidateIds: readonly string[]): Promise<readonly string[]> {
    // Mirror boardDb.listPromotedActionItemIds: empty input short-circuits to [].
    if (candidateIds.length === 0) return []
    // POST a JSON body (not repeated GET query params): the candidate id list can
    // exceed node:http's ~16KB request-header cap (~320 ids per committee) — #387.
    const res = await this.leafFetch('POST', '/api/v1/cards/promoted', {
      candidateIds: [...candidateIds],
    })
    return readDataArray(res, 'listPromotedActionItemIds') as string[]
  }

  /** R29-BOARD-STORE-S B5 → POST /api/v1/boards (201 { board, stacks }). A POST:
   *  never retried (a retry after a lost response would create a second board). */
  async createBoard(input: CreateBoardInput): Promise<CreatedBoard> {
    const res = (await this.leafFetch('POST', '/api/v1/boards', input)) as {
      board?: unknown
      stacks?: unknown
    } | null
    if (!res || typeof res.board !== 'object' || res.board === null || !Array.isArray(res.stacks)) {
      throw new Error('[board-service-client] malformed createBoard response: expected { board, stacks } from the board leaf')
    }
    return {
      board: deserializeBoard(res.board as Record<string, unknown>),
      stacks: res.stacks.map((s) => deserializeStack(s as Record<string, unknown>)),
    }
  }

  /** R29-BOARD-STORE-S B5 → POST /api/v1/boards/:id/stacks (201 Stack). Not
   *  retried; a board outside the tenant surfaces as BoardServiceError 404. */
  async createStack(boardId: string, input: CreateStackInput): Promise<Stack> {
    const res = (await this.leafFetch('POST', `/api/v1/boards/${encodeURIComponent(boardId)}/stacks`, {
      name: input.name,
      order: input.order,
    })) as Record<string, unknown>
    return deserializeStack(res)
  }
}
