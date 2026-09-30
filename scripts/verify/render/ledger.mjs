// TASK-053 (G-053-ledger, TRD-343): the RED ledger contract. Every guard id
// TASK-053 exports (render/suite.mjs GUARD_IDS) carries one `## <guard-id>`
// section in render/red-ledger.md holding a dated red and a dated green on the
// SAME case:
//
//   Date: YYYY-MM-DD
//   ### Mutation                          (non-empty)
//   ### Observed failing output           (a fenced block, non-empty)
//   ### Observed passing output (after)   (a fenced block, non-empty)
//   ### Verifier                          (non-empty)
//   ### Restore                           (non-empty)
//
// Pure: ledgerProblems() takes the text, so ledger.test.mjs can watch every
// incomplete shape fail.
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const LEDGER_PATH = path.join(import.meta.dirname, 'red-ledger.md')
export const MIN_LEDGER_IDS = 5
export const REQUIRED_SUBSECTIONS = [
  { title: 'Mutation', fenced: false },
  { title: 'Observed failing output', fenced: true },
  { title: 'Observed passing output (after)', fenced: true },
  { title: 'Verifier', fenced: false },
  { title: 'Restore', fenced: false },
]

export function readLedger(file = LEDGER_PATH) {
  return readFileSync(file, 'utf8')
}

/** `## <id>` sections of the ledger: { id -> body }. Headings inside fenced
 * blocks are output, never sections. */
export function ledgerSections(text) {
  const sections = {}
  let current = null
  let inFence = false
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const m = !inFence && /^## (\S+)\s*$/.exec(line)
    if (m) {
      current = m[1]
      if (current in sections) sections[`${current} (duplicate)`] = ''
      sections[current] = ''
      continue
    }
    if (current) sections[current] += `${line}\n`
  }
  return sections
}

/** `### <title>` subsections of one section body: { title -> body }. */
function subsections(body) {
  const out = {}
  let current = null
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const m = !inFence && /^### (.+?)\s*$/.exec(line)
    if (m) {
      current = m[1]
      out[current] = ''
      continue
    }
    if (current) out[current] += `${line}\n`
  }
  return out
}

/** Non-empty fenced blocks of a subsection body. */
function fencedBlocks(body) {
  return [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.trim().length > 0)
}

/** Every problem of the ledger against the exported ids (empty = complete). */
export function ledgerProblems(text, ids) {
  const out = []
  if (!Array.isArray(ids) || ids.length < MIN_LEDGER_IDS) {
    out.push(`the ledger is judged against ${ids?.length ?? 0} exported guard id(s), fewer than ${MIN_LEDGER_IDS}`)
  }
  const sections = ledgerSections(text)
  for (const key of Object.keys(sections)) if (key.endsWith(' (duplicate)')) out.push(`## ${key.replace(' (duplicate)', '')} appears more than once`)
  for (const id of ids ?? []) {
    const body = sections[id]
    if (body === undefined) {
      out.push(`## ${id}: no section`)
      continue
    }
    if (!/^Date: \d{4}-\d{2}-\d{2}\b/m.test(body)) out.push(`## ${id}: no "Date: YYYY-MM-DD" line`)
    const subs = subsections(body)
    for (const { title, fenced } of REQUIRED_SUBSECTIONS) {
      const sub = subs[title]
      if (sub === undefined) out.push(`## ${id}: no "### ${title}"`)
      else if (fenced && fencedBlocks(sub).length === 0) out.push(`## ${id}: "### ${title}" has no non-empty fenced block`)
      else if (!fenced && sub.trim().length === 0) out.push(`## ${id}: "### ${title}" is empty`)
    }
  }
  const known = new Set(ids ?? [])
  for (const key of Object.keys(sections)) {
    if (!key.endsWith(' (duplicate)') && !known.has(key)) out.push(`## ${key}: a section for an id the suite does not export`)
  }
  return out
}
