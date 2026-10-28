// "Neuer Mandant" as a request (TASK-043d D2/D7/D8, A3/A4 at unit level):
// validation, the normalised args, the single submit call, the refusal map.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createArgs, DENY_REASONS, PRINTABLE, RESERVED_SLUGS, submitCreate, submitRefusal, SubmitRefused, validateNewCustomer, type Evidence, type NewCustomerInput } from './requests'

const OP = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
const KEY = '0192f0c4-0000-7000-8000-00000000000a'
const GOOD: NewCustomerInput = {
  slug: 'proof-z',
  host: 'Rat.Proof.Example',
  itAdmin: 'IT@Proof.Example',
  councilAdmin: 'rat@proof.example',
  bodyName: 'Stadtrat',
  brandProduct: 'Rat',
  brandOrgShort: 'MS',
  enable: ['votes', 'calendar', 'votes'],
  dpia: { votes: { requiresDpia: false, documentRef: 'TOM-2' }, calendar: { requiresDpia: true, documentRef: 'TOM-1' } },
}
const EVIDENCE: Evidence = { token: 'x'.repeat(120), acr: 'loa2', authTime: new Date('2026-10-21T10:00:00Z'), sessionAt: new Date('2026-10-21T10:00:01Z') }

describe('the panel deny set is the gate deny set (no second list that can drift)', () => {
  it("names exactly the modules in @gremion/provisioning's DENY_REASONS (read from its source, the panel image has no such dependency)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/provisioning/src/operator-gate.ts'), 'utf8')
    const block = /DENY_REASONS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(src)?.[1] ?? ''
    const gate = [...block.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!).sort()
    expect(gate.length).toBeGreaterThan(0)
    expect(Object.keys(DENY_REASONS).sort()).toEqual(gate)
  })
})

