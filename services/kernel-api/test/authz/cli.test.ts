// `kernel-api authz sync|sweep`: usage, per-customer isolation of failures,
// the exit code. Pure wiring test (the verbs' effects are the .int suites').
import { describe, expect, it, vi } from 'vitest'
import { runAuthzCli, type AuthzCliDeps } from '../../src/authz/cli.ts'

const A = '01970000-0000-7000-8000-00000000000a'
const B = '01970000-0000-7000-8000-00000000000b'
const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}
const deps = (over: Partial<AuthzCliDeps> = {}): AuthzCliDeps => ({
  listCustomerIds: async () => [A, B],
  lookup: async (id) => ({ customerId: id, slug: 's', status: 'active', realm: 'r', issuer: 'i', kcInternal: 'k', dbConnRef: 'x' }),
  db: async () => {
    throw new Error('db down')
  },
  moduleIds: async () => new Map(),
  enabledModules: async () => new Set(),
  ...over,
})

describe('runAuthzCli', () => {
  it('usage errors exit 2 and touch nothing', async () => {
    const list = vi.fn(async () => [A])
    for (const argv of [[], ['authz'], ['authz', 'nope'], ['authz', 'sync', '--customer'], ['authz', 'sync', '--customer', 'x'], ['authz', 'sweep', 'extra']]) {
      const t = io()
      expect(await runAuthzCli(argv, t.io, deps({ listCustomerIds: list }))).toBe(2)
      expect(t.err[0]).toMatch(/^usage:/)
    }
    expect(list).not.toHaveBeenCalled()
  })
  it('one failing customer is named, the next is still visited, exit is 1', async () => {
    const t = io()
    const looked: string[] = []
    const code = await runAuthzCli(['authz', 'sweep'], t.io, deps({ lookup: async (id) => (looked.push(id), null) }))
    expect(code).toBe(1)
    expect(looked).toEqual([A, B])
    expect(t.err.filter((l) => l.startsWith('AUTHZ-FAILED'))).toHaveLength(2)
    expect(t.err[0]).toContain(A)
  })
  it('--customer visits exactly that customer and does not list', async () => {
    const t = io()
    const list = vi.fn(async () => [A, B])
    const looked: string[] = []
    await runAuthzCli(['authz', 'sync', '--customer', B], t.io, deps({ listCustomerIds: list, lookup: async (id) => (looked.push(id), null) }))
    expect(looked).toEqual([B])
    expect(list).not.toHaveBeenCalled()
  })
  it('no active customer is exit 0 with a line (a silent no-op would look like success)', async () => {
    const t = io()
    expect(await runAuthzCli(['authz', 'sync'], t.io, deps({ listCustomerIds: async () => [] }))).toBe(0)
    expect(t.out).toEqual(['AUTHZ-SYNC no active customer'])
  })
})
