import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Module Karenz (phase 2, Task 16): the files retained sink. The Nextcloud is ONE shared instance for every
// tenant, so the tests run the REAL Nextcloud client against ONE in-memory Nextcloud (groups, group folders
// with per-group permissions, WebDAV) and drive several tenants through it. Only the tenant database
// (retained_sink_state), the role lookup and the config are faked.

const NC_ADMIN = 'ncadmin'
const env: Record<string, string> = {
  NEXTCLOUD_URL: 'http://nc.test',
  NEXTCLOUD_ADMIN_USER: NC_ADMIN,
  NEXTCLOUD_ADMIN_PASSWORD: 'pw',
  NEXTCLOUD_OIDC_PROVIDER_ID: '3',
}
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: (name: string) => env[name] }))

const h = vi.hoisted(() => ({
  filesOn: { value: true as boolean | undefined },
  holders: {} as Record<string, Array<{ userId: string; email: string; displayName: string; roles: string[] }>>,
  holderRoles: [] as unknown[],
  holderFailure: { value: false },
}))
vi.mock('$lib/server/config', () => ({
  readConfig: () => ({ modules: h.filesOn.value === undefined ? {} : { files: h.filesOn.value } }),
}))
vi.mock('$lib/server/governance/role-holders', () => ({
  listRoleHolders: async (tenant: { id: string }, roles: readonly string[]) => {
    h.holderRoles.push([...roles])
    if (h.holderFailure.value) throw new Error('keycloak down')
    return { holders: h.holders[tenant.id] ?? [], skipped: [] }
  },
}))

import type { TenantContext } from '$lib/server/tenant/context'

// ── the one shared Nextcloud ────────────────────────────────────────────────

interface Folder { mount: string; groups: Map<string, number> }
class FakeNextcloud {
  groups = new Map<string, Set<string>>()
  users = new Set<string>([NC_ADMIN])
  folders = new Map<number, Folder>()
  files = new Map<string, string>() // `${folderId}/${filename}`
  requests: Array<{ method: string; path: string; body: string }> = []
  failures: Array<{ match: (method: string, path: string) => boolean; once: boolean }> = []
  private nextFolder = 100

  count(method: string, pathPart: string): number {
    return this.requests.filter((r) => r.method === method && r.path.includes(pathPart)).length
  }

