// TASK-062 TDD 2 (gremion-public): the raw SSR response carries the resolved
// `<html lang>` (no cookie + Accept-Language: en-US -> lang="en"; de-DE or no
// header -> lang="de"), rendered from the real app.html, and message
// functions called during the render see the request's locale.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createI18nHandle, LANG_PLACEHOLDER, LOCALE_COOKIE } from './i18n-handle'
import { m } from '../paraglide/messages.js'

const messages: Record<string, () => string> = m

const APP_HTML = readFileSync(join(__dirname, '..', '..', '..', 'app.html'), 'utf8')

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

describe('createI18nHandle (gremion-public)', () => {
  it('app.html declares the Paraglide lang placeholder, not a hardcoded lang', () => {
    expect(APP_HTML).toMatch(/<html lang="%paraglide\.lang%">/)
    expect(APP_HTML).not.toMatch(/<html lang="(de|en)"/)
  })

  it.each([
    [null, 'en-US', 'en'],
    [null, 'de-DE', 'de'],
    [null, null, 'de'],
    ['en', 'de-DE', 'en']
  ])('cookie %j + Accept-Language %j -> <html lang="%s">', async (cookie, header, expected) => {
    const event = fakeEvent(cookie, header)
    const response = await createI18nHandle()({ event, resolve: renderAppHtml } as never)
    const body = await response.text()
    expect(event.locals.locale).toBe(expected)
    expect(body).toContain(`<html lang="${expected}">`)
    expect(body).not.toContain(LANG_PLACEHOLDER)
  })

  it('message functions called during the render use the request locale', async () => {
    const response = await createI18nHandle()({
      event: fakeEvent(null, 'en-US'),
      resolve: async () => new Response(messages['a11y.skip']!())
    } as never)
    expect(await response.text()).toBe('Skip to content')
  })
})
