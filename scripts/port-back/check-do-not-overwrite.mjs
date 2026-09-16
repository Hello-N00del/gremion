#!/usr/bin/env node
// Unit B3 (spec B §A.1, B-02). The do-not-overwrite guard — READ ONLY.
//
// Kernel-wins is the direction for all 294 MIRRORED-but-differing paths
// (spec B §2.1). This is what makes it safe. Every port-back unit — B4, B4a,
// B6, B7, B22, B23 — runs `make lint-port-back` after it writes to this tree
// and before it hands the branch on. Running it before the write as well is
// free and tells you the state you inherited; it is the run AFTER the write
// that certifies the port-back.
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
// BOTH the index and the working tree are checked, because a port-back is a
// `cp -r`/`rsync` and its damage exists on disk long before anyone stages it.
// Round 1 shipped the index arm alone, and it could be made to print "45
// entries intact" over a tree with all 11 dashboard files deleted from disk;
// the working-tree arm is what closes that. Comparison is by blob SHA-1 in
// both arms — `git ls-files -s` for the index, `git hash-object` (which
// applies the same clean filter) for the working tree — so the comparison
// stays EOL-immune, which is the comparison verify-manifest.mjs also makes.
//
// Usage: node scripts/port-back/check-do-not-overwrite.mjs [--kernel <path>] [--set <file>]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * Working-tree state of `paths` -> Map<path, blobSha | null>; null means the
 * file is not on disk. `git hash-object` is given the repo-relative path, so
 * it applies the same attributes and clean filter the index would: the SHAs
 * are directly comparable with the ones indexBlobs() reports. One spawn for
 * the whole list.
 */
export function worktreeBlobs(repo, paths) {
  const m = new Map()
  const present = []
  for (const p of paths) {
    if (existsSync(path.join(repo, p))) present.push(p)
    else m.set(p, null)
  }
  if (present.length) {
    const out = execFileSync('git', ['-C', repo, 'hash-object', '--stdin-paths'], {
      input: present.join('\n') + '\n',
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
    const shas = out.split('\n').filter((l) => l.length > 0)
    if (shas.length !== present.length) {
      throw new Error(
        `git hash-object returned ${shas.length} SHAs for ${present.length} paths; refusing to report on a partial measurement`,
      )
    }
    present.forEach((p, i) => m.set(p, shas[i]))
  }
  return m
}

/** Every path the set protects, in one list — what worktreeBlobs() is asked to measure. */
export function protectedPaths(set) {
  const a = Array.isArray(set.doNotDelete) ? set.doNotDelete.filter((p) => typeof p === 'string') : []
  const b = Array.isArray(set.kernelAhead)
    ? set.kernelAhead.filter((e) => e && typeof e.path === 'string').map((e) => e.path)
    : []
  return [...a, ...b]
}

/**
 * Shape refusals. A set whose arms are missing or mistyped used to degrade
 * `check` into a weaker guard that still printed a clean line — the same class
 * of silent no-op the vacuity count exists for, one level up.
 */
function malformed(set) {
  const out = []
  if (!Number.isInteger(set.expectedEntries)) {
    out.push('PORT-BACK REFUSED: the do-not-overwrite set is malformed: expectedEntries must be an integer')
  }
  if (!Array.isArray(set.doNotDelete)) {
    out.push('PORT-BACK REFUSED: the do-not-overwrite set is malformed: doNotDelete must be an array of paths')
  } else {
    set.doNotDelete.forEach((p, i) => {
      if (typeof p !== 'string' || p.length === 0) {
        out.push(`PORT-BACK REFUSED: the do-not-overwrite set is malformed: doNotDelete[${i}] is not a path`)
      }
    })
  }
  if (!Array.isArray(set.kernelAhead)) {
    out.push('PORT-BACK REFUSED: the do-not-overwrite set is malformed: kernelAhead must be an array')
  } else {
    set.kernelAhead.forEach((e, i) => {
      if (!e || typeof e.path !== 'string' || e.path.length === 0) {
        out.push(`PORT-BACK REFUSED: the do-not-overwrite set is malformed: kernelAhead[${i}] has no path`)
      }
      if (!e || typeof e.forbiddenProductBlob !== 'string' || !/^[0-9a-f]{40}$/.test(e.forbiddenProductBlob)) {
        out.push(
          `PORT-BACK REFUSED: the do-not-overwrite set is malformed: kernelAhead[${i}] has no 40-hex forbiddenProductBlob, so its overwrite arm would never fire`,
        )
      }
    })
  }
  return out
}

/**
 * @param set       the frozen set
 * @param blobs     indexBlobs(kernel)
 * @param worktree  worktreeBlobs(kernel, protectedPaths(set)). Omitted only by
 *                  a caller that deliberately wants the index-only half; the
 *                  CLI, and therefore `make lint-port-back`, always passes it.
 */
export function check(set, blobs, worktree = null) {
  const shape = malformed(set)
  if (shape.length) return shape

  const doNotDelete = set.doNotDelete
  const kernelAhead = set.kernelAhead
  const carried = doNotDelete.length + kernelAhead.length
  // Vacuity: a guard over an empty set reports clean and means nothing.
  if (carried !== set.expectedEntries) {
    return [`PORT-BACK REFUSED: the do-not-overwrite set declares ${set.expectedEntries} entries but carries ${carried}`]
  }

  // undefined = not measured (index-only call); null = measured and absent.
  const onDisk = (p) => (worktree ? worktree.get(p) : undefined)

  const failures = []
  for (const p of doNotDelete) {
    if (!blobs.has(p)) {
      failures.push(`PORT-BACK REFUSED: ${p} is in the do-not-overwrite set and is no longer tracked in the kernel`)
    } else if (onDisk(p) === null) {
      failures.push(`PORT-BACK REFUSED: ${p} is in the do-not-overwrite set and is gone from the kernel working tree`)
    }
  }
  for (const e of kernelAhead) {
    const have = blobs.get(e.path)
    const disk = onDisk(e.path)
    if (!have) {
      failures.push(`PORT-BACK REFUSED: ${e.path} is in the do-not-overwrite set and is no longer tracked in the kernel`)
    } else if (have === e.forbiddenProductBlob) {
      failures.push(`PORT-BACK REFUSED: ${e.path} now carries the StuRa-tree blob ${have}; kernel wins on this path (spec B §2.1)`)
    } else if (disk === null) {
      failures.push(`PORT-BACK REFUSED: ${e.path} is in the do-not-overwrite set and is gone from the kernel working tree`)
    } else if (disk === e.forbiddenProductBlob) {
      failures.push(
        `PORT-BACK REFUSED: ${e.path} now carries the StuRa-tree blob ${disk} in the working tree; kernel wins on this path (spec B §2.1)`,
      )
    }
  }
  return failures
}

const KNOWN_OPTIONS = ['kernel', 'set']
const USAGE = 'usage: node scripts/port-back/check-do-not-overwrite.mjs [--kernel <path>] [--set <file>]'

/**
 * Strict. Round 1 took the last-wins-or-default road and answered GREEN about
 * its own repo when the caller typed `--kernal` or passed an empty `$KERNEL`;
 * a guard that reports on a tree nobody asked about is worse than no guard.
 * Unknown options, missing values and empty values are all hard errors.
 */
export function parseArgs(argv, defaults = { kernel: DEFAULT_KERNEL, set: DEFAULT_SET }) {
  const opts = { ...defaults }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      throw new Error(`unexpected argument "${a}"\n${USAGE}`)
    }
    const eq = a.indexOf('=')
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (!KNOWN_OPTIONS.includes(name)) {
      throw new Error(
        `unknown option "--${name}"; known options are ${KNOWN_OPTIONS.map((n) => `--${n}`).join(' and ')}\n${USAGE}`,
      )
    }
    let value
    if (eq === -1) {
      value = argv[++i]
      if (value !== undefined && value.startsWith('--')) {
        throw new Error(`--${name} requires a value, got the option "${value}"\n${USAGE}`)
      }
    } else {
      value = a.slice(eq + 1)
    }
    if (value === undefined || value === '') {
      throw new Error(`--${name} requires a non-empty value\n${USAGE}`)
    }
    opts[name] = value
  }
  return opts
}

