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
// dlq-list / dlq-replay run in the tenant-create one-shot (docs/runbooks/dead-letter.md) as the
// tenant's admin, which reads and deletes DLQ entries; dlq-replay republishes as the PUBLISHER of
// the entry's stream (the admin may not publish stream subjects). NATS_URL, NATS_SECRETS_DIR as for `nats-auth`.
// --subjects is the service's event-type -> subject map: a JSON object whose values may
// contain {tenant}. Never prints a seed, a password or a message body.
import { readFileSync } from 'node:fs'
import { collectMetrics, renderMetrics } from './metrics.ts'
import { assertContext } from './plumbing.ts'
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

const assertedCtx = (ctx: string): string => (assertContext(ctx), ctx)

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
  /** The NATS identity that publishes a stream (FLOWS: exactly one per stream), or undefined. */
  streamPublisher(stream: string): string | undefined
  out(text: string): void
}

async function realDeps(): Promise<CliDeps> {
  const { createTenantStore } = await import('@gremion/tenant-store')
  const { adminConnectOptionsFor, natsConnectOptionsFor, FLOWS } = await import('@gremion/nats-auth')
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
    streamPublisher: (stream) => Object.entries(FLOWS).find(([, f]) => f.publishes.includes(stream))?.[0],
    out: (t) => process.stdout.write(t),
  }
}

/** Each verb's flags: the one table main() parses with and the runbook test checks the documented commands against. */
export const COMMANDS = {
  'outbox-replay': { allowed: ['ctx', 'customer', 'tenant', 'subjects', 'module', 'identity', 'since'], required: ['ctx', 'customer', 'tenant', 'subjects'] },
  'outbox-requeue': { allowed: ['ctx', 'customer', 'event-id', 'module'], required: ['ctx', 'customer', 'event-id'] },
  'dlq-list': { allowed: ['tenant'], required: ['tenant'] },
  'dlq-replay': { allowed: ['tenant', 'seq'], required: ['tenant', 'seq'] },
  metrics: { allowed: ['ctx', 'customer', 'module', 'consumer'], required: ['ctx'] },
} as const

export type Verb = keyof typeof COMMANDS

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The same token shape @gremion/nats-auth enforces for tenant slugs and module ids (subject token, account name, file name). */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const CONSUMER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const SHAPES: Readonly<Record<string, { re: RegExp; what: string }>> = {
  customer: { re: UUID_RE, what: 'a UUID' },
  'event-id': { re: UUID_RE, what: 'a UUID' },
  tenant: { re: SLUG_RE, what: 'a lower-case slug (a-z, 0-9, -)' },
  module: { re: SLUG_RE, what: 'a lower-case slug (a-z, 0-9, -)' },
  identity: { re: SLUG_RE, what: 'a lower-case slug (a-z, 0-9, -)' },
  consumer: { re: CONSUMER_RE, what: 'a consumer name (letters, digits, _ and -)' },
}

/** Every flag's SHAPE is checked before anything is opened: a malformed value is a usage error (exit 2), never a query or a subject. */
export function validateFlags(f: Flags): void {
  for (const [k, v] of Object.entries(f)) {
    const shape = SHAPES[k]
    if (shape && !shape.re.test(v)) throw new UsageError(`--${k} ${JSON.stringify(v)} is not ${shape.what}`)
  }
  if (f.ctx !== undefined && !/^[a-z]{2,4}$/.test(f.ctx)) throw new UsageError(`--ctx ${JSON.stringify(f.ctx)} is not a context code (2-4 lower-case letters)`)
  if (f.seq !== undefined && !/^[1-9][0-9]{0,15}$/.test(f.seq)) throw new UsageError('--seq must be a positive integer')
}

