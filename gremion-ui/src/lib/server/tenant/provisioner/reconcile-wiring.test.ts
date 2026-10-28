// TASK-033-a r1 MED: the reconcile verb's audit-append-only check is wired where the verb really
// runs. scripts/tenant-provision.ts executes main() on import, so reconcileOne cannot be imported;
// this reads the file the way the CLI is written and asserts the structure that makes the
// check unskippable:
//   - reconcileOne routes the realm report through reconcileKernelAudit (the DB-level check);
//   - reconcileRealmOnly (the realm check alone) is called from reconcileOne and from nowhere else;
//   - both reconcile paths (one tenant, --all) go through reconcileOne.
// reconcile.test.ts proves withKernelAuditCheck, customer-adapters.test.ts proves
// reconcileKernelAudit; this is the last hop between them and the CLI.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'scripts', 'tenant-provision.ts')
// comments dropped (a commented-out call must not satisfy the scan)
const src = readFileSync(SCRIPT, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** The text of `async function <name>(...) { ... }` up to its matching closing brace. */
function bodyOf(name: string): string {
  const start = src.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found in tenant-provision.ts`).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`function ${name}: unbalanced braces`)
}

describe('tenant-provision.ts: reconcile always carries the audit-append-only check', () => {
  it('reconcileOne passes the realm report through reconcileKernelAudit, with the verb mode', () => {
    const body = bodyOf('reconcileOne')
    expect(body).toMatch(/reconcileRealmOnly\(/)
    expect(body).toMatch(/reconcileKernelAudit\(\s*realm\s*,[^)]*tenant\.id\s*,\s*verifyOnly\s*\)/)
  })

  it('the realm-only reconcile is called from reconcileOne and nowhere else', () => {
    const callers = [...src.matchAll(/reconcileRealmOnly\(/g)].length
    // one definition + one call (in reconcileOne)
    expect(callers).toBe(2)
    expect(bodyOf('reconcileOne')).toMatch(/reconcileRealmOnly\(/)
    expect(src.replace(bodyOf('reconcileOne'), '')).not.toMatch(/await reconcileRealmOnly\(|return reconcileRealmOnly\(/)
  })

  it('the bare reconcileRealm library call lives only in reconcileRealmOnly', () => {
    expect([...src.matchAll(/[^\w.]reconcileRealm\(/g)].length).toBe(1)
    expect(bodyOf('reconcileRealmOnly')).toMatch(/reconcileRealm\(/)
  })

  it('both reconcile paths (--all and one tenant) go through reconcileOne', () => {
    const body = bodyOf('cmdReconcile')
    expect([...body.matchAll(/await reconcileOne\(/g)].length).toBe(2)
  })
})
