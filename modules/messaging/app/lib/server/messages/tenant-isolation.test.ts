/**
 * Cross-customer isolation of the messaging module, on the code path the pilot
 * runs (isolation:tenant, kind `fake-upstream-app`).
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. The pilot runs messaging in-process
 * (MESSAGES_BACKEND unset) against ONE shared Synapse. The real routes, the real
 * Matrix client, the real Synapse admin client and the real room administration
 * run under a REAL tenant context (runWithTenant); only the upstream is a
 * recording fake that enforces what Synapse enforces (a user token reads and
 * writes only the rooms its user joined, an admin token is that server's own).
 * The app-layer promises under test are:
 *
 *   1. a Matrix token minted for a user of customer A is never served to
 *      customer B, even for the same Keycloak subject (token cache keyed by
 *      tenant), and evicting one tenant leaves the other's tokens alone;
 *   2. every upstream request caused by A carries A's own tokens: with a
 *      homeserver per tenant (registry services) it only reaches A's homeserver
 *      and never B's admin or user token, with the shared homeserver the user
 *      tokens stay A's;
 *   3. B's rooms are not listed, not readable and not writable as A, and a room
 *      administration action on B's room is refused before any Matrix write,
 *      because the room is looked up in A's own ledger. Alias lookup is checked
 *      with a homeserver per tenant only; room aliases on ONE shared homeserver
 *      are outside what this file shows.
 *
 * It shows app-layer scoping against ONE shared Synapse. It does NOT show that a
 * second customer can be added to a running installation, and it does not
 * exercise Synapse itself (docs/ops/isolation-evidence.md says so; a live
 * two-customer probe is owed). Not attacked here: the SSE sync route (same
 * token path as the others), the video and LiveKit routes
 * (livekit.tenant.test.ts covers the room namespace).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

// ---- environment seams (the same shape as matrix-synapse.tenant.test.ts) ------

const ENV = vi.hoisted(
  () =>
    ({
      MATRIX_URL: 'http://synapse.test:8008',
      SYNAPSE_ADMIN_TOKEN: 'admin-shared',
      SYNAPSE_ADMIN_BOT_USER_ID: '@bot:synapse.test',
      SYNAPSE_SERVER_NAME: 'synapse.test',
      TOKEN_ADMIN_A: 'admin-of-a',
      TOKEN_ADMIN_B: 'admin-of-b',
      MEDIA_SIGNING_SECRET: 'unit-media-secret',
    }) as Record<string, string | undefined>,
)
vi.mock('$env/dynamic/private', () => ({ env: ENV }))
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: (name: string) => ENV[name] }))

// ---- the per-tenant ledger of the room administration (the tenant's own database) ----

const LEDGER = vi.hoisted(() => ({
  /** tenant id -> org unit id -> Matrix room id */
  rooms: new Map<string, Map<string, string>>(),
  currentTenant: (): string => '',
  audit: [] as string[],
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({
  getResource: async (unitId: string) => {
    const roomId = LEDGER.rooms.get(LEDGER.currentTenant())?.get(unitId)
    return roomId ? { status: 'ok', external_id: roomId } : null
  },
  enqueueResources: vi.fn(),
  markResourceOk: vi.fn(),
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: async (unitId: string) => (LEDGER.rooms.get(LEDGER.currentTenant())?.has(unitId) ? { id: unitId, name: `Gremium ${unitId}` } : null),
  listOrgUnits: async () => [...(LEDGER.rooms.get(LEDGER.currentTenant())?.keys() ?? [])].map((id) => ({ id, name: `Gremium ${id}` })),
  setSubsystemWanted: vi.fn(),
}))
vi.mock('$lib/server/governance/provisioning/mutex', () => ({ withUnitLock: async (_id: string, fn: () => unknown) => fn() }))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  attachSubsystem: vi.fn(),
  releaseSubsystem: async (unitId: string, _kind: string, teardown: (externalId: string | null) => Promise<void>) => {
    const roomId = LEDGER.rooms.get(LEDGER.currentTenant())?.get(unitId) ?? null
    await teardown(roomId)
    LEDGER.rooms.get(LEDGER.currentTenant())?.delete(unitId)
    return roomId
  },
}))
vi.mock('$lib/server/db', () => ({ getDb: () => ({ begin: vi.fn() }) }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: async (e: { newValue: string }) => void LEDGER.audit.push(e.newValue) }))

