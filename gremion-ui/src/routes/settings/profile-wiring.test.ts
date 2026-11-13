// @vitest-environment node
// Pins the SERVER ENTRY of Settings > Profil, which no unit test of the logic modules can see:
// (1) kcActionReturnHandle sits in the hook chain before the Auth.js handle that answers
//     /auth/callback/keycloak itself (otherwise the cancelled/error/success notice is never recorded);
// (2) the settings route exposes exactly the two Profil form actions and binds them to the
//     real logic (otherwise both forms 404 while every logic test stays green).
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const m = vi.hoisted(() => ({
  saveOwnName: vi.fn(async () => ({ from: 'saveOwnName' })),
  startAccountAction: vi.fn(async () => ({ from: 'startAccountAction' })),
  ownNameDeps: vi.fn(() => ({ tag: 'ownNameDeps' })),
  accountActionDeps: vi.fn(() => ({ tag: 'accountActionDeps' })),
}))
vi.mock('$lib/server/profile/own-name', () => ({ saveOwnName: m.saveOwnName }))
vi.mock('$lib/server/profile/account-actions', () => ({ startAccountAction: m.startAccountAction }))
vi.mock('$lib/server/profile/profile-panel', () => ({ ownNameDeps: m.ownNameDeps, accountActionDeps: m.accountActionDeps }))
vi.mock('$lib/i18n/server/switch-locale', () => ({ switchLocale: vi.fn() }))
vi.mock('$lib/i18n/server/person-id', () => ({ personIdOf: vi.fn() }))
vi.mock('$lib/i18n/server/locale-preference-port', () => ({ getLocalePreferencePort: vi.fn() }))
vi.mock('../../auth', () => ({ signIn: vi.fn() }))

import { actions } from './+page.server'

describe('hook chain wiring of the kc_action return handle', () => {
  test('kcActionReturnHandle is in handle = sequence(...) before authHandleUnlessExempt', () => {
    const src = readFileSync(`${process.cwd()}/src/hooks.server.ts`, 'utf8')
    const chain = src.slice(src.indexOf('export const handle = sequence('))
    const at = (name: string) => chain.search(new RegExp(String.raw`^\s*${name},`, 'm'))
    expect(at('kcActionReturnHandle')).toBeGreaterThan(0)
    expect(at('authHandleUnlessExempt')).toBeGreaterThan(0)
    expect(at('kcActionReturnHandle')).toBeLessThan(at('authHandleUnlessExempt'))
  })
})

describe('settings route actions', () => {
  beforeEach(() => vi.clearAllMocks())

  test('exposes profileName and accountAction next to the language switch', () => {
    expect(Object.keys(actions).sort()).toEqual(['accountAction', 'locale', 'profileName'])
  })

  test('profileName runs saveOwnName with the own-name deps of the request tenant', async () => {
    const event = { locals: { tenant: { id: 't1' } }, request: new Request('https://pilot.test/settings?/profileName', { method: 'POST' }) }
    const out = await (actions.profileName as unknown as (e: unknown) => Promise<unknown>)(event)
    expect(out).toEqual({ from: 'saveOwnName' })
    expect(m.ownNameDeps).toHaveBeenCalledWith({ id: 't1' })
    expect(m.saveOwnName).toHaveBeenCalledWith(event, { tag: 'ownNameDeps' })
  })

  test('accountAction runs startAccountAction with the account-action deps', async () => {
    const event = { locals: { tenant: { id: 't1' } }, request: new Request('https://pilot.test/settings?/accountAction', { method: 'POST' }) }
    const out = await (actions.accountAction as unknown as (e: unknown) => Promise<unknown>)(event)
    expect(out).toEqual({ from: 'startAccountAction' })
    expect(m.accountActionDeps).toHaveBeenCalledWith({ id: 't1' }, expect.any(Function))
    expect(m.startAccountAction).toHaveBeenCalledWith(event, { tag: 'accountActionDeps' })
  })
})
