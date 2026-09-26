// TASK-062 TDD 2/7 — i18nHandle (brief §6.2/6.7): resolves the locale for a
// request and rewrites the raw HTML `lang="de"` to the resolved value, so a
// no-cookie `Accept-Language: en-US` request receives `<html lang="en"` in
// the actual server response (curl, before any client script runs).
//
// Person-preference/customer-default lookups are best-effort: the
// LocalePreferencePort has no production adapter yet (Q1 residual), and
// personIdOf() returns null until the subject->person mapping exists (Q2
// residual) — this handle must never 500 a request over either being
// unavailable, so an unconfigured port is caught and resolution just falls
// through to cookie/Accept-Language/'de'.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Handle } from '@sveltejs/kit'
import { sequence } from '@sveltejs/kit/hooks'
// @ts-expect-error — runtime-only internal entry, same use and reason as
// src/hooks.tenant-wiring.test.ts: sequence() needs the request store.
import { with_request_store } from '@sveltejs/kit/internal/server'
import { m } from '../paraglide/messages.js'
import { createI18nHandle, LANG_PLACEHOLDER, LOCALE_COOKIE, resolveRequestLocale } from './i18n-handle'
import { configureLocalePreference, resetLocalePreferenceForTest } from './locale-preference-port'
import { configurePersonIdMapperForTest, resetPersonIdMapperForTest } from './person-id'

const APP_HTML = readFileSync(join(__dirname, '..', '..', '..', 'app.html'), 'utf8')
const customerIdOf = (l: unknown) => (l as { tenant?: { id: string } }).tenant?.id ?? null

/** Stands in for SvelteKit's render: app.html through the merged transformPageChunk. */
async function renderAppHtml(_event: unknown, opts?: { transformPageChunk?: (input: { html: string; done: boolean }) => string | undefined | Promise<string | undefined> }) {
  const html = (await opts?.transformPageChunk?.({ html: APP_HTML, done: true })) ?? APP_HTML
  return new Response(html, { headers: { 'content-type': 'text/html' } })
}

function withRequestStore<T>(event: unknown, fn: () => T): T {
  const state = { tracing: { record_span: <R>({ fn }: { fn: (span: unknown) => Promise<R> }) => fn({}) } }
  return with_request_store({ event, state } as never, fn)
}

function fakeEvent(opts: {
  cookie?: string | null
  acceptLanguage?: string | null
  userId?: string | null
  tenantId?: string | null
}) {
  const cookies = new Map<string, string>()
  if (opts.cookie != null) cookies.set(LOCALE_COOKIE, opts.cookie)
  return {
    url: new URL('https://pilot.test/'),
    cookies: { get: (name: string) => cookies.get(name) ?? undefined },
    request: { headers: { get: (name: string) => (name.toLowerCase() === 'accept-language' ? (opts.acceptLanguage ?? null) : null) } },
    locals: { user: opts.userId ? { id: opts.userId } : null, tenant: opts.tenantId ? { id: opts.tenantId } : undefined }
  }
}

describe('resolveRequestLocale', () => {
  afterEach(() => {
    resetLocalePreferenceForTest()
    resetPersonIdMapperForTest()
  })

  it('no cookie, no Accept-Language, no person: de', async () => {
    const locale = await resolveRequestLocale(fakeEvent({}) as any, (l) => (l as any).tenant?.id ?? null)
    expect(locale).toBe('de')
  })

  it('Accept-Language: en-US with no cookie resolves to en', async () => {
    const locale = await resolveRequestLocale(fakeEvent({ acceptLanguage: 'en-US' }) as any, (l) => (l as any).tenant?.id ?? null)
    expect(locale).toBe('en')
  })

  it('a cookie set by a prior switch outranks Accept-Language', async () => {
    const locale = await resolveRequestLocale(
      fakeEvent({ cookie: 'de', acceptLanguage: 'en-US' }) as any,
      (l) => (l as any).tenant?.id ?? null
    )
    expect(locale).toBe('de')
  })

  it('an explicit signed-in person preference outranks the cookie', async () => {
    configureLocalePreference({ backend: 'memory' })
    configurePersonIdMapperForTest(() => 'person-1')
    await (await import('./locale-preference-port')).getLocalePreferencePort().set('cust-1', 'person-1', 'en')
    const locale = await resolveRequestLocale(
      fakeEvent({ cookie: 'de', userId: 'subject-1', tenantId: 'cust-1' }) as any,
      (l) => (l as any).tenant?.id ?? null
    )
    expect(locale).toBe('en')
  })

  it('an unconfigured port (Q1 residual) does not throw — falls through to cookie', async () => {
    configurePersonIdMapperForTest(() => 'person-1')
    const locale = await resolveRequestLocale(
      fakeEvent({ cookie: 'en', userId: 'subject-1', tenantId: 'cust-1' }) as any,
      (l) => (l as any).tenant?.id ?? null
    )
    expect(locale).toBe('en')
  })
})

describe('createI18nHandle (TDD 2: the raw SSR response carries the resolved lang)', () => {
  beforeEach(() => {
    resetLocalePreferenceForTest()
    resetPersonIdMapperForTest()
  })

  it('app.html declares the Paraglide lang placeholder, not a hardcoded lang', () => {
    expect(APP_HTML).toMatch(/<html lang="%paraglide.lang%">/)
    expect(APP_HTML).not.toMatch(/<html lang="(de|en)"/)
  })

  it.each([
    ['en-US', 'en'],
    ['en-US;q=0.9,de;q=0.8', 'en'],
    ['de-DE', 'de'],
    [null, 'de']
  ])('Accept-Language %j, no cookie -> <html lang="%s"> in the rendered app.html', async (header, expected) => {
    const event = fakeEvent({ acceptLanguage: header })
    const response = await createI18nHandle(customerIdOf)({ event, resolve: renderAppHtml } as never)
    const body = await response.text()
    expect((event.locals as { locale?: string }).locale).toBe(expected)
    expect(body).toContain(`<html lang="${expected}">`)
    expect(body).not.toContain(LANG_PLACEHOLDER)
  })

  it('SSR message calls inside resolve() see the request locale (Paraglide AsyncLocalStorage)', async () => {
    const event = fakeEvent({ acceptLanguage: 'en-US' })
    const resolve = async () => new Response(m['nav.files']())
    const response = await createI18nHandle(customerIdOf)({ event, resolve } as never)
    expect(await response.text()).toBe('Files')
  })

  it('never hands the request body to Paraglide (uploads are not cloned/teed)', async () => {
    const event = fakeEvent({ acceptLanguage: 'en-US' })
    let seen: unknown
    const resolve = async (e: unknown) => {
      seen = e
      return new Response('ok')
    }
    await createI18nHandle(customerIdOf)({ event, resolve } as never)
    expect(seen).toBe(event)
  })
})

describe('i18nHandle + brand style handle in one sequence() (TDD 7)', () => {
  it('both transformPageChunk rewrites land in the same response', async () => {
    const brandStyle = '<style id="tenant-brand">:root{--ds-accent:oklch(50% 0.1 30)}</style>'
    const brandHandle: Handle = ({ event, resolve }) =>
      resolve(event, { transformPageChunk: ({ html }) => html.replace('</head>', `${brandStyle}</head>`) })
    const composed = sequence(brandHandle, createI18nHandle(customerIdOf))
    const event = fakeEvent({ acceptLanguage: 'en-US' })
    const response = await withRequestStore(event, () => composed({ event, resolve: renderAppHtml } as never))
    const body = await response.text()
    expect(body).toContain('<html lang="en">')
    expect(body).toContain(`${brandStyle}</head>`)
  })
})