import { GET as roomsGet } from '../../../routes/api/messages/rooms/+server'
import { GET as messagesGet, POST as messagesPost } from '../../../routes/api/messages/rooms/[roomId]/messages/+server'
import { POST as readPost } from '../../../routes/api/messages/rooms/[roomId]/read/+server'
import { PUT as typingPut } from '../../../routes/api/messages/rooms/[roomId]/typing/+server'
import { POST as mediaPost } from '../../../routes/api/messages/rooms/[roomId]/media/+server'
import { PATCH as roomPatch, DELETE as roomDelete } from '../../../routes/api/messages/rooms/[roomId]/+server'
import { POST as roomArchive } from '../../../routes/api/messages/rooms/[roomId]/archive/+server'
import { GET as roomUnit } from '../../../routes/api/messages/rooms/[roomId]/unit/+server'
import { getMessagesBackend } from './backend'
import { __resetMatrixCachesForTests, evictMatrixClient, getMatrixClient } from './matrix-client'
import { __resetSynapseAdminForTests, getSynapseAdmin } from './synapse-admin'

// ---- two customers ---------------------------------------------------------------

const ctx = (id: string, services?: Record<string, string>): TenantContext => ({ id, slug: id, ...(services ? { services } : {}) }) as unknown as TenantContext
/** The pilot's shape: no per-tenant homeserver, the deployment's one Synapse. */
const A_SHARED = ctx('tid-a')
const B_SHARED = ctx('tid-b')
/** Registry-provisioned tenants: a homeserver, an admin token and a bot of their own. */
const A_OWN = ctx('tid-a', { matrixUrl: 'http://synapse-a.test:8008', synapseAdminTokenRef: 'env:TOKEN_ADMIN_A', synapseAdminBotUserId: '@bot:a.test', synapseServerName: 'a.test' })
const B_OWN = ctx('tid-b', { matrixUrl: 'http://synapse-b.test:8008', synapseAdminTokenRef: 'env:TOKEN_ADMIN_B', synapseAdminBotUserId: '@bot:b.test', synapseServerName: 'b.test' })
LEDGER.currentTenant = () => current?.id ?? ''
let current: { id: string } | null = null
const as = <T>(t: TenantContext, fn: () => T): T => {
  current = t
  return runWithTenant(t, fn)
}

