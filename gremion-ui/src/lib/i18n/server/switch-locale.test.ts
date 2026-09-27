// TASK-062 TDD 5: the language switch is a form POST answered by a 303. It
// sets the per-device cookie AND writes the person's preference through the
// port; a failing write is surfaced to the person, never a silent 200 no-op.
import { describe, expect, test, vi } from 'vitest'
import { isActionFailure, isRedirect } from '@sveltejs/kit'
import { switchLocale, LOCALE_COOKIE_OPTIONS_MAX_AGE, type SwitchLocaleDeps } from './switch-locale'
import { configureLocalePreference, getLocalePreferencePort, type LocalePreferencePort } from './locale-preference-port'

type CookieCall = { name: string; value: string; opts: Record<string, unknown> }

function makeEvent(form: Record<string, string>, url = 'https://pilot.test/settings?/locale') {
  const body = new URLSearchParams(form)
  const cookieCalls: CookieCall[] = []
  return {
    cookieCalls,
    event: {
      request: new Request(url, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
      }),
      url: new URL(url),
      cookies: {
        set: (name: string, value: string, opts: Record<string, unknown>) => void cookieCalls.push({ name, value, opts })
      },
      locals: { user: { id: 'subject-1' }, tenant: { id: 'customer-a' } }
    }
  }
}

function deps(port: LocalePreferencePort | (() => LocalePreferencePort), personId: string | null = 'person-1'): SwitchLocaleDeps {
  return {
    personIdOf: () => personId,
    customerIdOf: (locals) => (locals as { tenant?: { id: string } }).tenant?.id ?? null,
    port: typeof port === 'function' ? port : () => port
  }
}

async function run(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p
  } catch (thrown) {
    return thrown
  }
}

describe('switchLocale form action (TASK-062 TDD 5)', () => {
  test('POST locale=en -> 303 to the page it came from, cookie set, preference written', async () => {
    configureLocalePreference({ backend: 'memory' })
    const port = getLocalePreferencePort()
    const { event, cookieCalls } = makeEvent({ locale: 'en', redirectTo: '/settings/darstellung' })

    const outcome = await run(switchLocale(event, deps(port)))

    expect(isRedirect(outcome)).toBe(true)
    expect(outcome).toMatchObject({ status: 303, location: '/settings/darstellung' })
    expect(cookieCalls).toEqual([
      {
        name: 'gremion.locale',
        value: 'en',
        opts: { path: '/', sameSite: 'lax', httpOnly: true, secure: true, maxAge: LOCALE_COOKIE_OPTIONS_MAX_AGE }
      }
    ])
    expect(await port.get('customer-a', 'person-1')).toEqual({
      locale: 'en',
      rowVersion: 1,
      updatedByKind: 'person',
      updatedBy: 'person-1'
    })
  })

  test('a second switch bumps row_version by one', async () => {
    configureLocalePreference({ backend: 'memory' })
    const port = getLocalePreferencePort()
    await run(switchLocale(makeEvent({ locale: 'en' }).event, deps(port)))
    await run(switchLocale(makeEvent({ locale: 'de' }).event, deps(port)))
    expect(await port.get('customer-a', 'person-1')).toMatchObject({ locale: 'de', rowVersion: 2 })
  })

  test('a failing port write is surfaced (action failure), the cookie still switches, never a redirect', async () => {
    const failing: LocalePreferencePort = {
      get: vi.fn(),
      getCustomerDefault: vi.fn(),
      set: vi.fn(async () => {
        throw new Error('db down')
      })
    }
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { event, cookieCalls } = makeEvent({ locale: 'en', redirectTo: '/settings' })

    const outcome = await run(switchLocale(event, deps(failing)))

    expect(isRedirect(outcome)).toBe(false)
    expect(isActionFailure(outcome)).toBe(true)
    expect(outcome).toMatchObject({ status: 503, data: { localeError: 'not-saved', locale: 'en' } })
    expect(failing.set).toHaveBeenCalledWith('customer-a', 'person-1', 'en')
    expect(cookieCalls.map((c) => c.value)).toEqual(['en'])
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })

  test('an unconfigured port with a known person is a surfaced failure, not a silent success', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const outcome = await run(
      switchLocale(
        makeEvent({ locale: 'en' }).event,
        deps(() => {
          throw new Error('LocalePreferencePort not configured')
        })
      )
    )
    expect(isActionFailure(outcome)).toBe(true)
    expect(outcome).toMatchObject({ status: 503 })
    errorLog.mockRestore()
  })

  test('no person mapping yet (Q2): the cookie decides, no port call, still a 303', async () => {
    const port: LocalePreferencePort = { get: vi.fn(), getCustomerDefault: vi.fn(), set: vi.fn() }
    const { event, cookieCalls } = makeEvent({ locale: 'en' })
    const outcome = await run(switchLocale(event, deps(port, null)))
    expect(outcome).toMatchObject({ status: 303 })
    expect(port.set).not.toHaveBeenCalled()
    expect(cookieCalls.map((c) => c.value)).toEqual(['en'])
  })

  test('an unsupported locale is rejected with 400 and changes nothing', async () => {
    const port: LocalePreferencePort = { get: vi.fn(), getCustomerDefault: vi.fn(), set: vi.fn() }
    const { event, cookieCalls } = makeEvent({ locale: 'fr' })
    const outcome = await run(switchLocale(event, deps(port)))
    expect(isActionFailure(outcome)).toBe(true)
    expect(outcome).toMatchObject({ status: 400, data: { localeError: 'invalid' } })
    expect(cookieCalls).toEqual([])
    expect(port.set).not.toHaveBeenCalled()
  })

  test.each([
    ['//evil.example/x'],
    ['https://evil.example/'],
    ['/\\evil.example'],
    ['settings'],
    [''],
    // WHATWG URL parsing strips ASCII tab/newline, so these become `//evil.example`.
    ['/\t/evil.example/x'],
    ['/\n/evil.example/x'],
    ['/\r/evil.example/x'],
    ['\t//evil.example/x']
  ])('an unsafe redirectTo %j falls back to the settings page', async (redirectTo) => {
    const outcome = await run(switchLocale(makeEvent({ locale: 'de', redirectTo }).event, deps(vi.fn() as never, null)))
    expect(outcome).toMatchObject({ status: 303, location: '/settings/darstellung' })
  })

  test.each([
    ['/settings/darstellung', '/settings/darstellung'],
    ['/dashboard?tab=2', '/dashboard?tab=2'],
    ['/%09/evil.example', '/%09/evil.example']
  ])('a same-origin redirectTo %j is kept as %j', async (redirectTo, expected) => {
    const outcome = (await run(
      switchLocale(makeEvent({ locale: 'de', redirectTo }).event, deps(vi.fn() as never, null))
    )) as { status: number; location: string }
    expect(outcome).toMatchObject({ status: 303, location: expected })
    expect(new URL(outcome.location, 'https://pilot.test/').origin).toBe('https://pilot.test')
  })

  test('the cookie is not marked Secure on plain http (local dev), so the browser keeps it', async () => {
    const { event, cookieCalls } = makeEvent({ locale: 'en' }, 'http://localhost:4001/settings?/locale')
    await run(switchLocale(event, deps(vi.fn() as never, null)))
    expect(cookieCalls[0]?.opts.secure).toBe(false)
  })
})
