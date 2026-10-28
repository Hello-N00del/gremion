// gremion-ui/scripts/tenant-provision-export.ts
// TRD-149/150/151 verbs of the tenant-create one-shot (the engine behind
// `gremion-tenant export <slug> <dir>`; the library is
// @gremion/tenant-store/export).
//
//   export <slug> --out <dir>    CSV + JSON per exportable table, manifest.json,
//                                then the completeness check. Exit 0 complete,
//                                1 failed or incomplete (each file named), 2 usage.
//   export-verify <dir>          the completeness check alone, over a directory
//                                already on disk (the host runs it as a second,
//                                separate step). Needs no database.
//
// The kernel database is t_<hex32>__kernel on the kernel server
// (KERNEL_PG_ADMIN_FILE); a module's tenant database is
// tenantModuleDbName(tenant, module) on that module's server
// (MODULE_PG_ADMIN_<ID>_FILE), read only for modules enabled for the tenant in
// plt.module_database. Connections are direct (never the pooler), read-only
// repeatable-read transactions.
//
// HIGH-1: the admin urls are used ONLY on each server's maintenance database,
// to (re)assert the export reader (a NOSUPERUSER LOGIN role with
// pg_read_all_data and a fresh password, ensureExportReader). Every tenant
// database is then read AS that reader, never as the superuser, and its
// password is cleared again when the run ends.
import { assertNoTransitionalModules, connectExportReader, ensureExportReader, exportTenant, retireExportReader, verifyExport, type ExportModule } from '@gremion/tenant-store/export'
import { kernelDbName } from '@gremion/tenant-store/lifecycle'
import { tenantModuleDbName } from '@gremion/tenant-store'
import type { LifecycleModule } from '@gremion/tenant-store/lifecycle'
import postgres from 'postgres'

export const EXPORT_VERBS: ReadonlySet<string> = new Set(['export', 'export-verify'])

export const EXPORT_USAGE = `  export <slug> --out <dir>      (open-format export: CSV + JSON per table, manifest.json, completeness check)
  export-verify <dir>`

export interface ExportVerbContext {
  catalogue(): LifecycleModule[]
  customerIdForSlug(slug: string): Promise<string | null>
  openPlatform(): postgres.Sql
  /** postgres:// admin url of the kernel server / of a module's server (id = postgres service id). */
  kernelUrl(): string
  moduleUrl(serviceId: string): string
  reqFlag(name: string): string
  positional(index?: number): string | undefined
  usage(message: string): Error
  log(line: string): void
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

function withDb(url: string, db: string): string {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}

export async function exportVerb(verb: string, ctx: ExportVerbContext): Promise<void> {
  if (verb === 'export-verify') {
    const dir = ctx.positional(0)
    if (!dir) throw ctx.usage('export-verify requires <dir>')
    const r = verifyExport(dir)
    for (const p of r.problems) console.error(`EXPORT INCOMPLETE ${p.code} ${p.path}: ${p.detail}`)
    if (!r.ok) {
      console.error(`export check FAILED: ${r.problems.length} problem(s)`)
      process.exitCode = 1
      return
    }
    ctx.log(`export check ok: ${r.checked} file(s) present, non-empty, sha256 matches`)
    return
  }
  const slug = ctx.positional(0)
  if (!slug || !SLUG.test(slug)) throw ctx.usage('export requires a valid <slug>')
  const out = ctx.reqFlag('--out')
  const tenantId = await ctx.customerIdForSlug(slug)
  if (!tenantId) throw ctx.usage(`no customer with slug ${slug}`)

  const platform = ctx.openPlatform()
  const open: postgres.Sql[] = []
  const admins = new Map<string, postgres.Sql>()
  // The admin url, on the server's maintenance database only.
  const connect = (url: string) => {
    const s = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 }) as postgres.Sql
    open.push(s)
    return s
  }
  // Every connection AS the reader: search_path pinned at startup, no type fetch (HIGH-1).
  const connectReader = (url: string) => {
    const s = connectExportReader(url) as unknown as postgres.Sql
    open.push(s)
    return s
  }
  // One reader per server: the admin url's own (maintenance) database is where the role DDL runs.
  const plan: { adminUrl: string; db: string; assign(sql: ExportModule['sql'] & object): void }[] = []
  const openReaders = async () => {
    const byServer = new Map<string, string[]>()
    for (const p of plan) byServer.set(p.adminUrl, [...(byServer.get(p.adminUrl) ?? []), p.db])
    const creds = new Map<string, { user: string; password: string }>()
    for (const [adminUrl, dbs] of byServer) {
      const admin = connect(adminUrl)
      admins.set(adminUrl, admin)
      creds.set(adminUrl, await ensureExportReader(admin as ExportModule['sql'] & object, { databases: dbs }))
    }
    for (const p of plan) {
      const c = creds.get(p.adminUrl)!
      const u = new URL(withDb(p.adminUrl, p.db))
      u.username = c.user
      u.password = encodeURIComponent(c.password)
      p.assign(connectReader(u.toString()) as ExportModule['sql'] & object)
    }
  }
  try {
    // Every module database row but the dropped ones: 'enabling' / 'disabling' may still hold rows (MED).
    const states = new Map(
      (
        await platform<{ module_key: string; state: string }[]>`
          SELECT m.module_key, d.state FROM plt.module_database d JOIN plt.module m USING (module_id)
           WHERE d.customer_id = ${tenantId} AND d.state <> 'dropped'`
      ).map((r) => [r.module_key, r.state] as const),
    )
    const modules: ExportModule[] = ctx.catalogue().map((m) => {
      const rt = m.moduleJson.runtime
      const state = states.get(m.id)
      const isEnabled = state === 'enabled'
      const base: ExportModule = { id: m.id, runtimeExport: rt.export ?? null, platformServer: rt.platformServer ?? null, enabled: isEnabled }
      if (state === 'enabling' || state === 'disabling') base.transitional = state
      if (rt.export && isEnabled && rt.database) {
        const svc = rt.database.postgresService.replace(/-postgres$/, '')
        plan.push({ adminUrl: ctx.moduleUrl(svc), db: tenantModuleDbName(tenantId, m.id), assign: (s) => (base.sql = s) })
      }
      return base
    })
    assertNoTransitionalModules(modules)
    let kernel: (ExportModule['sql'] & object) | undefined
    plan.push({ adminUrl: ctx.kernelUrl(), db: kernelDbName(tenantId), assign: (s) => (kernel = s) })
    await openReaders()
    if (!kernel) throw new Error('internal: no kernel connection')
    const { manifest, verify } = await exportTenant({ slug, outDir: out, kernel, modules })
    for (const p of verify.problems) console.error(`EXPORT INCOMPLETE ${p.code} ${p.path}: ${p.detail}`)
    ctx.log(
      `exported ${slug}: ${manifest.files.length} file(s), ${manifest.modules.filter((m) => m.status === 'exported').length} module(s) + kernel; ` +
        `excluded: ${[...manifest.modules.filter((m) => m.status === 'excluded').map((m) => `module ${m.id}`), ...manifest.excluded_systems.map((s) => s.system)].join(', ')}`,
    )
    if (!verify.ok) {
      console.error(`export check FAILED: ${verify.problems.length} problem(s)`)
      process.exitCode = 1
    }
  } finally {
    for (const admin of admins.values()) {
      await retireExportReader(admin as ExportModule['sql'] & object).catch((err: unknown) => console.error(`export reader password not cleared: ${(err as Error).message}`))
    }
    await Promise.all([platform, ...open].map((s) => s.end({ timeout: 5 }).catch(() => undefined)))
  }
}
