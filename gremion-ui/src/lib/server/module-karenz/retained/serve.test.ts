// Module Karenz (phase 2, Task 11): serving the sealed copies - the role gate, the redaction against
// the erasure reports and the publication to the sinks. The database is the Task 10 in-memory stand-in
// plus the three statements of serve.ts (erasure_report, the publish steps, the records of one row).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'
import { subjectRef } from '$lib/server/erasure/orchestrator'
import type { TenantContext } from '$lib/server/tenant/context'
import { _resetKarenzPassForTests, _resetKarenzStagesToDefaultsForTests, registerKarenzStages, runKarenzPass } from '../engine'
import type { KarenzRowView } from '../platform'
import { STEP } from '../engine'
import { sealLines } from './crypto'
import { _clearRetentionRegistriesForTests, registerRetainedSink, registerRetentionClassPolicy, registerRetentionExtractor, type RetainedLine, type RetainedSink } from './extractors'
import { fakeTenantDb } from './fake-db.test-util'
import { canReadRetained, listRetained, publishRetained, redactLines, republishRetainedForSubject, resetPublishStepsForSubject, retainedFilename } from './serve'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const KARENZ = '44444444-4444-4444-8444-444444444441'
const KARENZ_2 = '44444444-4444-4444-8444-444444444442'
const SECRET = 'unit-test-secret-one'
const SWITCHED_OFF = new Date('2026-10-01T10:00:00Z')
const seam = { secret: SECRET, guard: async () => {} }
const META = { catalogueId: 'votes', retentionClass: 'RC-TEST' }

const NAMED: RetainedLine = { id: 'p1', data: { title: 'Haushalt', createdBy: 'Erika Beispiel', note: 'bleibt' }, persons: [{ id: 'user-a', field: 'createdBy' }] }
const OTHER: RetainedLine = { id: 'p2', data: { title: 'zwei', createdBy: 'Max Muster' }, persons: [{ id: 'user-b', field: 'createdBy' }] }
const PLAIN: RetainedLine = { id: 'p3', data: { title: 'drei' }, persons: [] }

const refOf = (id: string) => subjectRef(TENANT_ID, id, SECRET)

interface StepFake {
  karenz_id: string
  step: string
  state: 'pending' | 'done' | 'failed' | 'skipped'
  last_error: string | null
}

/** The Task 10 stand-in plus the extra statements serve.ts issues. */
function world() {
  const t = fakeTenantDb()
  const erased: { tenant_id: string; subject_ref: string }[] = []
  const steps: StepFake[] = []
  const base = t.db as unknown as ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) & { unsafe: unknown; begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
  const tag = async (strings: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?')
    if (/FROM erasure_report/.test(text)) {
      return [...new Set(erased.filter((r) => r.tenant_id === v[0]).map((r) => r.subject_ref))].map((subject_ref) => ({ subject_ref }))
    }
    if (/UPDATE module_karenz_step/.test(text)) {
      const ref = v[0] as string
      const hit: StepFake[] = []
      for (const s of steps) {
        if (!s.step.startsWith('publish:')) continue
        const rec = t.records().find((r) => r.karenz_id === s.karenz_id && s.step.endsWith(`:${r.id}`))
        if (rec?.subject_refs.includes(ref)) hit.push(s)
      }
      for (const s of hit) {
        s.state = 'pending'
        s.last_error = null
      }
      return hit.map((s) => {
        const rec = t.records().find((r) => r.karenz_id === s.karenz_id && s.step.endsWith(`:${r.id}`))!
        return { step: s.step, karenz_id: s.karenz_id, record_id: rec.id, catalogue_id: rec.catalogue_id }
      })
    }
    if (/INSERT INTO module_karenz_step/.test(text)) {
      const [karenz_id, step, state] = v as [string, string, StepFake['state']]
      let s = steps.find((x) => x.karenz_id === karenz_id && x.step === step)
      if (!s) {
        s = { karenz_id, step, state, last_error: null }
        steps.push(s)
      }
      s.state = state
      s.last_error = null
      return [{ karenz_id, step, state, attempts: 1, last_error: null, last_reported_at: null, done_at: null, updated_at: new Date() }]
    }
    if (/SELECT id, catalogue_id, retention_class FROM retained_record/.test(text) && /WHERE karenz_id =/.test(text)) {
      return t.records().filter((r) => r.karenz_id === v[0]).map((r) => ({ id: r.id, catalogue_id: r.catalogue_id, retention_class: r.retention_class }))
    }
    if (/FROM retained_record/.test(text) && /ORDER BY/.test(text) && !/WHERE/.test(text)) {
      return t.records().map((r) => ({ id: r.id, catalogue_id: r.catalogue_id, retention_class: r.retention_class, extractor_id: r.extractor_id, line_count: r.line_count, created_at: new Date('2026-10-01T10:00:00Z') }))
    }
    return base(strings, ...v)
  }
  const db = Object.assign(tag, {
    unsafe: base.unsafe,
    begin: (fn: (tx: unknown) => Promise<unknown>) => base.begin(async () => fn(db)),
  })
  const tenant = { id: TENANT_ID, slug: 'rat-a', db } as unknown as TenantContext
  return {
    t,
    db: db as never,
    tenant,
    erased,
    steps,
    erase: (subjectId: string) => erased.push({ tenant_id: TENANT_ID, subject_ref: refOf(subjectId) }),
    seal: async (karenz: string, extractor: string, lines: RetainedLine[], over: Partial<typeof META> = {}) => {
      return sealLines(db as never, TENANT_ID, karenz, extractor, lines, { ...META, ...over }, seam)
    },
  }
}

