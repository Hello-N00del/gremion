// packages/provisioning/src/router.ts — the customer's edge router document
// (Q16, Q17). The container prints it (`tenant-create render-router <slug>`,
// the document on stdout, logs on stderr) and the HOST writes
// etc/edge/tenant-<slug>.yml with emit.ts's contract (tmp, fsync, rename, dir
// fsync): a compose `etc/edge` mount is refused (hygiene j4), so the host is
// the second writer (named deviation, Q17).
import { renderTenantRouter, type HostPolicy } from '@gremion/edge-routers'
import { ProvisioningError } from './errors.ts'
import { assertCustomerSlug } from './slug.ts'

export interface CustomerRouterInput extends HostPolicy {
  slug: string
  /** Every tenant_domain host of the customer. */
  hosts: readonly string[]
  /** The primary host: the issuer host, which gets the realm router. */
  primaryHost: string
  certResolver: string
}

export function renderCustomerRouter(input: CustomerRouterInput): string {
  const slug = assertCustomerSlug(input.slug)
  const r = renderTenantRouter({
    slug,
    domains: input.hosts.map((host) => ({ host })),
    certResolver: input.certResolver,
    normaliseHost: input.normaliseHost,
    isReservedHost: input.isReservedHost,
    keycloak: { realm: slug, host: input.primaryHost },
  })
  if (r.skipped.length) {
    throw new ProvisioningError('PRECONDITION', `host(s) not routable for ${slug}: ${r.skipped.map((s) => `${s.host} (${s.code}: ${s.reason})`).join('; ')}`)
  }
  if (!r.yaml || !r.keycloakRouter) throw new ProvisioningError('PRECONDITION', `no router rendered for ${slug}`)
  return r.yaml
}
