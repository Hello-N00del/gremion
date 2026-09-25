// The file sets the check compares and the writer syncs are COMMITTABLE
// files: in a git work tree, tracked + untracked-not-ignored (a force-added
// file under .dart_tool/ included); local ignored clutter is neither
// flagged nor deleted.
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { checkDartCodegenDrift } from './codegen-drift.ts'
import { fakeGenerate, makeFixtureRepo, writeFile } from './fixture.ts'
import { scanForHandWrittenClients } from './hand-client-scan.ts'
import { syncDartPackages } from './writer.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function gitFixture(): { root: string; git: (...a: string[]) => void } {
  const root = makeFixtureRepo([{ name: 'widgets', type: 'openapi' }])
  roots.push(root)
  const git = (...a: string[]) => expect(spawnSync('git', a, { cwd: root, encoding: 'utf8' }).status).toBe(0)
  git('init', '-q')
  writeFile(root, '.gitignore', '.DS_Store\nnode_modules/\n.gen-work/\n')
  syncDartPackages(root, fakeGenerate)
  return { root, git }
}

describe('committable file sets (git work tree)', () => {
  it('a force-added hand-written client under <surface>/.dart_tool/ is extra AND nobody exempts it', () => {
    const { root, git } = gitFixture()
    const rel = 'packages/generated-clients-dart/widgets/.dart_tool/hand_client.dart'
    writeFile(root, rel, "final r = dio.get('/api/widgets/$id');\n")
    git('add', '-f', rel)
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.startsWith(`${rel}: extra`))).toBe(true)
  })

  it('ignored local clutter (.DS_Store, build/, node_modules/) is neither flagged nor deleted', () => {
    const { root } = gitFixture()
    writeFile(root, 'packages/generated-clients-dart/widgets/.DS_Store', 'x')
    writeFile(root, 'packages/generated-clients-dart/widgets/build/cache.bin', 'x')
    writeFile(root, 'packages/generated-clients-dart/.DS_Store', 'x')
    writeFile(root, 'packages/generated-clients-dart/node_modules/.bin/x', 'x')
    expect(checkDartCodegenDrift(root, { generate: fakeGenerate }).problems).toEqual([])
    syncDartPackages(root, fakeGenerate)
    expect(existsSync(join(root, 'packages/generated-clients-dart/widgets/build/cache.bin'))).toBe(true)
  })

  it('an untracked, not-ignored stray file is still flagged', () => {
    const { root } = gitFixture()
    writeFile(root, 'packages/generated-clients-dart/widgets/lib/src/hand_client.dart', 'class H {}\n')
    expect(checkDartCodegenDrift(root, { generate: fakeGenerate }).problems.join('\n')).toMatch(/hand_client\.dart: extra/)
  })

  it('the scan still sees the tree (sanity for the exemption)', () => {
    const { root } = gitFixture()
    writeFile(root, 'apps/mobile/lib/x.dart', "const p = '/api/widgets/1';\n")
    expect(scanForHandWrittenClients(root).problems.join('\n')).toMatch(/apps\/mobile\/lib\/x\.dart/)
  })
})