  /** What a user may do in a folder: the OR of the permissions of every group of the folder the user is in. */
  permissions(user: string, folderId: number): number {
    let perms = 0
    for (const [gid, p] of this.folders.get(folderId)?.groups ?? []) if (this.groups.get(gid)?.has(user)) perms |= p
    return perms
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    const raw = init?.body
    const body = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8')
    const path = url.pathname + url.search
    this.requests.push({ method, path, body })
    const fault = this.failures.find((f) => f.match(method, path))
    if (fault) {
      if (fault.once) this.failures = this.failures.filter((f) => f !== fault)
      return new Response('injected failure', { status: 500 })
    }
    const ocs = (data: unknown, statuscode = 100) =>
      new Response(JSON.stringify({ ocs: { meta: { status: 'ok', statuscode }, data } }), { status: 200 })
    const form = (key: string) => new URLSearchParams(body).get(key) ?? ''
    let m: RegExpExecArray | null

    if (method === 'POST' && url.pathname === '/ocs/v1.php/cloud/groups') {
      const gid = form('groupid')
      if (!this.groups.has(gid)) this.groups.set(gid, new Set())
      return ocs([])
    }
    if ((m = /^\/ocs\/v1\.php\/cloud\/groups\/([^/]+)$/.exec(url.pathname)) && method === 'GET') {
      const members = this.groups.get(decodeURIComponent(m[1]!))
      return members ? ocs({ users: [...members] }) : ocs([], 101)
    }
    if ((m = /^\/ocs\/v1\.php\/cloud\/users\/([^/]+)\/groups$/.exec(url.pathname))) {
      const user = decodeURIComponent(m[1]!)
      const gid = form('groupid')
      if (!this.users.has(user) || !this.groups.has(gid)) return new Response('not found', { status: 404 })
      if (method === 'POST') this.groups.get(gid)!.add(user)
      else if (method === 'DELETE') this.groups.get(gid)!.delete(user)
      return ocs([])
    }
    if (method === 'POST' && url.pathname === '/ocs/v2.php/apps/user_oidc/api/v1/user') {
      this.users.add((JSON.parse(body) as { userId: string }).userId)
      return ocs([])
    }
    if (url.pathname === '/index.php/apps/groupfolders/folders') {
      if (method === 'GET') {
        return ocs(Object.fromEntries([...this.folders].map(([id, f]) => [id, { id, mount_point: f.mount }])))
      }
      if (method === 'POST') {
        const id = this.nextFolder++
        this.folders.set(id, { mount: form('mountpoint'), groups: new Map() })
        return ocs({ id, mount_point: form('mountpoint') })
      }
    }
    if ((m = /^\/index\.php\/apps\/groupfolders\/folders\/(\d+)\/groups$/.exec(url.pathname)) && method === 'POST') {
      const folder = this.folders.get(Number(m[1]))
      if (!folder) return new Response('nope', { status: 404 })
      folder.groups.set(form('group'), 31) // a freshly added group gets everything until its permissions are set
      return ocs([])
    }
    if ((m = /^\/index\.php\/apps\/groupfolders\/folders\/(\d+)\/groups\/([^/]+)$/.exec(url.pathname)) && method === 'POST') {
      this.folders.get(Number(m[1]))?.groups.set(decodeURIComponent(m[2]!), Number(form('permissions')))
      return ocs([])
    }
    if ((m = /^\/remote\.php\/dav\/files\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)) && method === 'PUT') {
      const user = decodeURIComponent(m[1]!)
      const mount = decodeURIComponent(m[2]!)
      const name = decodeURIComponent(m[3]!)
      // the user sees only the folders its groups are in; the first visible folder of that mount name is the one written
      const id = [...this.folders].find(([fid, f]) => f.mount === mount && this.permissions(user, fid) > 0)?.[0]
      if (id === undefined) return new Response('not found', { status: 404 })
      const exists = this.files.has(`${id}/${name}`)
      if (this.permissions(user, id) & (exists ? 2 : 4)) {
        this.files.set(`${id}/${name}`, body)
        return new Response(exists ? null : '', { status: exists ? 204 : 201 })
      }
      return new Response('forbidden', { status: 403 })
    }
    return new Response(`unexpected ${method} ${path}`, { status: 500 })
  }
}

// ── the tenant database: only retained_sink_state and the advisory lock ─────

function makeTenantDb() {
  let state = new Map<string, { external_id: string; group_id: string }>()
  const statements: string[] = []
  const handle = (text: string, v: unknown[]): unknown[] => {
    statements.push(text)
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/FROM retained_sink_state/.test(text)) {
      const row = state.get(v[0] as string)
      return row ? [{ ...row }] : []
    }
    if (/INSERT INTO retained_sink_state/.test(text)) {
      const [sink, external_id, group_id] = v as [string, string, string]
      if (state.has(sink)) return [] // ON CONFLICT (sink) DO NOTHING
      state.set(sink, { external_id, group_id })
      return [{ external_id, group_id }]
    }
    throw new Error(`fake tenant db: unexpected statement: ${text}`)
  }
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => handle(strings.join('?'), values)
  const db: unknown = Object.assign(tag, {
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const saved = new Map([...state].map(([k, r]) => [k, { ...r }]))
      try {
        return await fn(db)
      } catch (err) {
        state = saved
        throw err
      }
    },
  })
  return { db, state: () => state, statements }
}

let nc: FakeNextcloud
function makeTenant(id: string) {
  const tdb = makeTenantDb()
  const tenant = { id, slug: id, db: tdb.db, configPath: `/cfg/${id}.json` } as unknown as TenantContext
  return { tenant, ...tdb }
}
const holder = (userId: string) => ({ userId, email: `${userId}@example.org`, displayName: userId, roles: ['vorstand'] })
const ndjson = (s: string) => Buffer.from(s, 'utf8')

