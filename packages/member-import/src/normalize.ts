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
  if (email.length > MAX_EMAIL || !EMAIL.test(email)) return false
  // RFC 5321: the local part is at most 64 octets (Keycloak 26's email validator refuses more)
  return email.indexOf('@') <= MAX_LOCAL_PART
}

export const MAX_EMAIL = 254
export const MAX_LOCAL_PART = 64
/** Keycloak 26's length validator on firstName / lastName. */
export const MAX_PERSON_NAME_PART = 255

// Keycloak 26's default user profile ("person-name-prohibited-characters" on
// firstName and lastName): a name carrying one of these is a 400 from the
// Admin API, which would end an apply midway. Mirrored here so such a row is
// rejected BEFORE the first account is created.
const PERSON_NAME_PROHIBITED = /[<>&"$%!#?§;*~/\\|^=[\]{}()\p{Cc}]/u

/** True when Keycloak 26's default user profile would accept `name` as a first / last name. */
export function isAcceptablePersonName(name: string): boolean {
  if (PERSON_NAME_PROHIBITED.test(name)) return false
  const i = name.lastIndexOf(' ')
  const first = i < 0 ? '' : name.slice(0, i)
  const last = i < 0 ? name : name.slice(i + 1)
  return first.length <= MAX_PERSON_NAME_PART && last.length <= MAX_PERSON_NAME_PART
}

/**
 * Text that may be logged: every e-mail address (plain or url-encoded) and
 * every `email=` query value removed. A last line of defence for errors of
 * unknown origin (a transport error names its request path, `?email=`).
 */
export function redactAddresses(text: string): string {
  return text
    .replace(/email=[^&\s"']*/gi, 'email=[redacted]')
    .replace(/[^\s"'<>(),;:/=]+(?:@|%40)[^\s"'<>(),;]+/gi, '[address]')
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
