#!/usr/bin/env node
// Module documentation guard. The kernel tree carries its in-tree modules under
// modules/<name>/ and lists the actively supported ones in docs/modules.md. Three
// repository-side checks, each with a falsifiable failure:
//   (a) every directory under modules/ has a non-empty README.md
//   (b) every directory under modules/ has a row in the docs/modules.md table (first
//       cell is the backticked directory name) that links its README, and no row names a
//       directory that does not exist
//   (c) the "disabled by default" status in that table agrees with modules/disabled.json
//       in both directions; docs/INDEX.md links docs/modules.md
//
// They read files. They do not prove what a running system serves.
//
// Run:  node scripts/check-module-docs.mjs
// Test: node --test scripts/check-module-docs.test.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const MODULES_DIR = 'modules'
export const MODULES_DOC = 'docs/modules.md'
export const DOCS_INDEX = 'docs/INDEX.md'
export const DISABLED_PATH = 'modules/disabled.json'
export const DISABLED_STATUS = /disabled by default/i

/** Every directory directly under modules/ (files such as disabled.json are not modules). */
export function moduleDirs(root) {
  const dir = join(root, MODULES_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort()
}

/** Table rows of docs/modules.md whose first cell is a backticked module name. */
export function docRows(root) {
  const p = join(root, MODULES_DOC)
  if (!existsSync(p)) return null
  const rows = new Map()
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*`([^`|]+)`\s*\|(.*)$/.exec(line)
    if (m) rows.set(m[1], line)
  }
  return rows
}

export function disabledIds(root) {
  try {
    const j = JSON.parse(readFileSync(join(root, DISABLED_PATH), 'utf8'))
    return Array.isArray(j.disabled) ? j.disabled.map((d) => d.id) : null
  } catch {
    return null
  }
}

export function checkReadmes(root, dirs) {
  const bad = []
  for (const d of dirs) {
    const p = join(root, MODULES_DIR, d, 'README.md')
    if (!existsSync(p)) bad.push(`(a) modules/${d} has no README.md`)
    else if (readFileSync(p, 'utf8').trim().length === 0) bad.push(`(a) modules/${d}/README.md is empty`)
  }
  return bad
}

export function checkListing(root, dirs) {
  const rows = docRows(root)
  if (rows === null) return [`(b) ${MODULES_DOC} does not exist`]
  if (rows.size === 0) return [`(b) ${MODULES_DOC} has no module table rows: an empty scan proves nothing`]
  const bad = []
  for (const d of dirs) {
    const row = rows.get(d)
    if (!row) bad.push(`(b) modules/${d} is missing from ${MODULES_DOC}`)
    else if (!row.includes(`../modules/${d}/README.md`)) bad.push(`(b) the ${MODULES_DOC} row for "${d}" does not link ../modules/${d}/README.md`)
  }
  for (const name of rows.keys()) if (!dirs.includes(name)) bad.push(`(b) ${MODULES_DOC} lists "${name}" but there is no modules/${name}`)
  return bad
}

export function checkStatus(root) {
  const bad = []
  const rows = docRows(root)
  const ids = disabledIds(root)
  if (ids === null) return [`(c) ${DISABLED_PATH} is unreadable or has no "disabled" array`]
  if (rows !== null) {
    for (const id of ids) {
      const row = rows.get(id)
      if (row && !DISABLED_STATUS.test(row)) bad.push(`(c) "${id}" is in ${DISABLED_PATH} but its ${MODULES_DOC} row does not say "disabled by default"`)
    }
    for (const [name, row] of rows) {
      if (DISABLED_STATUS.test(row) && !ids.includes(name)) bad.push(`(c) ${MODULES_DOC} says "${name}" is disabled by default but ${DISABLED_PATH} does not list it`)
    }
  }
  const idx = join(root, DOCS_INDEX)
  if (!existsSync(idx) || !/\]\(\.\/modules\.md\)/.test(readFileSync(idx, 'utf8'))) bad.push(`(c) ${DOCS_INDEX} does not link ./modules.md`)
  return bad
}

export function runChecks(root = ROOT) {
  const dirs = moduleDirs(root)
  const failures = []
  if (dirs.length === 0) failures.push(`no module directories under ${MODULES_DIR}/: an empty scan proves nothing`)
  failures.push(...checkReadmes(root, dirs), ...checkListing(root, dirs), ...checkStatus(root))
  return { dirs, failures }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dirs, failures } = runChecks(ROOT)
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`)
    process.exit(1)
  }
  console.log(`module docs ok: ${dirs.length} modules, each with a README and a ${MODULES_DOC} row`)
}
