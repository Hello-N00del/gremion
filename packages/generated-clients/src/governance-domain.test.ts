// packages/generated-clients/src/governance-domain.test.ts
//
// TASK-083 round 4: DOMAIN-alignment guards for contracts/governance/.
// Each block pins one DOMAIN v0.4 fact (DB-GOV-* rows, the GOV lifecycle
// diagrams, the GOV events table) that the round-3 review found the spec
// had drifted from. The source of truth is DOMAIN-gremion.md v0.4, quoted
// inline below so a reader never has to open the vault to see what is
// pinned.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root.js'

function loadOpenApi(): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/governance/openapi.gov.json'), 'utf8'))
}

describe('D1 - Meeting read surface carries the DB-GOV-MEETING fields gov.meeting-read v1 provides', () => {
  // DOMAIN "provides gov.meeting-read v1 ... the meeting's title, location
  // and times. This is why event payloads carry no title." The events are
  // minimised on the promise that the HTTP read surface carries the title.
  it('Meeting requires a non-empty title', () => {
    const s = loadOpenApi().components.schemas
    expect(s.Meeting.required).toContain('title')
    expect(s.Meeting.properties.title.type).toBe('string')
    expect(s.Meeting.properties.title.minLength).toBeGreaterThanOrEqual(1)
  })

  it('MeetingCreate requires title; MeetingUpdate accepts it optionally', () => {
    const s = loadOpenApi().components.schemas
    expect(s.MeetingCreate.required).toContain('title')
    expect(s.MeetingCreate.properties.title.minLength).toBeGreaterThanOrEqual(1)
    expect(s.MeetingUpdate.properties.title).toBeDefined()
    expect(s.MeetingUpdate.required ?? []).not.toContain('title')
  })

  it('Meeting exposes wahlperiode_id, notice_period_days_snapshot and call_link_id (read side)', () => {
    const m = loadOpenApi().components.schemas.Meeting
    for (const f of ['wahlperiode_id', 'notice_period_days_snapshot', 'call_link_id', 'location', 'motion_deadline_at']) {
      expect(m.properties[f], `Meeting.${f}`).toBeDefined()
    }
    // snapshot and call link are server-owned: never accepted on write
    expect(m.properties.notice_period_days_snapshot.readOnly).toBe(true)
    expect(m.properties.call_link_id.readOnly).toBe(true)
    const create = loadOpenApi().components.schemas.MeetingCreate
    expect(create.properties.notice_period_days_snapshot).toBeUndefined()
    expect(create.properties.call_link_id).toBeUndefined()
  })
})

// DOMAIN v0.4 "Lifecycles" (GOV), every state of each diagram in
// snake_case. The repo's compat gate (oasdiff --fail-on WARN) makes adding
// a response enum value a MAJOR bump, so the 1.0.0 enums must already hold
// every DOMAIN state.
const DOMAIN_LIFECYCLES: Record<string, string[]> = {
  // Meeting: Planned, Invited, InSession, Suspended, Closed, Cancelled
  Meeting: ['planned', 'invited', 'in_session', 'suspended', 'closed', 'cancelled'],
  // Invitation: Draft, Checked, Blocked, OverrideLogged, Dispatching,
  // DispatchRefused, Sent, PartlyFailed (PRD-MTG-002a/002b, FLOW-MTG-002)
  Invitation: ['draft', 'checked', 'blocked', 'override_logged', 'dispatching', 'dispatch_refused', 'sent', 'partly_failed'],
  // Agenda item: Proposed, Placed, Declined, Withdrawn, Called, Dealt, Adjourned
  AgendaItem: ['proposed', 'placed', 'declined', 'withdrawn', 'called', 'dealt', 'adjourned'],
  // Motion: Draft, PendingVerification, Submitted, OnAgenda, Withheld,
  // Deferred, Decided, Adjourned, Withdrawn, Expired (PRD-MTG-003, FLOW-MTG-003)
  Motion: [
    'draft', 'pending_verification', 'submitted', 'on_agenda', 'withheld',
    'deferred', 'decided', 'adjourned', 'withdrawn', 'expired',
  ],
}

