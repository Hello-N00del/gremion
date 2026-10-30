// Tenant delete wires the newsletter + calendar leaf shred from
// provisioner/leaf-shred.ts (PG-free). A source scan, because cmdDelete is a CLI
// one-shot that talks to KC and PG; the executors themselves are proven against
// a real Postgres in tests/leaf-shred/leaf-shred.pg.test.ts and the ordering in
// lifecycle.test.ts. This pins that scripts/tenant-provision.ts does not grow an
// inline executor again (the original inline copy dropped without FORCE and
// deleted the catalog row on the admin database).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const UI = join(__dirname, '..', '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(join(UI, rel), 'utf-8').replace(/\r\n/g, '\n')

describe('cmdDelete wires the leaf-shred.ts executors', () => {
  it('imports both executors from provisioner/leaf-shred and builds them from the leaf admin urls', () => {
    const code = read('scripts/tenant-provision.ts')
    expect(code).toMatch(
      /import \{\s*makeNewsletterLeafShredExecutor,\s*makeCalendarLeafShredExecutor,\s*\} from '\.\.\/src\/lib\/server\/tenant\/provisioner\/leaf-shred'/,
    )
    expect(code).toMatch(/makeNewsletterLeafShredExecutor\(\{ adminUrl: leafUrl \}\)/)
    expect(code).toMatch(/makeCalendarLeafShredExecutor\(\{ adminUrl: leafUrl \}\)/)
    expect(code).toMatch(/process\.env\.NEWSLETTER_PG_URL/)
    expect(code).toMatch(/process\.env\.CALENDAR_PG_URL/)
  })

  it('hands both executors to deleteTenant', () => {
    const code = read('scripts/tenant-provision.ts')
    expect(code).toMatch(/\.\.\.\(leaf \? \{ leaf \} : \{\}\)/)
    expect(code).toMatch(/\.\.\.\(calendarLeaf \? \{ calendar: calendarLeaf \} : \{\}\)/)
  })

  it('keeps no inline leaf DROP DATABASE or tenant_catalog DELETE in the script', () => {
    const code = read('scripts/tenant-provision.ts')
    expect(code).not.toMatch(/DROP DATABASE IF EXISTS "(newsletter|calendar)_/)
    expect(code).not.toMatch(/DELETE FROM tenant_catalog/)
  })

  it('the executors drop WITH (FORCE) and delete the catalog row in <prefix>control', () => {
    const code = read('src/lib/server/tenant/provisioner/leaf-shred.ts')
    expect(code).toMatch(/DROP DATABASE IF EXISTS "\$\{dbName\}" WITH \(FORCE\)/)
    expect(code).toMatch(/const controlDb = dbPrefix \+ 'control'/)
    expect(code).toMatch(/openSingle\(dbUrlFor\(opts\.adminUrl, controlDb\)\)/)
  })
})
