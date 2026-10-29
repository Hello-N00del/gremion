// TASK-077 G8 (static half): the realm template carries the kernel-API audience
// mapper on gremion-ui, access token only, exact audience. The live half
// (real tokens from a scratch Keycloak) is test/keycloak/audience.int.test.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REALM = fileURLToPath(new URL('../../../../docker/keycloak/realm-export.base.json', import.meta.url))

interface Mapper { name: string; protocolMapper: string; config: Record<string, string> }
interface Client { clientId: string; protocolMappers?: Mapper[] }

export function kernelAudienceMappers(doc: { clients: Client[] }): Mapper[] {
  const ui = doc.clients.find((c) => c.clientId === 'gremion-ui')
  return (ui?.protocolMappers ?? []).filter((m) => m.protocolMapper === 'oidc-audience-mapper' && m.config['included.custom.audience'] === 'gremion-kernel-api')
}

describe('G8 realm template: gremion-kernel-api audience', () => {
  const doc = JSON.parse(readFileSync(REALM, 'utf8')) as { clients: Client[] }

  it('gremion-ui has exactly one audience mapper for gremion-kernel-api', () => {
    expect(kernelAudienceMappers(doc)).toHaveLength(1)
  })

  it('is access-token only (never the ID token) and uses the custom audience, not a client audience', () => {
    const [m] = kernelAudienceMappers(doc)
    expect(m.config['access.token.claim']).toBe('true')
    expect(m.config['id.token.claim']).toBe('false')
    expect(m.config['included.client.audience']).toBeUndefined()
  })

  it('no other client carries the kernel audience (gremion-mobile gets none)', () => {
    for (const c of doc.clients.filter((x) => x.clientId !== 'gremion-ui')) {
      const hit = (c.protocolMappers ?? []).some((m) => m.config?.['included.custom.audience'] === 'gremion-kernel-api')
      expect(hit, c.clientId).toBe(false)
    }
  })

  it('the helper reports zero when the mapper is removed (guard (k), static)', () => {
    const stripped = structuredClone(doc)
    const ui = stripped.clients.find((c) => c.clientId === 'gremion-ui')!
    ui.protocolMappers = ui.protocolMappers!.filter((m) => m.config['included.custom.audience'] !== 'gremion-kernel-api')
    expect(kernelAudienceMappers(stripped)).toHaveLength(0)
  })
})
