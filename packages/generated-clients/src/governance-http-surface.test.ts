// packages/generated-clients/src/governance-http-surface.test.ts
//
// TASK-083 round 4: HTTP-surface conventions for
// contracts/governance/openapi.gov.json that the brief fixes as decisions
// (§5 Q6 problem types, Q7 cursor pagination, "chair-only operations
// document 403") and that the round-3 review found stated only in prose.
// A later change to any of these is a breaking change under the compat
// gate, so they are pinned before 1.0.0 merges.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root.js'

function loadOpenApi(): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/governance/openapi.gov.json'), 'utf8'))
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

function allOperations(doc: any): Array<{ path: string; method: string; op: any; pathParams: any[] }> {
  const ops: Array<{ path: string; method: string; op: any; pathParams: any[] }> = []
  for (const [p, item] of Object.entries<any>(doc.paths)) {
    for (const m of HTTP_METHODS) {
      if (item[m]) ops.push({ path: p, method: m, op: item[m], pathParams: item.parameters ?? [] })
    }
  }
  return ops
}

/** Follow one local $ref (components/...) to its target node. */
function deref(doc: any, node: any): any {
  let n = node
  while (n && typeof n.$ref === 'string') {
    n = n.$ref
      .slice(2)
      .split('/')
      .reduce((acc: any, seg: string) => acc?.[decodeURIComponent(seg)], doc)
  }
  return n
}

function paramNames(doc: any, op: any, pathParams: any[]): string[] {
  return [...pathParams, ...(op.parameters ?? [])].map((p) => deref(doc, p).name)
}

describe('H1 - every list operation is cursor-paginated (brief §5 Q7)', () => {
  it('there are list operations to check (non-vacuity)', () => {
    const lists = allOperations(loadOpenApi()).filter(({ op }) => op.operationId.startsWith('list'))
    expect(lists.length).toBeGreaterThanOrEqual(6)
  })

  it('each list takes ?cursor= and ?limit= and returns a named *Page {items, nextCursor}', () => {
    const doc = loadOpenApi()
    for (const { path, method, op, pathParams } of allOperations(doc)) {
      if (!op.operationId.startsWith('list')) continue
      const where = `${method} ${path}`
      const names = paramNames(doc, op, pathParams)
      expect(names, where).toContain('cursor')
      expect(names, where).toContain('limit')
      const schema = op.responses['200'].content['application/json'].schema
      expect(schema.$ref, `${where} must return a named page, not a bare array`).toMatch(/Page$/)
      const page = deref(doc, schema)
      expect(page.required, where).toEqual(expect.arrayContaining(['items', 'nextCursor']))
      expect(page.properties.items.type, where).toBe('array')
    }
  })

  it('no GET returns a bare array (a later move to a page object would be breaking)', () => {
    const doc = loadOpenApi()
    let checked = 0
    for (const { path, op } of allOperations(doc)) {
      const schema = op.responses['200']?.content?.['application/json']?.schema
      if (!schema) continue
      expect(schema.type, `${path}`).not.toBe('array')
      checked++
    }
    // A guard that checked zero responses "passes" without checking anything.
    expect(checked).toBeGreaterThan(0)
  })
})

// The named problem types (RFC 9457 `type`), one URN per refusal. The
// `urn:gremion:problem:<slug>` scheme is the one TASK-076's service
// template already emits (not-found, validation-failed, ...); governance
// refusals take the `gov:` prefix.
const PROBLEM_URN = /^urn:gremion:problem:(gov:)?[a-z0-9-]+$/

/** The problem `type` consts an error response declares, and the status
 *  const each problem schema pins. */
function declaredProblems(doc: any, response: any): Array<{ type: string; status: number }> {
  const r = deref(doc, response)
  const schema = r?.content?.['application/problem+json']?.schema
  if (!schema) return []
  const target = deref(doc, schema)
  const members = target.oneOf ? target.oneOf.map((m: any) => deref(doc, m)) : [target]
  return members.map((m: any) => {
    // a named problem pins `type` and `status` either on its own
    // properties (flat form) or on one allOf part
    const pinned = m.properties?.type?.const ? m : (m.allOf ?? []).find((part: any) => part.properties?.type?.const)
    return { type: pinned?.properties.type.const, status: pinned?.properties.status?.const }
  })
}

