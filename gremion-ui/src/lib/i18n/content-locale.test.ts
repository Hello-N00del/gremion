// R26-TRAIN4-FIX (WCAG 2.2 SC 3.1.1, operator ruling 2026-09-27): `<html lang>`
// names the language the page is written in. The language is decided per
// page, not per shell, and fails safe: a route follows the person's locale
// only when its page is PROVEN translated (below); every other route is
// declared German, shell routes (/beschluesse, /protokolle, /systemstatus,
// ...) included, and the catalogue strings around it (shell chrome, +error)
// render German with it.
//
// "Proven translated" is checked mechanically over the real route tree
// (every +page.svelte, its nested +layout.svelte files and every .svelte
// component they import, recursively): the tree renders from the catalogue
// AND carries no hard-coded text, neither a text node nor a user-facing
// attribute (title, aria-label, placeholder, ...). A hard-coded string in this
// codebase is German (UX-015 German-first), so one of them is enough to keep a
// page German. A part explicitly marked lang="de" is German on purpose (WCAG
// 3.1.2) and does not count.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { parse } from 'svelte/compiler'
import {
  TRANSLATED_ROUTE_IDS,
  UI_LOCALE_ATTRIBUTE,
  contentLocaleFor,
  htmlLangAttributes,
  isTranslatedRoute,
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
    // Shell routes that render some catalogue strings but still carry
    // hard-coded German (headings, <title>, tab bodies): German until TASK-161.
    ['/', 'de'],
    ['/settings', 'de'],
    ['/settings/[section]', 'de'],
    ['/members', 'de'],
    ['/members/committees/new', 'de'],
    ['/members/committees/[id]', 'de'],
    // Routes outside the shell with German-only pages.
    ['/legal/impressum', 'de'],
    ['/setup', 'de'],
    ['/auth/step-up', 'de'],
    ['/auth/logout', 'de'],
    // A route nobody has classified yet is German (fail safe).
    ['/some/new/route', 'de'],
    // No matching route: +error, inside the shell for a signed-in person, and
    // the shell is not translated yet.
    [null, 'de'],
    [undefined, 'de'],
    // Proven translated, outside the shell: follows the person.
    ['/auth/login', 'en']
  ] as const)('%s -> %s for an English person', (routeId, expected) => {
    expect(contentLocaleFor(routeId, 'en')).toBe(expected)
  })

  it('a German person gets German everywhere', () => {
    for (const id of ['/', '/auth/login', '/beschluesse', '/legal/impressum', null]) expect(contentLocaleFor(id, 'de')).toBe('de')
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

  it('translated page -> legal page: lang becomes de and the person locale is kept aside', () => {
    const root = fakeRoot('en')
    syncDocumentLang(root, '/legal/impressum')
    expect(root.lang).toBe('de')
    expect(root.getAttribute(UI_LOCALE_ATTRIBUTE)).toBe('en')
  })

  it('German page (served lang="de" data-ui-locale="en") -> translated page: lang returns to en', () => {
    const root = fakeRoot('de', { [UI_LOCALE_ATTRIBUTE]: 'en' })
    syncDocumentLang(root, '/auth/login')
    expect(root.lang).toBe('en')
    expect(root.getAttribute(UI_LOCALE_ATTRIBUTE)).toBeNull()
  })

  it('a navigation that keeps the language writes nothing (no lang mutation)', () => {
    for (const [lang, id] of [
      ['en', '/auth/login'],
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

/** Attributes and component props whose literal value is read or shown to a person. */
const USER_FACING = new Set([
  'title',
  'label',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'heading',
  'subtitle',
  'description',
  'eyebrow',
  'hint',
  'text'
])

type AstNode = { type?: string; [key: string]: unknown }

/** Keys of the modern Svelte AST under which markup continues. */
const MARKUP_KEYS = ['fragment', 'nodes', 'attributes', 'consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch']

function staticAttribute(node: AstNode, name: string): string | null {
  const attr = (node.attributes as AstNode[] | undefined)?.find((a) => a.type === 'Attribute' && a.name === name)
  const value = attr?.value
  return Array.isArray(value) && value.length === 1 && (value[0] as AstNode).type === 'Text'
    ? String((value[0] as AstNode).data)
    : null
}

/** Hard-coded, human-readable text in a component's markup (script, style and parts marked lang="de" excluded). */
function literalTexts(node: unknown, out: string[]): string[] {
  if (Array.isArray(node)) {
    for (const n of node) literalTexts(n, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  const n = node as AstNode
  if (n.type === 'Text') {
    const text = String(n.data).trim()
    if (/\p{L}{2,}/u.test(text)) out.push(text)
    return out
  }
  if (n.type === 'Attribute') {
    if (USER_FACING.has(String(n.name)) && Array.isArray(n.value)) literalTexts(n.value, out)
    return out
  }
  if ((n.type === 'RegularElement' || n.type === 'SvelteElement') && (n.name === 'script' || n.name === 'style')) return out
  // A part marked German on purpose (WCAG 3.1.2), e.g. the root layout's skip link.
  if (n.type === 'RegularElement' && staticAttribute(n, 'lang') === 'de') return out
  for (const key of MARKUP_KEYS) literalTexts(n[key], out)
  return out
}

interface Evidence {
  catalogue: boolean
  literals: string[]
}

/** Walks a component and every .svelte component it imports. */
function evidenceFor(files: string[]): Evidence {
  const seen = new Set<string>()
  const evidence: Evidence = { catalogue: false, literals: [] }
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    if (CATALOGUE.test(source)) evidence.catalogue = true
    const ast = parse(source, { modern: true }) as unknown as { fragment: unknown }
    for (const text of literalTexts(ast.fragment, [])) evidence.literals.push(`${relative(SRC, file)}: ${text}`)
    for (const f of svelteImports(file)) visit(f)
  }
  for (const f of files) visit(f)
  return evidence
}

const proven = (e: Evidence) => e.catalogue && e.literals.length === 0

/** A page's own +page.svelte plus every nested +layout.svelte above it (the root layout is the shell, not the page). */
function pageTree(pageFile: string): string[] {
  const files = [pageFile]
  for (let dir = dirname(pageFile); dir !== ROUTES && dir.startsWith(ROUTES); dir = dirname(dir)) {
    const layout = join(dir, '+layout.svelte')
    if (existsSync(layout)) files.push(layout)
  }
  return files
}

describe('the proof itself', () => {
  const probe = (markup: string) => literalTexts(parse(markup, { modern: true }).fragment, [])

  it('finds hard-coded text nodes and user-facing attributes, not code, classes or marked German parts', () => {
    expect(probe('<h1>Mitglieder</h1>')).toEqual(['Mitglieder'])
    expect(probe('<PageTitle title="Übersicht" />')).toEqual(['Übersicht'])
    expect(probe('<button aria-label="Schließen">✕</button>')).toEqual(['Schließen'])
    expect(probe('{#if x}<p>Keine Einträge</p>{:else}<p>{$t("a.b")}</p>{/if}')).toEqual(['Keine Einträge'])
    expect(probe('<p class="text-sm text-ink">{$t("a.b")} · {n}</p>')).toEqual([])
    expect(probe('<a lang="de" href="#main">Zum Inhalt springen</a>')).toEqual([])
  })
})

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

  // The root layout wraps every page in AppShell (a signed-in person) except
  // the pages under these prefixes; the chrome is part of the document, so a
  // page inside the shell is translated only when the shell is too.
  const OUTSIDE_SHELL = ['/auth', '/legal', '/setup']
  const insideShell = (pathname: string) => !OUTSIDE_SHELL.some((p) => pathname.startsWith(p))
  const shell = evidenceFor([join(SRC, 'lib', 'components', 'layout', 'AppShell.svelte')])
  const shellWhy = `shell hard-coded text: ${JSON.stringify(shell.literals.slice(0, 5))}`

  it.each(pages)('$id', ({ file, id }) => {
    const e = evidenceFor(pageTree(file))
    const translated = proven(e) && (!insideShell(id) || proven(shell))
    const why = `${id}: catalogue=${e.catalogue}, hard-coded text: ${JSON.stringify(e.literals.slice(0, 5))}; ${shellWhy}`
    expect(isTranslatedRoute(id), why).toBe(translated)
    expect(contentLocaleFor(id, 'en'), why).toBe(translated ? 'en' : 'de')
  })

  it('no route matched (null): +error follows the person only while it and the shell around it are proven translated', () => {
    const e = evidenceFor([join(ROUTES, '+error.svelte')])
    expect(isTranslatedRoute(null), `${JSON.stringify(e.literals)}; ${shellWhy}`).toBe(proven(e) && proven(shell))
  })

  it('the shell rule above mirrors the root layout', () => {
    const src = readFileSync(join(ROUTES, '+layout.svelte'), 'utf8')
    const prefixes = [...src.matchAll(/!\$page\.url\.pathname\.startsWith\('([^']+)'\)/g)].map((m) => m[1])
    expect(prefixes.sort()).toEqual([...OUTSIDE_SHELL].sort())
  })

  it('every listed route id names a real page (no stale entries)', () => {
    const ids = new Set(pages.map((p) => p.id))
    for (const id of TRANSLATED_ROUTE_IDS) expect(ids.has(id), id).toBe(true)
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
