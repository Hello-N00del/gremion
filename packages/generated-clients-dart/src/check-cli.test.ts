// runCheck() is everything tools/check.mjs does except resolving the real
// tools, so its wiring (scan problems merged, real-tree vacuity mode, the
// summary) is unit-tested with a fake generator. Round-1 finding: the .mjs
// wiring was untested — dropping the scan from the merge passed every test.
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCheck } from './check-cli.ts'
import { fakeGenerate, makeFixtureRepo, MINI_SPEC, writeFile } from './fixture.ts'
import { scanForHandWrittenClients } from './hand-client-scan.ts'
import { syncDartPackages } from './writer.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function fixture(...a: Parameters<typeof makeFixtureRepo>): string {
  const r = makeFixtureRepo(...a)
  roots.push(r)
  return r
}

describe('runCheck', () => {
  it('OK on a clean generated tree, reporting N of M and what the scan looked at', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    syncDartPackages(root, fakeGenerate)
    writeFile(root, 'apps/mobile/lib/main.dart', 'void main() {}\n')
    const v = runCheck(root, fakeGenerate)
    expect(v.ok).toBe(true)
    expect(v.summary).toMatch(/1 of 1 registry surface/)
    expect(v.summary).toMatch(/scanned 1 Dart file\(s\) outside the surface packages against 1 path key\(s\)/)
  })

  it('merges hand-written-client problems into the verdict', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    syncDartPackages(root, fakeGenerate)
    writeFile(root, 'apps/mobile/lib/api/governance_client.dart', "dio.get('/api/widgets/$id');\n")
    const v = runCheck(root, fakeGenerate)
    expect(v.ok).toBe(false)
    expect(v.problems.join('\n')).toMatch(/apps\/mobile\/lib\/api\/governance_client\.dart: hand-written client/)
  })

  it('is in real-tree mode: 0 of 0 fails', () => {
    const root = fixture([{ name: 'events', type: 'asyncapi' }])
    expect(runCheck(root, fakeGenerate).ok).toBe(false)
  })
})

describe('scan evidence (real-tree mode)', () => {
  it('fails when the listing does not contain the generated entry libraries', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    syncDartPackages(root, fakeGenerate)
    expect(scanForHandWrittenClients(root, { dartFiles: [], requireEvidence: true }).problems.join('\n')).toMatch(/does not contain packages\/generated-clients-dart\/widgets\/lib\/gremion_widgets_client\.dart/)
  })

  it('fails when registered OpenAPI specs yield zero path keys', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi', doc: { ...MINI_SPEC, paths: {} } }])
    syncDartPackages(root, fakeGenerate)
    expect(scanForHandWrittenClients(root, { requireEvidence: true }).problems.join('\n')).toMatch(/0 path keys/)
  })
})
