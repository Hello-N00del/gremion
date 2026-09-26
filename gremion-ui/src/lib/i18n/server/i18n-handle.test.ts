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
import { createI18nHandle, LOCALE_COOKIE, resolveRequestLocale } from './i18n-handle'
import { configureLocalePreference, resetLocalePreferenceForTest } from './locale-preference-port'
import { configurePersonIdMapperForTest, resetPersonIdMapperForTest } from './person-id'

function fakeEvent(opts: {
  cookie?: string | null
  acceptLanguage?: string | null
  userId?: string | null
  tenantId?: string | null
}) {
  const cookies = new Map<string, string>()
  if (opts.cookie != null) cookies.set(LOCALE_COOKIE, opts.cookie)
  return {
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

describe('createI18nHandle', () => {
  beforeEach(() => {
    resetLocalePreferenceForTest()
    resetPersonIdMapperForTest()
  })

  it('sets locals.locale and rewrites <html lang="de"> to the resolved locale', async () => {
    const handle = createI18nHandle((l) => (l as any).tenant?.id ?? null)
    const event = fakeEvent({ acceptLanguage: 'en-US' }) as any
    const resolve = async (_event: unknown, opts?: { transformPageChunk?: (input: { html: string }) => string }) => {
      const html = opts?.transformPageChunk?.({ html: '<!doctype html>\n<html lang="de">\n<head></head>' }) ?? ''
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    }
    const response = await handle({ event, resolve } as any)
    expect(event.locals.locale).toBe('en')
    const body = await response.text()
    expect(body).toContain('<html lang="en">')
    expect(body).not.toContain('lang="de"')
  })

  it('leaves the response untouched when resolve provides no transformPageChunk hook path issue (still resolves locals)', async () => {
    const handle = createI18nHandle((l) => (l as any).tenant?.id ?? null)
    const event = fakeEvent({ cookie: 'de' }) as any
    const resolve = async () => new Response('ok')
    await handle({ event, resolve } as any)
    expect(event.locals.locale).toBe('de')
  })
})
