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
import { extractorsFor, hasRetentionDeclaration, policyFor, type RetainedLine } from './extractors'
import { retainedRecordIdFor } from './store'
import { RetainedGuardError } from '../retained-guard'

export type WriteDeps = CryptoDeps

const errorCode = (err: unknown): unknown => (err as { code?: unknown } | null)?.code

const isUniqueViolation = (err: unknown): boolean => errorCode(err) === '23505'

const DAY_MS = 86_400_000

/** The calendar day (UTC) of a hold end; a time part rounds UP, so a hold never ends a day early. */
const holdDay = (d: Date): string => {
  const ms = d.getTime()
  return new Date(ms % DAY_MS === 0 ? ms : (Math.floor(ms / DAY_MS) + 1) * DAY_MS).toISOString().slice(0, 10)
}

/**
 * What may be said about a failure: the extractor id and the error class, plus the SQLSTATE of a
 * database error (five characters, no record content). The message stays out unless it comes from
 * this module's own errors (they never carry record content): an extractor's error may quote a name
 * or a path.
 */
function describe(extractorId: string, err: unknown): string {
  const own = err instanceof RetainedGuardError || err instanceof RetainedCryptoError
  const name = err instanceof Error ? err.name : typeof err
  if (own) return `${extractorId}: ${name}: ${(err as Error).message}`
  const code = errorCode(err)
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${extractorId}: ${name} [${code}]` : `${extractorId}: ${name}`
}

/**
 * Seal the copies of this Karenz row. Returns how many records and lines THIS call wrote (an
 * extractor that was already written adds nothing). A catalogue id with no extractor is a failure
 * unless it declared (registerNoRetention) that it retains nothing: a missing registration must not
 * pass for "nothing to retain" before an irreversible deletion.
 */
export async function writeRetainedCopies(ctx: KarenzContext, deps: WriteDeps = {}): Promise<{ records: number; lines: number }> {
  const db = ctx.tenant.db
  let records = 0
  let lineTotal = 0
  const failures: string[] = []

  if (!hasRetentionDeclaration(ctx.catalogueId)) {
    throw new KarenzPartialError([`${ctx.catalogueId}: no retention extractor registered and no declaration that it retains nothing`])
  }

  for (const extractor of extractorsFor(ctx.catalogueId)) {
    try {
      if (await retainedRecordIdFor(db, ctx.karenzId, extractor.id)) continue
      const lines: RetainedLine[] = []
      for await (const line of extractor.extract(ctx)) lines.push(line)
      const hold = policyFor(extractor.retentionClass).holdUntil({ startedAt: ctx.switchedOffAt })
      const meta = { catalogueId: extractor.catalogueId, retentionClass: extractor.retentionClass, holdUntil: hold ? holdDay(hold) : null }
      try {
        const sealed = await db.begin((tx) => sealLines(tx as unknown as Sql, ctx.tenant.id, ctx.karenzId, extractor.id, lines, meta, deps))
        records++
        lineTotal += sealed.lineCount
      } catch (err) {
        // another pass sealed the same copy first: counted as written only when the copy really exists
        if (isUniqueViolation(err) && (await retainedRecordIdFor(db, ctx.karenzId, extractor.id))) continue
        throw err
      }
    } catch (err) {
      const label = describe(extractor.id, err)
      ctx.log(`retained copy ${label}`)
      failures.push(label)
    }
  }

  if (failures.length > 0) throw new KarenzPartialError(failures)
  return { records, lines: lineTotal }
}
