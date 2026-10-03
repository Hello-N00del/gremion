import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Collected guard for the route seam. The sibling app/lib/server/content/backend/route-parity.test.ts
// only runs after the module overlay (app/lib -> src/lib, app/routes -> src/routes) is applied onto a
// gremion-ui tree; in this module tree its root resolves to modules/content, finds no src/routes, and
// passes having scanned nothing. This copy resolves the roots inside app/ and refuses to run on nothing.

const moduleRoot = join(fileURLToPath(import.meta.url), '..', '..')
const appRoot = join(moduleRoot, 'app')

// No existsSync early return: a missing root must THROW, never yield an empty (vacuously green) scan.
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

describe('content routes go through the backend seam (collected in the module tree)', () => {
  it('no +server.ts/+page.server.ts under app/routes/api/content or app/routes/content imports content-db directly', () => {
    const roots = [join(appRoot, 'routes', 'api', 'content'), join(appRoot, 'routes', 'content')]
    const files: string[] = []
    for (const root of roots) {
      for (const abs of walk(root)) {
        const rel = relative(moduleRoot, abs).split('\\').join('/')
        if (rel.endsWith('+server.ts') || rel.endsWith('+page.server.ts')) files.push(rel)
      }
    }
    // Non-vacuity floor: today 10 api + 6 page = 16 route files. 10 tolerates a few deletions but not an empty scan.
    expect(files.length).toBeGreaterThanOrEqual(10)
    const offenders = files.filter((f) =>
      /from ['"][^'"]*content\/content-db['"]/.test(readFileSync(join(moduleRoot, f), 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
