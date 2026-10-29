// TASK-080-a round 3 (HIGH, G6) -- the image-level proof, driven by test/bodies/image-proof.sh. Not a unit test
// (no *.test.ts name, its own config vitest.image.config.ts): the kernel-api IMAGE, started from the real
// docker-compose.app.yml `kernel-api` service in a compose project t080-<sha8>, with its NATS seed read through the
// real subpath mount, against PG18 and the authenticated NATS, seeds written by the TENANT-CREATE IMAGE (root).
//
//   T080_IMAGE_MODE=world     control + gremion_platform + reader role (no customer yet)
//   T080_IMAGE_MODE=customer  one customer with ZERO modules; its kernel db url becomes a file: ref in the tenants mount
//   T080_IMAGE_MODE=drive     operator writes (host, the customer's app pool) -> the CONTAINER's relay publishes them;
//                             post-conditions quoted: outbox states, IDT message count read from the broker
// State: T080_IMAGE_STATE (written by image-proof.sh, results merged back into it).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { adminConnectOptionsFor } from '@gremion/nats-auth'
import { jetstreamManager } from '@nats-io/jetstream'
import { connect as natsConnect } from '@nats-io/transport-node'
import { expect, it } from 'vitest'
import { operatorAuthorizer } from '../../src/bodies/authz.ts'
import { createBodiesService } from '../../src/bodies/service.ts'
import { kernelDatabaseOf } from '../../src/tenancy/target.ts'
import { buildWorld, connect, CONTROL_DB, createCustomer, READER_ROLE, stack, uuidv7, type ScratchWorld } from '../harness/scratch.ts'
import { connect as pgConnect } from '../harness/scratch.ts'

const statePath = process.env.T080_IMAGE_STATE!
const st = JSON.parse(readFileSync(statePath, 'utf8')) as ReturnType<typeof stack> & Record<string, any>
// vitest buffers console output of a passing run: the quoted post-conditions go to a file image-proof.sh prints
const log = (...a: unknown[]) => appendFileSync(join(dirname(statePath), 'evidence.log'), `[image-proof] ${a.join(' ')}
`)
const inNet = (u: string) => {
  const x = new URL(u)
  x.hostname = st.hosts.pg
  x.port = '5432'
  return x.toString()
}
const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2))

