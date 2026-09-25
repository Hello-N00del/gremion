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

describe('D2 - every state enum equals its DOMAIN lifecycle diagram', () => {
  for (const [schema, states] of Object.entries(DOMAIN_LIFECYCLES)) {
    it(`${schema}.state enum = DOMAIN ${schema} lifecycle`, () => {
      const prop = loadOpenApi().components.schemas[schema].properties.state
      expect([...prop.enum].sort()).toEqual([...states].sort())
    })
  }
})