/** Resolve --kernel to a real git work tree, or throw naming what was asked for. */
export function resolveKernel(kernel) {
  const abs = path.resolve(kernel)
  if (!existsSync(abs)) {
    throw new Error(`--kernel ${kernel} does not exist (resolved to ${abs})`)
  }
  let top
  try {
    top = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(`--kernel ${kernel} is not a git work tree (resolved to ${abs})`)
  }
  return top || abs
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let set
  let kernel
  let usable = true
  try {
    const opts = parseArgs(process.argv.slice(2))
    kernel = resolveKernel(opts.kernel)
    set = loadSet(opts.set)
  } catch (err) {
    process.stderr.write(`PORT-BACK GUARD DID NOT RUN: ${err.message}\n`)
    process.exitCode = 2
    usable = false
  }
  if (usable) {
    const failures = check(set, indexBlobs(kernel), worktreeBlobs(kernel, protectedPaths(set)))
    if (failures.length) {
      for (const f of failures) process.stderr.write(f + '\n')
      process.stderr.write(
        `\n${failures.length} refusal(s) against ${set.expectedEntries} protected entries frozen at kernel ${String(set.frozenAt?.kernel).slice(0, 8)}, checked in ${kernel}.\n`,
      )
      // exitCode, not exit(): process.exit() can truncate a piped stderr, and a
      // guard whose refusals are cut off on a CI pipe is a guard that failed
      // without saying why.
      process.exitCode = 1
    } else {
      console.log(
        `do-not-overwrite: ${set.expectedEntries} entries intact (${set.doNotDelete.length} must-exist, ${set.kernelAhead.length} kernel-ahead), index and working tree, in ${kernel}`,
      )
    }
  }
}
