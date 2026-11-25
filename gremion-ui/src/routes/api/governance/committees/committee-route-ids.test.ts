// A committee id that is not a UUID reached Postgres (uuid column) and the driver's
// "invalid input syntax for type uuid" (SQLSTATE 22P02) became a 500. Every route
// under /api/governance/committees/[id]/** and /api/committees/[id]/** answers 404
// for such an id, like it does for a well-formed id nobody owns, and never queries.
// The database seam is a pool that fails like Postgres does for a malformed uuid.
import { describe, it, expect, vi } from 'vitest'
import { Role } from '$lib/auth/types'

const dbCalls = vi.hoisted(() => ({ n: 0 }))

vi.mock('$lib/server/db', () => {
  const sql = Object.assign(
    (..._a: unknown[]) => {
      dbCalls.n += 1
      return Promise.reject(Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }))
    },
    { begin: () => Promise.reject(new Error('no transaction expected')) },
  )
  return { getDb: () => sql, getRawDb: () => sql }
})
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: vi.fn() }))

import { GET as detailGET, PATCH as detailPATCH, DELETE as detailDELETE } from './[id]/+server'
import { GET as historyGET } from './[id]/history/+server'
import { GET as membersGET, POST as membersPOST } from './[id]/members/+server'
import { DELETE as memberDELETE } from './[id]/members/[userId]/+server'
import { POST as provisionPOST } from './[id]/provision/+server'
import { GET as rolesGET, POST as rolesPOST } from './[id]/roles/+server'
import { POST as assignPOST } from './[id]/roles/[roleId]/assign/+server'
import { POST as revokePOST } from './[id]/roles/[roleId]/revoke/+server'
import { GET as registerGET } from '../../committees/[id]/beschluesse/+server'
import { PATCH as registerSettingsPATCH } from '../../committees/[id]/beschluesse/settings/+server'
import { PATCH as childTermPATCH } from '../../committees/[id]/child-term/+server'

const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin, Role.Member] }
const GOOD = '3f0c9c1e-6a53-4f6e-9a3b-2f4a1c7d8e90'
const BAD = ['not-a-uuid', 'protokolle', '1', "x' OR '1'='1"]

type Handler = (e: never) => Promise<Response> | Response

function ev(params: Record<string, string>, method: string) {
  return {
    params,
    request: new Request('http://localhost/x', {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ name: 'X', childTerm: 'Referate' }),
    }),
    url: new URL('http://localhost/x'),
    locals: { auth: async () => ({ user: ADMIN }), user: ADMIN, tenant: undefined },
  } as never
}

async function status(handler: Handler, params: Record<string, string>, method: string): Promise<number> {
  try {
    return ((await handler(ev(params, method))) as Response).status
  } catch (e) {
    const s = (e as { status?: unknown }).status
    return typeof s === 'number' ? s : 500
  }
}

const ROUTES: Array<[string, Handler, string, string[]]> = [
  ['committee GET', detailGET as Handler, 'GET', []],
  ['committee PATCH', detailPATCH as Handler, 'PATCH', []],
  ['committee DELETE', detailDELETE as Handler, 'DELETE', []],
  ['history GET', historyGET as Handler, 'GET', []],
  ['members GET', membersGET as Handler, 'GET', []],
  ['members POST', membersPOST as Handler, 'POST', []],
  ['member DELETE', memberDELETE as Handler, 'DELETE', ['userId']],
  ['provision POST', provisionPOST as Handler, 'POST', []],
  ['roles GET', rolesGET as Handler, 'GET', []],
  ['roles POST', rolesPOST as Handler, 'POST', []],
  ['assign POST', assignPOST as Handler, 'POST', ['roleId']],
  ['revoke POST', revokePOST as Handler, 'POST', ['roleId']],
  ['beschluesse GET', registerGET as Handler, 'GET', []],
  ['beschluesse settings PATCH', registerSettingsPATCH as Handler, 'PATCH', []],
  ['child-term PATCH', childTermPATCH as Handler, 'PATCH', []],
]

describe('a malformed committee id answers 404 and never reaches the database', () => {
  for (const [name, handler, method, extra] of ROUTES) {
    it.each(BAD)(`${name}: id %s`, async (bad) => {
      dbCalls.n = 0
      const params: Record<string, string> = { id: bad }
      for (const k of extra) params[k] = k === 'userId' ? 'kc-user' : GOOD
      expect(await status(handler, params, method)).toBe(404)
      expect(dbCalls.n).toBe(0)
    })
  }

  for (const [name, handler, method] of ROUTES.filter((r) => r[3].includes('roleId'))) {
    it(`${name}: a well-formed committee id with a malformed role id is 404 too`, async () => {
      dbCalls.n = 0
      expect(await status(handler, { id: GOOD, roleId: 'role-1' }, method)).toBe(404)
      expect(dbCalls.n).toBe(0)
    })
  }
})
