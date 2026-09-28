// TASK-062 TDD 3 (TRD-412): one catalogue, compiled by Paraglide, with no
// raw key reaching a DE or EN render.
//
// Guards, each falsifiable:
//   - de/en key sets are identical and non-empty (a dropped EN key goes RED);
//   - no empty translation;
//   - every catalogue key compiles to a Paraglide message reachable as
//     m['dotted.key'] (Q5) that returns the catalogue text per locale;
//   - every literal `$t('…')` key used anywhere in src/ exists in the
//     catalogue, so no consumer can render its raw key (e.g. `nav.files`).
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import de from './messages/de.json'
import en from './messages/en.json'
import * as m from './paraglide/messages.js'

const SRC = join(__dirname, '..', '..')
const I18N = __dirname

type Catalogue = Record<string, string>
const catalogues: Record<'de' | 'en', Catalogue> = { de, en }
const messages = m as unknown as Record<string, (inputs?: object, options?: { locale?: 'de' | 'en' }) => string>

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry === 'paraglide') continue
    if (statSync(full).isDirectory()) walk(full, out)
    else if ((entry.endsWith('.svelte') || entry.endsWith('.ts')) && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('message catalogue (TASK-062 TDD 3)', () => {
  test('de and en carry the same, non-empty key set', () => {
    const deKeys = Object.keys(de).sort()
    const enKeys = Object.keys(en).sort()
    expect(deKeys.length).toBeGreaterThan(200)
    expect(enKeys).toEqual(deKeys)
  })

  test('no translation is empty', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const empty = Object.entries(catalogue)
        .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
        .map(([k]) => `${locale}:${k}`)
      expect(empty).toEqual([])
    }
  })

  test('every key compiles to m[key] and renders its catalogue text per locale', () => {
    const missing: string[] = []
    const wrong: string[] = []
    for (const key of Object.keys(de)) {
      const fn = messages[key]
      if (typeof fn !== 'function') {
        missing.push(key)
        continue
      }
      for (const locale of ['de', 'en'] as const) {
        if (fn({}, { locale }) !== catalogues[locale][key]) wrong.push(`${locale}:${key}`)
      }
    }
    expect(missing).toEqual([])
    expect(wrong).toEqual([])
  })

  test('every literal $t() key used in src/ exists in the catalogue (no raw key can render)', () => {
    const used = new Map<string, string>()
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\$t\(\s*'([^']+)'\s*\)/g)) {
        used.set(match[1]!, relative(SRC, file))
      }
    }
    expect(used.size).toBeGreaterThan(20)
    const unknown = [...used].filter(([key]) => !(key in de)).map(([key, file]) => `${key} (${file})`)
    expect(unknown).toEqual([])
  })

  test('the legacy TypeScript dictionaries are gone: one catalogue (brief §4)', () => {
    expect(existsSync(join(I18N, 'de.ts'))).toBe(false)
    expect(existsSync(join(I18N, 'en.ts'))).toBe(false)
  })
})
