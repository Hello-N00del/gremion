// TRD-082 query recorder (brief TDD 11, Q12): wraps a postgres-js Sql (or
// stands in for one) and records every tagged-template query -- its text and
// its parameters. scopeProblems() then holds each recorded query to the rule:
// it carries the customer id as a parameter, or it is one of the PINNED
// exemptions (each matched by an exact normalised text). An unscoped query, a
// pinned exemption no query matched (stale), or zero queries scanned is a
// problem: the check never passes vacuously.
import type { Sql } from '@gremion/db'

export interface RecordedQuery {
  text: string
  params: unknown[]
}

/** Q12's exemptions, pinned. (2) -- 077-a's catalogue upserts -- is VOID: no such query exists (R10). */
export const PINNED_EXEMPTIONS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: '1: tenant_domain WHERE host = $1', pattern: /FROM public\.tenant_domain d JOIN public\.tenant t ON t\.id = d\.tenant_id WHERE d\.host = \$1$/ },
  { id: "3: the migrate job's tenant iteration", pattern: /^SELECT t\.id::text AS id, t\.status FROM public\.tenant t ORDER BY t\.id$/ },
  // TASK-080-a: the event relay iterates the active customers (one relay each), like the migrate job
  { id: "4: the relay's active-tenant iteration", pattern: /FROM public\.tenant t WHERE t\.status = 'active' ORDER BY t\.id$/ },
]

export const normalise = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A recording Sql: forwards to `inner` (a real Sql) or answers with `answer`. */
export function recordingSql(into: RecordedQuery[], next: Sql | ((q: RecordedQuery) => unknown[])): Sql {
  const fn = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const q = { text: normalise(strings.map((s, i) => (i === 0 ? s : `$${i}${s}`)).join('')), params }
    into.push(q)
    if (typeof next === 'function' && !('unsafe' in next)) return Promise.resolve((next as (q: RecordedQuery) => unknown[])(q))
    return (next as Sql)(strings, ...(params as never[]))
  }
  return Object.assign(fn, { end: async () => {}, options: { max: 4 } }) as unknown as Sql
}

export function scopeProblems(records: readonly RecordedQuery[], customerIds: readonly string[], exemptions = PINNED_EXEMPTIONS): string[] {
  const problems: string[] = []
  if (records.length === 0) problems.push('0 queries scanned: the check would pass vacuously')
  const used = new Set<string>()
  for (const q of records) {
    const exempt = exemptions.find((e) => e.pattern.test(q.text))
    if (exempt) {
      used.add(exempt.id)
      continue
    }
    if (!q.params.some((p) => typeof p === 'string' && customerIds.includes(p))) problems.push(`unscoped query (no customer id among its parameters): ${q.text}`)
  }
  for (const e of exemptions) if (!used.has(e.id)) problems.push(`stale exemption (no query matched it): ${e.id}`)
  return problems
}

/**
 * A pool stand-in for the domain service (which only ever calls `sql.begin`): the transaction handle it hands out
 * records every tagged-template query into `into`, then forwards to the REAL transaction. `.unsafe` (the events
 * library's own enqueue) passes through unrecorded: that statement is @gremion/events', not the service's.
 */
export function recordingPool(into: RecordedQuery[], real: Sql): Sql {
  const recordingTx = (tx: Sql): Sql =>
    new Proxy(tx as unknown as (...a: unknown[]) => unknown, {
      apply(target, thisArg, args: unknown[]) {
        const strings = args[0] as TemplateStringsArray
        if (Array.isArray(strings) && 'raw' in strings) {
          into.push({ text: normalise(strings.map((s, i) => (i === 0 ? s : `$${i}${s}`)).join('')), params: args.slice(1) })
        }
        return Reflect.apply(target, thisArg, args)
      },
    }) as unknown as Sql
  return { begin: (fn: (tx: Sql) => Promise<unknown>) => real.begin((tx) => fn(recordingTx(tx as unknown as Sql))) } as unknown as Sql
}
