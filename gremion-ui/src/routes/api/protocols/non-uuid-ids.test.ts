import { describe, it, expect, vi, beforeEach } from 'vitest'

// R30-F1-PROTO-K (kernel twin of R30-F1-PROTO-S): a non-UUID id in any
// /api/protocols/** path must answer 400 or 404, never 500. Live evidence
// (2026-10-02): the P1 e2e race requested GET /api/protocols/protokolle and the
// server answered 500, because the id reached Postgres, whose uuid column
// rejects it with SQLSTATE 22P02.
//
// The fake `sql` below behaves like that column: ANY query that reaches it
// throws 22P02. So a handler that forwards an unvalidated id to the database
// surfaces here as a thrown non-HTTP error (the 500), and a handler that
// guards the id never touches the database at all (asserted via the call count).

const { sqlCalls } = vi.hoisted(() => ({ sqlCalls: { n: 0 } }))

vi.mock('$lib/server/db', () => {
  const sql = (() => {
    sqlCalls.n++
    throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })
  }) as unknown as { json: (v: unknown) => unknown; begin: (fn: unknown) => unknown }
  sql.json = (v) => v
  sql.begin = () => {
    sqlCalls.n++
    throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })
  }
  return { getDb: () => sql }
})

import * as protocolOne from './[id]/+server'
import * as publish from './[id]/publish/+server'
import * as wopi from './[id]/wopi-token/+server'
import * as resolutions from './[id]/resolutions/+server'
import * as resolutionOne from './[id]/resolutions/[resId]/+server'
import * as submit from './[id]/submit/+server'
import * as actionItems from './[id]/action-items/+server'
import * as actionItemOne from './[id]/action-items/[itemId]/+server'
import * as challenges from './resolutions/[resId]/challenges/+server'
import * as challengeOne from './resolutions/[resId]/challenges/[challengeId]/+server'

const GOOD = '123e4567-e89b-12d3-a456-426614174000'
// The exact value the P1 race produced, plus the shapes a hostile caller sends.
const BAD_IDS = ['protokolle', 'new', 'p1', '../clients', '123', '123e4567-e89b-12d3-a456-42661417400Z']

type Handler = (event: never) => Promise<Response>

function makeEvent(params: Record<string, string>, body: unknown) {
  return {
    locals: { user: { id: 'u1', roles: ['council-admin', 'member', 'it-admin'] } },
    request: { json: async () => body },
    params,
  } as never
}

async function statusOf(fn: () => Promise<Response>): Promise<number> {
  try {
    return (await fn()).status
  } catch (err) {
    const status = (err as { status?: number })?.status
    // A thrown SvelteKit HttpError carries its status. Anything else (the fake
    // 22P02) is what SvelteKit turns into a 500.
    return typeof status === 'number' ? status : 500
  }
}

interface Case {
  label: string
  handler: Handler
  // which route param carries the bad id; the others are valid UUIDs
  param: 'id' | 'resId' | 'itemId' | 'challengeId'
  body?: unknown
}

const CASES: Case[] = [
  { label: 'GET /api/protocols/[id]', handler: protocolOne.GET as Handler, param: 'id' },
  { label: 'PATCH /api/protocols/[id]', handler: protocolOne.PATCH as Handler, param: 'id', body: { title: 'x' } },
  { label: 'POST /api/protocols/[id]/publish', handler: publish.POST as Handler, param: 'id' },
  { label: 'GET /api/protocols/[id]/wopi-token', handler: wopi.GET as Handler, param: 'id' },
  { label: 'POST /api/protocols/[id]/resolutions', handler: resolutions.POST as Handler, param: 'id', body: { text: 'x' } },
  { label: 'PATCH /api/protocols/[id]/resolutions/[resId] (bad resId)', handler: resolutionOne.PATCH as Handler, param: 'resId', body: { text: 'x' } },
  { label: 'DELETE /api/protocols/[id]/resolutions/[resId] (bad resId)', handler: resolutionOne.DELETE as Handler, param: 'resId' },
  { label: 'POST /api/protocols/[id]/submit', handler: submit.POST as Handler, param: 'id' },
  { label: 'POST /api/protocols/[id]/action-items', handler: actionItems.POST as Handler, param: 'id', body: { text: 'x' } },
  { label: 'PATCH /api/protocols/[id]/action-items/[itemId] (bad itemId)', handler: actionItemOne.PATCH as Handler, param: 'itemId', body: { completed: true } },
  { label: 'POST /api/protocols/resolutions/[resId]/challenges', handler: challenges.POST as Handler, param: 'resId', body: { grounds: 'x' } },
  { label: 'PATCH .../challenges/[challengeId] (bad resId)', handler: challengeOne.PATCH as Handler, param: 'resId', body: { status: 'upheld' } },
  { label: 'PATCH .../challenges/[challengeId] (bad challengeId)', handler: challengeOne.PATCH as Handler, param: 'challengeId', body: { status: 'upheld' } },
]

describe('non-UUID ids under /api/protocols answer 400/404, never 500', () => {
  beforeEach(() => {
    sqlCalls.n = 0
  })

  it('exercises every route handler (a scan of zero cases proves nothing)', () => {
    expect(CASES.length).toBe(13)
    for (const c of CASES) expect(typeof c.handler, c.label).toBe('function')
  })

  for (const c of CASES) {
    for (const bad of BAD_IDS) {
      it(`${c.label} with ${c.param}=${JSON.stringify(bad)}`, async () => {
        const params: Record<string, string> = { id: GOOD, resId: GOOD, itemId: GOOD, challengeId: GOOD }
        params[c.param] = bad
        const status = await statusOf(() => c.handler(makeEvent(params, c.body ?? {}) as never))
        expect([400, 404], `status ${status}`).toContain(status)
        // The id was refused before any query; it never reached Postgres.
        expect(sqlCalls.n).toBe(0)
      })
    }
  }

  it('control: the fake database really does fail a well-formed id (so a missing guard cannot pass silently)', async () => {
    const status = await statusOf(() => protocolOne.GET(makeEvent({ id: GOOD }, {}) as never))
    expect(status).toBe(500)
    expect(sqlCalls.n).toBeGreaterThan(0)
  })
})
