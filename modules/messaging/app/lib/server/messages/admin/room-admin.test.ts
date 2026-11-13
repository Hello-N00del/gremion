import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// FLOW-MSG-001 (TASK-009 lane B): room-admin.ts drives the REAL matrix-client /
// synapse-admin fetch layer (mocked fetch, exercised end-to-end) but stubs the
// governance/DB layer — attachSubsystem/releaseSubsystem/getResource/getOrgUnit
// are Postgres-backed and already proven separately (T1-T5, real DB). Mocking
// them here keeps this suite a pure unit suite: no database, no live Matrix.

// TASK-205b: the service endpoints (Matrix, Helios, LiveKit, Nextcloud) come through the serviceEnv seam, the
// successor of the deleted default-tenant env reader. This suite feeds the seam the same values it already
// feeds its `$env/dynamic/private` mock, so every case keeps its own env fixture.
vi.mock('$lib/server/env/service-env', async () => {
  const { env } = await import('$env/dynamic/private')
  return { serviceEnv: (name: string) => (env as Record<string, string | undefined>)[name] }
})
vi.mock('$env/dynamic/private', () => ({
  env: {
    MATRIX_URL: 'http://matrix.test:8008',
    SYNAPSE_ADMIN_TOKEN: 'admin-token',
    SYNAPSE_ADMIN_BOT_USER_ID: '@bot:matrix.test',
    SYNAPSE_SERVER_NAME: 'matrix.test',
  },
}))
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
  currentTenantId: () => 'default',
}))

const getOrgUnit = vi.fn()
const listOrgUnits = vi.fn()
const setSubsystemWanted = vi.fn()
vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnit, listOrgUnits, setSubsystemWanted }))

const getResource = vi.fn()
const enqueueResources = vi.fn()
const markResourceOk = vi.fn()
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ getResource, enqueueResources, markResourceOk }))

// Karenz (Task 15): unarchiveRoom re-attaches the ledger in one transaction.
const TX = { tag: 'tx' }
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(TX) }),
}))

const attachSubsystem = vi.fn()
const releaseSubsystem = vi.fn()
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  attachSubsystem, releaseSubsystem,
}))

const writeAuditEntry = vi.fn()
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry }))

const UNIT = { id: 'u1', name: 'Vorstand' }

function okReport(externalId: string) {
  return {
    orgUnitId: 'u1', overall: 'ok',
    subsystems: [
      { subsystem: 'keycloak', status: 'ok', willRetry: false },
      { subsystem: 'matrix', status: 'ok', willRetry: false },
      { subsystem: 'nextcloud', status: 'skipped', willRetry: false },
    ],
    __externalId: externalId,
  }
}

