// TASK-080-a step b/d: the typed event catalogue is the single source of
// asyncapi/idt.json (the file equals the rendering), every payload the
// catalogue allows validates against its schema in the file, and the subject
// is the IDT stream's filter.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { IDT_EVENTS, eventTypeOf, renderAsyncApi, subjectOfType, type FieldType, type IdtEventKey } from '../../src/outbox/catalogue.ts'

const FILE = fileURLToPath(new URL('../../asyncapi/idt.json', import.meta.url))
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as ReturnType<typeof renderAsyncApi> & { components: { schemas: Record<string, object> } }
const U = '0198a5a0-0000-7000-8000-000000000001'
const sample: Record<FieldType, unknown> = { uuid: U, 'uuid?': null, string: 'x', boolean: true, 'date-time': '2026-10-29T10:00:00Z', date: '2026-10-29', 'date?': null, strings: ['voting'] }

describe('the IDT event catalogue', () => {
  it('asyncapi/idt.json is exactly the rendering of the catalogue (no hand edit survives)', () => {
    expect(doc).toEqual(renderAsyncApi())
  })

  it('every catalogue event has one channel, one operation, one message and one closed payload schema', () => {
    const keys = Object.keys(IDT_EVENTS)
    expect(keys.length).toBe(20)
    expect(Object.keys(doc.channels as object)).toHaveLength(keys.length)
    expect(Object.keys(doc.operations as object)).toHaveLength(keys.length)
    for (const s of Object.values(doc.components.schemas) as Array<{ additionalProperties: boolean; required: string[]; properties: object }>) {
      expect(s.additionalProperties).toBe(false)
      expect(s.required).toEqual(Object.keys(s.properties))
      expect(s.required.at(-1)).toBe('aggregate_version')
    }
  })

  it('a payload built from the catalogue validates, and an unknown, a missing or a wrongly typed field does not', () => {
    const ajv = new Ajv({ strict: false, allErrors: true })
    addFormats.default(ajv)
    for (const key of Object.keys(IDT_EVENTS) as IdtEventKey[]) {
      const spec = IDT_EVENTS[key]
      const payload: Record<string, unknown> = { aggregate_version: 1 }
      for (const [f, t] of Object.entries(spec.fields)) payload[f] = sample[t]
      const schemaName = `${key.split('.').map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join('')}`
      const schema = doc.components.schemas[`${schemaName.charAt(0).toUpperCase()}${schemaName.slice(1)}Payload`]
      expect(schema, key).toBeDefined()
      const validate = ajv.compile(schema)
      expect(validate(payload), `${key}: ${JSON.stringify(validate.errors)}`).toBe(true)
      expect(validate({ ...payload, display_name: 'Jane' })).toBe(false)
      const first = Object.keys(spec.fields)[0]!
      const { [first]: _drop, ...missing } = payload
      expect(validate(missing)).toBe(false)
      expect(validate({ ...payload, aggregate_version: 0 })).toBe(false)
    }
  })

  it('no payload names a person: no display_name, e-mail, idp_subject or pseudonym field (TRD-154)', () => {
    for (const spec of Object.values(IDT_EVENTS)) for (const f of Object.keys(spec.fields)) expect(f).not.toMatch(/name|email|subject|pseudonym/)
  })

  it('the CloudEvents type and the NATS subject follow DOMAIN s.1, inside the IDT stream filter gremion.*.idt.>', () => {
    expect(eventTypeOf('seat.created')).toBe('de.gremion.idt.seat.created.v1')
    expect(subjectOfType(U, eventTypeOf('tenure.ended'))).toBe(`gremion.${U}.idt.tenure.ended`)
    expect(() => subjectOfType(U, 'de.gremion.gov.motion.created.v1')).toThrow(/not an idt event type/)
    expect(() => subjectOfType(U, 'de.gremion.idt.a.b.c.v1')).toThrow(/not an idt event type/)
  })
})
