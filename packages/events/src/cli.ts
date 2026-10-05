// packages/events/src/cli.ts -- `events outbox-replay | outbox-requeue | dlq-list | dlq-replay | metrics`
//
//   events outbox-replay  --ctx <c> --customer <uuid> --tenant <slug> --subjects <file> [--module <m>] [--identity <i>] [--since <iso>]
//   events outbox-requeue --ctx <c> --customer <uuid> --event-id <uuid> [--module <m>]
//   events dlq-list       --tenant <slug>
//   events dlq-replay     --tenant <slug> --seq <n>
//   events metrics        --ctx <c> [--customer <uuid>] [--module <m>] [--consumer <name>]
//
// Two identifiers, as everywhere in the kernel: --customer is the customer id (a UUIDv7, the
// tenant-store key of the service database), --tenant is the tenant SLUG (the NATS account
// T_<slug> and the subject token, @gremion/nats-auth).
//
// outbox-replay / outbox-requeue / metrics run in the OWNING SERVICE's container (they open
// that service's database through tenant-store: GREMION_<MODULE>_PG_URL; --module defaults to
// the context code; metrics reads GREMION_CUSTOMER_ID when --customer is absent).
// outbox-replay publishes as the service's NATS identity (--identity, default the module).
// dlq-list / dlq-replay run as the tenant's admin (the tenant-create one-shot,
// docs/runbooks/dead-letter.md). NATS_URL, NATS_SECRETS_DIR as for `nats-auth`.
// --subjects is the service's event-type -> subject map: a JSON object whose values may
// contain {tenant}. Never prints a seed, a password or a message body.
import { readFileSync } from 'node:fs'
import { collectMetrics, renderMetrics } from './metrics.ts'
import { listDeadLetters, replayDeadLetter, replayOutbox, requeueOutbox } from './recovery.ts'

const USAGE = [
  'usage: events outbox-replay --ctx <c> --customer <uuid> --tenant <slug> --subjects <file> [--module <m>] [--identity <i>] [--since <iso>]',
  '       events outbox-requeue --ctx <c> --customer <uuid> --event-id <uuid> [--module <m>]',
  '       events dlq-list --tenant <slug>',
  '       events dlq-replay --tenant <slug> --seq <n>',
  '       events metrics --ctx <c> [--customer <uuid>] [--module <m>] [--consumer <name>]',
].join('\n')

type Flags = Record<string, string>

export class UsageError extends Error {
  override name = 'UsageError'
}

