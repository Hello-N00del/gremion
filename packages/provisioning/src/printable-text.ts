// packages/provisioning/src/printable-text.ts -- the ONE text rule of the
// operator's free-text fields (brand, first body name, document reference):
// 1 to `max` characters, no control characters (C0, DEL), not blank. No
// imports: apps/control-panel keeps a mirror of it (its image depends on no
// workspace package) and its requests.test.ts runs both over one corpus, so
// the panel refuses on the form exactly what request-verify refuses later.
const PRINTABLE = /^[^\u0000-\u001f\u007f]+$/

/** True when `v` is a string of 1 to `max` printable characters (not only blanks). */
export function isPrintableText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max && PRINTABLE.test(v)
}
