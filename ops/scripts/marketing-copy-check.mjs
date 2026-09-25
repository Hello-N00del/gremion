#!/usr/bin/env node
// marketing-copy-check.mjs -- the "CI grep" of TASK-005 (TRD-265, TRD-112).
//
// Fails when marketing, product or onboarding copy
//   (a) names a system from the third-party licence register together with a
//       licence that is not that system's register value, or
//   (b) asserts that online student-body elections are lawful, or presents the
//       elections module as fit for statutory use.
//
// Both rule sets are READ FROM THE RECORDS, not restated here, so prose and
// check cannot drift apart:
//   docs/compliance/licence-register.md  section 2 table -> allowed licence strings
//   docs/compliance/elections-scope.md   section 2 table -> forbidden phrasings
// plus a small set of general lawfulness / statutory-fitness patterns below
// (the table is a floor, not a whitelist).
//
// Vacuity guards: the register must yield a row for each of the seven systems
// TRD-265 names, the elections table must yield phrasings, and every required
// scope entry must exist and contribute at least one file -- a moved directory
// fails instead of turning "no violations" into "nothing scanned".
//
// Run:  node ops/scripts/marketing-copy-check.mjs [--root DIR]
// Test: node --test ops/scripts/marketing-copy-check.test.mjs
// Exit: 0 clean; 1 a violation; 2 the check could not run (records unparseable,
//       scope missing). Both 1 and 2 must fail CI.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REGISTER_PATH = 'docs/compliance/licence-register.md'
export const ELECTIONS_PATH = 'docs/compliance/elections-scope.md'

// The seven systems TRD-265 names (plus Helios, which the register also
// carries). Each maps a register "System" cell prefix to the names copy uses.
export const SYSTEMS = [
  { key: 'Nextcloud', aliases: ['Nextcloud'] },
  { key: 'Collabora Online', aliases: ['Collabora Online', 'Collabora', 'CODE'] },
  { key: 'Matrix homeserver (Synapse)', aliases: ['Synapse', 'Matrix homeserver', 'Matrix-Homeserver', 'Matrix'] },
  { key: 'LiveKit', aliases: ['LiveKit'] },
  { key: 'Element Call', aliases: ['Element Call'] },
  { key: 'Keycloak', aliases: ['Keycloak'] },
  { key: 'Vaultwarden', aliases: ['Vaultwarden'] },
  { key: 'Helios', aliases: ['Helios'], optional: true },
]

// Copy in scope. `required` entries must exist and yield >= 1 file; the
// optional ones are the sales / trust / onboarding homes that do not exist yet
// and are scanned from the day they appear.
export const SCOPE = [
  { path: 'README.md', required: true },
  { path: 'docs/about-gremion.md', required: true },
  { path: 'gremion-public/src', required: true },
  { path: 'gremion-ui/src/lib/i18n', required: true },
  { path: 'docs/sales' },
  { path: 'docs/marketing' },
  { path: 'docs/trust' },
  { path: 'docs/onboarding' },
]
const TEXT_EXT = /\.(md|txt|html|svelte|ts|js|json|ya?ml)$/i
// Test code is not copy; fixtures in it would otherwise trip the check.
const NOT_COPY = /(^|[\\/])(test|tests|__tests__|node_modules)([\\/]|$)|\.(test|spec)\.[a-z]+$/i

// Licence names as copy writes them. Greedy on purpose: "AGPL v3 or later"
// is one mention, so "or later" cannot hide outside an allowed span.
const LICENCE_RE = new RegExp(
  [
    String.raw`\bGNU\s+(?:Affero\s+|Lesser\s+)?General\s+Public\s+Licen[cs]e(?:,?\s+(?:version|v\.?)\s*\d(?:\.\d)?)?(?:\s+or\s+(?:any\s+)?later(?:\s+version)?|\s+only)?`,
    String.raw`\b(?:GNU\s+)?(?:A|L)?GPL(?:[- ]?v?\d(?:\.\d)?)?(?:-only|-or-later|\+|\s+or\s+later|\s+only)?(?!\w)`,
    String.raw`\bMozilla\s+Public\s+Licen[cs]e(?:,?\s+(?:v\.?|version)?\s*\d\.\d)?`,
    String.raw`\bMPL(?:[- ]?v?\d\.\d)?\b`,
    String.raw`\bApache(?:\s+Licen[cs]e)?(?:,?\s*(?:Version|v\.?)?\s*-?\d\.\d)?\b`,
    String.raw`\bMIT(?:\s+Licen[cs]e)?\b`,
    String.raw`\bBSD(?:[- ]\d-Clause)?\b`,
    String.raw`\bISC\s+Licen[cs]e\b`,
    String.raw`\bEUPL(?:[- ]?\d\.\d)?\b`,
    String.raw`\bBusiness\s+Source\s+Licen[cs]e\b|\bBUSL(?:-\d\.\d)?\b`,
    String.raw`\bServer\s+Side\s+Public\s+Licen[cs]e\b|\bSSPL\b`,
    String.raw`\bElastic\s+Licen[cs]e\b`,
    String.raw`\bproprietär\w*|\bproprietary\b`,
  ].join('|'),
  'gi',
)

