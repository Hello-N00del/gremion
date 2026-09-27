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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

    it("does not offer 'en' while no portal page or component renders from the catalogue", () => {
      const consumers = [...sourceFiles(join(SRC, 'routes')), ...sourceFiles(join(SRC, 'lib', 'components'))].filter((f) =>
        /paraglide\/messages|\$lib\/i18n/.test(readFileSync(f, 'utf8'))
      )
      // The day a page renders from the catalogue, this list is non-empty and
      // CONTENT_LOCALES may grow with it (TASK-161). Until then the portal
      // must not declare a language its pages are not written in.
      const germanOnly = CONTENT_LOCALES.length === 1 && CONTENT_LOCALES[0] === 'de'
      expect(consumers.length > 0 || germanOnly, `CONTENT_LOCALES ${JSON.stringify(CONTENT_LOCALES)} with no catalogue consumer`).toBe(true)
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
