// TASK-062 brief §5 cascade, step 4: the customer's default_locale applies to
// every request that has a customer, not only to a signed-in person with a
// mapped person_id. Anonymous visitors and signed-in but unmapped subjects
// (all of them today, Q2) must still get it. While no port is configured
// (Q1, until TASK-080), the lookup is skipped quietly: no warning per request.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCALE_COOKIE, resolveRequestLocale } from './i18n-handle'
import {
  configureLocalePreference,
  getLocalePreferencePort,
  isLocalePreferenceConfigured,
  resetLocalePreferenceForTest
} from './locale-preference-port'
import { configurePersonIdMapperForTest, resetPersonIdMapperForTest } from './person-id'

const customerIdOf = (l: unknown) => (l as { tenant?: { id: string } }).tenant?.id ?? null

function fakeEvent(opts: { cookie?: string; acceptLanguage?: string; userId?: string; tenantId?: string }) {
  return {
    url: new URL('https://pilot.test/'),
    cookies: { get: (name: string) => (name === LOCALE_COOKIE ? opts.cookie : undefined) },
    request: { headers: { get: (name: string) => (name.toLowerCase() === 'accept-language' ? (opts.acceptLanguage ?? null) : null) } },
    locals: { user: opts.userId ? { id: opts.userId } : null, tenant: opts.tenantId ? { id: opts.tenantId } : undefined }
  }
}

afterEach(() => {
  resetLocalePreferenceForTest()
  resetPersonIdMapperForTest()
  vi.restoreAllMocks()
})

describe('customer default_locale for every request with a customer (brief §5 step 4)', () => {
  it('an anonymous visitor with no cookie and no Accept-Language gets the customer default', async () => {
    configureLocalePreference({ backend: 'memory', customerDefaults: { 'cust-1': 'en' } })
    expect(await resolveRequestLocale(fakeEvent({ tenantId: 'cust-1' }) as never, customerIdOf)).toBe('en')
  })

  it('a signed-in but unmapped subject (personIdOf null, Q2) gets the customer default', async () => {
    configureLocalePreference({ backend: 'memory', customerDefaults: { 'cust-1': 'en' } })
    expect(await resolveRequestLocale(fakeEvent({ userId: 'subject-1', tenantId: 'cust-1' }) as never, customerIdOf)).toBe('en')
  })

  it('a mapped person with follow_customer gets the customer default', async () => {
    configureLocalePreference({ backend: 'memory', customerDefaults: { 'cust-1': 'en' } })
    configurePersonIdMapperForTest(() => 'person-1')
    await getLocalePreferencePort().set('cust-1', 'person-1', 'follow_customer')
    expect(await resolveRequestLocale(fakeEvent({ userId: 'subject-1', tenantId: 'cust-1' }) as never, customerIdOf)).toBe('en')
  })

  it('the cookie and Accept-Language still outrank the customer default', async () => {
    configureLocalePreference({ backend: 'memory', customerDefaults: { 'cust-1': 'en' } })
    expect(await resolveRequestLocale(fakeEvent({ tenantId: 'cust-1', cookie: 'de' }) as never, customerIdOf)).toBe('de')
    expect(await resolveRequestLocale(fakeEvent({ tenantId: 'cust-1', acceptLanguage: 'de-DE' }) as never, customerIdOf)).toBe('de')
  })

  it('no customer on the request: the base locale de, the port is not asked', async () => {
    configureLocalePreference({ backend: 'memory', customerDefaults: { 'cust-1': 'en' } })
    const spy = vi.spyOn(getLocalePreferencePort(), 'getCustomerDefault')
    expect(await resolveRequestLocale(fakeEvent({}) as never, customerIdOf)).toBe('de')
    expect(spy).not.toHaveBeenCalled()
  })

  it('an unconfigured port is skipped without a warning on every anonymous request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isLocalePreferenceConfigured()).toBe(false)
    expect(await resolveRequestLocale(fakeEvent({ tenantId: 'cust-1' }) as never, customerIdOf)).toBe('de')
    expect(await resolveRequestLocale(fakeEvent({ userId: 'subject-1', tenantId: 'cust-1' }) as never, customerIdOf)).toBe('de')
    expect(warn).not.toHaveBeenCalled()
  })

  it('a failing customer-default read falls back to de and is logged, not thrown', async () => {
    configureLocalePreference({ backend: 'memory' })
    vi.spyOn(getLocalePreferencePort(), 'getCustomerDefault').mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveRequestLocale(fakeEvent({ tenantId: 'cust-1' }) as never, customerIdOf)).toBe('de')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