it(`image proof ${process.env.T080_IMAGE_MODE}`, { timeout: 240_000 }, async () => {
  const mode = process.env.T080_IMAGE_MODE
  if (mode === 'world') {
    const world = await buildWorld()
    st.readerControlUrl = inNet(world.readerControlUrl)
    st.readerPlatformUrl = inNet(world.readerPlatformUrl)
    const u = new URL(world.readerControlUrl)
    st.reader = { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), role: READER_ROLE, controlDb: CONTROL_DB }
    await world.close()
    log('world seeded: control, gremion_platform, reader role; customers: 0')
  } else if (mode === 'customer') {
    const world: ScratchWorld = {
      admin: connect(st.db), control: connect(CONTROL_DB), platform: connect('gremion_platform'), env: {},
      readerControlUrl: '', readerPlatformUrl: '', catalogueSize: 0, async close() {},
    }
    const slug = 'img-z'
    const Z = await createCustomer(world, slug, 'img-z.example.org', { realm: 'realm-z', issuer: 'https://img-z.example.org/realms/realm-z', kcInternal: 'http://127.0.0.1:1/realms/realm-z' })
    const envName = Z.ref.slice('env:'.length)
    writeFileSync(join(st.tenantsDir, `${slug}.dburl`), inNet(world.env[envName]!))
    await world.control`UPDATE tenant SET db_conn_ref = ${`file:/run/secrets/tenants/${slug}.dburl`} WHERE id = ${Z.id}::uuid`
    st.customer = { id: Z.id, slug, appPassword: Z.appPassword }
    const [n] = await world.platform<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.module_enablement WHERE customer_id = ${Z.id}::uuid`
    log(`customer ${slug} ${Z.id}: plt.module_enablement rows = ${n!.n} (the zero-module customer)`)
    expect(n!.n).toBe(0)
    await Promise.all([world.admin.end({ timeout: 5 }), world.control.end({ timeout: 5 }), world.platform.end({ timeout: 5 })])
  } else if (mode === 'drive') {
    const { id, slug, appPassword } = st.customer as { id: string; slug: string; appPassword: string }
    const hex = id.replaceAll('-', '')
    const db = kernelDatabaseOf(id)
    const admin = connect(db, { max: 2 })
    const app = pgConnect(db, { user: `k_${hex}_app`, password: appPassword, max: 3 })
    try {
      const run = uuidv7().slice(-6) // re-runnable: body and unit names are unique per customer
      const svc = createBodiesService({ authorizer: operatorAuthorizer })
      const ctx = { sql: app, customerId: id, actor: { kind: 'operator' as const, id: uuidv7() } }
      const body = await svc.createBody(ctx, { kindKey: 'stura', name: `Studierendenrat ${run}`, shortName: 'StuRa' })
      const unit = await svc.createOrgUnit(ctx, { bodyId: body.bodyId, kindKey: 'council', name: `Plenum ${run}` })
      const person = await svc.invitePerson(ctx, { email: `zoe-${uuidv7()}@example.org`, displayName: 'Zoe Zero' })
      await svc.startMembership(ctx, { personId: person.personId, bodyId: body.bodyId, orgUnitId: unit.orgUnitId, participationKind: 'elected_member', voting: true, validFrom: '2026-04-01', source: 'admin' })
      const [total] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM idt.outbox`
      log(`operator wrote body, org unit, person, membership: idt.outbox rows = ${total!.n}`)
      // the relay lives in the kernel-api CONTAINER (reconcile every 30 s, poll 1 s)
      const deadline = Date.now() + 120_000
      let states: { relay_state: string; n: number }[] = []
      for (;;) {
        states = await admin<{ relay_state: string; n: number }[]>`SELECT relay_state, count(*)::int AS n FROM idt.outbox GROUP BY relay_state ORDER BY relay_state`
        if (states.length === 1 && states[0]!.relay_state === 'published') break
        if (Date.now() > deadline) throw new Error(`the container relay did not publish within 120 s: ${JSON.stringify(states)}`)
        await new Promise((r) => setTimeout(r, 2_000))
      }
      log(`idt.outbox relay_state after the container relay: ${JSON.stringify(states)}`)
      expect(states).toEqual([{ relay_state: 'published', n: total!.n }])
      const nc = await natsConnect({ servers: `nats://127.0.0.1:${st.natsPort}`, ...adminConnectOptionsFor(slug, { secretsDir: st.secretsCopy }), reconnect: false, timeout: 5_000 })
      try {
        const jsm = await jetstreamManager(nc)
        const info = await jsm.streams.info('IDT')
        log(`JetStream IDT stream (read from the broker inside the stack): messages=${info.state.messages} subjects=${JSON.stringify(info.config.subjects)}`)
        expect(info.state.messages).toBe(total!.n)
      } finally {
        await nc.close()
      }
      const [c] = await admin<Record<string, number>[]>`SELECT (SELECT count(*)::int FROM idt.body) AS bodies, (SELECT count(*)::int FROM idt.org_unit) AS org_units, (SELECT count(*)::int FROM idt.person) AS persons, (SELECT count(*)::int FROM idt.membership) AS memberships`
      log(`row counts ${JSON.stringify(c)}`)
      const [x] = await admin<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'idt.membership'::regclass AND contype = 'x'`
      log(`\\d idt.membership EXCLUDE: ${x!.def}`)
      st.drive = { outbox: total!.n, states }
    } finally {
      await Promise.allSettled([admin.end({ timeout: 3 }), app.end({ timeout: 3 })])
    }
  } else {
    throw new Error('T080_IMAGE_MODE must be world|customer|drive')
  }
  save()
})
