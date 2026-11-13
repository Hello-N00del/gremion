// Settings > Profil: a signed-in member edits THEIR OWN first and last name.
//
// The target is the Keycloak user of the server-side session (locals.user.id, the
// ACCESS-token sub; the ID-token sub is pairwise, see src/auth.ts) and nothing
// else: not the form body, not the URL. The form is read for exactly two fields,
// firstName and lastName. The write goes through KeycloakAdminClient.updateUserNames,
// which keeps every other field of the user as it is stored.
//
// No role beyond Member is needed (every member edits their own name); the route
// is behind authGuard and SvelteKit's form-action origin check like the language switch.
import { fail } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { KcAdminError } from '$lib/server/keycloak-admin'

export const NAME_MAX = 80

/**
 * The text rule of the operator's free-text fields (packages/provisioning
 * printable-text.ts, which the root export does not publish): no C0/C1 control,
 * DEL, bidi control, line/paragraph separator or lone surrogate.
 */
// oxlint-disable-next-line no-control-regex -- the pattern exists to REFUSE control characters
const PRINTABLE = /^(?:[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])+$/

/**
 * The characters Keycloak's person-name-prohibited-characters validator refuses
 * (its default pattern, measured on 26.6.1: parentheses, semicolon, ampersand,
 * exclamation mark, slash, angle bracket and hash all answer 400
 * error-person-name-invalid-character; apostrophe and hyphen are accepted). The
 * form refuses them with its own field error, so a member is never told to retry
 * later for a name Keycloak will never take.
 */
const KC_PROHIBITED = /[<>&"$%!#?§;*~/\\|^=[\]{}()]/

export type NameField = 'firstName' | 'lastName'
export type NameFieldError = 'invalid' | 'chars'
export type ParsedName = { ok: true; firstName: string; lastName: string } | { ok: false; errors: Partial<Record<NameField, NameFieldError>>; values: Record<NameField, string> }

function field(form: FormData, key: NameField): string {
  const v = form.get(key)
  return typeof v === 'string' ? v : ''
}

/** Trim, then 1 to NAME_MAX printable characters per name. Reads no other form field. */
export function parseNameForm(form: FormData): ParsedName {
  const firstRaw = form.get('firstName')
  const lastRaw = form.get('lastName')
  const firstName = field(form, 'firstName').trim()
  const lastName = field(form, 'lastName').trim()
  const check = (name: string, raw: FormDataEntryValue | null): NameFieldError | null => {
    if (typeof raw !== 'string' || name.length < 1 || name.length > NAME_MAX || !PRINTABLE.test(name)) return 'invalid'
    return KC_PROHIBITED.test(name) ? 'chars' : null
  }
  const errors: Partial<Record<NameField, NameFieldError>> = {}
  const firstErr = check(firstName, firstRaw)
  const lastErr = check(lastName, lastRaw)
  if (firstErr) errors.firstName = firstErr
  if (lastErr) errors.lastName = lastErr
  if (Object.keys(errors).length > 0) return { ok: false, errors, values: { firstName, lastName } }
  return { ok: true, firstName, lastName }
}

export interface OwnNameDeps {
  updateUserNames(id: string, names: { firstName: string; lastName: string }): Promise<void>
}

export interface OwnNameEvent {
  request: Request
  locals: { user?: SessionUser | null }
}

export async function saveOwnName(event: OwnNameEvent, deps: OwnNameDeps) {
  const user = event.locals.user
  if (!user || typeof user.id !== 'string' || user.id === '' || !hasRole(user.roles, Role.Member)) {
    return fail(403, { profileName: { error: 'forbidden' as const } })
  }
  const parsed = parseNameForm(await event.request.formData())
  if (!parsed.ok) {
    return fail(400, { profileName: { error: 'invalid' as const, errors: parsed.errors, values: parsed.values } })
  }
  try {
    await deps.updateUserNames(user.id, { firstName: parsed.firstName, lastName: parsed.lastName })
  } catch (err) {
    // A name the form's own list missed but Keycloak's validator refuses: a field-level
    // error the member can fix, not a temporary outage.
    if (err instanceof KcAdminError && err.status === 400 && err.message.includes('error-person-name-invalid-character')) {
      // Keycloak 26.6.1 names the field in the body ({"field":"lastName",...}); when it does not, no field is marked.
      const bad = /"field"\s*:\s*"(firstName|lastName)"/.exec(err.message)?.[1] as NameField | undefined
      return fail(400, { profileName: { error: 'chars' as const, errors: bad ? { [bad]: 'chars' as const } : {}, values: { firstName: parsed.firstName, lastName: parsed.lastName } } })
    }
    // The error text can carry the Keycloak response body: log the class only, show nothing of it.
    console.error('[profile] own name not saved', { error: err instanceof Error ? err.name : typeof err })
    return fail(503, { profileName: { error: 'not-saved' as const, values: { firstName: parsed.firstName, lastName: parsed.lastName } } })
  }
  return { profileName: { saved: true as const } }
}
