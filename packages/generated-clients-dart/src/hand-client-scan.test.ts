// Test 2c: a hand-written Dart client of a specified surface anywhere outside
// the generated surface packages (apps/mobile/** included) is named.
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { makeFixtureRepo, MINI_SPEC, writeFile } from './fixture.ts'
import { spawnSync } from 'node:child_process'
import { listDartFiles, pathKeyPattern, scanForHandWrittenClients } from './hand-client-scan.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function fixture(): string {
  const r = makeFixtureRepo([
    { name: 'widgets', type: 'openapi' },
    { name: 'legacy', type: 'openapi', status: 'deprecated', doc: { ...MINI_SPEC, paths: { '/api/legacy/items': {} } } },
    { name: 'events', type: 'asyncapi' },
  ])
  roots.push(r)
  return r
}

describe('pathKeyPattern', () => {
  const re = pathKeyPattern('/api/widgets/{id}')
  it.each([
    ["'/api/widgets/{id}'"],
    ["'/api/widgets/$id'"],
    ["'/api/widgets/${w.id}'"],
    ["'$base/api/widgets/$id?x=1'"],
    ["Uri.parse('https://h/api/widgets/42')"],
  ])('matches %s', (text) => expect(re.test(text)).toBe(true))
  it.each([
    ["'/api/widgetsX/1'"],
    ["'/api/widgets'"],
    ["'/api/widgets/1/parts'"],
  ])('does not match %s', (text) => expect(re.test(text)).toBe(false))
})

describe('scanForHandWrittenClients', () => {
  it('names apps/mobile/lib/api/governance_client.dart calling a spec path', () => {
    const root = fixture()
    writeFile(root, 'apps/mobile/lib/api/governance_client.dart', "final r = dio.get('/api/widgets/$id');\n")
    const { problems } = scanForHandWrittenClients(root)
    expect(problems.some((p) => p.startsWith('apps/mobile/lib/api/governance_client.dart:') && p.includes('/api/widgets/{id}'))).toBe(true)
  })

  it('covers every registered OpenAPI spec, not only active ones', () => {
    const root = fixture()
    writeFile(root, 'tool/x.dart', "const p = '/api/legacy/items';\n")
    expect(scanForHandWrittenClients(root).problems.join('\n')).toMatch(/tool\/x\.dart:.*\/api\/legacy\/items/)
  })

  it('passes a Dart file that names no spec path, and generated surface packages', () => {
    const root = fixture()
    writeFile(root, 'apps/mobile/lib/main.dart', "void main() => print('/api/other');\n")
    writeFile(root, 'packages/generated-clients-dart/widgets/lib/src/api.dart', "const p = r'/api/widgets/{id}';\n")
    expect(scanForHandWrittenClients(root).problems).toEqual([])
  })

  it('does scan Dart outside a surface directory even under packages/generated-clients-dart/', () => {
    const root = fixture()
    writeFile(root, 'packages/generated-clients-dart/widgets-extra/x.dart', "const p = '/api/widgets/1';\n")
    expect(scanForHandWrittenClients(root).problems.join('\n')).toMatch(/widgets-extra\/x\.dart/)
  })
})

describe('listDartFiles in a git work tree', () => {
  it('lists tracked and untracked Dart files, not ignored ones', () => {
    const root = fixture()
    const git = (...a: string[]) => expect(spawnSync('git', a, { cwd: root }).status).toBe(0)
    git('init', '-q')
    writeFile(root, '.gitignore', 'ignored/\n')
    writeFile(root, 'tracked/a.dart', '')
    writeFile(root, 'ignored/b.dart', '')
    git('add', 'tracked/a.dart')
    writeFile(root, 'untracked/c.dart', '')
    expect(listDartFiles(root)).toEqual(['tracked/a.dart', 'untracked/c.dart'])
  })
})
