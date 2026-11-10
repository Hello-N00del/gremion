// The Code-Karte page: the load hands the status over, the template says what the operator needs to read.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const status = { ok: true, commit: '0123456789abcdef0123456789abcdef01234567', generatedFor: 'x', counts: { functions: 1, connections: 1 }, staleSteps: [], staleAreas: [], undescribedAreas: [], reason: null }
vi.mock('$lib/server/codemap', () => ({ readStatus: () => status }))

const { load } = await import('./+page.server')
const svelte = readFileSync(join(__dirname, '+page.svelte'), 'utf-8')
const layout = readFileSync(join(__dirname, '..', '+layout.svelte'), 'utf-8')

describe('the Code-Karte load', () => {
  it('hands the status to the page', async () => {
    expect(await load({} as never)).toEqual({ status })
  })
})

describe('the Code-Karte template', () => {
  it('has the heading, the full commit in <code>, and the stale summary in a <details>', () => {
    expect(svelte).toContain('<h1>Code-Karte</h1>')
    expect(svelte).toMatch(/<code>\{s\.commit\}<\/code>/)
    expect(svelte).toContain('<details')
    expect(svelte).toMatch(/staleSteps/)
    expect(svelte).toMatch(/staleAreas/)
  })

  it('shows a visible status notice with the reason when the map is not ok', () => {
    expect(svelte).toMatch(/role="status"/)
    expect(svelte).toMatch(/s\.reason/)
  })

  it('embeds the map in a sandboxed iframe with only scripts allowed', () => {
    expect(svelte).toMatch(/<iframe[^>]*src="\/codemap\/map"/s)
    expect(svelte).toMatch(/sandbox="allow-scripts"/)
    expect(svelte).toMatch(/<iframe[^>]*title=/s)
    expect(svelte).not.toMatch(/allow-same-origin/)
    expect(svelte).toMatch(/calc\(100vh - 14rem\)/)
    expect(svelte).toMatch(/min-height/)
  })

  it('shows the iframe only when the status is ok', () => {
    expect(svelte).toMatch(/\{#if !s\.ok\}[\s\S]*\{:else\}[\s\S]*<iframe/)
  })
})

describe('the shell navigation', () => {
  it('has one Code-Karte link after Betrieb', () => {
    expect(layout).toContain('<a href="/codemap">Code-Karte</a>')
    expect(layout.indexOf('<a href="/betrieb">Betrieb</a>')).toBeLessThan(layout.indexOf('<a href="/codemap">Code-Karte</a>'))
    expect(layout.match(/href="\/codemap"/g)).toHaveLength(1)
  })
})