function loadAsyncApi(): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/governance/asyncapi.gov.json'), 'utf8'))
}

// DOMAIN v0.4 GOV events table (DB-PLT-EVENT-TYPE rows), payload column,
// field for field. "new start and end" = scheduled_start/scheduled_end;
// "recipient person_ids" = recipient_person_ids; "curing_basis_id and
// version" = curing_basis_id + curing_basis_version.
const DOMAIN_EVENT_FIELDS: Record<string, { schema: string; fields: string[] }> = {
  'de.gremion.gov.meeting.scheduled.v1': {
    schema: 'EnvelopeMeetingScheduled',
    fields: ['meeting_id', 'body_id', 'org_unit_id', 'scheduled_start', 'scheduled_end', 'aggregate_version'],
  },
  'de.gremion.gov.meeting.rescheduled.v1': {
    schema: 'EnvelopeMeetingRescheduled',
    fields: ['meeting_id', 'scheduled_start', 'scheduled_end', 'aggregate_version'],
  },
  'de.gremion.gov.meeting.cancelled.v1': {
    schema: 'EnvelopeMeetingCancelled',
    fields: ['meeting_id', 'cancel_reason', 'aggregate_version'],
  },
  'de.gremion.gov.meeting.opened.v1': { schema: 'EnvelopeMeetingOpened', fields: ['meeting_id', 'opened_at'] },
  'de.gremion.gov.meeting.closed.v1': { schema: 'EnvelopeMeetingClosed', fields: ['meeting_id', 'body_id', 'closed_at'] },
  'de.gremion.gov.invitation.issued.v1': {
    schema: 'EnvelopeInvitationIssued',
    fields: ['invitation_id', 'meeting_id', 'version', 'recipient_person_ids', 'notice_met'],
  },
  'de.gremion.gov.notice.overridden.v1': {
    schema: 'EnvelopeNoticeOverridden',
    fields: ['invitation_id', 'meeting_id', 'actor_person_id', 'days_short', 'curing_basis_id', 'curing_basis_version'],
  },
  'de.gremion.gov.motion.submitted.v1': {
    schema: 'EnvelopeMotionSubmitted',
    fields: ['motion_id', 'meeting_id', 'submitter_kind', 'is_late'],
  },
  'de.gremion.gov.motion.withheld.v1': { schema: 'EnvelopeMotionWithheld', fields: ['motion_id', 'meeting_id'] },
  'de.gremion.gov.motion.admitted.v1': {
    schema: 'EnvelopeMotionAdmitted',
    fields: ['motion_id', 'meeting_id', 'actor_person_id'],
  },
  'de.gremion.gov.motion.deferred.v1': {
    schema: 'EnvelopeMotionDeferred',
    fields: ['motion_id', 'target_meeting_id', 'actor_person_id'],
  },
}

function payloadSchema(async: any, schemaKey: string): any {
  // allOf[EventEnvelope, {properties:{payload:{allOf:[<payload object>]}}}]
  return async.components.schemas[schemaKey].allOf[1].properties.payload.allOf[0]
}

describe('D3 - every event payload equals its DOMAIN field list, closed against extras', () => {
  it('the table covers exactly the 11 messages in the document', () => {
    const async = loadAsyncApi()
    const envelopes = Object.keys(async.components.schemas).filter((k) => k.startsWith('Envelope'))
    expect(envelopes.sort()).toEqual(Object.values(DOMAIN_EVENT_FIELDS).map((e) => e.schema).sort())
  })

  for (const [eventType, { schema, fields }] of Object.entries(DOMAIN_EVENT_FIELDS)) {
    it(`${eventType}: payload keys = DOMAIN fields, all required, no additional properties`, () => {
      const p = payloadSchema(loadAsyncApi(), schema)
      expect(Object.keys(p.properties).sort()).toEqual([...fields].sort())
      expect([...p.required].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))).toEqual(
        [...fields].sort(),
      )
      // minimisation made structural: a producer cannot slip a title,
      // location, reason or address in beside the listed fields
      expect(p.additionalProperties).toBe(false)
    })
  }
})

