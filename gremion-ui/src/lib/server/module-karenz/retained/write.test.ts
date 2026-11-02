// Module Karenz (phase 2, Task 10): writing the sealed copies at switch-off.
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'
import { KarenzPartialError, type KarenzContext } from '../participants'
import type { KarenzRowView } from '../platform'
import { _resetKarenzPassForTests, runKarenzPass, STEP } from '../engine'
import { openLines, sealLines } from './crypto'
import {
  _clearRetentionRegistriesForTests,
  extractorsFor,
  policyFor,
  registerNoRetention,
  registerRetainedSink,
  registerRetentionClassPolicy,
  registerRetentionExtractor,
  retainedSinks,
  type RetainedLine,
  type RetainedSink,
  type RetentionExtractor,
} from './extractors'
import { fakeTenantDb } from './fake-db.test-util'
import { writeRetainedCopies } from './write'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const KARENZ = '44444444-4444-4444-8444-444444444441'
const SECRET = 'unit-test-secret-one'
const guard = { secret: SECRET, guard: async () => {} }
const SWITCHED_OFF = new Date('2026-10-01T10:00:00Z')

function ndjson(lines: RetainedLine[]): string {
  return lines.map((l) => JSON.stringify(l) + '\n').join('')
}

function ctxFor(t: ReturnType<typeof fakeTenantDb>, over: Partial<KarenzContext> = {}): KarenzContext {
  return {
    tenant: { id: TENANT_ID, slug: 'rat-a', db: t.db } as unknown as TenantContext,
    karenzId: KARENZ,
    catalogueId: 'votes',
    manifestId: 'votes',
    switchedOffAt: SWITCHED_OFF,
    finalAt: new Date(SWITCHED_OFF.getTime() + 30 * 86_400_000),
    now: () => SWITCHED_OFF,
    items: { list: async () => [], upsert: async () => { throw new Error('unused') }, setState: async () => {} },
    log: () => {},
    ...over,
  }
}

const L1: RetainedLine = { id: 'p1', data: { title: 'eins' }, persons: [{ id: 'user-a', field: 'createdBy' }] }
const L2: RetainedLine = { id: 'p2', data: { title: 'zwei' }, persons: [] }

function extractor(id: string, lines: RetainedLine[] | Error, over: Partial<RetentionExtractor> = {}): RetentionExtractor {
  return {
    id,
    catalogueId: 'votes',
    retentionClass: 'RC-TEST',
    async *extract() {
      if (lines instanceof Error) throw lines
      for (const l of lines) yield l
    },
    ...over,
  }
}

beforeEach(() => _clearRetentionRegistriesForTests())

describe('registries', () => {
  it('extractorsFor returns the extractors of one catalogue id in registration order; a re-registration replaces in place', () => {
    registerRetentionExtractor(extractor('votes.a', []))
    registerRetentionExtractor(extractor('elections.a', [], { catalogueId: 'elections' }))
    registerRetentionExtractor(extractor('votes.b', []))
    expect(extractorsFor('votes').map((e) => e.id)).toEqual(['votes.a', 'votes.b'])
    registerRetentionExtractor(extractor('votes.a', [L1], { retentionClass: 'RC-NEW' }))
    expect(extractorsFor('votes').map((e) => `${e.id}:${e.retentionClass}`)).toEqual(['votes.a:RC-NEW', 'votes.b:RC-TEST'])
    expect(extractorsFor('nothing')).toEqual([])
  })

  it('policyFor defaults to no hold and no legible names, and a registered class policy wins', () => {
    expect(policyFor('RC-X').holdUntil({ startedAt: SWITCHED_OFF })).toBeNull()
    expect(policyFor('RC-X').keepsNamesUnderErasure).toBe(false)
    registerRetentionClassPolicy({ retentionClass: 'RC-X', holdUntil: ({ startedAt }) => new Date(startedAt.getTime() + 86_400_000), keepsNamesUnderErasure: true })
    expect(policyFor('RC-X').holdUntil({ startedAt: SWITCHED_OFF })?.toISOString()).toBe('2026-10-02T10:00:00.000Z')
    expect(policyFor('RC-X').keepsNamesUnderErasure).toBe(true)
  })

  it('registered sinks are listed', () => {
    const s: RetainedSink = { id: 'files', available: () => true, publish: async () => {} }
    registerRetainedSink(s)
    expect(retainedSinks().map((x) => x.id)).toEqual(['files'])
  })
})

