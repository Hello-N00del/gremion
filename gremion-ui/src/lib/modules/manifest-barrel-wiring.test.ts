import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// WHY THIS EXISTS (CI "Integration Tests (DB)" / "Apply migrations" break, 2026-10-27):
// manifests/index.generated.ts is COMMITTED and names every enabled module's manifest, but
// those manifests (elections, votes, newsletter, calendar, files, messages, board) are NOT
// committed: they are gitignored copies produced by scripts/interim-module-overlay.mjs from
// modules/<id>/app. Anything that loads the barrel outside Vite on a clean clone must run
// the overlay first. `pnpm migrate:test-fixture` loads it (fleet.ts -> registry) and had no
// overlay, so a fresh checkout died with ERR_MODULE_NOT_FOUND on './elections'. It passed on
// every developer machine because an earlier build/test had already left the copies behind.
// This test runs after pretest:unit's overlay, so it asserts the post-condition on disk.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MANIFESTS_DIR = join(PKG_ROOT, 'src', 'lib', 'modules', 'manifests')
const BARREL = join(MANIFESTS_DIR, 'index.generated.ts')

const importedManifests = [...readFileSync(BARREL, 'utf8').matchAll(/^import \{[^}]+\} from '\.\/([^']+)'$/gm)].map((m) => m[1])

describe('manifests/index.generated.ts names only manifests that exist', () => {
  it('the guard sees the barrel imports (not vacuous)', () => {
    expect(importedManifests.length).toBeGreaterThanOrEqual(9)
    expect(importedManifests).toContain('core')
    expect(importedManifests).toContain('elections')
  })

  it('every manifest the barrel imports resolves to a file next to it (after the overlay)', () => {
    const missing = importedManifests.filter((id) => !existsSync(join(MANIFESTS_DIR, `${id}.ts`)))
    expect(missing, `index.generated.ts imports ./${missing.join(', ./')} but no such file exists: run node scripts/interim-module-overlay.mjs, or regenerate the barrel with node scripts/build-module-manifest.mjs`).toEqual([])
  })
})

describe('a script that loads the manifest barrel outside Vite overlays the modules first', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

  it('premigrate:test-fixture runs the module overlay (CI "Apply migrations" runs on a clean clone)', () => {
    expect(pkg.scripts['migrate:test-fixture']).toContain('migrate-test-fixture.mjs')
    expect(pkg.scripts['premigrate:test-fixture']).toContain('interim-module-overlay.mjs')
  })
})
