#!/usr/bin/env node
// data-fingerprint.mjs -- the judge behind customer-provision-proof.sh's
// "suspend does not alter stored data" check (TASK-043c R30 addendum A2,
// PRD-OPS-004).
//
// The proof writes ledger/fingerprint-before-suspend.txt before `tenant
// suspend` and ledger/fingerprint-after-resume.txt after `tenant resume`, one
// line per table of the customer's kernel database and of every enabled
// module database, plus the realm's user count:
//   <scope>:<schema>.<table>\t<row count>\t<md5 over the ordered rows | ->
//   realm-users\t<count>
// ('#' lines are comments.) This compares the two. Equal is the ONLY pass:
// a changed / added / dropped table, a changed realm user count, a malformed
// line, and an EMPTY fingerprint (zero tables, or no realm user count: a check
// that read nothing proved nothing) all fail.
//
//   node data-fingerprint.mjs compare <before file> <after file>
// prints one violation per line; exit 0 only when there is none.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TABLE = /^([a-z0-9_-]+:[^\t]+)\t(\d+)\t([0-9a-f]{32}|-)$/
const REALM = /^realm-users\t(\d+)$/

export function parseFingerprint(text) {
  const tables = new Map()
  let realmUsers = null
  const malformed = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.startsWith('#')) continue
    const t = TABLE.exec(line)
    if (t) {
      tables.set(t[1], { count: t[2], md5: t[3] })
      continue
    }
    const r = REALM.exec(line)
    if (r) {
      realmUsers = r[1]
      continue
    }
    malformed.push(line)
  }
  return { tables, realmUsers, malformed }
}

function emptiness(fp, when) {
  const out = []
  if (fp.tables.size === 0) out.push(`${when}: no table was fingerprinted (zero tables proves nothing)`)
  if (fp.realmUsers === null) out.push(`${when}: no realm user count was recorded`)
  for (const l of fp.malformed) out.push(`${when}: malformed line ${JSON.stringify(l)}`)
  return out
}

export function compareFingerprints(beforeText, afterText) {
  const b = parseFingerprint(beforeText)
  const a = parseFingerprint(afterText)
  const out = [...emptiness(b, 'before suspend'), ...emptiness(a, 'after resume')]
  const keys = [...new Set([...b.tables.keys(), ...a.tables.keys()])].sort()
  for (const k of keys) {
    const x = b.tables.get(k)
    const y = a.tables.get(k)
    if (!y) out.push(`${k}: present before suspend, absent after resume`)
    else if (!x) out.push(`${k}: absent before suspend, present after resume`)
    else if (x.count !== y.count || x.md5 !== y.md5) out.push(`${k}: changed (${x.count} rows -> ${y.count} rows; md5 ${x.md5} -> ${y.md5})`)
  }
  if (b.realmUsers !== null && a.realmUsers !== null && b.realmUsers !== a.realmUsers) {
    out.push(`realm users: ${b.realmUsers} before suspend, ${a.realmUsers} after resume`)
  }
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [verb, before, after] = process.argv.slice(2)
  if (verb !== 'compare' || !before || !after) {
    console.log('usage: data-fingerprint.mjs compare <before file> <after file>')
    process.exit(2)
  }
  let bt
  let at
  try {
    bt = readFileSync(before, 'utf8')
    at = readFileSync(after, 'utf8')
  } catch (e) {
    console.log(`data-fingerprint: ${e.message}`)
    process.exit(1)
  }
  const violations = compareFingerprints(bt, at)
  for (const v of violations) console.log(v)
  process.exit(violations.length === 0 ? 0 : 1)
}
