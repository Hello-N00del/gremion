// packages/retention/src/catalogue.ts -- reads the figures of docs/compliance/
// retention-catalogue.md (TASK-070's file, never edited here) so registry.test.ts
// can fail when the registry and the catalogue disagree.
import { CACHE_ROW, CACHE_TTL_HOURS, LOG_CLASSES } from './registry.ts'

export interface CatalogueLogRow {
  row: string
  regularDays: number
  capDays: number
}

/** `| RC-LOG-ACC | ... | **14 d / 30 d** | ...` -> {row, regular 14, cap 30}. */
export function parseLogRows(md: string): CatalogueLogRow[] {
  const out: CatalogueLogRow[] = []
  for (const line of md.split('\n')) {
    const m = /^\|\s*(RC-LOG-[A-Z]+)\s*\|/.exec(line)
    if (!m) continue
    const f = /\*\*(\d+) d \/ (\d+) d\*\*/.exec(line)
    if (!f) continue
    out.push({ row: m[1]!, regularDays: Number(f[1]), capDays: Number(f[2]) })
  }
  return out
}

/** RC-K1-CACHE: the TTL in hours, or null when the row is missing or worded otherwise. */
export function parseCacheTtlHours(md: string): number | null {
  const line = md.split('\n').find((l) => l.startsWith(`| ${CACHE_ROW} |`))
  const m = line ? /TTL at most (\d+) hours?/.exec(line) : null
  return m ? Number(m[1]) : null
}

/** Human-readable drift report: empty when the registry equals the catalogue. */
export function catalogueDrift(md: string): string[] {
  const problems: string[] = []
  const rows = parseLogRows(md)
  for (const c of LOG_CLASSES) {
    const r = rows.find((x) => x.row === c.row)
    if (!r) {
      problems.push(`${c.row}: not in the catalogue`)
      continue
    }
    if (r.regularDays !== c.regularDays) problems.push(`${c.row}: regular ${c.regularDays} d in the registry, ${r.regularDays} d in the catalogue`)
    if (r.capDays !== c.capDays) problems.push(`${c.row}: cap ${c.capDays} d in the registry, ${r.capDays} d in the catalogue`)
  }
  for (const r of rows) if (!LOG_CLASSES.some((c) => c.row === r.row)) problems.push(`${r.row}: in the catalogue, not in the registry`)
  const ttl = parseCacheTtlHours(md)
  if (ttl !== CACHE_TTL_HOURS) problems.push(`${CACHE_ROW}: TTL ${CACHE_TTL_HOURS} h in the registry, ${ttl ?? 'unreadable'} h in the catalogue`)
  return problems
}