describe('writeRetainedCopies', () => {
  it('writes one record per extractor and counts them', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(extractor('votes.a', [L1, L2]))
    registerRetentionExtractor(extractor('votes.b', [L1]))
    expect(await writeRetainedCopies(ctxFor(t), guard)).toEqual({ records: 2, lines: 3 })
    expect(t.records().map((r) => r.extractor_id)).toEqual(['votes.a', 'votes.b'])
    expect(t.records()[0]).toMatchObject({ karenz_id: KARENZ, catalogue_id: 'votes', retention_class: 'RC-TEST', line_count: 2, hold_until: null })
  })

  it('a second write for the same karenz writes no new row (idempotent) and does not run the extractor again', async () => {
    const t = fakeTenantDb()
    const extract = vi.fn(async function* () {
      yield L1
    })
    registerRetentionExtractor(extractor('votes.a', [], { extract }))
    expect(await writeRetainedCopies(ctxFor(t), guard)).toEqual({ records: 1, lines: 1 })
    expect(await writeRetainedCopies(ctxFor(t), guard)).toEqual({ records: 0, lines: 0 })
    expect(t.records()).toHaveLength(1)
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('a record written by a concurrent pass (unique violation) counts as already written, not as a failure', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(
      extractor('votes.a', [], {
        // the other pass commits its copy while this one is still extracting
        async *extract() {
          yield L1
          await sealLines(t.db, TENANT_ID, KARENZ, 'votes.a', [L1], { catalogueId: 'votes', retentionClass: 'RC-TEST' }, guard)
        },
      }),
    )
    expect(await writeRetainedCopies(ctxFor(t), guard)).toEqual({ records: 0, lines: 0 })
    expect(t.records()).toHaveLength(1)
  })

  it('writeRetainedCopies calls no sink', async () => {
    const t = fakeTenantDb()
    const publish = vi.fn(async () => {})
    const available = vi.fn(() => true)
    registerRetainedSink({ id: 'files', available, publish })
    registerRetentionExtractor(extractor('votes.a', [L1]))
    await writeRetainedCopies(ctxFor(t), guard)
    expect(publish).not.toHaveBeenCalled()
    expect(available).not.toHaveBeenCalled()
  })

  it("an extractor that throws leaves no partial row for it and fails the step, the other extractors' rows stay", async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(extractor('votes.a', [L1]))
    registerRetentionExtractor(
      extractor('votes.bad', [], {
        async *extract() {
          yield L1
          throw new Error('Nextcloud said: poll of Erika Mustermann')
        },
      }),
    )
    registerRetentionExtractor(extractor('votes.c', [L2]))
    const err = (await writeRetainedCopies(ctxFor(t), guard).catch((e: unknown) => e)) as KarenzPartialError
    expect(err).toBeInstanceOf(KarenzPartialError)
    expect(err.failures).toHaveLength(1)
    expect(err.failures[0]).toContain('votes.bad')
    // the label names the extractor and the error class, never the error text (which may carry a name)
    expect(err.failures[0]).not.toContain('Mustermann')
    expect(t.records().map((r) => r.extractor_id)).toEqual(['votes.a', 'votes.c'])

    // the next pass retries only the missing one
    registerRetentionExtractor(extractor('votes.bad', [L1]))
    expect(await writeRetainedCopies(ctxFor(t), guard)).toEqual({ records: 1, lines: 1 })
    expect(t.records().map((r) => r.extractor_id).toSorted()).toEqual(['votes.a', 'votes.bad', 'votes.c'])
  })

  it('a sealing failure rolls the transaction back: no record and no data key stay behind', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(extractor('votes.a', [L1]))
    const err = await writeRetainedCopies(ctxFor(t), { secret: SECRET, guard: async () => { throw new Error('guard says no') } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KarenzPartialError)
    expect(t.records()).toHaveLength(0)
    expect(t.keys()).toHaveLength(0)
  })

  it('a record that fails after its data key was minted rolls the key back too (one transaction per extractor)', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(extractor('votes.a', [L1]))
    let calls = 0
    // the first guarded write (the data key) passes, the second (the record) is refused
    const flaky = {
      secret: SECRET,
      guard: async () => {
        if (++calls > 1) throw new Error('guard says no')
      },
    }
    const err = await writeRetainedCopies(ctxFor(t), flaky).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KarenzPartialError)
    expect(calls).toBe(2)
    expect(t.records()).toHaveLength(0)
    expect(t.keys()).toHaveLength(0)
  })

  it('a catalogue id that declared it retains nothing is success with zero records', async () => {
    const t = fakeTenantDb()
    registerNoRetention('votes')
    expect(await writeRetainedCopies(ctxFor(t), guard)).toEqual({ records: 0, lines: 0 })
    expect(t.statements).toHaveLength(0)
  })

  it('no extractor and no declaration fails the step: a missing registration is not "nothing to retain"', async () => {
    const t = fakeTenantDb()
    const err = (await writeRetainedCopies(ctxFor(t), guard).catch((e: unknown) => e)) as KarenzPartialError
    expect(err).toBeInstanceOf(KarenzPartialError)
    expect(err.failures).toHaveLength(1)
    expect(err.failures[0]).toContain('votes')
    expect(t.statements).toHaveLength(0)
  })

  it('a declaration for another catalogue id does not cover this one', async () => {
    const t = fakeTenantDb()
    registerNoRetention('elections')
    await expect(writeRetainedCopies(ctxFor(t), guard)).rejects.toBeInstanceOf(KarenzPartialError)
  })

  it('a unique violation that comes out of an extractor is a failure, not "already written"', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(
      extractor('votes.a', [], {
        async *extract() {
          yield L1
          throw Object.assign(new Error('module database said: duplicate key'), { code: '23505' })
        },
      }),
    )
    const err = (await writeRetainedCopies(ctxFor(t), guard).catch((e: unknown) => e)) as KarenzPartialError
    expect(err).toBeInstanceOf(KarenzPartialError)
    expect(err.failures[0]).toContain('votes.a')
    expect(t.records()).toHaveLength(0)
  })

  it('a unique violation while sealing counts as written only when the copy really exists', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(extractor('votes.a', [L1]))
    const refused = { secret: SECRET, guard: async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }) } }
    const err = (await writeRetainedCopies(ctxFor(t), refused).catch((e: unknown) => e)) as KarenzPartialError
    expect(err).toBeInstanceOf(KarenzPartialError)
    expect(t.records()).toHaveLength(0)
  })

  it('a database failure label carries the SQLSTATE and never the message', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(
      extractor('votes.a', [], {
        async *extract() {
          yield L1
          throw Object.assign(new Error('permission denied for table of Erika Mustermann'), { code: '42501' })
        },
      }),
    )
    const err = (await writeRetainedCopies(ctxFor(t), guard).catch((e: unknown) => e)) as KarenzPartialError
    expect(err.failures[0]).toContain('votes.a')
    expect(err.failures[0]).toContain('[42501]')
    expect(err.failures[0]).not.toContain('Mustermann')
  })

  it('only the extractors of the context catalogue id run', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(extractor('votes.a', [L1]))
    registerRetentionExtractor(extractor('elections.a', [L2], { catalogueId: 'elections' }))
    await writeRetainedCopies(ctxFor(t, { catalogueId: 'elections' }), guard)
    expect(t.records().map((r) => r.extractor_id)).toEqual(['elections.a'])
  })

  it('plaintext_sha256 equals the NDJSON hash, and the copy opens to the extracted lines', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(extractor('votes.a', [L1, L2]))
    await writeRetainedCopies(ctxFor(t), guard)
    const rec = t.records()[0]!
    expect(rec.plaintext_sha256).toBe(createHash('sha256').update(ndjson([L1, L2])).digest('hex'))
    expect(await openLines(t.db, TENANT_ID, rec.id, { secret: SECRET })).toEqual([L1, L2])
  })

  it('the class policy sets hold_until from the switch-off date', async () => {
    const t = fakeTenantDb()
    registerRetentionClassPolicy({ retentionClass: 'RC-HOLD', holdUntil: ({ startedAt }) => new Date(Date.UTC(startedAt.getUTCFullYear() + 2, startedAt.getUTCMonth(), startedAt.getUTCDate())), keepsNamesUnderErasure: false })
    registerRetentionExtractor(extractor('votes.a', [L1], { retentionClass: 'RC-HOLD' }))
    registerRetentionExtractor(extractor('votes.b', [L1]))
    await writeRetainedCopies(ctxFor(t), guard)
    expect(t.records().map((r) => r.hold_until)).toEqual(['2028-10-01', null])
  })

  it('a hold date that is not at UTC midnight moves to the next day, never to the day before', async () => {
    const t = fakeTenantDb()
    // local midnight in a UTC+2 zone is 22:00Z of the previous day
    registerRetentionClassPolicy({ retentionClass: 'RC-HOLD', holdUntil: () => new Date('2028-09-30T22:00:00Z'), keepsNamesUnderErasure: false })
    registerRetentionExtractor(extractor('votes.a', [L1], { retentionClass: 'RC-HOLD' }))
    await writeRetainedCopies(ctxFor(t), guard)
    expect(t.records().map((r) => r.hold_until)).toEqual(['2028-10-01'])
  })
})

