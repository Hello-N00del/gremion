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
import { exportTenant, verifyExport, type ExportModule } from '@gremion/tenant-store/export'
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
  const connect = (url: string) => {
    const s = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 }) as postgres.Sql
    open.push(s)
    return s
  }
  try {
    const enabled = new Set(
      (
        await platform<{ module_key: string }[]>`
          SELECT m.module_key FROM plt.module_database d JOIN plt.module m USING (module_id)
           WHERE d.customer_id = ${tenantId} AND d.state = 'enabled'`
      ).map((r) => r.module_key),
    )
    const modules: ExportModule[] = ctx.catalogue().map((m) => {
      const rt = m.moduleJson.runtime
      const isEnabled = enabled.has(m.id)
      const base: ExportModule = { id: m.id, runtimeExport: rt.export ?? null, platformServer: rt.platformServer ?? null, enabled: isEnabled }
      if (rt.export && isEnabled && rt.database) {
        const svc = rt.database.postgresService.replace(/-postgres$/, '')
        base.sql = connect(withDb(ctx.moduleUrl(svc), tenantModuleDbName(tenantId, m.id))) as ExportModule['sql']
      }
      return base
    })
    const kernel = connect(withDb(ctx.kernelUrl(), kernelDbName(tenantId))) as ExportModule['sql'] & object
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
    await Promise.all([platform, ...open].map((s) => s.end({ timeout: 5 }).catch(() => undefined)))
  }
}