// Named refusals the brief and DOMAIN require, per operation and status.
const REQUIRED_REFUSALS: Array<{ op: string; status: string; types: string[] }> = [
  // PRD-MTG-002b / brief §5: "send returns 409 with a named problem type";
  // DOMAIN DB-GOV-INVITATION: no connector -> "refused with a named reason"
  { op: 'sendInvitation', status: '409', types: ['urn:gremion:problem:gov:notice-override-missing', 'urn:gremion:problem:gov:no-mail-connector'] },
  // DB-GOV-NOTICE-OVERRIDE: at most one; written before dispatch; only when notice is missed
  {
    op: 'createNoticeOverride',
    status: '409',
    types: [
      'urn:gremion:problem:gov:override-exists',
      'urn:gremion:problem:gov:override-not-required',
      'urn:gremion:problem:gov:invitation-already-dispatched',
    ],
  },
  // DB-GOV-MOTION-ADMISSION: decides a late motion, append-only
  { op: 'createMotionAdmission', status: '409', types: ['urn:gremion:problem:gov:motion-not-late', 'urn:gremion:problem:gov:admission-exists'] },
  // DB-GOV-AGENDA-SECTION: only before the invitation
  { op: 'createAgendaSection', status: '409', types: ['urn:gremion:problem:gov:agenda-frozen'] },
  { op: 'updateAgendaSection', status: '409', types: ['urn:gremion:problem:gov:agenda-frozen'] },
]

describe('H2 - every error response declares named RFC 9457 problem types (brief §5 Q6)', () => {
  it('every 4xx/5xx response is problem+json with at least one pinned type URN and a matching status', () => {
    const doc = loadOpenApi()
    let checked = 0
    for (const { path, method, op } of allOperations(doc)) {
      for (const [status, response] of Object.entries<any>(op.responses)) {
        if (!/^[45]/.test(status)) continue
        const where = `${method} ${path} ${status}`
        const problems = declaredProblems(doc, response)
        expect(problems.length, `${where} declares no named problem type`).toBeGreaterThan(0)
        for (const p of problems) {
          expect(p.type, where).toMatch(PROBLEM_URN)
          expect(p.status, where).toBe(Number(status))
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  for (const { op, status, types } of REQUIRED_REFUSALS) {
    it(`${op} ${status} declares ${types.map((t) => t.split(':').pop()).join(', ')}`, () => {
      const doc = loadOpenApi()
      const found = allOperations(doc).find((o) => o.op.operationId === op)
      expect(found, op).toBeDefined()
      const declared = declaredProblems(doc, found!.op.responses[status]).map((p) => p.type)
      expect(declared).toEqual(expect.arrayContaining(types))
    })
  }

  it('the base Problem schema carries no host-bound example type', () => {
    const problem = loadOpenApi().components.schemas.Problem
    expect(JSON.stringify(problem)).not.toMatch(/https?:\/\//)
  })
})

// DOMAIN: "Only the chair issues it" (INVITATION), "recorded by: the chair"
// (NOTICE-OVERRIDE), "Only the chair reorders sections" (AGENDA-SECTION),
// "Only the chair decides" (MOTION-ADMISSION); the Meeting and Agenda item
// lifecycles put open/close/cancel/place/call with the chair.
const CHAIR_ONLY = [
  'updateMeeting', 'openMeeting', 'closeMeeting', 'cancelMeeting',
  'createAgendaSection', 'updateAgendaSection', 'updateAgendaItem',
  'createInvitation', 'createNoticeOverride', 'sendInvitation', 'createMotionAdmission',
]

describe('H3 - 401, 403, 404 and 400 are documented where they can occur', () => {
  it('every operation documents 401 (bearer OIDC on every call) and 403 (the PDP decides every call)', () => {
    const doc = loadOpenApi()
    for (const { path, method, op } of allOperations(doc)) {
      expect(op.responses['401'], `${method} ${path} 401`).toBeDefined()
      expect(op.responses['403'], `${method} ${path} 403`).toBeDefined()
    }
  })

  it('every chair-only operation exists and its 403 names the chair', () => {
    const doc = loadOpenApi()
    const byId = new Map(allOperations(doc).map((o) => [o.op.operationId, o.op]))
    for (const id of CHAIR_ONLY) {
      const op = byId.get(id)
      expect(op, id).toBeDefined()
      expect(op.responses['403']?.description ?? '', id).toMatch(/chair/i)
    }
  })

  it('every operation addressed by a path id documents 404', () => {
    const doc = loadOpenApi()
    let checked = 0
    for (const { path, method, op } of allOperations(doc)) {
      if (!/\{[A-Za-z]+Id\}/.test(path)) continue
      expect(op.responses['404'], `${method} ${path} 404`).toBeDefined()
      checked++
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('every operation with a request body documents 400', () => {
    const doc = loadOpenApi()
    let checked = 0
    for (const { path, method, op } of allOperations(doc)) {
      if (!op.requestBody) continue
      expect(op.responses['400'], `${method} ${path} 400`).toBeDefined()
      checked++
    }
    // A guard that checked zero operations "passes" without checking anything.
    expect(checked).toBeGreaterThan(0)
  })
})
