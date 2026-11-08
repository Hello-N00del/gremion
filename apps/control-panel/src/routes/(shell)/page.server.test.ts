// The customer list shows "<done> / <total> Schritte". The total is the number of provisioning step kinds
// (nine since the governance database), never a literal in the template: with a literal 8 a fully set-up
// customer read "9 / 8 Schritte" and one made before the governance server read "8 / 8", which looks complete.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/config', () => ({
  loadConfig: () => ({ ok: true, config: {} }),
  newCustomerDisabledReason: () => null,
}))
vi.mock('$lib/server/customers', async (orig) => ({
  ...(await orig<typeof import('$lib/server/customers')>()),
  platformDb: () => null,
  listCustomers: async () => [{ id: 'c1', slug: 'proof-a', host: null, status: 'active', stepsDone: 9 }],
}))
vi.mock('$lib/server/requests', async (orig) => ({ ...(await orig<typeof import('$lib/server/requests')>()), heartbeatAgeSeconds: async () => 1 }))

const { load } = await import('./+page.server')
const { EXECUTION_ORDER } = await import('$lib/server/customers')

describe('the customer list step total', () => {
  it('the load hands the page the number of step kinds', async () => {
    const data = (await load({} as never)) as { stepsTotal?: number }
    expect(data.stepsTotal).toBe(EXECUTION_ORDER.length)
    expect(data.stepsTotal).toBe(9)
  })

  it('the load hands it on every branch, so the template never reads undefined', () => {
    const src = readFileSync(join(__dirname, '+page.server.ts'), 'utf-8')
    expect(src.match(/stepsTotal/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('the template renders against the total and holds no literal denominator', () => {
    const svelte = readFileSync(join(__dirname, '+page.svelte'), 'utf-8')
    expect(svelte).toMatch(/data\.stepsTotal/)
    expect(svelte).not.toMatch(/\/\s*\d+\s*Schritte/)
  })
})
