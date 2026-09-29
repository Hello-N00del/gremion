// TASK-042 TDD 6 (TRD-042 [D R15-2], TRD-075): every tenant is equal. A tenant
// whose slug happens to be `default` gets exactly what `alpha` gets: its config
// under the data root, its own issuer as the Auth.js external base — with the
// deployment's AUTH_KEYCLOAK_* and CONFIG_PATH set to decoys that must NOT leak in.
// (Reconcile URIs: reconcile.test.ts (Q8); deletion: lifecycle.test.ts; backup
// database t_<slug>: test/backup.bats.)
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
  env: {
    CONFIG_PATH: '/decoy/config.json',
    AUTH_KEYCLOAK_ISSUER: 'https://decoy.example/auth/realms/decoy',
    AUTH_KEYCLOAK_BASE: 'https://decoy.example/auth/realms/decoy',
  },
}))

import { configPathForTenant, authExternalBaseForTenant } from './registry'

const savedRoot = process.env.TENANT_DATA_ROOT

function shapeFor(slug: string) {
  const issuer = `https://${slug}.council.example/auth/realms/${slug}`
  return {
    configPath: configPathForTenant(slug).split(slug).join('<slug>'),
    authExternalBase: authExternalBaseForTenant(issuer).split(slug).join('<slug>'),
  }
}

describe('every tenant is equal (TASK-042): no slug reads the deployment env', () => {
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.TENANT_DATA_ROOT
    else process.env.TENANT_DATA_ROOT = savedRoot
  })

  it('slug `default` gets /data/default/config.json and its own issuer', () => {
    delete process.env.TENANT_DATA_ROOT
    expect(configPathForTenant('default')).toBe('/data/default/config.json')
    const issuer = 'https://default.council.example/auth/realms/default'
    // The resolved context (slug `default`, decoy env set) is pinned by
    // registry.integration.test.ts point 6; the helper takes no slug at all.
    expect(authExternalBaseForTenant(issuer)).toBe(issuer)
    expect(authExternalBaseForTenant.length).toBe(1)
  })

  it('`default` and `alpha` are byte-equal up to the slug', () => {
    delete process.env.TENANT_DATA_ROOT
    expect(shapeFor('default')).toEqual(shapeFor('alpha'))
  })

  it('the data root is the deployment-global TENANT_DATA_ROOT, for every slug alike', () => {
    process.env.TENANT_DATA_ROOT = '/srv/gremion-data/'
    expect(configPathForTenant('default')).toBe('/srv/gremion-data/default/config.json')
    expect(configPathForTenant('alpha')).toBe('/srv/gremion-data/alpha/config.json')
  })
})
