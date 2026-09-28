// TASK-062 TDD 1/2 — gremion-public locale resolution (brief §6.1/6.2).
//
// gremion-public has no session and no tenant concept (app.d.ts: "No
// session — this app is fully public"), so the resolution order here is the
// tail of gremion-ui's cascade: cookie -> Accept-Language -> 'de'. No
// person preference, no customer default — there is no signed-in person or
// customer here to have one.
import { describe, it, expect } from 'vitest'
import { resolveLocale, type ResolveLocaleInput, type Locale } from './resolve-locale'

describe('resolveLocale (gremion-public)', () => {
  const cases: Array<{ name: string; input: ResolveLocaleInput; want: Locale }> = [
    { name: 'cookie wins over Accept-Language', input: { cookie: 'en', acceptLanguage: 'de-DE' }, want: 'en' },
    { name: 'a garbage cookie falls through to Accept-Language', input: { cookie: 'xx', acceptLanguage: 'en-US' }, want: 'en' },
    { name: 'no cookie, Accept-Language: en-US -> en', input: { cookie: null, acceptLanguage: 'en-US' }, want: 'en' },
    { name: 'no cookie, Accept-Language: de-DE -> de', input: { cookie: null, acceptLanguage: 'de-DE' }, want: 'de' },
    { name: 'no cookie, no header -> de', input: { cookie: null, acceptLanguage: null }, want: 'de' },
    {
      name: 'weighted: a lower-q tag listed first still loses to a higher-q tag listed later',
      input: { cookie: null, acceptLanguage: 'de;q=0.1,en;q=0.9' },
      want: 'en'
    },
    { name: 'q=0 is not acceptable (RFC 9110 §12.4.2)', input: { cookie: null, acceptLanguage: 'en;q=0' }, want: 'de' },
    { name: 'unrecognized language tag is ignored', input: { cookie: null, acceptLanguage: 'fr-FR' }, want: 'de' }
  ]

  it.each(cases)('$name', ({ input, want }) => {
    expect(resolveLocale(input)).toBe(want)
  })

  // R26-TRAIN4-FIX r3: a locale the pages are not written in is never chosen.
  const germanOnly: Array<{ name: string; input: ResolveLocaleInput }> = [
    { name: 'an en cookie is not applied', input: { cookie: 'en', acceptLanguage: 'de-DE' } },
    { name: 'Accept-Language en-US is not applied', input: { cookie: null, acceptLanguage: 'en-US' } },
    { name: 'a preferred en falls to the acceptable de', input: { cookie: null, acceptLanguage: 'en;q=0.9,de;q=0.1' } }
  ]

  it.each(germanOnly)("content locales ['de']: $name -> de", ({ input }) => {
    expect(resolveLocale(input, ['de'])).toBe('de')
  })
})
