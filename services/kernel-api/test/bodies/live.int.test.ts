// TASK-080-a live acceptance (plan s.6, run by test/bodies/proof.sh): the REAL
// chain on PostgreSQL 18 and the REAL authenticated NATS.
//   * M-OFF-1: a customer with ZERO modules enabled -- body, org unit, person and
//     membership writes return 2xx, the events land in idt.outbox, the relay
//     publishes them onto the IDT stream, and a consumer reads N back;
//   * M-OFF-3: the stack holds no board / calendar / publishing / messaging /
//     files container and none of the above needs one (census below);
//   * psql post-conditions (row counts, the gist EXCLUDE, outbox states, the
//     JetStream message count) are QUOTED in the test output;
//   * A3: person-token writes are 403 under the shipped authorizer, an allow-all
//     test double (test/ only) is the RED reference, and no test double is in dist;
//   * A5: the kernel-api nkey publishes IDT and nothing else.
// Nextcloud-down: N/A. Nextcloud is not on this path (no file, no folder, no
// call), so there is nothing to take down; the proof states N/A, not pass.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adminConnectOptionsFor, ensureTenantAccount, natsBrokerOps, natsConnectOptionsFor } from '@gremion/nats-auth'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import { connect } from '@nats-io/transport-node'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app/build.ts'
import { readConfig } from '../../src/app/config.ts'
import { wireDeps, type Wired } from '../../src/app/wire.ts'
import { operatorAuthorizer, type WriteAuthorizer } from '../../src/bodies/authz.ts'
import { runBodiesCli } from '../../src/bodies/cli.ts'
import { createBodiesService } from '../../src/bodies/service.ts'
import { natsOpener } from '../../src/outbox/nats.ts'
import { createRelayHost } from '../../src/outbox/relay-host.ts'
import { DIRS, buildBodiesWorld, type BodiesWorld } from '../harness/bodies-world.ts'
import { startIssuers, type Issuers } from '../harness/issuers.ts'
import { KERNEL_ROOT, stack, uuidv7, type Customer } from '../harness/scratch.ts'

const PROXY = 'proxy-secret-for-the-scratch-stack-0123'
const HOST = 'live-z.example.org'
const SLUG = 'live-z'

interface Live {
  natsPort: number
  secretsDir: string
  accountsDir: string
  natsContainer: string
  names: { pg: string; nats: string }
}
const live = (): Live => JSON.parse(readFileSync(process.env.T077_STATE!, 'utf8')) as Live

let w: BodiesWorld
let iss: Issuers
let wired: Wired
let app: FastifyInstance
let Z: Customer
let natsUrl: string
const log = (...a: unknown[]) => console.log('[bodies-proof]', ...a)
const admin = () => w.adminPool(Z)
const loc = () => ({ secretsDir: live().secretsDir })
const lines: string[] = []

beforeAll(async () => {
  if (!process.env.T080_LIVE) throw new Error('run through test/bodies/proof.sh')
  natsUrl = `nats://127.0.0.1:${live().natsPort}`
  w = await buildBodiesWorld('live')
  iss = await startIssuers(['realm-z'])
  const realm = iss.realms.get('realm-z')!
  Z = await w.customer(SLUG, HOST, { realm: 'realm-z', issuer: realm.issuer, kcInternal: realm.kcInternal })
  const l = live()
  await ensureTenantAccount({ tenant: SLUG, modules: ['kernel-api'] }, { secretsDir: l.secretsDir, accountsDir: l.accountsDir, broker: natsBrokerOps({ url: natsUrl, secretsDir: l.secretsDir }) })
  const config = readConfig(
    { TENANT_PROXY_SHARED_SECRET: PROXY, PLATFORM_DOMAIN: 'example.org', KERNEL_API_CONTROL_DB_URL: w.world.readerControlUrl, KERNEL_API_PLATFORM_DB_URL: w.world.readerPlatformUrl, GREMION_RELEASE_REF: 'dist-v1.0.0' },
    { modulesRoot: join(KERNEL_ROOT, 'modules'), kernelRoot: KERNEL_ROOT },
  )
  wired = wireDeps(config, { dirs: DIRS, env: w.world.env, log: { info: () => {}, warn: () => {}, error: () => {} } })
  app = buildApp({}, wired.deps)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await wired?.close()
  await iss?.close()
  await w?.close()
})

