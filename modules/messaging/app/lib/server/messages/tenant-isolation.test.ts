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
 * With MATRIX_IDENTITY=namespaced (the last part of this file) the same fake also keeps ONE global
 * user directory and ONE global alias directory, and answers the admin login, the account, room
 * creation, deactivation and login-flow requests the namespaced identity makes.
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
// The namespaced tokens below are unsigned stand-ins (`h.<claims>.s`): the verifier accepts exactly that
// shape and hands back its claims. The real verifier's refusals are pinned in matrix-identity.verify.test.ts.
vi.mock('$lib/server/jwt-verify', () => ({
  verifyBearerJwt: async (token: string) => {
    const [, body, sig] = token.split('.')
    return sig === 's' && body ? (JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Record<string, unknown>) : null
  },
}))
/** The Keycloak account of the erased subject, by tenant: `username` is what the hook derives the Matrix id from. */
const KC = vi.hoisted(() => ({ username: 'alice' }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: () => ({ getUser: async () => ({ username: KC.username }), listUsers: async () => [] }),
}))

// ---- the per-tenant ledger of the room administration (the tenant's own database) ----

const LEDGER = vi.hoisted(() => ({
  /** tenant id -> org unit id -> Matrix room id */
  rooms: new Map<string, Map<string, string>>(),
  currentTenant: (): string => '',
  audit: [] as string[],
  /** 'tenant|field|new value' of the audit entries a customer's OWN trail holds (read by auditEntryExists). */
  ownAudit: new Set<string>(),
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
vi.mock('$lib/server/audit-db', () => ({
  writeAuditEntry: async (e: { newValue: string }) => void LEDGER.audit.push(e.newValue),
  auditEntryExists: async (field: string, value: string) => LEDGER.ownAudit.has(`${LEDGER.currentTenant()}|${field}|${value}`),
}))

import { GET as roomsGet } from '../../../routes/api/messages/rooms/+server'
import { GET as syncGet } from '../../../routes/api/messages/sync/+server'
import { GET as messagesGet, POST as messagesPost } from '../../../routes/api/messages/rooms/[roomId]/messages/+server'
import { POST as readPost } from '../../../routes/api/messages/rooms/[roomId]/read/+server'
import { PUT as typingPut } from '../../../routes/api/messages/rooms/[roomId]/typing/+server'
import { POST as mediaPost } from '../../../routes/api/messages/rooms/[roomId]/media/+server'
import { PATCH as roomPatch, DELETE as roomDelete } from '../../../routes/api/messages/rooms/[roomId]/+server'
import { POST as roomArchive } from '../../../routes/api/messages/rooms/[roomId]/archive/+server'
import { POST as roomUnarchive } from '../../../routes/api/messages/rooms/[roomId]/unarchive/+server'
import { GET as roomUnit } from '../../../routes/api/messages/rooms/[roomId]/unit/+server'
import { getMessagesBackend } from './backend'
import { archiveRoom, deleteRoom, listOverview, renameRoom, unarchiveRoom } from './admin/room-admin'
import { __resetMatrixCachesForTests, evictMatrixClient, getMatrixClient } from './matrix-client'
import { __resetSynapseAdminForTests, getSynapseAdmin } from './synapse-admin'
import { createMatrixSubsystem } from './provisioning/matrix-subsystem'
import { messagingErasureHook } from './erasure'
import { messagingKarenz } from './karenz'
import type { KarenzContext } from '$lib/server/module-karenz/participants'
import type { KarenzItemRow } from '$lib/server/module-karenz/store'
import { TENANT_MARKER_TYPE, currentMeetingAliasLocalpart } from './matrix-namespace'
import type { OrgUnit } from '$lib/server/governance/org-units-db'

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
  /** The homeserver's ONE user directory (localpart-qualified ids). */
  readonly users = new Map<string, { displayname?: string; deactivated: boolean; erased: boolean }>()
  /** Login flows GET /login lists. */
  flows: Array<{ type: string }> = [{ type: 'm.login.password' }]
  /** The bodies of every admin login-as-user request, by user id. */
  readonly adminLogins: Array<{ userId: string; body: Record<string, unknown> }> = []
  roomSeq = 0
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
    if (method === 'GET' && path === '/_matrix/client/v3/login') return json(200, { flows: server.flows })
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
    if (path === '/_synapse/admin/v1/rooms' && method === 'GET') {
      if (kind !== 'admin') return json(403)
      return json(200, { rooms: [...server.rooms].filter(([, r]) => !r.deleted).map(([id, r]) => ({ room_id: id, creator: server.bot, name: r.name, canonical_alias: (r.state.get('m.room.canonical_alias')?.content as { alias?: string } | undefined)?.alias ?? null })) })
    }
    if ((m = /^\/_synapse\/admin\/v[12]\/rooms\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      if (kind !== 'admin') return json(403)
      const room = server.rooms.get(m[1]!)
      if (room) room.deleted = true
      return json(200, { delete_id: 'd' })
    }
    // ---- what the namespaced identity adds: accounts, admin login, room creation, join, erasure ----
    if ((m = /^\/_synapse\/admin\/v2\/users\/(.+)$/.exec(path))) {
      if (kind !== 'admin') return json(403)
      const id = m[1]!
      if (method === 'GET') {
        const u = server.users.get(id)
        return u ? json(200, { name: id, deactivated: u.deactivated, displayname: u.displayname }) : json(404, { errcode: 'M_NOT_FOUND' })
      }
      if (method === 'PUT') {
        const prior = server.users.get(id)
        server.users.set(id, { displayname: (body.displayname as string | undefined) ?? prior?.displayname, deactivated: body.deactivated === true, erased: prior?.erased ?? false })
        return json(200, { name: id })
      }
    }
    if ((m = /^\/_synapse\/admin\/v1\/users\/(.+)\/login$/.exec(path)) && method === 'POST') {
      if (kind !== 'admin') return json(403)
      const id = m[1]!
      if (!server.users.has(id)) return json(404, { errcode: 'M_NOT_FOUND' })
      server.adminLogins.push({ userId: id, body })
      const access = `mx-${server.host}-${++server.logins}`
      server.tokens.set(access, id)
      return json(200, { access_token: access })
    }
    if ((m = /^\/_synapse\/admin\/v1\/deactivate\/(.+)$/.exec(path)) && method === 'POST') {
      if (kind !== 'admin') return json(403)
      const u = server.users.get(m[1]!)
      if (!u) return json(404, { errcode: 'M_NOT_FOUND' })
      u.deactivated = true
      u.erased = body.erase === true
      return json(200, { id_server_unbind_result: 'no-support' })
    }
    if ((m = /^\/_synapse\/admin\/v1\/join\/(.+)$/.exec(path)) && method === 'POST') {
      if (kind !== 'admin') return json(403)
      const room = server.rooms.get(m[1]!)
      const who = body.user_id as string
      if (!room || !server.users.has(who)) return json(404)
      room.members.add(who)
      return json(200, { room_id: m[1] })
    }
    if (path === '/_matrix/client/v3/createRoom' && method === 'POST') {
      if (kind !== 'admin') return json(403)
      const aliasName = body.room_alias_name as string | undefined
      const alias = aliasName ? `#${aliasName}:${server.serverName}` : undefined
      if (alias && [...server.rooms.values()].some((r) => r.aliases.has(alias))) return json(400, { errcode: 'M_ROOM_IN_USE', error: 'Room alias already taken' })
      const id = `!new-${++server.roomSeq}:${server.serverName}`
      server.room(id, body.name as string, [server.bot], alias)
      for (const e of (body.initial_state as Array<{ type: string; state_key: string; content: unknown }> | undefined) ?? []) {
        server.rooms.get(id)!.state.set(e.type, { sender: server.bot, content: e.content })
      }
      return json(200, { room_id: id })
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
  LEDGER.ownAudit.clear()
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

  it("restore: B's archived room as A is a 404, stays archived, and writes nothing", async () => {
    // B archived its room: the marker of the admin bot names B's unit, the ledger row is released.
    const marker = { org_unit_id: 'unit-b', archived_at: '2026-01-01T00:00:00Z', prior: null }
    sharedSynapse.rooms.get(ROOM_B)!.state.set('org.gremion.room.archived', { sender: sharedSynapse.bot, content: marker })
    LEDGER.rooms.get('tid-b')!.delete('unit-b')
    const m = net.mark()
    for (const orgUnitId of ['unit-a', 'unit-b']) {
      const res = (await route(A_SHARED, roomUnarchive, ev(A_SHARED, ADMIN_A, 'admin-a', { roomId: ROOM_B, method: 'POST', body: JSON.stringify({ orgUnitId }), headers: json }))) as Response
      expect(res.status).toBe(404)
    }
    expect(writes(net.since(m))).toEqual([])
    expect(sharedSynapse.rooms.get(ROOM_B)!.state.get('org.gremion.room.archived')!.content).toEqual(marker)
    expect(LEDGER.rooms.get('tid-a')!.get('unit-a')).toBe(ROOM_A)
  })

  // Two customers on ONE homeserver can have an org unit with the same id (the dev seed migration gives
  // every fresh tenant database the same fixed unit ids). The archive marker is room state of the
  // shared homeserver, so the unit id alone does not say whose room it is.
  describe('an archived room of another customer whose unit has the same id', () => {
    const MARKER = 'org.gremion.room.archived'
    const json = { 'Content-Type': 'application/json' }
    const stamped = { org_unit_id: 'unit-x', tenant_id: 'tid-b', archived_at: '2026-01-01T00:00:00Z', prior: null }
    const legacy = { org_unit_id: 'unit-x', archived_at: '2026-01-01T00:00:00Z', prior: null }
    /** Both customers have the unit 'unit-x' and neither has an active room for it (an empty id is no ledger row). */
    const sameUnit = (marker: Record<string, unknown>) => {
      LEDGER.rooms.set('tid-a', new Map([['unit-x', '']]))
      LEDGER.rooms.set('tid-b', new Map([['unit-x', '']]))
      sharedSynapse.rooms.get(ROOM_B)!.state.set(MARKER, { sender: sharedSynapse.bot, content: marker })
    }

    for (const [label, marker] of [['stamped with the other customer', stamped], ['written before markers carried a customer', legacy]] as const) {
      it(`restore as A is a 404 and writes nothing (${label})`, async () => {
        sameUnit(marker)
        const m = net.mark()
        const res = (await route(A_SHARED, roomUnarchive, ev(A_SHARED, ADMIN_A, 'admin-a', { roomId: ROOM_B, method: 'POST', body: JSON.stringify({ orgUnitId: 'unit-x' }), headers: json }))) as Response
        expect(res.status).toBe(404)
        expect(net.since(m).filter((r) => r.method !== 'GET' && !r.path.endsWith('/login'))).toEqual([])
        expect(sharedSynapse.rooms.get(ROOM_B)!.state.get(MARKER)!.content).toEqual(marker)
      })

      it(`delete as A is a 404 and the room is kept (${label})`, async () => {
        sameUnit(marker)
        const res = (await route(A_SHARED, roomDelete, ev(A_SHARED, ADMIN_A, 'admin-a', { roomId: ROOM_B, method: 'DELETE', query: '?orgUnitId=unit-x' }))) as Response
        expect(res.status).toBe(404)
        expect(sharedSynapse.rooms.get(ROOM_B)!.deleted).toBe(false)
      })

      it(`A's archive list does not show it and reads no name of it (${label})`, async () => {
        sameUnit(marker)
        const m = net.mark()
        const overview = await as(A_SHARED, () => listOverview([{ id: 'unit-x', name: 'Gremium unit-x' }]))
        expect(overview.archivedRooms).toEqual([])
        expect(net.since(m).some((r) => r.path.includes(ROOM_B) && r.path.endsWith('/state/m.room.name'))).toBe(false)
      })
    }

    it('a room archived before markers named a customer is still shown to the customer whose own audit trail records the archive, and to no other', async () => {
      sameUnit(legacy)
      LEDGER.ownAudit.add(`tid-b|messages.room.archive|unit-x:${ROOM_B}:ok`)
      const own = await as(B_SHARED, () => listOverview([{ id: 'unit-x', name: 'Gremium unit-x' }]))
      expect(own.archivedRooms.map((r) => r.roomId)).toEqual([ROOM_B])
      const other = await as(A_SHARED, () => listOverview([{ id: 'unit-x', name: 'Gremium unit-x' }]))
      expect(other.archivedRooms).toEqual([])
    })

    it('the customer that archived the room still sees it', async () => {
      sameUnit(stamped)
      const overview = await as(B_SHARED, () => listOverview([{ id: 'unit-x', name: 'Gremium unit-x' }]))
      expect(overview.archivedRooms.map((r) => r.roomId)).toEqual([ROOM_B])
    })
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
    for (const [h, method, query] of [[roomPatch, 'PATCH', ''], [roomArchive, 'POST', ''], [roomUnarchive, 'POST', ''], [roomDelete, 'DELETE', '?orgUnitId=unit-a']] as const) {
      const res = (await route(A_SHARED, h as Handler, ev(A_SHARED, ALICE, 'alice', { roomId: ROOM_A, method, query, body: method === 'DELETE' ? null : JSON.stringify({ orgUnitId: 'unit-a', name: 'x' }), headers: json }))) as Response
      expect(res.status).toBe(403)
    }
    expect(net.since(m)).toEqual([])
  })
})


// ================================================================================
// 6. MATRIX_IDENTITY=namespaced: two customers on ONE shared homeserver
// ================================================================================
//
// The recording fake keeps ONE user directory and ONE alias directory for the homeserver, so a
// username or a unit name that two customers share is the same key for both unless the app
// namespaces it. Everything here goes through the real clients, the real routes, the real
// provisioning adapter and the real erasure hook; only the homeserver is the fake.

describe('a request without a Keycloak access token for the exchange', () => {
  const bare = (path: string) => {
    const e = ev(A_SHARED, ALICE, 'alice') as { locals: { auth: unknown }; request: Request; url: URL }
    e.url = new URL(`http://localhost${path}`)
    e.request = new Request(e.url)
    e.locals.auth = async () => ({ user: ALICE })
    return e as never
  }

  it('the room list and the live stream answer 502 as they always did (a missing token is not a 401 here)', async () => {
    await expect(route(A_SHARED, roomsGet, bare('/api/messages/rooms'))).rejects.toMatchObject({ status: 502 })
    await expect(route(A_SHARED, syncGet, bare('/api/messages/sync'))).rejects.toMatchObject({ status: 502 })
  })

  it('and the same with MATRIX_IDENTITY=namespaced', async () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    try {
      await expect(route(A_SHARED, roomsGet, bare('/api/messages/rooms'))).rejects.toMatchObject({ status: 502 })
      await expect(route(A_SHARED, syncGet, bare('/api/messages/sync'))).rejects.toMatchObject({ status: 502 })
    } finally {
      delete process.env.MATRIX_IDENTITY
    }
  })
})

describe('namespaced chat identity: two customers on one shared homeserver', () => {
  const NS_A = { id: 'tid-a', slug: 'acme', issuer: 'https://id.example.org/realms/acme' } as unknown as TenantContext
  const NS_B = { id: 'tid-b', slug: 'beta', issuer: 'https://id.example.org/realms/beta' } as unknown as TenantContext
  const nsJwt = (t: TenantContext, username: string, over: Record<string, unknown> = {}) =>
    `h.${Buffer.from(JSON.stringify({ sub: `sub-${t.slug}-${username}`, preferred_username: username, iss: t.issuer, exp: Math.floor(Date.now() / 1000) + 3600, ...over })).toString('base64url')}.s`
  const unit = { id: 'u1', name: 'Vorstand' } as unknown as OrgUnit
  const kc = { getUser: async (id: string) => ({ id, username: id.replace(/^kc-/, ''), firstName: 'Vorname', lastName: 'Nachname' }) }
  const subsystem = (t: TenantContext) =>
    as(t, () => createMatrixSubsystem({ matrix: getMatrixClient(), synapse: getSynapseAdmin(), kc: kc as never }, 'synapse.test', { slug: t.slug, tenantId: t.id }))
  const CTX = { parentKeycloakGroupId: null }
  const ALIAS_A = '#stura.acme.vorstand:synapse.test'
  const mint = (t: TenantContext, username: string) => as(t, () => getMatrixClient().getMatrixToken(nsJwt(t, username)))
  /** A room somebody else made that carries the alias customer A's unit would claim. */
  const stray = (state?: { sender: string; content: unknown }): string => {
    sharedSynapse.room('!stray:synapse.test', 'Vorstand', ['@someone:synapse.test'], ALIAS_A)
    if (state) sharedSynapse.rooms.get('!stray:synapse.test')!.state.set(TENANT_MARKER_TYPE, state)
    return '!stray:synapse.test'
  }

  beforeEach(() => {
    process.env.MATRIX_IDENTITY = 'namespaced'
  })
  afterEach(() => {
    delete process.env.MATRIX_IDENTITY
  })

  it('the same unit name in two customers gives two rooms with two aliases, each carrying its customer', async () => {
    const a = await subsystem(NS_A).ensureResource(unit, CTX, null)
    const b = await subsystem(NS_B).ensureResource(unit, CTX, null)
    expect(a.externalId).not.toBe(b.externalId)
    expect([...sharedSynapse.rooms.get(a.externalId!)!.aliases]).toEqual([ALIAS_A])
    expect([...sharedSynapse.rooms.get(b.externalId!)!.aliases]).toEqual(['#stura.beta.vorstand:synapse.test'])
    expect(sharedSynapse.rooms.get(a.externalId!)!.state.get(TENANT_MARKER_TYPE)).toEqual({ sender: sharedSynapse.bot, content: { tenant_id: 'tid-a' } })
    expect(sharedSynapse.rooms.get(b.externalId!)!.state.get(TENANT_MARKER_TYPE)).toEqual({ sender: sharedSynapse.bot, content: { tenant_id: 'tid-b' } })
  })

  it('the same username in two customers gives two accounts; each is a member of its own room only', async () => {
    const a = (await subsystem(NS_A).ensureResource(unit, CTX, null)).externalId!
    const b = (await subsystem(NS_B).ensureResource(unit, CTX, null)).externalId!
    await subsystem(NS_A).addMember(a, 'kc-alice')
    await subsystem(NS_B).addMember(b, 'kc-alice')
    expect([...sharedSynapse.users.keys()].sort()).toEqual(['@acme.alice:synapse.test', '@beta.alice:synapse.test'])
    expect([...sharedSynapse.rooms.get(a)!.members]).toContain('@acme.alice:synapse.test')
    expect([...sharedSynapse.rooms.get(a)!.members]).not.toContain('@beta.alice:synapse.test')
    expect([...sharedSynapse.rooms.get(b)!.members]).toContain('@beta.alice:synapse.test')
    expect([...sharedSynapse.rooms.get(b)!.members]).not.toContain('@acme.alice:synapse.test')
  })

  it('the account provisioning joins is the account the login mints: a member finds its room through the real route', async () => {
    const a = (await subsystem(NS_A).ensureResource(unit, CTX, null)).externalId!
    const b = (await subsystem(NS_B).ensureResource(unit, CTX, null)).externalId!
    await subsystem(NS_A).addMember(a, 'kc-alice')
    await subsystem(NS_B).addMember(b, 'kc-alice')
    const tokenA = await mint(NS_A, 'alice')
    expect(sharedSynapse.tokens.get(tokenA)).toBe('@acme.alice:synapse.test')
    expect(sharedSynapse.rooms.get(a)!.members.has(sharedSynapse.tokens.get(tokenA)!)).toBe(true)

    const listFor = async (t: TenantContext) => {
      const token = nsJwt(t, 'alice')
      const e = ev(t, user('kc-alice'), 'x', { headers: { Authorization: `Bearer ${token}` } }) as { locals: { auth: unknown } }
      e.locals.auth = async () => ({ user: user('kc-alice'), accessToken: token })
      const res = (await route(t, roomsGet, e as never)) as Response
      return ((await res.json()) as { data: { roomId: string }[] }).data.map((r) => r.roomId)
    }
    expect(await listFor(NS_A)).toEqual([a])
    expect(await listFor(NS_B)).toEqual([b])
  })

  it("customer B's alice has no way into A's room: her token is not a member and reads nothing", async () => {
    const a = (await subsystem(NS_A).ensureResource(unit, CTX, null)).externalId!
    await subsystem(NS_A).addMember(a, 'kc-alice')
    const tokenB = await mint(NS_B, 'alice')
    // B's alice is her own account, not A's: the id behind her token is not a member of A's room.
    expect(sharedSynapse.tokens.get(tokenB)).toBe('@beta.alice:synapse.test')
    expect(sharedSynapse.rooms.get(a)!.members.has(sharedSynapse.tokens.get(tokenB)!)).toBe(false)
    expect(await as(NS_B, () => getMatrixClient().getJoinedRooms(tokenB))).toEqual([])
    await expect(as(NS_B, () => getMatrixClient().getMessages(tokenB, a))).rejects.toThrow(/403/)
  })

  it("B's erasure of its alice deactivates B's account and leaves A's alice alone", async () => {
    const a = (await subsystem(NS_A).ensureResource(unit, CTX, null)).externalId!
    const b = (await subsystem(NS_B).ensureResource(unit, CTX, null)).externalId!
    await subsystem(NS_A).addMember(a, 'kc-alice')
    await subsystem(NS_B).addMember(b, 'kc-alice')
    KC.username = 'alice'
    const res = await as(NS_B, () => messagingErasureHook.erase({ tenantId: 'tid-b', subjectId: 'kc-alice', db: null } as never))
    expect(res).toEqual({ status: 'erased', counts: { matrix_accounts: 1 } })
    expect(sharedSynapse.users.get('@beta.alice:synapse.test')).toMatchObject({ deactivated: true, erased: true })
    expect(sharedSynapse.users.get('@acme.alice:synapse.test')).toMatchObject({ deactivated: false, erased: false })
  })

  it('a membership sync does not bring an erased account back, and leaves the display name of the others alone', async () => {
    const b = (await subsystem(NS_B).ensureResource(unit, CTX, null)).externalId!
    await subsystem(NS_B).addMember(b, 'kc-alice')
    await subsystem(NS_B).addMember(b, 'kc-carol')
    sharedSynapse.users.get('@beta.carol:synapse.test')!.displayname = 'Name chosen by Carol'
    KC.username = 'alice'
    await as(NS_B, () => messagingErasureHook.erase({ tenantId: 'tid-b', subjectId: 'kc-alice', db: null } as never))
    expect(sharedSynapse.users.get('@beta.alice:synapse.test')).toMatchObject({ deactivated: true, erased: true })

    await subsystem(NS_B).reconcileMembers(b, ['kc-alice', 'kc-carol'])
    await subsystem(NS_B).addMember(b, 'kc-alice')

    expect(sharedSynapse.users.get('@beta.alice:synapse.test')).toMatchObject({ deactivated: true, erased: true })
    expect(sharedSynapse.users.get('@beta.carol:synapse.test')).toMatchObject({ deactivated: false, displayname: 'Name chosen by Carol' })
    expect(sharedSynapse.rooms.get(b)!.members.has('@beta.carol:synapse.test')).toBe(true)
  })

  describe("a room found by alias is adopted only when it is this customer's", () => {
    it('without a marker: refused, nothing created, nothing joined', async () => {
      const id = stray()
      const before = sharedSynapse.rooms.size
      await expect(subsystem(NS_A).ensureResource(unit, CTX, null)).rejects.toThrow(/tid-a|Mandant|tenant/i)
      expect(sharedSynapse.rooms.size).toBe(before)
      expect(sharedSynapse.rooms.get(id)!.members.size).toBe(1)
    })

    it('with the marker of another customer: refused', async () => {
      stray({ sender: sharedSynapse.bot, content: { tenant_id: 'tid-b' } })
      await expect(subsystem(NS_A).ensureResource(unit, CTX, null)).rejects.toThrow(/Mandant|tenant/i)
    })

    it('with a marker that the bot did not write: refused', async () => {
      stray({ sender: '@someone:synapse.test', content: { tenant_id: 'tid-a' } })
      await expect(subsystem(NS_A).ensureResource(unit, CTX, null)).rejects.toThrow(/Mandant|tenant/i)
    })

    it('with the marker of this customer: adopted, no second room', async () => {
      const id = stray({ sender: sharedSynapse.bot, content: { tenant_id: 'tid-a' } })
      const before = sharedSynapse.rooms.size
      expect((await subsystem(NS_A).ensureResource(unit, CTX, null)).externalId).toBe(id)
      expect(sharedSynapse.rooms.size).toBe(before)
    })

    it('the creation path that runs into a taken alias adopts nothing either, and adopts with the right marker', async () => {
      const id = stray()
      await expect(as(NS_A, () => getMatrixClient().createRoom('Vorstand', 'T', 'stura.acme.vorstand', { tenantId: 'tid-a' }))).rejects.toThrow(/Mandant|tenant/i)
      sharedSynapse.rooms.get(id)!.state.set(TENANT_MARKER_TYPE, { sender: sharedSynapse.bot, content: { tenant_id: 'tid-a' } })
      expect(await as(NS_A, () => getMatrixClient().createRoom('Vorstand', 'T', 'stura.acme.vorstand', { tenantId: 'tid-a' }))).toBe(id)
    })

    it('a ledger hit still short-circuits: an existing room id is reused without any homeserver request', async () => {
      const m = net.mark()
      expect((await subsystem(NS_A).ensureResource(unit, CTX, '!known:synapse.test')).externalId).toBe('!known:synapse.test')
      expect(net.since(m)).toEqual([])
    })
  })

  // Room administration derives its aliases through the same switch as provisioning: archiving a
  // unit's room removes the alias provisioning gave it, and the archive and restore never touch an
  // alias of the legacy namespace, which on a shared homeserver may belong to another customer.
  describe('room administration addresses the aliases provisioning gave the room', () => {
    const adminUnit = { id: 'u1', name: 'Gremium u1' } as unknown as OrgUnit
    const UNIT_ALIAS = (slug: string) => `#stura.${slug}.gremium-u1:synapse.test`
    const archiveAliasOf = (roomId: string) => [...sharedSynapse.rooms.get(roomId)!.aliases].filter((a) => a.startsWith('#stura-archiv'))
    /** The unit's room as provisioning made it, and the customer's ledger row for it. */
    const provisioned = async (t: TenantContext): Promise<string> => {
      const id = (await subsystem(t).ensureResource(adminUnit, CTX, null)).externalId!
      LEDGER.rooms.set(t.id, new Map([[adminUnit.id, id]]))
      return id
    }
    /** Archives the unit's room; the released ledger row stays as an empty id (the unit still exists, it has no active room). */
    const archive = async (t: TenantContext) => {
      await as(t, () => archiveRoom('u1', { userId: 'admin' }))
      LEDGER.rooms.get(t.id)!.set(adminUnit.id, '')
    }

    it('archiving removes the unit alias from the room, gives it an archive alias of its customer, and touches no legacy alias', async () => {
      const room = await provisioned(NS_A)
      const m = net.mark()
      await archive(NS_A)
      const aliases = [...sharedSynapse.rooms.get(room)!.aliases]
      expect(aliases).not.toContain(UNIT_ALIAS('acme'))
      expect(aliases).toHaveLength(1)
      expect(aliases[0]).toMatch(/^#stura-archiv\.acme\.gremium-u1-\d{12}:synapse\.test$/)
      expect(net.since(m).filter((r) => r.path.includes('directory/room') && /#stura-(archiv-|gremium)/.test(r.path))).toEqual([])
    })

    it('after the archive the unit does not adopt its own archived room: it gets a new one', async () => {
      const archived = await provisioned(NS_A)
      await archive(NS_A)
      const again = (await subsystem(NS_A).ensureResource(adminUnit, CTX, null)).externalId!
      expect(again).not.toBe(archived)
      expect([...sharedSynapse.rooms.get(again)!.aliases]).toEqual([UNIT_ALIAS('acme')])
    })

    it('two customers archiving a unit of the same name get two archive aliases and archive only their own room', async () => {
      const a = await provisioned(NS_A)
      const b = await provisioned(NS_B)
      await archive(NS_A)
      expect(archiveAliasOf(b)).toEqual([])
      expect([...sharedSynapse.rooms.get(b)!.aliases]).toEqual([UNIT_ALIAS('beta')])
      await archive(NS_B)
      expect(archiveAliasOf(a)).toHaveLength(1)
      expect(archiveAliasOf(b)).toHaveLength(1)
      expect(archiveAliasOf(a)[0]).not.toBe(archiveAliasOf(b)[0])
      expect(archiveAliasOf(b)[0]).toMatch(/^#stura-archiv\.beta\./)
    })

    it("restoring puts the customer's own unit alias back, removes the archive alias and never creates a legacy alias", async () => {
      const room = await provisioned(NS_A)
      await archive(NS_A)
      const m = net.mark()
      await as(NS_A, () => unarchiveRoom('u1', room, { userId: 'admin' }))
      expect([...sharedSynapse.rooms.get(room)!.aliases]).toEqual([UNIT_ALIAS('acme')])
      expect(net.since(m).filter((r) => r.method !== 'GET' && r.path.includes('directory/room') && r.path.includes('#stura-gremium'))).toEqual([])
    })

    it("an archive alias of another customer in the room state is not taken for the restore to delete", async () => {
      const room = await provisioned(NS_A)
      await archive(NS_A)
      const foreign = '#stura-archiv.beta.gremium-u1-202601010000:synapse.test'
      sharedSynapse.rooms.get(room)!.state.set('m.room.canonical_alias', { sender: sharedSynapse.bot, content: { alias: foreign } })
      sharedSynapse.rooms.get(room)!.aliases.add(foreign)
      await as(NS_A, () => unarchiveRoom('u1', room, { userId: 'admin' }))
      expect([...sharedSynapse.rooms.get(room)!.aliases]).toContain(foreign)
    })
  })

  // One alias directory for every customer on the shared homeserver: what a customer archives, renames
  // or deletes is the room ITS ledger names, whatever an alias lookup answers.
  describe("room administration acts on the room of this customer's ledger, not on what an alias names", () => {
    const U1 = 'u1'
    const unit1 = { id: U1, name: 'Gremium u1' } as unknown as OrgUnit
    const legacyAlias = (name: string) => `#stura-${name}:synapse.test`
    const aliasesOf = (roomId: string) => [...sharedSynapse.rooms.get(roomId)!.aliases]

    it("B's archive leaves a room of A that holds the alias B's unit would use untouched: alias, state and power levels", async () => {
      const b = (await subsystem(NS_B).ensureResource(unit1, CTX, null)).externalId!
      LEDGER.rooms.set('tid-b', new Map([[U1, b]]))
      // The room that B's unit alias names is not B's ledger room.
      sharedSynapse.rooms.get(b)!.aliases.clear()
      sharedSynapse.room('!a-vorstand:synapse.test', 'Vorstand A', ['@acme.alice:synapse.test'], '#stura.beta.gremium-u1:synapse.test')
      const before = JSON.stringify([...sharedSynapse.rooms.get('!a-vorstand:synapse.test')!.state])
      await as(NS_B, () => archiveRoom(U1, { userId: 'admin' }))
      const a = sharedSynapse.rooms.get('!a-vorstand:synapse.test')!
      expect([...a.aliases]).toEqual(['#stura.beta.gremium-u1:synapse.test'])
      expect(JSON.stringify([...a.state])).toBe(before)
      expect(sharedSynapse.rooms.get(b)!.state.get('org.gremion.room.archived')?.content).toMatchObject({ org_unit_id: U1, tenant_id: 'tid-b' })
    })

    it("B's archive of its own unit leaves the legacy-alias room of another customer with the same unit name as it was", async () => {
      sharedSynapse.room('!a-legacy:synapse.test', 'Gremium u1', ['@alice:synapse.test'], legacyAlias('gremium-u1'))
      const b = (await subsystem(NS_B).ensureResource(unit1, CTX, null)).externalId!
      LEDGER.rooms.set('tid-b', new Map([[U1, b]]))
      const m = net.mark()
      await as(NS_B, () => archiveRoom(U1, { userId: 'admin' }))
      expect(aliasesOf('!a-legacy:synapse.test')).toEqual([legacyAlias('gremium-u1')])
      expect([...sharedSynapse.rooms.get('!a-legacy:synapse.test')!.state.keys()]).toEqual(['m.room.create'])
      expect(net.since(m).filter((r) => r.method !== 'GET' && r.path.includes('!a-legacy'))).toEqual([])
    })

    it('a ledger room that still carries a legacy alias is renamed, archived, restored and deleted by its room id', async () => {
      sharedSynapse.room('!old:synapse.test', 'Gremium u1', ['@acme.alice:synapse.test'], legacyAlias('gremium-u1'))
      LEDGER.rooms.set('tid-a', new Map([[U1, '!old:synapse.test']]))
      await as(NS_A, () => renameRoom(U1, { name: 'Neuer Name', userId: 'admin' }))
      expect(sharedSynapse.rooms.get('!old:synapse.test')!.name).toBe('Neuer Name')
      await as(NS_A, () => archiveRoom(U1, { userId: 'admin' }))
      LEDGER.rooms.get('tid-a')!.set(U1, '')
      expect(sharedSynapse.rooms.get('!old:synapse.test')!.state.get('org.gremion.room.archived')?.content).toMatchObject({ org_unit_id: U1, tenant_id: 'tid-a' })
      await as(NS_A, () => unarchiveRoom(U1, '!old:synapse.test', { userId: 'admin' }))
      expect(aliasesOf('!old:synapse.test')).toContain('#stura.acme.gremium-u1:synapse.test')
      LEDGER.rooms.set('tid-a', new Map([[U1, '!old:synapse.test']]))
      await as(NS_A, () => deleteRoom(U1, '!old:synapse.test', { userId: 'admin' }))
      expect(sharedSynapse.rooms.get('!old:synapse.test')!.deleted).toBe(true)
    })
  })

  // The meeting rooms: one alias directory, so the alias carries the customer, and the Karenz of one
  // customer lists the meeting rooms of that customer only.
  describe('meeting rooms of two customers on one homeserver', () => {
    const EVT = '0b7c6f1e-4a8e-4c51-9f3a-2d1e8c7b6a50'
    const meetingRoom = (t: TenantContext): Promise<string> =>
      as(t, () => getMatrixClient().createRoom('Sitzung', 'T', currentMeetingAliasLocalpart(EVT), { tenantId: t.id }))
    const items = new Map<string, KarenzItemRow>()
    const kctx = (t: TenantContext): KarenzContext => ({
      tenant: t, karenzId: 'k1', catalogueId: 'messaging', manifestId: 'messages',
      switchedOffAt: new Date('2026-11-01T00:00:00Z'), finalAt: new Date('2026-12-01T00:00:00Z'),
      now: () => new Date('2026-11-01T12:00:00Z'), log: vi.fn(),
      items: {
        list: async () => [...items.values()],
        upsert: async (i) => {
          const row = { itemId: `item-${items.size + 1}`, karenzId: 'k1', kind: i.kind, externalId: i.externalId, state: i.state, payload: i.payload ?? null, detail: i.detail ?? null, updatedAt: new Date() } as KarenzItemRow
          items.set(i.externalId, row)
          return row
        },
        setState: async () => undefined,
      },
    })
    /** The homeserver lists a room with the alias it was created under as its canonical one. */
    const canonical = (roomId: string): void => {
      const room = sharedSynapse.rooms.get(roomId)!
      room.state.set('m.room.canonical_alias', { sender: sharedSynapse.bot, content: { alias: [...room.aliases][0] } })
    }
    beforeEach(() => {
      items.clear()
      LEDGER.rooms.set('tid-a', new Map())
      LEDGER.rooms.set('tid-b', new Map())
    })

    it('the same event opened by both customers gives two rooms, each under the alias of its customer', async () => {
      const a = await meetingRoom(NS_A)
      const b = await meetingRoom(NS_B)
      expect(a).not.toBe(b)
      expect([...sharedSynapse.rooms.get(a)!.aliases]).toEqual([`#meeting.acme.${EVT}:synapse.test`])
      expect([...sharedSynapse.rooms.get(b)!.aliases]).toEqual([`#meeting.beta.${EVT}:synapse.test`])
    })

    it("B's Karenz lists no meeting room of A, and A's lists none of B", async () => {
      const a = await meetingRoom(NS_A)
      const b = await meetingRoom(NS_B)
      canonical(a)
      canonical(b)
      await as(NS_B, () => messagingKarenz.switchOff(kctx(NS_B)))
      expect([...items.keys()]).toEqual([b])
      items.clear()
      await as(NS_A, () => messagingKarenz.switchOff(kctx(NS_A)))
      expect([...items.keys()]).toEqual([a])
      const d = await as(NS_B, () => messagingKarenz.describe!(NS_B))
      expect(d.retained).toHaveLength(1)
      expect(d.retained[0]).toMatchObject({ count: 1 })
    })
  })

  describe('whose token it is', () => {
    it("B's token presented in A's scope is refused: no account is made for A, no login is minted", async () => {
      await expect(as(NS_A, () => getMatrixClient().getMatrixToken(nsJwt(NS_B, 'alice')))).rejects.toMatchObject({ status: 403 })
      expect(sharedSynapse.users.size).toBe(0)
      expect(sharedSynapse.adminLogins).toEqual([])
    })

    it('the login carries an expiry the homeserver enforces, and no device', async () => {
      const before = Date.now()
      await mint(NS_A, 'alice')
      expect(sharedSynapse.adminLogins).toHaveLength(1)
      const body = sharedSynapse.adminLogins[0]!.body
      expect(Object.keys(body)).toEqual(['valid_until_ms'])
      expect(body.valid_until_ms as number).toBeGreaterThanOrEqual(before + 3_600_000)
      expect(body.valid_until_ms as number).toBeLessThanOrEqual(Date.now() + 3_600_000)
    })

    it('while the homeserver offers a JWT login, no customer gets a Matrix token and no account is made', async () => {
      sharedSynapse.flows = [{ type: 'm.login.password' }, { type: 'org.matrix.login.jwt' }]
      await expect(mint(NS_A, 'alice')).rejects.toMatchObject({ status: 503 })
      await expect(mint(NS_B, 'alice')).rejects.toMatchObject({ status: 503 })
      expect(sharedSynapse.users.size).toBe(0)
      expect(sharedSynapse.adminLogins).toEqual([])
    })

    it('the room list and the live stream answer 503 while the homeserver offers a JWT login, not a 502', async () => {
      sharedSynapse.flows = [{ type: 'org.matrix.login.jwt' }]
      const evFor = (path: string) => {
        const token = nsJwt(NS_A, 'alice')
        const e = ev(NS_A, user('kc-alice'), 'x', { headers: { Authorization: `Bearer ${token}` } }) as { locals: { auth: unknown }; url: URL }
        e.locals.auth = async () => ({ user: user('kc-alice'), accessToken: token })
        e.url = new URL(`http://localhost${path}`)
        return e as never
      }
      await expect(route(NS_A, roomsGet, evFor('/api/messages/rooms'))).rejects.toMatchObject({ status: 503 })
      await expect(route(NS_A, syncGet, evFor('/api/messages/sync'))).rejects.toMatchObject({ status: 503 })
    })

    it('an erased account is not brought back by a login with a token that is still valid', async () => {
      await subsystem(NS_B).addMember((await subsystem(NS_B).ensureResource(unit, CTX, null)).externalId!, 'kc-alice')
      KC.username = 'alice'
      await as(NS_B, () => messagingErasureHook.erase({ tenantId: 'tid-b', subjectId: 'kc-alice', db: null } as never))
      await expect(mint(NS_B, 'alice')).rejects.toMatchObject({ status: 403 })
      expect(sharedSynapse.users.get('@beta.alice:synapse.test')).toMatchObject({ deactivated: true })
    })
  })
})
