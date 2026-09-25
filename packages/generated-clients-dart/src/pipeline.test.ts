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
  enforceFails?: boolean // pub get --enforce-lockfile exits non-zero
  newLock?: string // what a plain pub get writes over the lock
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
        if (args.includes('--enforce-lockfile') && k.enforceFails) throw new Error('fake-dart pub get exited 65:\nWarning: lockfile does not satisfy pubspec')
        if (!args.includes('--enforce-lockfile') && k.newLock !== undefined) w(o, 'pubspec.lock', k.newLock)
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

  const LOCK = (v: string, h: string) => `packages:\n  dio:\n    dependency: "direct main"\n    description:\n      name: dio\n      sha256: "${h}"\n      url: "https://pub.dev"\n    source: hosted\n    version: "${v}"\n`
  const seed = (root: string) => writeFile(root, 'packages/generated-clients-dart/widgets/pubspec.lock', LOCK('5.0.0', 'aaa'))
  const pubCalls = (calls: string[][]) => calls.filter((c) => c[1] === 'pub').map((c) => c.slice(1).join(' '))

  it('lock mode enforce (the check): pub get --enforce-lockfile against the committed lock', () => {
    const r = run({}, { lockMode: 'enforce' }, seed)
    r.run()
    expect(pubCalls(r.calls)).toEqual(['pub get --enforce-lockfile'])
  })

  it('lock mode update (the writer): enforce first, and only a failing enforce falls back to plain pub get', () => {
    const ok = run({}, { lockMode: 'update' }, seed)
    ok.run()
    expect(pubCalls(ok.calls)).toEqual(['pub get --enforce-lockfile'])
    const bump = run({ enforceFails: true, newLock: LOCK('5.1.0', 'bbb') }, { lockMode: 'update' }, seed)
    expect(bump.run().get('pubspec.lock')!.toString()).toContain('5.1.0')
    expect(pubCalls(bump.calls)).toEqual(['pub get --enforce-lockfile', 'pub get'])
  })

  it('lock mode update refuses a package whose version stayed but whose content hash changed', () => {
    const r = run({ enforceFails: true, newLock: LOCK('5.0.0', 'ccc') }, { lockMode: 'update' }, seed)
    expect(r.run).toThrow(/dio 5\.0\.0.*sha256 changed/)
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
