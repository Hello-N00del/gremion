// Case- and diacritic-folding for the palette search, so "ubersicht" finds "Übersicht".
// The same fold the palette's own page filter applies in the browser.

/** Lower-case and strip combining marks (NFD), for comparisons only, never for display. */
export function foldText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** True when `haystack` contains `needle` once both are folded. */
export function foldedIncludes(haystack: string, needle: string): boolean {
  return foldText(haystack).includes(foldText(needle))
}