const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`
const user = (id: string, roles: Role[] = [Role.Member]): SessionUser => ({ id, email: '', name: id, roles, groups: [], loa: 0, authTime: 0 }) as SessionUser

// ---- the recording fake Synapse(s) ---------------------------------------------------

interface Rec {
  host: string
  method: string
  path: string
  token: string | null
  kind: 'admin' | 'user' | 'none' | 'unknown'
}
interface Room {
  name: string
  members: Set<string>
  messages: { sender: string; body: string }[]
  aliases: Set<string>
  state: Map<string, { sender: string; content: unknown }>
  deleted: boolean
}

class FakeSynapse {
  readonly rooms = new Map<string, Room>()
  readonly tokens = new Map<string, string>()
  logins = 0
  constructor(
    readonly host: string,
    readonly adminToken: string,
    readonly serverName: string,
    readonly bot: string,
  ) {}
  room(id: string, name: string, members: string[], alias?: string): void {
    this.rooms.set(id, {
      name,
      members: new Set(members),
      messages: [{ sender: members[0]!, body: `canary-${id}` }],
      aliases: new Set(alias ? [alias] : []),
      state: new Map([['m.room.create', { sender: this.bot, content: {} }]]),
      deleted: false,
    })
  }
}

class FakeSynapses {
  readonly servers = new Map<string, FakeSynapse>()
  readonly requests: Rec[] = []
  add(s: FakeSynapse): FakeSynapse {
    this.servers.set(s.host, s)
    return s
  }
  mark(): number {
    return this.requests.length
  }
  since(mark: number): Rec[] {
    return this.requests.slice(mark)
  }

  async handle(input: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(input)
    const server = this.servers.get(u.host)
    const method = String(init.method ?? 'GET')
    const path = decodeURIComponent(u.pathname)
    const h = new Headers(init.headers as HeadersInit)
    const auth = h.get('Authorization')
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null
    if (!server) {
      this.requests.push({ host: u.host, method, path, token, kind: 'unknown' })
      return Response.json({ errcode: 'M_UNREACHABLE', error: `no such homeserver ${u.host}` }, { status: 502 })
    }
    const userId = token ? server.tokens.get(token) : undefined
    const kind: Rec['kind'] = token === null ? 'none' : token === server.adminToken ? 'admin' : userId ? 'user' : 'unknown'
    this.requests.push({ host: u.host, method, path, token, kind })
    const json = (status: number, body: unknown = {}) => Response.json(body, { status })
    const body = init.body ? ((): Record<string, unknown> => { try { return JSON.parse(typeof init.body === 'string' ? init.body : '') as Record<string, unknown> } catch { return {} } })() : {}

    if (method === 'POST' && path === '/_matrix/client/v3/login') {
      const sub = (JSON.parse(Buffer.from(String(body.token).split('.')[1]!, 'base64url').toString()) as { sub: string }).sub
      const uid = `@${sub}:${server.serverName}`
      const access = `mx-${server.host}-${++server.logins}`
      server.tokens.set(access, uid)
      return json(200, { access_token: access, user_id: uid })
    }
    if (kind === 'unknown' || kind === 'none') return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'unknown token' })

    let m: RegExpExecArray | null
    if (path === '/_matrix/client/v3/account/whoami') return kind === 'user' ? json(200, { user_id: userId }) : json(403)
    if (path === '/_matrix/client/v3/joined_rooms' && kind === 'user') {
      return json(200, { joined_rooms: [...server.rooms].filter(([, r]) => !r.deleted && r.members.has(userId!)).map(([id]) => id) })
    }
    if (path.startsWith('/_matrix/client/v3/notifications')) return json(200, { notifications: [] })
    if ((m = /^\/_matrix\/client\/v3\/directory\/room\/(.+)$/.exec(path))) {
      if (kind !== 'admin') return json(403)
      const alias = m[1]!
      if (method === 'GET') {
        const hit = [...server.rooms].find(([, r]) => r.aliases.has(alias))
        return hit ? json(200, { room_id: hit[0] }) : json(404, { errcode: 'M_NOT_FOUND' })
      }
      if (method === 'PUT') {
        const r = server.rooms.get(String(body.room_id))
        if (!r) return json(404)
        r.aliases.add(alias)
        return json(200)
      }
      if (method === 'DELETE') {
        for (const r of server.rooms.values()) r.aliases.delete(alias)
        return json(200)
      }
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(.+)$/.exec(path))) {
      const room = server.rooms.get(m[1]!)
      const rest = m[2]!
      if (!room || room.deleted) return json(404, { errcode: 'M_NOT_FOUND' })
      const mayRead = kind === 'admin' || room.members.has(userId!)
      if (!mayRead) return json(403, { errcode: 'M_FORBIDDEN', error: 'not in the room' })
      if (rest === 'messages' && method === 'GET') {
        return json(200, { chunk: room.messages.map((x, i) => ({ event_id: `$e${i}`, sender: x.sender, type: 'm.room.message', content: { body: x.body, msgtype: 'm.text' }, origin_server_ts: 1 })), end: 'e' })
      }
      if ((m = /^send\/m\.room\.message\/.+$/.exec(rest)) && method === 'PUT') {
        room.messages.push({ sender: userId ?? server.bot, body: String(body.body) })
        return json(200, { event_id: '$new' })
      }
      if (rest === 'read_markers' && method === 'POST') return json(200)
      if (rest.startsWith('typing/') && method === 'PUT') return json(200)
      if (rest === 'state/m.room.name' && method === 'GET') return json(200, { name: room.name })
      if (rest.startsWith('state/') && method === 'GET') {
        const ev = room.state.get(decodeURIComponent(rest.slice('state/'.length)).split('/')[0]!)
        return ev ? json(200, u.searchParams.get('format') === 'event' ? { sender: ev.sender, content: ev.content } : ev.content) : json(404, { errcode: 'M_NOT_FOUND' })
      }
      if (rest.startsWith('state/') && method === 'PUT' && kind === 'admin') {
        const [type] = decodeURIComponent(rest.slice('state/'.length)).split('/')
        room.state.set(type!, { sender: server.bot, content: body })
        if (type === 'm.room.name') room.name = String(body.name)
        return json(200, { event_id: '$state' })
      }
    }
    if ((m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/members$/.exec(path)) && method === 'GET') {
      if (kind !== 'admin') return json(403)
      const room = server.rooms.get(m[1]!)
      return room ? json(200, { members: [...room.members], total: room.members.size }) : json(404)
    }
    if ((m = /^\/_synapse\/admin\/v2\/rooms\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      if (kind !== 'admin') return json(403)
      const room = server.rooms.get(m[1]!)
      if (room) room.deleted = true
      return json(200, { delete_id: 'd' })
    }
    if (path === '/_matrix/media/v3/upload' && method === 'POST') return kind === 'user' ? json(200, { content_uri: 'mxc://synapse.test/m1' }) : json(403)
    return json(404, { errcode: 'M_UNRECOGNIZED', error: `the fake does not implement ${method} ${path}` })
  }
}

let net: FakeSynapses
let sharedSynapse: FakeSynapse
let synapseA: FakeSynapse
let synapseB: FakeSynapse

/** The pilot's shape: ONE Synapse; A's room and B's room both live on it. */
function shared(): void {
  net = new FakeSynapses()
  sharedSynapse = net.add(new FakeSynapse('synapse.test:8008', 'admin-shared', 'synapse.test', '@bot:synapse.test'))
  sharedSynapse.room('!room-a:synapse.test', 'Vorstand A', ['@alice:synapse.test'], '#stura-vorstand-a:synapse.test')
  sharedSynapse.room('!room-b:synapse.test', 'Vorstand B', ['@bob:synapse.test'], '#stura-vorstand-b:synapse.test')
  LEDGER.rooms.set('tid-a', new Map([['unit-a', '!room-a:synapse.test']]))
  LEDGER.rooms.set('tid-b', new Map([['unit-b', '!room-b:synapse.test']]))
}

/** Registry-provisioned tenants: a homeserver each. */
function separate(): void {
  net = new FakeSynapses()
  synapseA = net.add(new FakeSynapse('synapse-a.test:8008', 'admin-of-a', 'a.test', '@bot:a.test'))
  synapseB = net.add(new FakeSynapse('synapse-b.test:8008', 'admin-of-b', 'b.test', '@bot:b.test'))
  synapseA.room('!room-a:a.test', 'Vorstand A', ['@alice:a.test'], '#stura-vorstand:a.test')
  synapseB.room('!room-b:b.test', 'Vorstand B', ['@bob:b.test'], '#stura-vorstand:b.test')
}

beforeEach(() => {
  delete process.env.MESSAGES_BACKEND
  process.env.AUTH_SECRET = 'unit-auth-secret' // signs the media proxy urls
  __resetMatrixCachesForTests()
  __resetSynapseAdminForTests()
  LEDGER.rooms.clear()
  LEDGER.audit.length = 0
  current = null
  shared()
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => net.handle(String(input), init)))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---- request builders ---------------------------------------------------------------

function ev(tenant: TenantContext, who: SessionUser, sub: string, p: { roomId?: string; method?: string; body?: BodyInit | null; query?: string; headers?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/messages/rooms${p.roomId ? `/${p.roomId}` : ''}${p.query ?? ''}`)
  return {
    params: { roomId: p.roomId },
    locals: { user: who, auth: async () => ({ user: who, accessToken: jwt(sub) }) },
    url,
    request: new Request(url, { method: p.method ?? 'GET', headers: { Authorization: `Bearer ${jwt(sub)}`, ...p.headers }, ...(p.body !== undefined && p.body !== null ? { body: p.body } : {}) }),
    _tenant: tenant,
  } as never
}
/** A multipart upload as the media route reads it (the route test stubs formData the same way). */
function upload(roomId: string) {
  const fd = new FormData()
  fd.set('file', new File(['x'], 'a.png', { type: 'image/png' }))
  const base = ev(A_SHARED, ALICE, 'alice', { roomId, method: 'POST' }) as { request: unknown }
  base.request = { headers: new Headers({ Authorization: `Bearer ${jwt('alice')}`, 'Content-Type': 'multipart/form-data; boundary=x' }), formData: async () => fd }
  return base as never
}
type Handler = (e: never) => unknown
/** Runs a route handler inside the tenant's context, as the request pipeline does. */
const route = (tenant: TenantContext, h: Handler, e: never) => as(tenant, () => Promise.resolve(h(e)))