beforeEach(() => {
  _clearRetentionRegistriesForTests()
  vi.stubEnv('AUTH_SECRET', SECRET)
})
afterEach(() => vi.unstubAllEnvs())

describe('canReadRetained', () => {
  it.each([
    [[Role.Vorstand], true],
    [[Role.CouncilAdmin], true],
    [[Role.Finance], true],
    [[Role.Auditor], true],
    [[Role.ITAdmin], true],
    [[Role.Member], false],
    [[Role.Guest], false],
    [[], false],
  ])('%j -> %s', (roles, expected) => {
    expect(canReadRetained(roles as Role[])).toBe(expected)
  })
})

describe('redactLines', () => {
  it('blanks the person field and the person id of an erased person and leaves everything else', () => {
    const out = redactLines([NAMED, OTHER, PLAIN], new Set([refOf('user-a')]), TENANT_ID, false, SECRET)
    expect(out[0]).toEqual({ id: 'p1', data: { title: 'Haushalt', createdBy: 'erased', note: 'bleibt' }, persons: [{ id: 'erased', field: 'createdBy' }] })
    expect(out[1]).toEqual(OTHER)
    expect(out[2]).toEqual(PLAIN)
  })

  it('does not change its input', () => {
    const before = JSON.stringify([NAMED])
    redactLines([NAMED], new Set([refOf('user-a')]), TENANT_ID, false, SECRET)
    expect(JSON.stringify([NAMED])).toBe(before)
  })

  it('lines without persons pass through unchanged', () => {
    expect(redactLines([PLAIN], new Set([refOf('user-a')]), TENANT_ID, false, SECRET)).toEqual([PLAIN])
  })

  it('an erasure of another tenant (a ref hashed under another tenant id) redacts nothing', () => {
    const foreign = subjectRef('99999999-9999-4999-8999-999999999999', 'user-a', SECRET)
    expect(redactLines([NAMED], new Set([foreign]), TENANT_ID, false, SECRET)).toEqual([NAMED])
  })

  it('a person field that is not in the line data is reported (field name only), not skipped silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const typo: RetainedLine = { id: 'p7', data: { createdBy: 'Erika Beispiel' }, persons: [{ id: 'user-a', field: 'author.name' }] }
      redactLines([typo], new Set([refOf('user-a')]), TENANT_ID, false, SECRET)
      const logged = warn.mock.calls.flat().join(' ')
      expect(logged).toContain('author.name')
      expect(logged).not.toContain('Erika')
      expect(logged).not.toContain('user-a')
    } finally {
      warn.mockRestore()
    }
  })

  it('keepsNamesUnderErasure true leaves the name legible (phase 3 finance case)', () => {
    expect(redactLines([NAMED], new Set([refOf('user-a')]), TENANT_ID, true, SECRET)).toEqual([NAMED])
  })

  it('an erased person is blanked in a field of the line even when the same person appears twice', () => {
    const twice: RetainedLine = {
      id: 'p9',
      data: { createdBy: 'Erika Beispiel', approvedBy: 'Erika Beispiel' },
      persons: [
        { id: 'user-a', field: 'createdBy' },
        { id: 'user-a', field: 'approvedBy' },
      ],
    }
    expect(redactLines([twice], new Set([refOf('user-a')]), TENANT_ID, false, SECRET)[0]!.data).toEqual({ createdBy: 'erased', approvedBy: 'erased' })
  })
})