describe('the engine writes the copies in its retained step', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    _resetKarenzPassForTests()
  })

  async function pass(t: ReturnType<typeof fakeTenantDb>, over: Partial<KarenzRowView> = {}) {
    vi.stubEnv('AUTH_SECRET', SECRET)
    const tenant = { id: TENANT_ID, slug: 'rat-a', db: t.db } as unknown as TenantContext
    const steps = new Map<string, string>()
    const row: KarenzRowView = {
      karenzId: KARENZ,
      catalogueId: 'votes',
      manifestId: 'votes',
      state: 'open',
      switchedOffAt: SWITCHED_OFF,
      finalAt: new Date(SWITCHED_OFF.getTime() + 30 * 86_400_000),
      restoreRequestedAt: null,
      finalMode: null,
      platformDoneAt: null,
      tenantDoneAt: null,
      ...over,
    }
    const finalized = vi.fn()
    const result = await runKarenzPass(tenant, {
      listKarenz: async () => [row],
      reportKarenz: async () => {},
      participantsFor: () => [
        {
          catalogueId: 'votes',
          switchOff: async () => ({}),
          restore: async () => {},
          finalize: async (...a: unknown[]) => {
            finalized(...a)
            return { deleted: {} }
          },
        } as never,
      ],
      writeAudit: async () => {},
      startedActor: async () => null,
      now: () => new Date(SWITCHED_OFF.getTime() + 60_000),
      store: {
        getStep: async (_d, _k, step) => (steps.has(step) ? ({ step, state: steps.get(step)!, attempts: 1, lastError: null, lastReportedAt: null } as never) : null),
        markStep: async (_d, _k, step, patch) => {
          steps.set(step, patch.state)
          return { step, state: patch.state, attempts: 1 } as never
        },
        listSteps: async () => [...steps.entries()].map(([step, state]) => ({ step, state, attempts: 1, lastError: null, lastReportedAt: null }) as never),
        upsertItem: async () => { throw new Error('unused') },
        listItems: async () => [],
        setItemState: async () => true,
      },
    })
    return { result, steps, finalized }
  }

  it('a pass over an open row seals the registered extractors through writeRetainedCopies and marks the step done', async () => {
    const t = fakeTenantDb()
    registerRetentionExtractor(extractor('votes.a', [L1, L2]))
    const { result, steps } = await pass(t)
    expect(result.failed).toBe(0)
    expect(steps.get(STEP.retained)).toBe('done')
    expect(t.records().map((r) => r.extractor_id)).toEqual(['votes.a'])
  })

  it('a catalogue id with no extractor and no declaration leaves the retained step failed and the finalize refused, so nothing is deleted', async () => {
    const t = fakeTenantDb()
    const open = await pass(t)
    expect(open.steps.get(STEP.retained)).toBe('failed')
    expect(open.result.failed).toBeGreaterThan(0)

    const fin = await pass(t, { state: 'finalizing', finalMode: 'live' })
    expect(fin.steps.get(STEP.retained)).toBe('failed')
    expect(fin.steps.get(STEP.final)).toBe('failed')
    expect(fin.finalized).not.toHaveBeenCalled()
  })

  it('a catalogue id that declared it retains nothing finalizes', async () => {
    const t = fakeTenantDb()
    registerNoRetention('votes')
    const fin = await pass(t, { state: 'finalizing', finalMode: 'live' })
    expect(fin.steps.get(STEP.retained)).toBe('done')
    expect(fin.finalized).toHaveBeenCalled()
  })
})
