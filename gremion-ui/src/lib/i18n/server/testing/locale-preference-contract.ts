// TASK-062 TDD 4 — the LocalePreferencePort contract (brief §6.4, Q1 default).
//
// ONE suite every adapter must pass (packages/storage's contract.test.ts is the
// house pattern). Test-only: imported by locale-preference-port.contract.test.ts
// (memory) and locale-preference-pg.integration.test.ts (pg on the idt
// fixture), never by app code.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { LocalePreferencePort } from '../locale-preference-port'

/** UUIDv7 literals: idt.customer_setting checks uuid_extract_version(customer_id) = 7. */
export const CONTRACT_IDS = {
  /** default_locale 'en' */
  customerA: '01926000-0000-7000-8000-00000000000a',
  /** default_locale 'de' */
  customerB: '01926000-0000-7000-8000-00000000000b',
  /** no customer_setting row */
  customerUnconfigured: '01926000-0000-7000-8000-00000000000c',
  person1: '01926000-0000-7000-8000-000000000001'
} as const

export interface ContractHarness {
  /** A fresh, empty preference store with the customers above configured. */
  fresh(): Promise<LocalePreferencePort>
  close?(): Promise<void>
}

export function describeLocalePreferenceContract(backend: string, harness: ContractHarness): void {
  const { customerA, customerB, customerUnconfigured, person1 } = CONTRACT_IDS

  describe(`LocalePreferencePort contract: backend=${backend}`, () => {
    let port: LocalePreferencePort

    beforeEach(async () => {
      port = await harness.fresh()
    })

    afterAll(async () => {
      await harness.close?.()
    })

    it('get() on a person with no row yet returns null', async () => {
      expect(await port.get(customerA, person1)).toBeNull()
    })

    it('set() writes the row: locale, row_version=1, updated_by_kind=person, updated_by=personId', async () => {
      const row = await port.set(customerA, person1, 'en')
      expect(row).toEqual({ locale: 'en', rowVersion: 1, updatedByKind: 'person', updatedBy: person1 })
      expect(await port.get(customerA, person1)).toEqual(row)
    })

    it('a second set() bumps row_version by exactly 1 and updates the locale', async () => {
      await port.set(customerA, person1, 'en')
      const second = await port.set(customerA, person1, 'de')
      expect(second).toEqual({ locale: 'de', rowVersion: 2, updatedByKind: 'person', updatedBy: person1 })
      expect(await port.get(customerA, person1)).toEqual(second)
    })

    it('set() accepts follow_customer as an explicit choice', async () => {
      const row = await port.set(customerA, person1, 'follow_customer')
      expect(row.locale).toBe('follow_customer')
    })

    it('set() rejects an unsupported locale instead of storing it', async () => {
      await expect(port.set(customerA, person1, 'fr' as never)).rejects.toThrow(/locale/)
      expect(await port.get(customerA, person1)).toBeNull()
    })

    it('RLS: a different customer reads nothing for the same personId', async () => {
      await port.set(customerA, person1, 'en')
      expect(await port.get(customerB, person1)).toBeNull()
    })

    it('getCustomerDefault() returns the per-customer default', async () => {
      expect(await port.getCustomerDefault(customerA)).toBe('en')
      expect(await port.getCustomerDefault(customerB)).toBe('de')
    })

    it('getCustomerDefault() falls back to de for a customer without a setting', async () => {
      expect(await port.getCustomerDefault(customerUnconfigured)).toBe('de')
    })
  })
}
