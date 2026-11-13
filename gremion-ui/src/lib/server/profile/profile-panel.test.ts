import { describe, expect, test, vi } from 'vitest'
import { loadProfilePanel, withTimeout } from './profile-panel'
import { ACTION_COOKIE } from './account-actions'
import { Role } from '$lib/auth/types'
import { KcAdminError } from '$lib/server/keycloak-admin'

const user = { id: 'kc-uuid-1', email: 'a@example.org', name: 'A', roles: [Role.Member], groups: [], loa: 1, authTime: 0 }

function jar(initial?: string) {
  const store = new Map<string, string>(initial ? [[ACTION_COOKIE, initial]] : [])
  return { get: (n: string) => store.get(n), set: vi.fn(), delete: vi.fn((n: string) => void store.delete(n)) }
}

const kcUser = { id: 'kc-uuid-1', username: 'anna', email: 'anna@example.org', firstName: 'Anna', lastName: 'Alt', enabled: true, emailVerified: true }

describe('loadProfilePanel', () => {
  test('reads the SESSION user (and only it) for the form, and the e-mail capability', async () => {
    const getUser = vi.fn(async (_id: string) => kcUser)
    const out = await loadProfilePanel({ user, cookies: jar(), wantsProfile: true }, { getUser, emailActionAvailable: async () => true })
    expect(getUser).toHaveBeenCalledWith('kc-uuid-1')
    expect(out).toEqual({
      profile: { firstName: 'Anna', lastName: 'Alt', email: 'anna@example.org' },
      emailActionAvailable: true,
      accountActionResult: null,
    })
  })

  test('the e-mail button is hidden by default: a failing probe means false', async () => {
    const a = await loadProfilePanel(
      { user, cookies: jar(), wantsProfile: true },
      {
        getUser: async () => kcUser,
        emailActionAvailable: async () => {
          throw new Error('x')
        },
      },
    )
    expect(a.emailActionAvailable).toBe(false)
  })

  test('a failing name read hides the form data, it does not break the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const out = await loadProfilePanel(
      { user, cookies: jar(), wantsProfile: true },
      {
        getUser: async () => {
          throw new Error('kc down')
        },
        emailActionAvailable: async () => true,
      },
    )
    expect(out.profile).toBeNull()
    warn.mockRestore()
  })

  test('a SYNCHRONOUS throw while reading the user hides the form, it does not reject the load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const out = await loadProfilePanel(
      { user, cookies: jar(), wantsProfile: true },
      {
        getUser: () => {
          throw new Error('admin secret missing')
        },
        emailActionAvailable: async () => true,
      },
    )
    expect(out.profile).toBeNull()
    expect(out.emailActionAvailable).toBe(true)
    warn.mockRestore()
  })

  test('a SYNCHRONOUS throw in the e-mail probe means false, it does not reject the load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const out = await loadProfilePanel(
      { user, cookies: jar(), wantsProfile: true },
      {
        getUser: async () => kcUser,
        emailActionAvailable: () => {
          throw new Error('admin secret missing')
        },
      },
    )
    expect(out.emailActionAvailable).toBe(false)
    expect(out.profile).toEqual({ firstName: 'Anna', lastName: 'Alt', email: 'anna@example.org' })
    warn.mockRestore()
  })

  test('both reads throwing synchronously: no names, no e-mail action, a result and no rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const boom = () => {
      throw new Error('admin secret missing')
    }
    const out = await loadProfilePanel({ user, cookies: jar(), wantsProfile: true }, { getUser: boom, emailActionAvailable: boom })
    expect(out).toEqual({ profile: null, emailActionAvailable: false, accountActionResult: null })
    warn.mockRestore()
  })

  test('a failed read logs the error class and the Keycloak status, never the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await loadProfilePanel(
      { user, cookies: jar(), wantsProfile: true },
      {
        getUser: async () => {
          throw new KcAdminError(503, 'secret-body-text')
        },
        emailActionAvailable: async () => {
          throw new KcAdminError(403, 'other-body-text')
        },
      },
    )
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('KcAdminError')
    expect(logged).toContain('503')
    expect(logged).toContain('403')
    expect(logged).not.toContain('body-text')
    warn.mockRestore()
  })

  test('other sections do not touch Keycloak at all', async () => {
    const getUser = vi.fn()
    const probe = vi.fn()
    const out = await loadProfilePanel({ user, cookies: jar(), wantsProfile: false }, { getUser, emailActionAvailable: probe })
    expect(getUser).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(out).toEqual({ profile: null, emailActionAvailable: false, accountActionResult: null })
  })

  test('hands over a recorded action result once', async () => {
    const c = jar('UPDATE_PASSWORD.cancelled')
    const deps = { getUser: async () => kcUser, emailActionAvailable: async () => false }
    const out = await loadProfilePanel({ user, cookies: c, wantsProfile: true }, deps)
    expect(out.accountActionResult).toEqual({ action: 'UPDATE_PASSWORD', status: 'cancelled' })
    const again = await loadProfilePanel({ user, cookies: c, wantsProfile: true }, deps)
    expect(again.accountActionResult).toBeNull()
  })
})

describe('withTimeout', () => {
  test('rejects when the promise is slower than the budget', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toThrow('timeout')
  })
  test('passes the value through in time', async () => {
    await expect(withTimeout(Promise.resolve(3), 1000)).resolves.toBe(3)
  })
})