/** The verb and its flags, validated against COMMANDS: a UsageError names what is wrong. */
export function parseCommand(argv: string[]): { cmd: Verb; flags: Flags } {
  const [cmd, ...rest] = argv
  if (!cmd || !(cmd in COMMANDS)) throw new UsageError(`unknown command ${JSON.stringify(cmd ?? '')}`)
  const spec = COMMANDS[cmd as Verb]
  const flags = parseFlags(rest, spec.allowed)
  for (const r of spec.required) need(flags, r)
  validateFlags(flags)
  return { cmd: cmd as Verb, flags }
}

export async function main(argv: string[], deps?: CliDeps): Promise<number> {
  try {
    const { cmd, flags: f } = parseCommand(argv)
    const d = deps ?? (await realDeps())
    switch (cmd) {
      case 'outbox-replay': {
        const [ctx, customer, tenant] = [need(f, 'ctx'), need(f, 'customer'), need(f, 'tenant')]
        const subjects = loadSubjects(need(f, 'subjects'), tenant)
        const since = f.since ? new Date(f.since) : undefined
        if (since && Number.isNaN(since.getTime())) throw new UsageError('--since is not an ISO date')
        const module = f.module ?? ctx
        const db = await d.openDb(customer, module)
        let nats: Awaited<ReturnType<CliDeps['openNats']>> | undefined
        try {
          // --customer picks the database, --tenant the NATS account and subjects: a pair that does not
          // belong together would publish one tenant's events into another's streams. Refuse it first.
          const bound = await db.sql.unsafe<{ tenant_token: string }[]>(`SELECT tenant_token FROM ${assertedCtx(ctx)}.database_binding`)
          const token = bound[0]?.tenant_token
          if (bound.length !== 1 || token !== tenant) {
            throw new UsageError(`--customer ${customer} is bound to tenant ${JSON.stringify(token ?? null)}, not --tenant ${JSON.stringify(tenant)}: refusing to replay into another tenant's streams`)
          }
          const conn = (nats = await d.openNats(tenant, f.identity ?? module))
          const r = await replayOutbox(db.sql, conn.js, { ctx, subjects, since, log: (l) => d.out(`${l}\n`) })
          d.out(`${JSON.stringify(r)}\n`)
        } finally {
          await nats?.close()
          await db.close()
        }
        return 0
      }
      case 'outbox-requeue': {
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
        const tenant = need(f, 'tenant')
        const nats = await d.openNats(tenant, 'admin')
        try {
          for (const e of await listDeadLetters(nats.jsm)) d.out(`${JSON.stringify(e)}\n`)
        } finally {
          await nats.close()
        }
        return 0
      }
      case 'dlq-replay': {
        const tenant = need(f, 'tenant')
        const seq = Number(need(f, 'seq'))
        if (!Number.isInteger(seq) || seq < 1) throw new UsageError('--seq must be a positive integer')
        // The admin reads the entry and deletes it; it may NOT publish stream subjects (TASK-024), so the
        // re-delivery goes out as the target stream's publisher (FLOWS: exactly one per stream).
        const nats = await d.openNats(tenant, 'admin')
        const publishers: { close(): Promise<void> }[] = []
        try {
          const publisherOf = async (stream: string) => {
            const identity = d.streamPublisher(stream)
            if (!identity) throw new UsageError(`no NATS identity publishes stream ${stream}: the entry cannot be replayed (use outbox-replay)`)
            const p = await d.openNats(tenant, identity)
            publishers.push(p)
            return p.js
          }
          d.out(`${JSON.stringify(await replayDeadLetter(nats.jsm, publisherOf, { seq, log: (l) => d.out(`${l}\n`) }))}\n`)
        } finally {
          for (const p of publishers) await p.close()
          await nats.close()
        }
        return 0
      }
      case 'metrics': {
        const ctx = need(f, 'ctx')
        const customer = f.customer ?? process.env.GREMION_CUSTOMER_ID
        if (!customer) throw new UsageError('--customer is required (or GREMION_CUSTOMER_ID in the container)')
        validateFlags({ customer })
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
