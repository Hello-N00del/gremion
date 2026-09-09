/** Deterministic 0–359 hue derived from a committee id.
 *
 * Used by /members and /calendar to colour committee chips/cards stably across
 * reloads without storing the value in the schema. Identical ids always yield
 * identical hues. */
export function deriveHue(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return hash % 360
}

/** Two-character uppercase abbreviation for a committee name.
 *
 * - Single word → first two letters (Plenum → "PL").
 * - Multi-word → first letter of each of the first two words (Haushalts Ausschuss → "HA").
 * - Strips non-letter/digit characters before splitting.
 * - Empty input → "??". */
export function deriveAbbr(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim()
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}
