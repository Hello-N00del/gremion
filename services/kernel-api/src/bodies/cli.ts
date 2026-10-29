// services/kernel-api/src/bodies/cli.ts -- `kernel-api bodies <verb> --customer <id> [--operator <uuid>] [--json '<input>']`
// (TASK-080-a step e: the operator's engine interface to the domain service;
// the control panel / the executor call it, it is not an operator surface of
// its own -- R31-I4).
//
// Writes go through the SAME domain service as everything else (one tx, the
// outbox row in it) under operatorAuthorizer: the actor is kind 'operator'
// (created_by_kind = 'operator', created_by = --operator), a person never gets
// through it. The customer's runtime pool is resolved from the customer's OWN
// control row exactly as the service does (no environment fallback).
//
// Verbs:  status                       read-only counts + the outbox by relay state
//         create-body | create-org-unit | create-seat | create-wahlperiode
//         invite-person | start-membership | start-tenure     (--json = the service input)
// 080-b adds adopt-legacy here.
//
// Environment: KERNEL_API_CONTROL_DB_URL (the reader role suffices: two SELECTs).
import type { Sql } from '@gremion/db'
import postgres from 'postgres'
import { createTenantDb } from '../app/tenant-db.ts'
import { controlTenancyStore } from '../tenancy/store.ts'
import { allowsEnvRefs, createSecretResolver } from '../tenancy/secrets.ts'
import { operatorAuthorizer, type Actor } from './authz.ts'
import { BodiesError } from './errors.ts'
import { createBodiesService, type OpCtx } from './service.ts'
import { inCustomerTx } from './tx.ts'

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const WRITE_VERBS = ['create-body', 'create-org-unit', 'create-seat', 'create-wahlperiode', 'invite-person', 'start-membership', 'start-tenure'] as const
type WriteVerb = (typeof WRITE_VERBS)[number]

const USAGE = `usage: kernel-api bodies status --customer <id>
       kernel-api bodies <${WRITE_VERBS.join('|')}> --customer <id> --operator <uuid> --json '<input>'`

function parse(argv: readonly string[]): { verb: string; customer: string; operator?: string; json?: string } {
  const [verb, ...rest] = argv
  if (!verb) throw new Error('no verb')
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]
    const v = rest[i + 1]
    if (!k?.startsWith('--') || v === undefined || v.startsWith('--')) throw new Error(`bad argument ${JSON.stringify(k)}`)
    if (!['--customer', '--operator', '--json'].includes(k)) throw new Error(`unknown flag ${k}`)
    if (flags.has(k)) throw new Error(`${k} given twice`)
    flags.set(k, v)
  }
  const customer = flags.get('--customer')
  if (!customer || !UUID.test(customer)) throw new Error('--customer <customer id> is required')
  return { verb, customer, ...(flags.has('--operator') ? { operator: flags.get('--operator')! } : {}), ...(flags.has('--json') ? { json: flags.get('--json')! } : {}) }
}

export interface BodiesCliDeps {
  /** Test seam: the customer's pool and control row. */
  open?: (customerId: string, env: NodeJS.ProcessEnv) => Promise<{ sql: Sql; close(): Promise<void> }>
}