const ALICE = user('alice')
const BOB = user('bob')
const ADMIN_A = user('admin-a', [Role.CouncilAdmin, Role.ITAdmin])
const ROOM_A = '!room-a:synapse.test'
const ROOM_B = '!room-b:synapse.test'

/** Every request carries a token its own homeserver issued or holds (the login itself carries none). */
function noUnknownTokens(reqs: Rec[]): void {
  expect(reqs.filter((r) => r.kind === 'unknown' || (r.kind === 'none' && !r.path.endsWith('/login')))).toEqual([])
}

// ================================================================================
// 0. the backend the pilot runs
// ================================================================================

describe('the code path under test is the one the pilot runs', () => {
  it('MESSAGES_BACKEND unset resolves to the in-process client, whose clients are the per-tenant keyed ones', () => {
    expect(getMessagesBackend().kind).toBe('inprocess')
    const a = as(A_SHARED, () => getMessagesBackend().matrix())
    const b = as(B_SHARED, () => getMessagesBackend().matrix())
    expect(a).toBe(as(A_SHARED, () => getMatrixClient()))
    expect(a).not.toBe(b)
    expect(as(A_SHARED, () => getSynapseAdmin())).not.toBe(as(B_SHARED, () => getSynapseAdmin()))
  })

  it('there is no ambient tenant: a Matrix or Synapse client outside runWithTenant throws', () => {
    expect(() => getMatrixClient()).toThrow(/No tenant context/)
    expect(() => getSynapseAdmin()).toThrow(/No tenant context/)
  })
})