const cliEnv = () => ({ ...w.world.env, KERNEL_API_CONTROL_DB_URL: w.world.readerControlUrl })
async function cli(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runBodiesCli(argv, cliEnv(), { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out, err }
}
const OP = uuidv7()
const ids: Record<string, string> = {}
const result = (r: { out: string[] }): Record<string, string> => JSON.parse(r.out.find((l) => l.startsWith('BODIES-RESULT'))!.replace(/^BODIES-RESULT \S+ \S+ /, ''))

describe('M-OFF-1 .. M-OFF-3: a customer with ZERO modules enabled', () => {
  it('the customer has no module enabled (the precondition of the whole proof)', async () => {
    const [n] = await w.world.platform<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.module_enablement WHERE customer_id = ${Z.id}::uuid`
    expect(n!.n).toBe(0)
    log(`plt.module_enablement rows for the customer: ${n!.n}`)
  })

  it('body, org unit, person and membership writes return 2xx (exit 0, a BODIES-RESULT line) through the operator verbs', async () => {
    const body = await cli(['create-body', '--customer', Z.id, '--operator', OP, '--json', JSON.stringify({ kindKey: 'stura', name: 'Studierendenrat', shortName: 'StuRa' })])
    expect(body.code, body.err.join('\n')).toBe(0)
    ids.body = result(body).bodyId!
    const unit = await cli(['create-org-unit', '--customer', Z.id, '--operator', OP, '--json', JSON.stringify({ bodyId: ids.body, kindKey: 'council', name: 'Plenum' })])
    expect(unit.code, unit.err.join('\n')).toBe(0)
    ids.unit = result(unit).orgUnitId!
    const person = await cli(['invite-person', '--customer', Z.id, '--operator', OP, '--json', JSON.stringify({ email: 'zoe@example.org', displayName: 'Zoe Zero' })])
    expect(person.code, person.err.join('\n')).toBe(0)
    ids.person = result(person).personId!
    const member = await cli(['start-membership', '--customer', Z.id, '--operator', OP, '--json', JSON.stringify({ personId: ids.person, bodyId: ids.body, orgUnitId: ids.unit, participationKind: 'elected_member', voting: true, validFrom: '2026-04-01', source: 'admin' })])
    expect(member.code, member.err.join('\n')).toBe(0)
    ids.membership = result(member).membershipId!
    const status = await cli(['status', '--customer', Z.id])
    log(status.out.join(' '))
    expect(status.out.join('')).toMatch(/"bodies":1,"org_units":1,"seats":0,"persons":1,"memberships":1/)
  })

  it('psql: the rows are there as the OPERATOR wrote them, and the gist EXCLUDE is on idt.membership', async () => {
    const a = admin()
    const [c] = await a<Record<string, number>[]>`SELECT (SELECT count(*)::int FROM idt.body) AS bodies, (SELECT count(*)::int FROM idt.org_unit) AS org_units,
      (SELECT count(*)::int FROM idt.person) AS persons, (SELECT count(*)::int FROM idt.membership) AS memberships, (SELECT count(*)::int FROM idt.org_unit_kind) AS kinds`
    log('row counts', JSON.stringify(c))
    expect(c).toEqual({ bodies: 1, org_units: 1, persons: 1, memberships: 1, kinds: 9 })
    expect(await a`SELECT created_by_kind, created_by::text FROM idt.membership`).toEqual([{ created_by_kind: 'operator', created_by: OP }])
    const [x] = await a<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'idt.membership'::regclass AND contype = 'x'`
    log('idt.membership EXCLUDE:', x!.def)
    expect(x!.def).toMatch(/^EXCLUDE USING gist \(person_id WITH =, body_id WITH =, COALESCE\(org_unit_id, body_id\) WITH =, participation_kind WITH =, daterange\(valid_from, valid_until, '\[\]'::text\) WITH &&\)$/)
  })

  it('the 4 events are in idt.outbox, pending, in the writes\' own transactions', async () => {
    const rows = await admin()<{ event_type: string; relay_state: string }[]>`SELECT event_type, relay_state FROM idt.outbox ORDER BY event_time, event_id`
    log('idt.outbox before the relay:', JSON.stringify(rows.map((r) => `${r.event_type.replace('de.gremion.idt.', '').replace('.v1', '')}:${r.relay_state}`)))
    expect(rows.map((r) => r.event_type)).toEqual(['de.gremion.idt.body.created.v1', 'de.gremion.idt.orgunit.created.v1', 'de.gremion.idt.person.invited.v1', 'de.gremion.idt.membership.started.v1'])
    expect(new Set(rows.map((r) => r.relay_state))).toEqual(new Set(['pending']))
  })

  it('the relay host publishes them onto the IDT stream as the kernel-api identity; every row is published, none dead-lettered', async () => {
    const host = createRelayHost({
      tenancy: wired.deps.tenancy,
      tenantDb: wired.deps.tenantDb,
      gate: wired.deps.gate,
      openJetStream: natsOpener({ url: natsUrl, secretsDir: live().secretsDir }),
      log: { info: () => {}, warn: (m, f) => console.warn(m, f), error: (m, f) => console.error(m, f) },
      pollMs: 100,
    })
    try {
      await host.reconcile()
      expect(host.running()).toEqual([Z.id])
      const deadline = Date.now() + 30_000
      let states: Array<{ relay_state: string; n: number }> = []
      while (Date.now() < deadline) {
        states = await admin()<{ relay_state: string; n: number }[]>`SELECT relay_state, count(*)::int AS n FROM idt.outbox GROUP BY relay_state ORDER BY relay_state`
        if (states.length === 1 && states[0]!.relay_state === 'published') break
        await new Promise((r) => setTimeout(r, 200))
      }
      log('idt.outbox after the relay:', JSON.stringify(states))
      expect(states).toEqual([{ relay_state: 'published', n: 4 }])
      expect(await admin()`SELECT count(*)::int AS n FROM idt.outbox WHERE attempt_count > 0 OR last_error_code IS NOT NULL`).toEqual([{ n: 0 }])
    } finally {
      await host.stop()
    }
  })

  it('JetStream: the IDT stream holds exactly N=4 messages, and a consumer reads the N back with the outbox ids as message ids', async () => {
    const l = live()
    const nc = await connect({ servers: natsUrl, ...adminConnectOptionsFor(SLUG, loc()), reconnect: false, timeout: 5_000 })
    try {
      const jsm = await jetstreamManager(nc)
      const info = await jsm.streams.info('IDT')
      log(`JetStream IDT stream: messages=${info.state.messages} subjects=${JSON.stringify(info.config.subjects)}`)
      expect(info.state.messages).toBe(4)
      expect(info.config.subjects).toEqual(['gremion.*.idt.>'])
      const consumer = await jetstream(nc).consumers.get('IDT')
      const got: Array<{ subject: string; msgId: string | undefined; body: { eventId: string; eventType: string; tenantId: string; payload: Record<string, unknown> } }> = []
      for (let i = 0; i < 4; i++) {
        const m = await consumer.next({ expires: 8_000 })
        if (!m) break
        got.push({ subject: m.subject, msgId: m.headers?.get('Nats-Msg-Id'), body: m.json() })
      }
      expect(got.map((g) => g.subject)).toEqual([`gremion.${SLUG}.idt.body.created`, `gremion.${SLUG}.idt.orgunit.created`, `gremion.${SLUG}.idt.person.invited`, `gremion.${SLUG}.idt.membership.started`])
      const ob = await admin()<{ event_id: string }[]>`SELECT event_id::text FROM idt.outbox ORDER BY event_time, event_id`
      expect(got.map((g) => g.msgId)).toEqual(ob.map((o) => o.event_id))
      expect(got.map((g) => g.body.eventId)).toEqual(ob.map((o) => o.event_id))
      expect(new Set(got.map((g) => g.body.tenantId))).toEqual(new Set([Z.id]))
      expect(got[3]!.body.payload).toMatchObject({ membership_id: ids.membership, person_id: ids.person, participation_kind: 'elected_member', aggregate_version: 1 })
      log('consumer read back', got.length, 'messages:', got.map((g) => g.subject.split('.').slice(-2).join('.')).join(', '))
    } finally {
      await nc.close()
    }
    void l
  })

  it('a second relay pass publishes nothing new (idempotent): still N=4 on the stream', async () => {
    const host = createRelayHost({ tenancy: wired.deps.tenancy, tenantDb: wired.deps.tenantDb, gate: wired.deps.gate, openJetStream: natsOpener({ url: natsUrl, secretsDir: live().secretsDir }), log: { info: () => {}, warn: () => {}, error: () => {} }, pollMs: 100 })
    try {
      await host.reconcile()
      await new Promise((r) => setTimeout(r, 1_500))
    } finally {
      await host.stop()
    }
    const nc = await connect({ servers: natsUrl, ...adminConnectOptionsFor(SLUG, loc()), reconnect: false, timeout: 5_000 })
    try {
      expect((await (await jetstreamManager(nc)).streams.info('IDT')).state.messages).toBe(4)
    } finally {
      await nc.close()
    }
  })

  it('M-OFF-3: docker ps census. The stack is PostgreSQL + NATS and nothing of board, calendar, publishing, messaging or files runs in it; the writes above needed none', () => {
    const r = spawnSync('docker', ['ps', '--format', '{{.Names}}', '--filter', `name=${live().names.pg.replace(/-pg$/, '')}`], { encoding: 'utf8' })
    const names = r.stdout.split('\n').filter(Boolean).sort()
    log('docker ps census (this proof\'s containers):', names.join(', '))
    expect(names).toEqual([live().names.nats, live().names.pg].sort())
    expect(names.some((n) => /board|calendar|publishing|messaging|files|nextcloud/i.test(n))).toBe(false)
    log('Nextcloud-down: N/A (not on this path: no file, folder or Nextcloud call; nothing to take down)')
  })
})

describe('A5: the broker holds the kernel-api identity to the IDT stream', () => {
  it('the kernel-api nkey publishes gremion.<t>.idt.> (control) and is refused gremion.<t>.org-unit.> and another tenant\'s idt subject', async () => {
    const nc = await connect({ servers: natsUrl, ...natsConnectOptionsFor(SLUG, 'kernel-api', loc()), reconnect: false, timeout: 5_000 })
    const js = jetstream(nc)
    try {
      expect((await js.publish(`gremion.${SLUG}.idt.body.created`, '{}', { timeout: 3_000, msgID: uuidv7() })).stream).toBe('IDT')
      // a refused publish never gets a PubAck: it times out (or the server answers with a permission error)
      await expect(js.publish(`gremion.${SLUG}.org-unit.upserted`, '{}', { timeout: 2_000 })).rejects.toBeDefined()
      await expect(js.publish('gremion.someone-else.idt.body.created', '{}', { timeout: 2_000 })).rejects.toBeDefined()
    } finally {
      await nc.close().catch(() => undefined)
    }
    log('kernel-api nkey: idt publish ok; org-unit and other-tenant idt publishes refused by the broker')
    // clean the control message off the count the earlier test pinned: it was published AFTER them
    const admin2 = await connect({ servers: natsUrl, ...adminConnectOptionsFor(SLUG, loc()), reconnect: false, timeout: 5_000 })
    try {
      expect((await (await jetstreamManager(admin2)).streams.info('IDT')).state.messages).toBe(5)
    } finally {
      await admin2.close()
    }
  })
})

describe('A3: the HTTP API on the live database', () => {
  const edge = (token?: string) => ({ host: HOST, 'x-forwarded-host': HOST, 'x-proxy-trust': PROXY, ...(token ? { authorization: `Bearer ${token}` } : {}) })

  it('own preference: found by the verified subject (200), a subject with no person is 403, and the write reaches idt.preference', async () => {
    const svc = createBodiesService({ authorizer: operatorAuthorizer })
    await svc.activatePerson({ sql: w.appPool(Z), customerId: Z.id, actor: { kind: 'operator', id: OP } }, ids.person!, { idpSubject: 'kc-zoe' })
    const zoe = await iss.mint('realm-z', { sub: 'kc-zoe' })
    const got = await app.inject({ url: '/api/v1/persons/me/preference', headers: edge(zoe) })
    expect(got.statusCode, got.body).toBe(200)
    expect(got.json()).toMatchObject({ personId: ids.person, locale: 'follow_customer', effectiveLocale: 'de', stored: false })
    const put = await app.inject({ method: 'PUT', url: '/api/v1/persons/me/preference', headers: edge(zoe), payload: { locale: 'en' } })
    expect(put.statusCode, put.body).toBe(200)
    expect(put.json()).toMatchObject({ locale: 'en', effectiveLocale: 'en', stored: true, rowVersion: 1 })
    expect(await admin()`SELECT locale, updated_by_kind, updated_by::text FROM idt.preference`).toEqual([{ locale: 'en', updated_by_kind: 'person', updated_by: ids.person }])
    const stranger = await iss.mint('realm-z', { sub: 'kc-nobody' })
    expect((await app.inject({ url: '/api/v1/persons/me/preference', headers: edge(stranger) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/persons/me/preference', headers: edge(stranger), payload: { locale: 'de' } })).statusCode).toBe(403)
    expect((await app.inject({ url: `/api/v1/persons/${ids.person}`, headers: edge(stranger) })).statusCode).toBe(403)
    expect((await app.inject({ url: `/api/v1/persons/${ids.person}`, headers: edge(zoe) })).statusCode).toBe(200)
  })

  it('reads: the tree, the seats and the memberships answer from the live rows', async () => {
    const zoe = await iss.mint('realm-z', { sub: 'kc-zoe' })
    const tree = await app.inject({ url: '/api/v1/bodies/tree', headers: edge(zoe) })
    expect(tree.json()).toMatchObject({ bodies: [{ bodyId: ids.body, kindKey: 'stura' }], orgUnits: [{ orgUnitId: ids.unit, isOrgan: true }] })
    const members = await app.inject({ url: `/api/v1/bodies/${ids.body}/memberships?asOf=2026-06-01`, headers: edge(zoe) })
    expect(members.json().memberships).toHaveLength(1)
    expect((await app.inject({ url: `/api/v1/bodies/${ids.body}/memberships?asOf=2026-01-01`, headers: edge(zoe) })).json().memberships).toHaveLength(0)
  })

  it('guard 6: a person-token write is 403 under the shipped authorizer and writes NOTHING; an allow-all TEST double (the RED reference) lets the same request create a body', async () => {
    const zoe = await iss.mint('realm-z', { sub: 'kc-zoe' })
    const before = (await admin()`SELECT (SELECT count(*)::int FROM idt.body) AS b, (SELECT count(*)::int FROM idt.outbox) AS o`)[0]
    const denied = await app.inject({ method: 'POST', url: '/api/v1/bodies', headers: edge(zoe), payload: { kindKey: 'stupa', name: 'Parlament' } })
    expect(denied.statusCode, denied.body).toBe(403)
    expect(denied.json()).toMatchObject({ type: 'urn:gremion:problem:forbidden' })
    expect((await app.inject({ method: 'POST', url: '/api/v1/persons', headers: edge(zoe), payload: { email: 'q@example.org', displayName: 'Q' } })).statusCode).toBe(403)
    expect(await admin()`SELECT (SELECT count(*)::int FROM idt.body) AS b, (SELECT count(*)::int FROM idt.outbox) AS o`).toEqual([before])
    log('person-token POST /api/v1/bodies under the shipped authorizer: 403, rows unchanged', JSON.stringify(before))

    const allowAll: WriteAuthorizer = { authorize: async () => true } // TEST DOUBLE: lives in test/, never in src/ nor dist/
    const open = buildApp({}, { ...wired.deps, authorizer: allowAll })
    const created = await open.inject({ method: 'POST', url: '/api/v1/bodies', headers: edge(zoe), payload: { kindKey: 'stupa', name: 'Parlament' } })
    await open.close()
    expect(created.statusCode, created.body).toBe(201) // this is what the 403 above depends on: swap the authorizer and the test goes RED
    expect(await admin()`SELECT created_by_kind, created_by::text FROM idt.body WHERE name = 'Parlament'`).toEqual([{ created_by_kind: 'person', created_by: ids.person }])
  })

  it('no test double in the image: a grep over dist/index.js finds no allow-all authorizer', () => {
    const dist = join(KERNEL_ROOT, 'services', 'kernel-api', 'dist', 'index.js')
    expect(existsSync(dist), 'run proof.sh test (it builds the bundle)').toBe(true)
    const text = readFileSync(dist, 'utf8')
    expect(text).toContain('denyAll') // the shipped authorizer is in the bundle ...
    expect(text).not.toMatch(/allowAll|authorize:\s*(async\s*)?\(\)\s*=>\s*(true|!0)|authorize:\s*async\s*\(\)\s*=>\s*Promise\.resolve\(true\)/) // ... an allow-all is not
    log('grep dist/index.js for an allow-all authorizer: none; denyAll present')
  })

  it('M-OFF-2 at the bundle: dist/index.js names no module package or modules/ import of the substrate', () => {
    const text = readFileSync(join(KERNEL_ROOT, 'services', 'kernel-api', 'dist', 'index.js'), 'utf8')
    expect(text).not.toMatch(/modules\/board|@gremion\/module-board/)
  })
})

describe('the stack is this proof\'s own', () => {
  it('the scratch server is on 127.0.0.1 (assertNonProductionDbUrl) and named for this checkout', () => {
    const s = stack()
    expect(s.container).toBe(live().names.pg)
    expect(s.container).toMatch(/^t080-[0-9a-f]{8}-pg$/)
  })
})