describe('publishRetained and the redaction of a stored copy (Review Focus 5)', () => {
  const sinkCalls = () => {
    const calls: { recordId: string; title: string; filename: string; text: string }[] = []
    const sink: RetainedSink = {
      id: 'files',
      available: () => true,
      publish: async (c) => {
        calls.push({ recordId: c.recordId, title: c.title, filename: c.filename, text: c.ndjson.toString('utf8') })
      },
    }
    return { sink, calls }
  }

  it('a person erased after sealing is redacted in the served lines while the stored ciphertext hash is unchanged', async () => {
    const w = world()
    const sealed = await w.seal(KARENZ, 'votes.polls', [NAMED, PLAIN])
    const storedBefore = JSON.stringify(w.t.records().map((r) => [r.plaintext_sha256, r.ciphertext.toString('hex'), r.nonce.toString('hex')]))
    w.erase('user-a')

    const { sink, calls } = sinkCalls()
    await publishRetained({ tenant: w.tenant, record: { id: sealed.id, catalogueId: 'votes' }, sink })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).not.toContain('Erika Beispiel')
    expect(calls[0]!.text).not.toContain('user-a')
    expect(calls[0]!.text).toContain('"createdBy":"erased"')
    expect(calls[0]!.text).toContain('bleibt')
    // the stored bytes are never altered
    expect(JSON.stringify(w.t.records().map((r) => [r.plaintext_sha256, r.ciphertext.toString('hex'), r.nonce.toString('hex')]))).toBe(storedBefore)
    expect(w.t.records()[0]!.plaintext_sha256).toBe(sealed.sha256)
  })

  it('publishRetained sends the NDJSON to the sink with a stable filename, one JSON object per line', async () => {
    const w = world()
    const sealed = await w.seal(KARENZ, 'votes.polls', [NAMED, PLAIN])
    const { sink, calls } = sinkCalls()
    const rec = { id: sealed.id, catalogueId: 'votes' }
    await publishRetained({ tenant: w.tenant, record: rec, sink })
    await publishRetained({ tenant: w.tenant, record: rec, sink })

    expect(calls[0]!.filename).toBe(calls[1]!.filename)
    expect(calls[0]!.filename).toBe(retainedFilename('votes', sealed.id))
    expect(calls[0]!.filename).toMatch(/^[a-z0-9._-]+\.ndjson$/)
    expect(calls[0]!.recordId).toBe(sealed.id)
    expect(calls[0]!.title).not.toContain('Erika')
    const lines = calls[0]!.text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RetainedLine)
    expect(lines.map((l) => l.id)).toEqual(['p1', 'p3'])
    expect(calls[0]!.text.endsWith('\n')).toBe(true)
  })

  it('keepsNamesUnderErasure of the record class keeps the name in the published copy', async () => {
    const w = world()
    registerRetentionClassPolicy({ retentionClass: 'RC-KEEP', holdUntil: () => null, keepsNamesUnderErasure: true })
    const sealed = await w.seal(KARENZ, 'votes.polls', [NAMED], { retentionClass: 'RC-KEEP' })
    w.erase('user-a')
    const { sink, calls } = sinkCalls()
    await publishRetained({ tenant: w.tenant, record: { id: sealed.id, catalogueId: 'votes' }, sink })
    expect(calls[0]!.text).toContain('Erika Beispiel')
  })

  it('an unknown record id fails the publication', async () => {
    const w = world()
    const { sink } = sinkCalls()
    await expect(publishRetained({ tenant: w.tenant, record: { id: '55555555-5555-4555-8555-555555555555', catalogueId: 'votes' }, sink })).rejects.toThrow(/does not exist/)
  })
})

