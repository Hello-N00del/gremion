// packages/generated-clients-dart/src/pipeline.ts
//
// The real GenerateFn: one pure-in-effect function used by BOTH the writer
// (tools/generate.mjs) and the check (tools/check.mjs). Two implementations
// would themselves be the drift the check exists to catch. Per surface:
//
//   openapi-generator (dart-dio) -> overlay -> dart pub get (against the
//   committed pubspec.lock) -> dart run build_runner build -> dart analyze gate
//
// Generator-only output is not a deliverable: the package is returned only if
// it analyzes with zero errors. The file set returned is asserted equal to
// the generator's own manifest (.openapi-generator/FILES) plus the
// build_runner outputs plus the fixed overlay, so an unaccounted file (from a
// tool change) fails here instead of being committed unnoticed.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAnalysisOptions, checkIgnoreComments, evaluateAnalyze } from './analyze-gate.ts'
import { byPath, listPackageFiles, specStamp, STAMP_FILE, type GeneratedFiles, type GenerateFn } from './codegen-drift.ts'
import { normalizeFor31 } from './spec-normalize.ts'
import { DART_PACKAGES_DIR, SCRATCH_ROOT, type DartSurface } from './registry.ts'
import type { Tool } from './tools.ts'

export interface PipelineTools { generator: Tool; dart: Tool }
export interface PipelineOptions {
  log?: (m: string) => void
  /** test hook: keep the staging dir and hand its path over (caller removes it) */
  keepWorkDir?: (dir: string) => void
}

/** Written into the staging output dir BEFORE the generator runs, so the
 *  generator honours it. test/** and doc/** are also switched off by
 *  --global-property; this file is the second, independent guard. */
export const GENERATOR_IGNORE = [
  '# Owned by packages/generated-clients-dart/src/pipeline.ts (GENERATOR_IGNORE).',
  '# Keeps tests and docs out of the generated package, and keeps the',
  '# generator .gitignore (which ignores pubspec.lock) out: the lock is committed.',
  'test/**',
  'doc/**',
  '.gitignore',
  '',
].join('\n')

const OVERLAY: Record<string, string> = {
  '.gitattributes': '# Generated output is compared byte for byte; keep LF on every platform.\n* text eol=lf\n',
  '.gitignore': '# pub/build_runner caches. pubspec.lock and the *.g.dart files ARE committed.\n.dart_tool/\nbuild/\n',
}

const GENERATOR_META = ['.openapi-generator/FILES', '.openapi-generator/VERSION', '.openapi-generator-ignore']
const HOMEPAGE = 'https://github.com/Hello-N00del/gremion'

function lf(buf: Buffer): Buffer {
  return buf.includes('\r\n') ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n')) : buf
}

/** The committed lock of this surface if there is one; otherwise the lock
 *  of the first committed surface (every package has the same template
 *  dependencies), so a newly registered surface resolves to the same
 *  versions instead of whatever pub.dev serves that day. */
function seedLock(repoRoot: string, s: DartSurface): { path: string; own: boolean } | null {
  const own = join(repoRoot, s.packageDir, 'pubspec.lock')
  if (existsSync(own)) return { path: own, own: true }
  const root = join(repoRoot, DART_PACKAGES_DIR)
  if (!existsSync(root)) return null
  for (const name of readdirSync(root).sort(byPath)) {
    const p = join(root, name, 'pubspec.lock')
    if (name !== s.name && existsSync(p) && existsSync(join(root, name, STAMP_FILE))) return { path: p, own: false }
  }
  return null
}

export function runAnalyzeGate(dart: Tool, workDir: string, cwd: string, log: (m: string) => void): void {
  let output: string
  let exitOk = true
  try {
    output = dart.run(['analyze', '--no-fatal-warnings'], { workDir, cwd, network: false })
  } catch (e) {
    exitOk = false
    output = (e as Error).message
  }
  const v = evaluateAnalyze({ exitOk, output })
  log(`dart analyze: ${v.errors} error(s), ${v.warnings} warning(s), ${v.infos} info(s)`)
  for (const l of output.split('\n')) if (/^\s*warning - /.test(l)) log(`  ${l.trim()}`)
  if (!v.ok) throw new Error(`analyze gate failed:\n${v.problems.map((p) => `  - ${p}`).join('\n')}`)
}

