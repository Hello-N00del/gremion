// packages/provisioning/src/printable-text.ts -- the ONE text rule of the
// operator's free-text fields (brand, first body name, document reference):
// 1 to `max` characters, not blank, and none of: C0/C1 controls, DEL, the
// bidi controls (U+202A-202E, U+2066-2069), the line/paragraph separators
// (U+2028/2029) or a lone surrogate. No imports: apps/control-panel keeps a
// mirror of it (its image depends on no workspace package) and its
// requests.test.ts pins the pattern source and runs both over one corpus, so
// the panel refuses on the form exactly what request-verify refuses later.
// oxlint-disable-next-line no-control-regex -- the pattern exists to REFUSE control characters
export const PRINTABLE_TEXT = /^(?:[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])+$/

/** True when `v` is a string of 1 to `max` printable characters (not only blanks). */
export function isPrintableText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max && PRINTABLE_TEXT.test(v)
}
