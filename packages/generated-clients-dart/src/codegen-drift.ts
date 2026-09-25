// packages/generated-clients-dart/src/codegen-drift.ts
//
// The read side of the Dart codegen (the write side is tools/generate.mjs).
// Mirrors packages/generated-clients/src/codegen-drift.ts, extended from one
// file per client to the WHOLE file set of each surface package: the check
// regenerates every surface through the same injected `generate` function
// the writer uses and compares the result with what is on disk.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDartSurfaces, type DartSurface } from './registry.ts'

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
    if (problems.length === before) checked++
  }
  return { problems, checked, expected: surfaces.length }
}
