// packages/ports/src/contract-file-references.test.ts
// A shipped contract document may only name a source file this repository
// actually contains. The kernel is public and the module code is not here, so a
// description that says "the kernel's <x>.ts consumes …" sends a reader after a
// file that does not exist — the exact defect that survived a hand review in
// contracts/calendar and contracts/content (their info.description each claimed
// a kernel audit consumer that lives in the module repo). Prose is not pinned by
// the channel-address assertions in the sibling contract tests, so it is pinned
// here: every `<name>.ts` token appearing anywhere in a contract document must
// match a file the repository contains.
//
// WHAT THIS DOES NOT DO — the check is by BASENAME, not by path, because the
// contract prose names bare filenames (`hooks.server.ts`, `jwt-verify.ts`) and
// carries no path to check against. So a contract that named the right filename
// at a module-repo path would still pass. That is weaker than "the file the
// sentence points at exists"; it is exactly strong enough for the defect this
// was written for, a contract naming a file that is nowhere in the kernel.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const contractsRoot = join(repoRoot, 'contracts')

const SKIP_DIRS = new Set(['node_modules', '.git', '.svelte-kit', 'build', 'dist', 'coverage', '.turbo'])

/** Every file basename in the repo (excluding build output), for existence checks. */
function collectBasenames(dir: string, into: Set<string>): Set<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectBasenames(join(dir, entry.name), into)
    } else {
      into.add(entry.name)
    }
  }
  return into
}

function collectContracts(dir: string, into: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectContracts(full, into)
    else if (entry.name.endsWith('.json')) into.push(full)
  }
  return into
}

const basenames = collectBasenames(repoRoot, new Set<string>())
const contractFiles = collectContracts(contractsRoot, [])
const label = (full: string) => relative(repoRoot, full).split(sep).join('/')

describe('contract documents name only files this repo contains', () => {
  it('finds contract documents to check', () => {
    expect(contractFiles.length).toBeGreaterThan(0)
  })

  it.each(contractFiles.map((f) => [label(f), f] as const))(
    '%s references no absent source file',
    (rel, full) => {
      const text = readFileSync(full, 'utf8')
      const referenced = [...new Set(text.match(/[A-Za-z0-9][A-Za-z0-9._-]*\.ts\b/g) ?? [])]
      const missing = referenced.filter((name) => !basenames.has(name))
      expect(missing, `${rel} names ${missing.join(', ')}, which this repo does not contain`).toEqual([])
    },
  )
})
