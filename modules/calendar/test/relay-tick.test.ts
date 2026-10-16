// test/relay-tick.test.ts — the relay tick isolates tenants from each other.
//
// BYTE-IDENTICAL in the calendar, content and newsletter leaves.
//
// Two tenants; the first one's store refuses with a TenantIdentityMismatchError.
// The second must still be processed, the refusal is logged by tenant id only
// (the refusal's message carries the slug), and a listing failure still reaches
// the caller's tick-level handler.

import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRelayTick } from '../src/relay-tick.ts'
import { TenantIdentityMismatchError, type TenantRef, type Sql } from '../src/tenant-store.ts'

const INDEX_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts')

const FIRST: TenantRef = { id: '0190aaaa-0000-7000-8000-000000000001', slug: 'first-slug' }
const SECOND: TenantRef = { id: '0190aaaa-0000-7000-8000-000000000002', slug: 'second-slug' }
const SQL_SECOND = { marker: 'second' } as unknown as Sql

afterEach(() => vi.restoreAllMocks())

describe('runRelayTick - per-tenant isolation', () => {
  it('still processes the second tenant when the first tenant\'s store throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storeFor = vi.fn(async (tenant: TenantRef): Promise<Sql> => {
      if (tenant.id === FIRST.id) {
        throw new TenantIdentityMismatchError(FIRST, { id: FIRST.id, slug: 'catalogued-slug' })
      }
      return SQL_SECOND
    })
    const pass = vi.fn(async () => ({ ok: 1, failed: 0 }))

    await expect(
      runRelayTick({ listTenants: async () => [FIRST, SECOND], storeFn: storeFor, pass }),
    ).resolves.toBeUndefined()

    expect(storeFor).toHaveBeenCalledTimes(2)
    expect(pass).toHaveBeenCalledTimes(1)
    expect(pass).toHaveBeenCalledWith(SQL_SECOND, SECOND)

    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain(FIRST.id)
    expect(logged).not.toContain('first-slug')
    expect(logged).not.toContain('catalogued-slug')
  })

  it('also isolates a tenant whose relay pass throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    const pass = vi.fn(async (_sql: Sql, tenant: TenantRef) => {
      seen.push(tenant.id)
      if (tenant.id === FIRST.id) throw new Error('boom')
    })
    await runRelayTick({ listTenants: async () => [FIRST, SECOND], storeFn: async () => SQL_SECOND, pass })
    expect(seen).toEqual([FIRST.id, SECOND.id])
  })

  it('does not swallow a listing failure (the caller\'s tick-level handler owns it)', async () => {
    const storeFor = vi.fn()
    await expect(
      runRelayTick({
        listTenants: async () => {
          throw new Error('catalog down')
        },
        storeFn: storeFor,
        pass: vi.fn(),
      }),
    ).rejects.toThrow('catalog down')
    expect(storeFor).not.toHaveBeenCalled()
  })
})

describe('index.ts wiring', () => {
  it('drives the relay interval through runRelayTick, not an inline per-tenant loop', () => {
    const src = fs.readFileSync(INDEX_TS, 'utf8')
    const interval = src.slice(src.indexOf('relayTimer = setInterval('))
    const body = interval.slice(0, interval.indexOf('}, RELAY_INTERVAL_MS)'))
    expect(body).toContain('runRelayTick(')
    expect(body).not.toMatch(/for \(const tenant of/)
  })
})