describe('filesRetainedSink', () => {
  let sink: Awaited<typeof import('./retained-sink')>

  beforeEach(async () => {
    vi.clearAllMocks()
    nc = new FakeNextcloud()
    vi.stubGlobal('fetch', vi.fn(nc.fetch))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.filesOn.value = true
    h.holders = {}
    h.holderRoles = []
    h.holderFailure.value = false
    sink = await import('./retained-sink')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const publish = (t: { tenant: TenantContext }, recordId: string, filename: string, content: string) =>
    sink.filesRetainedSink.publish({ tenant: t.tenant, recordId, title: 'Aufbewahrte Unterlagen', filename, ndjson: ndjson(content) })

  it('is the sink with the id files', () => {
    expect(sink.filesRetainedSink.id).toBe('files')
  })

  it('the retained sink is unavailable when the files module is off (the download in settings does not depend on it)', () => {
    const t = makeTenant('tenant-a')
    h.filesOn.value = true
    expect(sink.filesRetainedSink.available(t.tenant)).toBe(true)
    h.filesOn.value = false
    expect(sink.filesRetainedSink.available(t.tenant)).toBe(false)
    h.filesOn.value = undefined // no entry at all is not "on"
    expect(sink.filesRetainedSink.available(t.tenant)).toBe(false)
    expect(nc.requests).toEqual([]) // deciding availability never touches Nextcloud
  })

  it('publish creates the tenant\'s group folder and group once, stores both ids in retained_sink_state, and uploads one document per record, read-only (permission 1)', async () => {
    const t = makeTenant('tenant-a')
    h.holders['tenant-a'] = [holder('u1'), holder('u2')]

    await publish(t, 'r1', 'retained-a-r1.ndjson', '{"n":1}\n')
    await publish(t, 'r2', 'retained-a-r2.ndjson', '{"n":2}\n')

    expect(nc.folders.size).toBe(1)
    const [folderId, folder] = [...nc.folders][0]!
    expect(folder.mount).toBe('Aufbewahrung-tenant-a')
    // exactly one creation of the folder, whatever the number of records
    expect(nc.count('POST', '/groupfolders/folders?format=json')).toBe(1)
    // the readers' group is read-only (permission 1)
    expect(folder.groups.get('gremion-retained-tenant-a')).toBe(1)
    // both ids are stored in the tenant's own state row
    expect(t.state().get('files')).toEqual({ external_id: String(folderId), group_id: 'gremion-retained-tenant-a' })
    // one document per record
    expect([...nc.files.keys()].sort()).toEqual([`${folderId}/retained-a-r1.ndjson`, `${folderId}/retained-a-r2.ndjson`])
    expect(nc.files.get(`${folderId}/retained-a-r1.ndjson`)).toBe('{"n":1}\n')
    // the role holders read: members of the readers' group, and only that
    expect([...nc.groups.get('gremion-retained-tenant-a')!].sort()).toEqual(['u1', 'u2'])
    // asked for exactly the five roles that may read retained records
    expect(h.holderRoles[0]).toEqual(['council-admin', 'vorstand', 'finance', 'auditor', 'it-admin'])
  })

  it('the readers can read but never write; only the service account writes, through a group of its own', async () => {
    const t = makeTenant('tenant-a')
    h.holders['tenant-a'] = [holder('u1')]
    await publish(t, 'r1', 'retained-a-r1.ndjson', 'x\n')
    const [folderId, folder] = [...nc.folders][0]!

    expect(nc.permissions('u1', folderId)).toBe(1) // read only
    expect(nc.permissions(NC_ADMIN, folderId) & 6).toBe(6) // create and update
    // the writer group has the service account as its only member
    const writerGroups = [...folder.groups.keys()].filter((g) => g !== 'gremion-retained-tenant-a')
    expect(writerGroups).toHaveLength(1)
    expect([...nc.groups.get(writerGroups[0]!)!]).toEqual([NC_ADMIN])
    // and a reader is never put in it, nor the service account in the readers' group
    expect(nc.groups.get('gremion-retained-tenant-a')!.has(NC_ADMIN)).toBe(false)
  })

  it('the second publish reads the ids from retained_sink_state and looks nothing up by name', async () => {
    const t = makeTenant('tenant-a')
    h.holders['tenant-a'] = [holder('u1')]
    await publish(t, 'r1', 'retained-a-r1.ndjson', 'x\n')
    nc.requests = []

    await publish(t, 'r2', 'retained-a-r2.ndjson', 'y\n')

    expect(nc.count('GET', '/groupfolders/folders')).toBe(0) // no listing, so no adoption by mount point
    expect(nc.count('POST', '/groupfolders/folders')).toBe(0) // no second folder, no second grant
    expect(nc.count('POST', '/cloud/groups')).toBe(0) // no group creation
    expect(nc.folders.size).toBe(1)
  })

  it('creation takes a database-wide lock first and stores the state inside the same transaction', async () => {
    const t = makeTenant('tenant-a')
    await publish(t, 'r1', 'retained-a-r1.ndjson', 'x\n')
    const lock = t.statements.findIndex((s) => /pg_advisory_xact_lock/.test(s))
    const insert = t.statements.findIndex((s) => /INSERT INTO retained_sink_state/.test(s))
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(insert).toBeGreaterThan(lock)
  })

  it('TWO-TENANT: two tenants publishing to one Nextcloud get two group folders and two groups, and a role holder never reads another tenant\'s copies', async () => {
    const a = makeTenant('tenant-a')
    const b = makeTenant('tenant-b')
    h.holders['tenant-a'] = [holder('alice'), holder('shared')]
    h.holders['tenant-b'] = [holder('bob')]

    await publish(a, 'ra', 'retained-a.ndjson', 'A\n')
    await publish(b, 'rb', 'retained-b.ndjson', 'B\n')

    expect(nc.folders.size).toBe(2)
    expect([...nc.folders.values()].map((f) => f.mount).sort()).toEqual(['Aufbewahrung-tenant-a', 'Aufbewahrung-tenant-b'])
    expect(a.state().get('files')!.external_id).not.toBe(b.state().get('files')!.external_id)
    expect(a.state().get('files')!.group_id).toBe('gremion-retained-tenant-a')
    expect(b.state().get('files')!.group_id).toBe('gremion-retained-tenant-b')

    const groupA = nc.groups.get('gremion-retained-tenant-a')!
    const groupB = nc.groups.get('gremion-retained-tenant-b')!
    expect([...groupA].sort()).toEqual(['alice', 'shared'])
    expect([...groupB]).toEqual(['bob'])
    // tenant A's holders have no permission at all on tenant B's folder, and the other way round
    const idA = Number(a.state().get('files')!.external_id)
    const idB = Number(b.state().get('files')!.external_id)
    expect(nc.permissions('alice', idB)).toBe(0)
    expect(nc.permissions('bob', idA)).toBe(0)
    expect(nc.permissions('alice', idA)).toBe(1)
    // each tenant's document sits in its own folder only
    expect(nc.files.get(`${idA}/retained-a.ndjson`)).toBe('A\n')
    expect(nc.files.has(`${idB}/retained-a.ndjson`)).toBe(false)
  })

  it('a folder with the tenant\'s mount point that is not in its retained_sink_state is NOT adopted: publish fails loudly and writes nothing', async () => {
    const t = makeTenant('tenant-a')
    h.holders['tenant-a'] = [holder('u1')]
    // somebody (an earlier crash, a human) already made a folder with this exact mount point
    nc.folders.set(7, { mount: 'Aufbewahrung-tenant-a', groups: new Map([['somebody-else', 31]]) })

    const err = await publish(t, 'r1', 'retained-a-r1.ndjson', 'x\n').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(sink.RetainedSinkError)
    expect((err as Error).message).toMatch(/not adopted/)
    expect(t.state().size).toBe(0) // no state row recorded for a folder that is not ours
    expect(nc.files.size).toBe(0) // nothing uploaded
    expect(nc.folders.size).toBe(1) // and no second folder created beside it
    expect(nc.folders.get(7)!.groups.has('gremion-retained-tenant-a')).toBe(false) // our group was not attached to it
    expect(nc.count('POST', '/groupfolders/folders/7')).toBe(0)
  })

  it('publishing the same filename twice overwrites and leaves one document', async () => {
    const t = makeTenant('tenant-a')
    h.holders['tenant-a'] = [holder('u1')]
    await publish(t, 'r1', 'retained-a-r1.ndjson', 'person: Max Muster\n')
    await publish(t, 'r1', 'retained-a-r1.ndjson', 'person: erased\n') // the republish after an erasure

    expect([...nc.files.keys()]).toHaveLength(1)
    expect([...nc.files.values()]).toEqual(['person: erased\n'])
  })

  it('the membership sync adds new holders and removes former ones, inside one tenant\'s group only', async () => {
    const a = makeTenant('tenant-a')
    const b = makeTenant('tenant-b')
    h.holders['tenant-a'] = [holder('u1'), holder('u2')]
    h.holders['tenant-b'] = [holder('u3')]
    await publish(a, 'ra', 'a.ndjson', '1\n')
    await publish(b, 'rb', 'b.ndjson', '1\n')

    // u1 lost the role, u4 gained it; tenant B is unchanged
    h.holders['tenant-a'] = [holder('u2'), holder('u4')]
    await publish(a, 'ra', 'a.ndjson', '2\n')

    expect([...nc.groups.get('gremion-retained-tenant-a')!].sort()).toEqual(['u2', 'u4'])
    expect([...nc.groups.get('gremion-retained-tenant-b')!]).toEqual(['u3'])
    // a holder is given a Nextcloud account first (the group call 404s for a user without one)
    expect(nc.users.has('u4')).toBe(true)
    // a further run for tenant A issues no call that names tenant B's group
    nc.requests = []
    await publish(a, 'ra', 'a.ndjson', '3\n')
    expect(nc.requests.some((r) => r.body.includes('gremion-retained-tenant-b') || r.path.includes('gremion-retained-tenant-b'))).toBe(false)
  })

  it('a holder is provisioned with the details the role lookup returned', async () => {
    const t = makeTenant('tenant-a')
    h.holders['tenant-a'] = [{ userId: 'u9', email: 'u9@example.org', displayName: 'U Neun', roles: ['finance'] }]
    await publish(t, 'r1', 'a.ndjson', '1\n')
    const provision = nc.requests.find((r) => r.path.includes('/user_oidc/api/v1/user'))!
    expect(JSON.parse(provision.body)).toMatchObject({ providerId: 3, userId: 'u9', displayName: 'U Neun', email: 'u9@example.org' })
  })

  it('a role lookup failure fails the publish before anything is uploaded (no document goes to an unknown audience)', async () => {
    const t = makeTenant('tenant-a')
    h.holderFailure.value = true
    await expect(publish(t, 'r1', 'a.ndjson', '1\n')).rejects.toThrow(/keycloak down/)
    expect(nc.files.size).toBe(0)
  })

  it('a Nextcloud failure fails the publish step (the engine retries it) and the retry converges on one folder and one document', async () => {
    const t = makeTenant('tenant-a')
    h.holders['tenant-a'] = [holder('u1')]
    nc.failures.push({ match: (method, path) => method === 'PUT' && path.includes('/remote.php/dav/'), once: true })

    await expect(publish(t, 'r1', 'a.ndjson', '1\n')).rejects.toThrow(/500/)
    expect(nc.files.size).toBe(0)
    // the state row was recorded before the upload, so the retry does not look for the folder again
    expect(t.state().get('files')).toBeDefined()

    await publish(t, 'r1', 'a.ndjson', '1\n')
    expect(nc.folders.size).toBe(1)
    expect(nc.files.size).toBe(1)
  })

  it('a failure while creating the folder leaves no state row, and the next attempt refuses the stray folder instead of adopting it', async () => {
    const t = makeTenant('tenant-a')
    nc.failures.push({ match: (method, path) => method === 'POST' && path.includes('/groupfolders/folders/') && path.endsWith('/groups'), once: true })

    await expect(publish(t, 'r1', 'a.ndjson', '1\n')).rejects.toThrow(/500/)
    expect(t.state().size).toBe(0)
    expect(nc.folders.size).toBe(1) // created, not yet granted

    const err = await publish(t, 'r1', 'a.ndjson', '1\n').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(sink.RetainedSinkError)
    expect(nc.folders.size).toBe(1)
    expect(nc.files.size).toBe(0)
  })

  it('refuses a tenant id that cannot be part of a Nextcloud name, before any request', async () => {
    const t = makeTenant('tenant/../x')
    await expect(publish(t, 'r1', 'a.ndjson', '1\n')).rejects.toThrow(/tenant id/)
    expect(nc.requests).toEqual([])
  })

  it('the names are per tenant and derived in one place', () => {
    expect(sink.retainedFolderName('abc-1')).toBe('Aufbewahrung-abc-1')
    expect(sink.retainedReaderGroup('abc-1')).toBe('gremion-retained-abc-1')
  })
})
