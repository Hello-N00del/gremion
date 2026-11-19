#!/usr/bin/env node
// Guard for the documentation of where a customer's board lives (the board README in both
// languages, the board part of the tenant-lifecycle runbook, the board rows of the Karenz
// table, the pilot module defaults in both languages).
//
// A green run says: the sentences that were once true and stopped being true are gone, the
// runbook names the things it must name, and every identifier the board documents cite
// (a verb, an environment key, a table or column) is found in a source file that is not a
// document. It does not say the prose is right; a reader still has to read it.
//
//   (a) none of the stale statements is present, in either language
//   (b) the runbook has its board section, and that section says the move of an existing
//       customer's board is not available yet, gives the read-only check, and says that board
//       must be ticked when the customer is created
//   (c) every identifier cited in backticks or in a fenced block of the board sections is
//       found in a tracked non-document file; a verb that was named but never built fails here
//   (d) the number of days the export is kept after day 30 is the one in export-hold.ts
//   (e) the read-only check names the table and the column the code really reads
//
// Run:  node scripts/check-board-docs.mjs
// Test: node --test scripts/check-board-docs.test.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const RUNBOOK = 'docs/runbooks/tenant-lifecycle.md'
export const README_EN = 'modules/board/README.md'
export const README_DE = 'modules/board/README.de.md'
export const DEFAULTS_EN = 'docs/pilot/module-defaults.md'
export const DEFAULTS_DE = 'docs/pilot/module-defaults.de.md'
export const EXPORT_HOLD = 'packages/provisioning/src/export-hold.ts'
export const LOCATION_MIGRATION = 'gremion-ui/migrations/0066_board_location.sql'
export const KARENZ_MIGRATION = 'packages/tenant-store/src/lifecycle/platform-migrations/0016_plt_module_karenz.sql'
export const BOARD_SECTION = '## Board: where a customer\'s board lives'

export const FILES = [RUNBOOK, README_EN, README_DE, DEFAULTS_EN, DEFAULTS_DE, EXPORT_HOLD, LOCATION_MIGRATION, KARENZ_MIGRATION]

/** Statements that were true before the board declared its own database and are false now. */
export const STALE = [
  [RUNBOOK, /`board` \(no module database\)/, 'the Karenz row that says board has no module database'],
  [RUNBOOK, /hidden through `config\.modules\.board`; no export is taken/, 'the Karenz row that says no export is taken'],
  [README_EN, /declares\s+no\s+`runtime\.database`/, 'the README says board declares no database'],
  [README_EN, /test environment only/, 'the README says the leaf is for a test environment only'],
  [README_EN, /served in-process and never\s+reaches the leaf/, 'the README says a created customer never reaches the leaf'],
  [README_EN, /provisional profile of the catalogue loader/, 'the README says the retention profile is provisional'],
  [README_EN, /default\s+in-process mode needs neither/, 'the README says the default mode needs no board-postgres'],
  [README_EN, /needs a platform enablement to disable/, 'the README offers a platform enablement as the way to hide a kernel board'],
  [README_EN, /Not established from the code/, 'the README closes with the old not-established bullet'],
  [README_DE, /deklariert\s+deshalb\s+weder/, 'the German README says board declares no database'],
  [README_DE, /nur Testumgebung/, 'the German README says the leaf is for a test environment only'],
  [README_DE, /erreicht den Leaf nie/, 'the German README says a created customer never reaches the leaf'],
  [README_DE, /vorläufiges Profil des Katalog-Laders/, 'the German README says the retention profile is provisional'],
  [README_DE, /braucht beides nicht/, 'the German README says the default mode needs no board-postgres'],
  [README_DE, /Plattform-Aktivierung,\s+die deaktiviert wird/, 'the German README offers a platform enablement as the way to hide a kernel board'],
  [README_DE, /Nicht aus dem Code belegt/, 'the German README closes with the old not-established bullet'],
  [DEFAULTS_EN, /board needs no profile: it runs in-process/, 'the defaults say board needs no compose profile'],
  [DEFAULTS_DE, /board braucht keines: es läuft im Prozess/, 'the German defaults say board needs no compose profile'],
]

/** What must be named, per language, in the board section of the runbook. */
export const REQUIRED = [
  [/not available yet/, 'that moving an existing customer\'s board into its own database is not available yet'],
  [/board_location/, 'the table the read-only check reads'],
  [/ticked/, 'that board must be ticked when the customer is created'],
  [/export_kept_until/, 'the column the hand release of a kept export sets'],
  [/hostd\.lock/, 'the host lock the raw one-shot does not take'],
]

const text = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n') : null)

/** The board section of the runbook: from its heading to the next top-level heading, or null. */
export function boardSection(runbook) {
  const at = runbook.indexOf(`\n${BOARD_SECTION}\n`)
  if (at < 0) return null
  const rest = runbook.slice(at + 1)
  const next = rest.indexOf('\n## ', BOARD_SECTION.length)
  return next < 0 ? rest : rest.slice(0, next)
}

/** The board rows of the Karenz table (they start with a backticked `board`). */
export function karenzBoardRows(runbook) {
  return runbook.split('\n').filter((l) => /^\| `board`/.test(l))
}

