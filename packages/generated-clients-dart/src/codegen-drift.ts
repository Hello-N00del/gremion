// packages/generated-clients-dart/src/codegen-drift.ts
//
// The read side of the Dart codegen (the write side is tools/generate.mjs).
// Mirrors packages/generated-clients/src/codegen-drift.ts, extended from one
// file per client to the WHOLE file set of each surface package: the check
// regenerates every surface through the same injected `generate` function
// the writer uses and compares the result with what is on disk.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { byPath, isGitWorkTree, listCommittable } from './tree-files.ts'
import { DART_PACKAGES_DIR, loadDartSurfaces, NODE_SIDE, type DartSurface } from './registry.ts'

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

export { byPath, listPackageFiles } from './tree-files.ts'

/** Node-side dirs whose content is ours and must hold no Dart. */
const NODE_SOURCE_DIRS = ['src', 'tools']

/** Provenance stamp every generated package carries: the spec it came from
 *  and that spec's sha256 (LF-normalised). Written by the generator pipeline,
 *  checked here WITHOUT regenerating. */
export const STAMP_FILE = '.generated-from'

export function specStamp(repoRoot: string, s: DartSurface): string {
  const lf = readFileSync(join(repoRoot, s.specFile), 'utf8').replace(/\r\n/g, '\n')
  return `${s.specFile}\nsha256:${createHash('sha256').update(lf).digest('hex')}\n`
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
    const before = problems.length
    // Stale spec: checked from the stamp alone, before and independent of
    // regeneration, so the message says WHY the package no longer matches.
    const stampPath = join(repoRoot, s.packageDir, STAMP_FILE)
    const stamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : null
    if (stamp !== specStamp(repoRoot, s)) {
      problems.push(`${s.packageDir}/${STAMP_FILE}: stale — ${stamp === null ? 'the provenance stamp is missing' : `${s.specFile} changed since this package was generated`}. ${REGENERATE}`)
    }
    let expectedFiles: GeneratedFiles
    try {
      expectedFiles = opts.generate(repoRoot, s)
    } catch (e) {
      problems.push(`${s.packageDir}: generating surface "${s.name}" from ${s.specFile} failed: ${(e as Error).message}`)
      continue
    }
    if (![...expectedFiles.keys()].some((k) => k.startsWith('lib/') && k.endsWith('.dart'))) {
      problems.push(`${s.packageDir}: the generator emitted no lib/**/*.dart for "${s.name}" — an empty client is not a client.`)
    }
    const committable = listCommittable(repoRoot, s.packageDir)
    const committableSet = new Set(committable)
    const git = isGitWorkTree(repoRoot)
    for (const [rel, bytes] of [...expectedFiles].sort(([a], [b]) => byPath(a, b))) {
      const onDisk = join(repoRoot, s.packageDir, rel)
      if (git && existsSync(onDisk) && !committableSet.has(rel)) {
        problems.push(`${s.packageDir}/${rel}: generated but ignored by git (a .gitignore or core.excludesFile rule) — it would never be committed. Un-ignore it or force-add it.`)
      } else if (!existsSync(onDisk)) {
        problems.push(`${s.packageDir}/${rel}: missing — the generator emits it but it is not on disk. ${REGENERATE}`)
      } else if (!readFileSync(onDisk).equals(bytes)) {
        problems.push(`${s.packageDir}/${rel}: differs from what ${s.specFile} generates — a hand edit (or a stale spec). ${REGENERATE}`)
      }
    }
    for (const rel of committable) {
      if (!expectedFiles.has(rel)) {
        problems.push(`${s.packageDir}/${rel}: extra — the generator does not emit this file (hand-written?). Generated packages hold generator output only.`)
      }
    }
    if (problems.length === before) checked++
  }

  // Nothing but the Node side and the registered surfaces may live here.
  const pkgFiles = listCommittable(repoRoot, DART_PACKAGES_DIR)
  const surfaceNames = new Set(surfaces.map((x) => x.name))
  for (const name of [...new Set(pkgFiles.map((f) => f.split('/')[0]))].sort(byPath)) {
    if (surfaceNames.has(name) || NODE_SIDE.has(name)) continue
    problems.push(`${DART_PACKAGES_DIR}/${name}: not an openapi+active surface in contracts/registry.json and not part of the Node tooling — remove it, or register its spec and regenerate.`)
  }
  for (const f of pkgFiles) {
    if (NODE_SOURCE_DIRS.some((d) => f.startsWith(`${d}/`)) && f.endsWith('.dart')) {
      problems.push(`${DART_PACKAGES_DIR}/${f}: a Dart file in the Node tooling side — Dart here is generator output under a surface directory only.`)
    }
  }
  return { problems, checked, expected: surfaces.length }
}

export interface Verdict { ok: boolean; problems: string[]; summary: string }

/** The one place `ok` is decided. `requireSurfaces` is the real-tree mode:
 *  a registry with no openapi+active entry means the check looked at nothing,
 *  which is a failure there (a fixture may legitimately be 0 of 0). */
export function finalizeCheck(r: DriftResult, o: { requireSurfaces: boolean }): Verdict {
  const problems = [...r.problems]
  const summary = `${r.checked} of ${r.expected} registry surface(s) (openapi+active) regenerated and matched`
  if (r.checked !== r.expected) problems.push(`only ${r.checked} of ${r.expected} surfaces checked clean`)
  if (o.requireSurfaces && r.expected < 1) problems.push(`${summary}: 0 of 0 on the real tree — contracts/registry.json lists no openapi+active surface, so this check looked at nothing`)
  return { ok: problems.length === 0, problems, summary }
}