// ================================================================================
// 1. positive controls
// ================================================================================

describe('positive controls: each customer reaches its own rooms through the real routes', () => {
  it('A lists, reads and writes its own room; B its own', async () => {
    const m = net.mark()
    const list = (await route(A_SHARED, roomsGet, ev(A_SHARED, ALICE, 'alice'))) as Response
    const rooms = ((await list.json()) as { data: { roomId: string; name: string }[] }).data
    expect(rooms).toEqual([expect.objectContaining({ roomId: ROOM_A, name: 'Vorstand A' })])

    const read = (await route(A_SHARED, messagesGet, ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_A }))) as Response
    expect(JSON.stringify(await read.json())).toContain('canary-!room-a')
    const sent = (await route(A_SHARED, messagesPost, ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_A, method: 'POST', body: JSON.stringify({ body: 'hello from a' }), headers: { 'Content-Type': 'application/json' } }))) as Response
    expect(sent.status).toBeLessThan(300)
    expect(sharedSynapse.rooms.get(ROOM_A)!.messages.at(-1)).toEqual({ sender: '@alice:synapse.test', body: 'hello from a' })

    const bRead = (await route(B_SHARED, messagesGet, ev(B_SHARED, BOB, 'bob', { roomId: ROOM_B }))) as Response
    expect(JSON.stringify(await bRead.json())).toContain('canary-!room-b')
    noUnknownTokens(net.since(m))
  })

  it("A renames its own room through the admin route: the ledger of A names the room, the admin write goes out", async () => {
    const res = (await route(ADMIN_TENANT, roomPatch, ev(ADMIN_TENANT, ADMIN_A, 'admin-a', { roomId: ROOM_A, method: 'PATCH', body: JSON.stringify({ orgUnitId: 'unit-a', name: 'Vorstand neu' }), headers: { 'Content-Type': 'application/json' } }))) as Response
    expect(res.status).toBe(200)
    expect(sharedSynapse.rooms.get(ROOM_A)!.name).toBe('Vorstand neu')
  })
})
const ADMIN_TENANT = A_SHARED

// ================================================================================
// 2. tokens
// ================================================================================

