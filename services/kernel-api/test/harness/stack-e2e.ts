// TASK-077 stack-proof.sh, phase `e2e` (brief s.1, TDD 15): the section-1 items that
// need the running stack, asserted on SERVED responses of the kernel-api IMAGE
// (read-only container on 127.0.0.1) with REAL Keycloak 26.6.1 tokens from two
// realms, the web stand-in `docker stop`ped first. Sequential: later steps build on
// earlier ones, and every state change (a status, a ledger row, a stopped database)
// is restored before the next. State from T077_STATE (written by stack-proof.sh).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { inlineRefs, listOperations, loadSpec } from '@gremion/fastify-service-template'
import { RESERVED_PLATFORM_LABELS } from '@gremion/tenancy-core'
import { SignJWT } from 'jose'
import { afterAll, describe, expect, it } from 'vitest'
import { SPEC_URL } from '../../src/app/build.ts'
import { buildResponseContract, checkResponse } from '../../src/app/response-contract.ts'
import { kernelDatabaseOf } from '../../src/tenancy/target.ts'
import { connect, CONTROL_DB } from './scratch.ts'

const statePath = process.env.T077_STATE!
const PROOF = process.env.T077_PROOF!
const SDIR = process.env.T077_SDIR!
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
let st = readState()

const doc = inlineRefs(loadSpec(SPEC_URL))
const contract = buildResponseContract(doc)
const opByPath = new Map(listOperations(doc).map((o) => [`${o.method} ${o.path}`, o.operationId!]))
const seen: Array<{ what: string; violation: unknown }> = []

