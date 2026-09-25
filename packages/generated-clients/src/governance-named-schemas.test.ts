// packages/generated-clients/src/governance-named-schemas.test.ts
//
// TASK-083 round 5: TASK-076 generates routes and validators from the named
// $ref schemas, and the TS/Dart generators synthesize a name for any inline
// schema (Dart: SendInvitation409Response). These guards pin the two gaps the
// round-4 verifier found beyond T2 (which checks 2xx and request bodies).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root.js'

function loadOpenApi(): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/governance/openapi.gov.json'), 'utf8'))
}

describe('N1 - a partial update of an agenda item requires no field', () => {
  it('updateAgendaItem (PATCH) takes a named AgendaItemUpdate, not the create body', () => {
    const doc = loadOpenApi()
    const patch = doc.paths['/api/v1/agenda-items/{agendaItemId}'].patch
    expect(patch.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/AgendaItemUpdate')
  })

  it('AgendaItemUpdate has no required field, only fields the create body knows, and at least one property', () => {
    const s = loadOpenApi().components.schemas
    const upd = s.AgendaItemUpdate
    expect(upd, 'AgendaItemUpdate is declared').toBeDefined()
    expect(upd.required ?? []).toEqual([])
    expect(upd.minProperties).toBe(1)
    const createKeys = Object.keys(s.AgendaItemCreate.properties)
    expect(Object.keys(upd.properties).length).toBeGreaterThan(0)
    for (const k of Object.keys(upd.properties)) expect(createKeys, k).toContain(k)
    // server-owned fields are never writable through the update either
    for (const k of ['state', 'outcome', 'agenda_item_id', 'meeting_id', 'proposer_person_id']) {
      expect(upd.properties[k], k).toBeUndefined()
    }
  })
})
