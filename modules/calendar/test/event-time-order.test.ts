/**
 * calendar leaf: an event whose end lies before its start is refused with 400
 * on POST and PATCH /api/v1/events (the leaf is the store, so it holds the line
 * even when a caller skips the kernel's own check). An end equal to the start
 * stays valid: an all-day event is one date.
 *
 * PG-free: the store module is mocked, so the test sees whether a write was
 * attempted at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'

const store = vi.hoisted(() => ({
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
}))

vi.mock('../src/store/events.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/store/events.ts')>()),
  ...store,
}))
vi.mock('../src/outbox.ts', () => ({ enqueueOutbox: vi.fn(async () => undefined) }))

import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import type { Sql } from '../src/tenant-store.ts'

const SECRET = 'time-order-secret'
const headers = {
  'x-internal-auth': SECRET,
  'x-tenant-id': 'a1000000-0000-4000-8000-0000000000a1',
  'x-tenant-slug': 'time-order',
  'content-type': 'application/json',
}
const MESSAGE = 'Das Ende darf nicht vor dem Beginn liegen.'

function stubSql(): Sql {
  const sql = Object.assign((..._a: unknown[]) => Promise.resolve([]), {
    begin: async (cb: (tx: unknown) => unknown) => cb(sql),
  })
  return sql as unknown as Sql
}

describe('calendar leaf: end before start', () => {
  let base: string
  let server: ReturnType<typeof createServer>

  beforeAll(async () => {
    server = createServer({ secret: SECRET, routes: buildApiRoutes(async () => stubSql()) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  beforeEach(() => {
    vi.clearAllMocks()
    store.getEvent.mockResolvedValue({
      id: 'ev-1',
      startAt: new Date('2026-11-11T10:00:00.000Z'),
      endAt: new Date('2026-11-11T11:00:00.000Z'),
      committeeIds: [],
    })
    store.createEvent.mockImplementation(async (_sql: unknown, input: object) => ({ id: 'ev-new', committeeIds: [], source: 'manual', ...input }))
    store.updateEvent.mockImplementation(async (_sql: unknown, id: string) => ({ id }))
  })

  const post = (b: object) =>
    fetch(`${base}/api/v1/events`, { method: 'POST', headers, body: JSON.stringify({ title: 'T', createdBy: 'u', ...b }) })
  const patch = (b: object) =>
    fetch(`${base}/api/v1/events/ev-1`, { method: 'PATCH', headers, body: JSON.stringify(b) })

  it('POST with an end before the start is 400 and stores nothing', async () => {
    const res = await post({ startAt: '2026-11-11T10:00:00.000Z', endAt: '2026-11-11T09:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(MESSAGE)
    expect(store.createEvent).not.toHaveBeenCalled()
  })

  it('POST accepts a later end and an equal end', async () => {
    expect((await post({ startAt: '2026-11-11T10:00:00.000Z', endAt: '2026-11-11T11:00:00.000Z' })).status).toBe(201)
    expect((await post({ startAt: '2026-11-11T00:00:00.000Z', endAt: '2026-11-11T00:00:00.000Z', allDay: true })).status).toBe(201)
  })

  it('PATCH with an end before the start in the body is 400', async () => {
    const res = await patch({ startAt: '2026-11-12T10:00:00.000Z', endAt: '2026-11-12T09:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(store.updateEvent).not.toHaveBeenCalled()
  })

  it('PATCH with one side that contradicts the stored other side is 400', async () => {
    expect((await patch({ endAt: '2026-11-11T09:00:00.000Z' })).status).toBe(400)
    expect((await patch({ startAt: '2026-11-11T12:00:00.000Z' })).status).toBe(400)
    expect(store.updateEvent).not.toHaveBeenCalled()
  })

  it('PATCH with a valid change, or without times, is served', async () => {
    expect((await patch({ endAt: '2026-11-11T12:00:00.000Z' })).status).toBe(200)
    expect((await patch({ title: 'Neu' })).status).toBe(200)
  })
})