describe('validateNewCustomer', () => {
  it('a good form has no errors; no module is required (code default: none ticked)', () => {
    expect(validateNewCustomer(GOOD)).toEqual({})
    expect(validateNewCustomer({ ...GOOD, enable: [], dpia: {} })).toEqual({})
  })
  it('board and vault are refused BY NAME with their reason', () => {
    expect(validateNewCustomer({ ...GOOD, enable: ['board'] }).enable).toMatch(/board/)
    expect(validateNewCustomer({ ...GOOD, enable: ['calendar', 'vault'] }).enable).toMatch(/vault/)
  })
  it('a ticked module without a document reference is a dpia field error (panel-level)', () => {
    const blank = validateNewCustomer({ ...GOOD, enable: ['calendar'], dpia: { calendar: { requiresDpia: false, documentRef: '   ' } } })
    expect(blank.dpia).toMatch(/calendar/)
    const absent = validateNewCustomer({ ...GOOD, enable: ['calendar', 'votes'], dpia: { votes: { requiresDpia: false, documentRef: 'TOM-2' } } })
    expect(absent.dpia).toMatch(/calendar/)
    expect(absent.dpia).not.toMatch(/votes/)
  })
  it('the document reference is capped at 500 characters, like request-verify', () => {
    const at = validateNewCustomer({ ...GOOD, enable: ['calendar'], dpia: { calendar: { requiresDpia: false, documentRef: 'x'.repeat(500) } } })
    expect(at).toEqual({})
    const over = validateNewCustomer({ ...GOOD, enable: ['calendar'], dpia: { calendar: { requiresDpia: false, documentRef: 'x'.repeat(501) } } })
    expect(over.dpia).toMatch(/500/)
  })
  it('H1: the panel text rule is the provisioning text rule (same pattern, same verdict on one corpus; the panel image has no such dependency)', async () => {
    const { isPrintableText, PRINTABLE_TEXT } = await import('../../../../../packages/provisioning/src/printable-text')
    expect(PRINTABLE.source).toBe(PRINTABLE_TEXT.source)
    const corpus = [
      'Rat', 'Stadtrat Süd', 'a'.repeat(80), 'a'.repeat(81), '', '   ', 'a\u0000b', 'a\nb', 'a\tb', 'a\u007fb', 'a\u001fb', 'emoji \u{1F600}',
      'a\u0085b', 'a\u0080b', 'a\u009fb', 'a\u202eb', 'a\u202ab', 'a\u2066b', 'a\u2069b', 'a\u2028b', 'a\u2029b', 'a\ud800b', 'a\udfffb', 'a\ud83dz',
    ]
    for (const v of corpus) {
      const panel = validateNewCustomer({ ...GOOD, brandProduct: v }).brandProduct === undefined
      expect(panel, JSON.stringify(v)).toBe(isPrintableText(v, 80))
    }
    for (const v of ['a\u0085b', 'a\u202eb', 'a\u2028b', 'a\ud800b']) expect(isPrintableText(v, 80), JSON.stringify(v)).toBe(false)
  })
  it('HIGH-2: the reserved slugs are the provisioning list (equal sets, read from its source), refused with German text', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/provisioning/src/slug.ts'), 'utf8')
    const block = /RESERVED_SLUGS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? ''
    const gate = [...block.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]!)
    expect(gate.length).toBeGreaterThan(0)
    expect([...RESERVED_SLUGS].sort()).toEqual([...gate].sort())
    for (const slug of gate) expect(validateNewCustomer({ ...GOOD, slug }).slug, slug).toMatch(/reserviert/)
  })
  it('MED-2: with a known-module list, an id outside it is an enable error', () => {
    expect(validateNewCustomer({ ...GOOD, enable: ['calendar'], dpia: GOOD.dpia }, DENY_REASONS, ['calendar', 'votes'])).toEqual({})
    expect(validateNewCustomer({ ...GOOD, enable: ['ghost'], dpia: { ghost: { requiresDpia: false, documentRef: 'x' } } }, DENY_REASONS, ['calendar']).enable).toMatch(/ghost/)
  })
  it('LOW-1: the non-ASCII host check sees the raw value (Kelvin sign U+212A lower-cases to k)', () => {
    expect(validateNewCustomer({ ...GOOD, host: 'rat.\u212Aeller.de' }).host).toMatch(/ASCII/)
  })
  it('H1: control characters in bodyName, brandProduct and brandOrgShort are field errors', () => {
    const e = validateNewCustomer({ ...GOOD, bodyName: 'a\u0000b', brandProduct: 'a\nb', brandOrgShort: 'a\u007f' })
    expect(Object.keys(e).sort()).toEqual(['bodyName', 'brandOrgShort', 'brandProduct'])
  })
  it('H1: a non-ASCII host gets its own German message (no punycode in the pilot)', () => {
    expect(validateNewCustomer({ ...GOOD, host: 'rät.müller.de' }).host).toMatch(/ASCII/)
    expect(validateNewCustomer({ ...GOOD, host: 'xn--rt-pka.example' }).host).toBeUndefined()
  })
  it('H2: every enabled module needs an explicit yes/no (null/absent is an error), yes needs a reference', () => {
    const base = { ...GOOD, enable: ['calendar'] }
    expect(validateNewCustomer({ ...base, dpia: { calendar: { requiresDpia: null, documentRef: 'TOM-1' } } }).dpia).toMatch(/calendar/)
    expect(validateNewCustomer({ ...base, dpia: {} }).dpia).toMatch(/calendar/)
    expect(validateNewCustomer({ ...base, dpia: { calendar: { requiresDpia: true, documentRef: '' } } }).dpia).toMatch(/calendar/)
    expect(validateNewCustomer({ ...base, dpia: { calendar: { requiresDpia: false, documentRef: 'TOM-1' } } })).toEqual({})
    expect(validateNewCustomer({ ...base, dpia: { calendar: { requiresDpia: true, documentRef: 'TOM-1' } } })).toEqual({})
  })
  it('bad slug, platform, host, admins, brand are field errors', () => {
    const e = validateNewCustomer({ ...GOOD, slug: 'platform', host: 'nohost', itAdmin: 'x', councilAdmin: 'y', brandProduct: '', brandOrgShort: 'x'.repeat(21) })
    expect(Object.keys(e).sort()).toEqual(['brandOrgShort', 'brandProduct', 'councilAdmin', 'host', 'itAdmin', 'slug'])
  })
})