export function generateDartPackage(repoRoot: string, s: DartSurface, tools: PipelineTools, opts: PipelineOptions = {}): GeneratedFiles {
  const log = opts.log ?? (() => {})
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  const work = mkdtempSync(join(SCRATCH_ROOT, `${s.name}-${process.pid}-`))
  let keep = false
  try {
    const specText = readFileSync(join(repoRoot, s.specFile), 'utf8').replace(/\r\n/g, '\n')
    const parsed = JSON.parse(specText) as { info?: { version?: unknown } }
    const version = parsed.info?.version
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`${s.specFile}: info.version ${JSON.stringify(version)} is not x.y.z — it becomes the pub package version`)
    }
    mkdirSync(join(work, 'in'))
    mkdirSync(join(work, 'out'))
    const { doc, report } = normalizeFor31(parsed)
    log(`[${s.name}] generator input (src/spec-normalize.ts): ${report.nullable.length} nullable -> type array, ${report.nullableFalseDropped.length} nullable:false dropped, ${report.defaultNullDropped.length} default:null dropped, ${report.constTyped.length} const typed`)
    writeFileSync(join(work, 'in', 'spec.json'), `${JSON.stringify(doc, null, 2)}\n`)
    writeFileSync(join(work, 'out', '.openapi-generator-ignore'), GENERATOR_IGNORE)

    log(`[${s.name}] openapi-generator via ${tools.generator.describe}`)
    const genOut = tools.generator.run([
      'generate', '-g', 'dart-dio', '-i', 'in/spec.json', '-o', 'out',
      '--global-property', 'apiTests=false,modelTests=false,apiDocs=false,modelDocs=false',
      '--additional-properties', [
        `pubName=${s.pubName}`,
        `pubVersion=${version}`,
        `pubDescription=Generated Dart client for the ${s.name} surface (${s.specFile}). Do not edit by hand.`,
        `pubHomepage=${HOMEPAGE}`,
        'serializationLibrary=built_value',
        'dateLibrary=core',
      ].join(','),
    ], { workDir: work, network: false })
    for (const l of genOut.split('\n')) if (/\bWARN\b/.test(l) && !/Empty operationId/.test(l)) log(`  generator: ${l.trim()}`)

    const out = join(work, 'out')
    const filesManifest = join(out, '.openapi-generator', 'FILES')
    if (!existsSync(filesManifest)) throw new Error('openapi-generator wrote no .openapi-generator/FILES — it did not generate')
    const manifest = readFileSync(filesManifest, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    if (manifest.length === 0) throw new Error('openapi-generator manifest .openapi-generator/FILES is empty')
    for (const f of manifest) if (!existsSync(join(out, f))) throw new Error(`openapi-generator manifest lists ${f}, which it did not write`)

    for (const [rel, text] of Object.entries(OVERLAY)) writeFileSync(join(out, rel), text)
    writeFileSync(join(out, STAMP_FILE), specStamp(repoRoot, s))

    const analysisOptions = join(out, 'analysis_options.yaml')
    const aoProblems = existsSync(analysisOptions) ? checkAnalysisOptions(readFileSync(analysisOptions, 'utf8')) : []
    if (aoProblems.length > 0) throw new Error(aoProblems.join('\n'))

    const lock = seedLock(repoRoot, s)
    if (lock) copyFileSync(lock.path, join(out, 'pubspec.lock'))
    const pubArgs = lock?.own ? ['pub', 'get', '--enforce-lockfile'] : ['pub', 'get']
    log(`[${s.name}] dart ${pubArgs.join(' ')} via ${tools.dart.describe}${lock ? (lock.own ? ' (committed lock)' : ' (lock seeded from another surface)') : ' (no lock yet: fresh resolution)'}`)
    tools.dart.run(pubArgs, { workDir: work, cwd: 'out' })

    const beforeBuild = new Set(listPackageFiles(out))
    log(`[${s.name}] dart run build_runner build --delete-conflicting-outputs`)
    tools.dart.run(['run', 'build_runner', 'build', '--delete-conflicting-outputs'], { workDir: work, cwd: 'out', network: false })
    const buildOutputs = listPackageFiles(out).filter((f) => !beforeBuild.has(f))
    const notGDart = buildOutputs.filter((f) => !f.endsWith('.g.dart'))
    if (notGDart.length > 0) throw new Error(`build_runner wrote files other than *.g.dart: ${notGDart.join(', ')}`)
    if (buildOutputs.length === 0) throw new Error('build_runner wrote no *.g.dart — built_value models were not built')

    log(`[${s.name}] dart analyze --no-fatal-warnings`)
    runAnalyzeGate(tools.dart, work, 'out', log)

    const files: GeneratedFiles = new Map()
    for (const rel of listPackageFiles(out)) files.set(rel, lf(readFileSync(join(out, rel))))

    const accounted = new Set([...manifest, ...GENERATOR_META, ...buildOutputs, ...Object.keys(OVERLAY), STAMP_FILE, 'pubspec.lock'])
    const unaccounted = [...files.keys()].filter((f) => !accounted.has(f))
    const absent = [...accounted].filter((f) => !files.has(f))
    if (unaccounted.length > 0 || absent.length > 0) {
      throw new Error(`generated file set does not match the generator manifest + build_runner outputs + overlay: unaccounted [${unaccounted.join(', ')}], absent [${absent.join(', ')}]`)
    }
    const ignoreProblems = checkIgnoreComments(files)
    if (ignoreProblems.length > 0) throw new Error(ignoreProblems.join('\n'))
    log(`[${s.name}] ${files.size} files (${manifest.length} generator, ${buildOutputs.length} build_runner)`)
    if (opts.keepWorkDir) {
      keep = true
      opts.keepWorkDir(work)
    }
    return files
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true })
  }
}

export function realGenerate(tools: PipelineTools, log?: (m: string) => void): GenerateFn {
  return (repoRoot, s) => generateDartPackage(repoRoot, s, tools, { log })
}
