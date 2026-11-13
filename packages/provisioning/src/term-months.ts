// packages/provisioning/src/term-months.ts -- the semester start months of a
// customer (brand.termMonths in a create request, brand.term_months in the
// tenant config): the month, 1 to 12, in which the winter and in which the
// summer semester start, two different ones. The sidebar's semester label
// ("WiSe 26/27", "SoSe 27") is computed from them at read time by the app
// (gremion-ui $lib/semester), so only the months are ever stored.
// No imports: apps/control-panel keeps a mirror of the rule (its image depends
// on no workspace package) and its requests.test.ts runs both over one corpus.

/** The months (1 to 12, different) in which the winter and the summer semester start. */
export interface TermMonths {
  winter: number
  summer: number
}

const isMonth = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 12

/** Exactly the two keys, two different whole months 1 to 12. */
export function isTermMonths(v: unknown): v is TermMonths {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return Object.keys(o).length === 2 && isMonth(o.winter) && isMonth(o.summer) && o.winter !== o.summer
}