describe('no Matrix token crosses customers', () => {
  it('the same Keycloak subject in A and in B gets two logins and two different Matrix tokens; each is cached per tenant', async () => {
    const same = jwt('same-sub')
    const a1 = await as(A_SHARED, () => getMatrixClient().getMatrixToken(same))
    const b1 = await as(B_SHARED, () => getMatrixClient().getMatrixToken(same))
    expect(sharedSynapse.logins).toBe(2)
    expect(a1).not.toBe(b1)
    expect(await as(A_SHARED, () => getMatrixClient().getMatrixToken(same))).toBe(a1)
    expect(await as(B_SHARED, () => getMatrixClient().getMatrixToken(same))).toBe(b1)
    expect(sharedSynapse.logins).toBe(2)
  })

  it('two logins of the same subject started at the same time in A and B do not share an in-flight login', async () => {
    const same = jwt('same-sub')
    const [a, b] = await Promise.all([as(A_SHARED, () => getMatrixClient().getMatrixToken(same)), as(B_SHARED, () => getMatrixClient().getMatrixToken(same))])
    expect(a).not.toBe(b)
    expect(sharedSynapse.logins).toBe(2)
  })

  it('the device id is part of the key too, and never turns one tenant\'s token into the other\'s', async () => {
    const same = jwt('same-sub')
    const a = await as(A_SHARED, () => getMatrixClient().getMatrixToken(same, 'dev-1'))
    const b = await as(B_SHARED, () => getMatrixClient().getMatrixToken(same, 'dev-1'))
    expect(a).not.toBe(b)
  })

  it('evicting tenant A drops A\'s tokens and leaves B\'s alone', async () => {
    const same = jwt('same-sub')
    const a1 = await as(A_SHARED, () => getMatrixClient().getMatrixToken(same))
    const b1 = await as(B_SHARED, () => getMatrixClient().getMatrixToken(same))
    evictMatrixClient('tid-a')
    expect(await as(B_SHARED, () => getMatrixClient().getMatrixToken(same))).toBe(b1)
    const a2 = await as(A_SHARED, () => getMatrixClient().getMatrixToken(same))
    expect(a2).not.toBe(a1)
    expect(sharedSynapse.logins).toBe(3)
  })

  it('with a homeserver per tenant, every request A causes reaches A\'s homeserver with A\'s tokens, and B\'s never carries A\'s', async () => {
    separate()
    const m = net.mark()
    const sa = await as(A_OWN, () => getMatrixClient().getMatrixToken(jwt('alice')))
    const sb = await as(B_OWN, () => getMatrixClient().getMatrixToken(jwt('bob')))
    await as(A_OWN, () => getMatrixClient().getJoinedRooms(sa))
    await as(A_OWN, () => getMatrixClient().getRoomIdByAlias('#stura-vorstand:a.test'))
    await as(B_OWN, () => getMatrixClient().getJoinedRooms(sb))
    await as(B_OWN, () => getMatrixClient().getRoomIdByAlias('#stura-vorstand:b.test'))
    await as(A_OWN, () => getSynapseAdmin().isRoomMember('!room-a:a.test', '@alice:a.test'))
    await as(B_OWN, () => getSynapseAdmin().isRoomMember('!room-b:b.test', '@bob:b.test'))
    const reqs = net.since(m)
    noUnknownTokens(reqs)
    // the login carries no token; everything else carries the host's own admin token or a token it issued
    const ownTokens = (host: string): Array<string | null> => (host === 'synapse-a.test:8008' ? [null, 'admin-of-a', sa] : host === 'synapse-b.test:8008' ? [null, 'admin-of-b', sb] : [])
    expect(reqs.filter((r) => !ownTokens(r.host).includes(r.token))).toEqual([])
    expect(reqs.some((r) => r.host === 'synapse-a.test:8008')).toBe(true)
    expect(reqs.some((r) => r.host === 'synapse-b.test:8008')).toBe(true)
  })
})

// ================================================================================
// 3. attacks, as A, against B's rooms (the pilot's shape: one shared Synapse)
// ================================================================================

