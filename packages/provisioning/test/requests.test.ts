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
  it('every kind of the DB CHECK is known; create + the TASK-031 kinds have a handler; reserved kinds name their owner', () => {
    expect([...REQUEST_KINDS].sort()).toEqual(
      ['create', 'disable_module', 'enable_module', 'import_isolation', 'import_members', 'reconcile', 'record_dpia', 'resume', 'seed_vertical', 'suspend'].sort(),
    )
    expect([...HANDLED_KINDS]).toEqual(['create', 'suspend', 'resume', 'import_members', 'seed_vertical'])
    expect(KIND_OWNER.import_members).toBe('TASK-031')
    expect(KIND_OWNER.seed_vertical).toBe('TASK-031')
    expect(KIND_OWNER.record_dpia).toBe('TASK-044')
    expect(KIND_OWNER.import_isolation).toBe('TASK-044')
  })

  it.each([
    ['record_dpia', 'no handler (TASK-044)'],
    ['import_isolation', 'no handler (TASK-044)'],
    ['reconcile', 'no handler (TASK-043d-2)'],
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
    const dpia = { votes: { requires_dpia: false, reason_codes: ['no_special_category'], document_ref: 'TOM-3' } }
    // translated ONCE, here, to the library's DpiaSpec (what --dpia-json carries)
    expect(verify(env({ args: createArgs({ dpia }) }))).toMatchObject({
      verdict: 'ok',
      args: { dpia: { votes: { requiresDpia: 'no', reasonCodes: ['no_special_category'], documentRef: 'TOM-3' } } },
    })
    expect(verify(env({ args: createArgs({ dpia: { votes: { ...dpia.votes, requires_dpia: true } } }) }))).toMatchObject({ verdict: 'ok', args: { dpia: { votes: { requiresDpia: 'yes' } } } })
    expect(verify(env({ args: createArgs({ dpia: { votes: { ...dpia.votes, document_ref: null } } }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/dpia\.votes\.document_ref is required/) })
    expect(verify(env({ args: createArgs({ dpia: { votes: { ...dpia.votes, reason_codes: [] } } }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/dpia\.votes\.reason_codes/) })
    expect(verify(env({ args: createArgs({ dpia: { publishing: dpia.votes } }) }))).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/dpia names publishing, which is not enabled/) })
    expect(verify(env({ args: createArgs({ dpia: { votes: { requires_dpia: 'no', reason_codes: ['x_y'], document_ref: 'TOM-3' } } }) }))).toMatchObject({
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

// TASK-031: the member import and the vertical seed are request kinds. The
// list rides in the request (platform 0010 raises its cap and purges it on
// any final state); the container reads it from STDIN.
describe('import_members args (TASK-031)', () => {
  const SHA = 'a'.repeat(64)
  const imp = (args: Record<string, unknown>) => verify(env({ kind: 'import_members', args }))
  const validate = { slug: 'musterstadt', phase: 'validate', vertical: 'demo', csv: 'name,email,body\nA B,a@x.example,Rat\n' }

  it('a validate is accepted and normalised', () => {
    expect(imp(validate)).toEqual({ verdict: 'ok', args: validate })
  })
  it('an apply must name the validated sha256; a validate must not carry one', () => {
    expect(imp({ ...validate, phase: 'apply' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/names the sha256/) })
    expect(imp({ ...validate, phase: 'apply', expectSha256: 'XYZ' })).toMatchObject({ verdict: 'refused' })
    expect(imp({ ...validate, phase: 'apply', expectSha256: SHA })).toEqual({ verdict: 'ok', args: { ...validate, phase: 'apply', expectSha256: SHA } })
    expect(imp({ ...validate, expectSha256: SHA })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/validate carries no expectSha256/) })
  })
  it('refuses another customer, an unknown field, a path-like vertical, an empty or oversized list', () => {
    expect(imp({ ...validate, slug: 'other' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not the request's slug/) })
    expect(imp({ ...validate, members: [] })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field members/) })
    expect(imp({ ...validate, vertical: '../x' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/vertical id/) })
    expect(imp({ ...validate, csv: '  ' })).toMatchObject({ verdict: 'refused' })
    expect(imp({ ...validate, csv: 'x'.repeat(1_048_577) })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/exceeds/) })
    expect(imp({ ...validate, phase: 'wipe' })).toMatchObject({ verdict: 'refused' })
  })
})

describe('seed_vertical args (TASK-031)', () => {
  const seed = (args: Record<string, unknown>) => verify(env({ kind: 'seed_vertical', args }))
  it('accepts a vertical id for the request customer only', () => {
    expect(seed({ slug: 'musterstadt', vertical: 'demo' })).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', vertical: 'demo' } })
    expect(seed({ slug: 'other', vertical: 'demo' })).toMatchObject({ verdict: 'refused' })
    expect(seed({ slug: 'musterstadt', vertical: 'Demo!' })).toMatchObject({ verdict: 'refused' })
    expect(seed({ slug: 'musterstadt', vertical: 'demo', force: true })).toMatchObject({ verdict: 'refused' })
  })
})

describe('suspend and resume args (TRD-044)', () => {
  it.each(['suspend', 'resume'])('%s: the request customer only, nothing else', (kind) => {
    const v = (args: unknown, slug = 'musterstadt') => verify(env({ kind, customerSlug: slug, args }))
    expect(v({ slug: 'musterstadt' })).toEqual({ verdict: 'ok', args: { slug: 'musterstadt' } })
    expect(v({ slug: 'other' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not the request's slug/) })
    expect(v({})).toMatchObject({ verdict: 'refused' })
    expect(v(null)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/must be an object/) })
    expect(v([])).toMatchObject({ verdict: 'refused' })
    expect(v({ slug: 'musterstadt', wipe: true })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field wipe/) })
  })
  it('KIND_OWNER names TRD-044', () => {
    expect(KIND_OWNER.suspend).toBe('TRD-044')
    expect(KIND_OWNER.resume).toBe('TRD-044')
  })
})