// General lawfulness / statutory-fitness claims about elections (the
// elections-scope.md table adds its concrete phrasings on top).
export const ELECTION_PATTERNS = [
  /\b(?:elections?|e-?voting|online[- ]voting)\b[^.!?\n]{0,80}\b(?:are|is|be|being)\s+(?:fully\s+)?(?:lawful|legal|legally\s+(?:valid|binding|compliant|secure)|permitted|allowed|admissible)\b/i,
  /\b(?:lawful|legally\s+(?:valid|binding|compliant|secure))\s+(?:online\s+|statutory\s+|student[- ]body\s+)*(?:elections?|e-?voting|ballots?)\b/i,
  /\b(?:fit|suitable|approved|certified|ready|compliant)\s+for\s+(?:use\s+in\s+)?statutory\b/i,
  /\bstatutory[- ](?:use|elections?)\b[^.!?\n]{0,40}\b(?:supported|compliant|approved|ready)\b/i,
  /\bWahl(?:en)?\b[^.!?\n]{0,80}\b(?:sind|ist)\s+(?:rechtlich\s+)?(?:zulässig|rechtssicher|rechtsgültig|rechtskonform|erlaubt)\b/i,
  /\b(?:rechtssicher|rechtsgültig|rechtskonform|zulässig)\w*\s+(?:Online-)?(?:Gremien|Hochschul|Studierendenschafts)?[Ww]ahl/,
  /\bfür\s+(?:satzungsgemäße|amtliche|offizielle|gesetzliche)\s+Wahlen\s+(?:geeignet|zugelassen)\b/i,
  /\beignet sich\b[^.!?\n]{0,40}\b(?:satzungsgemäß|amtlich|offiziell|gesetzlich)\w*\s+Wahl/i,
  /\brechts(?:sicher|gültig|konform)\b[^.!?\n]{0,60}wahl/i,
  /wahl\w*\b[^.!?\n]{0,60}\brechts(?:sicher|gültig|konform)\b/i,
]

// Broader patterns that the sanctioned honest-scope notice itself would
// match ("does not run the university's statutory elections", "keine
// satzungsgemäßen Wahlen"). They apply only to sentences without a negation.
export const ELECTION_PATTERNS_UNLESS_NEGATED = [
  /\b(?:zulässig|erlaubt)\b[^.!?\n]{0,40}\b(?:Ländern|Land|Bundesl\w*)\b/i,
  /\b(?:Ländern|Land|Bundesl\w*)\b[^.!?\n]{0,40}\b(?:zulässig|erlaubt)\b/i,
  /\b(?:zulässig|erlaubt)\b[^.!?\n]{0,40}\bWahl/i,
  /\b(?:official|binding|statutory)\s+(?:[\w-]+\s+){0,2}elections?\b/i,
  /\b(?:satzungsgemäß|amtlich|offiziell|gesetzlich)\w*\s+(?:\w+\s+)?Wahl/i,
]
const NEGATION = /\b(?:not|no|never|nor|cannot|can't|doesn't|does not|keine?[nmrs]?|nicht|niemals|weder)\b/i

// ── records ────────────────────────────────────────────────────────────────

