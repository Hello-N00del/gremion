// The login page bounces to Keycloak with a callbackUrl taken from the query string. That value must
// be a same-origin path after URL normalisation: the old leading-slash rule let through values that the
// URL parser collapses or rewrites into another host (dot segments, encoded slashes).
const { mockPage } = vi.hoisted(() => ({
  mockPage: { url: new URL('http://localhost/auth/login'), data: {} as Record<string, unknown> }
}))
const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }))

vi.mock('$app/state', () => ({ page: mockPage }))
vi.mock('@auth/sveltekit/client', () => ({ signIn }))

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Page from './+page.svelte'

const open = (callbackUrl: string | null, extra = '') => {
  const u = new URL(`http://localhost/auth/login${extra}`)
  if (callbackUrl !== null) u.searchParams.set('callbackUrl', callbackUrl)
  mockPage.url = u
}

beforeEach(() => signIn.mockReset())

describe('/auth/login callbackUrl', () => {
  test.each([
    ['/finance', '/finance'],
    ['/finance?tab=2#top', '/finance?tab=2#top'],
    ['/a/../finance', '/finance']
  ])('keeps the same-origin path %j as %j', (raw, expected) => {
    open(raw)
    render(Page)
    expect(signIn).toHaveBeenCalledWith('keycloak', { callbackUrl: expected })
  })

  test('without a callbackUrl it signs in to /', () => {
    open(null)
    render(Page)
    expect(signIn).toHaveBeenCalledWith('keycloak', { callbackUrl: '/' })
  })

  test.each([
    ['//evil.example'],
    ['/\\evil.example'],
    ['https://evil.example/'],
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['/\t/evil.example'],
    ['/.//evil.example'],
    ['/%2e//evil.example'],
    ['/..//evil.example'],
    ['/a/..//evil.example'],
    ['/%2f/evil.example'],
    ['/%5c/evil.example']
  ])('hostile callbackUrl %j falls back to /', (raw) => {
    open(raw)
    render(Page)
    expect(signIn).toHaveBeenCalledTimes(1)
    expect(signIn).toHaveBeenCalledWith('keycloak', { callbackUrl: '/' })
  })

  test('the signed-out "log in again" button uses the same guard', async () => {
    open('/.//evil.example', '?loggedOut=1')
    const { getByRole } = render(Page)
    expect(signIn).not.toHaveBeenCalled()
    getByRole('button').click()
    expect(signIn).toHaveBeenCalledWith('keycloak', { callbackUrl: '/' })
  })
})
