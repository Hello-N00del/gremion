// TASK-043d-1 TDD 7: the request-kind registry and the per-kind args checks
// the container's request-verify runs before the executor runs anything. The
// create args reuse validateCreate (slug, host, the two administrators, the
// enable list against the catalogue and the deny set); a kind without a
// handler is refused naming its owner; args.slug must be the request's slug.
import { describe, expect, it } from 'vitest'
import { HANDLED_KINDS, KIND_OWNER, REQUEST_KINDS, modulesToEnable, verifyRequestArgs, verifyEnableLoaded, type RequestEnvelope } from '../src/index.ts'

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
    expect([...HANDLED_KINDS].sort()).toEqual(['create', 'disable_module', 'enable_module', 'import_members', 'reconcile', 'record_dpia', 'resume', 'seed_vertical', 'suspend'].sort())
    expect(KIND_OWNER.import_members).toBe('TASK-031')
    expect(KIND_OWNER.seed_vertical).toBe('TASK-031')
        expect(KIND_OWNER.import_isolation).toBe('TASK-044')
  })

  it.each([
    ['import_isolation', 'no handler (TASK-044)'],
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

// TRD-044 remainder: the module and reconcile kinds.
describe('enable_module / disable_module / record_dpia / reconcile args (TRD-044)', () => {
  const v = (kind: string, args: unknown, slug = 'musterstadt') => verify(env({ kind, customerSlug: slug, args }))
  const dpia = { requires_dpia: false, reason_codes: ['operator_decision'], document_ref: 'TOM-3' }

  it('enable_module: slug + module, the DPIA decision optional (recorded or carried), normalised to the library DpiaSpec', () => {
    expect(v('enable_module', { slug: 'musterstadt', module: 'votes' })).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', module: 'votes', dpia: null } })
    expect(v('enable_module', { slug: 'musterstadt', module: 'votes', dpia })).toEqual({
      verdict: 'ok',
      args: { slug: 'musterstadt', module: 'votes', dpia: { requiresDpia: 'no', reasonCodes: ['operator_decision'], documentRef: 'TOM-3' } },
    })
    expect(v('enable_module', { slug: 'musterstadt', module: 'votes', dpia: { ...dpia, document_ref: '  ' } })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/document_ref is required/) })
    expect(v('enable_module', { slug: 'musterstadt', module: 'votes', dpia: { ...dpia, requires_dpia: 'yes' } })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/requires_dpia/) })
  })

  it.each(['enable_module', 'disable_module'])('%s: the module must be in the catalogue, not in disabled.json, and enable not on the deny list', (kind) => {
    expect(v(kind, { slug: 'musterstadt', module: 'nosuchmodule' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not in the catalogue/) })
    if (kind === 'enable_module') {
      expect(v(kind, { slug: 'musterstadt', module: 'finance' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/finance is disabled in this build \(modules\/disabled\.json\)/) })
    }
    expect(v(kind, { slug: 'musterstadt', module: 'Votes' })).toMatchObject({ verdict: 'refused' })
    expect(v(kind, { slug: 'musterstadt' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/module/) })
    expect(v(kind, { slug: 'other', module: 'votes' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not the request's slug/) })
    expect(v(kind, { slug: 'musterstadt', module: 'votes', force: true })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field force/) })
    expect(v(kind, null)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/must be an object/) })
  })

  it('disable_module and record_dpia accept a module that modules/disabled.json now lists (a build that stops shipping a module must still export and drop it); enable_module does not', () => {
    expect(v('disable_module', { slug: 'musterstadt', module: 'finance' })).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', module: 'finance' } })
    expect(v('record_dpia', { slug: 'musterstadt', module: 'finance', requiresDpia: true, documentRef: 'TOM-3' })).toMatchObject({ verdict: 'ok' })
    expect(v('enable_module', { slug: 'musterstadt', module: 'finance' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/disabled in this build/) })
    // the catalogue still bounds the id
    expect(v('disable_module', { slug: 'musterstadt', module: 'nosuchmodule' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not in the catalogue/) })
  })

  it('enable_module refuses board and vault by name; disable_module carries no dpia', () => {
    expect(v('enable_module', { slug: 'musterstadt', module: 'board' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/board cannot be enabled/) })
    expect(v('disable_module', { slug: 'musterstadt', module: 'votes' })).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', module: 'votes' } })
    expect(v('disable_module', { slug: 'musterstadt', module: 'votes', dpia })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field dpia/) })
  })

  it('record_dpia: an explicit boolean and a document reference are both required', () => {
    const ok = { slug: 'musterstadt', module: 'votes', requiresDpia: true, documentRef: 'TOM-9' }
    expect(v('record_dpia', ok)).toEqual({
      verdict: 'ok',
      args: { slug: 'musterstadt', module: 'votes', requiresDpia: 'yes', reasonCodes: ['operator_decision'], documentRef: 'TOM-9' },
    })
    expect(v('record_dpia', { ...ok, requiresDpia: false })).toMatchObject({ verdict: 'ok', args: { requiresDpia: 'no' } })
    expect(v('record_dpia', { ...ok, requiresDpia: undefined })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/requiresDpia must be true or false/) })
    expect(v('record_dpia', { ...ok, requiresDpia: 'yes' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/requiresDpia/) })
    expect(v('record_dpia', { ...ok, documentRef: '' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/documentRef/) })
    expect(v('record_dpia', { ...ok, documentRef: undefined })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/documentRef/) })
    expect(v('record_dpia', { ...ok, documentRef: 'x'.repeat(501) })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/documentRef/) })
    expect(v('record_dpia', { ...ok, documentRef: 'a\u0000b' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/documentRef/) })
    expect(v('record_dpia', { ...ok, documentRef: '--operator x' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/documentRef must not start with a dash/) })
    expect(v('record_dpia', { ...ok, module: 'nosuchmodule' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not in the catalogue/) })
    expect(v('record_dpia', { ...ok, reasonCodes: ['x'] })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field reasonCodes/) })
  })

  it('reconcile: slug + a strict boolean apply', () => {
    expect(v('reconcile', { slug: 'musterstadt', apply: false })).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', apply: false } })
    expect(v('reconcile', { slug: 'musterstadt', apply: true })).toEqual({ verdict: 'ok', args: { slug: 'musterstadt', apply: true } })
    expect(v('reconcile', { slug: 'musterstadt' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/apply must be true or false/) })
    expect(v('reconcile', { slug: 'musterstadt', apply: 'true' })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/apply must be true or false/) })
    expect(v('reconcile', { slug: 'musterstadt', apply: true, all: true })).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/unknown field all/) })
    expect(v('reconcile', { slug: 'other', apply: true })).toMatchObject({ verdict: 'refused' })
  })

  it('modulesToEnable names the module an enable_module (and a create) will enable, for the loaded-version check', () => {
    const a = v('enable_module', { slug: 'musterstadt', module: 'votes' })
    if (a.verdict !== 'ok') throw new Error('x')
    expect(modulesToEnable(a.args)).toEqual(['votes'])
    const d = v('disable_module', { slug: 'musterstadt', module: 'votes' })
    if (d.verdict !== 'ok') throw new Error('x')
    expect(modulesToEnable(d.args)).toEqual([])
  })
})
