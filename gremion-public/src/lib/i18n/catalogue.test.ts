// TASK-062 TDD 3 (gremion-public): the portal's catalogue uses gremion-ui's
// key naming (a shared key means the same string in both apps), de/en carry
// the same non-empty key set, and every key compiles to m['dotted.key'].
import { describe, expect, test } from 'vitest'
import de from './messages/de.json'
import en from './messages/en.json'
import uiDe from '../../../../gremion-ui/src/lib/i18n/messages/de.json'
import uiEn from '../../../../gremion-ui/src/lib/i18n/messages/en.json'
import * as m from './paraglide/messages.js'

type Catalogue = Record<string, string>
const messages = m as unknown as Record<string, (inputs?: object, options?: { locale?: 'de' | 'en' }) => string>
const catalogues: Record<'de' | 'en', Catalogue> = { de, en }

describe('gremion-public message catalogue (TASK-062 TDD 3)', () => {
  test('de and en carry the same, non-empty key set', () => {
    expect(Object.keys(de).length).toBeGreaterThan(0)
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort())
    for (const catalogue of Object.values(catalogues)) {
      expect(Object.entries(catalogue).filter(([, v]) => !v.trim())).toEqual([])
    }
  })

  test('keys follow the gremion-ui naming, and a key both apps carry means the same text', () => {
    for (const key of Object.keys(de)) expect(key).toMatch(/^[a-z0-9]+(\.[a-zA-Z0-9]+)+$/)
    const shared = Object.keys(de).filter((k) => k in uiDe)
    expect(shared.length).toBeGreaterThan(0)
    for (const key of shared) {
      expect(catalogues.de[key]).toBe((uiDe as Catalogue)[key])
      expect(catalogues.en[key]).toBe((uiEn as Catalogue)[key])
    }
  })

  test('every key compiles and renders its catalogue text per locale', () => {
    for (const locale of ['de', 'en'] as const) {
      for (const [key, text] of Object.entries(catalogues[locale])) {
        expect(messages[key]?.({}, { locale })).toBe(text)
      }
    }
  })
})
