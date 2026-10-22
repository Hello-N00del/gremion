// gremion-ui/scripts/tenant-provision-import.ts
// TASK-031's verbs of the tenant-create one-shot (its own file, O9: the
// dispatcher tenant-provision.ts holds one import, the case lines and the USAGE
// text). They are the ENGINE of the executor's `import_members` and
// `seed_vertical` request kinds (infra/host/lib/executor/handlers/), not an
// operator CLI (R31-I4): the member list arrives on STDIN, never in argv or env.
//
//   import-validate <slug> --vertical <id>
//       STDIN: the member list (CSV). STDOUT: ONE JSON line, the result
//       {status, sha256, counts, rows, database}. Exit 0 validated, 1 rejected. Writes nothing.
//   import-apply <slug> --vertical <id> --expect-sha256 <hex>
//       STDIN: the same list. Refused unless it validates AND its sha256 is the
//       validated one AND the realm is stamped with its own mail principal
//       (before any account is created). Exit 0 applied, 1 otherwise.
//   seed-vertical <slug> --vertical <id>
//       Adopts the customer's single root, creates the vertical's other units
//       with their projection rows, merges the vertical's wording into the
//       tenant config. Idempotent. Exit 0 applied, 1 otherwise.
//
// E-mail addresses are never printed: a result names a row by number and name.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  applyImport,
  ImportRefused,
  ListFormatError,
  loadVertical,
  parseList,
  validateRows,
  validationResult,
  VerticalError,
  type ImportResult,
  type Vertical,
} from '@gremion/member-import'
import { kernelDbName } from '@gremion/tenant-store/lifecycle'
import { assertSmtpStamped, type CustomerRef, type ProvisioningDeps } from '@gremion/provisioning'
import { readConfig } from '../src/lib/server/config'
import { configPathForTenant, getTenantById } from '../src/lib/server/tenant/registry'
import { inProvisioningContext } from '../src/lib/server/tenant/provisioner/customer-adapters'
import type { KcProvisionApi } from '../src/lib/server/tenant/provisioner/kc-admin-api'
import { keycloakAccounts, memberImportTarget, seedVertical, sqlOrgStore } from '../src/lib/server/tenant/provisioner/member-import-adapters'

export const IMPORT_VERBS: ReadonlySet<string> = new Set(['import-validate', 'import-apply', 'seed-vertical'])

export const IMPORT_USAGE = `  import-validate <slug> --vertical <id>              (member list CSV on STDIN)
  import-apply <slug> --vertical <id> --expect-sha256 <hex>   (same list on STDIN)
  seed-vertical <slug> --vertical <id>`

export interface ImportVerbContext {
  withLive<T>(opts: { needEdge?: boolean }, fn: (deps: ProvisioningDeps) => Promise<T>): Promise<T>
  provisionerKc(): KcProvisionApi
  writeConfigFile(path: string, text: string): void
  /** The whole STDIN as UTF-8 (the verb refuses a TTY / empty list itself). */
  readStdin(): string
  flag(name: string): string | undefined
  reqFlag(name: string): string
  positional(index?: number): string | undefined
  usage(message: string): Error
  log(line: string): void
}

const VERTICAL_ID = /^[a-z][a-z0-9-]{0,62}$/

/** Where the verticals live in the image (COPY verticals/ -> /repo/verticals, cwd /repo/gremion-ui). */
export function verticalsDir(): string {
  return process.env.GREMION_VERTICALS_DIR ?? resolve(process.cwd(), '..', 'verticals')
}

export function readVertical(id: string, dir = verticalsDir()): Vertical {
  if (!VERTICAL_ID.test(id)) throw new VerticalError(`vertical id "${id}" is not a-z0-9 and dashes`)
  return loadVertical((f) => readFileSync(join(dir, id, f), 'utf8'), id)
}

function print(r: unknown): void {
  process.stdout.write(`${JSON.stringify(r)}\n`)
}

/**
 * The ONE result line of import-validate / import-apply: the result plus the
 * customer's kernel database name, which the host's handler needs to take its
 * pre-import dump (gremion-migration-dump take) before the first write.
 */
