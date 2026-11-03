// Phase 1 Task 4: the real adapters (pgModules, pgGate) build the Actor the
// tenant-store verbs record from the actor kind they are given. The verbs are
// stubbed so this stays a pure unit test; the schema already allows `person`
// in enabled_by_kind, requested_by_kind and ops.dpia_decision.decided_by_kind.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ enable: [] as unknown[][], disable: [] as unknown[][], dpia: [] as unknown[][] }))

vi.mock('@gremion/tenant-store/lifecycle', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@gremion/tenant-store/lifecycle')>()
  return {
    ...orig,
    enableModule: vi.fn(async (...a: unknown[]) => {
      calls.enable.push(a)
      return { noop: false, database: 't_x__votes' }
    }),
    disableModule: vi.fn(async (...a: unknown[]) => {
      calls.disable.push(a)
      return { noop: false, dropped: true, database: 't_x__votes', export: null }
    }),
    recordDpiaDecision: vi.fn(async (...a: unknown[]) => {
      calls.dpia.push(a)
      return { dpiaDecisionId: 'x', created: true }
    }),
  }
})

import type { Sql } from '@gremion/db'
import { pgGate, pgModules } from '../src/index.ts'
import type { CustomerRef } from '../src/ports.ts'

const ID = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const C: CustomerRef = { id: '01927f00-0000-7000-8000-000000000001', slug: 'musterstadt', token: 'musterstadt', realm: 'musterstadt', host: 'rat.musterstadt.example' }
// a callable stand-in: createEnableGate only asserts it is a function, the verbs are stubbed
const platform = (() => undefined) as unknown as Sql
const modules = () =>
  pgModules({
    platform,
    catalogue: [{ id: 'votes', moduleJson: { runtime: { version: '1' } } }] as never,
    lifecycle: { releaseRef: 'r' } as never,
  })

beforeEach(() => {
  calls.enable.length = 0
  calls.disable.length = 0
  calls.dpia.length = 0
})

describe('pgModules and pgGate: the Actor kind', () => {
  it('enable and disable record a person when asked, and an operator by default', async () => {
    const m = modules()
    await m.enable(C, 'votes', (async () => null) as never, ID, 'person')
    await m.enable(C, 'votes', (async () => null) as never, ID)
    await m.disable(C, 'votes', ID, 'person')
    await m.disable(C, 'votes', ID)
    expect(calls.enable.map((a) => a[2])).toEqual([
      { kind: 'person', id: ID },
      { kind: 'operator', id: ID },
    ])
    expect(calls.disable.map((a) => a[2])).toEqual([
      { kind: 'person', id: ID },
      { kind: 'operator', id: ID },
    ])
  })

  it('recordDpia records the decision as decided by a person when asked, by an operator by default', async () => {
    const gate = pgGate(platform, { releaseTipSha: null })
    const decision = { requiresDpia: 'no', reasonCodes: ['council_decision'], documentRef: 'TOM-Anhang 4.1' } as const
    await gate.recordDpia(C.id, 'votes', decision, ID, 'person')
    await gate.recordDpia(C.id, 'votes', decision, ID)
    expect(calls.dpia.map((a) => (a[1] as { decidedBy: unknown }).decidedBy)).toEqual([
      { kind: 'person', id: ID },
      { kind: 'operator', id: ID },
    ])
  })
})
