// packages/generated-clients-dart/src/codegen-drift.ts
//
// The read side of the Dart codegen (the write side is tools/generate.mjs).
// Mirrors packages/generated-clients/src/codegen-drift.ts, extended from one
// file per client to the WHOLE file set of each surface package: the check
// regenerates every surface through the same injected `generate` function
// the writer uses and compares the result with what is on disk.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DART_PACKAGES_DIR, loadDartSurfaces, type DartSurface } from './registry.ts'

/** package-relative, forward-slash path → exact bytes */
export type GeneratedFiles = Map<string, Buffer>
export type GenerateFn = (repoRoot: string, surface: DartSurface) => GeneratedFiles

export interface DriftResult {
  problems: string[]
  /** N: surfaces compared end to end */
  checked: number
  /** M: openapi+active registry entries */
  expected: number
}

const REGENERATE = 'Run `pnpm --filter @gremion/generated-clients-dart generate`; never edit generated files by hand.'

/** Code-unit order, independent of the host locale. */
export function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The Node write/check side that shares packages/generated-clients-dart/
 *  with the surface packages. Every other top-level entry must be a
 *  registered surface. */
const NODE_SIDE = new Set(['.gitignore', 'README.md', 'package.json', 'tsconfig.json', 'vitest.config.ts', 'src', 'tools', 'node_modules', '.gen-work'])
/** Node-side dirs whose content is ours and must hold no Dart. */
const NODE_SOURCE_DIRS = ['src', 'tools']

/** Every file under `dir` (package-relative, forward-slash), skipping only
 *  `.dart_tool/` at the package root — pub's cache, never committed. A
 *  symlink is listed as a file, never followed. */
export function listPackageFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      if (rel === '' && name === '.dart_tool') continue
      const childAbs = join(abs, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (lstatSync(childAbs).isDirectory()) walk(childAbs, childRel)
      else out.push(childRel)
    }
  }
  walk(dir, '')
  return out.sort(byPath)
}

export interface DriftOptions {
  generate: GenerateFn
}

export function checkDartCodegenDrift(repoRoot: string, opts: DriftOptions): DriftResult {
  const problems: string[] = []
  const { surfaces } = loadDartSurfaces(repoRoot)
  let checked = 0
  for (const s of surfaces) {
    if (!existsSync(join(repoRoot, s.packageDir))) {
      problems.push(`${s.packageDir}: missing output — no Dart package for registry surface "${s.name}" (spec ${s.specFile}). Run \`pnpm --filter @gremion/generated-clients-dart generate\`.`)
      continue
    }
    let expectedFiles: GeneratedFiles
    try {
      expectedFiles = opts.generate(repoRoot, s)
    } catch (e) {
      problems.push(`${s.packageDir}: generating surface "${s.name}" from ${s.specFile} failed: ${(e as Error).message}`)
      continue
    }
    const before = problems.length
    for (const [rel, bytes] of [...expectedFiles].sort(([a], [b]) => byPath(a, b))) {
      const onDisk = join(repoRoot, s.packageDir, rel)
      if (!existsSync(onDisk)) {
        problems.push(`${s.packageDir}/${rel}: missing — the generator emits it but it is not on disk. ${REGENERATE}`)
      } else if (!readFileSync(onDisk).equals(bytes)) {
        problems.push(`${s.packageDir}/${rel}: differs from what ${s.specFile} generates — a hand edit (or a stale spec). ${REGENERATE}`)
      }
    }
    for (const rel of listPackageFiles(join(repoRoot, s.packageDir))) {
      if (!expectedFiles.has(rel)) {
        problems.push(`${s.packageDir}/${rel}: extra — the generator does not emit this file (hand-written?). Generated packages hold generator output only.`)
      }
    }
    if (problems.length === before) checked++
  }

  // Nothing but the Node side and the registered surfaces may live here.
  const pkgRoot = join(repoRoot, DART_PACKAGES_DIR)
  const surfaceNames = new Set(surfaces.map((x) => x.name))
  if (existsSync(pkgRoot)) {
    for (const name of readdirSync(pkgRoot).sort(byPath)) {
      if (surfaceNames.has(name) || NODE_SIDE.has(name)) continue
      problems.push(`${DART_PACKAGES_DIR}/${name}: not an openapi+active surface in contracts/registry.json and not part of the Node tooling — remove it, or register its spec and regenerate.`)
    }
    for (const dir of NODE_SOURCE_DIRS) {
      if (!existsSync(join(pkgRoot, dir))) continue
      for (const rel of listPackageFiles(join(pkgRoot, dir))) {
        if (rel.endsWith('.dart')) problems.push(`${DART_PACKAGES_DIR}/${dir}/${rel}: a Dart file in the Node tooling side — Dart here is generator output under a surface directory only.`)
      }
    }
  }
  return { problems, checked, expected: surfaces.length }
}