describe('resetPublishStepsForSubject', () => {
  it('sets the publish steps of the records naming the subject back to pending, and no other step or record', async () => {
    const w = world()
    const a = await w.seal(KARENZ, 'votes.a', [NAMED])
    const b = await w.seal(KARENZ, 'votes.b', [OTHER])
    const c = await w.seal(KARENZ_2, 'votes.c', [NAMED])
    for (const [k, id] of [[KARENZ, a.id], [KARENZ, b.id], [KARENZ_2, c.id]] as const) {
      w.steps.push({ karenz_id: k, step: STEP.publish('files', id), state: 'done', last_error: null })
    }
    w.steps.push({ karenz_id: KARENZ, step: STEP.retained, state: 'done', last_error: null })

    const n = await resetPublishStepsForSubject(w.db, refOf('user-a'))

    expect(n).toBe(2)
    const state = (step: string) => w.steps.find((s) => s.step === step)!.state
    expect(state(STEP.publish('files', a.id))).toBe('pending')
    expect(state(STEP.publish('files', c.id))).toBe('pending')
    // a record whose subject_refs do not contain the ref is not reset
    expect(state(STEP.publish('files', b.id))).toBe('done')
    expect(state(STEP.retained)).toBe('done')
  })

  it('returns 0 when no record names the subject', async () => {
    const w = world()
    const a = await w.seal(KARENZ, 'votes.a', [OTHER])
    w.steps.push({ karenz_id: KARENZ, step: STEP.publish('files', a.id), state: 'done', last_error: null })
    expect(await resetPublishStepsForSubject(w.db, refOf('user-a'))).toBe(0)
  })
})

