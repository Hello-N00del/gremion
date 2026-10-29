// The authz routes' failure mapping, without a database: only an availability
// failure of the customer's store is a 503; anything else is a 500 with a generic
// body and a log line that names the cause. (The grant rules are the .int suites'.)
import { describe, expect, it } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Logger, TenantRow } from '../../src/app/deps.ts'
import { authzHandlers, isAvailabilityError } from '../../src/authz/http.ts'
import { setContext } from '../../src/tenancy/context.ts'

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

const CUSTOMER = '01970000-0000-7000-8000-00000000000a'
const tenant: TenantRow = { customerId: CUSTOMER, slug: 's', status: 'active', realm: 'r', issuer: 'i', kcInternal: 'k', dbConnRef: 'x' }

const coded = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`driver said ${code}`), { code, ...extra })

function harness(kernelDb: () => Promise<never>) {
  const logs: { msg: string; fields: Record<string, unknown> }[] = []
  const log: Logger = { info: () => {}, warn: () => {}, error: (msg, fields) => logs.push({ msg, fields: fields ?? {} }) }
  const handlers = authzHandlers({ registry: { listEnabled: async () => [] } as never, log, kernelDb })
  const request = { body: {}, query: {}, params: {} } as unknown as FastifyRequest
  setContext(request, { tenant, caller: { kind: 'user', claims: { sub: 's' } } })
  const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} }
  const reply = {
    header: (k: string, v: string) => ((sent.headers[k] = v), reply),
    code: (n: number) => ((sent.status = n), reply),
    type: () => reply,
    send: (b: string) => ((sent.body = b), reply),
  } as unknown as FastifyReply
  const call = async (op: 'issueAuthzGrant' | 'listAuthzGrants' | 'revokeAuthzGrant' | 'revokeAllAuthzGrants' = 'issueAuthzGrant') => {
    await (handlers[op] as unknown as Handler)(request, reply)
    return { status: sent.status, problem: sent.body ? JSON.parse(sent.body) : null }
  }
  return { logs, call }
}

describe('isAvailabilityError', () => {
  it.each([
    ['ECONNREFUSED', coded('ECONNREFUSED')],
    ['ECONNRESET', coded('ECONNRESET')],
    ['ETIMEDOUT', coded('ETIMEDOUT')],
    ['postgres.js CONNECT_TIMEOUT', coded('CONNECT_TIMEOUT')],
    ['postgres.js CONNECTION_CLOSED', coded('CONNECTION_CLOSED')],
    ['admin_shutdown 57P01', coded('57P01')],
    ['cannot_connect_now 57P03', coded('57P03')],
    ['too_many_connections 53300', coded('53300')],
    ['connection exception class 08006', coded('08006')],
    ['an AggregateError carrying ECONNREFUSED (node dual-stack connect)', Object.assign(new AggregateError([], 'connect failed'), { code: 'ECONNREFUSED' })],
    ['a wrapped cause', new Error('open failed', { cause: coded('ECONNREFUSED') })],
    ['a pool timeout by message', new Error('timed out acquiring a connection from the pool')],
  ])('%s is an availability failure', (_n, err) => {
    expect(isAvailabilityError(err)).toBe(true)
  })
  it.each([
    ['a plain TypeError', new TypeError("Cannot read properties of undefined (reading 'x')")],
    ['a unique violation 23505', coded('23505', { constraint_name: 'authz_grant_pkey' })],
    ['a syntax error 42601', coded('42601')],
    ['an undefined column 42703', coded('42703')],
    ['a non-error value', 'boom'],
    ['null', null],
  ])('%s is not', (_n, err) => {
    expect(isAvailabilityError(err)).toBe(false)
  })
})

describe('authz route failure mapping', () => {
  it('an availability failure of the customer store is 503 customer-unavailable and is logged with its cause', async () => {
    const h = harness(async () => {
      throw coded('ECONNREFUSED')
    })
    const r = await h.call('issueAuthzGrant')
    expect(r.status).toBe(503)
    expect(r.problem.type).toBe('urn:gremion:problem:customer-unavailable')
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]!.fields).toMatchObject({ code: 'ECONNREFUSED', customerId: CUSTOMER, operation: 'issueAuthzGrant' })
    expect(String(h.logs[0]!.fields.stack)).toContain('Error')
  })
  it('any other failure is 500 with a generic body (no message, no stack, no constraint) and a log line that names all of it', async () => {
    const h = harness(async () => {
      throw coded('23505', { constraint_name: 'authz_grant_pkey', message: 'duplicate key value violates unique constraint "authz_grant_pkey"' })
    })
    const r = await h.call('revokeAllAuthzGrants')
    expect(r.status).toBe(500)
    expect(r.problem.type).toBe('urn:gremion:problem:internal')
    const wire = JSON.stringify(r.problem)
    expect(wire).not.toMatch(/authz_grant_pkey|duplicate key|23505|stack/i)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]!.fields).toMatchObject({ code: '23505', constraint_name: 'authz_grant_pkey', customerId: CUSTOMER, operation: 'revokeAllAuthzGrants' })
    expect(String(h.logs[0]!.fields.err)).toContain('duplicate key')
    expect(String(h.logs[0]!.fields.stack)).toContain('Error')
  })
  it('a TypeError from a bug is a 500, not a 503 and not a 400', async () => {
    const h = harness(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'x')")
    })
    expect((await h.call('listAuthzGrants')).status).toBe(500)
  })
  it('the customer database not being wired stays a 503 (the documented answer)', async () => {
    const logs: unknown[] = []
    const handlers = authzHandlers({ registry: { listEnabled: async () => [] } as never, log: { info() {}, warn() {}, error: (...a) => logs.push(a) } })
    const request = { body: {}, query: {}, params: {} } as unknown as FastifyRequest
    setContext(request, { tenant, caller: { kind: 'user', claims: { sub: 's' } } })
    let status = 0
    const reply = { header: () => reply, code: (n: number) => ((status = n), reply), type: () => reply, send: () => reply } as unknown as FastifyReply
    await (handlers.issueAuthzGrant as unknown as Handler)(request, reply)
    expect(status).toBe(503)
  })
})
