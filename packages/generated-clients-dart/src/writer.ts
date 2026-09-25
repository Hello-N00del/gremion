// packages/generated-clients-dart/src/writer.ts
//
// The write side (tools/generate.mjs is its CLI). It syncs each surface
// package to EXACTLY what `generate` emits (writes every file, deletes files
// the generator no longer emits), so the next check sees zero drift and two
// back-to-back runs change nothing. It uses the same GenerateFn the check
// uses, so there is one implementation, not two.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STAMP_FILE, type GenerateFn } from './codegen-drift.ts'
import { byPath, listCommittable } from './tree-files.ts'
import { DART_PACKAGES_DIR, loadDartSurfaces } from './registry.ts'

function removeEmptyDirs(dir: string, isRoot: boolean): void {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.isDirectory() && !(isRoot && name.name === '.dart_tool')) removeEmptyDirs(join(dir, name.name), false)
  }
  if (!isRoot && readdirSync(dir).length === 0) rmdirSync(dir)
}

/** Returns the repo-relative package dirs written, in registry order. */
export function syncDartPackages(repoRoot: string, generate: GenerateFn, log: (m: string) => void = () => {}): string[] {
  const { surfaces } = loadDartSurfaces(repoRoot)
  // Generate everything first: a failure on any surface leaves the tree as
  // it was instead of half-written.
  const outputs = surfaces.map((s) => ({ s, files: generate(repoRoot, s) }))
  const written: string[] = []
  for (const { s, files } of outputs) {
    if (!files.has(STAMP_FILE)) throw new Error(`generator output for ${s.name} carries no ${STAMP_FILE} provenance stamp`)
    const pkg = join(repoRoot, s.packageDir)
    for (const [rel, bytes] of [...files].sort(([a], [b]) => byPath(a, b))) {
      const p = join(pkg, rel)
      mkdirSync(dirname(p), { recursive: true })
      if (!existsSync(p) || !readFileSync(p).equals(bytes)) writeFileSync(p, bytes)
    }
    for (const rel of listCommittable(repoRoot, s.packageDir)) {
      if (!files.has(rel)) {
        rmSync(join(pkg, rel))
        log(`removed ${s.packageDir}/${rel} (no longer generated)`)
      }
    }
    removeEmptyDirs(pkg, true)
    log(`generated ${s.packageDir} (${files.size} files) from ${s.specFile}`)
    written.push(s.packageDir)
  }
  // A package this writer once generated (it carries the stamp) whose
  // surface left the registry is removed; anything else is left for the
  // check to name — the writer never deletes what it did not write.
  const root = join(repoRoot, DART_PACKAGES_DIR)
  const names = new Set(surfaces.map((s) => s.name))
  for (const name of readdirSync(root).sort(byPath)) {
    if (names.has(name) || !existsSync(join(root, name, STAMP_FILE))) continue
    rmSync(join(root, name), { recursive: true, force: true })
    log(`removed ${DART_PACKAGES_DIR}/${name} (surface no longer openapi+active in the registry)`)
  }
  return written
}