describe('republishRetainedForSubject (an erasure after the Karenz row left the live states)', () => {
  function publishedWorld() {
    const w = world()
    const calls: { sink: string; filename: string; text: string }[] = []
    const sinkOf = (id: string, over: Partial<RetainedSink> = {}): RetainedSink => ({
      id,
      available: () => true,
      publish: async (c) => void calls.push({ sink: id, filename: c.filename, text: c.ndjson.toString('utf8') }),
      ...over,
    })
    return { w, calls, sinkOf }
  }

  it('publishes the redacted copy at once, whatever state the Karenz row is in: no engine pass runs', async () => {
    const { w, calls, sinkOf } = publishedWorld()
    const a = await w.seal(KARENZ, 'votes.a', [NAMED, PLAIN])
    registerRetainedSink(sinkOf('files'))
    // the row finalized long ago: its publish step is done and no pass will ever list it again
    w.steps.push({ karenz_id: KARENZ, step: STEP.publish('files', a.id), state: 'done', last_error: null })
    w.erase('user-a')

    const out = await republishRetainedForSubject(w.tenant, refOf('user-a'))

    expect(out).toEqual({ published: 1, unreachable: [], failed: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.filename).toBe(retainedFilename('votes', a.id))
    expect(calls[0]!.text).not.toContain('Erika Beispiel')
    expect(calls[0]!.text).toContain('"createdBy":"erased"')
    // nothing is left pending behind it
    expect(w.steps.find((s) => s.step === STEP.publish('files', a.id))?.state).toBe('done')
  })

  it('a sink that is unavailable (the files module is off) is reported, and the step stays pending for a later pass', async () => {
    const { w, calls, sinkOf } = publishedWorld()
    const a = await w.seal(KARENZ, 'votes.a', [NAMED])
    registerRetainedSink(sinkOf('files', { available: () => false }))
    w.steps.push({ karenz_id: KARENZ, step: STEP.publish('files', a.id), state: 'done', last_error: null })
    w.erase('user-a')

    const out = await republishRetainedForSubject(w.tenant, refOf('user-a'))

    expect(out).toEqual({ published: 0, unreachable: [STEP.publish('files', a.id)], failed: [] })
    expect(calls).toHaveLength(0)
    expect(w.steps.find((s) => s.step === STEP.publish('files', a.id))?.state).toBe('pending')
  })

  it('a sink that fails is reported without any message text, and the step stays pending', async () => {
    const { w, sinkOf } = publishedWorld()
    const a = await w.seal(KARENZ, 'votes.a', [NAMED])
    registerRetainedSink(sinkOf('files', { publish: async () => { throw new Error('upload of Erika Beispiel refused') } }))
    w.steps.push({ karenz_id: KARENZ, step: STEP.publish('files', a.id), state: 'done', last_error: null })
    w.erase('user-a')

    const out = await republishRetainedForSubject(w.tenant, refOf('user-a'))

    expect(out.published).toBe(0)
    expect(out.failed).toHaveLength(1)
    expect(out.failed[0]).toContain(STEP.publish('files', a.id))
    expect(JSON.stringify(out)).not.toContain('Erika')
    expect(w.steps.find((s) => s.step === STEP.publish('files', a.id))?.state).toBe('pending')
  })

  it('one failing copy does not stop the others, and a record that does not name the subject is left alone', async () => {
    const { w, calls, sinkOf } = publishedWorld()
    const a = await w.seal(KARENZ, 'votes.a', [NAMED])
    const b = await w.seal(KARENZ, 'votes.b', [OTHER])
    const c = await w.seal(KARENZ_2, 'votes.c', [NAMED])
    registerRetainedSink(sinkOf('files', { publish: async (x) => { if (x.recordId === a.id) throw new Error('boom'); calls.push({ sink: 'files', filename: x.filename, text: x.ndjson.toString('utf8') }) } }))
    for (const [k, id] of [[KARENZ, a.id], [KARENZ, b.id], [KARENZ_2, c.id]] as const) w.steps.push({ karenz_id: k, step: STEP.publish('files', id), state: 'done', last_error: null })
    w.erase('user-a')

    const out = await republishRetainedForSubject(w.tenant, refOf('user-a'))

    expect(out.published).toBe(1)
    expect(out.failed).toHaveLength(1)
    expect(calls.map((x) => x.filename)).toEqual([retainedFilename('votes', c.id)])
    expect(w.steps.find((s) => s.step === STEP.publish('files', b.id))?.state).toBe('done')
  })

  it('a copy that was never published (no step) is not published by the erasure', async () => {
    const { w, calls, sinkOf } = publishedWorld()
    await w.seal(KARENZ, 'votes.a', [NAMED])
    registerRetainedSink(sinkOf('files'))
    w.erase('user-a')
    expect(await republishRetainedForSubject(w.tenant, refOf('user-a'))).toEqual({ published: 0, unreachable: [], failed: [] })
    expect(calls).toHaveLength(0)
  })
})

describe('listRetained', () => {
  it('lists the copies of the tenant without ciphertext', async () => {
    const w = world()
    await w.seal(KARENZ, 'votes.a', [NAMED, PLAIN])
    const out = await listRetained(TENANT_ID, w.db)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ catalogueId: 'votes', retentionClass: 'RC-TEST', lineCount: 2 })
    expect(out[0]!.createdAt).toBeInstanceOf(Date)
    expect(Object.keys(out[0]!).toSorted()).toEqual(['catalogueId', 'createdAt', 'id', 'lineCount', 'retentionClass'])
  })
})

