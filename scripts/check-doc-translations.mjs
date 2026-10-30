#!/usr/bin/env node
// German translation guard. A user-facing document X.md may carry a German sibling
// X.de.md in the same directory. The German file starts with a sync marker
//   <!-- i18n-sync: source=X.md sha256=<sha256 of X.md, LF line endings> -->
// recording which English text it was translated from. The checks, each with a
// falsifiable failure:
//   (a) every *.de.md has an English sibling, and its marker names that sibling
//   (b) the English file still hashes to the value in the marker: an English edit
//       that did not also update the German text is stale and fails here
//   (c) both files carry the language switcher line, and no English file links a
//       German sibling that does not exist
//   (d) every pair in REQUIRED_PAIRS (the set agreed with the operator) exists, so
//       deleting a German file is a visible change, not a silent one
//
// After updating a German text, re-record the English hash:
//   node scripts/check-doc-translations.mjs --stamp docs/modules.de.md [...]
// Stamp only a file whose German text you have actually brought up to date; the
// stamp is the claim that someone did.
//
// They read files. A green run says the German text was re-stamped after the last
// English change; it does not say the translation is faithful.
//
// Run:  node scripts/check-doc-translations.mjs
// Test: node --test scripts/check-doc-translations.test.mjs

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const REQUIRED_PAIRS = [
  'README.md',
  'docs/about-gremion.md',
  'docs/compliance.md',
  'docs/compliance/controller-processor-split.md',
  'docs/compliance/elections-scope.md',
  'docs/log-retention-policy.md',
  'docs/modules.md',
  'docs/pilot/module-defaults.md',
  ...['board', 'calendar', 'content', 'elections', 'files', 'finance', 'handover', 'messaging', 'publishing', 'vault', 'votes']
    .map((m) => `modules/${m}/README.md`),
]

const MARKER = /^<!-- i18n-sync: source=(\S+) sha256=([0-9a-f]{64}) -->$/
const SWITCH_WINDOW = 4 // the switcher sits at the top: within the first lines of each file

const lf = (text) => text.replace(/\r\n/g, '\n')
export const enHash = (text) => createHash('sha256').update(lf(text)).digest('hex')
export const marker = (source, hash) => `<!-- i18n-sync: source=${source} sha256=${hash} -->`
export const enSwitch = (enBase) => `**English** | [Deutsch](./${enBase.replace(/\.md$/, '.de.md')})`
export const deSwitch = (enBase) => `[English](./${enBase}) | **Deutsch**`

const posix = (p) => p.split('\\').join('/')
const head = (text) => lf(text).split('\n').slice(0, SWITCH_WINDOW).map((l) => l.trim())

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p)
  }
  return out
}

/** Repo-relative English paths that have a German sibling, sorted. */
export function findPairs(root) {
  return walk(root, [])
    .filter((p) => p.endsWith('.de.md'))
    .map((p) => posix(relative(root, p)).replace(/\.de\.md$/, '.md'))
    .filter((en) => existsSync(join(root, en)))
    .sort()
}

export function runChecks(root = ROOT, required = REQUIRED_PAIRS) {
  const failures = []
  const mdFiles = walk(root, []).map((p) => posix(relative(root, p)))
  const deFiles = mdFiles.filter((p) => p.endsWith('.de.md'))
  if (deFiles.length === 0) failures.push('no *.de.md file found: an empty scan proves nothing')

  for (const de of deFiles) {
    const en = de.replace(/\.de\.md$/, '.md')
    const enBase = basename(en)
    if (!existsSync(join(root, en))) {
      failures.push(`(a) ${de} has no English sibling ${en}`)
      continue
    }
    const deText = readFileSync(join(root, de), 'utf8')
    const enText = readFileSync(join(root, en), 'utf8')
    const m = MARKER.exec(lf(deText).split('\n')[0].trim())
    if (!m) failures.push(`(a) ${de} does not start with an i18n-sync marker (${marker(enBase, '<sha256>')})`)
    else if (m[1] !== enBase) failures.push(`(a) ${de}: the marker names source=${m[1]}, expected ${enBase}`)
    else if (m[2] !== enHash(enText)) {
      failures.push(`(b) ${de} is stale: ${en} changed since the German text was last synced; update it, then run node scripts/check-doc-translations.mjs --stamp ${de}`)
    }
    if (!head(deText).includes(deSwitch(enBase))) failures.push(`(c) ${de} lacks the switcher line "${deSwitch(enBase)}" at the top`)
    if (!head(enText).includes(enSwitch(enBase))) failures.push(`(c) ${en} lacks the switcher line "${enSwitch(enBase)}" at the top`)
  }

  for (const en of mdFiles.filter((p) => !p.endsWith('.de.md'))) {
    const enBase = basename(en)
    const deBase = enBase.replace(/\.md$/, '.de.md')
    const text = readFileSync(join(root, en), 'utf8')
    if (text.includes(`](./${deBase})`) && !existsSync(join(root, dirname(en), deBase))) {
      failures.push(`(c) ${en} links ./${deBase}, which does not exist`)
    }
  }

  for (const en of required) {
    const de = en.replace(/\.md$/, '.de.md')
    if (!existsSync(join(root, de))) failures.push(`(d) ${en} is in the agreed set but has no German sibling ${de}`)
  }
  return { pairs: findPairs(root), failures }
}

/** Re-record the current English hash in each named German file's marker. */
export function stamp(root, deFiles) {
  const done = []
  for (const de of deFiles.map(posix)) {
    if (!de.endsWith('.de.md')) throw new Error(`${de} is not a .de.md file`)
    const en = de.replace(/\.de\.md$/, '.md')
    const enPath = join(root, en)
    if (!existsSync(enPath)) throw new Error(`${de} has no English sibling ${en}`)
    const lines = readFileSync(join(root, de), 'utf8').split('\n')
    const line = marker(basename(en), enHash(readFileSync(enPath, 'utf8')))
    const cr = lines[0].endsWith('\r') ? '\r' : ''
    if (MARKER.test(lines[0].trim())) lines[0] = line + cr
    else lines.unshift(line + cr)
    writeFileSync(join(root, de), lines.join('\n'))
    done.push(de)
  }
  return done
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args[0] === '--stamp') {
    if (args.length < 2) {
      console.error('usage: node scripts/check-doc-translations.mjs --stamp <file.de.md> [...]')
      process.exit(2)
    }
    for (const de of stamp(ROOT, args.slice(1))) console.log(`stamped ${de}`)
    process.exit(0)
  }
  const { pairs, failures } = runChecks(ROOT)
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`)
    process.exit(1)
  }
  console.log(`doc translations ok: ${pairs.length} English/German pairs in sync`)
}
