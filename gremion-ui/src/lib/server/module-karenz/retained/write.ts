// src/lib/server/module-karenz/retained/write.ts
// Module Karenz (phase 2, Task 10): the engine's `retained` step. At switch-off, while the module
// database still exists, every extractor registered for the module hands over its lines and they are
// sealed as one read-only copy per (Karenz row, extractor).
//
// Idempotent and restart-safe: an extractor whose copy exists is skipped (and not even run); a
// concurrent pass that wins the unique (karenz_id, extractor_id) is counted as written; each extractor
// is sealed in ONE transaction, so a failure leaves neither a record nor a data key behind. One
// failing extractor never stops the others: all are processed and the step then fails with a
// KarenzPartialError (the engine retries it on the next pass, writing only what is missing).
//
// This file calls NO sink: publishing a sealed copy is the engine's per-(record, sink) step (Task 11),
// so a failed publication is retried on its own.
import type { Sql } from '@gremion/db'
import { KarenzPartialError, type KarenzContext } from '../participants'
import { RetainedCryptoError, sealLines, type CryptoDeps } from './crypto'
import { extractorsFor, policyFor, type RetainedLine } from './extractors'
import { retainedRecordIdFor } from './store'
import { RetainedGuardError } from '../retained-guard'

export type WriteDeps = CryptoDeps

const isUniqueViolation = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === '23505'

const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * What may be said about a failure: the extractor id and the error class. The message stays out
 * unless it comes from this module's own errors (they never carry record content): an extractor's
 * error may quote a name or a path.
 */
function describe(extractorId: string, err: unknown): string {
  const own = err instanceof RetainedGuardError || err instanceof RetainedCryptoError
  const name = err instanceof Error ? err.name : typeof err
  return own ? `${extractorId}: ${name}: ${(err as Error).message}` : `${extractorId}: ${name}`
}

/**
 * Seal the copies of this Karenz row. Returns how many records and lines THIS call wrote (an
 * extractor that was already written adds nothing); zero extractors is success with zero records.
 */
export async function writeRetainedCopies(ctx: KarenzContext, deps: WriteDeps = {}): Promise<{ records: number; lines: number }> {
  const db = ctx.tenant.db
  let records = 0
  let lineTotal = 0
  const failures: string[] = []

  for (const extractor of extractorsFor(ctx.catalogueId)) {
    try {
      if (await retainedRecordIdFor(db, ctx.karenzId, extractor.id)) continue
      const lines: RetainedLine[] = []
      for await (const line of extractor.extract(ctx)) lines.push(line)
      const hold = policyFor(extractor.retentionClass).holdUntil({ startedAt: ctx.switchedOffAt })
      const sealed = await db.begin((tx) =>
        sealLines(
          tx as unknown as Sql,
          ctx.tenant.id,
          ctx.karenzId,
          extractor.id,
          lines,
          { catalogueId: extractor.catalogueId, retentionClass: extractor.retentionClass, holdUntil: hold ? isoDate(hold) : null },
          deps,
        ),
      )
      records++
      lineTotal += sealed.lineCount
    } catch (err) {
      // another pass sealed the same copy first: it exists, which is all this step is for
      if (isUniqueViolation(err)) continue
      const label = describe(extractor.id, err)
      ctx.log(`retained copy ${label}`)
      failures.push(label)
    }
  }

  if (failures.length > 0) throw new KarenzPartialError(failures)
  return { records, lines: lineTotal }
}
