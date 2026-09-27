// TASK-062 TDD 2 (gremion-public): the raw SSR response carries the resolved
// `<html lang>`, rendered from the real app.html, and message functions called
// during the render see the request's locale.
//
// R26-TRAIN4-FIX r3 (WCAG 3.1.1, operator ruling 2026-09-27): `<html lang>`
// names the language the page is written in. Every visible portal string is
// still hard-coded German (the 9-key catalogue renders none of them), so the
// shipped handle declares lang="de" for every request, whatever the cookie or
// Accept-Language asks for, until TASK-161 translates the portal and adds 'en'
// to CONTENT_LOCALES. The cookie/Accept-Language plumbing itself stays proven
// below with both locales enabled, the configuration TASK-161 switches on.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { parse } from 'svelte/compiler'
import { createI18nHandle, LANG_PLACEHOLDER, LOCALE_COOKIE } from './i18n-handle'
import { CONTENT_LOCALES, SUPPORTED_LOCALES } from '../locale'
import { m } from '../paraglide/messages.js'

const messages: Record<string, () => string> = m

const SRC = join(__dirname, '..', '..', '..')
const APP_HTML = readFileSync(join(SRC, 'app.html'), 'utf8')

function fakeEvent(cookie: string | null, acceptLanguage: string | null) {
  const cookies = new Map<string, string>()
  if (cookie != null) cookies.set(LOCALE_COOKIE, cookie)
  return {
    url: new URL('https://portal.test/'),
    cookies: { get: (name: string) => cookies.get(name) ?? undefined },
    request: { headers: { get: (name: string) => (name.toLowerCase() === 'accept-language' ? acceptLanguage : null) } },
    locals: {} as Record<string, unknown>
  }
}

async function renderAppHtml(_event: unknown, opts?: { transformPageChunk?: (input: { html: string; done: boolean }) => unknown }) {
  const html = ((await opts?.transformPageChunk?.({ html: APP_HTML, done: true })) as string | undefined) ?? APP_HTML
  return new Response(html, { headers: { 'content-type': 'text/html' } })
}

/** Every .svelte/.ts file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts') ? [path] : []
  })
}

// The page-language proof, the same rule as gremion-ui content-locale.test.ts.
const CATALOGUE = /paraglide\/messages|\$lib\/i18n['/]/
const USER_FACING = new Set(['title', 'label', 'placeholder', 'alt', 'aria-label', 'aria-description', 'heading', 'subtitle', 'description', 'eyebrow', 'hint', 'text'])
const MARKUP_KEYS = ['fragment', 'nodes', 'attributes', 'consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch']
type AstNode = { type?: string; [key: string]: unknown }

function staticLang(node: AstNode): string | null {
  const attr = (node.attributes as AstNode[] | undefined)?.find((a) => a.type === 'Attribute' && a.name === 'lang')
  const value = attr?.value
  return Array.isArray(value) && value.length === 1 && (value[0] as AstNode).type === 'Text' ? String((value[0] as AstNode).data) : null
}

/** Hard-coded, human-readable text in a component's markup. */
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
  if (n.type === 'RegularElement' && (n.name === 'script' || n.name === 'style' || staticLang(n) === 'de')) return out
  for (const key of MARKUP_KEYS) literalTexts(n[key], out)
  return out
}

/** Catalogue use and hard-coded text over components and every .svelte component they import. */
function evidenceFor(files: string[]): { catalogue: boolean; literals: string[] } {
  const seen = new Set<string>()
  const evidence = { catalogue: false, literals: [] as string[] }
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    if (CATALOGUE.test(source)) evidence.catalogue = true
    const ast = parse(source, { modern: true }) as unknown as { fragment: unknown }
    for (const text of literalTexts(ast.fragment, [])) evidence.literals.push(`${relative(SRC, file)}: ${text}`)
    for (const [, spec] of source.matchAll(/from\s+['"]([^'"]+\.svelte)['"]/g)) {
      const path = spec!.startsWith('$lib/') ? join(SRC, 'lib', spec!.slice(5)) : spec!.startsWith('.') ? join(dirname(file), spec!) : null
      if (path && existsSync(path)) visit(path)
    }
  }
  for (const f of files) visit(f)
  return evidence
}

