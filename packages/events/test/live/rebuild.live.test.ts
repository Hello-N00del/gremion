// Live group `rebuild` (TDD 14, TRD-422): JetStream is wiped with two consumers part-way through;
// the runbook's `nats-auth ensure` recreates the streams and its `events outbox-replay` republishes
// the published outbox rows; every consumer's projection then equals the control state.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConsumer, type ConsumerHandle } from '../../src/consumer.ts'
import { createRelay } from '../../src/relay.ts'
import { binOf, extractCommands, fill } from '../runbook-lib.ts'
import {
  asAdmin,
  asModule,
  closeAll,
  createOrgUnit,
  ensureTenant,
  IDT_DOMAIN,
  managerOf,
  newService,
  newTenantIds,
  projectionDomain,
  projector,
  renameOrgUnit,
  rows,
  runCli,
  SCRATCH,
  subjectsFor,
  uuidv7,
  waitFor,
  type Nats,
  type Service,
} from './harness.ts'
import type { JetStreamManager } from '@nats-io/jetstream'

const T = newTenantIds()
let idt: Service
let fin: Service
let brd: Service
let kernel: Nats
let finance: Nats
let financeJsm: JetStreamManager
let admin: Awaited<ReturnType<typeof asAdmin>>
const live: ConsumerHandle[] = []

const consumerOf = async (svc: Service, name: string): Promise<ConsumerHandle> => {
  const c = createConsumer({
    sql: svc.sql,
    ctx: svc.ctx,
    tenant: T.slug,
    module: 'finance',
    js: finance.js,
    jsm: financeJsm,
    stream: 'ORGUNIT',
    name,
    startFrom: 'all',
    handler: projector(svc.ctx),
    onError: () => {},
    log: () => {},
  })
  await c.start()
  live.push(c)
  return c
}
const stop = async (c: ConsumerHandle) => {
  await c.stop()
  live.splice(live.indexOf(c), 1)
}
const relayAll = () => createRelay({ sql: idt.sql, ctx: 'idt', js: kernel.js, subjects: subjectsFor(T.slug), onError: () => {}, log: () => {} }).runOnce()
const projected = (svc: Service) => rows<{ org_unit_id: string; name: string; version: string }>(svc, `SELECT org_unit_id, name, version FROM ${svc.ctx}.org_unit_projection ORDER BY org_unit_id`)
const control = () => rows<{ org_unit_id: string; name: string; version: string }>(idt, 'SELECT org_unit_id, name, row_version AS version FROM idt.org_unit ORDER BY org_unit_id')
const normal = (r: { org_unit_id: string; name: string; version: string }[]) => r.map((x) => `${x.org_unit_id}|${x.name}|${x.version}`)

beforeAll(async () => {
  await ensureTenant(T.slug)
  idt = await newService(T.customerId, T.slug, 'idt', IDT_DOMAIN)
  fin = await newService(T.customerId, T.slug, 'fin', projectionDomain('fin'))
  brd = await newService(T.customerId, T.slug, 'brd', projectionDomain('brd'))
  kernel = await asModule(T.slug, 'kernel')
  finance = await asModule(T.slug, 'finance')
  financeJsm = await managerOf(finance)
  admin = await asAdmin(T.slug)
})
afterAll(async () => {
  for (const c of live.splice(0)) await c.stop().catch(() => undefined)
  await closeAll()
})

