// The live-stack harness for scripts/proof.sh: a real Postgres 18 and the kernel's authenticated
// NATS (scripts/stack.mjs). Every database handle comes through @gremion/tenant-store and every
// NATS identity through @gremion/nats-auth (TRD-426, TASK-024): nothing here opens a connection
// of its own. Run only under proof.sh (EVENTS_PROOF=1, EVENTS_STATE=<state.json>).
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Sql } from '@gremion/db'
import { adminConnectOptionsFor, ensureTenantAccount, natsBrokerOps, natsConnectOptionsFor } from '@gremion/nats-auth'
import { createTenantStore, openMigrationDb, runMigrations, type TenantStore } from '@gremion/tenant-store'
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/nats-core'
import { connect } from '@nats-io/transport-node'
import { inTenantTx } from '../../src/db.ts'
import { plumbingSql } from '../../src/plumbing.ts'

export const REPO = path.resolve(import.meta.dirname, '../../../..')
const STATE_FILE = process.env.EVENTS_STATE ?? ''
if (!process.env.EVENTS_PROOF || !STATE_FILE) {
  throw new Error('[events-proof] run through packages/events/scripts/proof.sh (EVENTS_PROOF/EVENTS_STATE unset)')
}

interface StackState {
  prefix: string
  names: { pg: string; nats: string }
  secretsDir: string
  accountsDir: string
  pg: { port: number; user: string; password: string }
  nats: { port: number }
}
export const STACK = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState
export const NATS_URL = `nats://127.0.0.1:${STACK.nats.port}`
export const SECRETS = STACK.secretsDir
export const ACCOUNTS = STACK.accountsDir
export const loc = { secretsDir: SECRETS }
export const SCRATCH = path.join(REPO, '.scratch', 't079')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The service role: NOSUPERUSER, so FORCE ROW LEVEL SECURITY applies to it. */
const SVC_USER = 't079_svc'
const SVC_PASSWORD = randomBytes(12).toString('base64url')

/** psql as the harness superuser inside the Postgres container (local socket). Setup only. */
export function psql(sql: string, db = 'postgres'): string {
  return execFileSync('docker', ['exec', STACK.names.pg, 'psql', '-U', STACK.pg.user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    encoding: 'utf8',
  }).trim()
}

