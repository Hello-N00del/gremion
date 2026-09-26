#!/usr/bin/env node
// check-dependabot-dockerfiles — every tracked Dockerfile's directory is listed
// by a dependabot `package-ecosystem: docker` entry (Release-1 B35, adapted by
// TASK-046). A base image nobody is told about never gets a security bump, and
// dependabot does not report a directory it was never given.
//
// Run:  node scripts/release/check-dependabot-dockerfiles.mjs
// Test: node --test scripts/release/b35-adapts.test.mjs

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Set of '/dir' paths named by docker ecosystem entries (directory: and directories:). */
export function dockerDirectories(yamlText) {
  const dirs = new Set()
  let inDocker = false
  let inList = false
  for (const line of yamlText.split('\n')) {
    const eco = /^\s*-\s*package-ecosystem:\s*["']?([\w-]+)/.exec(line)
    if (eco) {
      inDocker = eco[1] === 'docker'
      inList = false
      continue
    }
    if (!inDocker) continue
    let m
    if ((m = /^\s+directory:\s*["']?([^"'\s#]+)/.exec(line))) {
      dirs.add(m[1])
      inList = false
    } else if (/^\s+directories:\s*$/.test(line)) inList = true
    else if (inList && (m = /^\s+-\s*["']?([^"'\s#]+)/.exec(line))) dirs.add(m[1])
    else if (inList && /^\s+[a-z-]+:/.test(line)) inList = false
  }
  return dirs
}

export function checkDependabotDockerfiles(root) {
  const problems = []
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const dockerfiles = files.filter((f) => basename(f) === 'Dockerfile')
  if (!dockerfiles.length) problems.push({ code: 'no-dockerfiles', path: '.', message: 'no tracked Dockerfile — nothing was checked' })
  const cfg = join(root, '.github/dependabot.yml')
  const dirs = existsSync(cfg) ? dockerDirectories(readFileSync(cfg, 'utf8')) : new Set()
  if (!dirs.size) problems.push({ code: 'no-docker-ecosystem', path: '.github/dependabot.yml', message: 'no docker ecosystem directory listed' })
  for (const f of dockerfiles) {
    const d = dirname(f) === '.' ? '/' : `/${dirname(f)}`
    if (!dirs.has(d)) problems.push({ code: 'uncovered-dockerfile', path: f, message: `${d} is not in any dependabot docker entry` })
  }
  return problems
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const ps = checkDependabotDockerfiles(root)
  for (const p of ps) console.error(`check-dependabot-dockerfiles: FAIL ${p.code} ${p.path}: ${p.message}`)
  console.log(`check-dependabot-dockerfiles: ${ps.length} problem(s)`)
  process.exit(ps.length ? 1 : 0)
}