function tableRows(text, afterHeading) {
  const start = text.indexOf(afterHeading)
  if (start < 0) return []
  const rest = text.slice(start + afterHeading.length)
  const end = rest.search(/\n## /)
  const body = end < 0 ? rest : rest.slice(0, end)
  const lines = body.split('\n').map((l) => l.trim())
  const firstTable = []
  let seen = false
  for (const l of lines) {
    if (l.startsWith('|')) { firstTable.push(l); seen = true } else if (seen) break
  }
  return firstTable
    .filter((l) => !/^\|[\s|:-]+\|$/.test(l))
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
}

/** register text -> Map(systemKey -> {spdx, allowed:[strings]}) */
export function parseRegister(text) {
  const rows = tableRows(text, '## 2. Register')
  if (rows.length < 2) throw new Error(`${REGISTER_PATH}: no section 2 register table found`)
  const header = rows[0].map((c) => c.toLowerCase())
  const iSys = header.indexOf('system')
  const iSpdx = header.indexOf('spdx expression')
  const iPlain = header.indexOf('plain wording for copy')
  if (iSys < 0 || iSpdx < 0 || iPlain < 0) {
    throw new Error(`${REGISTER_PATH}: register table lacks a System / SPDX expression / Plain wording for copy column`)
  }
  const out = new Map()
  for (const row of rows.slice(1)) {
    const sys = SYSTEMS.find((s) => row[iSys]?.startsWith(s.key.split(' (')[0]))
    if (!sys) continue
    const spdx = [...(row[iSpdx] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1])
    const plain = [...(row[iPlain] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])
    if (spdx.length === 0 || plain.length === 0) {
      throw new Error(`${REGISTER_PATH}: row for ${sys.key} has no \`SPDX expression\` or "plain wording"`)
    }
    // A plain wording with a parenthetical is also allowed without it:
    // "GNU AGPL v3 (dual-licensed; ...)" -> "GNU AGPL v3".
    const extra = plain.map((p) => p.replace(/\s*\(.*\)\s*$/, '')).filter((p) => p && !plain.includes(p))
    // An SPDX disjunction also allows each alternative on its own:
    // "AGPL-3.0-only OR LicenseRef-X" -> "AGPL-3.0-only".
    for (const e of spdx) if (/ OR /.test(e)) extra.push(...e.split(/\s+OR\s+/).filter((x) => !x.startsWith('LicenseRef-')))
    out.set(sys.key, { spdx, allowed: [...spdx, ...plain, ...extra] })
  }
  const missing = SYSTEMS.filter((s) => !s.optional && !out.has(s.key)).map((s) => s.key)
  if (missing.length) throw new Error(`${REGISTER_PATH}: no register row for ${missing.join(', ')}`)
  return out
}

/** elections-scope text -> [lower-cased phrase or RegExp] */
export function parseForbidden(text) {
  const rows = tableRows(text, '**Forbidden phrasings**')
  const phrases = []
  for (const row of rows.slice(1)) {
    for (const cell of row) {
      for (const m of cell.matchAll(/„([^"“”]+)[“"]|"([^"]+)"/g)) {
        const p = (m[1] ?? m[2]).trim()
        if (!p) continue
        if (/\[[^\]]+\]/.test(p)) {
          // "lawful in [any Land]" -> the words before the placeholder plus one word.
          const esc = p.split(/\[[^\]]+\]/).map((s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          phrases.push(new RegExp(`\\b${esc.join('\\s+\\S+\\s*')}\\S*`, 'i'))
        } else {
          phrases.push(p.toLowerCase())
        }
      }
    }
  }
  if (phrases.length < 10) {
    throw new Error(`${ELECTIONS_PATH}: forbidden-phrasings table yielded ${phrases.length} phrasings (expected >= 10)`)
  }
  return phrases
}

// ── the check ──────────────────────────────────────────────────────────────

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function sentences(line) {
  // Split on sentence ends and on string-literal boundaries in code.
  return line.split(/(?<=[.!?])\s+|[`'"]\s*[,;:]\s*[`'"]/).filter((s) => s.trim())
}

/** One sentence -> licence problems. */
export function licenceProblems(sentence, register) {
  const mentions = []
  for (const s of SYSTEMS) {
    for (const a of s.aliases) {
      // CODE / Matrix are only systems when written that way, not as words.
      const flags = a === 'CODE' ? 'g' : 'gi'
      for (const m of sentence.matchAll(new RegExp(`(?<![\\w-])${esc(a)}(?![\\w-])`, flags))) {
        mentions.push({ key: s.key, start: m.index, end: m.index + m[0].length })
      }
    }
  }
  if (mentions.length === 0) return []
  const problems = []
  for (const lm of sentence.matchAll(LICENCE_RE)) {
    // "MIT" is a licence only in capitals; "Mit" is German for "with".
    if (/^mit\b/i.test(lm[0]) && !/^MIT\b/.test(lm[0])) continue
    const ls = lm.index
    const le = ls + lm[0].length
    // Attribute the licence to the nearest system mention, preferring one before it.
    const before = mentions.filter((m) => m.end <= ls).sort((a, b) => b.end - a.end)[0]
    const after = mentions.filter((m) => m.start >= le).sort((a, b) => a.start - b.start)[0]
    const owner = before && (!after || ls - before.end <= after.start - le + 20) ? before : after ?? before
    const reg = register.get(owner.key)
    if (!reg) {
      problems.push(`names a licence ("${lm[0]}") for ${owner.key}, which has no register row`)
      continue
    }
    const covered = reg.allowed.some((a) => {
      for (const am of sentence.matchAll(new RegExp(`(?<![\\w-])${esc(a)}(?![\\w-])`, 'gi'))) {
        if (am.index <= ls && am.index + am[0].length >= le) return true
      }
      return false
    })
    if (!covered) {
      problems.push(`states "${lm[0].trim()}" for ${owner.key}; the register allows only ${reg.allowed.map((a) => `"${a}"`).join(' / ')}`)
    }
  }
  return problems
}

/** One sentence -> elections problems. */
export function electionProblems(sentence, forbidden) {
  const problems = []
  const low = sentence.toLowerCase()
  for (const f of forbidden) {
    if (typeof f === 'string' ? low.includes(f) : f.test(sentence)) {
      problems.push(`uses a forbidden elections phrasing (${typeof f === 'string' ? `"${f}"` : f}) -- ${ELECTIONS_PATH} section 2`)
    }
  }
  for (const re of ELECTION_PATTERNS) {
    if (re.test(sentence)) problems.push(`asserts election lawfulness or statutory fitness (${re}) -- TRD-112`)
  }
  if (!NEGATION.test(sentence)) {
    for (const re of ELECTION_PATTERNS_UNLESS_NEGATED) {
      if (re.test(sentence)) problems.push(`asserts election lawfulness or statutory fitness (${re}) -- TRD-112`)
    }
  }
  return problems
}

// Prose is hard-wrapped, so a sentence can span lines. In Markdown and plain
// text, consecutive prose lines are joined into one paragraph (reported at its
// first line); a blank line, heading, table row, list item, quote or code
// fence starts a new one. Code files are checked line by line.
const BLOCK_START = /^\s*(?:#|\||[-*+]\s|\d+[.)]\s|>|```|~~~)/

export function paragraphs(text, prose) {
  const lines = text.split(/\r?\n/)
  if (!prose) return lines.map((l, i) => ({ line: i + 1, text: l }))
  const out = []
  let cur = null
  lines.forEach((l, i) => {
    if (!l.trim()) { cur = null; return }
    if (!cur || BLOCK_START.test(l) || cur.text.trimStart().startsWith('|')) {
      cur = { line: i + 1, text: l }
      out.push(cur)
    } else {
      cur.text += ` ${l.trim()}`
    }
  })
  return out
}

export function checkText(text, register, forbidden, prose = true) {
  const out = []
  for (const para of paragraphs(text, prose)) {
    for (const s of sentences(para.text)) {
      for (const p of [...licenceProblems(s, register), ...electionProblems(s, forbidden)]) {
        out.push({ line: para.line, problem: p, text: s.trim().slice(0, 160) })
      }
    }
  }
  return out
}

function walk(abs, files) {
  const st = statSync(abs)
  if (st.isDirectory()) {
    for (const e of readdirSync(abs)) {
      const p = join(abs, e)
      if (NOT_COPY.test(e)) continue
      walk(p, files)
    }
  } else if (TEXT_EXT.test(abs) && !NOT_COPY.test(abs)) {
    files.push(abs)
  }
}

export function collectScope(root, scope = SCOPE) {
  const files = []
  const errors = []
  for (const entry of scope) {
    const abs = join(root, entry.path)
    if (!existsSync(abs)) {
      if (entry.required) errors.push(`required scope entry ${entry.path} does not exist`)
      continue
    }
    const before = files.length
    walk(abs, files)
    if (entry.required && files.length === before) errors.push(`required scope entry ${entry.path} yielded no files`)
  }
  return { files, errors }
}

export function run(root) {
  const register = parseRegister(readFileSync(join(root, REGISTER_PATH), 'utf8'))
  const forbidden = parseForbidden(readFileSync(join(root, ELECTIONS_PATH), 'utf8'))
  const { files, errors } = collectScope(root)
  if (errors.length) throw new Error(errors.join('; '))
  if (files.length === 0) throw new Error('scope matched no files')
  const violations = []
  for (const f of files) {
    for (const v of checkText(readFileSync(f, 'utf8'), register, forbidden, /\.(md|txt)$/i.test(f))) {
      violations.push({ file: relative(root, f).split(sep).join('/'), ...v })
    }
  }
  return { violations, files: files.length, systems: register.size, phrasings: forbidden.length }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--root')
  const root = i > 0 ? process.argv[i + 1] : join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
  let res
  try {
    if (i > 0 && !root) throw new Error('--root needs a directory')
    res = run(root)
  } catch (e) {
    console.error(`marketing-copy-check: ERROR ${e.message}`)
    process.exit(2)
  }
  for (const v of res.violations) console.error(`marketing-copy-check: FAIL ${v.file}:${v.line}: ${v.problem}\n    ${v.text}`)
  if (res.violations.length) {
    console.error(`marketing-copy-check: ${res.violations.length} violation(s) in ${res.files} file(s) scanned.`)
    process.exit(1)
  }
  console.log(`marketing-copy-check: OK ${res.files} file(s) scanned against ${res.systems} register rows and ${res.phrasings} forbidden phrasings`)
}
