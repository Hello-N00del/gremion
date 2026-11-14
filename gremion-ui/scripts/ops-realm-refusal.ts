// Why `gremion-tenant init` refuses an existing ops realm, as one pure function.
//
// The realm carries one fingerprint, sha256(template text + "\n" + panel origin), so a
// mismatch has two causes with two different remedies, and the stored value alone cannot
// tell them apart:
//   - ORIGIN: the realm was made for another panel origin. The origin is bound to the
//     realm's redirect URIs, web origin and fingerprint and cannot change in place; the
//     install needs a new ops realm.
//   - TEMPLATE: the realm was made by an earlier release's template (same origin). It is
//     brought up to the current template by hand and re-stamped (upgrade runbook, step 8a).
// The realm's own control-panel client says which origin it was made for (its one redirect
// URI is `<origin>/*`): the fingerprint of the CURRENT template with THAT origin equals the
// stored one exactly when only the origin differs. gremion-tenant's kcadm path
// (init_realm_only_kcadm) does the same in bash and says the same words for the same case;
// test/host/tenant.bats holds that side, and scripts/check-control-panel-access.test.mjs
// holds the phrases both sides share.
//
// Five outcomes, so that "the client could not be read" is never worded like "the client
// says nothing":
//   origin      the stored origin is another one and the fingerprint is the current template's for it
//   template    the stored origin is this one: the template is the difference
//   both        the stored origin is another one and the fingerprint is not the current template's
//               for it either: origin and template differ (or the realm was edited by hand)
//   no-redirect the client was read and carries no `<origin>/*` redirect URI
//   unreadable  the client could not be read: the refusal carries a short form of the error
import { createHash } from 'node:crypto'

export type OpsRealmRefusalKind = 'origin' | 'template' | 'both' | 'no-redirect' | 'unreadable'

export interface OpsRealmRefusal {
  readonly kind: OpsRealmRefusalKind
  readonly message: string
}

export function opsRealmFingerprint(templateText: string, origin: string): string {
  return createHash('sha256').update(templateText).update('\n').update(origin).digest('hex')
}

/** The origin a realm was made for: its control-panel client's one redirect URI minus the `/*`. */
export function storedPanelOrigin(redirectUris: readonly string[] | undefined): string {
  const first = redirectUris?.[0] ?? ''
  return first.endsWith('/*') ? first.slice(0, -2) : ''
}

/** The longest error text a refusal carries. */
export const READ_ERROR_MAX = 160

/**
 * A short, safe form of why a read failed, for the refusal text: the first line, with a
 * credential in a URL (`scheme://user:secret@host`), the value of any key whose name holds
 * password, passwd, secret, token or api_key (`password=x`, `KEYCLOAK_ADMIN_PASSWORD=x`,
 * `"access_token":"x"`, `secret = "a b"`), an Authorization header and a `Bearer` token masked,
 * at most READ_ERROR_MAX characters. gremion-tenant's bash does the same masking.
 */