describe('D4 - server-recorded DOMAIN fields are readable; append-only records have a read path', () => {
  it('snapshots and actors DOMAIN records are exposed read-only', () => {
    const s = loadOpenApi().components.schemas
    // DB-GOV-NOTICE-OVERRIDE "text curing_basis_snapshot (the basis text and
    // citation as they stood when recorded)"
    expect(s.NoticeOverride.properties.curing_basis_snapshot?.readOnly).toBe(true)
    // DB-GOV-MOTION "timestamp deadline_snapshot"; is_late is computed from it
    expect(s.Motion.properties.deadline_snapshot?.readOnly).toBe(true)
    // DB-GOV-INVITATION "reference sender_person_id"
    expect(s.Invitation.properties.sender_person_id?.readOnly).toBe(true)
    expect(s.NoticeOverrideCreate.properties.curing_basis_snapshot).toBeUndefined()
    expect(s.MotionCreate.properties.deadline_snapshot).toBeUndefined()
  })

  it('the one notice-override and a motion\'s admissions can be read back (GET only, still no mutating verb)', () => {
    const paths = loadOpenApi().paths
    const override = paths['/api/v1/invitations/{invitationId}/notice-override']
    expect(override.get?.operationId).toBe('getNoticeOverride')
    const admissions = paths['/api/v1/motions/{motionId}/admissions']
    expect(admissions.get?.operationId).toBe('listMotionAdmissions')
    for (const item of [override, admissions]) {
      for (const m of ['put', 'patch', 'delete']) expect(item[m]).toBeUndefined()
    }
  })

  it('reading a missing override is a 404, and the admissions list is cursor-paginated like every other list', () => {
    const doc = loadOpenApi()
    const get = doc.paths['/api/v1/invitations/{invitationId}/notice-override'].get
    expect(get.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/NoticeOverride')
    expect(get.responses['404']).toBeDefined()
    const list = doc.paths['/api/v1/motions/{motionId}/admissions'].get
    expect(list.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/MotionAdmissionPage')
    const names = (list.parameters ?? []).map((p: any) => p.name ?? p.$ref)
    expect(names.join(' ')).toMatch(/cursor/i)
    expect(names.join(' ')).toMatch(/limit/i)
  })

  it('AgendaItem exposes the DB-GOV-AGENDA-ITEM outcome read-only (set when dealt, SCHEMA agenda_item_outcome_check)', () => {
    const s = loadOpenApi().components.schemas
    const outcome = s.AgendaItem.properties.outcome
    expect(outcome?.readOnly).toBe(true)
    const byStringOrder = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)
    expect([...outcome.enum].sort(byStringOrder)).toEqual(
      ['no_decision', 'noted', 'referred', 'rejected', 'resolved', null].sort(byStringOrder),
    )
    expect(s.AgendaItemCreate.properties.outcome).toBeUndefined()
  })

  it('a defer admission must name exactly one target: a meeting id or the next meeting (DB-GOV-MOTION-ADMISSION)', () => {
    const s = loadOpenApi().components.schemas
    const create = s.MotionAdmissionCreate
    expect(create.if?.properties?.outcome?.const).toBe('defer')
    expect(create.if?.required).toContain('outcome')
    const branches: any[] = create.then?.oneOf ?? []
    const alternatives = branches.map((b: any) => b.required).flat()
    expect(alternatives).toEqual(expect.arrayContaining(['deferred_to_meeting_id', 'defer_to_next_meeting']))
    // "next meeting" is chosen by sending true; false is not a target
    const nextBranch = branches.find((b: any) => (b.required ?? []).includes('defer_to_next_meeting'))
    expect(nextBranch.properties.defer_to_next_meeting.const).toBe(true)
    // admit names no target (SCHEMA motion_admission_defer_check)
    expect(create.else?.properties?.deferred_to_meeting_id).toBe(false)
    expect(create.else?.properties?.defer_to_next_meeting).toBe(false)
    // the recorded admission shows which target was chosen
    expect(s.MotionAdmission.properties.defer_to_next_meeting?.type).toBe('boolean')
    expect(s.MotionAdmission.required).toContain('defer_to_next_meeting')
  })
})

describe('D5 - every envelope names its own DB-PLT-EVENT-TYPE; the document describes only what GOV sends', () => {
  // DOMAIN DB-PLT-EVENT-TYPE / brief §5: de.gremion.gov.<entity>.<verb>.v1.
  // The type travels in the envelope (CloudEvents 1.0 `type`, reverse-DNS),
  // so a consumer on gremion.*.gov.> can dispatch on it without parsing the
  // subject. Each message pins its own value.
  for (const [eventType, { schema }] of Object.entries(DOMAIN_EVENT_FIELDS)) {
    it(`${schema}.eventType is the const ${eventType}`, () => {
      const env = loadAsyncApi().components.schemas[schema]
      expect(env.allOf[1].properties.eventType?.const).toBe(eventType)
      expect(env.allOf[1].required ?? []).toContain('eventType')
    })
  }

  it('the base envelope cites no helper or union that does not exist', () => {
    const base = loadAsyncApi().components.schemas.EventEnvelope
    expect(base.properties.eventType.description).not.toMatch(/GovernanceEvent/)
    // the base pattern admits every DOMAIN event type and nothing short or foreign
    const re = new RegExp(base.properties.eventType.pattern)
    for (const t of Object.keys(DOMAIN_EVENT_FIELDS)) expect(re.test(t), t).toBe(true)
    for (const bad of ['meeting.scheduled', 'de.gremion.cal.event.created.v1', 'deXgremion.gov.meeting.scheduled.v1']) {
      expect(re.test(bad), bad).toBe(false)
    }
  })

  it('no receive operation stands for all eleven channels while bound to one', () => {
    const ops = Object.values<any>(loadAsyncApi().operations)
    expect(ops.filter((o) => o.action === 'receive')).toEqual([])
    expect(ops.filter((o) => o.action === 'send')).toHaveLength(Object.keys(DOMAIN_EVENT_FIELDS).length)
  })

  it('motion.deferred carries a null target_meeting_id for a defer to the next meeting', () => {
    // SCHEMA gov.motion.target_meeting_id: "Null ... after a deferral 'to the
    // next meeting' until one is chosen"; DB-GOV-MOTION-ADMISSION allows it
    const p = payloadSchema(loadAsyncApi(), 'EnvelopeMotionDeferred')
    expect(p.properties.target_meeting_id.type).toEqual(['string', 'null'])
  })
})

describe('D7 - cancel_reason carries exactly SCHEMA meeting_cancel_reason_check', () => {
  // SCHEMA gov.meeting: CHECK (cancel_reason IN ('chair_cancelled',
  // 'body_archived', 'org_unit_archived', 'customer_offboarding')). A value the
  // GOV database stores but the 1.0.0 enum lacks, or a renamed value, is a
  // MAJOR bump later, so both documents use SCHEMA's set now.
  const SCHEMA_CANCEL_REASONS = ['chair_cancelled', 'body_archived', 'org_unit_archived', 'customer_offboarding']

  it('Meeting.cancel_reason = SCHEMA values plus null (null outside cancelled)', () => {
    const prop = loadOpenApi().components.schemas.Meeting.properties.cancel_reason
    const byStringOrder = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)
    expect([...prop.enum].sort(byStringOrder)).toEqual([...SCHEMA_CANCEL_REASONS, null].sort(byStringOrder))
  })

  it('meeting.cancelled payload cancel_reason = SCHEMA values (the event is only sent when cancelled)', () => {
    const p = payloadSchema(loadAsyncApi(), 'EnvelopeMeetingCancelled')
    expect([...p.properties.cancel_reason.enum].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))).toEqual(
      [...SCHEMA_CANCEL_REASONS].sort(),
    )
    expect(p.properties.cancel_reason.type).toBe('string')
  })
})

describe('D2 - every state enum equals its DOMAIN lifecycle diagram', () => {
  for (const [schema, states] of Object.entries(DOMAIN_LIFECYCLES)) {
    it(`${schema}.state enum = DOMAIN ${schema} lifecycle`, () => {
      const prop = loadOpenApi().components.schemas[schema].properties.state
      expect([...prop.enum].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))).toEqual(
        [...states].sort(),
      )
    })
  }
})
