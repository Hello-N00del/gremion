import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/brand', () => ({
  requireBrand: vi.fn(() => ({
    product: 'Musterrat', logoLetter: 'S', orgShort: 'Muster-HS', term: 'SoSe 26',
    orgName: 'Studierendenrat der Musterhochschule', domain: 'stura.example.org',
    version: 'v2.4',
  })),
}))
vi.mock('$lib/server/db', () => ({ getDb: () => { throw new Error('no db in test') } }))
vi.mock('$lib/server/messages/matrix-client', () => ({ getMatrixClient: () => { throw new Error('no matrix') } }))

describe('+layout.server.ts brand via requireBrand', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())
  it('ships the resolved tenant brand in the layout payload', async () => {
    const { load } = await import('./+layout.server')
    // P2.2-auth A4: load() consults capabilitiesForTenant(locals.tenant) for the
    // nav filter — a config without a roles override keeps golden behavior.
    const event = { depends: () => {}, locals: { tenant: { config: {} }, auth: async () => null, accessToken: null } } as never
    // load() is typed LayoutServerLoad whose return union includes `void`;
    // narrow to the runtime payload shape (same pattern as layout.server.test.ts).
    const data = (await load(event)) as { brand: { orgShort: string } }
    expect(data.brand.orgShort).toBe('Muster-HS')
  })
})