export function shortReadError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error'
  const first = raw.split(/\r?\n/)[0]?.trim() ?? ''
  const key = String.raw`([\w.-]*(?:password|passwd|secret|token|api[_-]?key)[\w.-]*["']?\s*[=:]\s*)`
  const masked = first
    .replace(/:\/\/[^/@\s]*@/g, '://***@')
    .replace(/\bAuthorization(["']?\s*[=:]\s*)[^"',&]*/gi, 'Authorization$1***')
    .replace(new RegExp(`${key}"[^"]*"`, 'gi'), '$1"***"')
    .replace(new RegExp(`${key}'[^']*'`, 'gi'), "$1'***'")
    .replace(new RegExp(`${key}[^\\s"',&]+`, 'gi'), '$1***')
    .replace(/\bBearer\s+\S+/gi, 'Bearer ***')
  const text = masked === '' ? 'no message' : masked
  return text.length > READ_ERROR_MAX ? `${text.slice(0, READ_ERROR_MAX - 3)}...` : text
}

/**
 * Reads the realm's control-panel client (the origin the realm was made for is its one redirect
 * URI). A failed read (a 403, a 500, an expired session, an answer that is not a list) is NOT "the
 * client carries no redirect URI": it comes back as `storedReadError`, a short masked form of the
 * error, and the refusal words the two differently. A list without that client is no error.
 */
export async function readStoredPanelClient(
  raw: (method: string, path: string, body?: unknown) => Promise<unknown>,
  realm: string,
): Promise<{ storedRedirectUris: string[] | undefined; storedReadError: string | undefined }> {
  try {
    const clients = await raw('GET', `/admin/realms/${realm}/clients?clientId=control-panel`)
    if (clients === undefined || clients === null) return { storedRedirectUris: undefined, storedReadError: undefined }
    if (!Array.isArray(clients)) return { storedRedirectUris: undefined, storedReadError: 'the answer is not a list of clients' }
    const first: unknown = clients[0]
    const uris: unknown = typeof first === 'object' && first !== null ? (first as { redirectUris?: unknown }).redirectUris : undefined
    const list = Array.isArray(uris) ? uris.filter((u): u is string => typeof u === 'string') : undefined
    return { storedRedirectUris: list, storedReadError: undefined }
  } catch (e) {
    return { storedRedirectUris: undefined, storedReadError: shortReadError(e) }
  }
}

export function opsRealmRefusal(args: {
  realm: string
  templateText: string
  origin: string
  storedFingerprint: string | undefined
  storedRedirectUris: readonly string[] | undefined
  /** Set when reading the realm's control-panel client failed: the short form of the error (shortReadError). */
  storedReadError?: string | undefined
}): OpsRealmRefusal {
  const { realm, templateText, origin, storedFingerprint } = args
  const stored = storedPanelOrigin(args.storedRedirectUris)
  const head = `realm ${realm} differs from realm-export.ops.json for panel origin ${origin}`
  const fp = storedFingerprint ?? 'absent'
  const notKnown = `either the origin changed (it cannot change in place; the install needs a new ops realm) or the realm was made by an earlier template (docs/ops/runbook/upgrade.md, step 8a, whose precondition tells which)`
  if (args.storedReadError !== undefined && args.storedReadError !== '') {
    return {
      kind: 'unreadable',
      message: `${head} (fingerprint ${fp}): the realm's control-panel client could not be read (${args.storedReadError}), so the origin it was made for is not known; ${notKnown}`,
    }
  }
  if (stored !== '' && stored !== origin) {
    if (storedFingerprint === opsRealmFingerprint(templateText, stored)) {
      return {
        kind: 'origin',
        message: `${head}: it was made for the panel origin ${stored}, and an origin cannot change in place (the realm's redirect URIs, web origin and fingerprint are bound to it); this install needs a new ops realm for ${origin}, or its origin put back to ${stored}. The template is not the difference, so step 8a of docs/ops/runbook/upgrade.md does not apply`,
      }
    }
    return {
      kind: 'both',
      message: `${head} (fingerprint ${fp}): it was made for the panel origin ${stored}, and its fingerprint is not the current template's for ${stored} either, so the origin and the template both differ (or the realm was changed by hand). An origin cannot change in place: this install needs a new ops realm for ${origin}, or its origin put back to ${stored}, and then docs/ops/runbook/upgrade.md, step 8a (read its precondition first) decides about the template`,
    }
  }
  if (stored === origin) {
    return {
      kind: 'template',
      message: `${head}: the origin is the one it was made for, so its template is the difference (fingerprint ${fp}). A realm made by an earlier release's template is brought up to this one with kcadm, then re-stamped: docs/ops/runbook/upgrade.md, step 8a (read its precondition first)`,
    }
  }
  return {
    kind: 'no-redirect',
    message: `${head} (fingerprint ${fp}): the realm's control-panel client carries no redirect URI of the form <origin>/*, so the origin it was made for is not known; ${notKnown}`,
  }
}
