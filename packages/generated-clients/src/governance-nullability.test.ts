// packages/generated-clients/src/governance-nullability.test.ts
//
// TASK-083 round 5 (D6): the 1.0.0 contract must be able to carry every
// state the GOV database can hold. The compat gate (oasdiff --fail-on WARN,
// asyncapi-compat) treats widening a response or payload type to admit null
// as a MAJOR bump, so a column that SCHEMA declares nullable and the contract
// declares non-null is a defect that cannot be fixed later without 2.0.0.
//
// Source of truth, quoted so a reader never has to open the vault:
// - DOMAIN v0.4 DB-GOV "Organisational references": org_unit_id "is null
//   where the body itself decides" (DOMAIN line 1065).
// - SCHEMA gov.meeting: org_unit_id uuid (nullable), meeting_number integer
//   (nullable), scheduled_end timestamptz ("end only" nullable), location
//   (nullable), motion_deadline_at (nullable).
// - SCHEMA gov.motion: target_meeting_id "Null while in draft, or after a
//   deferral 'to the next meeting' until one is chosen" (SCHEMA line 6170);
//   submitted_at "Required outside draft, pending_verification and expired"
//   (motion_submitted_check); is_late = submitted_at > deadline_snapshot, a
//   generated column that is null whenever either side is null;
//   reference_label and rationale nullable.
// - SCHEMA gov.agenda_item: agenda_section_id, position "Null while the item
//   is proposed or declined"; item_number and description nullable.
// - SCHEMA gov.invitation: notice_met "yes (draft, checked)" nullable;
//   recipient_count nullable.
// - SCHEMA gov.notice_override: reason "yes, only once erased" (erasable in
//   place to NULL under a covered redaction).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root.js'

function load(file: string): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/governance', file), 'utf8'))
}

// A property admits null when its type list names null (or it is an anyOf
// with a null branch), and, if it carries an enum, the enum lists null too:
// JSON Schema rejects a value outside `enum` whatever `type` says.
function admitsNull(prop: any): boolean {
  if (!prop) return false
  const typeOk = Array.isArray(prop.type)
    ? prop.type.includes('null')
    : Array.isArray(prop.anyOf ?? prop.oneOf)
      ? (prop.anyOf ?? prop.oneOf).some((b: any) => b.type === 'null')
      : false
  const enumOk = Array.isArray(prop.enum) ? prop.enum.includes(null) : true
  return typeOk && enumOk
}

const SCHEMA_NULLABLE_RESPONSE_FIELDS: Record<string, string[]> = {
  Meeting: ['org_unit_id', 'wahlperiode_id', 'meeting_number', 'scheduled_end', 'location', 'call_link_id',
    'motion_deadline_at', 'opened_at', 'closed_at', 'cancel_reason'],
  AgendaItem: ['section_id', 'position', 'item_number', 'description', 'own_publication_class',
    'proposer_person_id', 'outcome'],
  Invitation: ['notice_met', 'sent_at', 'sender_person_id', 'recipient_count'],
  NoticeOverride: ['reason', 'curing_basis_id', 'curing_basis_version'],
  InvitationRecipient: ['bounce_class', 'submitted_at'],
  Motion: ['target_meeting_id', 'agenda_item_id', 'reference_label', 'rationale', 'submitter_person_id',
    'submitted_at', 'deadline_snapshot', 'is_late'],
  MotionAdmission: ['deferred_to_meeting_id'],
}

describe('D6 - every SCHEMA-nullable column is nullable in the 1.0.0 contract', () => {
  for (const [schema, fields] of Object.entries(SCHEMA_NULLABLE_RESPONSE_FIELDS)) {
    for (const f of fields) {
      it(`${schema}.${f} admits null`, () => {
        const prop = load('openapi.gov.json').components.schemas[schema].properties[f]
        expect(prop, `${schema}.${f} is declared`).toBeDefined()
        expect(admitsNull(prop), `${schema}.${f}: ${JSON.stringify(prop)}`).toBe(true)
      })
    }
  }

  it('MeetingCreate names the body and leaves org_unit_id and scheduled_end optional (the body itself may decide)', () => {
    const create = load('openapi.gov.json').components.schemas.MeetingCreate
    expect(create.required).toContain('body_id')
    expect(create.properties.body_id?.format).toBe('uuid')
    expect(create.required).not.toContain('org_unit_id')
    expect(create.required).not.toContain('scheduled_end')
    expect(admitsNull(create.properties.org_unit_id)).toBe(true)
  })

  it('MeetingUpdate can clear the optional end and location', () => {
    const upd = load('openapi.gov.json').components.schemas.MeetingUpdate
    expect(admitsNull(upd.properties.scheduled_end)).toBe(true)
    expect(admitsNull(upd.properties.location)).toBe(true)
  })

  const payload = (schema: string): any =>
    load('asyncapi.gov.json').components.schemas[schema].allOf[1].properties.payload.allOf[0]

  it('meeting.scheduled carries a null org_unit_id when the body itself decides, and a null end when none is set', () => {
    const p = payload('EnvelopeMeetingScheduled')
    expect(admitsNull(p.properties.org_unit_id)).toBe(true)
    expect(admitsNull(p.properties.scheduled_end)).toBe(true)
    // still required: present in every payload, possibly null (DOMAIN field list)
    expect(p.required).toEqual(expect.arrayContaining(['org_unit_id', 'scheduled_end']))
  })

  it('meeting.rescheduled carries a null end when none is set', () => {
    const p = payload('EnvelopeMeetingRescheduled')
    expect(admitsNull(p.properties.scheduled_end)).toBe(true)
    expect(p.properties.scheduled_start.type).toBe('string')
  })

  it('motion.submitted carries a null is_late when the target meeting has no motion deadline', () => {
    const p = payload('EnvelopeMotionSubmitted')
    expect(admitsNull(p.properties.is_late)).toBe(true)
  })

  it('the fields SCHEMA holds NOT NULL stay non-null (no blanket widening)', () => {
    const s = load('openapi.gov.json').components.schemas
    for (const [schema, f] of [
      ['Meeting', 'meeting_id'], ['Meeting', 'body_id'], ['Meeting', 'title'], ['Meeting', 'scheduled_start'],
      ['Meeting', 'state'], ['Motion', 'motion_id'], ['Motion', 'title'], ['Motion', 'state'],
      ['Invitation', 'state'], ['NoticeOverride', 'days_short'], ['AgendaItem', 'title'],
    ] as const) {
      expect(admitsNull(s[schema].properties[f]), `${schema}.${f}`).toBe(false)
    }
  })
})