/** `--key value` pairs only; a repeated, unknown or valueless flag is a usage error. */
export function parseFlags(args: string[], allowed: readonly string[]): Flags {
  const out: Flags = {}
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]
    const v = args[i + 1]
    if (!k?.startsWith('--') || !allowed.includes(k.slice(2))) throw new UsageError(`unknown or misplaced argument ${JSON.stringify(k)}`)
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${k} needs a value`)
    if (k.slice(2) in out) throw new UsageError(`${k} given twice`)
    out[k.slice(2)] = v
  }
  return out
}

const need = (f: Flags, k: string): string => {
  const v = f[k]
  if (!v) throw new UsageError(`--${k} is required`)
  return v
}

/** The --subjects file: { "<event type>": "gremion.{tenant}.<stream segment>.<...>" }. */
export function loadSubjects(file: string, tenant: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' || !v) throw new UsageError(`--subjects ${file}: ${k} is not a subject string`)
    out[k] = v.replaceAll('{tenant}', tenant)
  }
  return out
}

export interface CliDeps {
  /** Opens the owning service's database for a customer; returns the handle and a closer. */
  openDb(customer: string, module: string): Promise<{ sql: import('@gremion/db').Sql; close(): Promise<void> }>
  /** Connects to NATS as a module identity (`admin` = the tenant admin) of a tenant slug. */
  openNats(tenant: string, identity: string): Promise<{ js: import('@nats-io/jetstream').JetStreamClient; jsm: import('@nats-io/jetstream').JetStreamManager; close(): Promise<void> }>
  out(text: string): void
}

async function realDeps(): Promise<CliDeps> {
  const { createTenantStore } = await import('@gremion/tenant-store')
  const { adminConnectOptionsFor, natsConnectOptionsFor } = await import('@gremion/nats-auth')
  const { connect } = await import('@nats-io/transport-node')
  const { jetstream, jetstreamManager } = await import('@nats-io/jetstream')
  return {
    async openDb(customer, module) {
      const store = createTenantStore({ maxConnections: 2 })
      return { sql: await store.openTenantDb(customer, module), close: () => store.close() }
    },
    async openNats(tenant, identity) {
      const url = process.env.NATS_URL
      if (!url) throw new UsageError('NATS_URL is unset (the tenant-create container carries it)')
      const opts = identity === 'admin' ? adminConnectOptionsFor(tenant) : natsConnectOptionsFor(tenant, identity)
      const nc = await connect({ servers: url, ...opts, reconnect: false, timeout: 5_000 })
      return { js: jetstream(nc), jsm: await jetstreamManager(nc), close: () => nc.close().then(() => undefined) }
    },
    out: (t) => process.stdout.write(t),
  }
}

export async function main(argv: string[], deps?: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv
  if (!['outbox-replay', 'outbox-requeue', 'dlq-list', 'dlq-replay', 'metrics'].includes(cmd ?? '')) {
    console.error(USAGE)
    return 2
  }
  try {
    const d = deps ?? (await realDeps())
    switch (cmd) {
      case 'outbox-replay': {
        const f = parseFlags(rest, ['ctx', 'customer', 'tenant', 'subjects', 'module', 'identity', 'since'])
        const [ctx, customer, tenant] = [need(f, 'ctx'), need(f, 'customer'), need(f, 'tenant')]
        const subjects = loadSubjects(need(f, 'subjects'), tenant)
        const since = f.since ? new Date(f.since) : undefined
        if (since && Number.isNaN(since.getTime())) throw new UsageError('--since is not an ISO date')
        const module = f.module ?? ctx
        const db = await d.openDb(customer, module)
        const nats = await d.openNats(tenant, f.identity ?? module)
        try {
          const r = await replayOutbox(db.sql, nats.js, { ctx, subjects, since, log: (l) => d.out(`${l}\n`) })
          d.out(`${JSON.stringify(r)}\n`)
        } finally {
          await nats.close()
          await db.close()
        }
        return 0
      }
      case 'outbox-requeue': {
        const f = parseFlags(rest, ['ctx', 'customer', 'event-id', 'module'])
        const [ctx, customer, eventId] = [need(f, 'ctx'), need(f, 'customer'), need(f, 'event-id')]
        const db = await d.openDb(customer, f.module ?? ctx)
        try {
          await requeueOutbox(db.sql, { ctx, eventId })
          d.out(`requeued ${eventId}: dead_lettered -> pending\n`)
        } finally {
          await db.close()
        }
        return 0
      }
      case 'dlq-list': {
        const tenant = need(parseFlags(rest, ['tenant']), 'tenant')
        const nats = await d.openNats(tenant, 'admin')
        try {
          for (const e of await listDeadLetters(nats.jsm)) d.out(`${JSON.stringify(e)}\n`)
        } finally {
          await nats.close()
        }
        return 0
      }
      case 'dlq-replay': {
        const f = parseFlags(rest, ['tenant', 'seq'])
        const tenant = need(f, 'tenant')
        const seq = Number(need(f, 'seq'))
        if (!Number.isInteger(seq) || seq < 1) throw new UsageError('--seq must be a positive integer')
        const nats = await d.openNats(tenant, 'admin')
        try {
          d.out(`${JSON.stringify(await replayDeadLetter(nats.jsm, nats.js, { seq, log: (l) => d.out(`${l}\n`) }))}\n`)
        } finally {
          await nats.close()
        }
        return 0
      }
      case 'metrics': {
        const f = parseFlags(rest, ['ctx', 'customer', 'module', 'consumer'])
        const ctx = need(f, 'ctx')
        const customer = f.customer ?? process.env.GREMION_CUSTOMER_ID
        if (!customer) throw new UsageError('--customer is required (or GREMION_CUSTOMER_ID in the container)')
        const db = await d.openDb(customer, f.module ?? ctx)
        try {
          d.out(renderMetrics(await collectMetrics(db.sql, { ctx, consumer: f.consumer })))
        } finally {
          await db.close()
        }
        return 0
      }
      default:
        console.error(USAGE)
        return 2
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n${USAGE}`)
      return 2
    }
    throw err
  }
}
