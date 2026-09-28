// TASK-062 TDD 5 (wiring): routes/settings/+page.server.ts exposes the
// `locale` form action and it reaches the LocalePreferencePort with the
// tenant as customer and personIdOf(locals) as person.
import { afterEach, describe, expect, test } from 'vitest'
import { isRedirect } from '@sveltejs/kit'
import { actions } from '../../../routes/settings/+page.server'
import { configureLocalePreference, getLocalePreferencePort, resetLocalePreferenceForTest } from './locale-preference-port'
import { configurePersonIdMapperForTest, resetPersonIdMapperForTest } from './person-id'

afterEach(() => {
  resetLocalePreferenceForTest()
  resetPersonIdMapperForTest()
})

describe('settings ?/locale action (TASK-062)', () => {
  test('POST en writes the preference for the tenant/person and answers 303', async () => {
    configureLocalePreference({ backend: 'memory' })
    configurePersonIdMapperForTest((subject) => (subject === 'kc-subject' ? 'person-7' : null))
    const cookies: string[] = []
    const url = 'https://pilot.test/settings?/locale'
    const event = {
      request: new Request(url, { method: 'POST', body: new URLSearchParams({ locale: 'en', redirectTo: '/settings' }) }),
      url: new URL(url),
      cookies: { set: (name: string, value: string) => void cookies.push(`${name}=${value}`) },
      locals: { user: { id: 'kc-subject' }, tenant: { id: 'tenant-1' } }
    }
    let outcome: unknown
    try {
      outcome = await actions.locale(event as never)
    } catch (thrown) {
      outcome = thrown
    }
    expect(isRedirect(outcome)).toBe(true)
    expect(outcome).toMatchObject({ status: 303, location: '/settings' })
    expect(cookies).toEqual(['gremion.locale=en'])
    expect(await getLocalePreferencePort().get('tenant-1', 'person-7')).toMatchObject({ locale: 'en', rowVersion: 1 })
  })
})
