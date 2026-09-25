// Drift + hand-written-client checks, driven by an injected generator (brief
// §6 tests 1-4, 6 run without Docker/Java/Dart).
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { checkDartCodegenDrift } from './codegen-drift.ts'
import { fakeGenerate, makeFixtureRepo } from './fixture.ts'

const roots: string[] = []
function fixture(...a: Parameters<typeof makeFixtureRepo>): string {
  const r = makeFixtureRepo(...a)
  roots.push(r)
  return r
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

describe('test 1 — missing output', () => {
  it('names the surface whose package was never generated', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.includes('packages/generated-clients-dart/widgets') && /missing/.test(p))).toBe(true)
  })
})