export function resultLine<T extends ImportResult>(result: T, customerId: string): T & { database: string } {
  return { ...result, database: kernelDbName(customerId) }
}

const failed = (message: string): ImportResult & { error: string } => ({
  status: 'failed',
  sha256: '',
  counts: { created: 0, linked_existing: 0, unchanged: 0, rejected: 0, accounts_created: 0, invites_sent: 0 },
  rows: [],
  error: message,
})

async function customerRef(deps: ProvisioningDeps, slug: string): Promise<CustomerRef> {
  const row = await deps.control.getBySlug(slug)
  if (!row) throw new Error(`customer ${slug} has no control row`)
  if (row.status !== 'active') throw new Error(`customer ${slug} is ${row.status}; the import runs on an active customer`)
  return { id: row.id, slug: row.slug, token: row.slug.replace(/-/g, '_'), realm: row.realm, host: row.host ?? '' }
}

export async function importVerb(verb: string, ctx: ImportVerbContext): Promise<void> {
  const slug = ctx.positional(0)
  if (!slug) throw ctx.usage(`${verb} requires <slug>`)
  const verticalId = ctx.reqFlag('--vertical')
  let vertical: Vertical
  try {
    vertical = readVertical(verticalId)
  } catch (err) {
    print(failed(`vertical ${verticalId}: ${err instanceof Error ? err.message : String(err)}`))
    process.exitCode = 1
    return
  }

  if (verb === 'seed-vertical') {
    await ctx.withLive({}, async (deps) => {
      const c = await customerRef(deps, slug)
      const tenant = await getTenantById(c.id)
      if (!tenant) throw new Error(`customer ${slug} has no control row`)
      const report = await inProvisioningContext(c, async () => {
        const cfg = readConfig()
        return seedVertical(vertical, {
          store: sqlOrgStore(),
          // D-8: a matrix room / Nextcloud folder is asked for only when messaging / files are enabled for the tenant
          modules: { messaging: cfg.modules.messages === true, files: cfg.modules.files === true },
          readConfig: () => readFileSync(configPathForTenant(tenant), 'utf8'),
          writeConfig: (text) => ctx.writeConfigFile(configPathForTenant(tenant), text),
        })
      })
      ctx.log(`seed-vertical ${slug}: units created ${report.units.created}, adopted ${report.units.adopted}, present ${report.units.present}; terms ${report.terms_written ? 'written' : 'unchanged'}`)
      print(report)
    })
    return
  }

  // import-validate / import-apply: the list, on STDIN
  const text = ctx.readStdin()
  let expected: string | undefined
  if (verb === 'import-apply') {
    expected = ctx.reqFlag('--expect-sha256')
    if (!/^[0-9a-f]{64}$/.test(expected)) throw ctx.usage('--expect-sha256 must be 64 lowercase hex characters')
  }
  await ctx.withLive({}, async (deps) => {
    const c = await customerRef(deps, slug)
    let result: ImportResult & { error?: string }
    try {
      // the realm sends its mail from its own submission principal, or nothing is created (assertSmtpStamped)
      if (verb === 'import-apply') await assertSmtpStamped(c, deps)
      result = await inProvisioningContext(c, async () => {
        const store = sqlOrgStore()
        const report = validateRows(parseList(text), { bodies: await store.listBodies(), roles: vertical.roles })
        if (verb === 'import-validate') return validationResult(report)
        const target = memberImportTarget(keycloakAccounts(ctx.provisionerKc(), c.realm), store)
        return applyImport(report, vertical.roles, target, expected!)
      })
    } catch (err) {
      if (err instanceof ListFormatError) result = { ...failed(err.message), status: 'rejected' }
      else if (err instanceof ImportRefused) result = failed(err.message)
      else throw err
    }
    ctx.log(`${verb} ${slug}: ${result.status}, created ${result.counts.created}, rejected ${result.counts.rejected}`)
    print(resultLine(result, c.id))
    if (result.status !== 'validated' && result.status !== 'applied') process.exitCode = 1
  })
}
