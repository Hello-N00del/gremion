#!/usr/bin/env node
// Unit B3 (spec B §A.1, B-02). The do-not-overwrite guard — READ ONLY.
//
// Kernel-wins is the direction for all 294 MIRRORED-but-differing paths
// (spec B §2.1). This is what makes it safe. Every port-back unit — B4, B4a,
// B6, B7, B22, B23 — runs `make lint-port-back` before it writes to this tree.
//
// Two arms, and neither pins the kernel's own bytes:
//   doNotDelete  43 paths the kernel holds and the StuRa tree does not. A
//                StuRa-tree-wins copy of any parent directory removes them
//                silently, because a copy cannot add a file the source lacks.
//                Editing them is fine; losing them is not.
//   kernelAhead  paths both trees carry where the kernel is ahead. The
//                forbidden state is the kernel blob BECOMING the frozen StuRa
//                blob. Editing them is fine; reverting to f276af59 is not.
//
// Amending the set is allowed and is described in its own `amendment` field:
// a unit that deliberately deletes a protected path removes the row, lowers
// expectedEntries and drops the row's assertion IN THE SAME COMMIT.
//
// Comparison is by git index blob SHA-1, not working-tree bytes: that is the
// EOL-immune comparison, and it is the same one verify-manifest.mjs makes.
//
// Usage: node scripts/port-back/check-do-not-overwrite.mjs [--kernel <path>] [--set <file>]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SET = path.join(HERE, 'do-not-overwrite.json')
const DEFAULT_KERNEL = path.join(HERE, '..', '..')

export function loadSet(file = DEFAULT_SET) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** git ls-files -s -> Map<path, blobSha>. Submodule gitlinks (mode 160000) are skipped. */
export function indexBlobs(repo) {
  const out = execFileSync('git', ['-C', repo, 'ls-files', '-s'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  const m = new Map()
  for (const line of out.split('\n')) {
    const mm = line.match(/^(\d+) ([0-9a-f]{40}) \d\t(.*)$/)
    if (!mm || mm[1] === '160000') continue
    m.set(mm[3], mm[2])
  }
  return m
}

export function check(set, blobs) {
  const doNotDelete = set.doNotDelete ?? []
  const kernelAhead = set.kernelAhead ?? []
  const carried = doNotDelete.length + kernelAhead.length
  // Vacuity first: a guard over an empty set reports clean and means nothing.
  if (carried !== set.expectedEntries) {
    return [`PORT-BACK REFUSED: the do-not-overwrite set declares ${set.expectedEntries} entries but carries ${carried}`]
  }

  const failures = []
  for (const p of doNotDelete) {
    if (!blobs.has(p)) {
      failures.push(`PORT-BACK REFUSED: ${p} is in the do-not-overwrite set and is no longer tracked in the kernel`)
    }
  }
  for (const e of kernelAhead) {
    const have = blobs.get(e.path)
    if (!have) {
      failures.push(`PORT-BACK REFUSED: ${e.path} is in the do-not-overwrite set and is no longer tracked in the kernel`)
    } else if (have === e.forbiddenProductBlob) {
      failures.push(`PORT-BACK REFUSED: ${e.path} now carries the StuRa-tree blob ${have}; kernel wins on this path (spec B §2.1)`)
    }
  }
  return failures
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const set = loadSet(arg('set', DEFAULT_SET))
  const kernel = arg('kernel', DEFAULT_KERNEL)
  const failures = check(set, indexBlobs(kernel))
  if (failures.length) {
    for (const f of failures) process.stderr.write(f + '\n')
    process.stderr.write(`\n${failures.length} refusal(s) against ${set.expectedEntries} protected entries frozen at kernel ${set.frozenAt.kernel.slice(0, 8)}.\n`)
    process.exit(1)
  }
  console.log(`do-not-overwrite: ${set.expectedEntries} entries intact (${set.doNotDelete.length} must-exist, ${set.kernelAhead.length} kernel-ahead)`)
}
