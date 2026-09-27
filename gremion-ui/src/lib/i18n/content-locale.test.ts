// R26-TRAIN4-FIX r3 (WCAG 3.1.1, operator ruling 2026-09-27): `<html lang>`
// names the language the page is written in. Routes outside the app shell
// whose pages render no catalogue string (legal pages, the setup wizard, the
// step-up interstitial) are German whatever the person's locale, so they are
// declared German; every other route keeps the person's locale, because the
// shell (AppShell/NavDrawer/TopBar) and +error render from the catalogue.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  GERMAN_ONLY_ROUTE_PREFIXES,
  UI_LOCALE_ATTRIBUTE,
  contentLocaleFor,
  htmlLangAttributes,
  isGermanOnlyPath,
  syncDocumentLang
} from './content-locale'

const ROUTES = join(__dirname, '..', '..', 'routes')

describe('isGermanOnlyPath / contentLocaleFor', () => {
  it.each([
    ['/legal/impressum', true],
    ['/legal/datenschutz', true],
    ['/legal', true],
    ['/setup', true],
    ['/auth/step-up', true],
    ['/', false],
    ['/auth/login', false],
    ['/settings/darstellung', false],
    ['/legalese', false],
    ['/setupx', false]
  ])('%s -> %s (segment boundary, not a bare prefix)', (path, expected) => {
    expect(isGermanOnlyPath(path)).toBe(expected)
  })

  it('a German-only page is German for an English person; every other page follows the person', () => {
    expect(contentLocaleFor('/legal/impressum', 'en')).toBe('de')
    expect(contentLocaleFor('/legal/impressum', 'de')).toBe('de')
    expect(contentLocaleFor('/auth/login', 'en')).toBe('en')
    expect(contentLocaleFor('/', 'en')).toBe('en')
  })
})

describe('htmlLangAttributes', () => {
  it('names the content language, and the person locale only where it differs', () => {
    expect(htmlLangAttributes('en', 'en')).toBe('lang="en"')
    expect(htmlLangAttributes('de', 'de')).toBe('lang="de"')
    expect(htmlLangAttributes('de', 'en')).toBe(`lang="de" ${UI_LOCALE_ATTRIBUTE}="en"`)
  })
})

/** A stand-in for document.documentElement that records every write. */
function fakeRoot(lang: string, attrs: Record<string, string> = {}) {
  const writes: string[] = []
  const store = new Map(Object.entries(attrs))
  return {
    writes,
    get lang() {
      return lang
    },
    set lang(value: string) {
      writes.push(`lang=${value}`)
      lang = value
    },
    getAttribute: (name: string) => store.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      writes.push(`${name}=${value}`)
      store.set(name, value)
    },
    removeAttribute: (name: string) => {
      writes.push(`-${name}`)
      store.delete(name)
    }
  }
}

describe('syncDocumentLang (client-side navigation, root +layout.svelte onNavigate)', () => {
  it('shell -> legal page: lang becomes de and the person locale is kept aside', () => {
    const root = fakeRoot('en')
    syncDocumentLang(root, '/legal/impressum')
    expect(root.lang).toBe('de')
    expect(root.getAttribute(UI_LOCALE_ATTRIBUTE)).toBe('en')
  })

  it('legal page (served lang="de" data-ui-locale="en") -> shell: lang returns to en', () => {
    const root = fakeRoot('de', { [UI_LOCALE_ATTRIBUTE]: 'en' })
    syncDocumentLang(root, '/')
    expect(root.lang).toBe('en')
    expect(root.getAttribute(UI_LOCALE_ATTRIBUTE)).toBeNull()
  })

  it('a navigation that keeps the language writes nothing (no lang mutation)', () => {
    for (const [lang, path] of [
      ['en', '/settings'],
      ['de', '/'],
      ['de', '/legal/datenschutz']
    ] as const) {
      const root = fakeRoot(lang)
      syncDocumentLang(root, path)
      expect(root.writes).toEqual([])
    }
    const onLegal = fakeRoot('de', { [UI_LOCALE_ATTRIBUTE]: 'en' })
    syncDocumentLang(onLegal, '/legal/datenschutz')
    expect(onLegal.writes).toEqual([])
  })
})

/** Every file below a directory, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const usesCatalogue = (file: string) => /\$lib\/i18n|paraglide\/messages/.test(readFileSync(file, 'utf8'))

describe('the German-only list matches the routes (guard)', () => {
  const layout = readFileSync(join(ROUTES, '+layout.svelte'), 'utf8')
  // Routes outside the shell render no catalogue chrome of their own; the
  // root layout decides which those are.
  const nonShellPrefixes = [...layout.matchAll(/!\$page\.url\.pathname\.startsWith\('(\/[a-z-]+)'\)/g)].map((m) => m[1]!)

  it('reads the non-shell prefixes from the root layout', () => {
    expect(nonShellPrefixes).toEqual(['/auth', '/legal', '/setup'])
  })

  // Each rendered page outside the shell: German-only exactly when none of
  // its files render from the catalogue.
  const pages = nonShellPrefixes.flatMap((prefix) =>
    filesUnder(join(ROUTES, prefix.slice(1)))
      .filter((f) => f.endsWith(`${sep}+page.svelte`))
      .map((f) => ({ file: f, path: '/' + relative(ROUTES, f).split(sep).slice(0, -1).join('/') }))
  )

  it.each(pages)('$path', ({ file, path }) => {
    const dir = join(file, '..')
    const translated = filesUnder(dir).some((f) => f.endsWith('.svelte') && usesCatalogue(f))
    expect(isGermanOnlyPath(path), `${path}: renders from the catalogue = ${translated}`).toBe(!translated)
  })

  it('every listed prefix is a real non-shell route', () => {
    for (const prefix of GERMAN_ONLY_ROUTE_PREFIXES) {
      expect(nonShellPrefixes.some((p) => prefix === p || prefix.startsWith(p + '/'))).toBe(true)
      expect(pages.some((p) => p.path === prefix || p.path.startsWith(prefix + '/'))).toBe(true)
    }
  })

  it('the root layout keeps <html lang> in step on client-side navigation', () => {
    expect(layout).toMatch(/onNavigate\(/)
    expect(layout).toMatch(/syncDocumentLang\(document\.documentElement,/)
  })
})