/** A UUIDv7 (RFC 9562): 48-bit unix ms, version 7, random rest. */
export function uuidv7(): string {
  const b = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const dbNameOf = (customer: string, ctx: string) => `t_${customer.replaceAll('-', '')}__${ctx}`
const svcUrl = (db: string) => `postgres://${SVC_USER}:${encodeURIComponent(SVC_PASSWORD)}@127.0.0.1:${STACK.pg.port}/${db}`
const resolveTarget = (customer: string, module: string) => ({ url: svcUrl(dbNameOf(customer, module)) })

let roleMade = false
function ensureRole(): void {
  if (roleMade) return
  psql(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SVC_USER}') THEN CREATE ROLE ${SVC_USER} LOGIN NOSUPERUSER; END IF; END $$`)
  // Every process sets its own password: the role outlives one test file within a stack.
  psql(`ALTER ROLE ${SVC_USER} LOGIN NOSUPERUSER PASSWORD '${SVC_PASSWORD}'`)
  roleMade = true
}

const stores: TenantStore[] = []
const closers: (() => Promise<unknown>)[] = []

export interface Service {
  ctx: string
  sql: Sql
  customerId: string
}

/** Creates the database t_<customer>__<ctx> owned by the service role, binds it, migrates the plumbing + `domainSql`. */
export async function newService(customerId: string, slug: string, ctx: string, domainSql: string): Promise<Service> {
  ensureRole()
  const db = dbNameOf(customerId, ctx)
  psql(`CREATE DATABASE "${db}" OWNER ${SVC_USER}`)
  const dir = path.join(SCRATCH, 'mig', db)
  mkdirSync(dir, { recursive: true })
  // The service's first migration: the plumbing block byte-for-byte, then its own tables.
  const file = '0001_init.sql'
  const text = `${plumbingSql(ctx)}\n${domainSql}\n`
  writeFileSync(path.join(dir, file), text)
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ [file]: createHash('sha256').update(text).digest('hex') }, null, 2)}\n`)
  const mig = await openMigrationDb(customerId, ctx, { resolveTarget })
  try {
    await runMigrations({ sql: mig, dir, releaseRef: 'dist-v0.0.1', log: () => {} })
    // Provisioning writes the binding (SCHEMA §0.6): one row, the customer and context this database serves.
    await mig.unsafe(`INSERT INTO ${ctx}.database_binding (customer_id, tenant_token, context_code) VALUES ($1, $2, $3)`, [customerId, slug, ctx])
  } finally {
    await mig.end({ timeout: 5 })
  }
  const store = createTenantStore({ resolveTarget, maxConnections: 6, onError: () => {} })
  stores.push(store)
  return { ctx, sql: await store.openTenantDb(customerId, ctx), customerId }
}

export interface Nats {
  nc: NatsConnection
  js: JetStreamClient
}

async function open(opts: ReturnType<typeof natsConnectOptionsFor>): Promise<Nats> {
  const nc = await connect({ servers: NATS_URL, ...opts, reconnect: false, timeout: 5_000 })
  closers.push(() => nc.close())
  return { nc, js: jetstream(nc) }
}

/** A module identity of a tenant, through TASK-024's natsConnectOptionsFor (the only way in). */
export const asModule = (slug: string, module: string) => open(natsConnectOptionsFor(slug, module, loc))
export async function asAdmin(slug: string): Promise<Nats & { jsm: JetStreamManager }> {
  const c = await open(adminConnectOptionsFor(slug, loc))
  return { ...c, jsm: await jetstreamManager(c.nc) }
}
export async function managerOf(c: Nats): Promise<JetStreamManager> {
  return jetstreamManager(c.nc)
}

/** nats-auth `ensure` for a tenant slug against the scratch broker (creates the account, its users, its streams and the DLQ). */
export async function ensureTenant(slug: string, modules: string[] = ['finance']): Promise<void> {
  await ensureTenantAccount({ tenant: slug, modules }, { secretsDir: SECRETS, accountsDir: ACCOUNTS, broker: natsBrokerOps({ url: NATS_URL, secretsDir: SECRETS }) })
}

export interface Tenant {
  slug: string
  customerId: string
}

export function newTenantIds(): Tenant {
  return { slug: `tn${randomBytes(5).toString('hex')}`, customerId: uuidv7() }
}

/** Rows of `table` through the service's tenant context (the RLS policies see only this customer). */
export async function rows<T = Record<string, unknown>>(svc: Service, query: string, params: unknown[] = []): Promise<T[]> {
  return inTenantTx(svc.sql, svc.ctx, (tx) => tx.unsafe<T[]>(query, params as never[]))
}
export async function count(svc: Service, table: string, where = 'true', params: unknown[] = []): Promise<number> {
  return Number((await rows<{ n: string }>(svc, `SELECT count(*) AS n FROM ${svc.ctx}.${table} WHERE ${where}`, params))[0]!.n)
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000, every = 100): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(every)
  }
}

export async function closeAll(): Promise<void> {
  for (const c of closers.splice(0)) await c().catch(() => undefined)
  for (const s of stores.splice(0)) await s.close().catch(() => undefined)
}

/** The service-injected subject map of the F1 flow (Q7): the kernel publishes into ORGUNIT. */
export const subjectsFor = (slug: string): Record<string, string> => ({
  'de.gremion.idt.orgunit.created.v1': `gremion.${slug}.org-unit.created`,
  'de.gremion.idt.orgunit.renamed.v1': `gremion.${slug}.org-unit.renamed`,
})

/** The producer's domain table: an org unit and its row_version (the aggregate version). */
export const IDT_DOMAIN = `
CREATE TABLE idt.org_unit (
  org_unit_id  uuid        PRIMARY KEY,
  customer_id  uuid        NOT NULL,
  name         text        NOT NULL,
  row_version  bigint      NOT NULL DEFAULT 1
);`

/** A consumer's projection of org units, plus a counter of how often the effect ran. */
export const projectionDomain = (ctx: string) => `
CREATE TABLE ${ctx}.org_unit_projection (
  org_unit_id  uuid        PRIMARY KEY,
  customer_id  uuid        NOT NULL,
  name         text        NOT NULL,
  version      bigint      NOT NULL,
  applied      integer     NOT NULL DEFAULT 1
);`

/** The producer side of one domain change: state + enqueue in ONE transaction (what a service does). */
export async function createOrgUnit(idt: Service, input: { id: string; name: string; testRunId?: string; traceparent?: string | null }): Promise<string> {
  const { enqueue } = await import('../../src/enqueue.ts')
  return inTenantTx(idt.sql, 'idt', async (tx) => {
    await tx.unsafe('INSERT INTO idt.org_unit (org_unit_id, customer_id, name) VALUES ($1, idt.current_customer_id(), $2)', [input.id, input.name])
    return enqueue(tx, {
      eventType: 'de.gremion.idt.orgunit.created.v1',
      source: '/gremion/idt',
      aggregate: { type: 'orgunit', id: input.id, version: 1 },
      data: { orgUnitId: input.id, name: input.name.replaceAll(' ', '_') },
      traceparent: input.traceparent ?? null,
      testRunId: input.testRunId ?? null,
    })
  })
}

/** Renames an org unit (row_version + 1) and enqueues the renamed event at that version. */
export async function renameOrgUnit(idt: Service, id: string, name: string): Promise<{ eventId: string; version: number }> {
  const { enqueue } = await import('../../src/enqueue.ts')
  return inTenantTx(idt.sql, 'idt', async (tx) => {
    const [r] = await tx.unsafe<{ row_version: string }[]>('UPDATE idt.org_unit SET name = $2, row_version = row_version + 1 WHERE org_unit_id = $1 RETURNING row_version', [id, name])
    const version = Number(r!.row_version)
    const eventId = await enqueue(tx, {
      eventType: 'de.gremion.idt.orgunit.renamed.v1',
      source: '/gremion/idt',
      aggregate: { type: 'orgunit', id, version },
      data: { orgUnitId: id, name: name.replaceAll(' ', '_') },
    })
    return { eventId, version }
  })
}

/** The consumer's effect for context `ctx`: upsert the projection, counting applications. */
export const projector =
  (ctx: string) =>
  async (tx: Sql, ev: { payload: Record<string, unknown>; aggregate: { version: number } }): Promise<void> => {
    await tx.unsafe(
      `INSERT INTO ${ctx}.org_unit_projection (org_unit_id, customer_id, name, version)
       VALUES ($1, ${ctx}.current_customer_id(), $2, $3)
       ON CONFLICT (org_unit_id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, applied = ${ctx}.org_unit_projection.applied + 1`,
      [ev.payload.orgUnitId as string, ev.payload.name as string, ev.aggregate.version],
    )
  }

/** A publisher that counts publishes (by message id and aggregate version) and can fail chosen ones. */
export function countingPublisher(js: JetStreamClient, failWhen: (call: { subject: string; msgId: string; version: number }) => boolean = () => false) {
  const calls: { subject: string; msgId: string; version: number; duplicate?: boolean; failed?: boolean }[] = []
  const publisher = {
    publish: async (subject: string, data: Uint8Array | string, opts: { msgID?: string; headers?: { get(k: string): string } }) => {
      const call: (typeof calls)[number] = { subject, msgId: opts.msgID ?? '', version: Number(opts.headers?.get('Gremion-Aggregate-Version') ?? 0) }
      calls.push(call)
      if (failWhen(call)) {
        call.failed = true
        // A row-specific failure (the relay counts it); a transport failure would burn no attempt.
        throw Object.assign(new Error('simulated row failure'), { name: 'PermissionViolationError' })
      }
      const ack = await js.publish(subject, data, opts as never)
      call.duplicate = ack.duplicate
      return ack
    },
  }
  return { calls, publisher: publisher as unknown as Pick<JetStreamClient, 'publish'> }
}

/** The environment of the tenant-create container, in the scratch stack: what `pnpm exec events|nats-auth` reads. */
export function cliEnv(): NodeJS.ProcessEnv {
  const base = `postgres://${SVC_USER}:${encodeURIComponent(SVC_PASSWORD)}@127.0.0.1:${STACK.pg.port}/x`
  return {
    ...process.env,
    NATS_URL,
    NATS_SECRETS_DIR: SECRETS,
    NATS_ACCOUNTS_DIR: ACCOUNTS,
    GREMION_IDT_PG_URL: base,
    GREMION_FIN_PG_URL: base,
    GREMION_BRD_PG_URL: base,
  }
}

/** Runs `node <bin> <args>` (the scratch equivalent of `pnpm exec <tool>` in the migrate image); returns stdout. */
export function runCli(bin: string, args: string[]): string {
  return execFileSync(process.execPath, [bin, ...args], { env: cliEnv(), encoding: 'utf8', timeout: 60_000 })
}
