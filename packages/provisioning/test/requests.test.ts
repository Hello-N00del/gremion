// TASK-043d-1 TDD 7: the request-kind registry and the per-kind args checks
// the container's request-verify runs before the executor runs anything. The
// create args reuse validateCreate (slug, host, the two administrators, the
// enable list against the catalogue and the deny set); a kind without a
// handler is refused naming its owner; args.slug must be the request's slug.
import { describe, expect, it } from 'vitest'
import { HANDLED_KINDS, KIND_OWNER, REQUEST_KINDS, verifyRequestArgs, verifyEnableLoaded, type RequestEnvelope } from '../src/index.ts'

const OPERATOR = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const CATALOGUE = ['board', 'calendar', 'content', 'finance', 'publishing', 'vault', 'votes']
const DISABLED = ['content', 'finance', 'vault']

const createArgs = (over: Record<string, unknown> = {}) => ({
  slug: 'musterstadt',
  host: 'rat.musterstadt.example',
  itAdmin: 'IT@Musterstadt.example',
  councilAdmin: 'rat@musterstadt.example',
  bodyName: 'Stadtrat',
  brand: { product: 'Ratsportal', orgShort: 'MS' },
  enable: ['votes', 'calendar', 'votes'],
  ...over,
})
const env = (over: Partial<RequestEnvelope> = {}): RequestEnvelope => ({ kind: 'create', customerSlug: 'musterstadt', args: createArgs(), operatorId: OPERATOR, ...over })
const verify = (e: RequestEnvelope) => verifyRequestArgs(e, { catalogueIds: CATALOGUE, disabledIds: DISABLED })

describe('the request kinds', () => {
  it('every kind of the DB CHECK is known; only create has a handler in 043d-1; reserved kinds name their owner', () => {
    expect([...REQUEST_KINDS].sort()).toEqual(
      ['create', 'disable_module', 'enable_module', 'import_isolation', 'import_members', 'reconcile', 'record_dpia', 'resume', 'seed_vertical', 'suspend'].sort(),
    )
    expect([...HANDLED_KINDS]).toEqual(['create'])
    expect(KIND_OWNER.import_members).toBe('TASK-031')
    expect(KIND_OWNER.seed_vertical).toBe('TASK-031')
    expect(KIND_OWNER.record_dpia).toBe('TASK-044')
    expect(KIND_OWNER.import_isolation).toBe('TASK-044')
  })

  it.each([
    ['import_members', 'no handler (TASK-031)'],
    ['seed_vertical', 'no handler (TASK-031)'],
    ['record_dpia', 'no handler (TASK-044)'],
    ['import_isolation', 'no handler (TASK-044)'],
    ['suspend', 'no handler (TASK-043d-2)'],
  ])('%s is refused: %s', (kind, reason) => {
    expect(verify(env({ kind, args: {} }))).toEqual({ verdict: 'refused', reason })
  })

  it('an unknown kind is refused by name', () => {
    expect(verify(env({ kind: 'drop_everything' }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown request kind drop_everything/) })
  })
})

describe('create args', () => {
  it('valid: normalised (emails lower-cased, enable sorted and unique, brand kept)', () => {
    const r = verify(env())
    expect(r).toEqual({
      verdict: 'ok',
      args: {
        slug: 'musterstadt',
        host: 'rat.musterstadt.example',
        itAdmin: 'it@musterstadt.example',
        councilAdmin: 'rat@musterstadt.example',
        bodyName: 'Stadtrat',
        brand: { product: 'Ratsportal', orgShort: 'MS' },
        enable: ['calendar', 'votes'],
        dpia: {},
      },
    })
  })

  it.each([
    ['board', /board cannot be enabled: it is not tenant-isolated/],
    ['vault', /vault cannot be enabled: the password vault stays off/],
    ['nosuchmodule', /not in the catalogue/],
    ['finance', /finance is disabled in this build \(modules\/disabled\.json\)/],
  ])('enable %s is refused by name', (id, why) => {
    expect(verify(env({ args: createArgs({ enable: ['calendar', id] }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(why) })
  })

  it('a bad host, a missing administrator, a host path in the args or an unknown field are refused', () => {
    expect(verify(env({ args: createArgs({ host: 'Rat.Example' }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/host/) })
    expect(verify(env({ args: createArgs({ councilAdmin: 'not-an-address' }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/admin email/) })
    expect(verify(env({ args: createArgs({ configFile: '/etc/shadow' }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field configFile/) })
    expect(verify(env({ args: createArgs({ brand: { product: '', orgShort: 'MS' } }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/brand\.product/) })
    expect(verify(env({ args: createArgs({ brand: { product: 'X', orgShort: 'MS', logo: 'x' } }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field brand\.logo/) })
  })

  it('args.slug must be the request slug', () => {
    expect(verify(env({ customerSlug: 'anderstadt' }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/args\.slug musterstadt is not the request's slug anderstadt/) })
  })

  it('a non-uuid operator is refused', () => {
    expect(verify(env({ operatorId: 'root' }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/operator id/) })
  })

  it('C13: optional DPIA decisions per enabled module, carried to CreateSpec.dpia; a decision for a module not enabled, or a malformed one, is refused', () => {
    const dpia = { votes: { requires_dpia: false, reason_codes: ['no_special_category'], document_ref: null } }
    expect(verify(env({ args: createArgs({ dpia }) }))).toMatchObject({ verdict: 'ok', args: { dpia } })
    expect(verify(env({ args: createArgs({ dpia: { publishing: dpia.votes } }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/dpia names publishing, which is not enabled/) })
    expect(verify(env({ args: createArgs({ dpia: { votes: { requires_dpia: 'no', reason_codes: [], document_ref: null } } }) }))).toMatchObject({
      verdict: 'refused',
      reason: expect.stringMatching(/dpia\.votes\.requires_dpia/),
    })
    expect(verify(env({ args: createArgs({ dpia: { votes: { requires_dpia: true, reason_codes: ['Bad Code'], document_ref: 'DSFA-1' } } }) }))).toMatchObject({
      verdict: 'refused',
      reason: expect.stringMatching(/dpia\.votes\.reason_codes/),
    })
  })
})

describe('verifyEnableLoaded', () => {
  it('names the modules init loaded no version for, and passes an empty list without asking', async () => {
    let asked = 0
    const unloaded = async (ids: readonly string[]) => {
      asked++
      return ids.filter((i) => i === 'calendar')
    }
    expect(await verifyEnableLoaded(['calendar', 'votes'], unloaded)).toMatch(/calendar/)
    expect(await verifyEnableLoaded(['votes'], unloaded)).toBeNull()
    expect(await verifyEnableLoaded([], unloaded)).toBeNull()
    expect(asked).toBe(2)
  })
})
