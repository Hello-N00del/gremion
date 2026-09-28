// services/votes/test/aggregator-parity.test.ts
// Normalized-source PARITY between the votes leaf's pure aggregator (+ its VoteItem
// type) and the kernel oracles under gremion-ui/src/lib/votes. The leaf is a SEPARATE
// process and cannot import the kernel $lib, so the two copies are duplicated by hand
// and MUST stay identical — flag-ON (service) === flag-OFF (in-process). Any drift in
// the mapping/merge logic is a silent behaviour split between the two run modes.
//
// The comparison is at the STRING level: strip comments + import statements + blank
// lines from both sides, then assert equality. We deliberately do NOT value-import the
// leaf module (as gremion-ui/src/lib/server/finance/pdf/leaf-export-parity.test.ts does
// for the finance byte-exporters) because aggregator.ts pulls in helios-client.ts,
// which would drag its fetch transitive graph into this unit test. The two copies
// differ ONLY in their header comment and import specifiers ($lib alias vs relative
// .js paths) — exactly what normalizeSource() removes.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LEAF_DIR = join(HERE, '..', 'src', 'aggregator')
const KERNEL_DIR = join(HERE, '..', '..', '..', 'gremion-ui', 'src', 'lib', 'votes')

/** Reduce a source file to its semantic body: drop block comments, trailing line
 *  comments, `import` statements, and blank lines, then right-trim each survivor.
 *  Everything this removes is precisely the leaf↔kernel delta (header comment +
 *  import specifiers); the function/interface bodies must then be character-equal. */
function normalizeSource(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (the kernel types.ts JSDoc)
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, '').trimEnd()) // line comments (leaf headers, inline notes)
    .filter((line) => !/^\s*import\b/.test(line)) // import statements ($lib vs relative .js)
    .filter((line) => line.trim() !== '') // blank lines
    .join('\n')
}

const normalized = (dir: string, file: string) => normalizeSource(readFileSync(join(dir, file), 'utf8'))

describe('votes leaf aggregator parity — leaf copy is source-identical to the kernel oracle (comments/imports aside)', () => {
  for (const file of ['aggregator.ts', 'types.ts']) {
    it(`${file}: normalized leaf source === normalized kernel source`, () => {
      expect(normalized(LEAF_DIR, file)).toBe(normalized(KERNEL_DIR, file))
    })
  }
})
