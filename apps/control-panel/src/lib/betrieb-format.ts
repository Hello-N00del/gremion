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
