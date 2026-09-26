#!/usr/bin/env node
// check-lockfile-committed — the root pnpm-lock.yaml is the ONE lockfile, and
// every Dockerfile that installs with pnpm/npm installs from it frozen
// (Release-1 B35, adapted by TASK-046: root lockfile only).
//
//   - pnpm-lock.yaml is tracked at the root;
//   - no other lockfile (pnpm-lock.yaml, package-lock.json, yarn.lock,
//     npm-shrinkwrap.json) is tracked, except under a fixtures/ directory;
//   - in every tracked Dockerfile, each `pnpm install` carries
//     --frozen-lockfile (continuation lines joined first) and there is no bare
//     `npm install` of project dependencies (`npm ci` is fine; `npm install -g
//     <tool>@<x.y.z>` of a pinned global tool is fine).
//
// Run:  node scripts/release/check-lockfile-committed.mjs
// Test: node --test scripts/release/b35-adapts.test.mjs

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json'])

/** RUN instructions with backslash continuations joined. */
export function runInstructions(dockerfile) {
  const joined = dockerfile.replace(/\\\r?\n/g, ' ')
  return joined.split('\n').filter((l) => /^\s*RUN\s/i.test(l))
}

export function checkLockfileCommitted(root) {
  const problems = []
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  if (!files.includes('pnpm-lock.yaml')) problems.push({ code: 'no-root-lockfile', path: 'pnpm-lock.yaml', message: 'root pnpm-lock.yaml is not tracked' })
  for (const f of files) {
    if (f === 'pnpm-lock.yaml' || !LOCKFILES.has(basename(f))) continue
    if (/(^|\/)fixtures\//.test(f)) continue
    problems.push({ code: 'extra-lockfile', path: f, message: 'only the root pnpm-lock.yaml may be committed' })
  }
  for (const f of files.filter((x) => basename(x) === 'Dockerfile')) {
    for (const run of runInstructions(readFileSync(join(root, f), 'utf8'))) {
      for (const cmd of run.split(/&&|;|\|\|/)) {
        const c = cmd.trim().replace(/^RUN\s+/i, '')
        if (/(^|\s)pnpm\s+(install|i)(\s|$)/.test(c) && !/--frozen-lockfile/.test(c)) {
          problems.push({ code: 'unfrozen-install', path: f, message: `pnpm install without --frozen-lockfile: ${c}` })
        }
        const npm = /(^|\s)npm\s+(install|i)(\s+(.*))?$/.exec(c)
        if (npm) {
          const args = (npm[4] ?? '').trim().split(/\s+/).filter(Boolean)
          const global = args.includes('-g') || args.includes('--global')
          const pkgs = args.filter((a) => !a.startsWith('-'))
          if (!global || pkgs.length === 0) {
            problems.push({ code: 'unfrozen-install', path: f, message: `npm install of project dependencies (use npm ci or pnpm --frozen-lockfile): ${c}` })
          }
        }
      }
    }
  }
  return problems
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const ps = checkLockfileCommitted(root)
  for (const p of ps) console.error(`check-lockfile-committed: FAIL ${p.code} ${p.path}: ${p.message}`)
  console.log(`check-lockfile-committed: ${ps.length} problem(s)`)
  process.exit(ps.length ? 1 : 0)
}