export async function runBodiesCli(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo, deps: BodiesCliDeps = {}): Promise<number> {
  let a: ReturnType<typeof parse>
  try {
    a = parse(argv)
  } catch (err) {
    io.err(`${USAGE}\n(${(err as Error).message})`)
    return 2
  }
  if (a.verb !== 'status' && !(WRITE_VERBS as readonly string[]).includes(a.verb)) {
    io.err(`${USAGE}\n(unknown verb ${JSON.stringify(a.verb)})`)
    return 2
  }
  if (a.verb !== 'status' && (!a.operator || !UUID.test(a.operator) || a.json === undefined)) {
    io.err(`${USAGE}\n(${a.verb} needs --operator <uuid> and --json)`)
    return 2
  }
  let handle: { sql: Sql; close(): Promise<void> }
  try {
    handle = await (deps.open ?? openFromEnv)(a.customer, env)
  } catch (err) {
    io.err(`kernel-api bodies: ${(err as Error).message}`)
    return 1
  }
  try {
    if (a.verb === 'status') {
      const s = await inCustomerTx(handle.sql, a.customer, async (tx) => {
        const [c] = await tx<Record<string, number>[]>`
          SELECT (SELECT count(*)::int FROM idt.body WHERE customer_id = ${a.customer}::uuid) AS bodies,
                 (SELECT count(*)::int FROM idt.org_unit WHERE customer_id = ${a.customer}::uuid) AS org_units,
                 (SELECT count(*)::int FROM idt.seat WHERE customer_id = ${a.customer}::uuid) AS seats,
                 (SELECT count(*)::int FROM idt.person WHERE customer_id = ${a.customer}::uuid) AS persons,
                 (SELECT count(*)::int FROM idt.membership WHERE customer_id = ${a.customer}::uuid) AS memberships,
                 (SELECT count(*)::int FROM idt.tenure WHERE customer_id = ${a.customer}::uuid) AS tenures`
        const outbox = await tx<{ relay_state: string; n: number }[]>`
          SELECT relay_state, count(*)::int AS n FROM idt.outbox WHERE customer_id = ${a.customer}::uuid GROUP BY relay_state ORDER BY relay_state`
        return { ...c, outbox: Object.fromEntries(outbox.map((o) => [o.relay_state, o.n])) }
      })
      io.out(`BODIES-STATUS customer=${a.customer} ${JSON.stringify(s)}`)
      return 0
    }
    let input: Record<string, unknown>
    try {
      input = JSON.parse(a.json!) as Record<string, unknown>
    } catch {
      io.err(`${USAGE}\n(--json is not valid JSON)`)
      return 2
    }
    const actor: Actor = { kind: 'operator', id: a.operator! }
    const ctx: OpCtx = { sql: handle.sql, customerId: a.customer, actor }
    const svc = createBodiesService({ authorizer: operatorAuthorizer })
    const run: Record<WriteVerb, (i: never) => Promise<unknown>> = {
      'create-body': (i) => svc.createBody(ctx, i),
      'create-org-unit': (i) => svc.createOrgUnit(ctx, i),
      'create-seat': (i) => svc.createSeat(ctx, i),
      'create-wahlperiode': (i) => svc.createWahlperiode(ctx, i),
      'invite-person': (i) => svc.invitePerson(ctx, i),
      'start-membership': (i) => svc.startMembership(ctx, i),
      'start-tenure': (i) => svc.startTenure(ctx, i),
    }
    const out = await run[a.verb as WriteVerb](input as never)
    io.out(`BODIES-RESULT verb=${a.verb} customer=${a.customer} ${JSON.stringify(out)}`)
    return 0
  } catch (err) {
    if (err instanceof BodiesError) {
      io.err(`BODIES-REFUSED verb=${a.verb} customer=${a.customer} ${err.message}${err.constraint ? ` [${err.constraint}]` : ''}`)
      return 1
    }
    io.err(`BODIES-FAILED verb=${a.verb} customer=${a.customer} ${(err as Error).message}`)
    return 1
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** The customer's own control row -> its runtime pool (kernelTargetResolver), the way the service opens it. */
async function openFromEnv(customerId: string, env: NodeJS.ProcessEnv): Promise<{ sql: Sql; close(): Promise<void> }> {
  const url = env.KERNEL_API_CONTROL_DB_URL
  if (!url?.trim()) throw new Error('KERNEL_API_CONTROL_DB_URL is not set; nothing was done')
  const control = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 }) as unknown as Sql
  try {
    const tenant = await controlTenancyStore(control).lookupId(customerId)
    if (!tenant) throw new Error(`no customer ${customerId} in the control registry`)
    if (tenant.status !== 'active') throw new Error(`customer ${customerId} is ${tenant.status}: nothing was done`)
    const db = createTenantDb({ resolveSecret: createSecretResolver({ env, allowEnvRefs: allowsEnvRefs(env) }), log: { info: () => {}, warn: () => {}, error: (m, f) => console.error(m, f) }, maxConnections: 2 })
    const sql = await db.sqlFor(tenant)
    return { sql, close: () => db.close() }
  } finally {
    await control.end({ timeout: 5 })
  }
}
