// @vitest-environment node
//
// How an identity is shown: the sender names of a message list (looked up in the customer's own
// Keycloak by the username behind the Matrix id) and the display name of a call participant.
// MATRIX_IDENTITY=namespaced puts the customer slug in front of the username; legacy ids such as
// max.mustermann are displayed exactly as before.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

const KC = vi.hoisted(() => ({ lookups: [] as string[] }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: () => ({
    listUsers: async (q: { username: string }) => {
      KC.lookups.push(q.username)
      return q.username === 'alice' ? [{ firstName: 'Alice', lastName: 'Muster' }] : []
    },
  }),
}))
vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: () => undefined }))

import { __resetSenderNamesForTests, createSenderNameResolver, getSenderNameResolver } from './sender-names'
import { livekitDisplayName } from './livekit-jwt'
import { fallbackSenderName } from '$lib/components/messaging/sender-label'

const ACME = { id: 'tid-acme', slug: 'acme', issuer: 'https://id.example.org/realms/acme' } as unknown as TenantContext

afterEach(() => {
  delete process.env.MATRIX_IDENTITY
  KC.lookups.length = 0
  __resetSenderNamesForTests()
})

describe('sender names', () => {
  test('a resolver without a slug looks the localpart up as it is, as before', async () => {
    const seen: string[] = []
    const r = createSenderNameResolver(async (u) => (seen.push(u), null))
    const names = await r.resolveMany(['@max.mustermann:synapse.test'])
    expect(seen).toEqual(['max.mustermann'])
    expect(names.get('@max.mustermann:synapse.test')).toBe('Max Mustermann')
  })

  test('a resolver with a slug looks up the username behind the prefix and shows a readable fallback', async () => {
    const seen: string[] = []
    const r = createSenderNameResolver(async (u) => (seen.push(u), null), { slug: 'acme' })
    const names = await r.resolveMany(['@acme.alice:synapse.test', '@acme.max_40example.org:synapse.test'])
    expect(seen.sort()).toEqual(['alice', 'max@example.org'])
    expect(names.get('@acme.alice:synapse.test')).toBe('Alice')
    expect(names.get('@acme.max_40example.org:synapse.test')).toBe('Max')
  })

  test('the per-customer resolver of a namespaced install uses the request customer\'s slug', async () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    const names = await runWithTenant(ACME, () => getSenderNameResolver().resolveMany(['@acme.alice:synapse.test']))
    expect(KC.lookups).toEqual(['alice'])
    expect(names.get('@acme.alice:synapse.test')).toBe('Alice Muster')
  })

  test('the per-customer resolver of a legacy install looks the localpart up unchanged', async () => {
    await runWithTenant(ACME, () => getSenderNameResolver().resolveMany(['@alice:synapse.test']))
    expect(KC.lookups).toEqual(['alice'])
  })

  test('the browser fallback, which knows no slug, shows an id as before', () => {
    expect(fallbackSenderName('@max.mustermann:synapse.test')).toBe('Max Mustermann')
    expect(fallbackSenderName('@acme.alice:synapse.test', 'acme')).toBe('Alice')
  })
})

describe('call participant name', () => {
  test('legacy: the localpart of the Matrix id', () => {
    expect(livekitDisplayName('@max.mustermann:synapse.test')).toBe('max.mustermann')
  })

  test('namespaced: the localpart without the slug of the request customer', () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    expect(runWithTenant(ACME, () => livekitDisplayName('@acme.alice:synapse.test'))).toBe('alice')
    // an address stays encoded, as it always was in a call
    expect(runWithTenant(ACME, () => livekitDisplayName('@acme.max_40example.org:synapse.test'))).toBe('max_40example.org')
  })

  test('namespaced: an id of another customer keeps its prefix', () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    expect(runWithTenant(ACME, () => livekitDisplayName('@beta.alice:synapse.test'))).toBe('beta.alice')
  })
})
