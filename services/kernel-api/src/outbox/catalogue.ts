// services/kernel-api/src/outbox/catalogue.ts -- the typed catalogue of the
// identity (IDT) events the kernel API emits (TASK-080-a, DOMAIN s.1 :758-784).
//
// ONE source: asyncapi/idt.json is RENDERED from this table (renderAsyncApi) and
// a test holds the file equal to the rendering; the domain service can only
// emit a key of this table, with exactly the fields it names, so a payload the
// spec does not describe is not expressible (test/outbox/catalogue.test.ts also
// validates every emitted payload with ajv).
//
// Payloads carry ids and minimal data only (TRD-154): no name, no e-mail.
// aggregate_version is added to every payload by enqueue().

export type FieldType = 'uuid' | 'uuid?' | 'string' | 'boolean' | 'date-time' | 'date' | 'date?' | 'strings'

export interface EventSpec {
  aggregate: string
  event: string
  fields: Readonly<Record<string, FieldType>>
}

const def = <const F extends Record<string, FieldType>>(aggregate: string, event: string, fields: F): EventSpec & { fields: F } => ({ aggregate, event, fields })

export const IDT_EVENTS = {
  'person.invited': def('person', 'invited', { person_id: 'uuid', customer_id: 'uuid' }),
  'person.activated': def('person', 'activated', { person_id: 'uuid', activated_at: 'date-time' }),
  'person.disabled': def('person', 'disabled', { person_id: 'uuid', disabled_at: 'date-time' }),
  'person.enabled': def('person', 'enabled', { person_id: 'uuid' }),
  'body.created': def('body', 'created', { body_id: 'uuid', kind_key: 'string', parent_body_id: 'uuid?' }),
  'body.updated': def('body', 'updated', { body_id: 'uuid', kind_key: 'string', parent_body_id: 'uuid?' }),
  'body.archived': def('body', 'archived', { body_id: 'uuid', archived_at: 'date-time' }),
  'orgunit.created': def('orgunit', 'created', { org_unit_id: 'uuid', body_id: 'uuid', parent_org_unit_id: 'uuid?', kind_key: 'string', is_organ: 'boolean' }),
  'orgunit.updated': def('orgunit', 'updated', { org_unit_id: 'uuid', body_id: 'uuid', kind_key: 'string' }),
  'orgunit.archived': def('orgunit', 'archived', { org_unit_id: 'uuid', body_id: 'uuid' }),
  'seat.created': def('seat', 'created', { seat_id: 'uuid', body_id: 'uuid', org_unit_id: 'uuid?', seat_kind: 'string', fill_mode: 'string', voting: 'boolean' }),
  'seat.retired': def('seat', 'retired', { seat_id: 'uuid', body_id: 'uuid' }),
  'membership.started': def('membership', 'started', { membership_id: 'uuid', body_id: 'uuid', org_unit_id: 'uuid?', person_id: 'uuid', participation_kind: 'string', voting: 'boolean', valid_from: 'date' }),
  'membership.corrected': def('membership', 'corrected', { membership_id: 'uuid', changed: 'strings', valid_from: 'date', valid_until: 'date?', voting: 'boolean' }),
  'membership.ended': def('membership', 'ended', { membership_id: 'uuid', body_id: 'uuid', person_id: 'uuid', valid_until: 'date', end_reason: 'string' }),
  'tenure.started': def('tenure', 'started', { tenure_id: 'uuid', seat_id: 'uuid', seat_kind: 'string', body_id: 'uuid', person_id: 'uuid', starts_on: 'date', source: 'string', mandate_beschluss_ref: 'uuid?' }),
  'tenure.corrected': def('tenure', 'corrected', { tenure_id: 'uuid', seat_kind: 'string', changed: 'strings', starts_on: 'date', ended_on: 'date?' }),
  'tenure.ended': def('tenure', 'ended', { tenure_id: 'uuid', seat_id: 'uuid', seat_kind: 'string', body_id: 'uuid', person_id: 'uuid', ended_on: 'date', end_reason: 'string' }),
  'wahlperiode.created': def('wahlperiode', 'created', { wahlperiode_id: 'uuid', body_id: 'uuid', org_unit_id: 'uuid?', starts_on: 'date', ends_on: 'date' }),
  'wahlperiode.closed': def('wahlperiode', 'closed', { wahlperiode_id: 'uuid', body_id: 'uuid' }),
} as const

export type IdtEventKey = keyof typeof IDT_EVENTS