describe('room-admin', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // TASK-009 verifier FIX item 1: the archive marker is trusted only when the
  // admin bot sent it AND created the room, both read as full events
  // (?format=event). Marker reads therefore issue two GETs per room and run in
  // parallel across rooms, so these suites route fetch by URL instead of
  // relying on call order.
  const BOT = '@bot:matrix.test'
  type RoomFixture = { marker?: unknown; markerSender?: string; createSender?: string; markerError?: Error }
  // Models Synapse faithfully: a plain state read returns the CONTENT only;
  // ?format=event returns the full event (sender + content).
  const isStateRead = (url: string, roomId: string, type: string) =>
    url.includes(`/rooms/${encodeURIComponent(roomId)}/state/${type}/`)
  let currentUrl = ''
  const evResponse = (sender: string, content: unknown) =>
    new Response(JSON.stringify(currentUrl.includes('format=event') ? { sender, content } : content), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  function routeMatrix(
    rooms: Record<string, RoomFixture>,
    extra?: (url: string, init?: RequestInit) => Response | undefined,
  ) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      currentUrl = url
      for (const [roomId, f] of Object.entries(rooms)) {
        if (isStateRead(url, roomId, 'org.gremion.room.archived')) {
          if (f.markerError) throw f.markerError
          return f.marker === undefined
            ? new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 })
            : evResponse(f.markerSender ?? BOT, f.marker)
        }
        if (isStateRead(url, roomId, 'm.room.create')) {
          return evResponse(f.createSender ?? BOT, { room_version: '10' })
        }
      }
      const r = extra?.(url, init)
      if (r) return r
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
  }
  const deleteCalls = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'DELETE')

  // TASK-009 fu1 defect 1: findArchivedRooms now scans EVERY room via
  // listRooms() (paginated GET /_synapse/admin/v1/rooms, no search_term) and
  // keeps only those whose `creator` is the admin bot, rather than relying on
  // Synapse's search_term (which — per Synapse's own docs — only matches a
  // room's name/canonical_alias/room_id, so a directory-only archive alias is
  // invisible to it). This fakes listRooms' pagination faithfully: `from` is
  // an index into `rooms`, a page is `pageSize` rooms, and next_batch is
  // present iff more remain — matching real Synapse semantics, NOT a
  // search_term match.
  function fakeListRoomsHandler(
    rooms: Array<{ room_id: string; creator?: string; canonical_alias?: string | null }>,
    pageSize = 100,
  ) {
    return (url: string): Response | undefined => {
      if (!url.includes('/_synapse/admin/v1/rooms') || url.includes('!')) return undefined // exclude single-room-detail GETs
      if (url.includes('search_term')) return undefined // must NOT be used by production code any more
      if (url.includes('limit=1')) {
        return new Response(JSON.stringify({ rooms: [] }), { status: 200 }) // validateCredentials probe
      }
      const qIndex = url.indexOf('?')
      const params = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '')
      const from = Number(params.get('from') ?? '0')
      const page = rooms.slice(from, from + pageSize)
      const nextBatch = from + pageSize < rooms.length ? from + pageSize : undefined
      return new Response(
        JSON.stringify({ rooms: page, ...(nextBatch !== undefined ? { next_batch: nextBatch } : {}) }),
        { status: 200 },
      )
    }
  }

  describe('createRoom', () => {
    it('T6: happy path with a custom name — PUTs m.room.name, audits ok, returns the roomId', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource
        .mockResolvedValueOnce(null) // pre-check: no existing room
        .mockResolvedValueOnce({ status: 'ok', external_id: '!new:matrix.test' }) // post-attach read
      attachSubsystem.mockResolvedValue(okReport('!new:matrix.test'))

      const { createRoom } = await import('./room-admin')
      const result = await createRoom('u1', { name: 'Der Vorstand', userId: 'admin-1' })

      expect(result.roomId).toBe('!new:matrix.test')
      expect(attachSubsystem).toHaveBeenCalledWith('u1', 'matrix')

      // The rename PUT — the only fetch call for this happy path (no custom
      // topic, no other Matrix calls issued directly by createRoom).
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('/state/m.room.name/')
      expect(init.method).toBe('PUT')
      expect(JSON.parse(init.body as string)).toEqual({ name: 'Der Vorstand' })

      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.create', newValue: 'u1:!new:matrix.test:ok' })
      )
    })

    it('T7: 409 when the room already exists — no Matrix call, attachSubsystem never called', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!existing:matrix.test' })

      const { createRoom, RoomConflictError } = await import('./room-admin')

      await expect(createRoom('u1', { userId: 'admin-1' })).rejects.toThrow(RoomConflictError)
      expect(attachSubsystem).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('LOW fix: a concurrent archive/delete race after attachSubsystem reports ok throws a typed RoomNotFoundError, not a raw TypeError', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource
        .mockResolvedValueOnce(null) // pre-check: no existing room
        .mockResolvedValueOnce(null) // post-attach re-read: ledger row vanished mid-race
      attachSubsystem.mockResolvedValue(okReport('!new:matrix.test'))

      const { createRoom, RoomNotFoundError } = await import('./room-admin')
      await expect(createRoom('u1', { userId: 'admin-1' })).rejects.toThrow(RoomNotFoundError)
    })

    it('T8: Synapse unreachable (ECONNREFUSED) — MatrixUnavailableError, audit outcome failed', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValueOnce(null)
      attachSubsystem.mockResolvedValue({
        orgUnitId: 'u1', overall: 'degraded',
        subsystems: [
          { subsystem: 'keycloak', status: 'ok', willRetry: false },
          { subsystem: 'matrix', status: 'failed', error: 'connect ECONNREFUSED 127.0.0.1:8008', willRetry: true },
          { subsystem: 'nextcloud', status: 'skipped', willRetry: false },
        ],
      })

      const { createRoom, MatrixUnavailableError } = await import('./room-admin')

      await expect(createRoom('u1', { userId: 'admin-1' })).rejects.toThrow(MatrixUnavailableError)
      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.create', newValue: 'u1::failed' })
      )
    })
  })

  describe('renameRoom', () => {
    it('T9: sends the PUT state to the tenant matrixUrl with the new name', async () => {
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })

      const { renameRoom } = await import('./room-admin')
      await renameRoom('u1', { name: 'Neuer Name', userId: 'admin-1' })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('http://matrix.test:8008/_matrix/client/v3/rooms/' + encodeURIComponent('!r:matrix.test') + '/state/m.room.name/')
      expect(JSON.parse(init.body as string)).toEqual({ name: 'Neuer Name' })
      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.rename' })
      )
    })
  })

  describe('archiveRoom', () => {
    function mockReleaseInvokesTeardown(result: 'ok' | 'db-fail') {
      releaseSubsystem.mockImplementation(async (_unitId, _sub, teardown) => {
        await teardown('!r:matrix.test')
        if (result === 'db-fail') throw new Error('db detach failed')
        return '!r:matrix.test'
      })
    }

    it('T10: prior marker read, power levels read, marker (with prior), power levels write, alias RESOLVE (matches), alias delete + archive alias + canonical_alias - in that order', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 404 })) // 1. existing archive marker GET (none)
        .mockResolvedValueOnce(new Response(JSON.stringify({ users: { '@bot:matrix.test': 100 } }), { status: 200 })) // 2. power_levels GET
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 3. marker PUT
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 4. power_levels PUT
        .mockResolvedValueOnce(new Response(JSON.stringify({ room_id: '!r:matrix.test' }), { status: 200 })) // 5. alias resolve GET (matches this room)
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 6. alias DELETE
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 7. archive alias PUT
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 8. canonical_alias state PUT
      mockReleaseInvokesTeardown('ok')

      const { archiveRoom } = await import('./room-admin')
      const roomId = await archiveRoom('u1', { userId: 'admin-1' })

      expect(roomId).toBe('!r:matrix.test')
      expect(fetchMock).toHaveBeenCalledTimes(8)
      const urls = fetchMock.mock.calls.map((c) => c[0] as string)
      const methods = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).method)
      expect(urls[0]).toContain('/state/org.gremion.room.archived/')
      expect(methods[0]).toBe('GET')
      expect(urls[1]).toContain('/state/m.room.power_levels/')
      expect(methods[1]).toBe('GET')
      expect(urls[2]).toContain('/state/org.gremion.room.archived/')
      expect(methods[2]).toBe('PUT')
      expect(urls[3]).toContain('/state/m.room.power_levels/')
      expect(methods[3]).toBe('PUT')
      expect(urls[4]).toContain('/directory/room/')
      expect(methods[4]).toBeUndefined() // getRoomIdByAlias omits `method` - fetch defaults to GET
      expect(urls[5]).toContain('/directory/room/')
      expect(methods[5]).toBe('DELETE')
      expect(urls[6]).toContain('/directory/room/')
      expect(methods[6]).toBe('PUT')
      expect(urls[7]).toContain('/state/m.room.canonical_alias/')
      expect(methods[7]).toBe('PUT')

      const powerLevelsBody = JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string)
      expect(powerLevelsBody.events_default).toBe(100)
      expect(powerLevelsBody.invite).toBe(100)
      expect(powerLevelsBody.state_default).toBe(100)
      expect(powerLevelsBody.events['m.call.member']).toBe(100)
      expect(powerLevelsBody.users).toEqual({ '@bot:matrix.test': 100 }) // users map kept

      // DEFECT 1: the archive alias is set as m.room.canonical_alias (not
      // just a bare directory alias), and it is the SAME alias value that
      // was just put in the directory - not independently recomputed
      // (freshArchiveAlias() embeds a timestamp; calling it twice would mint
      // two different aliases and point canonical_alias at one the
      // directory PUT never created).
      const archiveAliasUrl = decodeURIComponent(urls[6]!.split('/directory/room/')[1]!)
      const canonicalBody = JSON.parse((fetchMock.mock.calls[7][1] as RequestInit).body as string)
      expect(canonicalBody).toEqual({ alias: archiveAliasUrl })

      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.archive', newValue: 'u1:!r:matrix.test:ok' })
      )
    })

    it('Karenz T15: archive stores the prior power levels (the values it overwrites) in the marker', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      const prior = {
        events_default: 0, invite: 0, state_default: 50,
        events: { 'm.call.member': 0, 'org.matrix.msc3401.call.member': 0 },
      }
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 404 })) // existing marker: none
        .mockResolvedValueOnce(new Response(JSON.stringify({
          ...prior, events: { ...prior.events, 'm.room.name': 50 }, users: { '@bot:matrix.test': 100 },
        }), { status: 200 })) // power_levels GET
        .mockImplementation(async () => new Response('{}', { status: 200 }))
      mockReleaseInvokesTeardown('ok')

      const { archiveRoom } = await import('./room-admin')
      await archiveRoom('u1', { userId: 'admin-1' })

      const markerPut = fetchMock.mock.calls.find((c) =>
        (c[0] as string).includes('/state/org.gremion.room.archived/') && (c[1] as RequestInit).method === 'PUT')!
      const markerBody = JSON.parse((markerPut[1] as RequestInit).body as string)
      expect(markerBody.org_unit_id).toBe('u1')
      expect(markerBody.tenant_id).toBe('default') // whose archive it is: unit ids are not unique across customers
      expect(markerBody.prior).toEqual(prior) // only the four call-member types of `events`, never m.room.name
      expect(markerBody.prior.events['m.room.name']).toBeUndefined()
    })

    it('Karenz T15: a retry after a partial archive keeps the FIRST prior (the room is already read-only then)', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      const firstPrior = { events_default: 0, invite: 0, state_default: 50, events: { 'm.call.member': 0 } }
      routeMatrix(
        { '!r:matrix.test': { marker: { org_unit_id: 'u1', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z', prior: firstPrior } } },
        (url) => {
          if (url.includes('/state/m.room.power_levels/')) {
            // the room is ALREADY read-only from the first, interrupted attempt
            return new Response(JSON.stringify({ events_default: 100, invite: 100, state_default: 100, events: { 'm.call.member': 100 } }), { status: 200 })
          }
          return undefined
        },
      )
      mockReleaseInvokesTeardown('ok')

      const { archiveRoom } = await import('./room-admin')
      await archiveRoom('u1', { userId: 'admin-1' })

      const markerPut = fetchMock.mock.calls.find((c) =>
        (c[0] as string).includes('/state/org.gremion.room.archived/') && (c[1] as RequestInit).method === 'PUT')!
      const markerBody = JSON.parse((markerPut[1] as RequestInit).body as string)
      expect(markerBody.prior).toEqual(firstPrior)
      expect(markerBody.archived_at).toBe('2026-09-01T00:00:00Z')
    })

    it('MEDIUM fix (round-1 deferred, r1-kernel-nav-roomsB2): a canonical alias that resolves to a DIFFERENT room is never deleted', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 404 })) // existing marker GET (none)
        .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })) // power_levels GET
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // marker PUT
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // power_levels PUT
        // The alias now resolves to SOME OTHER room (rename collision) —
        // deleting it would take down that other unit's live canonical alias.
        .mockResolvedValueOnce(new Response(JSON.stringify({ room_id: '!someone-elses-room:matrix.test' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // archive alias PUT still happens
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // canonical_alias state PUT still happens
      mockReleaseInvokesTeardown('ok')

      const { archiveRoom } = await import('./room-admin')
      await archiveRoom('u1', { userId: 'admin-1' })

      // Exactly 7 calls: no DELETE call was ever issued for the mismatched alias.
      expect(fetchMock).toHaveBeenCalledTimes(7)
      const methods = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).method)
      expect(methods).not.toContain('DELETE')
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not resolve to the room being archived'),
        expect.objectContaining({ roomId: '!r:matrix.test', resolvedRoomId: '!someone-elses-room:matrix.test' })
      )
      errSpy.mockRestore()
    })

    it('T10b: a DB-detach failure after teardown propagates, and a retry is idempotent (same Matrix ops, now succeeds)', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      mockReleaseInvokesTeardown('db-fail')

      const { archiveRoom } = await import('./room-admin')
      await expect(archiveRoom('u1', { userId: 'admin-1' })).rejects.toThrow('db detach failed')
      const callsAfterFailure = fetchMock.mock.calls.length
      expect(callsAfterFailure).toBe(7) // teardown ran fully before the DB step failed

      // Retry: ledger row is still 'ok' (DB detach never committed), so a second
      // archiveRoom call re-finds the same active room and redoes the same idempotent ops.
      mockReleaseInvokesTeardown('ok')
      const roomId = await archiveRoom('u1', { userId: 'admin-1' })
      expect(roomId).toBe('!r:matrix.test')
      expect(fetchMock).toHaveBeenCalledTimes(callsAfterFailure + 7)
    })

    it('T11: an M_FORBIDDEN power-levels read calls makeRoomAdmin once, then retries — and canonical_alias inherits that same admin grant', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 404 })) // 1. existing marker GET (none)
        .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'not admin' }), { status: 403 })) // 2. power_levels GET -> forbidden
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 3. make_room_admin POST
        .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })) // 4. power_levels GET retry -> ok
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 5. marker PUT
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 6. power_levels PUT
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 7. alias resolve GET (default {} body -> mismatch, delete skipped)
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 8. archive alias PUT
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // 9. canonical_alias state PUT - no SECOND make_room_admin call
      mockReleaseInvokesTeardown('ok')

      const { archiveRoom } = await import('./room-admin')
      await archiveRoom('u1', { userId: 'admin-1' })

      expect(fetchMock).toHaveBeenCalledTimes(9)
      const [makeAdminUrl, makeAdminInit] = fetchMock.mock.calls[2] as [string, RequestInit]
      expect(makeAdminUrl).toContain('/make_room_admin')
      expect(JSON.parse(makeAdminInit.body as string)).toEqual({ user_id: '@bot:matrix.test' })
      const makeAdminCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes('/make_room_admin'))
      expect(makeAdminCalls).toHaveLength(1) // canonical_alias PUT never needed its own forbidden-retry
      expect((fetchMock.mock.calls[8]![0] as string)).toContain('/state/m.room.canonical_alias/')
    })

    it('T11b: a FORBIDDEN power-levels WRITE (read succeeded, bot below 100) re-reads after make_room_admin, so the retried PUT keeps the bot at 100 and the later alias steps are allowed', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      // A stateful homeserver: the bot sits at 50, so writing m.room.power_levels is forbidden
      // until make_room_admin raises it to 100; a write replaces the whole content.
      let pl: Record<string, unknown> = { users: { [BOT]: 50 }, state_default: 50 }
      const plPuts: Array<Record<string, unknown>> = []
      const botLevel = () => (pl.users as Record<string, number>)[BOT] ?? 0
      const forbidden = () => new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'no' }), { status: 403 })
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (url.includes('/state/org.gremion.room.archived/') && method === 'GET') return new Response('{}', { status: 404 })
        if (url.includes('/make_room_admin')) {
          pl = { ...pl, users: { ...(pl.users as object), [BOT]: 100 } }
          return new Response('{}', { status: 200 })
        }
        if (url.includes('/state/m.room.power_levels/')) {
          if (method === 'GET') return new Response(JSON.stringify(pl), { status: 200 })
          if (botLevel() < 100) return forbidden()
          pl = JSON.parse(init!.body as string)
          plPuts.push(pl)
          return new Response('{}', { status: 200 })
        }
        if (url.includes('/state/m.room.canonical_alias/') && method === 'PUT') {
          // after the archive the room needs PL100 for state events: a demoted bot is locked out
          return botLevel() >= (pl.state_default as number) ? new Response('{}', { status: 200 }) : forbidden()
        }
        return new Response('{}', { status: 200 })
      })
      mockReleaseInvokesTeardown('ok')

      const { archiveRoom } = await import('./room-admin')
      await expect(archiveRoom('u1', { userId: 'admin-1' })).resolves.toBe('!r:matrix.test')

      expect(plPuts).toHaveLength(1)
      expect((plPuts[0]!.users as Record<string, number>)[BOT]).toBe(100) // not the stale 50
      expect(plPuts[0]!.state_default).toBe(100)
    })
  })

  describe('unarchiveRoom (Karenz restore)', () => {
    const ROOM = '!r:matrix.test'
    const ARCHIVE_ALIAS = '#stura-archiv-vorstand-202609010000:matrix.test'
    const CANON = '#stura-vorstand:matrix.test'
    const CALL_TYPES = [
      'org.matrix.msc4143.rtc.member', 'org.matrix.msc3401.call.member', 'm.call.member', 'io.element.call.encryption_keys',
    ]
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

    // A faithful in-memory room: state events by type, directory aliases by name.
    function archivedRoom(opts: { prior?: unknown; aliasHolder?: string } = {}) {
      const state = new Map<string, unknown>()
      state.set('m.room.create', { room_version: '10' })
      state.set('org.gremion.room.archived', { org_unit_id: 'u1', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z', ...(opts.prior ? { prior: opts.prior } : {}) })
      state.set('m.room.power_levels', {
        events_default: 100, invite: 100, state_default: 100,
        events: { ...Object.fromEntries(CALL_TYPES.map((t) => [t, 100])), 'm.room.name': 50 },
        users: { [BOT]: 100 },
      })
      state.set('m.room.canonical_alias', { alias: ARCHIVE_ALIAS })
      const aliases = new Map<string, string>([[ARCHIVE_ALIAS, ROOM]])
      if (opts.aliasHolder) aliases.set(CANON, opts.aliasHolder)
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const st = /\/rooms\/[^/]+\/state\/([^/]+)\//.exec(url)
        if (st) {
          const type = decodeURIComponent(st[1]!)
          if (method === 'PUT') { state.set(type, JSON.parse(init!.body as string)); return ok({}) }
          if (!state.has(type)) return new Response('{"errcode":"M_NOT_FOUND"}', { status: 404 })
          return ok(url.includes('format=event') ? { sender: BOT, content: state.get(type) } : state.get(type))
        }
        const dir = /\/directory\/room\/([^?]+)/.exec(url)
        if (dir) {
          const alias = decodeURIComponent(dir[1]!)
          if (method === 'PUT') { aliases.set(alias, JSON.parse(init!.body as string).room_id); return ok({}) }
          if (method === 'DELETE') { aliases.delete(alias); return ok({}) }
          return aliases.has(alias) ? ok({ room_id: aliases.get(alias) }) : new Response('{"errcode":"M_NOT_FOUND"}', { status: 404 })
        }
        return ok({})
      })
      return { state, aliases }
    }

    it('restores the prior power levels exactly, puts the canonical alias back, re-attaches the ledger and the room is no longer archived', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue(null) // released at the switch-off
      const prior = { events_default: 0, invite: 0, state_default: 50, events: { 'm.call.member': 0 } }
      const room = archivedRoom({ prior })

      const { unarchiveRoom, getRoomArchiveMarker } = await import('./room-admin')
      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })

      const pl = room.state.get('m.room.power_levels') as { events_default: number; invite: number; state_default: number; events: Record<string, number>; users: Record<string, number> }
      expect(pl.events_default).toBe(0)
      expect(pl.invite).toBe(0)
      expect(pl.state_default).toBe(50)
      expect(pl.events['m.call.member']).toBe(0)
      // the other call types were not in the room before the archive: gone again, not set to a made-up value
      expect(pl.events['org.matrix.msc3401.call.member']).toBeUndefined()
      expect(pl.events['m.room.name']).toBe(50) // untouched
      expect(pl.users).toEqual({ [BOT]: 100 })

      expect(room.aliases.get(CANON)).toBe(ROOM)
      expect(room.aliases.has(ARCHIVE_ALIAS)).toBe(false)
      expect(room.state.get('m.room.canonical_alias')).toEqual({ alias: CANON })

      expect(enqueueResources).toHaveBeenCalledWith(TX, 'u1', ['matrix'])
      expect(setSubsystemWanted).toHaveBeenCalledWith(TX, 'u1', 'matrix', true)
      expect(markResourceOk).toHaveBeenCalledWith('u1', 'matrix', ROOM, TX)

      // the marker is overwritten (a state event cannot be deleted); the room then reads as active
      const marker = room.state.get('org.gremion.room.archived') as Record<string, unknown>
      expect(typeof marker.unarchived_at).toBe('string')
      expect(marker.org_unit_id).toBeUndefined()
      await expect(getRoomArchiveMarker(ROOM)).resolves.toBeNull()
      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.unarchive', newValue: `u1:${ROOM}:ok` })
      )
    })

    it('a marker written before the prior was stored falls back to the createRoom defaults (0 for the call-member events)', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue(null)
      const room = archivedRoom()

      const { unarchiveRoom } = await import('./room-admin')
      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })

      const pl = room.state.get('m.room.power_levels') as { events_default: number; invite: number; state_default: number; events: Record<string, number> }
      expect([pl.events_default, pl.invite, pl.state_default]).toEqual([0, 0, 50])
      for (const t of CALL_TYPES) expect(pl.events[t]).toBe(0)
      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.unarchive', newValue: `u1:${ROOM}:ok-defaults` })
      )
    })

    it('the ledger is re-attached BEFORE the marker is overwritten, so an interrupted restore is retried', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue(null)
      const room = archivedRoom()
      markResourceOk.mockRejectedValueOnce(new Error('db down'))

      const { unarchiveRoom, getRoomArchiveMarker } = await import('./room-admin')
      await expect(unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })).rejects.toThrow('db down')
      expect((await getRoomArchiveMarker(ROOM))?.org_unit_id).toBe('u1') // still archived: the retry will do it all again
      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.unarchive', newValue: `u1:${ROOM}:failed` })
      )

      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' }) // idempotent second run
      expect(room.aliases.get(CANON)).toBe(ROOM)
      await expect(getRoomArchiveMarker(ROOM)).resolves.toBeNull()
    })

    it('a transient failure while removing the archive alias does not leak it: the retry still finds and removes it', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue(null)
      const room = archivedRoom()
      const inner = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>
      let failed = false
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (!failed && init?.method === 'DELETE' && url.includes(encodeURIComponent(ARCHIVE_ALIAS))) {
          failed = true
          return new Response('{"errcode":"M_UNKNOWN"}', { status: 500 })
        }
        return inner(url, init)
      })

      const { unarchiveRoom } = await import('./room-admin')
      await expect(unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })).rejects.toThrow('500')
      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })

      expect(room.aliases.has(ARCHIVE_ALIAS)).toBe(false) // not left behind, pointing at an active room
      expect(room.state.get('m.room.canonical_alias')).toEqual({ alias: CANON })
    })

    it('an already active room (no marker, ledger row ok for this room) is a no-op', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: ROOM })
      routeMatrix({}) // no marker anywhere

      const { unarchiveRoom } = await import('./room-admin')
      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })

      const writes = fetchMock.mock.calls.filter((c) => ['PUT', 'DELETE', 'POST'].includes((c[1] as RequestInit)?.method ?? ''))
      expect(writes).toHaveLength(0)
      expect(markResourceOk).not.toHaveBeenCalled()
    })

    it('a room that is neither archived for this unit nor its active room is a RoomNotFoundError', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue(null)
      routeMatrix({ [ROOM]: { marker: { org_unit_id: 'someone-else', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } } })

      const { unarchiveRoom, RoomNotFoundError } = await import('./room-admin')
      await expect(unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })).rejects.toThrow(RoomNotFoundError)
    })

    it('a room that is a unit ledger room is already active whatever the row status (a failed row, no marker): a no-op', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'failed', external_id: ROOM })
      routeMatrix({ [ROOM]: {} })

      const { unarchiveRoom } = await import('./room-admin')
      await expect(unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })).resolves.toEqual({ aliasRestored: true, priorGuessed: false })
      expect(markResourceOk).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.filter((c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET') !== 'GET')).toHaveLength(0)
    })

    it('a canonical alias held by ANOTHER room never blocks the restore: the alias is not taken over, the room is writable again and re-attached', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue(null)
      const prior = { events_default: 0, invite: 0, state_default: 50, events: {} }
      const room = archivedRoom({ aliasHolder: '!other:matrix.test', prior })

      const { unarchiveRoom, getRoomArchiveMarker } = await import('./room-admin')
      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })

      expect(room.aliases.get(CANON)).toBe('!other:matrix.test') // never taken over
      expect((room.state.get('m.room.power_levels') as { events_default: number }).events_default).toBe(0)
      expect(markResourceOk).toHaveBeenCalledWith('u1', 'matrix', ROOM, TX)
      expect(room.aliases.get(ARCHIVE_ALIAS)).toBe(ROOM) // still reachable by its archive alias
      expect(room.state.get('m.room.canonical_alias')).toEqual({ alias: ARCHIVE_ALIAS })
      await expect(getRoomArchiveMarker(ROOM)).resolves.toBeNull()
    })

    it('a failing audit write in the failure path does not replace the error being reported', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue(null)
      markResourceOk.mockRejectedValueOnce(new Error('db down'))
      writeAuditEntry.mockRejectedValueOnce(new Error('audit down'))
      archivedRoom()

      const { unarchiveRoom } = await import('./room-admin')
      await expect(unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })).rejects.toThrow('db down')
    })

    it('a ledger row that is already ok for a DIFFERENT room is a RoomConflictError', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: '!fresh:matrix.test' })
      archivedRoom()

      const { unarchiveRoom, RoomConflictError } = await import('./room-admin')
      await expect(unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })).rejects.toThrow(RoomConflictError)
      expect(markResourceOk).not.toHaveBeenCalled()
    })

    it.each(['failed', 'pending'])('a ledger row (%s) that names a DIFFERENT room is a RoomConflictError too: that room is live and must not be orphaned', async (status) => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status, external_id: '!fresh:matrix.test' })
      const room = archivedRoom()

      const { unarchiveRoom, RoomConflictError } = await import('./room-admin')
      await expect(unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })).rejects.toThrow(RoomConflictError)
      expect(markResourceOk).not.toHaveBeenCalled()
      expect(room.aliases.has(CANON)).toBe(false) // the Matrix side was not touched
    })

    it('a pending row without an external id is no conflict: the restore re-attaches the room', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'pending', external_id: null })
      archivedRoom()

      const { unarchiveRoom } = await import('./room-admin')
      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })
      expect(markResourceOk).toHaveBeenCalledWith('u1', 'matrix', ROOM, TX)
    })

    it('the archive alias named by the marker is removed even when the canonical_alias state never got it (an archive that died between the two)', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue({ status: 'ok', external_id: ROOM })
      const room = archivedRoom()
      room.state.set('org.gremion.room.archived', { org_unit_id: 'u1', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z', archive_alias: ARCHIVE_ALIAS })
      room.state.set('m.room.canonical_alias', { alias: CANON })

      const { unarchiveRoom } = await import('./room-admin')
      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })

      expect(room.aliases.has(ARCHIVE_ALIAS)).toBe(false)
      expect(room.aliases.get(CANON)).toBe(ROOM)
    })

    it('a marker archive alias that points at ANOTHER room is never deleted', async () => {
      getOrgUnit.mockResolvedValue(UNIT)
      getResource.mockResolvedValue(null)
      const room = archivedRoom()
      room.state.set('org.gremion.room.archived', { org_unit_id: 'u1', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z', archive_alias: '#stura-archiv-x-202601010000:matrix.test' })
      room.aliases.set('#stura-archiv-x-202601010000:matrix.test', '!elsewhere:matrix.test')

      const { unarchiveRoom } = await import('./room-admin')
      await unarchiveRoom('u1', ROOM, { userId: 'karenz-service' })

      expect(room.aliases.get('#stura-archiv-x-202601010000:matrix.test')).toBe('!elsewhere:matrix.test')
      expect(room.aliases.has(ARCHIVE_ALIAS)).toBe(false) // the canonical_alias fallback still removed its own
    })

    it('getRoomArchiveMarker withholds the unit of a marker stamped by ANOTHER customer, or by none (still archived, but no unit of this customer)', async () => {
      const { getRoomArchiveMarker } = await import('./room-admin')
      routeMatrix({ [ROOM]: { marker: { org_unit_id: 'u1', tenant_id: 'other-customer', archived_at: '2026-09-01T00:00:00Z' } } })
      await expect(getRoomArchiveMarker(ROOM)).resolves.toEqual({ foreign: true })
      routeMatrix({ [ROOM]: { marker: { org_unit_id: 'u1', archived_at: '2026-09-01T00:00:00Z' } } })
      await expect(getRoomArchiveMarker(ROOM)).resolves.toEqual({ foreign: true })
    })

    it('getRoomArchiveMarker returns null for marker content without org_unit_id (an unarchived room)', async () => {
      routeMatrix({ [ROOM]: { marker: { unarchived_at: '2026-09-10T00:00:00Z' } } })
      const { getRoomArchiveMarker } = await import('./room-admin')
      await expect(getRoomArchiveMarker(ROOM)).resolves.toBeNull()
    })
  })

  describe('deleteRoom', () => {
    it('T12a: delete of the active room calls synapseAdmin.deleteRoom then detaches', async () => {
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      releaseSubsystem.mockImplementation(async (_unitId, _sub, teardown) => {
        await teardown('!r:matrix.test')
        return '!r:matrix.test'
      })

      const { deleteRoom } = await import('./room-admin')
      await deleteRoom('u1', '!r:matrix.test', { userId: 'it-admin-1' })

      expect(releaseSubsystem).toHaveBeenCalledWith('u1', 'matrix', expect.any(Function))
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('http://matrix.test:8008/_synapse/admin/v1/rooms/' + encodeURIComponent('!r:matrix.test'))
      expect(init.method).toBe('DELETE')
      expect(JSON.parse(init.body as string)).toEqual({ block: true, purge: true })
      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.delete', newValue: 'u1:!r:matrix.test:ok' })
      )
    })

    it('T12b: delete of an archived room requires a marker whose org_unit exists — otherwise 404 (RoomNotFoundError)', async () => {
      // The active-room ledger check misses (this roomId is not the unit's CURRENT room).
      getResource.mockResolvedValue(null)
      getOrgUnit.mockResolvedValue(UNIT)
      routeMatrix({ '!archived:matrix.test': { marker: { org_unit_id: 'u1', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } } })

      const { deleteRoom } = await import('./room-admin')
      await deleteRoom('u1', '!archived:matrix.test', { userId: 'it-admin-1' })

      const deleteCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE')
      expect(deleteCall?.[0]).toBe(
        'http://matrix.test:8008/_synapse/admin/v1/rooms/' + encodeURIComponent('!archived:matrix.test')
      )
    })

    it('T12c: a marker naming a DIFFERENT (or absent) org unit is refused with RoomNotFoundError', async () => {
      getResource.mockResolvedValue(null)
      getOrgUnit.mockResolvedValue(UNIT)
      routeMatrix({ '!foreign:matrix.test': { marker: { org_unit_id: 'someone-elses-unit', tenant_id: 'default' } } })

      const { deleteRoom, RoomNotFoundError } = await import('./room-admin')
      await expect(
        deleteRoom('u1', '!foreign:matrix.test', { userId: 'it-admin-1' })
      ).rejects.toThrow(RoomNotFoundError)
    })

    it('T12d: a transport failure during the active-room teardown writes a "failed" audit entry and throws MatrixUnavailableError', async () => {
      getResource.mockResolvedValue({ status: 'ok', external_id: '!r:matrix.test' })
      releaseSubsystem.mockImplementation(async (_unitId, _sub, teardown) => {
        // The teardown callback itself calls getSynapseAdmin().deleteRoom,
        // which issues the fetch that rejects here.
        await teardown('!r:matrix.test')
        return '!r:matrix.test'
      })
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8008'))

      const { deleteRoom, MatrixUnavailableError } = await import('./room-admin')
      await expect(
        deleteRoom('u1', '!r:matrix.test', { userId: 'it-admin-1' })
      ).rejects.toThrow(MatrixUnavailableError)

      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.delete', newValue: 'u1:!r:matrix.test:failed' })
      )
      expect(writeAuditEntry).not.toHaveBeenCalledWith(
        expect.objectContaining({ newValue: 'u1:!r:matrix.test:ok' })
      )
    })

    it('T12e: a transport failure deleting an ARCHIVED room (no active ledger row) writes a "failed" audit entry too', async () => {
      getResource.mockResolvedValue(null)
      getOrgUnit.mockResolvedValue(UNIT)
      routeMatrix(
        { '!archived:matrix.test': { marker: { org_unit_id: 'u1', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } } },
        (_url, init) => {
          if (init?.method === 'DELETE') throw new Error('connect ECONNREFUSED 127.0.0.1:8008') // the delete itself
          return undefined
        },
      )

      const { deleteRoom, MatrixUnavailableError } = await import('./room-admin')
      await expect(
        deleteRoom('u1', '!archived:matrix.test', { userId: 'it-admin-1' })
      ).rejects.toThrow(MatrixUnavailableError)

      expect(writeAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'messages.room.delete', newValue: 'u1:!archived:matrix.test:failed' })
      )
    })

    it('SECURITY (verifier FIX 1): a marker NOT sent by the admin bot is ignored — RoomNotFoundError, no purge issued', async () => {
      // Any signed-in user can mint a Matrix token, create a room, and set a
      // marker naming a victim unit. Before the fix deleteRoom trusted it and
      // an ITAdmin click purged the attacker-chosen room.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      getResource.mockResolvedValue(null)
      getOrgUnit.mockResolvedValue(UNIT)
      routeMatrix({
        '!evil:matrix.test': { marker: { org_unit_id: 'u1', tenant_id: 'default' }, markerSender: '@mallory:matrix.test' },
      })

      const { deleteRoom, RoomNotFoundError } = await import('./room-admin')
      await expect(
        deleteRoom('u1', '!evil:matrix.test', { userId: 'it-admin-1' })
      ).rejects.toThrow(RoomNotFoundError)
      expect(deleteCalls()).toHaveLength(0)
      expect(writeAuditEntry).not.toHaveBeenCalledWith(expect.objectContaining({ newValue: 'u1:!evil:matrix.test:ok' }))
      warnSpy.mockRestore()
    })

    it('SECURITY (verifier FIX 1): a room the admin bot did not CREATE is not Gremion-managed, even with a bot-sent marker — RoomNotFoundError', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      getResource.mockResolvedValue(null)
      getOrgUnit.mockResolvedValue(UNIT)
      routeMatrix({
        '!foreign:matrix.test': { marker: { org_unit_id: 'u1', tenant_id: 'default' }, createSender: '@mallory:matrix.test' },
      })

      const { deleteRoom, RoomNotFoundError } = await import('./room-admin')
      await expect(
        deleteRoom('u1', '!foreign:matrix.test', { userId: 'it-admin-1' })
      ).rejects.toThrow(RoomNotFoundError)
      expect(deleteCalls()).toHaveLength(0)
      warnSpy.mockRestore()
    })
  })

  describe('listOverview', () => {
    it('T13: maps each ledger state, and degrades to matrix:"unreachable" without throwing when Matrix is down', async () => {
      getResource
        .mockResolvedValueOnce(null) // leer
        .mockResolvedValueOnce({ status: 'pending', external_id: null }) // wird angelegt
        .mockResolvedValueOnce({ status: 'failed', external_id: null, last_error: 'boom' }) // fehler
        .mockResolvedValueOnce({ status: 'ok', external_id: '!r:matrix.test' }) // aktiv
      // validateCredentials degrades to false on any transport failure (its own contract) —
      // simulate Matrix being down.
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'))

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([
        { id: 'a', name: 'Leer' }, { id: 'b', name: 'Ladend' },
        { id: 'c', name: 'Fehler' }, { id: 'd', name: 'Aktiv' },
      ] as never)

      expect(overview.matrix).toBe('unreachable')
      expect(overview.units.map((u) => u.state)).toEqual(['leer', 'wird_angelegt', 'fehler', 'aktiv'])
      expect(overview.units[3].roomId).toBe('!r:matrix.test')
    })

    it('MEDIUM fix (round-1 deferred, r2-rooms-B3): a ledger row matching no recognized status reports "fehler", not the archived/leer fallback', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // Two malformed shapes: an unrecognized status value, and 'ok' with no
      // external_id (a successful-provisioning row missing its own id) —
      // both used to fall silently into the archived-check branch.
      getResource
        .mockResolvedValueOnce({ status: 'weird_unknown_status', external_id: null })
        .mockResolvedValueOnce({ status: 'ok', external_id: null })
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 })) // reachable, no archived rooms

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'x', state: 'fehler' })
      expect(overview.units[1]).toMatchObject({ unitId: 'y', state: 'fehler' })
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('matching no recognized state'),
        expect.objectContaining({ unitId: 'x' })
      )
      errSpy.mockRestore()
    })

    it('T13b (B3-c): a unit with no active ledger row but a matching archived-room marker is "archiviert", not "leer"', async () => {
      getResource
        .mockResolvedValueOnce(null) // unit 'e' — released, no ledger row left (S2.1)
        .mockResolvedValueOnce(null) // unit 'f' — genuinely never had a room
      routeMatrix(
        { '!arch:matrix.test': { marker: { org_unit_id: 'e', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } } },
        fakeListRoomsHandler([{ room_id: '!arch:matrix.test', creator: BOT }]),
      )

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'e', name: 'Archiviert' }, { id: 'f', name: 'Leer' }] as never)

      expect(overview.matrix).toBe('reachable')
      expect(overview.units[0]).toMatchObject({ unitId: 'e', state: 'archiviert', roomId: '!arch:matrix.test' })
      expect(overview.units[1]).toMatchObject({ unitId: 'f', state: 'leer' })
      const listCall = fetchMock.mock.calls.find(
        (c) => (c[0] as string).includes('/_synapse/admin/v1/rooms') && !(c[0] as string).includes('limit=1')
      )
      expect(listCall).toBeTruthy()
      expect(listCall?.[0]).not.toContain('search_term')
    })

    // DEFECT 1 (this unit): the old search-based code searched for
    // 'stura-archiv-' as a search_term, which Synapse only matches against a
    // room's NAME, CANONICAL_ALIAS or ROOM_ID — never a plain directory-only
    // alias. This room's canonical_alias is null (exactly what a real
    // archived room looked like before archiveMatrixSide also set it), so
    // the old code found nothing here; detection must depend only on the
    // durable marker + creator scan, never on alias content.
    it('DEFECT 1 RED->GREEN: an archived room with only a directory alias (canonical_alias null) is still detected', async () => {
      getResource.mockResolvedValue(null)
      routeMatrix(
        { '!arch:matrix.test': { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } } },
        fakeListRoomsHandler([{ room_id: '!arch:matrix.test', creator: BOT, canonical_alias: null }]),
      )

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'k', state: 'archiviert', roomId: '!arch:matrix.test' })
    })

    it('DEFECT 1: scans more than one page of rooms (next_batch pagination), not just the first', async () => {
      getResource.mockResolvedValue(null)
      const rooms = Array.from({ length: 5 }, (_, i) => ({
        room_id: `!r${i}:matrix.test`, creator: i === 4 ? BOT : '@someone:matrix.test',
      }))
      routeMatrix(
        { '!r4:matrix.test': { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } } },
        fakeListRoomsHandler(rooms, 2), // pageSize 2 forces 3 pages for 5 rooms
      )

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'k', state: 'archiviert', roomId: '!r4:matrix.test' })
    })

    it('DEFECT 1: a room created by a NON-bot user is excluded by the creator scan before any marker is ever read, even carrying a marker that would otherwise pass the chokepoint', async () => {
      getResource.mockResolvedValue(null)
      routeMatrix(
        {
          '!legit:matrix.test': { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } },
          // Sender/create fixtures default to BOT — this marker WOULD pass
          // getRoomArchiveMarker's own chokepoint if it were ever read. It
          // must not be, because listRooms' own `creator` field already
          // excludes this room from the candidate set.
          '!nonbot:matrix.test': { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-09-09T00:00:00Z' } },
        },
        fakeListRoomsHandler([
          { room_id: '!legit:matrix.test', creator: BOT },
          { room_id: '!nonbot:matrix.test', creator: '@someone-else:matrix.test' },
        ]),
      )

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      // The newer '!nonbot' marker would win the newest-archivedAt tie-break
      // if it had been read at all.
      expect(overview.units[0]).toMatchObject({ unitId: 'k', state: 'archiviert', roomId: '!legit:matrix.test' })
    })

    it('SECURITY (verifier FIX 1): a forged archive room (non-bot marker or non-bot creator) is never reported "archiviert"', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      getResource.mockResolvedValue(null)
      routeMatrix(
        {
          '!forged1:matrix.test': { marker: { org_unit_id: 'v', tenant_id: 'default', archived_at: '2026-09-09T00:00:00Z' }, markerSender: '@mallory:matrix.test', createSender: '@mallory:matrix.test' },
          '!forged2:matrix.test': { marker: { org_unit_id: 'v', tenant_id: 'default', archived_at: '2026-09-09T00:00:00Z' }, createSender: '@mallory:matrix.test' },
        },
        // Both rooms pass the creator SCAN (listRooms reports the bot as
        // creator — the bot's own admin token created them), so this test
        // exercises the getRoomArchiveMarker chokepoint itself (sender /
        // m.room.create checks), not the scan filter.
        fakeListRoomsHandler([
          { room_id: '!forged1:matrix.test', creator: BOT },
          { room_id: '!forged2:matrix.test', creator: BOT },
        ]),
      )

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'v', name: 'Opfer' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'v', state: 'leer' })
      expect(overview.units[0].roomId).toBeUndefined()
      warnSpy.mockRestore()
    })

    it('T13c: a per-unit getResource REJECTION is reported as its own "fehler_lesen" state, logged, and never collapsed into "leer"', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      getResource
        .mockRejectedValueOnce(new Error('pool exhausted')) // unit 'g' — DB read fails
        .mockResolvedValueOnce(null) // unit 'h' — genuinely leer
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED')) // matrix unreachable, no archived search

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'g', name: 'Kaputt' }, { id: 'h', name: 'Leer' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'g', state: 'fehler_lesen' })
      expect(overview.units[1]).toMatchObject({ unitId: 'h', state: 'leer' })
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('fehler_lesen'),
        expect.objectContaining({ unitId: 'g' })
      )
      errSpy.mockRestore()
    })

    it('T13d: per-unit ledger reads run in PARALLEL, not one at a time (N+1 fix)', async () => {
      let inFlight = 0
      let maxInFlight = 0
      getResource.mockImplementation(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 0))
        inFlight -= 1
        return null
      })
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 })) // reachable, no archived rooms

      const { listOverview } = await import('./room-admin')
      await listOverview([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] as never)

      expect(maxInFlight).toBeGreaterThan(1)
    })
  })

  // The archive of the overview is a list of ROOMS. It used to keep one archived room per unit (the
  // newest): with two archived rooms of one unit, deleting the newest brought the older one up in
  // its place, so the row read "Archiviert" before and after the delete.
  describe('listOverview: archivedRooms', () => {
    const OLDER = '!older:matrix.test'
    const NEWER = '!newer:matrix.test'
    const olderFixture = { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-01-01T00:00:00Z' } }
    const newerFixture = { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } }
    // The plain state read of m.room.name answers the content only, like the homeserver does.
    const roomNames = (names: Record<string, string>) => (url: string): Response | undefined => {
      for (const [roomId, name] of Object.entries(names)) {
        if (isStateRead(url, roomId, 'm.room.name')) return new Response(JSON.stringify({ name }), { status: 200 })
      }
      return undefined
    }
    const both = (...handlers: Array<(url: string) => Response | undefined>) => (url: string) => {
      for (const handler of handlers) {
        const res = handler(url)
        if (res) return res
      }
      return undefined
    }

    it('lists every archived room of a unit, newest first, and a deleted one is gone from the list', async () => {
      getResource.mockResolvedValue(null)
      routeMatrix(
        { [OLDER]: olderFixture, [NEWER]: newerFixture },
        fakeListRoomsHandler([{ room_id: OLDER, creator: BOT }, { room_id: NEWER, creator: BOT }]),
      )
      const { listOverview } = await import('./room-admin')
      const before = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(before.archivedRooms.map((r) => r.roomId)).toEqual([NEWER, OLDER])
      expect(before.archivedRooms[0]).toMatchObject({
        unitId: 'k', unitName: 'K', archivedAt: '2026-09-01T00:00:00Z', restorable: true,
      })

      // The hard delete answers after the purge: the homeserver no longer lists the room.
      routeMatrix({ [OLDER]: olderFixture }, fakeListRoomsHandler([{ room_id: OLDER, creator: BOT }]))
      const after = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(after.archivedRooms.map((r) => r.roomId)).toEqual([OLDER])
      expect(after.units[0]).toMatchObject({ state: 'archiviert', roomId: OLDER })
    })

    it('lists an archived room of a unit that has a room again, but not as restorable', async () => {
      getResource.mockResolvedValue({ status: 'ok', external_id: '!live:matrix.test' })
      routeMatrix({ [OLDER]: olderFixture, '!live:matrix.test': {} }, fakeListRoomsHandler([
        { room_id: OLDER, creator: BOT }, { room_id: '!live:matrix.test', creator: BOT },
      ]))
      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(overview.units[0]).toMatchObject({ state: 'aktiv', roomId: '!live:matrix.test' })
      expect(overview.archivedRooms).toEqual([
        expect.objectContaining({ roomId: OLDER, unitId: 'k', restorable: false, restoreBlockedBy: 'other_room' }),
      ])
    })

    it('an unreadable ledger of the unit is reported as such, never as another room of the unit', async () => {
      getResource.mockRejectedValue(new Error('connection terminated'))
      routeMatrix({ [OLDER]: olderFixture }, fakeListRoomsHandler([{ room_id: OLDER, creator: BOT }]))
      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'k', state: 'fehler_lesen' })
      expect(overview.archivedRooms).toEqual([
        expect.objectContaining({ roomId: OLDER, unitId: 'k', restorable: false, restoreBlockedBy: 'unreadable' }),
      ])
    })

    it('does not list an archived room whose marker names a unit this customer does not have', async () => {
      getResource.mockResolvedValue(null)
      routeMatrix(
        { [OLDER]: { marker: { org_unit_id: 'gone', tenant_id: 'default', archived_at: '2026-01-01T00:00:00Z' } } },
        fakeListRoomsHandler([{ room_id: OLDER, creator: BOT }]),
      )
      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(overview.archivedRooms).toEqual([])
      expect(overview.units[0]).toMatchObject({ unitId: 'k', state: 'leer' })
    })

    it('is empty, and reads no room name, while Matrix is unreachable', async () => {
      getResource.mockResolvedValue({ status: 'ok', external_id: '!live:matrix.test' })
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'))
      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(overview.matrix).toBe('unreachable')
      expect(overview.archivedRooms).toEqual([])
      expect(overview.units[0]).toMatchObject({ state: 'aktiv', roomId: '!live:matrix.test' })
      expect(overview.units[0].roomName).toBeUndefined()
      expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes('/state/m.room.name/'))).toBe(false)
    })

    // A rename changes the room's name in Matrix, never the unit's. The overview showed the unit
    // name only, so a renamed room looked exactly as before.
    it('carries the own name of an active and of an archived room, read as room state', async () => {
      getResource
        .mockResolvedValueOnce({ status: 'ok', external_id: '!live:matrix.test' }) // unit 'a'
        .mockResolvedValueOnce(null) // unit 'k'
      routeMatrix(
        { [OLDER]: olderFixture, '!live:matrix.test': {} },
        both(
          roomNames({ '!live:matrix.test': 'Vorstand intern', [OLDER]: 'Altes Plenum' }),
          fakeListRoomsHandler([{ room_id: OLDER, creator: BOT }, { room_id: '!live:matrix.test', creator: BOT }]),
        ),
      )
      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'a', name: 'Vorstand' }, { id: 'k', name: 'Plenum' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'a', state: 'aktiv', roomName: 'Vorstand intern' })
      expect(overview.units[1]).toMatchObject({ unitId: 'k', state: 'archiviert', roomName: 'Altes Plenum' })
      expect(overview.archivedRooms[0]).toMatchObject({ roomId: OLDER, unitName: 'Plenum', roomName: 'Altes Plenum' })
      // the same request shape as every other state read of the admin bot
      const nameRead = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/state/m.room.name/'))
      expect(nameRead?.[0]).toBe(`http://matrix.test:8008/_matrix/client/v3/rooms/${encodeURIComponent('!live:matrix.test')}/state/m.room.name/`)
      expect(nameRead?.[1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer admin-token' } })
    })

    it('a failed name read leaves the name out and keeps the room in the overview', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      getResource.mockResolvedValue({ status: 'ok', external_id: '!live:matrix.test' })
      routeMatrix({ '!live:matrix.test': {} }, (url) => {
        if (isStateRead(url, '!live:matrix.test', 'm.room.name')) return new Response('{}', { status: 500 })
        return fakeListRoomsHandler([{ room_id: '!live:matrix.test', creator: BOT }])(url)
      })
      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'a', name: 'Vorstand' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'a', state: 'aktiv', roomId: '!live:matrix.test' })
      expect(overview.units[0].roomName).toBeUndefined()
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('room name could not be read'), expect.objectContaining({ roomId: '!live:matrix.test' }),
      )
      errSpy.mockRestore()
    })
  })

  describe('findArchivedRooms (via listOverview)', () => {
    it('logs a per-room marker-read rejection and does not let it hide a genuinely archived unit found elsewhere', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      getResource.mockResolvedValue(null)
      routeMatrix(
        {
          '!flaky:matrix.test': { markerError: new Error('ETIMEDOUT') }, // getRoomArchiveMarker(!flaky) rejects
          '!ok:matrix.test': { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } },
        },
        fakeListRoomsHandler([
          { room_id: '!flaky:matrix.test', creator: BOT },
          { room_id: '!ok:matrix.test', creator: BOT },
        ]),
      )

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'k', state: 'archiviert', roomId: '!ok:matrix.test' })
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('getRoomArchiveMarker failed for room'),
        expect.objectContaining({ roomId: '!flaky:matrix.test' })
      )
      errSpy.mockRestore()
    })

    it('picks the NEWEST archived room deterministically when a unit has more than one archive marker', async () => {
      getResource.mockResolvedValue(null)
      routeMatrix(
        {
          '!older:matrix.test': { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-01-01T00:00:00Z' } },
          '!newer:matrix.test': { marker: { org_unit_id: 'k', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } },
        },
        fakeListRoomsHandler([
          { room_id: '!older:matrix.test', creator: BOT },
          { room_id: '!newer:matrix.test', creator: BOT },
        ]),
      )

      const { listOverview } = await import('./room-admin')
      const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

      expect(overview.units[0]).toMatchObject({ unitId: 'k', roomId: '!newer:matrix.test' })
    })

    // LOW (TASK-009 fu1 round 2 verifier): an unconfigured admin bot user id
    // used to fall through `Boolean(bot) && room.creator === bot` silently —
    // zero candidates, empty map, no error, no log — indistinguishable from
    // "nothing is archived" in the operator-facing overview. Confirms the
    // explicit early-return + log, and that listRooms (which would otherwise
    // scan every room for nothing) is never even called.
    it('RED->GREEN: logs an error and returns none-detected (without calling listRooms) when the admin bot user id is unconfigured', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      getResource.mockResolvedValue(null)
      const { env } = await import('$env/dynamic/private')
      const originalBotId = env.SYNAPSE_ADMIN_BOT_USER_ID
      env.SYNAPSE_ADMIN_BOT_USER_ID = ''
      const { __resetMatrixCachesForTests } = await import('../matrix-client')
      __resetMatrixCachesForTests()
      let listRoomsCalled = false
      routeMatrix({}, (url) => {
        if (url.includes('/_synapse/admin/v1/rooms') && !url.includes('!') && !url.includes('limit=1')) {
          listRoomsCalled = true
        }
        return undefined
      })

      try {
        const { listOverview } = await import('./room-admin')
        const overview = await listOverview([{ id: 'k', name: 'K' }] as never)

        expect(overview.units[0]).toMatchObject({ unitId: 'k', state: 'leer' })
        expect(listRoomsCalled).toBe(false)
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringContaining('admin bot user id unconfigured')
        )
      } finally {
        env.SYNAPSE_ADMIN_BOT_USER_ID = originalBotId
        __resetMatrixCachesForTests()
        errSpy.mockRestore()
      }
    })
  })

  describe('resolveMatrixError', () => {
    it.each([
      ['getaddrinfo ENOTFOUND matrix', 'unavailable'],
      ['connect ECONNREFUSED 127.0.0.1:8008', 'unavailable'],
      ['ETIMEDOUT', 'unavailable'],
      ['The operation was aborted', 'unavailable'],
      ['Matrix GET x -> 502: Bad Gateway', 'unavailable'],
      ['Matrix GET x -> 503: Service Unavailable', 'unavailable'],
      ['Matrix GET x -> 504: Gateway Timeout', 'unavailable'],
      ['Matrix GET x -> 403: forbidden', 'upstream'],
      ['Matrix GET x -> 400: bad request', 'upstream'],
    ])('T14: %s -> %s', async (message, expected) => {
      const { resolveMatrixError } = await import('./room-admin')
      expect(resolveMatrixError(new Error(message))).toBe(expected)
    })
  })

  // TASK-009 lane B (row 15): the /messages Einstellungen panel needs an
  // active room's owning org unit (rename/archive/delete all take orgUnitId,
  // not roomId alone) — the reverse of getResource's unitId -> roomId map.
  describe('findUnitIdForRoom', () => {
    it('finds the unit whose ledger row external_id matches an ACTIVE room', async () => {
      listOrgUnits.mockResolvedValue([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
      getResource
        .mockResolvedValueOnce({ status: 'ok', external_id: '!other:matrix.test' }) // unit a
        .mockResolvedValueOnce({ status: 'ok', external_id: '!target:matrix.test' }) // unit b

      const { findUnitIdForRoom } = await import('./room-admin')
      await expect(findUnitIdForRoom('!target:matrix.test')).resolves.toBe('b')
    })

    it('falls back to the archive marker when no ledger row matches (an ARCHIVED room), when the marker names a unit that exists in this tenant', async () => {
      // 'c' must appear in listOrgUnits — findUnitIdForRoom only iterates
      // getResource per KNOWN unit above, so the loop never actually reads
      // its ledger row when it isn't there, but the fallback below now
      // checks it against this same list before trusting it.
      listOrgUnits.mockResolvedValue([{ id: 'a', name: 'A' }, { id: 'c', name: 'C' }])
      getResource
        .mockResolvedValueOnce(null) // unit a
        .mockResolvedValueOnce(null) // unit c
      routeMatrix({ '!archived:matrix.test': { marker: { org_unit_id: 'c', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } } })

      const { findUnitIdForRoom } = await import('./room-admin')
      await expect(findUnitIdForRoom('!archived:matrix.test')).resolves.toBe('c')
    })

    it('returns null when nothing matches (unknown/foreign room)', async () => {
      listOrgUnits.mockResolvedValue([{ id: 'a', name: 'A' }])
      getResource.mockResolvedValueOnce(null)
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }))

      const { findUnitIdForRoom } = await import('./room-admin')
      await expect(findUnitIdForRoom('!nope:matrix.test')).resolves.toBeNull()
    })

    it('LOW fix (house review, TASK-009 fix round 2): does NOT trust an archive marker naming a unit id absent from this tenant\'s own org units', async () => {
      // The marker is Matrix room state, forgeable/stale — 'z' matches no
      // known org unit (a cross-tenant probe, or a unit deleted since the
      // room was archived). Before the fix this returned 'z' verbatim,
      // pointing the Einstellungen panel's rename/archive/delete calls at
      // an org unit id that does not exist in this tenant's own DB.
      listOrgUnits.mockResolvedValue([{ id: 'a', name: 'A' }])
      getResource.mockResolvedValueOnce(null) // unit a
      routeMatrix({ '!spoofed:matrix.test': { marker: { org_unit_id: 'z', tenant_id: 'default', archived_at: '2026-09-01T00:00:00Z' } } })

      const { findUnitIdForRoom } = await import('./room-admin')
      await expect(findUnitIdForRoom('!spoofed:matrix.test')).resolves.toBeNull()
    })

    it('SECURITY (verifier FIX 1): a marker sent by a non-bot user naming a REAL unit resolves to null', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      listOrgUnits.mockResolvedValue([{ id: 'a', name: 'A' }])
      getResource.mockResolvedValueOnce(null)
      routeMatrix({
        '!evil:matrix.test': { marker: { org_unit_id: 'a', tenant_id: 'default' }, markerSender: '@mallory:matrix.test', createSender: '@mallory:matrix.test' },
      })

      const { findUnitIdForRoom } = await import('./room-admin')
      await expect(findUnitIdForRoom('!evil:matrix.test')).resolves.toBeNull()
      warnSpy.mockRestore()
    })
  })
})