describe('createArgs: the args request-verify accepts', () => {
  it('lower-cases the identities, sorts and dedupes the modules, carries brand and the DPIA decisions, and no host path', () => {
    const a = createArgs(GOOD)
    expect(a).toEqual({
      slug: 'proof-z',
      host: 'rat.proof.example',
      itAdmin: 'it@proof.example',
      councilAdmin: 'rat@proof.example',
      bodyName: 'Stadtrat',
      brand: { product: 'Rat', orgShort: 'MS' },
      enable: ['calendar', 'votes'],
      dpia: {
        calendar: { requires_dpia: true, reason_codes: ['operator_decision'], document_ref: 'TOM-1' },
        votes: { requires_dpia: false, reason_codes: ['operator_decision'], document_ref: 'TOM-2' },
      },
    })
    expect(JSON.stringify(a)).not.toMatch(/configFile|\/opt\/|tenant-config/)
  })
  it('with no module ticked: enable [] and dpia {} (the module-OFF default)', () => {
    const a = createArgs({ ...GOOD, enable: [], dpia: {}, bodyName: '' })
    expect(a.enable).toEqual([])
    expect(a.dpia).toEqual({})
    expect('bodyName' in a).toBe(false)
  })
})

/** A recording stand-in for the postgres tagged template: returns the query's values. */
function fakeSql(result: unknown, fail?: unknown) {
  const calls: { text: string; values: unknown[] }[] = []
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values })
      return fail ? Promise.reject(fail) : Promise.resolve(result)
    },
    { json: (v: unknown) => ({ json: v }) },
  )
  return { sql: sql as never, calls }
}

describe('submitCreate (A3/A4 at unit level): ONE call of plt.submit_provisioning_request, as the panel role', () => {
  it('passes kind create, the slug, the normalised args, the form key, the operator and the evidence; no reason, no host actor', async () => {
    const f = fakeSql([{ id: 'req-1' }])
    await expect(submitCreate(f.sql, GOOD, OP, KEY, EVIDENCE)).resolves.toBe('req-1')
    expect(f.calls).toHaveLength(1)
    const c = f.calls[0]!
    expect(c.text).toContain('plt.submit_provisioning_request(')
    expect(c.text).not.toMatch(/INSERT|UPDATE|DELETE/i)
    expect(c.values).toContain('proof-z')
    expect(c.values).toContain(KEY)
    expect(c.values).toContain(OP)
    expect(c.values).toContain('loa2')
    expect(c.values).toContain(EVIDENCE.token)
    expect((c.values.find((v) => (v as { json?: unknown })?.json) as { json: unknown }).json).toEqual(createArgs(GOOD))
  })
  it('TRD-092: the same statement writes the vendor-access record (oac.record_access) with who, what and why', async () => {
    const f = fakeSql([{ id: 'req-1' }])
    await submitCreate(f.sql, GOOD, OP, KEY, EVIDENCE)
    expect(f.calls).toHaveLength(1)
    const c = f.calls[0]!
    expect(c.text).toContain('oac.record_access(')
    expect(c.values).toContain('panel_request')
    expect(c.values.filter((v) => v === OP)).toHaveLength(2) // the request's operator and the record's actor
    expect(c.values.some((v) => typeof v === 'string' && v.includes('Mandant anlegen für proof-z'))).toBe(true)
    // the signed evidence token is in the request only, never in the record's words
    expect(c.values.filter((v) => typeof v === 'string' && v.includes(EVIDENCE.token))).toHaveLength(1)
  })
  it('a non-uuid operator or key never reaches the database', async () => {
    const f = fakeSql([{ id: 'x' }])
    await expect(submitCreate(f.sql, GOOD, 'not-a-uuid', KEY, EVIDENCE)).rejects.toBeInstanceOf(SubmitRefused)
    await expect(submitCreate(f.sql, GOOD, OP, 'nope', EVIDENCE)).rejects.toBeInstanceOf(SubmitRefused)
    expect(f.calls).toHaveLength(0)
  })
  it('a database refusal becomes a German message with the right status', async () => {
    for (const [code, status] of [['28000', 403], ['42501', 403], ['23505', 409], ['22023', 400], ['XX000', 503]] as const) {
      const f = fakeSql(null, Object.assign(new Error('db'), { code }))
      const err = await submitCreate(f.sql, GOOD, OP, KEY, EVIDENCE).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SubmitRefused)
      expect((err as SubmitRefused).status).toBe(status)
    }
    expect(submitRefusal(null).status).toBe(503)
  })
})