type TsOf<T extends FieldType> = T extends 'boolean' ? boolean : T extends 'strings' ? string[] : T extends `${string}?` ? string | null : string

/** The payload an event of `K` carries (aggregate_version is added by enqueue). */
export type IdtPayload<K extends IdtEventKey> = { -readonly [F in keyof (typeof IDT_EVENTS)[K]['fields']]: TsOf<(typeof IDT_EVENTS)[K]['fields'][F]> }

export const IDT_SOURCE = '/gremion/idt'
export const eventTypeOf = (key: IdtEventKey): string => `de.gremion.idt.${key}.v1`

/** gremion.<customer>.idt.<aggregate>.<event> from the CloudEvents type de.gremion.idt.<aggregate>.<event>.v1. */
export function subjectOfType(customerId: string, eventType: string): string {
  const m = /^de\.gremion\.idt\.([a-z]+)\.([a-z]+)\.v1$/.exec(eventType)
  if (!m) throw new Error(`not an idt event type: ${JSON.stringify(eventType)}`)
  return `gremion.${customerId}.idt.${m[1]}.${m[2]}`
}

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const camel = (aggregate: string, event: string): string => `${aggregate}${pascal(event)}`

function schemaOf(t: FieldType): Record<string, unknown> {
  switch (t) {
    case 'uuid': return { type: 'string', format: 'uuid' }
    case 'uuid?': return { oneOf: [{ type: 'null' }, { type: 'string', format: 'uuid' }] }
    case 'string': return { type: 'string' }
    case 'boolean': return { type: 'boolean' }
    case 'date-time': return { type: 'string', format: 'date-time' }
    case 'date': return { type: 'string', format: 'date' }
    case 'date?': return { oneOf: [{ type: 'null' }, { type: 'string', format: 'date' }] }
    case 'strings': return { type: 'array', items: { type: 'string' } }
  }
}

export const ASYNCAPI_INFO = {
  title: 'Gremion kernel API: identity events (IDT)',
  version: '1.0.0',
  description:
    'TASK-080-a. Events of the kernel API (bodies, org units, seats, wahlperioden, persons, memberships, tenures), written through enqueue(tx) into idt.outbox in the same transaction as the state change and relayed to the IDT stream. Subject: gremion.{tenantId}.idt.<aggregate>.<event>; CloudEvents type de.gremion.idt.<aggregate>.<event>.v1 (DOMAIN s.1). Payloads carry ids and minimal data only (TRD-154); aggregate_version is added to every payload by enqueue. Published ONLY by the nats-auth identity kernel-api. grant.*, branding.*, importjob.*, customersetting.*, person.profilechanged/erased, tenure.release-changed and wahlperiode.corrected are later tasks (081, 130, ops chain) and are not declared here.',
}

/** The AsyncAPI 3.0 document of the catalogue (asyncapi/idt.json is this, serialised). */
export function renderAsyncApi(): Record<string, unknown> {
  const channels: Record<string, unknown> = {}
  const operations: Record<string, unknown> = {}
  const messages: Record<string, unknown> = {}
  const schemas: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(IDT_EVENTS) as [IdtEventKey, EventSpec][]) {
    const ch = camel(spec.aggregate, spec.event)
    const msg = `${pascal(ch)}Event`
    const payload = `${pascal(ch)}Payload`
    const type = eventTypeOf(key)
    channels[ch] = {
      address: `gremion.{tenantId}.idt.${spec.aggregate}.${spec.event}`,
      description: type,
      parameters: { tenantId: { description: 'Customer UUID.' } },
      messages: { [`${ch}Event`]: { $ref: `#/components/messages/${msg}` } },
    }
    operations[`publish${pascal(ch)}`] = {
      action: 'send',
      channel: { $ref: `#/channels/${ch}` },
      summary: `The kernel API publishes ${key}.`,
    }
    messages[msg] = { name: type, contentType: 'application/json', payload: { $ref: `#/components/schemas/${payload}` } }
    const properties: Record<string, unknown> = {}
    for (const [f, t] of Object.entries(spec.fields)) properties[f] = schemaOf(t)
    properties.aggregate_version = { type: 'integer', minimum: 1 }
    schemas[payload] = { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }
  }
  return {
    asyncapi: '3.0.0',
    info: ASYNCAPI_INFO,
    defaultContentType: 'application/json',
    channels,
    operations,
    components: { messages, schemas },
  }
}
