// packages/member-import/src/normalize.ts — the one place a name or an e-mail
// address is normalised (TASK-031 brief Q7: NFC + trim + lower-case, exact
// lookup). PURE.

/** NFC, trimmed, lower-cased: the identity an account is looked up by. */
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFC').trim().toLowerCase()
}

// Deliberately plain: one @, no whitespace, a dot in the domain. Keycloak and
// the mail relay are the real judges; this only refuses what can never be an address.
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && EMAIL.test(email)
}

/** NFC, trimmed, inner whitespace collapsed. */
export function normalizeName(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** The comparison key of a body or role label (case-insensitive, NFC). */
export function labelKey(raw: string): string {
  return normalizeName(raw).toLowerCase()
}

/**
 * Keycloak wants a first and a last name; the list carries one `name`. The last
 * space splits it ("Anna Maria Berger" -> "Anna Maria" / "Berger"); a single
 * word is the last name. Names are set on CREATE only, never updated on an
 * existing user.
 */
export function splitName(name: string): { firstName: string; lastName: string } {
  const n = normalizeName(name)
  const i = n.lastIndexOf(' ')
  return i < 0 ? { firstName: '', lastName: n } : { firstName: n.slice(0, i), lastName: n.slice(i + 1) }
}
