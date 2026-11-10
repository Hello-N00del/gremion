// The Code-Karte page: the load hands the status over, the template says what the operator needs to read.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const status = { ok: true, commit: '0123456789abcdef0123456789abcdef01234567', generatedFor: 'x', counts: { functions: 1, connections: 1 }, staleSteps: [], staleAreas: [], undescribedAreas: [], reason: null }
let current = status as typeof status | { ok: false; reason: string }
let mapCheck = { readable: true, reason: null as string | null }
const checkMap = vi.fn(() => mapCheck)
vi.mock('$lib/server/codemap', () => ({ readStatus: () => current, checkMap: () => checkMap() }))

const { load } = await import('./+page.server')
const svelte = readFileSync(join(__dirname, '+page.svelte'), 'utf-8')
const layout = readFileSync(join(__dirname, '..', '+layout.svelte'), 'utf-8')

describe('the Code-Karte load', () => {
  beforeEach(() => {
    current = status
    mapCheck = { readable: true, reason: null }
    checkMap.mockClear()
  })

  it('hands the status and the readability of the map page to the page', async () => {
    expect(await load({} as never)).toEqual({ status, map: { readable: true, reason: null } })
  })

  it('reports a map page that cannot be served, with its reason', async () => {
    mapCheck = { readable: false, reason: 'Die Seite der Code-Karte (code-map.html) fehlt in diesem Image.' }
    expect(await load({} as never)).toEqual({ status, map: mapCheck })
  })

  it('does not look at the map page when the status is not ok (the status already says why)', async () => {
    current = { ok: false, reason: 'extract failed' }
    const data = (await load({} as never)) as { map: { readable: boolean } }
    expect(checkMap).not.toHaveBeenCalled()
    expect(data.map.readable).toBe(false)
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

  it('shows the iframe only when the status is ok and the map page is readable', () => {
    expect(svelte).toMatch(/\{#if !s\.ok\}[\s\S]*\{:else\}[\s\S]*\{#if data\.map\.readable\}\s*<iframe/)
    expect(svelte.match(/<iframe/g)).toHaveLength(1)
  })

  it('shows a notice with the reason, and no iframe, when the status is ok but the map page is not readable', () => {
    expect(svelte).toMatch(/\{#if !data\.map\.readable\}[\s\S]*role="status"[\s\S]*data\.map\.reason/)
  })
})

describe('the shell navigation', () => {
  it('has one Code-Karte link after Betrieb', () => {
    expect(layout).toContain('<a href="/codemap">Code-Karte</a>')
    expect(layout.indexOf('<a href="/betrieb">Betrieb</a>')).toBeLessThan(layout.indexOf('<a href="/codemap">Code-Karte</a>'))
    expect(layout.match(/href="\/codemap"/g)).toHaveLength(1)
  })
})