describe('the engine publishes every record to every available sink (steps publish:<sink>:<record>)', () => {
  beforeEach(() => {
    _resetKarenzStagesToDefaultsForTests()
    // the notice stages have their own tests; the pass here is about the publish steps
    registerKarenzStages({ noticeSwitchoff: undefined, reminder: undefined })
    registerRetentionExtractor({ id: 'votes.a', catalogueId: 'votes', retentionClass: 'RC-TEST', async *extract() { yield NAMED; yield PLAIN } })
  })
  afterEach(() => {
    _resetKarenzPassForTests()
    _resetKarenzStagesToDefaultsForTests()
  })

  async function pass(w: ReturnType<typeof world>, over: Partial<KarenzRowView> = {}) {
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
    const find = (karenzId: string, step: string) => w.steps.find((s) => s.karenz_id === karenzId && s.step === step)
    const toRow = (s: StepFake) => ({ karenzId: s.karenz_id, step: s.step, state: s.state, attempts: 1, lastError: s.last_error, lastReportedAt: null, doneAt: null, updatedAt: new Date() }) as never
    return runKarenzPass(w.tenant, {
      listKarenz: async () => [row],
      reportKarenz: async () => {},
      participantsFor: () => [{ catalogueId: 'votes', switchOff: async () => {}, restore: async () => {}, finalize: async () => ({ deleted: {} }) } as never],
      writeAudit: async () => {},
      startedActor: async () => null,
      now: () => new Date(SWITCHED_OFF.getTime() + 60_000),
      store: {
        getStep: async (_d, k, step) => {
          const s = find(k, step)
          return s ? toRow(s) : null
        },
        markStep: async (_d, k, step, patch) => {
          let s = find(k, step)
          if (!s) {
            s = { karenz_id: k, step, state: patch.state, last_error: null }
            w.steps.push(s)
          }
          s.state = patch.state
          s.last_error = patch.error ?? null
          return toRow(s)
        },
        listSteps: async (_d, k) => w.steps.filter((s) => s.karenz_id === k).map(toRow),
        upsertItem: async () => { throw new Error('unused') },
        listItems: async () => [],
        setItemState: async () => true,
      },
    })
  }

  it('publishes the sealed copy to the sink after the retained step, under the publish:<sink>:<record> step', async () => {
    const w = world()
    const calls: string[] = []
    registerRetainedSink({ id: 'files', available: () => true, publish: async (c) => void calls.push(c.filename) })
    const result = await pass(w)
    expect(result.failed).toBe(0)
    const rec = w.t.records()[0]!
    expect(w.steps.find((s) => s.step === STEP.publish('files', rec.id))?.state).toBe('done')
    expect(calls).toEqual([retainedFilename('votes', rec.id)])
    // a second pass does not publish again
    await pass(w)
    expect(calls).toHaveLength(1)
  })

  it('a sink that is not available for the tenant gets no step', async () => {
    const w = world()
    const publish = vi.fn(async () => {})
    registerRetainedSink({ id: 'files', available: () => false, publish })
    await pass(w)
    expect(w.steps.some((s) => s.step.startsWith('publish:'))).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })

  it('a sink failure marks the publish step failed and the next pass retries it', async () => {
    const w = world()
    let fail = true
    const publish = vi.fn(async () => {
      if (fail) throw new Error('nextcloud unreachable for Erika Beispiel')
    })
    registerRetainedSink({ id: 'files', available: () => true, publish })
    const first = await pass(w)
    expect(first.failed).toBeGreaterThan(0)
    const rec = w.t.records()[0]!
    const step = w.steps.find((s) => s.step === STEP.publish('files', rec.id))!
    expect(step.state).toBe('failed')
    expect(step.last_error).not.toContain('Erika')

    fail = false
    const second = await pass(w)
    expect(second.failed).toBe(0)
    expect(step.state).toBe('done')
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('after an erasure resetPublishStepsForSubject makes the next pass publish the redacted version again under the same filename', async () => {
    const w = world()
    const calls: { filename: string; text: string }[] = []
    registerRetainedSink({ id: 'files', available: () => true, publish: async (c) => void calls.push({ filename: c.filename, text: c.ndjson.toString('utf8') }) })
    await pass(w)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).toContain('Erika Beispiel')

    w.erase('user-a')
    expect(await resetPublishStepsForSubject(w.db, refOf('user-a'))).toBe(1)
    await pass(w)

    expect(calls).toHaveLength(2)
    expect(calls[1]!.filename).toBe(calls[0]!.filename)
    expect(calls[1]!.text).not.toContain('Erika Beispiel')
    expect(calls[1]!.text).toContain('erased')
  })

  it('a sink id too long for a step name makes the list of publish steps fail loudly instead of publishing under an unreportable name', async () => {
    const w = world()
    const publish = vi.fn(async () => {})
    registerRetainedSink({ id: 'a-sink-id-that-is-far-too-long-for-a-step', available: () => true, publish })
    const result = await pass(w)
    expect(result.failed).toBeGreaterThan(0)
    expect(w.steps.find((s) => s.step === STEP.publishList)?.state).toBe('failed')
    expect(publish).not.toHaveBeenCalled()
  })
})
