// TASK-062 TDD 4 — the LocalePreferencePort contract, memory backend (the pg
// backend runs the same suite in locale-preference-pg.integration.test.ts).
import { describe, it, expect } from 'vitest'
import {
  configureLocalePreference,
  createLocalePreferencePort,
  getLocalePreferencePort,
  resetLocalePreferenceForTest
} from './locale-preference-port'
import { CONTRACT_IDS, describeLocalePreferenceContract } from './testing/locale-preference-contract'

describeLocalePreferenceContract('memory', {
  fresh: async () =>
    createLocalePreferencePort({
      backend: 'memory',
      customerDefaults: { [CONTRACT_IDS.customerA]: 'en', [CONTRACT_IDS.customerB]: 'de' }
    })
})

describe('LocalePreferencePort registry', () => {
  it('getLocalePreferencePort() throws until configured (so an unbound port is never a silent no-op)', () => {
    resetLocalePreferenceForTest()
    expect(() => getLocalePreferencePort()).toThrow(/not configured/)
  })

  it('resetLocalePreferenceForTest() clears rows between tests', async () => {
    configureLocalePreference({ backend: 'memory' })
    await getLocalePreferencePort().set(CONTRACT_IDS.customerA, CONTRACT_IDS.person1, 'en')
    resetLocalePreferenceForTest()
    configureLocalePreference({ backend: 'memory' })
    expect(await getLocalePreferencePort().get(CONTRACT_IDS.customerA, CONTRACT_IDS.person1)).toBeNull()
  })
})
