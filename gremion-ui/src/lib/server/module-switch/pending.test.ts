// @vitest-environment node
//
// A confirmed module switch that waits for the second factor: the pure rules of pending.ts. What is kept
// (only a shape-valid input), and who may carry a claimed switch out (the person who confirmed it, in time,
// with a second factor NEWER than the one it was confirmed with). The table itself is pinned against a real
// database in pending.integration.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import { armPendingSwitch, checkPendingSwitch, claimPendingSwitch, normalizePendingInput, PENDING_COOKIE_PATH, PENDING_TTL_SECONDS, type PendingSwitch } from './pending'

const kept = (over: Partial<PendingSwitch> = {}): PendingSwitch => ({
  userId: 'u1',
  armedAuthTime: 1000,
  input: { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' },
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  live: true,
  ...over,
})

describe('normalizePendingInput', () => {
  it('keeps a switch-off with its typed name and a switch-on with its DPIA decision', () => {
    expect(normalizePendingInput({ moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' })).toEqual({ moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' })
    expect(normalizePendingInput({ moduleId: 'calendar', action: 'enable', dpia: { requiresDpia: true, documentRef: 'TOM 4.2' } })).toEqual({
      moduleId: 'calendar',
      action: 'enable',
      dpia: { requiresDpia: true, documentRef: 'TOM 4.2' },
    })
    expect(normalizePendingInput({ moduleId: 'votes', action: 'enable' })).toEqual({ moduleId: 'votes', action: 'enable' })
  })

  it('drops every field it does not know', () => {
    expect(normalizePendingInput({ moduleId: 'votes', action: 'enable', resume: true, tenant: 'other', dpia: null })).toEqual({ moduleId: 'votes', action: 'enable' })
    expect(normalizePendingInput({ moduleId: 'votes', action: 'enable', dpia: { requiresDpia: false, documentRef: 'a', extra: 1 } })).toEqual({
      moduleId: 'votes',
      action: 'enable',
      dpia: { requiresDpia: false, documentRef: 'a' },
    })
  })

  it.each([
    ['nothing', null],
    ['a text', 'votes'],
    ['a list', [{ moduleId: 'votes', action: 'enable' }]],
    ['a module that is not switchable here', { moduleId: 'vault', action: 'enable' }],
    ['a module id that is not a text', { moduleId: 7, action: 'enable' }],
    ['an unknown action', { moduleId: 'votes', action: 'drop' }],
    ['a typed name that is not a text', { moduleId: 'votes', action: 'disable', confirm: ['Abstimmungen'] }],
    ['an oversized typed name', { moduleId: 'votes', action: 'disable', confirm: 'x'.repeat(201) }],
    ['a DPIA decision that is a list', { moduleId: 'votes', action: 'enable', dpia: [] }],
    ['a DPIA answer that is not yes or no', { moduleId: 'votes', action: 'enable', dpia: { requiresDpia: 'no', documentRef: 'a' } }],
    ['an oversized document reference', { moduleId: 'votes', action: 'enable', dpia: { requiresDpia: false, documentRef: 'x'.repeat(501) } }],
  ])('keeps nothing for %s', (_name, body) => {
    expect(normalizePendingInput(body)).toBeNull()
  })
})

describe('checkPendingSwitch', () => {
  const after = { id: 'u1', loa: 2, authTime: 1040 }

  it('the person who confirmed, in time, with a newer second factor may carry it out', () => {
    const pending = kept()
    expect(checkPendingSwitch(pending, after, 2)).toEqual({ ok: true, pending })
  })

  it('nothing claimed is gone', () => {
    expect(checkPendingSwitch(null, after, 2)).toEqual({ ok: false, reason: 'gone' })
  })

  it("another person's switch is gone for this one, also when it is expired (nothing about it is told)", () => {
    expect(checkPendingSwitch(kept({ userId: 'u2' }), after, 2)).toEqual({ ok: false, reason: 'gone' })
    expect(checkPendingSwitch(kept({ userId: 'u2', live: false }), after, 2)).toEqual({ ok: false, reason: 'gone' })
  })

  it('a session without a person id matches nobody', () => {
    expect(checkPendingSwitch(kept({ userId: '' }), { ...after, id: '' }, 2)).toEqual({ ok: false, reason: 'gone' })
  })

  it('past its expiry it is expired, however fresh the second factor', () => {
    expect(checkPendingSwitch(kept({ live: false }), after, 2)).toEqual({ ok: false, reason: 'expired' })
  })

  it.each([
    ['the second factor of the confirmation itself', { id: 'u1', loa: 2, authTime: 1000 }],
    ['an older second factor', { id: 'u1', loa: 2, authTime: 999 }],
    ['no second factor at all', { id: 'u1', loa: 1, authTime: 1040 }],
    ['no sign-in time', { id: 'u1', loa: 2, authTime: Number.NaN }],
  ])('unconfirmed with %s', (_name, user) => {
    expect(checkPendingSwitch(kept(), user, 2)).toEqual({ ok: false, reason: 'unconfirmed' })
  })

  it('a confirmation made without any second factor (0) needs one afterwards', () => {
    expect(checkPendingSwitch(kept({ armedAuthTime: 0 }), { id: 'u1', loa: 2, authTime: 0 }, 2)).toEqual({ ok: false, reason: 'unconfirmed' })
    expect(checkPendingSwitch(kept({ armedAuthTime: 0 }), after, 2)).toMatchObject({ ok: true })
  })
})

describe('the handle', () => {
  /** A pool that fails the test when it is used. */
  const untouched = (): Sql => vi.fn(() => { throw new Error('the database must not be asked') }) as unknown as Sql

  it.each([['nothing', undefined], ['an empty text', ''], ['a short text', 'abc'], ['a text with other characters', `${'a'.repeat(42)}'`], ['a number', 7]])(
    'claimPendingSwitch answers null for %s without asking the database',
    async (_name, handle) => {
      expect(await claimPendingSwitch(untouched(), handle)).toBeNull()
    },
  )

  it('armPendingSwitch refuses a confirmation without a person, before the database is asked', async () => {
    await expect(armPendingSwitch(untouched(), { userId: '', authTime: 0, input: { moduleId: 'votes', action: 'enable' } })).rejects.toThrow(/person/)
  })

  it('waits no longer than the second factor stays fresh, on the module API path only', () => {
    expect(PENDING_TTL_SECONDS).toBeLessThanOrEqual(300)
    expect(PENDING_COOKIE_PATH).toBe('/api/settings/modules')
  })
})