describe('TDD 14 rebuild from the outbox (TRD-422)', () => {
  const cmds = extractCommands()
  const find = (tool: string, verb: string) => cmds.find((c) => c.tool === tool && c.args[0] === verb)!
  const subjectsFile = path.join(SCRATCH, `subjects-${T.slug}.json`)

  test('wipe JetStream with two consumers part-way; ensure recreates the streams; outbox-replay restores both projections to the control state', async () => {
    mkdirSync(SCRATCH, { recursive: true })
    writeFileSync(
      subjectsFile,
      JSON.stringify({ 'de.gremion.idt.orgunit.created.v1': 'gremion.{tenant}.org-unit.created', 'de.gremion.idt.orgunit.renamed.v1': 'gremion.{tenant}.org-unit.renamed' }),
    )
    const finC = await consumerOf(fin, 'rb-fin')
    const brdC = await consumerOf(brd, 'rb-brd')
    const [u1, u2, u3] = [uuidv7(), uuidv7(), uuidv7()]
    for (const [id, name] of [[u1, 'alpha'], [u2, 'beta'], [u3, 'gamma']] as const) await createOrgUnit(idt, { id, name })
    await relayAll()
    await waitFor('both consumers to apply the first three', async () => (await projected(fin)).length === 3 && (await projected(brd)).length === 3)

    // finance stops after 3 of 5; board after 4 of 5: two consumers part-way through.
    await stop(finC)
    await renameOrgUnit(idt, u1, 'alpha-renamed')
    await relayAll()
    await waitFor('board to apply the rename', async () => (await projected(brd)).find((r) => r.org_unit_id === u1)?.version === '2')
    await stop(brdC)
    await renameOrgUnit(idt, u2, 'beta-renamed')
    await relayAll()

    const want = normal(await control())
    expect(want).toHaveLength(3)
    expect(normal(await projected(fin)), 'finance is part-way').not.toEqual(want)
    expect(normal(await projected(brd)), 'board is part-way').not.toEqual(want)
    expect(Number((await rows<{ n: string }>(idt, "SELECT count(*) AS n FROM idt.outbox WHERE relay_state = 'published'"))[0]!.n)).toBe(5)

    // The wipe: the stream, its consumers, the DLQ stream.
    await admin.jsm.streams.delete('ORGUNIT')
    await admin.jsm.streams.delete('DLQ')
    await expect(admin.jsm.streams.info('ORGUNIT')).rejects.toThrow(/not found/i)
    await expect(admin.jsm.consumers.info('ORGUNIT', 'rb-fin')).rejects.toThrow(/not found/i)

    // The runbook, as written: ensure first (the streams are recreated by the admin), then the replay.
    runCli(binOf('nats-auth'), fill(find('nats-auth', 'ensure').args, { slug: T.slug, modules: 'finance' }))
    expect((await admin.jsm.streams.info('ORGUNIT')).state.messages).toBe(0)
    expect((await admin.jsm.streams.info('DLQ')).config.subjects).toContain('$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>')
    const out = runCli(
      binOf('events'),
      fill(find('events', 'outbox-replay').args, { slug: T.slug, customer: T.customerId, ctx: 'idt', service: 'kernel-api', identity: 'kernel', 'subjects-file': subjectsFile }),
    )
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({ republished: 5 })
    expect((await admin.jsm.streams.info('ORGUNIT')).state.messages).toBe(5)

    // Fresh durables (the old ones went with the stream): they start from the replayed history.
    await consumerOf(fin, 'rb-fin-2')
    await consumerOf(brd, 'rb-brd-2')
    await waitFor('both projections to equal the control state', async () => {
      const [f, b] = [normal(await projected(fin)), normal(await projected(brd))]
      return JSON.stringify(f) === JSON.stringify(want) && JSON.stringify(b) === JSON.stringify(want)
    }, 30_000)
    expect(normal(await projected(fin))).toEqual(want)
    expect(normal(await projected(brd))).toEqual(want)
    // The inbox absorbed what each had already applied: no event was applied twice.
    for (const svc of [fin, brd]) {
      const applied = await rows<{ applied: number }>(svc, `SELECT applied FROM ${svc.ctx}.org_unit_projection`)
      for (const a of applied) expect(a.applied, `${svc.ctx}: an event applied twice`).toBeLessThanOrEqual(2)
    }
  })

  test('the documented ensure keeps the tenant working: the DLQ stream and the module identities are intact', async () => {
    const info = await admin.jsm.streams.info('DLQ')
    expect(info.config.subjects).toEqual(['gremion.*.dlq.>', '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>'])
    const again = await asModule(T.slug, 'finance')
    expect((await again.js.consumers.get('ORGUNIT', 'rb-fin-2')).info).toBeTypeOf('function')
    expect(find('nats-auth', 'ensure').args).not.toContain('--suspend')
  })
})
