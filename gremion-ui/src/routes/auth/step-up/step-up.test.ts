// The step-up page under the OTP-or-deny realm flow (docs/auth.md "The realm flow is OTP-or-deny"):
// Keycloak never enrols a TOTP inside the step-up; a user without a second factor is REFUSED, and the
// gremion login theme's error page sends that refusal back here as ?error=no-second-factor
// (services/kernel-api/test/keycloak/stepup-deny.int.test.ts proves that half on a real Keycloak).
// The page must then say so plainly, link the Keycloak account console of the user's realm, and
// NOT bounce into Keycloak again (that would be refused again).
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'

const signIn = vi.fn()
vi.mock('@auth/sveltekit/client', () => ({ signIn: (...a: unknown[]) => signIn(...a) }))

import Page from './+page.svelte'
import { load } from './+page.server'

const ACCOUNT = 'https://rat.musterstadt.example/auth/realms/musterstadt/account'
type Data = { returnTo: string; secondFactorMissing: boolean; accountUrl: string | null }
const props = (over: Partial<Data> = {}) =>
  ({ props: { data: { returnTo: '/finance', secondFactorMissing: false, accountUrl: ACCOUNT, ...over } } }) as unknown as { props: never }
const hrefs = (c: HTMLElement) => Array.from(c.querySelectorAll('a')).map((a) => a.getAttribute('href'))

beforeEach(() => signIn.mockReset())

describe('step-up page', () => {
  test('requests loa2 from Keycloak', () => {
    render(Page, props())
    expect(signIn).toHaveBeenCalledWith('keycloak', { callbackUrl: '/finance' }, { acr_values: 'loa2', max_age: '300' })
  })

  test('the refusal notice (?error=no-second-factor) is plain, links the account console and does NOT bounce back into Keycloak', () => {
    const { container } = render(Page, props({ secondFactorMissing: true }))
    expect(signIn).not.toHaveBeenCalled()
    const text = container.textContent ?? ''
    expect(text).toMatch(/Zweiter Faktor erforderlich/)
    expect(text).toMatch(/Authenticator/)
    expect(hrefs(container)).toContain(ACCOUNT)
    expect(hrefs(container)).toContain('/finance')
  })

  test('without an account url (no resolved tenant) the notice still says what is missing, with no dead link', () => {
    const { container } = render(Page, props({ secondFactorMissing: true, accountUrl: null }))
    expect(signIn).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/zweiten Faktor/)
    expect(hrefs(container).filter((h) => h !== '/finance')).toEqual([])
  })
})

describe('step-up load', () => {
  const tenant = { authExternalBase: 'https://rat.musterstadt.example/auth/realms/musterstadt/' }
  const run = (qs: string, t: unknown = tenant) =>
    load({ url: new URL(`http://localhost/auth/step-up${qs}`), locals: { tenant: t } } as never) as Promise<Record<string, unknown>>

  test('flags the refusal notice only for error=no-second-factor', async () => {
    expect((await run('?error=no-second-factor')).secondFactorMissing).toBe(true)
    expect((await run('')).secondFactorMissing).toBe(false)
    expect((await run('?error=other')).secondFactorMissing).toBe(false)
  })

  test('derives the account console from the request tenant, null without one', async () => {
    expect((await run('')).accountUrl).toBe(ACCOUNT)
    expect((await run('', null)).accountUrl).toBeNull()
  })

  test('keeps the open-redirect guard on returnTo', async () => {
    expect((await run('?returnTo=//evil.com')).returnTo).toBe('/')
    expect((await run('?returnTo=/finance')).returnTo).toBe('/finance')
    expect((await run('?returnTo=/finance%3Fx%3D1%23a')).returnTo).toBe('/finance?x=1#a')
  })

  test('returnTo is a link on the notice: backslash and control-character variants that resolve off-site fall back to /', async () => {
    for (const evil of ['/%5Cevil.com', '/%5C%09/evil.com', '/%09/evil.com', 'https://evil.com', '%5C%5Cevil.com']) {
      expect((await run(`?error=no-second-factor&returnTo=${evil}`)).returnTo, evil).toBe('/')
    }
  })
})