describe('createI18nHandle (gremion-public)', () => {
  it('app.html declares the Paraglide lang placeholder, not a hardcoded lang', () => {
    expect(APP_HTML).toMatch(/<html lang="%paraglide\.lang%">/)
    expect(APP_HTML).not.toMatch(/<html lang="(de|en)"/)
  })

  describe('as shipped: the portal is written in German, so it is declared German (WCAG 3.1.1)', () => {
    it.each([
      [null, 'en-US'],
      [null, 'en-US;q=0.9,de;q=0.8'],
      ['en', 'en-US'],
      ['en', 'de-DE'],
      [null, 'de-DE'],
      [null, null]
    ])('cookie %j + Accept-Language %j -> <html lang="de">', async (cookie, header) => {
      const event = fakeEvent(cookie, header)
      const response = await createI18nHandle()({ event, resolve: renderAppHtml } as never)
      const body = await response.text()
      expect(event.locals.locale).toBe('de')
      expect(body).toContain('<html lang="de">')
      expect(body).not.toContain(LANG_PLACEHOLDER)
    })

    it('message functions rendered for an en-US visitor are German too', async () => {
      const response = await createI18nHandle()({
        event: fakeEvent(null, 'en-US'),
        resolve: async () => new Response(messages['a11y.skip']!())
      } as never)
      expect(await response.text()).toBe('Zum Inhalt springen')
    })

    // R26-TRAIN4-FIX r5 (verify-r3 LOW): one catalogue consumer (a footer with
    // one message) is not enough. The portal may offer a locale other than
    // German only when EVERY page is proven translated: its whole component
    // tree (the page, all layouts, +error, every imported .svelte component)
    // renders from the catalogue and carries no hard-coded text node or
    // user-facing attribute. Parts marked lang="de" do not count.
    it("does not offer a non-German locale unless every portal page is proven translated", () => {
      const routes = sourceFiles(join(SRC, 'routes')).filter((f) => f.endsWith('.svelte'))
      const pages = routes.filter((f) => f.endsWith(`${sep}+page.svelte`))
      expect(pages.length).toBeGreaterThan(0)
      const shared = routes.filter((f) => f.endsWith(`${sep}+layout.svelte`) || f.endsWith(`${sep}+error.svelte`))
      const untranslated = pages
        .map((page) => ({ page: relative(SRC, page), e: evidenceFor([page, ...shared]) }))
        .filter(({ e }) => !e.catalogue || e.literals.length > 0)
      const germanOnly = CONTENT_LOCALES.every((l) => l === 'de')
      expect(
        germanOnly || untranslated.length === 0,
        `CONTENT_LOCALES ${JSON.stringify(CONTENT_LOCALES)} while ${untranslated.length} page(s) are not translated, e.g. ` +
          JSON.stringify(untranslated.slice(0, 3).map(({ page, e }) => ({ page, catalogue: e.catalogue, text: e.literals.slice(0, 3) })))
      ).toBe(true)
    })

    it('the proof finds hard-coded text and ignores code, classes and marked German parts', () => {
      const probe = (markup: string) => literalTexts(parse(markup, { modern: true }).fragment, [])
      expect(probe('<h1>Beschlüsse</h1>')).toEqual(['Beschlüsse'])
      expect(probe('<a aria-label="Startseite" href="/">{m.x()}</a>')).toEqual(['Startseite'])
      expect(probe('<p class="text-sm">{m.x()} · {n}</p>')).toEqual([])
      expect(probe('<p lang="de">Nur auf Deutsch</p>')).toEqual([])
    })
  })

  describe('the cookie -> Accept-Language cascade, with both locales enabled (TASK-161 configuration)', () => {
    it.each([
      [null, 'en-US', 'en'],
      [null, 'de-DE', 'de'],
      [null, null, 'de'],
      ['en', 'de-DE', 'en']
    ])('cookie %j + Accept-Language %j -> <html lang="%s">', async (cookie, header, expected) => {
      const event = fakeEvent(cookie, header)
      const response = await createI18nHandle({ contentLocales: SUPPORTED_LOCALES })({ event, resolve: renderAppHtml } as never)
      const body = await response.text()
      expect(event.locals.locale).toBe(expected)
      expect(body).toContain(`<html lang="${expected}">`)
      expect(body).not.toContain(LANG_PLACEHOLDER)
    })

    it('message functions called during the render use the request locale', async () => {
      const response = await createI18nHandle({ contentLocales: SUPPORTED_LOCALES })({
        event: fakeEvent(null, 'en-US'),
        resolve: async () => new Response(messages['a11y.skip']!())
      } as never)
      expect(await response.text()).toBe('Skip to content')
    })
  })
})
