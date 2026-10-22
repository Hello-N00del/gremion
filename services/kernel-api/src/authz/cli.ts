// services/kernel-api/src/authz/cli.ts -- `kernel-api authz sync|sweep [--customer <id>]`
// (plan s.3 G6, brief s.5.2/5.6). Both verbs are per customer, idempotent, and
// safe to run from cron next to the 60 s in-process cadence:
//   sync   writes the role/capability catalogue (module-aware: M-OFF-1/3)
//   sweep  expires, activates, and revokes grants of disabled modules (M-OFF-2/4)
// Without --customer every `active` customer is visited; one customer's failure
// never stops the others, is named on its own AUTHZ-FAILED line, and makes the
// exit code 1. Exit 2 = usage. The wiring (control + platform pools, the gate's
// tenant-store pools) is injected so the verbs are testable without a database.
import type { TenantRow } from '../app/deps.ts'
import { sweepGrants } from './sweep.ts'
import { syncAuthzCatalogue } from './sync.ts'
import type { EnabledModules } from './pdp.ts'
import type { Sql } from './tx.ts'

export interface AuthzCliIo {
  out(line: string): void
  err(line: string): void
}

export interface AuthzCliDeps {
  /** Customer ids to visit when --customer is absent (active customers). */
  listCustomerIds(): Promise<string[]>
  lookup(customerId: string): Promise<TenantRow | null>
  /** The customer's kernel database as the app role (tenant-store pool; this module opens no connection, TRD-426). */
  db(tenant: TenantRow): Promise<Sql>
  /** plt.module_key -> module_id for modules the registry knows (a module without rows gets no capability, M-OFF-3). */
  moduleIds(): Promise<ReadonlyMap<string, string>>
  /** The per-call registry read (never cached). */
  enabledModules: EnabledModules
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function runAuthzCli(argv: readonly string[], io: AuthzCliIo, deps: AuthzCliDeps): Promise<number> {
  const [cmd, verb, ...rest] = argv
  const usage = (why: string) => {
    io.err(`usage: kernel-api authz sync|sweep [--customer <customer id>]  (${why})`)
    return 2
  }
  if (cmd !== 'authz') return usage(`unknown command ${JSON.stringify(cmd)}`)
  if (verb !== 'sync' && verb !== 'sweep') return usage(`unknown verb ${JSON.stringify(verb)}`)
  let only: string | undefined
  if (rest.length === 2 && rest[0] === '--customer' && UUID.test(rest[1] ?? '')) only = rest[1]
  else if (rest.length !== 0) return usage(`unexpected arguments ${rest.join(' ')}`)

  const ids = only ? [only] : await deps.listCustomerIds()
  let failed = 0
  for (const id of ids) {
    try {
      const tenant = await deps.lookup(id)
      if (!tenant) throw new Error(`no customer ${id} in the control registry`)
      const sql = await deps.db(tenant)
      if (verb === 'sync') {
        const enabled = await deps.enabledModules(id)
        const r = await syncAuthzCatalogue(sql, { customerId: id, moduleIds: await deps.moduleIds(), enabledModules: enabled })
        io.out(`AUTHZ-SYNC ${id} roles=${r.roles} capabilities=${r.capabilities} skipped=${r.skipped.length} module_disabled=${r.disabled.length}`)
      } else {
        const r = await sweepGrants(sql, deps.enabledModules, id)
        io.out(`AUTHZ-SWEEP ${id} activated=${r.activated} expired=${r.expired} module_revoked=${r.moduleRevoked}`)
      }
    } catch (err) {
      failed++
      io.err(`AUTHZ-FAILED ${id} ${verb}: ${(err as Error).message}`)
    }
  }
  if (only === undefined && ids.length === 0) io.out(`AUTHZ-${verb.toUpperCase()} no active customer`)
  return failed === 0 ? 0 : 1
}
