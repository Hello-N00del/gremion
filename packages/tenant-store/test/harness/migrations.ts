// Scratch copies of the fixture module's migrations, for specs that need a
// subset, a tampered byte, or a regenerated manifest.
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_MIGRATIONS = fileURLToPath(new URL('../fixtures/migrations/fixture/', import.meta.url))

const made: string[] = []

export function writeManifest(dir: string): void {
  const m: Record<string, string> = {}
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    m[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n')
}

/** A scratch copy; `only` keeps a subset (manifest regenerated to match). */
export function copyFixture({ only }: { only?: string[] } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 't020-mig-'))
  made.push(d)
  cpSync(FIXTURE_MIGRATIONS, d, { recursive: true })
  if (only) {
    for (const f of readdirSync(d).filter((f) => f.endsWith('.sql'))) if (!only.includes(f)) rmSync(join(d, f))
    writeManifest(d)
  }
  return d
}

export function cleanupFixtures(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
}
