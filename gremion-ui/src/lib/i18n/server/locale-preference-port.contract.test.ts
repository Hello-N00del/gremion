// TASK-062 TDD 4 — LocalePreferencePort contract suite (brief §6.4, Q1 default).
//
// ONE suite, run against every backend in LOCALE_PREFERENCE_BACKENDS
// (packages/storage's contract.test.ts is the house pattern for this). Only
// the backend name differs between runs. Today that is just 'memory' — the
// pg adapter is a residual (see locale-preference-port.ts's header comment).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  configureLocalePreference,
  getLocalePreferencePort,
  resetLocalePreferenceForTest,
  LOCALE_PREFERENCE_BACKENDS
} from './locale-preference-port'

const CUSTOMER_A = 'cust-aaaaaaaa'
const CUSTOMER_B = 'cust-bbbbbbbb'
const PERSON_1 = 'person-11111111'

describe.each(LOCALE_PREFERENCE_BACKENDS)('LocalePreferencePort contract: backend=%s', (backend) => {
  beforeEach(() => {
    configureLocalePreference({ backend, customerDefaults: { [CUSTOMER_A]: 'en', [CUSTOMER_B]: 'de' } })
  })

  it('get() on a person with no row yet returns null', async () => {
    const port = getLocalePreferencePort()
    expect(await port.get(CUSTOMER_A, PERSON_1)).toBeNull()
  })

  it('set() writes the row: locale, row_version=1, updated_by_kind=person, updated_by=personId', async () => {
    const port = getLocalePreferencePort()
    const row = await port.set(CUSTOMER_A, PERSON_1, 'en')
    expect(row).toEqual({ locale: 'en', rowVersion: 1, updatedByKind: 'person', updatedBy: PERSON_1 })
    expect(await port.get(CUSTOMER_A, PERSON_1)).toEqual(row)
  })

  it('a second set() bumps row_version by exactly 1 and updates the locale', async () => {
    const port = getLocalePreferencePort()
    await port.set(CUSTOMER_A, PERSON_1, 'en')
    const second = await port.set(CUSTOMER_A, PERSON_1, 'de')
    expect(second).toEqual({ locale: 'de', rowVersion: 2, updatedByKind: 'person', updatedBy: PERSON_1 })
  })

  it('set() accepts follow_customer as an explicit choice', async () => {
    const port = getLocalePreferencePort()
    const row = await port.set(CUSTOMER_A, PERSON_1, 'follow_customer')
    expect(row.locale).toBe('follow_customer')
  })

  it('RLS: a different customer reads nothing for the same personId', async () => {
    const port = getLocalePreferencePort()
    await port.set(CUSTOMER_A, PERSON_1, 'en')
    expect(await port.get(CUSTOMER_B, PERSON_1)).toBeNull()
  })

  it('getCustomerDefault() returns the configured per-customer default', async () => {
    const port = getLocalePreferencePort()
    expect(await port.getCustomerDefault(CUSTOMER_A)).toBe('en')
    expect(await port.getCustomerDefault(CUSTOMER_B)).toBe('de')
  })

  it('getCustomerDefault() falls back to de for an unconfigured customer', async () => {
    const port = getLocalePreferencePort()
    expect(await port.getCustomerDefault('cust-unconfigured')).toBe('de')
  })
})

describe('LocalePreferencePort test isolation', () => {
  it('resetLocalePreferenceForTest() clears rows between tests', async () => {
    configureLocalePreference({ backend: 'memory' })
    const port = getLocalePreferencePort()
    await port.set(CUSTOMER_A, PERSON_1, 'en')
    resetLocalePreferenceForTest()
    configureLocalePreference({ backend: 'memory' })
    expect(await getLocalePreferencePort().get(CUSTOMER_A, PERSON_1)).toBeNull()
  })
})
