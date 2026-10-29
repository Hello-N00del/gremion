// TASK-043d-1 verify-r1 HIGH 1: the DPIA decision crosses THREE hands -- the
// panel's createArgs, request-verify (@gremion/provisioning verifyRequestArgs)
// and the tenant-provision --dpia-json parser + the library's own shape check
// (assertDpiaSpec). Each side was tested against its own idea of the format,
// so every panel create with a module ticked failed at the last hop. This test
// feeds the REAL output of each hop into the next.
import { describe, expect, it } from 'vitest'
import { assertDpiaSpec, verifyRequestArgs } from '@gremion/provisioning'
import { createArgs, validateNewCustomer, type NewCustomerInput } from '../../../../../../apps/control-panel/src/lib/server/requests'
import { parseDpiaMap } from '../../../../../scripts/tenant-provision-scratch'

const OP = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const ctx = { catalogueIds: ['board', 'calendar', 'votes', 'vault'], disabledIds: [] as string[] }
const form = (over: Partial<NewCustomerInput> = {}): NewCustomerInput => ({
  slug: 'proof-z',
  host: 'rat.proof.example',
  itAdmin: 'it@proof.example',
  councilAdmin: 'rat@proof.example',
  bodyName: '',
  brandProduct: 'Rat',
  brandOrgShort: 'MS',
  enable: ['calendar', 'votes'],
  dpia: { calendar: { requiresDpia: true, documentRef: 'TOM-1' }, votes: { requiresDpia: false, documentRef: 'TOM-2' } },
  ...over,
})
const verify = (i: NewCustomerInput) =>
  verifyRequestArgs({ kind: 'create', customerSlug: i.slug, args: createArgs(i), operatorId: OP }, ctx)

describe('panel -> request-verify -> --dpia-json -> library: one DPIA wire format', () => {
  it('a panel create with modules ticked is accepted by every hop', () => {
    const v = verify(form())
    expect(v.verdict).toBe('ok')
    if (v.verdict !== 'ok') return
    // a create request carries the DPIA map; the import / seed kinds do not (the union is narrowed here)
    if (!('dpia' in v.args)) throw new Error('a create request must carry dpia')
    // exactly what create.sh writes to the --dpia-json file: `jq -c .dpia`
    const parsed = parseDpiaMap(JSON.stringify(v.args.dpia))
    expect(Object.keys(parsed).sort()).toEqual(['calendar', 'votes'])
    for (const [moduleKey, spec] of Object.entries(parsed)) expect(() => assertDpiaSpec(moduleKey, spec, OP)).not.toThrow()
    expect(parsed.calendar).toMatchObject({ requiresDpia: 'yes', documentRef: 'TOM-1' })
    expect(parsed.votes).toMatchObject({ requiresDpia: 'no', documentRef: 'TOM-2' })
  })

  it('a ticked module without a document reference is refused by request-verify (no placeholder is invented)', () => {
    const v = verify(form({ dpia: { calendar: { requiresDpia: true, documentRef: '' }, votes: { requiresDpia: false, documentRef: 'TOM-2' } } }))
    expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/dpia\.calendar\.document_ref/) })
  })

  it('the form refuses the same case before it is ever submitted', () => {
    const e = validateNewCustomer(form({ dpia: { calendar: { requiresDpia: true, documentRef: '' }, votes: { requiresDpia: false, documentRef: 'TOM-2' } } }))
    expect(e.dpia).toMatch(/calendar/)
    expect(validateNewCustomer(form())).toEqual({})
  })
})
