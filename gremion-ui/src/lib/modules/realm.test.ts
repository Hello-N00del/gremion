import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeRealm } from './realm'
import { MODULE_MANIFESTS } from './registry'

const KC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docker', 'keycloak')
// The shipped base template carries the deployment apex host as the
// `__APEX_DOMAIN__` sentinel (resolved at Keycloak boot by
// docker/keycloak/substitute-realm-secrets.sh, and by loadBaseRealmDoc() in
// scripts/tenant-provision.ts). Resolve it to this suite's example apex so the
// fixtures exercise the same shape a real deployment gets.
const TEST_APEX = 'council.example'
const base = JSON.parse(
  readFileSync(join(KC, 'realm-export.base.json'), 'utf-8').split('__APEX_DOMAIN__').join(TEST_APEX),
)
const original = JSON.parse(
  readFileSync(join(KC, 'realm-export.json'), 'utf-8').split('__APEX_DOMAIN__').join(TEST_APEX),
)
const cfg = () => ({ modules: {} }) as any

// Carve note: the governance-only kernel ships exactly the two always-on
// manifests (core, governance), neither of which declares a realm fragment, so
// composeRealm injects nothing — the composed output equals the committed
// governance-only realm-export.json. The carved-out finance module's
// ref-finanzen groups + `finance` realm role are gone from both the base
// template and the generated export.
describe('composeRealm (P0.2) — governance-only kernel', () => {
  it('output deep-equals the committed realm-export.json (kernel adds no module realm fragments)', () => {
    expect(composeRealm(base, MODULE_MANIFESTS, cfg())).toEqual(original)
  })

  it('carries the four kernel realm roles and no carved-out finance role', () => {
    const r = composeRealm(base, MODULE_MANIFESTS, cfg()) as any
    const roleNames = r.roles.realm.map((x: any) => x.name)
    expect(roleNames).toEqual(expect.arrayContaining(['guest', 'member', 'council-admin', 'it-admin']))
    expect(roleNames).not.toContain('finance')
    expect(r.groups.map((g: any) => g.name)).not.toContain('ref-finanzen')
  })

  it('every client scopeMappings entry carries the base roles and no finance role', () => {
    const r = composeRealm(base, MODULE_MANIFESTS, cfg()) as any
    const clients = (r.scopeMappings ?? []).filter((sm: any) => sm.client)
    for (const sm of clients) {
      expect(sm.roles).toEqual(expect.arrayContaining(['guest', 'member', 'council-admin', 'it-admin']))
      expect(sm.roles).not.toContain('finance')
    }
  })

  it('base template carries no council.example path-wildcard redirect URIs (#240)', () => {
    expect(JSON.stringify(base)).not.toContain('https://council.example/*')
    expect(JSON.stringify(original)).not.toContain('https://council.example/*')
  })

  it('every app client in the base template pins fullScopeAllowed:false (#254)', () => {
    for (const c of (base as any).clients) {
      expect(c.fullScopeAllowed, `client ${c.clientId} must set fullScopeAllowed:false`).toBe(false)
    }
  })
})