/** Identifier-looking parts of the backticked spans and fenced blocks of a text: keys, snake_case names and kebab-case verbs. */
export function identifiers(doc) {
  const spans = []
  for (const m of doc.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) spans.push(m[1])
  for (const m of doc.replaceAll(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)) spans.push(m[1])
  const found = new Set()
  for (const s of spans) {
    for (const m of s.matchAll(/(?<![\w$<{./-])[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+(?![\w>}])/g)) {
      const t = m[0]
      const key = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t)
      const snake = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t)
      const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(t)
      if (key || snake || kebab) found.add(t)
    }
  }
  return [...found].sort()
}

/** Words that are part of ordinary tooling, not of this repository, and the shell and SQL words that look like identifiers. */
export const TOOLING = new Set([
  'read-only', 'pg_database', 'pg_dump', 'pg_restore', 'datname', 'sort', 'uniq', 'psql', 'ON_ERROR_STOP', 'env-file', 'no-privileges', 'no-owner',
  'default_transaction_read_only', 'current_database', 'to_regclass', 'pg_class', 'pg_namespace', 'relname', 'relkind', 'nspname',
])

/** Whether a tracked file that is not a document contains `token`. */
export function repoHasToken(root, token) {
  try {
    const out = execFileSync('git', ['grep', '-l', '-F', '-e', token, '--', '.', ':(exclude)*.md', ':(exclude)docs', ':(exclude)*.de.md'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 24,
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

export function runChecks(root = ROOT, { exists = (t) => repoHasToken(root, t) } = {}) {
  const failures = []
  const docs = Object.fromEntries(FILES.map((f) => [f, text(root, f)]))
  for (const [f, body] of Object.entries(docs)) if (body === null) failures.push(`${f} is missing`)
  if (failures.length > 0) return { failures, tokens: [] }

  for (const [f, re, what] of STALE) if (re.test(docs[f])) failures.push(`(a) ${f}: ${what}`)

  const section = boardSection(docs[RUNBOOK])
  if (section === null) {
    failures.push(`(b) ${RUNBOOK} has no section "${BOARD_SECTION}"`)
  } else {
    for (const [re, what] of REQUIRED) if (!re.test(section)) failures.push(`(b) the board section of ${RUNBOOK} does not say ${what}`)
  }

  const karenzRows = karenzBoardRows(docs[RUNBOOK])
  if (karenzRows.length < 2) failures.push(`(b) the Karenz table of ${RUNBOOK} has ${karenzRows.length} board row(s); it needs one for a board in its own database and one for a board in the kernel tables`)

  const tokens = new Set()
  const scanned = [
    [RUNBOOK, `${section ?? ''}\n${karenzRows.join('\n')}`],
    [README_EN, docs[README_EN]],
    [README_DE, docs[README_DE]],
    [DEFAULTS_EN, docs[DEFAULTS_EN]],
    [DEFAULTS_DE, docs[DEFAULTS_DE]],
  ]
  for (const [f, body] of scanned) {
    for (const t of identifiers(body)) {
      if (TOOLING.has(t)) continue
      tokens.add(t)
      if (!exists(t)) failures.push(`(c) ${f} names \`${t}\`, which no source file outside the documents contains`)
    }
  }

  const keep = /^\s*board:\s*(\d+)\s*,?\s*$/m.exec(docs[EXPORT_HOLD])
  const days = keep ? Number(keep[1]) : null
  if (days === null) failures.push(`(d) ${EXPORT_HOLD} has no EXPORT_KEEP_DAYS entry for board`)
  else {
    for (const row of karenzRows) {
      const m = /(\d+)\s+days\s+after\s+day\s+30/.exec(row)
      if (m && Number(m[1]) !== days) failures.push(`(d) a board Karenz row says ${m[1]} days after day 30; EXPORT_KEEP_DAYS.board is ${days}`)
    }
    if (karenzRows.length >= 2 && !karenzRows.some((r) => new RegExp(`${days}\\s+days\\s+after\\s+day\\s+30`).test(r))) {
      failures.push(`(d) no board Karenz row says that the export is kept ${days} days after day 30 (EXPORT_KEEP_DAYS.board)`)
    }
  }

  if (!/CREATE TABLE IF NOT EXISTS board_location[\s\S]*?\blocation\s+text/.test(docs[LOCATION_MIGRATION])) {
    failures.push(`(e) ${LOCATION_MIGRATION} no longer creates board_location with a location column: the read-only check of the runbook reads it`)
  }
  if (!/export_kept_until/.test(docs[KARENZ_MIGRATION])) failures.push(`(e) ${KARENZ_MIGRATION} has no export_kept_until column: the hand release of a kept export sets it`)
  if (section !== null && !/board_location/.test(section)) failures.push('(e) the board section does not read board_location')

  return { failures, tokens: [...tokens].sort() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { failures, tokens } = runChecks(ROOT)
  if (failures.length > 0) {
    for (const f of failures) console.error(`[board-docs] ${f}`)
    process.exit(1)
  }
  console.log(`[board-docs] OK, ${tokens.length} identifiers found in the source`)
}
