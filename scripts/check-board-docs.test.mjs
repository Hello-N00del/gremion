// node --test suite for the board documentation guard. Each RED case mutates a throwaway copy of
// the documents and asserts on the report text. Top-level test() declarations only
// (scripts/verify/suites/unit.mjs cross-checks the declared count with node's).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FILES, ROOT, RUNBOOK, README_EN, DEFAULTS_DE, EXPORT_HOLD, boardSection, identifiers, karenzBoardRows, runChecks } from './check-board-docs.mjs'

/** A copy of the guarded files in a temp tree; `exists` answers from a fixed set, so the case does not depend on git. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'boarddocs-'))
  for (const rel of FILES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), readFileSync(join(ROOT, rel)))
  }
  const read = (rel) => readFileSync(join(root, rel), 'utf8')
  const write = (rel, body) => writeFileSync(join(root, rel), body)
  const report = (known = null) => runChecks(root, { exists: known ? (t) => known.has(t) : () => true }).failures.join('\n')
  return { root, read, write, report, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('the real tree passes, and the scan is not vacuous', () => {
  const { failures, tokens } = runChecks(ROOT)
  assert.deepEqual(failures, [])
  for (const t of ['board_location', 'export_kept_until', 'karenz-status', 'KARENZ_FINAL_DELETION', 'BOARD_BACKEND']) {
    assert.ok(tokens.includes(t), `expected the scan to see ${t}`)
  }
  assert.ok(tokens.length >= 15, `only ${tokens.length} identifiers were scanned`)
  const runbook = readFileSync(join(ROOT, RUNBOOK), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(boardSection(runbook) !== null, 'the board section was found')
  assert.ok(karenzBoardRows(runbook).length >= 2, 'both board Karenz rows were found')
})

test('identifiers reads backticked spans and fenced blocks, and nothing from prose', () => {
  const doc = ['Plain day-30 and read-only prose, FOO_BAR too.', '', 'See `KARENZ_FINAL_DELETION` and `board_location` and `karenz-status`.', '', '```bash', 'tc karenz-run --env-file x', 'SELECT export_kept_until FROM plt.module_karenz', '```', ''].join('\n')
  assert.deepEqual(identifiers(doc), ['KARENZ_FINAL_DELETION', 'board_location', 'export_kept_until', 'karenz-run', 'karenz-status', 'module_karenz'])
})

test('RED (a): each stale statement, in either language, is reported', () => {
  const f = fixture()
  try {
    assert.equal(f.report(), '')
    f.write(README_EN, `${f.read(README_EN)}\n\`module.json\` therefore declares no \`runtime.database\` and no \`runtime.export\`.\n`)
    assert.match(f.report(), /\(a\) modules\/board\/README\.md: the README says board declares no database/)
    f.write(DEFAULTS_DE, `${f.read(DEFAULTS_DE)}\n(board braucht keines: es läuft im Prozess)\n`)
    assert.match(f.report(), /\(a\) docs\/pilot\/module-defaults\.de\.md: the German defaults say board needs no compose profile/)
    f.write(RUNBOOK, `${f.read(RUNBOOK)}\n| \`board\` (no module database) | x |\n`)
    assert.match(f.report(), /\(a\) docs\/runbooks\/tenant-lifecycle\.md: the Karenz row that says board has no module database/)
  } finally {
    f.cleanup()
  }
})

test('RED (b): the board section and its required statements', () => {
  const f = fixture()
  try {
    const runbook = f.read(RUNBOOK)
    f.write(RUNBOOK, runbook.replace('not available yet', 'available'))
    assert.match(f.report(), /\(b\) the board section of .* does not say that moving an existing customer's board/)
    f.write(RUNBOOK, runbook.replace(/\n## Board: where a customer's board lives\n/, '\n## Something else\n'))
    assert.match(f.report(), /\(b\) docs\/runbooks\/tenant-lifecycle\.md has no section/)
    f.write(RUNBOOK, runbook.replaceAll('| `board`', '| board'))
    assert.match(f.report(), /\(b\) the Karenz table .* has 0 board row\(s\)/)
  } finally {
    f.cleanup()
  }
})

test('RED (c): a verb or key that is named but exists in no source file is reported', () => {
  const f = fixture()
  try {
    const known = new Set(runChecks(f.root, { exists: () => true }).tokens)
    assert.equal(f.report(known), '')
    f.write(RUNBOOK, f.read(RUNBOOK).replace(/(\n## Board: where a customer's board lives\n)/, '$1\nRun `board-move` first, with `BOARD_MOVE_FREEZE_SECONDS` set.\n'))
    const out = f.report(known)
    assert.match(out, /\(c\) docs\/runbooks\/tenant-lifecycle\.md names `board-move`/)
    assert.match(out, /\(c\) docs\/runbooks\/tenant-lifecycle\.md names `BOARD_MOVE_FREEZE_SECONDS`/)
  } finally {
    f.cleanup()
  }
})

test('RED (d): the days the export is kept are the ones in export-hold.ts', () => {
  const f = fixture()
  try {
    f.write(EXPORT_HOLD, f.read(EXPORT_HOLD).replace(/^(\s*board:\s*)\d+/m, '$1400'))
    assert.match(f.report(), /\(d\) a board Karenz row says \d+ days after day 30; EXPORT_KEEP_DAYS\.board is 400/)
  } finally {
    f.cleanup()
  }
})

test('RED (e): the table the check reads and the column the release sets must still exist', () => {
  const f = fixture()
  try {
    f.write('gremion-ui/migrations/0066_board_location.sql', f.read('gremion-ui/migrations/0066_board_location.sql').replace('location    text', 'place       text'))
    assert.match(f.report(), /\(e\) gremion-ui\/migrations\/0066_board_location\.sql no longer creates board_location with a location column/)
    const k = 'packages/tenant-store/src/lifecycle/platform-migrations/0016_plt_module_karenz.sql'
    f.write(k, f.read(k).replaceAll('export_kept_until', 'export_held_to'))
    assert.match(f.report(), /\(e\) .*0016_plt_module_karenz\.sql has no export_kept_until column/)
  } finally {
    f.cleanup()
  }
})
