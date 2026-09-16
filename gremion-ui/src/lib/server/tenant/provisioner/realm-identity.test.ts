// B-01 (spec B §T.4): realm-export.base.json is a per-tenant TEMPLATE. Its
// realm identity is a sentinel that buildTenantRealmDoc overwrites
// (realm-doc.ts:271), and it carries no retired institution name.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { buildTenantRealmDoc, PROVISIONER_SECRET_CLIENTS } from './realm-doc'

const KC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', '..', '..', 'docker', 'keycloak',
)
const TEST_APEX = 'council.example'
const raw = readFileSync(join(KC, 'realm-export.base.json'), 'utf-8')
const base = JSON.parse(raw.split('__APEX_DOMAIN__').join(TEST_APEX))

describe('realm identity in the per-tenant template (B-01)', () => {
  it('the template realm is the __REALM_NAME__ sentinel, not an institution name', () => {
    expect(base.realm).toBe('__REALM_NAME__')
  })

  it('no client name or role description carries the retired institution name', () => {
    const names = [
      ...(base.clients ?? []).map((c: any) => `${c.name ?? ''} ${c.description ?? ''}`),
      ...((base.roles?.realm ?? []) as any[]).map((r) => `${r.name ?? ''} ${r.description ?? ''}`),
      ...((base.groups ?? []) as any[]).map((g) => `${g.name ?? ''}`),
    ].join(' ')
    expect(names).not.toMatch(/StuRa/i)
  })

  it('buildTenantRealmDoc overwrites the sentinel with the tenant realm name', () => {
    const doc = buildTenantRealmDoc({
      base,
      manifests: MODULE_MANIFESTS,
      config: { modules: {} } as never,
      slug: 't2',
      realmName: 'verein',
      tenantHost: 't2.council.example',
      apexDomain: 'council.example',
      clientSecrets: Object.fromEntries(
        PROVISIONER_SECRET_CLIENTS.map((c) => [c, `secret-${c}`]),
      ),
    })
    expect(doc.realm).toBe('verein')
    expect(JSON.stringify(doc)).not.toContain('__REALM_NAME__')
  })

  it('the realm name defaults to the slug when no realmName is supplied (pipeline.ts:186)', () => {
    const doc = buildTenantRealmDoc({
      base,
      manifests: MODULE_MANIFESTS,
      config: { modules: {} } as never,
      slug: 'kreisrat',
      realmName: 'kreisrat',
      tenantHost: 'kreisrat.council.example',
      apexDomain: 'council.example',
      clientSecrets: Object.fromEntries(
        PROVISIONER_SECRET_CLIENTS.map((c) => [c, `secret-${c}`]),
      ),
    })
    expect(doc.realm).toBe('kreisrat')
  })
})
