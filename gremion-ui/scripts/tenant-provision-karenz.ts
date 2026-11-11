// gremion-ui/scripts/tenant-provision-karenz.ts -- module Karenz (2026-10-30),
// phase 2 Task 4: the tenant-create one-shot's `karenz-run` and `karenz-status`
// verbs. Its own file, like the purge and export verbs: tenant-provision.ts
// carries one import, two case lines and a USAGE line.
//
//   karenz-run                  (no argument)
//       Day 30 of every Karenz row that is due, the PLATFORM side: it drops the
//       module database that is still blocked and deletes the row's own export
//       (finalizeDueKarenz, idempotent, restart-safe). The deletion switch is
//       KARENZ_FINAL_DELETION, read here and nowhere else: only the exact string
//       `on` deletes, anything else (the shipped value is `off`) is a dry run that
//       records the mode on each due row, counts what is due and deletes nothing.
//       The tenant pass reads that mode from the row, never from its own env.
//       ONE JSON line on STDOUT:
//         {"verb":"karenz-run","deletion":"on"|"off","due":n,"finalized":n,"kept":n,"orphanedExports":[...],"errors":[...]}
//       EXIT 0 when `errors` is empty (a dry run is exit 0 even with rows due),
//       1 otherwise, 2 usage. `deletion on` needs TENANT_EXPORT_DIR to be its own
//       mount (as disable-module does); a dry run does not.
//   karenz-status <slug>
//       The operator view: the live and the recent rows of one customer, as ONE
//       JSON line. It includes the actor (who switched the module off), which no
//       council function returns; it is therefore for the operator only.
import type postgres from 'postgres'
import { finalDeletionEnabled, type FinalizeResult } from '@gremion/tenant-store/lifecycle'
import type { ProvisioningDeps } from '@gremion/provisioning'
import { exportDirRefusal } from './tenant-provision-gate'

export const KARENZ_VERBS: ReadonlySet<string> = new Set(['karenz-run', 'karenz-status'])

export const KARENZ_USAGE = `  karenz-run   (module Karenz day 30: drop what is still blocked, delete the export; KARENZ_FINAL_DELETION=on deletes, anything else is a dry run; one JSON line)
  karenz-status <slug>   (the live and recent Karenz rows of one customer, with the actor; operator view; one JSON line)`

/** The wall-clock budget of one karenz-run (finalizeDueKarenz stops starting new rows after it). */
export const KARENZ_RUN_DEADLINE_MS = 110_000

