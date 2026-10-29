// gremion-ui/scripts/tenant-provision-purge.ts — TRD-144/145 (TASK-033-a):
// the tenant-create one-shot's `purge-run` verb, the container half of the
// host's gremion-purge.timer. Its own file, like the request and import verbs:
// tenant-provision.ts carries one import, one dispatch case and a USAGE line.
//
//   purge-run
//     Runs every retention category docs/compliance/retention-catalogue.md gives
//     a concrete window and a table in this repository (runPurge in
//     @gremion/tenant-store/lifecycle): deletes the aged rows as each customer's
//     purger role (LOGGED IN as it, never SET ROLE under the admin), and writes
//     one plt.job_run row (job_kind purge_run) with the counts per category and
//     the errors; it stops itself at PURGE_DEADLINE_MS and records the run as
//     partial ("partial":"deadline"). ONE JSON line on STDOUT:
//       {"verb":"purge-run","status":"succeeded","categories":{...},"errors":0,...}
//     EXIT 0 succeeded (or skipped: another run holds the lock); 1 failed (a
//     customer database or rule errored or was refused, the run reached its
//     deadline or a batch cap; the row says which) or the run could not start or
//     record; 2 usage.
import { runPurge, type PurgeDeps, type PurgeResult } from '@gremion/tenant-store/lifecycle'

export const PURGE_VERBS: ReadonlySet<string> = new Set(['purge-run'])

export const PURGE_USAGE = '  purge-run   (TRD-144/145: purge rows past their retention window and record the run in plt.job_run; one JSON line)'

export interface PurgeVerbContext {
  /** process.argv after the verb */
  args: readonly string[]
  /** A direct pool to gremion_platform as its owner. */
  openPlatform(): PurgeDeps['platform']
  /** The kernel server behind KERNEL_PG_ADMIN_FILE. */
  openKernelServer(): PurgeDeps['server'] & { close(): Promise<void> }
  run?: (deps: PurgeDeps) => Promise<PurgeResult>
  usage(message: string): Error
  log(line: string): void
}

export async function purgeVerb(verb: string, ctx: PurgeVerbContext): Promise<void> {
  if (!PURGE_VERBS.has(verb)) throw ctx.usage(`unknown verb ${verb}`)
  if (ctx.args.length > 0) throw ctx.usage('purge-run takes no argument (the windows are the catalogue\'s, not a flag)')
  const platform = ctx.openPlatform()
  const server = ctx.openKernelServer()
  try {
    const r = await (ctx.run ?? runPurge)({ platform, server, log: (m) => ctx.log(m) })
    for (const e of r.errors) ctx.log(`purge-run: ${e.tenant ?? 'platform'} ${e.rule}: ${e.message}`)
    process.stdout.write(
      `${JSON.stringify({
        verb,
        status: r.status,
        jobRunId: r.jobRunId,
        tenantsScanned: r.tenantsScanned,
        categories: r.categories,
        errors: r.errors.length,
        skipped: r.skipped.length,
        partial: r.partial,
        batchLimitHits: r.batchLimitHits.length,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt.toISOString(),
      })}\n`,
    )
    if (r.status === 'failed') process.exitCode = 1
  } finally {
    await Promise.allSettled([platform.end({ timeout: 5 }), server.close()])
  }
}
