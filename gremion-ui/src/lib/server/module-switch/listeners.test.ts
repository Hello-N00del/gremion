// @vitest-environment node
//
// Karenz phase 1, Task 13: the listener registry the reconciler notifies once a council request has
// reached a final state. Phase 2 registers the info mail here; phase 1 registers nothing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _clearModuleSwitchListenersForTests, notifyModuleSwitchListeners, registerModuleSwitchListener, type ModuleSwitchEvent } from './listeners'

const EVENT: ModuleSwitchEvent = {
  requestId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  slug: 'rat-a',
  moduleId: 'votes',
  manifestId: 'votes',
  action: 'enable',
  outcome: 'applied',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  at: new Date('2026-10-31T10:00:00Z'),
  detail: null,
}

afterEach(() => {
  _clearModuleSwitchListenersForTests()
  vi.restoreAllMocks()
})

describe('module switch listeners', () => {
  it('calls every registered listener with the event, in registration order', async () => {
    const order: string[] = []
    registerModuleSwitchListener(async (e) => {
      order.push(`a:${e.requestId}`)
    })
    registerModuleSwitchListener(async (e) => {
      order.push(`b:${e.outcome}`)
    })
    await notifyModuleSwitchListeners(EVENT)
    expect(order).toEqual([`a:${EVENT.requestId}`, 'b:applied'])
  })

  it('a listener that rejects is logged and does not stop the next one', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const next = vi.fn(async () => {})
    registerModuleSwitchListener(async () => {
      throw new Error('mail relay down')
    })
    registerModuleSwitchListener(next)
    await expect(notifyModuleSwitchListeners(EVENT)).resolves.toBeUndefined()
    expect(next).toHaveBeenCalledTimes(1)
    expect(err.mock.calls.flat().join(' ')).toContain('mail relay down')
  })

  it('a listener that throws synchronously is contained the same way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const next = vi.fn(async () => {})
    registerModuleSwitchListener((() => {
      throw new Error('sync boom')
    }) as never)
    registerModuleSwitchListener(next)
    await notifyModuleSwitchListeners(EVENT)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('with no listener registered a notification is a no-op', async () => {
    await expect(notifyModuleSwitchListeners(EVENT)).resolves.toBeUndefined()
  })
})
