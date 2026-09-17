#!/usr/bin/env node
// D-01: handover stays private and unextracted, and its three migrations ship in
// NO release-1 tree — not the kernel, not any gremion-module-<id> repo, not the
// assembled distribution. Block 1900-1999 is reserved and EMPTY.
//
// Post-condition, not exit code: the walk counts the migration files it actually
// looked at and FAILS below one, because a guard that scanned nothing and exited
// 0 is indistinguishable from a guard that found nothing wrong.
//
// Survives B7's renumber: the match is on the NAME after the numeric prefix, so
// 050_handover_schema.sql and 1900_handover_schema.sql both fail.
//
//   node scripts/check-unshipped-migrations.mjs [--tree <dir>]
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UNSHIPPED_BASENAMES = [
  '050_handover_schema.sql',
  '051_handover_event.sql',
  '052_handover_module_binding.sql',
]
export const UNSHIPPED_SUFFIX_RE =
  /^\d{3,4}_(handover_schema|handover_event|handover_module_binding)\.sql$/

const MIGRATION_DIRS = new Set(['migrations', 'migrations-control'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'coverage', '.svelte-kit'])

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, acc)
    else if (name.endsWith('.sql') && MIGRATION_DIRS.has(basename(dir))) acc.push(abs)
  }
  return acc
}

function main() {
  const i = process.argv.indexOf('--tree')
  const root =
    i >= 0 ? process.argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), '..')
  if (!existsSync(root)) {
    console.error(`[unshipped] tree does not exist: ${root}`)
    process.exit(1)
  }
  const files = walk(root, [])
  if (files.length === 0) {
    console.error(
      `[unshipped] scanned zero migration files under ${root} — the guard would pass vacuously`,
    )
    process.exit(1)
  }
  const offenders = files.filter(
    (f) => UNSHIPPED_BASENAMES.includes(basename(f)) || UNSHIPPED_SUFFIX_RE.test(basename(f)),
  )
  for (const f of offenders) {
    console.error(
      `UNSHIPPED MIGRATION: ${relative(root, f)} — handover does not ship in release 1 (D-01)`,
    )
  }
  if (offenders.length) process.exit(1)
  console.info(`[unshipped] ${files.length} migration file(s) scanned, no handover migration present`)
}

main()
