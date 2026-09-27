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
    },
    {
      name: 'weight wins over listed order: a lower-q tag listed FIRST still loses to a higher-q tag listed later',
      input: {
        personPreference: null,
        cookie: null,
        acceptLanguage: 'de;q=0.1,en;q=0.9',
        customerDefaultLocale: 'de'
      },
      want: 'en'
    },
    {
      name: 'RFC 9110 12.4.2: q=0 means not acceptable, so it is skipped rather than treated as a match',
      input: {
        personPreference: null,
        cookie: null,
        acceptLanguage: 'en;q=0',
        customerDefaultLocale: 'de'
      },
      want: 'de'
    },
    {
      // Q4 (brief §5, logged for TASK-004): a person who explicitly picked
      // follow_customer has, by definition, deferred to the customer default
      // — but the brief's own resolution order still runs Accept-Language
      // BEFORE "customer default_locale (this is where follow_customer
      // resolves too)". Applying the brief's written default literally:
      // Accept-Language outranks the customer default even under
      // follow_customer, with no cookie in play. This is the recommended
      // default from the brief, applied as-is; it is not this unit's
      // decision to change, and is named here per the review's LOW finding
      // so a future reader sees it was a deliberate application of the
      // written order, not an oversight.
      name: 'follow_customer, no cookie: Accept-Language still outranks the customer default (brief §5 order, applied literally — Q4/TASK-004)',
      input: {
        personPreference: 'follow_customer',
        cookie: null,
        acceptLanguage: 'en-US',
        customerDefaultLocale: 'de'
      },
      want: 'en'
    }
  ]

  it.each(cases)('$name', ({ input, want }) => {
    expect(resolveLocale(input)).toBe(want)
  })
})
