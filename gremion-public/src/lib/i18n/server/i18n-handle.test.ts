// TASK-062 TDD 2 (gremion-public) — i18nHandle rewrites app.html's raw
// `lang="de"` to the resolved locale (item 2's acceptance: no cookie +
// Accept-Language: en-US -> <html lang="en">, raw response, no JS).
import { describe, it, expect } from 'vitest'
import { createI18nHandle, LOCALE_COOKIE } from './i18n-handle'

function fakeEvent(cookie: string | null, acceptLanguage: string | null) {
  const cookies = new Map<string, string>()
  if (cookie != null) cookies.set(LOCALE_COOKIE, cookie)
  return {
    cookies: { get: (name: string) => cookies.get(name) ?? undefined },
    request: { headers: { get: (name: string) => (name.toLowerCase() === 'accept-language' ? acceptLanguage : null) } },
    locals: {}
  }
}

describe('createI18nHandle (gremion-public)', () => {
  it('sets locals.locale and rewrites <html lang="de"> in the raw response', async () => {
    const handle = createI18nHandle()
    const event = fakeEvent(null, 'en-US') as any
    const resolve = async (_event: unknown, opts?: { transformPageChunk?: (input: { html: string }) => string }) => {
      const html = opts?.transformPageChunk?.({ html: '<!doctype html>\n<html lang="de">\n<head></head>' }) ?? ''
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    }
    const response = await handle({ event, resolve } as any)
    expect((event.locals as any).locale).toBe('en')
    const body = await response.text()
    expect(body).toContain('<html lang="en">')
  })

  it('de-DE or no header resolves to de', async () => {
    const handle = createI18nHandle()
    const event = fakeEvent(null, null) as any
    const resolve = async () => new Response('ok')
    await handle({ event, resolve } as any)
    expect((event.locals as any).locale).toBe('de')
  })
})
