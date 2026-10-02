// packages/provisioning/src/slug.ts — the customer slug, its token and its
// mail submission principal (TDD 1).
//
// The slug is SCHEMA's customer_slug_check (^[a-z][a-z0-9]*(-[a-z0-9]+)*$,
// `platform` reserved) capped at 30 characters: the slug is also a host label
// and the seed of the realm name, and gremion-ui's validateSlug (tenant/
// slug.ts) caps it there. The reserved list is validateSlug's RESERVED_SLUGS
// plus `platform` (the ops realm, Q5); gremion-ui's provisioner test asserts
// this set is a superset of its own, so the two cannot drift apart.
import { ProvisioningError } from './errors.ts'

export const CUSTOMER_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const MIN_SLUG = 3
export const MAX_SLUG = 30

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'platform',
  'gremion',
  'stura',
  'keycloak',
  'nextcloud',
  'helios',
  'postgres',
  'control',
  'template0',
  'template1',
  'public',
  'cloud',
  'matrix',
  'elections',
  'master',
])

/** The token the principal CLI accepts (ops/vendor-mail/principals.mjs TOKEN_RE). */
export const TENANT_TOKEN = /^[a-z][a-z0-9_]{2,39}$/

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function assertCustomerSlug(slug: string): string {
  if (typeof slug !== 'string') throw new ProvisioningError('INVALID_INPUT', `slug must be a string, got ${typeof slug}`)
  if (slug.length < MIN_SLUG || slug.length > MAX_SLUG) {
    throw new ProvisioningError('INVALID_INPUT', `slug ${JSON.stringify(slug)} must be ${MIN_SLUG} to ${MAX_SLUG} characters`)
  }
  if (!CUSTOMER_SLUG.test(slug)) {
    throw new ProvisioningError('INVALID_INPUT', `slug ${JSON.stringify(slug)} must match ${CUSTOMER_SLUG.source} (no leading digit, no double or trailing hyphen)`)
  }
  if (RESERVED_SLUGS.has(slug)) throw new ProvisioningError('INVALID_INPUT', `slug ${JSON.stringify(slug)} is reserved`)
  return slug
}

/** token = slug with every '-' replaced by '_' (TASK-043 §5). */
export function tokenFor(slug: string): string {
  const token = assertCustomerSlug(slug).replaceAll('-', '_')
  if (!TENANT_TOKEN.test(token)) throw new ProvisioningError('INVALID_INPUT', `token ${JSON.stringify(token)} does not match ${TENANT_TOKEN.source}`)
  return token
}

/** The customer's own submission principal on the vendor mail server (TRD-049). */
export function principalFor(token: string, platformDomain: string): string {
  if (!TENANT_TOKEN.test(token)) throw new ProvisioningError('INVALID_INPUT', `token ${JSON.stringify(token)} does not match ${TENANT_TOKEN.source}`)
  if (!DOMAIN.test(platformDomain)) throw new ProvisioningError('INVALID_INPUT', `platform domain ${JSON.stringify(platformDomain)} is not a lowercase DNS name`)
  return `kc-${token}@${platformDomain}`
}
