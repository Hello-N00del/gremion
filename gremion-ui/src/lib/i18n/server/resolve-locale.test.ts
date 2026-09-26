// TASK-062 TDD 1 — resolveLocale table test (brief §6.1).
//
// Covers the resolution order (brief §5): explicit de/en of the signed-in
// person -> cookie -> Accept-Language -> customer default_locale (this is
// where `follow_customer` resolves too) -> 'de'; plus a garbage cookie, a
// weighted Accept-Language header, and an empty header.
import { describe, it, expect } from 'vitest'
import { resolveLocale, type ResolveLocaleInput, type Locale } from './resolve-locale'

describe('resolveLocale — resolution order (TRD-412)', () => {
  const cases: Array<{ name: string; input: ResolveLocaleInput; want: Locale }> = [
    {
      name: 'explicit person preference wins over everything else',
      input: {
        personPreference: 'en',
        cookie: 'de',
        acceptLanguage: 'de-DE',
        customerDefaultLocale: 'de'
      },
      want: 'en'
    },
    {
      name: 'no person preference: cookie wins over Accept-Language and customer default',
      input: {
        personPreference: null,
        cookie: 'en',
        acceptLanguage: 'de-DE',
        customerDefaultLocale: 'de'
      },
      want: 'en'
    },
    {
      name: "follow_customer: cookie still wins (it is the person's per-device mirror, Q4)",
      input: {
        personPreference: 'follow_customer',
        cookie: 'en',
        acceptLanguage: 'de-DE',
        customerDefaultLocale: 'de'
      },
      want: 'en'
    },
    {
      name: 'a garbage cookie is ignored, falling through to Accept-Language',
      input: {
        personPreference: null,
        cookie: 'xx-not-a-locale',
        acceptLanguage: 'en-US',
        customerDefaultLocale: 'de'
      },
      want: 'en'
    },
    {
      name: 'weighted Accept-Language: en-US;q=0.9,de;q=0.8 picks en (higher q)',
      input: {
        personPreference: null,
        cookie: null,
        acceptLanguage: 'en-US;q=0.9,de;q=0.8',
        customerDefaultLocale: 'de'
      },
      want: 'en'
    },
    {
      name: 'reversed weights: de;q=0.9,en-US;q=0.8 picks de',
      input: {
        personPreference: null,
        cookie: null,
        acceptLanguage: 'de;q=0.9,en-US;q=0.8',
        customerDefaultLocale: 'en'
      },
      want: 'de'
    },
    {
      name: 'follow_customer with no cookie and no Accept-Language match: customer default_locale',
      input: {
        personPreference: 'follow_customer',
        cookie: null,
        acceptLanguage: null,
        customerDefaultLocale: 'en'
      },
      want: 'en'
    },
    {
      name: 'no person preference (never signed in), no cookie, empty Accept-Language: customer default',
      input: {
        personPreference: null,
        cookie: null,
        acceptLanguage: '',
        customerDefaultLocale: 'en'
      },
      want: 'en'
    },
    {
      name: 'nothing resolves anywhere: falls all the way to de',
      input: {
        personPreference: null,
        cookie: null,
        acceptLanguage: null,
        customerDefaultLocale: null
      },
      want: 'de'
    },
    {
      name: 'Accept-Language with an unrecognized language tag is ignored',
      input: {
        personPreference: null,
        cookie: null,
        acceptLanguage: 'fr-FR,ja;q=0.5',
        customerDefaultLocale: 'en'
      },
      want: 'en'
    }
  ]

  for (const { name, input, want } of cases) {
    it(name, () => {
      expect(resolveLocale(input)).toBe(want)
    })
  }
})
