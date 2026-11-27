// @vitest-environment node
// searchProtocols: the SQL itself is proven against a real Postgres by protocols-db.search.integration.test.ts
// (wildcards typed into the query match only themselves, markup is not searched, blanks collapse, the date
// matches as DD.MM.YYYY and as YYYY-MM-DD). What this unit test pins is the pattern the query is turned
// into and that every LIKE carries the ESCAPE clause that pattern relies on.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const h = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('$lib/server/db', () => ({
  getDb: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push([strings.join('?'), ...values])
    return Promise.resolve([])
  },
}))

import { containsPattern, searchProtocols } from './protocols-db'

describe('containsPattern', () => {
  it('wraps the text so it matches anywhere', () => {
    expect(containsPattern('haushalt')).toBe('%haushalt%')
  })

  it('escapes the characters LIKE treats specially, so they only match themselves', () => {
    expect(containsPattern('100%')).toBe('%100\\%%')
    expect(containsPattern('a_b')).toBe('%a\\_b%')
    expect(containsPattern('a\\b')).toBe('%a\\\\b%')
    expect(containsPattern('%_\\')).toBe('%\\%\\_\\\\%')
  })
})

describe('searchProtocols', () => {
  it('sends the escaped pattern and the limit as parameters, never inside the statement', async () => {
    h.calls.length = 0
    await searchProtocols('50%_x', 200)
    const [text, ...values] = h.calls[0]!
    expect(values).toEqual(['%50\\%\\_x%', '%50\\%\\_x%', '%50\\%\\_x%', '%50\\%\\_x%', 200])
    expect(String(text)).not.toContain('50')
  })

  it('every ILIKE carries the ESCAPE clause the pattern relies on', () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'protocols-db.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function searchProtocols'))
    const ilikes = body.match(/ILIKE \$\{pattern\}[^\n]*/g) ?? []
    expect(ilikes).toHaveLength(4)
    for (const line of ilikes) expect(line).toContain("ESCAPE '\\\\'")
  })
})
