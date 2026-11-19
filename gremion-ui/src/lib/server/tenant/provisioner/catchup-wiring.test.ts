// CD stage 1 (U6g): the enable-catch-up dump is wired where the provisioner really runs. scripts/tenant-provision.ts
// executes main() on import, so the live deps cannot be built in a test; this reads the file the way the CLI is
// written (as reconcile-wiring.test.ts does) and asserts the hops between the factory (packages/tenant-store,
// tested there) and the lifecycle that calls it:
//   - catchupDump is built from the process environment (GREMION_MIGRATION_DUMP_DIR and the owner uid are read there)
//     with the live release label and the live exporter;
//   - its upgradeHooks and its retire object are handed to the module lifecycle, under the names enableModule and
//     finalizeDue read (a lifecycle without them applies the pending files of an enable with no dump at all).
// Dropping either line leaves every behavioural test green, which is the defect this guards: nobody passed it.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'scripts', 'tenant-provision.ts')
// comments dropped (a commented-out line must not satisfy the scan)
const src = readFileSync(SCRIPT, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** The text of the call that starts with `opening` (which ends in `(`), up to its matching closing parenthesis. */
function callOf(opening: string): string {
  const start = src.indexOf(opening)
  expect(start, `${opening} not found in tenant-provision.ts`).toBeGreaterThanOrEqual(0)
  const open = start + opening.length - 1
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`${opening}: unbalanced parentheses`)
}

describe('tenant-provision.ts: the enable catch-up dump reaches the module lifecycle', () => {
  it('catchupDump is built once, from the process env, the live release and the live exporter', () => {
    expect([...src.matchAll(/[^\w.]catchupDump\(/g)].length).toBe(1)
    const call = callOf('const catchup = catchupDump(')
    expect(call).toMatch(/env:\s*process\.env\b/)
    expect(call).toMatch(/release:\s*env\.releaseRef\b/)
    expect(call).toMatch(/exporter[,\s]/)
    expect(call).toMatch(/pgUserFor:/)
  })

  it('the lifecycle handed to pgModules carries upgradeHooks and dumpRetire from that factory', () => {
    const call = callOf('modules: pgModules(')
    expect(call).toMatch(/lifecycle:\s*\{/)
    expect(call).toMatch(/\bupgradeHooks:\s*catchup\.upgradeHooks\b/)
    expect(call).toMatch(/\bdumpRetire:\s*catchup\.retire\b/)
  })
})
