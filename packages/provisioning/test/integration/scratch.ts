// Shared by the TASK-043d integration specs: the scratch server of run.mjs,
// gremion_platform bootstrapped (idempotent; platform.int.test.ts runs first,
// vitest.integration.config.ts), the panel and executor roles made exactly as
// `gremion-tenant init` makes them, and a TCP login for each (the real
// executor role has NO password and reaches the server over the local socket
// only; a test twin with the same grants carries one so a pool can connect).
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres, { type Sql } from 'postgres'
import { bootstrapPlatform, ensureExecutorRole, ensurePanelRequester, loadModuleJsons } from '../../src/index.ts'

export const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
export const OWNER = 't043_platform'

export function adminUrl(db = 'postgres', user?: string, password?: string): string {
  const raw = process.env.T043_PG_ADMIN_URL
  if (!raw) throw new Error('T043_PG_ADMIN_URL is unset: run through `pnpm test:integration` (test/integration/run.mjs)')
  const u = new URL(raw)
  if (u.hostname !== '127.0.0.1' || decodeURIComponent(u.username) !== 't043_admin') throw new Error('[t043d] refusing a database url that is not the scratch server')
  u.pathname = `/${db}`
  if (user) u.username = user
  if (password) u.password = encodeURIComponent(password)
  return u.toString()
}

export const open = (db = 'postgres', max = 2, user?: string, password?: string): Sql =>
  postgres(adminUrl(db, user, password), { max, onnotice: () => {}, connect_timeout: 10 })

/** The docker name run.mjs gave the scratch server. */
export const scratchContainer = (): string => {
  const sha8 = process.env.T043_SCRATCH
  if (!sha8 || !/^[0-9a-f]{8}$/.test(sha8)) throw new Error('T043_SCRATCH is unset: run through `pnpm test:integration`')
  return `t043-${sha8}-pg`
}

export const code = (q: Promise<unknown>): Promise<string> => q.then(() => 'ok', (e: { code?: string }) => e.code ?? 'no-sqlstate')
export const failure = (q: Promise<unknown>): Promise<{ code: string; message: string } | null> =>
  q.then(
    () => null,
    (e: { code?: string; message?: string }) => ({ code: e.code ?? 'no-sqlstate', message: e.message ?? '' }),
  )

export interface Roles {
  admin: Sql
  owner: Sql
  ownerPassword: string
  control: string
  panelRole: string
  panelPassword: string
  /** A pool AS the panel role on gremion_platform / on the control registry. */
  panel: Sql
  panelControl: Sql
  /** A pool AS the executor's test twin (same grants and marker, plus a password). */
  executor: Sql
  executorRole: string
  close(): Promise<void>
}

export async function setupRoles(tag: string): Promise<Roles> {
  const admin = open('postgres', 2)
  const ownerPassword = randomBytes(24).toString('base64url')
  await bootstrapPlatform({
    kernelAdmin: admin,
    openPlatform: () => open('gremion_platform', 2, OWNER, ownerPassword),
    owner: OWNER,
    ownerPassword,
    releaseRef: 'dist-v0.0.1',
    catalogue: loadModuleJsons(resolve(REPO, 'modules')),
  })
  const control = `t043d_${tag}_control`
  if ((await admin`SELECT 1 FROM pg_database WHERE datname = ${control}`).length === 0) await admin.unsafe(`CREATE DATABASE ${control}`)
  const c = open(control, 1)
  try {
    await c.unsafe(`CREATE TABLE IF NOT EXISTS tenant (id uuid PRIMARY KEY, slug text NOT NULL, status text NOT NULL DEFAULT 'active');
                    CREATE TABLE IF NOT EXISTS tenant_domain (host text PRIMARY KEY, tenant_id uuid NOT NULL, is_primary boolean NOT NULL DEFAULT true);
                    CREATE TABLE IF NOT EXISTS tenant_secret_ref (tenant_id uuid PRIMARY KEY, ref text)`)
  } finally {
    await c.end()
  }
  const panelRole = `t043d_${tag}_panel`
  const panelPassword = randomBytes(24).toString('base64url')
  const openAdminOn = (db: string) => open(db, 1)
  await ensurePanelRequester({ kernelAdmin: admin, openAdminOn, role: panelRole, password: panelPassword, controlDatabase: control })
  const executorRole = `t043d_${tag}_exec`
  await ensureExecutorRole({ kernelAdmin: admin, openAdminOn, role: executorRole })
  const execPassword = randomBytes(24).toString('base64url')
  await admin.unsafe(`ALTER ROLE ${executorRole} PASSWORD '${execPassword}'`)
  const owner = open('gremion_platform', 3, OWNER, ownerPassword)
  const panel = open('gremion_platform', 2, panelRole, panelPassword)
  const panelControl = open(control, 1, panelRole, panelPassword)
  const executor = open('gremion_platform', 2, executorRole, execPassword)
  return {
    admin,
    owner,
    ownerPassword,
    control,
    panelRole,
    panelPassword,
    panel,
    panelControl,
    executor,
    executorRole,
    async close() {
      await Promise.all([owner, panel, panelControl, executor].map((p) => p.end({ timeout: 5 }).catch(() => {})))
      await admin.end({ timeout: 5 })
    },
  }
}

/** A submit call with every argument named; `over` replaces any of them. */
export function submitArgs(over: Partial<SubmitArgs> = {}): SubmitArgs {
  const now = new Date()
  return {
    kind: 'create',
    slug: 'musterstadt',
    args: { slug: 'musterstadt', host: 'rat.musterstadt.example' },
    key: crypto.randomUUID(),
    operator: '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33',
    acr: 'loa2',
    authTime: new Date(now.getTime() - 60_000),
    sessionAt: new Date(now.getTime() - 30_000),
    token: 'e'.repeat(300),
    reason: null,
    hostActor: null,
    ...over,
  }
}
export interface SubmitArgs {
  kind: string | null
  slug: string | null
  args: unknown
  key: string | null
  operator: string | null
  acr: string | null
  authTime: Date | null
  sessionAt: Date | null
  token: string | null
  reason: string | null
  hostActor: string | null
}

export function submit(sql: Sql, a: SubmitArgs) {
  return sql<{ id: string }[]>`
    SELECT plt.submit_provisioning_request(${a.kind}, ${a.slug}, ${a.args === null ? null : sql.json(a.args as never)}, ${a.key}::uuid, ${a.operator}::uuid,
      ${a.acr}, ${a.authTime}::timestamptz, ${a.sessionAt}::timestamptz, ${a.token}, ${a.reason}, ${a.hostActor})::text AS id`
}