export interface KarenzVerbContext {
  /** process.argv after the verb */
  args: readonly string[]
  /** The environment the switch is read from (default process.env). */
  env?: Record<string, string | undefined>
  withLive<T>(opts: { needEdge?: boolean }, fn: (deps: ProvisioningDeps) => Promise<T>): Promise<T>
  /** A direct pool to gremion_platform as its owner; the verb ends it. */
  openPlatform(): postgres.Sql
  /** The customer id of a slug from the control registry, or null. */
  customerIdForSlug(slug: string): Promise<string | null>
  /** Tests only: whether TENANT_EXPORT_DIR is its own mount (default: exportDirRefusal over /proc/self/mountinfo). */
  exportDirMounted?: (dir: string) => boolean
  usage(message: string): Error
  log(line: string): void
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

async function cmdKarenzRun(ctx: KarenzVerbContext): Promise<void> {
  if (ctx.args.length > 0) throw ctx.usage('karenz-run takes no argument (the deletion switch is KARENZ_FINAL_DELETION, not a flag)')
  const env = ctx.env ?? process.env
  const finalDeletion = finalDeletionEnabled(env)
  if (finalDeletion) {
    // a live run deletes the exports of finished Karenz rows, and drops databases only against an export
    // that outlives this one-shot container: the same refusal as disable-module, before anything is touched
    const dir = env.TENANT_EXPORT_DIR ?? ''
    const refusal = exportDirRefusal(dir, { override: ctx.exportDirMounted })
    if (refusal !== null) {
      throw ctx.usage(`karenz-run with KARENZ_FINAL_DELETION=on needs TENANT_EXPORT_DIR (${dir || 'unset'}) to be a mounted volume that outlives this container; nothing was touched (${refusal})`)
    }
  }
  const r: FinalizeResult = await ctx.withLive({}, async (deps) => {
    if (!deps.modules.finalizeDue) throw new Error('the modules port has no finalizeDue: karenz-run cannot run against this adapter')
    return deps.modules.finalizeDue({ finalDeletion, deadlineMs: KARENZ_RUN_DEADLINE_MS })
  })
  for (const e of r.errors) ctx.log(`karenz-run: Karenz ${e.karenzId} (${e.moduleKey}): ${e.message}`)
  ctx.log(`karenz-run: deletion ${finalDeletion ? 'on' : 'off'}: ${r.due} due, ${r.finalized} finalized, ${r.kept} kept, ${r.orphanedExports.length} orphaned export(s), ${r.errors.length} error(s)`)
  process.stdout.write(
    `${JSON.stringify({
      verb: 'karenz-run',
      deletion: finalDeletion ? 'on' : 'off',
      due: r.due,
      finalized: r.finalized,
      kept: r.kept,
      orphanedExports: r.orphanedExports,
      errors: r.errors,
    })}\n`,
  )
  if (r.errors.length > 0) process.exitCode = 1
}

interface StatusRow {
  karenz_id: string
  module_key: string
  state: string
  switched_off_at: Date
  final_at: Date
  restore_requested_at?: Date | null
  restored_at?: Date | null
  actor_kind: string
  actor_id: string | null
  export_path: string | null
  export_deleted_at: Date | null
  export_kept_until: Date | null
  final_mode: string | null
  platform_done_at: Date | null
  tenant_done_at: Date | null
  retained_ok_at: Date | null
}

async function cmdKarenzStatus(ctx: KarenzVerbContext): Promise<void> {
  const slug = ctx.args[0]
  if (!slug) throw ctx.usage('karenz-status requires <slug>')
  if (!SLUG.test(slug)) throw ctx.usage(`karenz-status: ${JSON.stringify(slug)} is not a valid slug`)
  if (ctx.args.length > 1) throw ctx.usage('karenz-status takes exactly one argument, <slug>')
  const customerId = await ctx.customerIdForSlug(slug)
  if (!customerId) throw ctx.usage(`unknown customer ${JSON.stringify(slug)}`)
  const platform = ctx.openPlatform()
  try {
    // the live rows, and the closed ones of the last 90 days; newest first, bounded
    const rows = await platform<StatusRow[]>`
      SELECT k.karenz_id::text, m.module_key, k.state, k.switched_off_at, k.final_at, k.restore_requested_at, k.restored_at,
             k.actor_kind, k.actor_id::text, k.export_path, k.export_deleted_at, k.export_kept_until, k.final_mode,
             k.platform_done_at, k.tenant_done_at, k.retained_ok_at
        FROM plt.module_karenz k JOIN plt.module m ON m.module_id = k.module_id
       WHERE k.customer_id = ${customerId}
         AND (k.state IN ('open', 'restoring', 'finalizing') OR k.switched_off_at > now() - interval '90 days')
       ORDER BY k.switched_off_at DESC, k.karenz_id DESC
       LIMIT 100`
    ctx.log(`karenz-status ${slug}: ${rows.length} row(s)`)
    process.stdout.write(
      `${JSON.stringify({
        verb: 'karenz-status',
        slug,
        rows: rows.map((r) => ({
          karenzId: r.karenz_id,
          moduleKey: r.module_key,
          state: r.state,
          switchedOffAt: r.switched_off_at,
          finalAt: r.final_at,
          restoreRequestedAt: r.restore_requested_at ?? null,
          restoredAt: r.restored_at ?? null,
          actorKind: r.actor_kind,
          actorId: r.actor_id,
          exportPath: r.export_path,
          exportDeletedAt: r.export_deleted_at,
          exportKeptUntil: r.export_kept_until,
          finalMode: r.final_mode,
          platformDoneAt: r.platform_done_at,
          tenantDoneAt: r.tenant_done_at,
          retainedOkAt: r.retained_ok_at,
        })),
      })}\n`,
    )
  } finally {
    await platform.end({ timeout: 5 })
  }
}

/** Dispatches one of KARENZ_VERBS. */
export async function karenzVerb(verb: string, ctx: KarenzVerbContext): Promise<void> {
  switch (verb) {
    case 'karenz-run':
      return cmdKarenzRun(ctx)
    case 'karenz-status':
      return cmdKarenzStatus(ctx)
    default:
      throw ctx.usage(`unknown karenz verb ${verb}`)
  }
}

/** A module database row that is not dropped, as `delete` reads it. */
export interface LiveModuleDatabase {
  module_key: string
  state: string
  /** The end of the live Karenz of this module, when there is one. */
  final_at: Date | null
}

/** The module databases of one customer that are not dropped, with the end of their Karenz (a platform pool). */
export async function liveModuleDatabases(platform: postgres.Sql, customerId: string): Promise<LiveModuleDatabase[]> {
  return platform<LiveModuleDatabase[]>`
    SELECT m.module_key, d.state,
           (SELECT min(k.final_at) FROM plt.module_karenz k
             WHERE k.customer_id = d.customer_id AND k.module_id = d.module_id AND k.state IN ('open', 'restoring', 'finalizing')) AS final_at
      FROM plt.module_database d JOIN plt.module m USING (module_id)
     WHERE d.customer_id = ${customerId} AND d.state <> 'dropped'
     ORDER BY 1`
}

const day = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * The refusal of `delete` while the customer still has module databases: a switched-off module is
 * not gone for 30 days (its database is blocked, not dropped), so the text names the Karenz and what
 * ends it, instead of telling the operator to disable what is already disabled.
 */
export function liveModuleDatabasesRefusal(slug: string, rows: readonly LiveModuleDatabase[]): string {
  const blocked = rows.filter((r) => r.state === 'blocked')
  const other = rows.filter((r) => r.state !== 'blocked')
  const parts: string[] = []
  if (blocked.length) {
    parts.push(`module(s) ${blocked.map((r) => `${r.module_key} (blocked in its 30-day Karenz${r.final_at ? `, ends ${day(r.final_at)}` : ''})`).join(', ')}`)
  }
  if (other.length) {
    parts.push(`module(s) ${other.map((r) => `${r.module_key} (${r.state})`).join(', ')} with their own databases`)
  }
  return (
    `${slug} still has ${parts.join(' and ')}; delete does not drop module databases. ` +
    `Switch every enabled module off and let its Karenz run out: the day-30 job (karenz-run, with KARENZ_FINAL_DELETION=on) drops the blocked database, then rerun delete`
  )
}
