// locale-en unit: the rail's German source labels and their catalogue messages.
//
// Guards, each falsifiable:
//   - every label a rail entry can show has a message (a new entry without one
//     goes RED, so the English rail cannot silently keep a German word);
//   - the German message equals the literal (de renders unchanged either way);
//   - the English message exists and differs, bar the two labels that are the
//     same word in both languages;
//   - a label with no entry, and a tenant's own wording, stay as written.
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import de from '$lib/i18n/messages/de.json'
import en from '$lib/i18n/messages/en.json'
import { baseNavSchema, navSchema, type NavItem, type NavTemplateEntry } from './nav-schema'
import { NAV_LABEL_MESSAGE_KEYS, localizeNav, localizeNavLabel } from './nav-localize'

const trFor = (catalogue: Record<string, string>) => (key: string) => catalogue[key] ?? key
const trEn = trFor(en)

/** Every label a rail entry can show: composed schema, the base template, labelIfOff wordings and every module manifest on disk. */
function railLabels(): Set<string> {
  const out = new Set<string>()
  const visit = (items: ReadonlyArray<NavItem | NavTemplateEntry>) => {
    for (const item of items) {
      if ('slot' in item) continue
      out.add(item.label)
      if (item.kind === 'item' && item.labelIfOff) out.add(item.labelIfOff.label)
      if (item.kind === 'section') visit(item.children)
    }
  }
  visit(navSchema)
  visit(baseNavSchema)
  // Modules that are not built into this registry (the vault) still ship rail entries in their own manifests.
  const modulesDir = join(__dirname, '..', '..', '..', '..', '..', 'modules')
  for (const id of existsSync(modulesDir) ? readdirSync(modulesDir) : []) {
    const dir = join(modulesDir, id, 'app', 'lib', 'modules', 'manifests')
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8')
      for (const m of src.matchAll(/kind:\s*'(?:item|section)'[^\n]*?\blabel:\s*'([^']+)'/g)) out.add(m[1]!)
      for (const m of src.matchAll(/labelIfOff:\s*\{[^}]*?\blabel:\s*'([^']+)'/g)) out.add(m[1]!)
    }
  }
  return out
}

describe('rail labels and the catalogue', () => {
  const labels = railLabels()

  test('finds the rail (kernel template and module entries)', () => {
    for (const known of ['Arbeitsbereich', 'Einstellungen', 'Räume', 'Abstimmungen & Wahlen', 'Abstimmungen', 'Tresor']) {
      expect(labels.has(known), known).toBe(true)
    }
  })

  test('every rail label has a catalogue key', () => {
    expect([...labels].filter((l) => !(l in NAV_LABEL_MESSAGE_KEYS))).toEqual([])
  })

  test('every key is in both catalogues, de equals the literal, en exists', () => {
    for (const [label, key] of Object.entries(NAV_LABEL_MESSAGE_KEYS)) {
      expect(de[key as keyof typeof de], `de ${key}`).toBe(label)
      expect(typeof en[key as keyof typeof en], `en ${key}`).toBe('string')
    }
  })

  test('the English text differs from the German one, bar the words that are the same in both', () => {
    const same = Object.entries(NAV_LABEL_MESSAGE_KEYS).filter(([label, key]) => label === en[key as keyof typeof en]).map(([l]) => l)
    expect(same.sort()).toEqual(['Matrix · Chat', 'Newsletter'])
  })

  test('no key is used for two labels', () => {
    const keys = Object.values(NAV_LABEL_MESSAGE_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('localizeNavLabel / localizeNav', () => {
  test('de: untouched, same tree', () => {
    expect(localizeNavLabel('Einstellungen', 'de', trEn)).toBe('Einstellungen')
    expect(localizeNav(navSchema, 'de', trEn)).toBe(navSchema)
  })

  test('en: every label of the composed rail is translated, structure and hrefs unchanged', () => {
    const out = localizeNav(navSchema, 'en', trEn)
    const flat = (nav: NavItem[]): string[] => nav.flatMap((i) => (i.kind === 'section' ? [i.label, ...flat(i.children)] : [i.label]))
    const hrefs = (nav: NavItem[]): string[] => nav.flatMap((i) => (i.kind === 'section' ? hrefs(i.children) : [i.href]))
    expect(hrefs(out)).toEqual(hrefs(navSchema))
    expect(flat(out)).toEqual(flat(navSchema).map((l) => en[NAV_LABEL_MESSAGE_KEYS[l] as keyof typeof en]))
  })

  test("a tenant's own wording and an unknown label stay as written", () => {
    expect(localizeNavLabel('Fachschaften', 'en', trEn)).toBe('Fachschaften')
    expect(localizeNavLabel('constructor', 'en', trEn)).toBe('constructor')
    expect(localizeNavLabel('__proto__', 'en', trEn)).toBe('__proto__')
  })

  test('a key the catalogue lacks never renders raw: the German label stays', () => {
    expect(localizeNavLabel('Einstellungen', 'en', (k) => k)).toBe('Einstellungen')
  })

  test('a label the translation does not reach is marked German; a translated one is not', () => {
    const tree: NavItem[] = [
      { kind: 'section', label: 'Fachschaften', children: [
        { kind: 'item', href: '/a', label: 'Einstellungen', icon: 'settings' },
        { kind: 'item', href: '/b', label: 'Eigene Seite', icon: 'file' },
        // Same word in both languages: translated (a catalogue entry), so no German mark.
        { kind: 'item', href: '/c', label: 'Newsletter', icon: 'send' }
      ] }
    ]
    const out = localizeNav(tree, 'en', trEn)
    const section = out[0]!
    expect(section.lang).toBe('de')
    const kids = section.kind === 'section' ? section.children : []
    expect(kids.map((k) => [k.label, k.lang])).toEqual([
      ['Settings', undefined],
      ['Eigene Seite', 'de'],
      ['Newsletter', undefined]
    ])
    // A catalogue without the message leaves the German label, marked as German.
    const bare = localizeNav(tree, 'en', (k) => k)
    expect(bare[0]!.kind === 'section' && bare[0]!.children[0]!.lang).toBe('de')
  })

  test('the input tree is not mutated', () => {
    const before = JSON.stringify(navSchema)
    localizeNav(navSchema, 'en', trEn)
    expect(JSON.stringify(navSchema)).toBe(before)
  })
})
