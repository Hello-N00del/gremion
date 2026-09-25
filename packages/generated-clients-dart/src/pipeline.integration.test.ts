// The ONE integration test that runs the real pinned toolchain (brief §6):
// openapi-generator 7.12.0 (dart-dio) -> dart pub get -> build_runner ->
// dart analyze, over a scratch spec that exercises both nullable spellings
// (OpenAPI 3.0 `nullable: true` and 3.1 `type: [..., "null"]`; the generator
// logs "OpenAPI 3.1 support is still in beta"). Then a deliberately malformed
// file in the same generated package must fail the analyze gate. No tool ->
// this FAILS (resolveGenerator/resolveDart throw); it never skips.
import { describe, it, expect, afterAll } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeFixtureRepo } from './fixture.ts'
import { generateDartPackage, runAnalyzeGate } from './pipeline.ts'
import { loadDartSurfaces } from './registry.ts'
import { resolveDart, resolveGenerator } from './tools.ts'
import { STAMP_FILE } from './codegen-drift.ts'

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'widgets', version: '2.3.4' },
  paths: {
    '/api/widgets/{id}': {
      get: {
        operationId: 'getWidget',
        tags: ['widgets'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Widget: {
        type: 'object',
        required: ['id', 'note', 'legacy', 'day', 'data'],
        properties: {
          id: { type: 'string' },
          note: { type: ['string', 'null'] },
          legacy: { type: 'string', nullable: true },
          count: { type: 'integer' },
          day: { type: 'string', format: 'date', nullable: true },
          data: { type: 'object', nullable: true },
        },
      },
    },
  },
}

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

describe('real pipeline (pinned generator + Dart SDK)', () => {
  it('generates an analyzable package with correct nullability, and the gate fails a malformed file', () => {
    const root = makeFixtureRepo([{ name: 'widgets', type: 'openapi', doc: SPEC }])
    roots.push(root)
    const [s] = loadDartSurfaces(root).surfaces
    const log: string[] = []
    const tools = { generator: resolveGenerator(), dart: resolveDart() }
    let kept = ''
    const files = generateDartPackage(root, s, tools, { log: (m) => log.push(m), keepWorkDir: (d) => { kept = d } })
    roots.push(kept)

    const names = [...files.keys()]
    expect(names).toEqual(expect.arrayContaining([
      '.openapi-generator/FILES', '.openapi-generator/VERSION', '.openapi-generator-ignore',
      '.gitattributes', '.gitignore', STAMP_FILE, 'analysis_options.yaml', 'pubspec.yaml', 'pubspec.lock',
      'lib/gremion_widgets_client.dart', 'lib/src/model/widget.dart', 'lib/src/model/widget.g.dart', 'lib/src/serializers.g.dart',
    ]))
    expect(names.some((n) => n.startsWith('test/') || n.startsWith('doc/'))).toBe(false)
    expect(files.get('.openapi-generator/VERSION')!.toString().trim()).toBe('7.12.0')
    expect(files.get('pubspec.yaml')!.toString()).toMatch(/^name: gremion_widgets_client$/m)
    expect(files.get('pubspec.yaml')!.toString()).toMatch(/^version: 2\.3\.4$/m)
    for (const [n, b] of files) expect(b.includes('\r\n'), `${n} has CRLF`).toBe(false)

    const model = files.get('lib/src/model/widget.dart')!.toString()
    expect(model).toMatch(/String get id;/)
    expect(model).toMatch(/String\? get note;/) // 3.1 type: [string, null]
    expect(model).toMatch(/String\? get legacy;/) // 3.0-style nullable: true
    expect(model).toMatch(/int\? get count;/) // optional
    expect(model).toMatch(/Date\? get day;/)
    expect(model).toMatch(/JsonObject\? get data;/)

    expect(log.join('\n')).toMatch(/dart analyze: 0 error\(s\)/)

    // Same generated package, one malformed file: the real analyzer must fail the gate.
    writeFileSync(join(kept, 'out', 'lib', 'src', 'broken.dart'), 'class {\n')
    expect(() => runAnalyzeGate(tools.dart, kept, 'out', () => {})).toThrow(/error - lib\/src\/broken\.dart/)
  }, 900_000)
})
