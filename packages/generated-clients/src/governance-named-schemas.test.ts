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

describe('N2 - every error response body is a named $ref, never an inline union', () => {
  // the three 409s that refuse by more than one name
  const MULTI_409: Record<string, { path: string; method: string; members: string[] }> = {
    createNoticeOverride: {
      path: '/api/v1/invitations/{invitationId}/notice-override', method: 'post',
      members: ['ProblemOverrideExists', 'ProblemOverrideNotRequired', 'ProblemInvitationAlreadyDispatched'],
    },
    sendInvitation: {
      path: '/api/v1/invitations/{invitationId}/send', method: 'post',
      members: ['ProblemNoticeOverrideMissing', 'ProblemNoMailConnector', 'ProblemStateTransitionRefused'],
    },
    createMotionAdmission: {
      path: '/api/v1/motions/{motionId}/admissions', method: 'post',
      members: ['ProblemMotionNotLate', 'ProblemAdmissionExists'],
    },
  }

  it('no operation response anywhere carries an inline schema (4xx/5xx included)', () => {
    const doc = loadOpenApi()
    const inline: string[] = []
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue
        for (const [code, resp] of Object.entries<any>(op.responses ?? {})) {
          for (const [ct, media] of Object.entries<any>(resp.content ?? {})) {
            if (!media.schema?.$ref) inline.push(`${m.toUpperCase()} ${p} ${code} ${ct}`)
          }
        }
      }
    }
    expect(inline).toEqual([])
  })

  for (const [opId, { path, method, members }] of Object.entries(MULTI_409)) {
    it(`${opId} 409 names a union schema whose members are its named refusals`, () => {
      const doc = loadOpenApi()
      const ref: string = doc.paths[path][method].responses['409'].content['application/problem+json'].schema.$ref
      expect(ref).toMatch(/^#\/components\/schemas\/Problem\w+$/)
      const union = doc.components.schemas[ref.split('/').pop()!]
      expect(union.oneOf.map((b: any) => b.$ref.split('/').pop()).sort()).toEqual([...members].sort())
    })
  }
})