function docker(args: string[], allowFail = false) {
  const r = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.join(' ')}: ${(r.stderr || '').slice(-300)}`)
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}
const proof = (...args: string[]) => {
  const r = spawnSync('bash', [PROOF, ...args], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

interface Res { status: number; headers: Record<string, string>; text: string; json: any }
function call(path: string, headers: Record<string, string>): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: st.apiPort, path, method: 'GET', headers, setHost: false, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown
        try { json = JSON.parse(text) } catch { json = undefined }
        const h: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(',') : String(v)
        const r = { status: res.statusCode ?? 0, headers: h, text, json }
        const op = opByPath.get(`GET ${path}`)
        if (op && json !== undefined) seen.push({ what: `${path} ${r.status}`, violation: checkResponse(contract, op, r.status, (h['content-type'] ?? '').split(';')[0]!.trim(), json) })
        resolve(r)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}
const edge = (host: string, token?: string): Record<string, string> => ({ host, 'x-forwarded-host': host, 'x-proxy-trust': st.proxy, ...(token ? { authorization: `Bearer ${token}` } : {}) })
const SELF = '/api/v1/tenancy/self'
const MODULES = '/api/v1/modules'

async function token(realm: string, user: string, client = 'gremion-ui'): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'password', client_id: client, username: user, password: st.userPass })
  if (client === 'gremion-ui') body.set('client_secret', st.uiSecret)
  const r = await fetch(`http://127.0.0.1:${st.kcPort}/realms/${realm}/protocol/openid-connect/token`, { method: 'POST', body })
  const j = (await r.json()) as { access_token?: string }
  if (!j.access_token) throw new Error(`no token from ${realm}/${client}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j.access_token
}
const claims = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString('utf8')) as { iss: string; aud: string | string[] }
const problem = (r: Res) => /^application\/problem\+json/.test(r.headers['content-type'] ?? '')

const pgReady = async () => {
  for (let i = 0; i < 40; i++) {
    if (docker(['exec', st.names.pg, 'psql', '-h', '127.0.0.1', '-U', st.user, '-d', st.db, '-c', 'SELECT 1'], true).code === 0) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('postgres did not come back')
}
const psql = (db: string, sql: string) => docker(['exec', st.names.pg, 'psql', '-h', '127.0.0.1', '-U', st.user, '-d', db, '-At', '-c', sql]).out

let tokA = ''
let tokB = ''
afterAll(() => {
  // leave the stack restored for the next phase
  docker(['start', st.names.pg], true)
})

describe('section 1 on the running stack (kernel-api image, real Keycloak, web stopped)', () => {
  it('keycloak issues real tokens for both realms whose aud carries gremion-kernel-api (G8)', async () => {
    tokA = await token('realm-a', 'auser')
    tokB = await token('realm-b', 'buser')
    for (const [t, realm] of [[tokA, 'realm-a'], [tokB, 'realm-b']] as const) {
      const c = claims(t)
      expect(c.iss).toBe(`http://127.0.0.1:${st.kcPort}/realms/${realm}`)
      expect([c.aud].flat()).toContain('gremion-kernel-api')
    }
    const plain = claims(await token('realm-a', 'auser', 't077-plain'))
    expect([plain.aud].flat()).not.toContain('gremion-kernel-api')
  })

  it('WEB STOPPED: the kernel API answers a tenant-resolved request with A\'s token on A\'s host', async () => {
    docker(['stop', st.names.web])
    expect(docker(['inspect', '--format', '{{.State.Running}}', st.names.web]).out).toBe('false')
    expect(docker(['inspect', '--format', '{{.State.Running}}', st.names.api]).out).toBe('true')
    // the kernel-api container references no web container (nothing it needs was stopped)
    expect(docker(['inspect', '--format', '{{json .HostConfig.Links}} {{json .NetworkSettings.Networks}}', st.names.api]).out).not.toContain('web')
    const r = await call(SELF, edge(st.customers.a.host, tokA))
    expect(r.status, r.text).toBe(200)
    const body = JSON.stringify(r.json)
    expect(body).toContain(st.customers.a.id)
    expect(body).toContain(st.customers.a.slug)
    expect(body).toContain('realm-a')
    expect(body).not.toContain(st.customers.b.id)
  })

  it('CROSS-REALM: B\'s token on A\'s host is refused 401 problem+json; missing audience, forged alg, junk, none are 401', async () => {
    const h = st.customers.a.host
    const r = await call(SELF, edge(h, tokB))
    expect(r.status).toBe(401)
    expect(problem(r)).toBe(true)
    expect(r.text).not.toContain(st.customers.a.id)
    expect((await call(SELF, edge(h, await token('realm-a', 'auser', 't077-plain')))).status).toBe(401)
    const hs = await new SignJWT({ aud: 'gremion-kernel-api' }).setProtectedHeader({ alg: 'HS256' }).setIssuer(claims(tokA).iss).setSubject('x').setExpirationTime('5m').sign(new TextEncoder().encode('k'.repeat(32)))
    expect((await call(SELF, edge(h, hs))).status).toBe(401)
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: claims(tokA).iss, aud: 'gremion-kernel-api', sub: 'x', exp: 4e9 })).toString('base64url')}.`
    expect((await call(SELF, edge(h, none))).status).toBe(401)
    expect((await call(SELF, edge(h, 'not-a-jwt'))).status).toBe(401)
    expect((await call(SELF, edge(h))).status).toBe(401)
  })

  it('HOST: unbound, reserved, Host != X-Forwarded-Host -> 404; no/wrong proxy header -> 403', async () => {
    const unbound = await call(SELF, edge('nobody.example.org', tokA))
    expect(unbound.status).toBe(404)
    expect(problem(unbound)).toBe(true)
    const label = [...RESERVED_PLATFORM_LABELS][0]!
    expect((await call(SELF, edge(`${label}.example.org`, tokA))).status).toBe(404)
    expect((await call(SELF, { ...edge(st.customers.a.host, tokA), 'x-forwarded-host': st.customers.b.host })).status).toBe(404)
    expect((await call(SELF, edge('a b.example.org', tokA))).status).toBe(404)
    const noProxy = { host: st.customers.a.host, 'x-forwarded-host': st.customers.a.host, authorization: `Bearer ${tokA}` }
    expect((await call(SELF, noProxy)).status).toBe(403)
    expect((await call(SELF, { ...noProxy, 'x-proxy-trust': 'wrong-secret-wrong-secret-wrong' })).status).toBe(403)
  })

  it('BOOT: an unset proxy secret refuses to boot (the image exits non-zero, names the variable)', () => {
    const env = readFileSync(`${SDIR}/api.env`, 'utf8').split('\n').filter((l) => l && !l.startsWith('TENANT_PROXY_SHARED_SECRET='))
    const args = ['run', '--rm', '--read-only', '--cap-drop', 'ALL', ...env.flatMap((l) => ['-e', l]), st.apiImage]
    const r = docker(args, true)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('TENANT_PROXY_SHARED_SECRET')
  })

  it('STATUS: provisioning/deleting/deleted -> 404; suspended -> 503 with Retry-After and no data; restored -> 200', async () => {
    const control = connect(CONTROL_DB, { max: 1 })
    try {
      const h = st.customers.a.host
      for (const status of ['provisioning', 'deleting', 'deleted']) {
        await control`UPDATE tenant SET status = ${status} WHERE id = ${st.customers.a.id}::uuid`
        const r = await call(SELF, edge(h, tokA))
        expect(r.status, status).toBe(404)
      }
      await control`UPDATE tenant SET status = 'suspended' WHERE id = ${st.customers.a.id}::uuid`
      const s = await call(SELF, edge(h, tokA))
      expect(s.status).toBe(503)
      expect(s.headers['retry-after']).toBeTruthy()
      expect(s.text).not.toContain(st.customers.a.id)
    } finally {
      await control`UPDATE tenant SET status = 'active' WHERE id = ${st.customers.a.id}::uuid`
      await control.end({ timeout: 5 })
    }
    expect((await call(SELF, edge(st.customers.a.host, tokA))).status).toBe(200)
  })

  it('CONTROL DB DOWN: 503 for every customer, nothing cached; back up -> 200', async () => {
    docker(['stop', st.names.pg])
    try {
      for (const [c, t] of [[st.customers.a, tokA], [st.customers.b, tokB]] as const) {
        const r = await call(SELF, edge(c.host, t))
        expect(r.status, c.slug).toBe(503)
      }
    } finally {
      docker(['start', st.names.pg])
      await pgReady()
    }
    let r = await call(SELF, edge(st.customers.a.host, tokA))
    for (let i = 0; i < 15 && r.status !== 200; i++) {
      await new Promise((x) => setTimeout(x, 1000))
      r = await call(SELF, edge(st.customers.a.host, tokA))
    }
    expect(r.status).toBe(200)
  })

  it('REGISTRY: exactly the customer\'s enabled modules (A: board, calendar; B: content), disabled ones absent', async () => {
    const keys = (r: Res) => (JSON.stringify(r.json).match(/"(?:moduleKey|module_key|key|id)":"([a-z]+)"/g) ?? []).map((m) => m.split('"')[3]).sort()
    const a = await call(MODULES, edge(st.customers.a.host, tokA))
    const b = await call(MODULES, edge(st.customers.b.host, tokB))
    expect(a.status, a.text).toBe(200)
    expect(b.status, b.text).toBe(200)
    expect(new Set(keys(a))).toEqual(new Set(st.expectedEnabled.a))
    expect(new Set(keys(b))).toEqual(new Set(st.expectedEnabled.b))
    expect(a.text).not.toContain('vault')
    expect(a.text).toContain('runtime')
    expect(st.catalogueSize).toBe(11)
  })

  it('BEHIND / TRD-353 / DOWN: B\'s ledger row missing, altered sha256, or its database refusing connections -> 503 for B only; A 200; all restored', async () => {
    const dbB = kernelDatabaseOf(st.customers.b.id)
    const okA = async () => expect((await call(SELF, edge(st.customers.a.host, tokA))).status).toBe(200)
    const B = async () => (await call(SELF, edge(st.customers.b.host, tokB)))
    expect((await B()).status).toBe(200)
    const before = psql(dbB, 'SELECT filename, sha256 FROM idt.schema_migration ORDER BY filename')
    expect(before).toContain('0001_idt_setup.sql')

    // behind: the applied row is gone, one shipped file pending
    const row = psql(dbB, "SELECT to_jsonb(m)::text FROM idt.schema_migration m WHERE filename LIKE '0001%'")
    psql(dbB, 'ALTER TABLE idt.schema_migration DISABLE TRIGGER USER')
    psql(dbB, "DELETE FROM idt.schema_migration WHERE filename LIKE '0001%'")
    try {
      const r = await B()
      expect(r.status, r.text).toBe(503)
      expect(r.headers['retry-after']).toBeTruthy()
      expect(psql(dbB, 'SELECT count(*) FROM idt.schema_migration')).toBe('0') // the request did not apply anything
      await okA()
    } finally {
      psql(dbB, `INSERT INTO idt.schema_migration SELECT * FROM jsonb_populate_record(NULL::idt.schema_migration, '${row.replaceAll("'", "''")}'::jsonb)`)
    }
    expect((await B()).status).toBe(200)

    // TRD-353: an applied sha256 that is not the shipped file's
    const sha = psql(dbB, "SELECT sha256 FROM idt.schema_migration WHERE filename LIKE '0001%'")
    psql(dbB, "UPDATE idt.schema_migration SET sha256 = repeat('0', 64) WHERE filename LIKE '0001%'")
    try {
      expect((await B()).status).toBe(503)
      await okA()
    } finally {
      psql(dbB, `UPDATE idt.schema_migration SET sha256 = '${sha}' WHERE filename LIKE '0001%'`)
      psql(dbB, 'ALTER TABLE idt.schema_migration ENABLE TRIGGER USER')
    }
    expect((await B()).status).toBe(200)
    expect(psql(dbB, 'SELECT filename, sha256 FROM idt.schema_migration ORDER BY filename')).toBe(before)

    // B's database down
    psql('postgres', `ALTER DATABASE "${dbB}" WITH ALLOW_CONNECTIONS false`)
    psql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbB}'`)
    try {
      expect((await B()).status).toBe(503)
      await okA()
    } finally {
      psql('postgres', `ALTER DATABASE "${dbB}" WITH ALLOW_CONNECTIONS true`)
    }
    let r = await B()
    for (let i = 0; i < 10 && r.status !== 200; i++) { await new Promise((x) => setTimeout(x, 1000)); r = await B() }
    expect(r.status).toBe(200)
  })

  it('PROVISIONED AFTER THE MIGRATE JOB: 503 until `migrate --customer <id>`, then 200 (Q10)', async () => {
    const late = proof('late')
    expect(late.code, late.out).toBe(0)
    st = readState()
    const C = st.customers.c
    expect(C).toBeTruthy()
    const tokC = await token('realm-c', 'cuser')
    const before = await call(SELF, edge(C.host, tokC))
    expect(before.status, before.text).toBe(503)
    const m = proof('migrate', '--customer', C.id)
    expect(m.code, m.out).toBe(0)
    expect(m.out).toMatch(/premigration-dump created/)
    expect(m.out).toContain(`MIGRATE-RESULT customer=${C.id} applied=1 already=0`)
    const after = await call(SELF, edge(C.host, tokC))
    expect(after.status, after.text).toBe(200)
  })

  it('MIGRATE + DUMP: the first run took exactly one `created` dump line per customer before its apply; a re-run applies and dumps nothing; pg_dump major = server major', async () => {
    const log = readFileSync(`${SDIR}/migrate-1.log`, 'utf8').split('\n')
    for (const c of [st.customers.a, st.customers.b]) {
      const hex = c.id.replaceAll('-', '')
      const dump = log.findIndex((l) => l.startsWith('premigration-dump created') && l.includes(`t_${hex}__kernel`))
      const applied = log.findIndex((l) => l.includes(`[kernel-api migrate ${c.id}] applied 0001`))
      expect(dump, c.slug).toBeGreaterThanOrEqual(0)
      expect(applied, c.slug).toBeGreaterThan(dump)
      expect(log.filter((l) => l.startsWith('premigration-dump created') && l.includes(`t_${hex}__kernel`))).toHaveLength(1)
    }
    // the dump is on the DURABLE dir (a mount, not the container's tmpfs): the --rm migrate container is gone and both dumps are still there
    const kept = docker(['run', '--rm', '--entrypoint', 'sh', '-v', `${st.names.pg.replace(/-pg$/, '-dump')}:/d`, st.apiImage, '-c', 'stat -c %a:%u /d; ls /d; find /d -name "*.dump" | wc -l']).out
    expect(kept).toContain('700:1000')
    expect(kept).toContain('ledger.jsonl')
    expect(Number(kept.trim().split(/\r?\n/).at(-1))).toBeGreaterThanOrEqual(2)
    const again = proof('migrate')
    expect(again.code, again.out).toBe(0)
    expect(again.out).not.toMatch(/premigration-dump created/)
    expect(again.out).toContain(`MIGRATE-RESULT customer=${st.customers.a.id} applied=0 already=1`)
    const dumpMajor = /(\d+)\./.exec(docker(['run', '--rm', '--entrypoint', 'pg_dump', st.apiImage, '--version']).out)?.[1]
    const serverMajor = psql(st.db, 'SHOW server_version_num').slice(0, 2)
    expect(dumpMajor).toBe(serverMajor)
    expect(serverMajor).toBe('18')
  })

  it('EXPIRED TOKEN: a real Keycloak token past exp (beyond the 30 s tolerance) is 401 problem+json; a fresh one is 200 again (lifespan restored)', async () => {
    const kc = `http://127.0.0.1:${st.kcPort}`
    const adm = (await (await fetch(`${kc}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'a', password: 'a' }) })).json()) as { access_token: string }
    const auth = { authorization: `Bearer ${adm.access_token}`, 'content-type': 'application/json' }
    const realm = (await (await fetch(`${kc}/admin/realms/realm-a`, { headers: auth })).json()) as { accessTokenLifespan: number }
    const original = realm.accessTokenLifespan
    const put = (n: number) => fetch(`${kc}/admin/realms/realm-a`, { method: 'PUT', headers: auth, body: JSON.stringify({ accessTokenLifespan: n }) })
    let short = ''
    try {
      expect((await put(2)).status).toBe(204)
      short = await token('realm-a', 'auser')
      expect(claims(short)).toMatchObject({ iss: `${kc}/realms/realm-a` })
      const c = JSON.parse(Buffer.from(short.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number; iat: number }
      expect(c.exp - c.iat).toBe(2)
    } finally {
      expect((await put(original)).status).toBe(204)
    }
    expect((await call(SELF, edge(st.customers.a.host, short))).status).toBe(200) // inside its life: served
    await new Promise((r) => setTimeout(r, 36_000)) // 2 s life + the verifier's 30 s tolerance + margin
    const late = await call(SELF, edge(st.customers.a.host, short))
    expect(late.status, late.text).toBe(401)
    expect(problem(late)).toBe(true)
    expect(late.text).not.toContain(st.customers.a.id)
    expect((await call(SELF, edge(st.customers.a.host, await token('realm-a', 'auser')))).status).toBe(200)
  }, 120_000)

  it("Q3 CROSS-DB: A's registry ref aimed at B's database is refused (503 for A, nothing of B served); restored -> 200", async () => {
    const control = connect(CONTROL_DB, { max: 1 })
    try {
      const [a] = await control<{ r: string }[]>`SELECT db_conn_ref AS r FROM tenant WHERE id = ${st.customers.a.id}::uuid`
      const [b] = await control<{ r: string }[]>`SELECT db_conn_ref AS r FROM tenant WHERE id = ${st.customers.b.id}::uuid`
      expect(a!.r).not.toBe(b!.r)
      await control`UPDATE tenant SET db_conn_ref = ${b!.r} WHERE id = ${st.customers.a.id}::uuid`
      try {
        const r = await call(SELF, edge(st.customers.a.host, tokA))
        expect(r.status, r.text).toBe(503)
        expect(r.text).not.toContain(st.customers.b.id)
        expect(r.text).not.toContain(st.customers.b.slug)
      } finally {
        await control`UPDATE tenant SET db_conn_ref = ${a!.r} WHERE id = ${st.customers.a.id}::uuid`
      }
    } finally {
      await control.end({ timeout: 5 })
    }
    const back = await call(SELF, edge(st.customers.a.host, tokA))
    expect(back.status, back.text).toBe(200)
    expect(back.text).toContain(st.customers.a.id)
  })

  it('CONFORMANCE: every live response (success and problem) validated against openapi/kernel-core.json', () => {
    expect(seen.length).toBeGreaterThan(15)
    expect(seen.filter((s) => s.violation !== null)).toEqual([])
  })
})
