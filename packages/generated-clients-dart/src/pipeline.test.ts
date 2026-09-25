// The pipeline's fail-closed guards, driven by FAKE tools (no Docker): a
// generator or build step that "succeeds" without producing what it should
// must fail the run, never yield a package.
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { makeFixtureRepo, writeFile } from './fixture.ts'
import { generateDartPackage, type PipelineOptions } from './pipeline.ts'
import { loadDartSurfaces, SCRATCH_ROOT } from './registry.ts'
import type { RunOpts, Tool } from './tools.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

interface Knobs {
  files?: string[] | null // manifest entries; null = no FILES written
  unwritten?: string[] // listed in FILES but not written
  gdart?: string[] // what build_runner writes
  pubExtra?: string // an extra file pub get writes
  model?: string // content of lib/src/model/a.dart
  analyze?: string
  analyzeFails?: boolean
}

function fakeTools(k: Knobs = {}) {
  const calls: string[][] = []
  const w = (o: RunOpts, rel: string, text: string) => {
    const p = join(o.workDir, o.cwd ?? '.', rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  const generator: Tool = {
    describe: 'fake-generator', kind: 'path',
    run(args, o) {
      calls.push(['gen', ...args, `network=${o.network}`])
      const files = k.files === undefined ? ['pubspec.yaml', 'analysis_options.yaml', 'lib/x_client.dart', 'lib/src/model/a.dart'] : k.files
      for (const f of files ?? []) {
        if (k.unwritten?.includes(f)) continue
        w({ ...o, cwd: 'out' }, f, f === 'lib/src/model/a.dart' ? (k.model ?? "part 'a.g.dart';\n") : f === 'analysis_options.yaml' ? 'analyzer:\n  exclude:\n    - test/*.dart\n' : `// ${f}\n`)
      }
      if (files !== null) w({ ...o, cwd: 'out' }, '.openapi-generator/FILES', files.map((f) => `${f}\n`).join(''))
      w({ ...o, cwd: 'out' }, '.openapi-generator/VERSION', '7.12.0\n')
      return ''
    },
  }
  const dart: Tool = {
    describe: 'fake-dart', kind: 'path',
    run(args, o) {
      calls.push(['dart', ...args])
      if (args[0] === 'pub') {
        if (!existsSync(join(o.workDir, 'out', 'pubspec.lock'))) w(o, 'pubspec.lock', 'packages: {}\n')
        if (k.pubExtra) w(o, k.pubExtra, 'x')
      } else if (args[0] === 'run') {
        for (const g of k.gdart ?? ['lib/src/model/a.g.dart']) w(o, g, '// g\n')
      } else if (args[0] === 'analyze') {
        if (k.analyzeFails) throw new Error(k.analyze ?? 'exited 3')
        return k.analyze ?? 'Analyzing out...\nNo issues found!\n'
      }
      return ''
    },
  }
  return { tools: { generator, dart }, calls }
}

function run(k: Knobs = {}, opts: PipelineOptions = {}, before?: (root: string) => void) {
  const root = makeFixtureRepo([{ name: 'widgets', type: 'openapi' }])
  roots.push(root)
  before?.(root)
  const [s] = loadDartSurfaces(root).surfaces
  const { tools, calls } = fakeTools(k)
  return { run: () => generateDartPackage(root, s, tools, opts), calls, root }
}

describe('generateDartPackage with fake tools', () => {
  it('happy path: manifest + meta + overlay + lock + build outputs, nothing else', () => {
    const r = run()
    expect([...r.run().keys()].sort()).toEqual([
      '.generated-from', '.gitattributes', '.gitignore', '.openapi-generator-ignore', '.openapi-generator/FILES', '.openapi-generator/VERSION',
      'analysis_options.yaml', 'lib/src/model/a.dart', 'lib/src/model/a.g.dart', 'lib/x_client.dart', 'pubspec.lock', 'pubspec.yaml',
    ])
  })

  it('passes the pinned generator options, offline', () => {
    const r = run()
    r.run()
    const gen = r.calls.find((c) => c[0] === 'gen')!.join(' ')
    expect(gen).toContain('-g dart-dio')
    expect(gen).toContain('apiTests=false,modelTests=false,apiDocs=false,modelDocs=false')
    expect(gen).toMatch(/enumUnknownDefaultCase=true/)
    expect(gen).toMatch(/pubPublishTo=none/)
    expect(gen).toContain('network=false')
  })

  it('lock mode: the check enforces the committed lock, the writer may update it', () => {
    const seed = (root: string) => writeFile(root, 'packages/generated-clients-dart/widgets/pubspec.lock', 'packages: {}\n')
    const enforce = run({}, { lockMode: 'enforce' }, seed)
    enforce.run()
    expect(enforce.calls.find((c) => c[1] === 'pub')).toEqual(['dart', 'pub', 'get', '--enforce-lockfile'])
    const update = run({}, { lockMode: 'update' }, seed)
    update.run()
    expect(update.calls.find((c) => c[1] === 'pub')).toEqual(['dart', 'pub', 'get'])
  })

  it.each<[string, Knobs, RegExp]>([
    ['no .openapi-generator/FILES', { files: null }, /FILES/],
    ['an empty manifest', { files: [] }, /empty/],
    ['a manifest entry the generator did not write', { unwritten: ['lib/x_client.dart'] }, /lib\/x_client\.dart/],
    ['build_runner writing nothing', { gdart: [] }, /no \*\.g\.dart/],
    ['build_runner writing a non-.g.dart file', { gdart: ['lib/src/model/a.g.dart', 'lib/extra.dart'] }, /lib\/extra\.dart/],
    ['an unaccounted file', { pubExtra: 'stray.txt' }, /unaccounted \[stray\.txt\]/],
    ['a generated string "null" default', { model: "part 'a.g.dart';\n  static void _defaults(ABuilder b) => b..parentId = 'null';\n" }, /'null'/],
    ['an analyze error', { analyzeFails: true, analyze: "error - lib/a.dart:1:1 - x - y\n1 issue found.\n" }, /analyze gate failed/],
  ])('fails closed on %s', (_n, k, re) => {
    expect(run(k).run).toThrow(re)
  })

  it('removes its staging dir on failure', () => {
    const mine = () => readdirSync(SCRATCH_ROOT).filter((d) => d.startsWith(`widgets-${process.pid}-`))
    const before = mine().length
    expect(run({ files: null }).run).toThrow()
    expect(mine().length).toBe(before)
  })
})