describe("B's rooms are not listed, readable or writable as A", () => {
  it("the room list of A has none of B's rooms or names", async () => {
    const res = (await route(A_SHARED, roomsGet, ev(A_SHARED, ALICE, 'alice'))) as Response
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain(ROOM_B)
    expect(text).not.toContain('Vorstand B')
  })

  it("reading B's room is refused by the membership check, and no message read for B's room leaves", async () => {
    const m = net.mark()
    await expect(route(A_SHARED, messagesGet, ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_B }))).rejects.toMatchObject({ status: 403 })
    expect(net.since(m).some((r) => r.path.includes(ROOM_B) && r.path.endsWith('/messages'))).toBe(false)
  })

  it("writing to B's room as A does not land: Synapse refuses A's token, nothing is stored, no other token is used", async () => {
    const m = net.mark()
    const before = sharedSynapse.rooms.get(ROOM_B)!.messages.length
    await expect(route(A_SHARED, messagesPost, ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_B, method: 'POST', body: JSON.stringify({ body: 'planted' }), headers: { 'Content-Type': 'application/json' } }))).rejects.toBeTruthy()
    expect(sharedSynapse.rooms.get(ROOM_B)!.messages).toHaveLength(before)
    const sends = net.since(m).filter((r) => r.method === 'PUT' && r.path.includes(ROOM_B))
    expect(sends.length).toBeGreaterThan(0)
    expect(sends.every((r) => r.kind === 'user' && sharedSynapse.tokens.get(r.token!) === '@alice:synapse.test')).toBe(true)
  })

  it("read markers and typing in B's room as A change nothing and carry only A's token", async () => {
    const m = net.mark()
    await expect(route(A_SHARED, readPost, ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_B, method: 'POST', body: JSON.stringify({ eventId: '$e0' }), headers: { 'Content-Type': 'application/json' } }))).rejects.toBeTruthy()
    await expect(route(A_SHARED, typingPut, ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_B, method: 'PUT', body: JSON.stringify({ typing: true }), headers: { 'Content-Type': 'application/json' } }))).rejects.toBeTruthy()
    const touching = net.since(m).filter((r) => r.path.includes(ROOM_B) && r.method !== 'GET')
    expect(touching.length).toBeGreaterThan(0)
    expect(touching.every((r) => r.kind === 'user' && sharedSynapse.tokens.get(r.token!) === '@alice:synapse.test')).toBe(true)
  })

  it("uploading media into B's room is refused by the membership check before any upload leaves", async () => {
    const m = net.mark()
    await expect(route(A_SHARED, mediaPost, upload(ROOM_B))).rejects.toMatchObject({ status: 403 })
    expect(net.since(m).some((r) => r.path.includes('/media/v3/upload'))).toBe(false)
    const ok = (await route(A_SHARED, mediaPost, upload(ROOM_A))) as Response
    expect(ok.status).toBe(200)
  })

  it('a request with no session user is refused before any Matrix request', async () => {
    const m = net.mark()
    const e = ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_A })
    ;(e as { locals: { user?: unknown } }).locals.user = undefined
    await expect(route(A_SHARED, messagesGet, e)).rejects.toMatchObject({ status: 401 })
    expect(net.since(m)).toEqual([])
  })
})

describe("B's rooms and aliases are not addressable as A (homeserver per tenant)", () => {
  it('with a homeserver per tenant, B\'s alias does not resolve through A\'s client and A\'s alias does not through B\'s', async () => {
    separate()
    expect(await as(A_OWN, () => getMatrixClient().getRoomIdByAlias('#stura-vorstand:b.test'))).toBeNull()
    expect(await as(A_OWN, () => getMatrixClient().getRoomIdByAlias('#stura-vorstand:a.test'))).toBe('!room-a:a.test')
    expect(await as(B_OWN, () => getMatrixClient().getRoomIdByAlias('#stura-vorstand:a.test'))).toBeNull()
    expect(await as(B_OWN, () => getMatrixClient().getRoomIdByAlias('#stura-vorstand:b.test'))).toBe('!room-b:b.test')
  })

  it("with a homeserver per tenant, A's room list never contains B's rooms and A's admin client does not see B's members", async () => {
    separate()
    const sa = await as(A_OWN, () => getMatrixClient().getMatrixToken(jwt('alice')))
    expect(await as(A_OWN, () => getMatrixClient().getJoinedRooms(sa))).toEqual(['!room-a:a.test'])
    await expect(as(A_OWN, () => getSynapseAdmin().getRoomMembers('!room-b:b.test'))).rejects.toMatchObject({ status: 404 })
    expect(await as(A_OWN, () => getSynapseAdmin().isRoomMember('!room-b:b.test', '@bob:b.test'))).toBe(false)
  })

  it('the same alias localpart in both customers addresses each customer\'s own room when each has its own homeserver', async () => {
    separate()
    const a = await as(A_OWN, () => getMatrixClient().getRoomIdByAlias('#stura-vorstand:a.test'))
    const b = await as(B_OWN, () => getMatrixClient().getRoomIdByAlias('#stura-vorstand:b.test'))
    expect(a).toBe('!room-a:a.test')
    expect(b).toBe('!room-b:b.test')
  })
})

