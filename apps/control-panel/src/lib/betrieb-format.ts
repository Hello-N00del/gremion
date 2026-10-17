// apps/control-panel/src/lib/betrieb-format.ts — how the "Betrieb" page prints a
// value; shared by the server module and the page (no server-only import here).
export type Unit = 'age' | 'percent' | 'count' | 'bytes'

const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 })
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 })

export function formatValue(v: number, unit: Unit): string {
  switch (unit) {
    case 'age': {
      if (v < 3600) return `vor ${nf0.format(Math.max(0, Math.round(v / 60)))} min`
      if (v < 2 * 86400) return `vor ${nf0.format(Math.round(v / 3600))} h`
      return `vor ${nf0.format(Math.round(v / 86400))} d`
    }
    case 'percent':
      return `${nf1.format(v)} %`
    case 'bytes': {
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let i = 0
      let x = v
      while (x >= 1024 && i < units.length - 1) {
        x /= 1024
        i++
      }
      return `${nf1.format(x)} ${units[i]}`
    }
    default:
      return nf0.format(v)
  }
}

export interface SummaryInput {
  rows: { level: string }[]
  error: string | null
}

/**
 * The page's one-line verdict. A tile without data is NOT healthy (review r1):
 * it is counted and named, so a missing backup or container metric never
 * reads as "Keine Auffälligkeiten".
 */
export function summarize(panels: SummaryInput[]): { attention: boolean; text: string } {
  const flagged = panels.reduce((n, p) => n + p.rows.filter((r) => r.level !== 'ok').length + (p.error ? 1 : 0), 0)
  const empty = panels.filter((p) => p.rows.length === 0 && !p.error).length
  const parts: string[] = []
  if (flagged > 0) parts.push(`${flagged} ${flagged === 1 ? 'Auffälligkeit' : 'Auffälligkeiten'}, oben in den Kacheln`)
  if (empty > 0) parts.push(`${empty} ${empty === 1 ? 'Kachel' : 'Kacheln'} ohne Daten`)
  if (parts.length === 0) return { attention: false, text: 'Keine Auffälligkeiten.' }
  return { attention: true, text: `${parts.join('; ')}.` }
}
