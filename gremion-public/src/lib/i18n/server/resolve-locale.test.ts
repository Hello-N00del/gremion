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

  for (const { name, input, want } of cases) {
    it(name, () => {
      expect(resolveLocale(input)).toBe(want)
    })
  }
})
