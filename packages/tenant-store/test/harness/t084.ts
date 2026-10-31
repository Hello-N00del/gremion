// packages/tenant-store/test/harness/t084.ts — TASK-084-a: the t084 specs' view
// of the ONE scratch container started by t084-stack.mjs. Every connection
// goes through assertScratchUrl: 127.0.0.1, the harness port, nothing else.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

export interface T084State {
  sha8: string
  port: number
  user: string
  container: string
  image: string
}

let cached: T084State | undefined

export function state(): T084State {
  if (cached) return cached
  const path = process.env.T084_STATE
  if (!path) throw new Error('T084_STATE is unset: run the specs through `pnpm --filter @gremion/tenant-store test:t084` (test/harness/t084-stack.mjs)')
  const s = JSON.parse(readFileSync(path, 'utf8')) as T084State
  if (s.sha8 !== process.env.T084_SCRATCH) throw new Error('the t084 scratch state does not belong to this run')
  cached = s
  return s
}

/** Fail closed unless `url` is this run's scratch server (127.0.0.1, the harness port). */
export function assertScratchUrl(url: string): void {
  const s = state()
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('[t084] refusing an unparseable database url')
  }
  const ok = (u.protocol === 'postgres:' || u.protocol === 'postgresql:') && u.hostname === '127.0.0.1' && u.port === String(s.port)
  if (!ok) throw new Error(`[t084] refusing a database url that is not this run's scratch server (${u.hostname}:${u.port})`)
}

function adminUrl(): string {
  const file = process.env.T084_ADMIN_URL_FILE
  if (!file) throw new Error('T084_ADMIN_URL_FILE is unset')
  return readFileSync(file, 'utf8').trim()
}

/** A url to `database` on the scratch server; user and password default to the harness admin. */
export function dbUrlFor(database: string, user?: string, password?: string): string {
  const u = new URL(adminUrl())
  u.pathname = `/${database}`
  if (user !== undefined) u.username = user
  if (password !== undefined) u.password = encodeURIComponent(password)
  const url = u.toString()
  assertScratchUrl(url)
  return url
}

/** The harness admin on the maintenance database `postgres`. */
export function admin(max = 2): postgres.Sql {
  return postgres(dbUrlFor('postgres'), { max, onnotice: () => {} })
}

/** The harness admin on `database`, optionally with a startup role (options=-c role=<role>). */
export function adminOn(database: string, opts: { max?: number; role?: string } = {}): postgres.Sql {
  if (opts.role !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(opts.role)) throw new Error(`[t084] refusing role ${JSON.stringify(opts.role)}`)
  return postgres(dbUrlFor(database), {
    max: opts.max ?? 2,
    onnotice: () => {},
    ...(opts.role ? { connection: { options: `-c role=${opts.role}` } } : { connection: { search_path: 'pg_catalog' } }),
  })
}

/** A LOGIN role's own connection to `database`. */
export function connectAs(database: string, user: string, password: string): postgres.Sql {
  return postgres(dbUrlFor(database, user, password), { max: 1, onnotice: () => {}, connect_timeout: 5 })
}

/** A fresh RFC 9562 version-7 uuid. */
export function uuidv7(): string {
  const b = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** A generated secret (never logged). */
export function genPassword(): string {
  return randomBytes(24).toString('base64url')
}
