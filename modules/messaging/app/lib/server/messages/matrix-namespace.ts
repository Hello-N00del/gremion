// Chat identity per customer on ONE shared Synapse (MATRIX_IDENTITY=legacy|namespaced).
//
// legacy (the default, unset counts as legacy): the Matrix localpart is the Keycloak username and a
// unit room's alias is `stura-<unit>`. That is right while one customer owns the homeserver.
//
// namespaced: the homeserver is shared by several customers, so every id and alias carries the
// customer's slug, and the app is the only party that decides which Matrix account a login is:
//
//   user      @<slug>.<escaped username>:<server>
//   alias     #stura.<slug>.<unit name slug>:<server>
//
// The customer registry only issues slugs matching SLUG_RE (^[a-z][a-z0-9]*(-[a-z0-9]+)*$), which
// carry no '.', so the FIRST '.' of a localpart always separates slug from username and the pair
// (slug, username) is recovered from the localpart: the mapping is injective. '-' would not do as
// the separator, because a slug may contain it. The alias uses the same separator; the legacy alias
// namespace `<slug>-` of the customer adapters is therefore NOT used here.
//
// Pure helpers first, then the two accessors that read the switch and the request's tenant.
import { getTenant } from '$lib/server/tenant/context'
import { decodeUsername, stripTenantPrefix } from '$lib/components/messaging/sender-label'

/** Room state event a namespaced room carries: `{ tenant_id }`, the customer the room belongs to. */
export const TENANT_MARKER_TYPE = 'org.gremion.tenant'

/** The slug shape of the customer registry (customer-ops need_slug). */
export const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export type MatrixIdentityMode = 'legacy' | 'namespaced'

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`matrix identity: invalid customer slug ${JSON.stringify(slug)}`)
}

const KEPT = /[a-z0-9.=/-]/

/**
 * Encode a Keycloak username as a Matrix localpart part. Characters of [a-z0-9.=/-] stay; every other
 * character becomes `_hh` per UTF-8 byte (lower-case hex), which is what decodeUsername reads. The
 * underscore itself is encoded too (`_5f`): left alone, a username holding a literal `_40` would
 * equal the encoding of an '@' and two members of one customer could share an account.
 */
export function escapeUsername(username: string): string {
  let out = ''
  for (const ch of username) {
    if (KEPT.test(ch)) {
      out += ch
      continue
    }
    for (const byte of new TextEncoder().encode(ch)) out += `_${byte.toString(16).padStart(2, '0')}`
  }
  return out
}

/** The Matrix localpart of a customer's member: `<slug>.<escaped username>`. */
export function matrixLocalpart(slug: string, username: string): string {
  assertSlug(slug)
  if (username === '') throw new Error('matrix identity: empty username')
  return `${slug}.${escapeUsername(username)}`
}

/**
 * The name part of a unit room alias, as it was before the namespaced mode: lower-cased, German
 * umlauts and sharp s transliterated, other diacritics stripped, every other run collapsed to one '-',
 * leading and trailing '-' trimmed. (provisioning/matrix-subsystem.ts prefixes `stura-`.)
 */
export function unitNameSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip any remaining diacritics (é→e)
    .replace(/[^a-z0-9]+/g, '-') // any non-alphanumeric run → single '-'
    .replace(/^-+|-+$/g, '') // trim leading/trailing '-'
}

/** The alias localpart of a customer's unit room: `stura.<slug>.<unit name slug>`. */
export function unitAliasLocalpart(slug: string, name: string): string {
  assertSlug(slug)
  return `stura.${slug}.${unitNameSlug(name)}`
}

/**
 * The alias localpart of a unit room's archive alias: `stura-archiv.<slug>.<unit name slug>-<ts>`
 * (namespaced). It carries the customer: on a shared homeserver the alias directory is global, so an
 * archive alias without it would collide between two customers archiving a same-named unit within
 * the same minute. The `stura-archiv.` prefix cannot be taken for a unit alias (`stura.`).
 */
export function archiveAliasLocalpart(slug: string, name: string, ts: string): string {
  assertSlug(slug)
  return `stura-archiv.${slug}.${unitNameSlug(name)}-${ts}`
}

/**
 * The unit alias localpart of the request's customer under the identity switch: `stura-<unit>` in
 * legacy mode (the same as provisioning's aliasLocalpart, unchanged), `stura.<slug>.<unit>` in
 * namespaced mode. Provisioning and room administration both derive the alias through this.
 */
export function currentUnitAliasLocalpart(name: string): string {
  return matrixIdentityMode() === 'namespaced' ? unitAliasLocalpart(getTenant().slug, name) : `stura-${unitNameSlug(name)}`
}

/** The archive alias localpart of the request's customer under the identity switch (`ts` is yyyymmddhhmm). */
export function currentArchiveAliasLocalpart(name: string, ts: string): string {
  return matrixIdentityMode() === 'namespaced'
    ? archiveAliasLocalpart(getTenant().slug, name, ts)
    : `stura-archiv-${unitNameSlug(name)}-${ts}`
}

/**
 * What an archive alias of the request's customer starts with, `#` included: `#stura-archiv-` in
 * legacy mode, `#stura-archiv.<slug>.` in namespaced mode, so an archive alias of another customer
 * found in room state is never taken for one of this customer's.
 */
export function currentArchiveAliasPrefix(): string {
  return matrixIdentityMode() === 'namespaced' ? `#stura-archiv.${getTenant().slug}.` : '#stura-archiv-'
}

export { stripTenantPrefix }

/** The Keycloak username a localpart of this customer stands for (prefix stripped, _hh undone). */
export function displayUsername(slug: string, localpart: string): string {
  return decodeUsername(stripTenantPrefix(localpart, slug))
}

/**
 * The identity mode of this process. Read at call time from MATRIX_IDENTITY (a deployment switch like
 * MESSAGES_BACKEND, not a per-customer value). Unset, empty and `legacy` are legacy. Any other value
 * than `namespaced` throws: a typo must refuse chat, never fall back to the shared-username identity.
 */
export function matrixIdentityMode(): MatrixIdentityMode {
  const raw = process.env.MATRIX_IDENTITY
  if (raw === undefined || raw === '' || raw === 'legacy') return 'legacy'
  if (raw === 'namespaced') return 'namespaced'
  throw new Error(`MATRIX_IDENTITY must be 'legacy' or 'namespaced', got ${JSON.stringify(raw)}`)
}

/** The slug to strip when displaying ids: the request customer's in namespaced mode, else null. */
export function identitySlug(): string | null {
  return matrixIdentityMode() === 'namespaced' ? getTenant().slug : null
}

/** The Matrix localpart of a member of the request's customer. Legacy reads no tenant context. */
export function currentMatrixLocalpart(username: string): string {
  return matrixIdentityMode() === 'namespaced' ? matrixLocalpart(getTenant().slug, username) : username
}
