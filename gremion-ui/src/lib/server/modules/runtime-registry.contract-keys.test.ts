// TASK-206-0 guard: the four DataProviderContract keys (and the handover facts
// core) that module code written against the product registers through. The
// `satisfies` clause is the type-level half: drop a key from the contract and
// `svelte-check` reports this file (a removed key is a type error, not a silent
// runtime miss). The runtime half pins that the typed providers round-trip.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerDataProvider,
  getDataProvider,
  _resetRuntimeRegistryForTests,
  type DataProviderContract,
  type HandoverFinanceFactsCore,
} from './runtime-registry'

const PORTED_KEYS = [
  'finance:org-unit-refs',
  'finance:handover-retention',
  'finance:handover-facts',
  'messages:unread-rooms',
  // kernel-ahead, absent at the product source: must survive the port
  'finance:dashboard-summary',
] as const satisfies readonly (keyof DataProviderContract)[]

describe('DataProviderContract: ported provider keys', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
  })

  it('each ported key is registrable and resolves to its provider', () => {
    const facts: HandoverFinanceFactsCore = {
      financeUnitCount: 1,
      budgetTitel: [],
      openBookings: 0,
      pendingVierAugen: 0,
    }
    registerDataProvider('finance:org-unit-refs', async () => ({ referenced: false, counts: {} }))
    registerDataProvider('finance:handover-retention', async () => null)
    registerDataProvider('finance:handover-facts', async () => facts)
    registerDataProvider('messages:unread-rooms', async () => [])
    registerDataProvider('finance:dashboard-summary', async () => null)
    for (const key of PORTED_KEYS) expect(getDataProvider(key)).toBeTypeOf('function')
  })

  it('an unregistered key reads as absent (module off), never a default provider', () => {
    for (const key of PORTED_KEYS) expect(getDataProvider(key)).toBeUndefined()
  })
})
