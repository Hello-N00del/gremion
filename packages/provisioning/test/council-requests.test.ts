// Module self-service, phase 1, Task 2: the constants of the council requester role.
// The role (gremion_ui_modules) may EXECUTE exactly the three council functions that
// migrations 0014 and 0016 create; COUNCIL_EXECUTES must name each of them once, spelled as
// regprocedure prints them, so the grant and the postcondition cannot drift from the SQL.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COUNCIL_EXECUTES, COUNCIL_REQUESTER_MARKER, COUNCIL_REQUESTER_ROLE } from '../src/index.ts'

const MIGRATIONS = new URL('../../tenant-store/src/lifecycle/platform-migrations/', import.meta.url)
const migration = (re: RegExp): string => {
  const f = readdirSync(MIGRATIONS).find((n) => re.test(n))
  if (!f) throw new Error(`the migration matching ${String(re)} is absent`)
  return readFileSync(new URL(f, MIGRATIONS), 'utf8')
}
const council = (): string => migration(/^\d{4}_plt_council_requests\.sql$/)
const karenz = (): string => migration(/^\d{4}_plt_module_karenz\.sql$/)

/** `name(a text, b uuid)` in CREATE FUNCTION -> `plt.name(text, uuid)` as regprocedure prints it. */
function createdSignatures(sql: string): string[] {
  const out: string[] = []
  for (const m of sql.matchAll(/CREATE FUNCTION\s+(plt\.[a-z_]+)\s*\(([^)]*)\)/g)) {
    const types = m[2]!
      .split(',')
      .map((p) => p.trim().replace(/^[a-z_]+\s+/, ''))
      .filter(Boolean)
    out.push(`${m[1]}(${types.join(', ')})`)
  }
  return out
}

describe('council requester constants', () => {
  it('names the marker and the login role', () => {
    expect(COUNCIL_REQUESTER_MARKER).toBe('plt_council_requester')
    expect(COUNCIL_REQUESTER_ROLE).toBe('gremion_ui_modules')
  })

  it('COUNCIL_EXECUTES lists each function once and every entry exists in 0014 or 0016', () => {
    expect(new Set(COUNCIL_EXECUTES).size).toBe(COUNCIL_EXECUTES.length)
    expect(COUNCIL_EXECUTES).toHaveLength(5)
    const created014 = createdSignatures(council())
    const created015 = createdSignatures(karenz())
    expect(created014).toHaveLength(3)
    expect(created015).toHaveLength(2)
    const created = [...created014, ...created015]
    for (const sig of COUNCIL_EXECUTES) expect(created, sig).toContain(sig)
    for (const sig of created) expect(COUNCIL_EXECUTES, sig).toContain(sig)
  })
})
