// R26-TRAIN4-FIX (WCAG 3.1.1, operator ruling 2026-09-27): `<html lang>`
// names the language the page is written in. The language is decided per
// page, not per shell: a route keeps the person's locale only when its page
// renders from the catalogue; every other route is declared German, shell
// routes (/beschluesse, /protokolle, /systemstatus, ...) included, and the
// catalogue strings around it (shell chrome, +error) render German with it.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import {
  UI_LOCALE_ATTRIBUTE,
  contentLocaleFor,
  htmlLangAttributes,
  syncDocumentLang,
  uiLocaleOf
} from './content-locale'

const ROUTES = join(__dirname, '..', '..', 'routes')
const SRC = join(ROUTES, '..')

describe('contentLocaleFor (route id)', () => {
  it.each([
    // Shell routes whose pages are hard-coded German (the round-3 verifier's list).
    ['/beschluesse', 'de'],
    ['/protokolle', 'de'],
    ['/systemstatus', 'de'],
    ['/committees', 'de'],
    ['/portal', 'de'],
    ['/members/committees/[id]/beschluesse', 'de'],
    ['/members/committees/[id]/protokolle', 'de'],
    ['/members/committees/[id]/protokolle/[protocolId]', 'de'],
    ['/members/committees/[id]/protokolle/new', 'de'],
    ['/settings/compliance/print', 'de'],
    // Routes outside the shell with German-only pages.
    ['/legal/impressum', 'de'],
    ['/setup', 'de'],
    ['/auth/step-up', 'de'],
    ['/auth/logout', 'de'],
    // Pages that render from the catalogue follow the person.
    ['/', 'en'],
    ['/settings', 'en'],
    ['/settings/[section]', 'en'],
    ['/members', 'en'],
    ['/members/committees/new', 'en'],
    ['/members/committees/[id]', 'en'],
    ['/auth/login', 'en'],
    // No matching route: SvelteKit renders +error, which renders from the catalogue.
    [null, 'en']
  ] as const)('%s -> %s for an English person', (routeId, expected) => {
    expect(contentLocaleFor(routeId, 'en')).toBe(expected)
  })

  it('a German person gets German everywhere', () => {
    for (const id of ['/', '/beschluesse', '/legal/impressum', null]) expect(contentLocaleFor(id, 'de')).toBe('de')
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

describe('uiLocaleOf', () => {
  it('the person locale: data-ui-locale when the page is declared in another language, else lang', () => {
    expect(uiLocaleOf(fakeRoot('de', { [UI_LOCALE_ATTRIBUTE]: 'en' }))).toBe('en')
    expect(uiLocaleOf(fakeRoot('en'))).toBe('en')
    expect(uiLocaleOf(fakeRoot('de'))).toBe('de')
    expect(uiLocaleOf(fakeRoot('xx'))).toBe('de')
  })
})

describe('syncDocumentLang (client-side navigation, root +layout.svelte)', () => {
  it('translated page -> German shell page: lang becomes de and the person locale is kept aside', () => {
    const root = fakeRoot('en')
    syncDocumentLang(root, '/beschluesse')
    expect(root.lang).toBe('de')
    expect(root.getAttribute(UI_LOCALE_ATTRIBUTE)).toBe('en')
  })

  it('shell -> legal page: lang becomes de and the person locale is kept aside', () => {
    const root = fakeRoot('en')
    syncDocumentLang(root, '/legal/impressum')
    expect(root.lang).toBe('de')
    expect(root.getAttribute(UI_LOCALE_ATTRIBUTE)).toBe('en')
  })

  it('German page (served lang="de" data-ui-locale="en") -> translated page: lang returns to en', () => {
    const root = fakeRoot('de', { [UI_LOCALE_ATTRIBUTE]: 'en' })
    syncDocumentLang(root, '/')
    expect(root.lang).toBe('en')
    expect(root.getAttribute(UI_LOCALE_ATTRIBUTE)).toBeNull()
  })

  it('a navigation that keeps the language writes nothing (no lang mutation)', () => {
    for (const [lang, id] of [
      ['en', '/settings/[section]'],
      ['de', '/'],
      ['de', '/legal/datenschutz'],
      ['de', '/beschluesse']
    ] as const) {
      const root = fakeRoot(lang)
      syncDocumentLang(root, id)
      expect(root.writes).toEqual([])
    }
    const onGerman = fakeRoot('de', { [UI_LOCALE_ATTRIBUTE]: 'en' })
    syncDocumentLang(onGerman, '/protokolle')
    expect(onGerman.writes).toEqual([])
  })
})

/** Every file below a directory, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const CATALOGUE = /\$lib\/i18n['/]|paraglide\/messages/

/** The .svelte files a component imports ($lib/... or relative). */
function svelteImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/from\s+['"]([^'"]+\.svelte)['"]/g)]
    .map((m) => m[1]!)
    .map((spec) =>
      spec.startsWith('$lib/') ? join(SRC, 'lib', spec.slice(5)) : spec.startsWith('.') ? join(dirname(file), spec) : null
    )
    .filter((p): p is string => p !== null && existsSync(p))
}

/** True when the component, or any .svelte component it imports, renders from the catalogue. */
function rendersFromCatalogue(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false
  seen.add(file)
  if (CATALOGUE.test(readFileSync(file, 'utf8'))) return true
  return svelteImports(file).some((f) => rendersFromCatalogue(f, seen))
}

describe('every page is declared in the language it renders in (guard)', () => {
  // Every +page.svelte under routes/, shell routes included: the round-3 scan
  // looked only at the routes outside the shell and so missed /beschluesse.
  const pages = filesUnder(ROUTES)
    .filter((f) => f.endsWith(`${sep}+page.svelte`))
    .map((file) => {
      const dir = relative(ROUTES, dirname(file)).split(sep).filter(Boolean).join('/')
      return { file, id: '/' + dir }
    })

  it('finds the pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(20)
    expect(pages.map((p) => p.id)).toContain('/beschluesse')
  })

  it.each(pages)('$id', ({ file, id }) => {
    const translated = rendersFromCatalogue(file)
    expect(contentLocaleFor(id, 'en'), `${id}: renders from the catalogue = ${translated}`).toBe(translated ? 'en' : 'de')
  })

  const layout = readFileSync(join(ROUTES, '+layout.svelte'), 'utf8')

  it('the root layout keeps <html lang> in step on client-side navigation, and again once it has landed', () => {
    expect(layout).toMatch(/onNavigate\(\(\{ to \}\) => \{\s*if \(to\) syncDocumentLang\(document\.documentElement, to\.route\.id\)/)
    expect(layout).toMatch(/afterNavigate\(\(\{ to \}\) => \{\s*if \(to\) syncDocumentLang\(document\.documentElement, to\.route\.id\)/)
  })

  it('the root layout renders the shell chrome in the page language', () => {
    expect(layout).toMatch(/<AppShell[^>]*\blocale=\{pageLocale\}/)
  })
})
