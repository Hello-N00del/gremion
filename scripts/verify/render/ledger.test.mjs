// TASK-053 (G-053-ledger, TRD-343; brief TDD 7): render/red-ledger.md carries a
// complete, dated RED and GREEN for every exported guard id. The synthetic
// cases watch every incomplete shape fail; the last case judges the real file.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ledgerProblems, ledgerSections, MIN_LEDGER_IDS, readLedger } from './ledger.mjs'
import { GUARD_IDS } from './suite.mjs'

const FENCE = '```'

function section(id, { date = 'Date: 2026-09-29', failing = 'FAIL something', passing = 'PASS something', drop = [] } = {}) {
  const parts = [`## ${id}`, '', date, '']
  const subs = {
    Mutation: 'one line changed',
    'Observed failing output': `${FENCE}text\n${failing}\n${FENCE}`,
    'Observed passing output (after)': `${FENCE}text\n${passing}\n${FENCE}`,
    Verifier: 'node --test x',
    Restore: 'git checkout -- x',
  }
  for (const [title, body] of Object.entries(subs)) {
    if (drop.includes(title)) continue
    parts.push(`### ${title}`, '', body, '')
  }
  return parts.join('\n')
}

const IDS = ['G-1', 'G-2', 'G-3', 'G-4', 'G-5']
const ledger = (overrides = {}) => ['# ledger', '', ...IDS.map((id) => section(id, overrides[id]))].join('\n')

test('a complete ledger over five ids passes', () => {
  assert.deepEqual(ledgerProblems(ledger(), IDS), [])
})

test('a missing section fails, naming the id', () => {
  const text = ['# ledger', ...IDS.slice(0, 4).map((id) => section(id))].join('\n')
  assert.deepEqual(ledgerProblems(text, IDS), ['## G-5: no section'])
})

test('a missing Date: line fails', () => {
  assert.deepEqual(ledgerProblems(ledger({ 'G-2': { date: 'Dated: yesterday' } }), IDS), ['## G-2: no "Date: YYYY-MM-DD" line'])
})

test('a missing or empty failing block fails', () => {
  assert.deepEqual(ledgerProblems(ledger({ 'G-3': { failing: '' } }), IDS), ['## G-3: "### Observed failing output" has no non-empty fenced block'])
  assert.deepEqual(ledgerProblems(ledger({ 'G-3': { drop: ['Observed failing output'] } }), IDS), ['## G-3: no "### Observed failing output"'])
})

test('a missing passing-after block fails', () => {
  assert.deepEqual(ledgerProblems(ledger({ 'G-4': { drop: ['Observed passing output (after)'] } }), IDS), [
    '## G-4: no "### Observed passing output (after)"',
  ])
})

test('a missing Mutation, Verifier or Restore fails', () => {
  for (const title of ['Mutation', 'Verifier', 'Restore']) {
    assert.deepEqual(ledgerProblems(ledger({ 'G-1': { drop: [title] } }), IDS), [`## G-1: no "### ${title}"`], title)
  }
})

test('fewer than five ids fails', () => {
  const four = IDS.slice(0, 4)
  const text = ['# ledger', ...four.map((id) => section(id))].join('\n')
  assert.match(ledgerProblems(text, four).join('\n'), new RegExp(`fewer than ${MIN_LEDGER_IDS}`))
})

test('a section for an unexported id, or a duplicate section, fails', () => {
  assert.deepEqual(ledgerProblems(`${ledger()}\n${section('G-9')}`, IDS), ['## G-9: a section for an id the suite does not export'])
  assert.deepEqual(ledgerProblems(`${ledger()}\n${section('G-1')}`, IDS), ['## G-1 appears more than once'])
})

test('a ## line inside a fenced block is output, never a section', () => {
  const sections = ledgerSections(ledger({ 'G-1': { failing: '## G-7 quoted from a log' } }))
  assert.equal(sections['G-7'], undefined)
})

test('the real red-ledger.md is complete for every exported guard id', () => {
  assert.ok(GUARD_IDS.length >= MIN_LEDGER_IDS, `suite.mjs exports ${GUARD_IDS.length} guard id(s)`)
  assert.deepEqual(ledgerProblems(readLedger(), GUARD_IDS), [])
})