describe("an administration action on B's room as A is refused before any Matrix write", () => {
  const writes = (reqs: Rec[]) => reqs.filter((r) => r.method !== 'GET' && !r.path.endsWith('/login'))
  const json = { 'Content-Type': 'application/json' }

  it("rename: B's room with A's unit, and with B's unit id, is a 404 and writes nothing", async () => {
    const m = net.mark()
    for (const orgUnitId of ['unit-a', 'unit-b']) {
      const res = (await route(A_SHARED, roomPatch, ev(A_SHARED, ADMIN_A, 'admin-a', { roomId: ROOM_B, method: 'PATCH', body: JSON.stringify({ orgUnitId, name: 'hijacked' }), headers: json }))) as Response
      expect(res.status).toBe(404)
    }
    expect(writes(net.since(m))).toEqual([])
    expect(sharedSynapse.rooms.get(ROOM_B)!.name).toBe('Vorstand B')
  })

  it("archive: B's room as A is a 404 and writes nothing", async () => {
    const m = net.mark()
    for (const orgUnitId of ['unit-a', 'unit-b']) {
      const res = (await route(A_SHARED, roomArchive, ev(A_SHARED, ADMIN_A, 'admin-a', { roomId: ROOM_B, method: 'POST', body: JSON.stringify({ orgUnitId }), headers: json }))) as Response
      expect(res.status).toBe(404)
    }
    expect(writes(net.since(m))).toEqual([])
  })

  it("delete: B's room as A is a 404, B's room is not deleted, no delete request leaves", async () => {
    const m = net.mark()
    for (const orgUnitId of ['unit-a', 'unit-b']) {
      const res = (await route(A_SHARED, roomDelete, ev(A_SHARED, ADMIN_A, 'admin-a', { roomId: ROOM_B, method: 'DELETE', query: `?orgUnitId=${orgUnitId}` }))) as Response
      expect(res.status).toBe(404)
    }
    expect(net.since(m).some((r) => r.method === 'DELETE')).toBe(false)
    expect(sharedSynapse.rooms.get(ROOM_B)!.deleted).toBe(false)
    expect(LEDGER.rooms.get('tid-b')!.get('unit-b')).toBe(ROOM_B)
  })

  it("unit lookup: B's room does not resolve to a unit in A's tenant", async () => {
    const res = (await route(A_SHARED, roomUnit, ev(A_SHARED, ADMIN_A, 'admin-a', { roomId: ROOM_B }))) as Response
    expect(res.status).toBe(404)
    const own = (await route(A_SHARED, roomUnit, ev(A_SHARED, ADMIN_A, 'admin-a', { roomId: ROOM_A }))) as Response
    expect(((await own.json()) as { data: { orgUnitId: string } }).data.orgUnitId).toBe('unit-a')
  })

  it('a member without the admin role is refused before the ledger or Matrix is touched', async () => {
    const m = net.mark()
    for (const [h, method, query] of [[roomPatch, 'PATCH', ''], [roomArchive, 'POST', ''], [roomDelete, 'DELETE', '?orgUnitId=unit-a']] as const) {
      const res = (await route(A_SHARED, h as Handler, ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_A, method, query, body: method === 'DELETE' ? null : JSON.stringify({ orgUnitId: 'unit-a', name: 'x' }), headers: json }))) as Response
      expect(res.status).toBe(403)
    }
    expect(net.since(m)).toEqual([])
  })
})
