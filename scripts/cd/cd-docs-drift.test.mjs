// Drift guard for the operator document of the continuous-deployment program
// (docs/ops/continuous-deployment.md).
//
// WHY. A document that names a verb, a flag, a hold kind, a mail kind or a config key by hand
// goes stale the day the program changes, and an operator who follows a stale document at the
// wrong moment (a held release, a parked window) does harm. So the document is written in
// fixed tables under fixed headings, and this file reads those tables and compares them with
// what the program actually defines: the verb functions of lib/cd, the config parser and its
// defaults in core.sh, the state schema (hold kinds, phases, stages, block rules), the mail
// kinds of notify.sh and the shipped template cd.env.tmpl. A name in the document that the
// program does not have fails, and a name the program has that the document does not
// mention fails: both directions.
//
// It also holds the document to the public-repository rules: no e-mail address outside
// example.org, example.com, .invalid and .test (the same pattern as cd-guards.test.mjs, copied
// here on purpose: importing that file would register its tests a second time), no calendar
// date at all (the agreement date is written as a placeholder), and the two placeholders of the
// adoption steps must be there.
//
// Every guard here was watched RED: the document was absent, then a key was renamed in the
// document, a verb was renamed in a library, an address was pasted into the document and a
// number of the lock span was changed. The review rounds added: a flag read per verb (a flag of
// another verb in a command fails), the leaf lock sentence and the two reminders pinned as whole
// sentences (each was changed to another number or period and went RED), and the prose claims about
// code pinned to the code they were read from. The canary tests prove the scanners still fire, because
// a scan that reaches nothing reports clean.
//
// Collection. unit:node counts the declared tests of a file by the lines that start with the
// word `test` and an opening bracket, so every test below is a plain call at the start of a
// line and nothing is registered inside a loop. Loops live inside the bodies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = 'docs/ops/continuous-deployment.md'
const CORE = 'infra/host/lib/cd/core.sh'
const TEMPLATE = 'infra/host/templates/env/cd.env.tmpl'

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

function docText() {
  assert.ok(existsSync(path.join(ROOT, DOC)), `${DOC} does not exist`)
  return read(DOC)
}

// A text with every run of white space (a wrapped line) as one space, so a phrase can be pinned whole.
function flat(text) {
  return text.replace(/\s+/g, ' ')
}

function libFiles() {
  const files = globSync('infra/host/lib/cd/*.sh', { cwd: ROOT })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => !f.endsWith('/apply-root.sh'))
    .toSorted((a, b) => a.localeCompare(b))
  assert.ok(files.length >= 15, `only ${files.length} libraries matched under infra/host/lib/cd`)
  return files
}

// ---- reading the document -----------------------------------------------------------------

// The body of the `## ` section whose title starts with TITLE (up to the next `## ` line).
function section(text, title) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).startsWith(title))
  assert.ok(start >= 0, `the document has no section "## ${title}"`)
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n')
}

// The body of the `### ` subsection whose title starts with TITLE, inside a section text.
function subsection(text, title) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('### ') && l.slice(4).startsWith(title))
  assert.ok(start >= 0, `the section has no subsection "### ${title}"`)
  let end = lines.findIndex((l, i) => i > start && l.startsWith('### '))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n')
}

// The rows of the markdown tables in a text, as arrays of trimmed cells; the header and the
// separator row of each table are dropped.
function tableRows(text) {
  const rows = []
  let inTable = false
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) {
      inTable = false
      skipped = 0
      continue
    }
    if (!inTable) {
      inTable = true
      skipped = 0
    }
    if (skipped < 2) {
      skipped += 1
      continue
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    rows.push(cells)
  }
  return rows
}

// The text of a cell without its code quotes.
function bare(cell) {
  return cell.replace(/`/g, '').trim()
}

// The first cell of every table row, without code quotes.
function firstCells(text) {
  return tableRows(text).map((r) => bare(r[0]))
}

// Every inline code span of a text.
function codeSpans(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
}

// ---- reading the program ------------------------------------------------------------------

function verbsOfProgram() {
  const verbs = new Set()
  for (const f of libFiles()) {
    for (const m of read(f).matchAll(/^cd_cmd_([a-z0-9_]+)\(\)/gm)) verbs.add(m[1].replaceAll('_', '-'))
  }
  assert.ok(verbs.size >= 14, `only ${verbs.size} verbs found in the libraries`)
  return verbs
}

// The body of an associative-array declaration in a shell file: from the declaration line to
// the first line that starts with a closing bracket.
function shellBlock(rel, declaration) {
  const lines = read(rel).split('\n')
  const start = lines.findIndex((l) => l.startsWith(declaration))
  assert.ok(start >= 0, `${rel} has no "${declaration}"`)
  const end = lines.findIndex((l, i) => i > start && l.startsWith(')'))
  assert.ok(end > start, `${rel}: the block "${declaration}" does not close`)
  return lines.slice(start + 1, end).join('\n')
}

function keysOfKinds() {
  const keys = [...shellBlock(CORE, 'declare -gA CD_KIND=(').matchAll(/\[(CD_[A-Z0-9_]+)\]=/g)].map((m) => m[1])
  assert.ok(keys.length >= 45, `only ${keys.length} config keys in CD_KIND`)
  return keys
}

function defaultsOfProgram() {
  const out = new Map()
  for (const m of shellBlock(CORE, 'declare -gA CD_DEFAULTS=(').matchAll(/\[(CD_[A-Z0-9_]+)\]=("[^"]*"|\S+)/g)) {
    out.set(m[1], m[2].replace(/^"(.*)"$/, '$1'))
  }
  assert.ok(out.size >= 35, `only ${out.size} defaults in CD_DEFAULTS`)
  return out
}

function templateValues() {
  const out = new Map()
  for (const raw of read(TEMPLATE).split('\n')) {
    const l = raw.trim()
    if (l === '' || l.startsWith('#')) continue
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l)
    assert.ok(m, `not KEY=VALUE in the template: ${l}`)
    out.set(m[1], m[2].replace(/^"(.*)"$/, '$1'))
  }
  assert.ok(out.size >= 45, `only ${out.size} keys in the template`)
  return out
}

// The word list inside `IN("a","b",...)` of the state schema check that starts with HEAD.
function schemaList(head) {
  const m = new RegExp(`${head.replace(/[.()|]/g, '\\$&')}[^"]*IN\\(([^)]*)\\)`).exec(read(CORE))
  assert.ok(m, `core.sh has no schema check "${head}"`)
  const words = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])
  assert.ok(words.length >= 4, `the schema list "${head}" parsed to ${words.length} words`)
  return words
}

function sorted(list) {
  return [...list].toSorted((a, b) => a.localeCompare(b))
}

function onlyIn(a, b) {
  const set = new Set(b)
  return sorted(a.filter((x) => !set.has(x)))
}

// The address pattern of cd-guards.test.mjs (see there for the unit-instance exemption).
const ADDRESS = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g
function foreignAddresses(text) {
  const bad = []
  for (const m of text.matchAll(ADDRESS)) {
    const domain = m[1].toLowerCase()
    if (domain === 'example.org' || domain === 'example.com') continue
    if (domain.endsWith('.invalid') || domain.endsWith('.test')) continue
    if (domain.endsWith('.service')) continue
    bad.push(m[0])
  }
  return bad
}

// A calendar date written as year, month and day with dashes.
const ISO_DATE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g

// Programs other than gremion-cd whose flags the document names, and where each one is defined.
const OTHER_PROGRAMS = [
  { word: 'gremion-migration-dump', files: ['infra/host/bin/gremion-migration-dump'] },
  { word: 'gremion-tenant', files: ['infra/host/bin/gremion-tenant'] },
  { word: 'gremion-verify', files: ['infra/host/bin/gremion-verify'] },
  { word: 'gremion-deploy', files: ['infra/host/bin/gremion-deploy'] },
  { word: 'gremion-rollback', files: ['infra/host/bin/gremion-rollback'] },
]
const FLAG = /--[a-z][a-z0-9-]*/g

// The flags one verb of gremion-cd takes: the case labels of the option loop inside the verb's own
// function (`--reason)`, `--json)`, `--a | --b)`). A verb whose function has no such loop passes its
// arguments on; for it the flags that appear in its body count. Reading one verb and not the whole
// program matters: a flag that exists for another verb must not pass for this one.
function flagsOfVerb(verb) {
  const name = `cd_cmd_${verb.replaceAll('-', '_')}`
  for (const f of libFiles()) {
    const lines = read(f).split('\n')
    const start = lines.findIndex((l) => l.startsWith(`${name}() {`))
    if (start < 0) continue
    const end = lines.findIndex((l, i) => i > start && l === '}')
    assert.ok(end > start, `${f}: the function ${name} does not close`)
    const body = lines.slice(start, end + 1)
    const labelled = body.flatMap((l) => {
      const m = /^\s*((?:--[a-z][a-z0-9-]*(?:=\*)?\s*\|\s*)*--[a-z][a-z0-9-]*(?:=\*)?)\)/.exec(l)
      return m ? (m[1].match(FLAG) ?? []) : []
    })
    return new Set(labelled.length > 0 ? labelled : (body.join('\n').match(FLAG) ?? []))
  }
  return assert.fail(`no library defines ${name}`)
}

// The verb a flag of a code span belongs to: the nearest `gremion-cd <verb>` before it, or the
// verb a span starts with when the span is written without the program name.
function verbForFlag(span, flag, verbs) {
  const before = span.slice(0, span.indexOf(flag))
  const named = [...before.matchAll(/gremion-cd ([a-z][a-z0-9-]*)/g)].at(-1)
  if (named) return named[1]
  const first = span.split(' ')[0]
  return verbs.has(first) ? first : null
}

// ---- the tests ----------------------------------------------------------------------------

test('the scanners fire on a bad sample and pass a good one (canary)', () => {
  const at = '@'
  const foreign = ['ops', 'real-org.de'].join(at)
  assert.deepEqual(foreignAddresses(`mail ${foreign} now`), [foreign])
  assert.deepEqual(foreignAddresses(['ops', 'example.org'].join(at)), [])
  assert.deepEqual(foreignAddresses(['gremion-cd-apply', '0123456789ab.service'].join(at)), [])
  assert.equal('seen on 2031-04-09'.match(ISO_DATE)?.length, 1)
  assert.equal('version 1.2.3 and 12:30'.match(ISO_DATE), null)
  const rows = tableRows('| H1 | H2 |\n|---|---|\n| `a` | one |\n| `b` | two |\n\ntext')
  assert.deepEqual(rows.map((r) => bare(r[0])), ['a', 'b'])
  assert.deepEqual(onlyIn(['x', 'y'], ['y']), ['x'])
  assert.deepEqual(codeSpans('see `gremion-cd status --json` and `x`'), ['gremion-cd status --json', 'x'])
  // the per-verb flag reader reaches the option loops: hold takes --reason and nothing of release-now
  assert.deepEqual([...flagsOfVerb('hold')], ['--reason'])
  assert.ok(flagsOfVerb('release-now').has('--with-state') && !flagsOfVerb('hold').has('--with-state'))
  assert.equal(verbForFlag('gremion-cd adopt --re-adopt, then gremion-cd hold --reason', '--reason', new Set(['adopt', 'hold'])), 'hold')
  assert.equal(verbForFlag('release-now <sha12> --with-state', '--with-state', new Set(['release-now'])), 'release-now')
})

test('the document exists and is long enough to be the operator document', () => {
  const text = docText()
  assert.ok(text.length > 20000, `the document is only ${text.length} characters`)
  for (const title of [
    'What stage 1 does',
    'How a release moves',
    'Commands',
    'Configuration',
    'Holds',
    'Kill switch',
    'Locks',
    'Rollback',
    'Dump set',
    'Module step',
    'Leaf step',
    'Reconcile',
    'Mail and dead-man',
    'Adoption',
    'Applying host programs',
    'Hand procedures',
    'Proof',
    'Accepted gaps',
    'Release cadence amendment',
  ]) {
    section(text, title)
  }
})

test('every verb of the program is in the verb table and every verb of the table exists', () => {
  const rows = tableRows(section(docText(), 'Commands'))
  const documented = rows.map((r) => bare(r[0]))
  assert.ok(documented.length >= 14, `only ${documented.length} verbs in the verb table`)
  const program = [...verbsOfProgram()]
  assert.deepEqual(onlyIn(program, documented), [], 'a verb of the program is missing from the verb table')
  assert.deepEqual(onlyIn(documented, program), [], 'the verb table names a verb the program does not have')
})

test('every gremion-cd command in the document names a verb the program has', () => {
  const verbs = verbsOfProgram()
  const seen = new Set()
  for (const span of codeSpans(docText())) {
    const m = /^gremion-cd ([a-z][a-z0-9-]*)/.exec(span)
    if (!m) continue
    seen.add(m[1])
    assert.ok(verbs.has(m[1]), `the document runs "gremion-cd ${m[1]}", which is not a verb of the program`)
  }
  assert.ok(seen.size >= 12, `only ${seen.size} different verbs are shown in commands`)
})

test('every flag the document shows is a flag of the verb or program that takes it', () => {
  const verbs = verbsOfProgram()
  const others = OTHER_PROGRAMS.map((p) => ({ ...p, flags: new Set(p.files.map(read).join(' ').match(FLAG)) }))
  const extra = {
    '--migrate-only': ['modules/calendar/src/index.ts', 'modules/content/src/index.ts', 'modules/publishing/src/index.ts'],
    '--all': ['gremion-ui/scripts/tenant-provision-modules.ts', 'gremion-ui/scripts/tenant-provision.ts'],
  }
  // flags of tools that are not this repository's: allowed only in a command span that names the tool
  const thirdParty = [
    { word: 'systemctl', flags: ['--now', '--wait', '--no-block'] },
    { word: 'docker compose', flags: ['--env-file', '--rm', '--no-deps'] },
  ]
  let checked = 0
  for (const span of codeSpans(docText())) {
    const flags = span.match(FLAG) ?? []
    for (const flag of flags) {
      checked += 1
      const tool = thirdParty.find((t) => span.includes(t.word) && t.flags.includes(flag))
      if (tool) continue
      const other = others.find((p) => span.includes(p.word))
      const verb = verbForFlag(span, flag, verbs)
      if (verb) {
        assert.ok(verbs.has(verb), `"${span}": ${verb} is not a verb of gremion-cd`)
        assert.ok(flagsOfVerb(verb).has(flag), `"${span}": ${flag} is not a flag of the verb ${verb}`)
      } else if (other) {
        assert.ok(other.flags.has(flag), `"${span}": ${flag} is not a flag of ${other.word}`)
      } else if (span.startsWith('--')) {
        // a span that starts with a flag, in prose or in a table cell: it must exist in the program or in one of the known programs
        const known = [...verbs].some((v) => flagsOfVerb(v).has(flag)) || others.some((p) => p.flags.has(flag)) || (extra[flag] ?? []).some((f) => read(f).includes(flag))
        assert.ok(known, `the flag ${flag} is a flag of no program this file knows`)
      } else if (extra[flag]) {
        assert.ok(extra[flag].some((f) => read(f).includes(flag)), `"${span}": ${flag} is in none of ${extra[flag].join(', ')}`)
      } else {
        assert.fail(`"${span}": ${flag} is a flag no check of this file knows (add the program it belongs to)`)
      }
    }
  }
  assert.ok(checked >= 20, `only ${checked} flags were checked`)
})

test('the operator-value table and the tunable table together name exactly the config keys of the parser', () => {
  const config = section(docText(), 'Configuration')
  const operator = firstCells(subsection(config, 'Operator values'))
  const tunables = firstCells(subsection(config, 'Tunable keys'))
  const kinds = keysOfKinds()
  const defaults = defaultsOfProgram()
  assert.ok(operator.length >= 8, `only ${operator.length} operator keys documented`)
  assert.ok(tunables.length >= 35, `only ${tunables.length} tunable keys documented`)
  assert.deepEqual(sorted(operator), sorted(kinds.filter((k) => !defaults.has(k))), 'the operator-value table differs from the keys that have no default')
  assert.deepEqual(sorted(tunables), sorted([...defaults.keys()]), 'the tunable table differs from the keys that have a default')
  assert.deepEqual(onlyIn(kinds, [...operator, ...tunables]), [], 'a key of the parser is not documented')
})

test('every key of the shipped template is documented and every documented default is the real one', () => {
  const config = section(docText(), 'Configuration')
  const template = templateValues()
  const defaults = defaultsOfProgram()
  const documented = new Map(tableRows(subsection(config, 'Tunable keys')).map((r) => [bare(r[0]), bare(r[1])]))
  const operator = firstCells(subsection(config, 'Operator values'))
  assert.deepEqual(onlyIn([...template.keys()], [...documented.keys(), ...operator]), [], 'the template carries a key the document does not')
  assert.deepEqual(onlyIn([...documented.keys(), ...operator], [...template.keys()]), [], 'the document names a key the template does not carry')
  for (const [key, value] of defaults) {
    assert.equal(template.get(key), value, `${key}: the template value differs from the default of the parser`)
    assert.equal(documented.get(key), value, `${key}: the documented default differs from the default of the parser`)
  }
})

test('every CD_ name in the document is a config key (an internal knob is never presented as a key)', () => {
  const kinds = new Set(keysOfKinds())
  const names = new Set(docText().match(/\bCD_[A-Z0-9_]+\b/g))
  assert.ok(names.size >= 45, `only ${names.size} CD_ names found`)
  const bad = sorted([...names].filter((n) => !kinds.has(n)))
  assert.deepEqual(bad, [], 'the document names a CD_ variable the parser would refuse as an unknown key')
})

test('the hold table names exactly the hold kinds of the state schema', () => {
  const documented = firstCells(subsection(section(docText(), 'Holds'), 'Hold kinds'))
  const schema = schemaList('check("hold.kind"')
  assert.deepEqual(onlyIn(schema, documented), [], 'a hold kind of the schema is missing from the table')
  assert.deepEqual(onlyIn(documented, schema), [], 'the table names a hold kind the schema does not have')
  const notify = read('infra/host/lib/cd/notify.sh').match(/^CD_NOTIFY_HOLDS="([^"]*)"/m)
  assert.ok(notify, 'notify.sh has no CD_NOTIFY_HOLDS')
  assert.deepEqual(onlyIn(notify[1].split(' ').filter((w) => w !== 'none'), schema), [], 'the mail vocabulary has a hold the schema lacks')
})

test('the block rules and the rollback rules are exactly those of the program', () => {
  const holds = section(docText(), 'Holds')
  const blocks = firstCells(subsection(holds, 'Block rules'))
  const noBlock = firstCells(subsection(holds, 'Rollback rules that write no block'))
  const schemaRules = (/\(\.rule \| IN\(([^)]*)\)\)/.exec(read(CORE)) ?? [])[1]
  assert.ok(schemaRules, 'core.sh has no block rule list')
  const schema = [...schemaRules.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1])
  const rollback = ((/_CD_RB_RULES="([^"]*)"/.exec(read('infra/host/lib/cd/rollback.sh')) ?? [])[1] ?? '').trim().split(/\s+/)
  assert.ok(schema.length >= 10 && rollback.length >= 12, 'the rule lists did not parse')
  assert.deepEqual(sorted(blocks), sorted(schema), 'the block rule table differs from the blocked.json schema')
  assert.deepEqual(sorted([...blocks, ...noBlock]), sorted(rollback), 'block rules and no-block rules together differ from the rules a rollback accepts')
})

test('the stage table and the phase table are exactly those of the state schema', () => {
  const how = section(docText(), 'How a release moves')
  const stages = firstCells(subsection(how, 'Stages'))
  const phases = firstCells(subsection(how, 'Phases'))
  assert.deepEqual(stages, schemaList('check("release.stage"'), 'the stage table differs from the schema (the order is the order of the pipeline)')
  assert.deepEqual(sorted(phases), sorted(schemaList('check("phase"')), 'the phase table differs from the schema')
})

test('the mail table names exactly the mail kinds of the notifier', () => {
  const documented = firstCells(subsection(section(docText(), 'Mail and dead-man'), 'Mail kinds'))
  const kinds = [...shellBlock('infra/host/lib/cd/notify.sh', 'declare -gA CD_NOTIFY_KIND_FIELDS=(').matchAll(/^\s*\[([a-z_]+)\]=/gm)].map((m) => m[1])
  assert.ok(kinds.length >= 14, `only ${kinds.length} mail kinds in the notifier`)
  assert.deepEqual(onlyIn(kinds, documented), [], 'a mail kind of the notifier is missing from the table')
  assert.deepEqual(onlyIn(documented, kinds), [], 'the table names a mail kind the notifier does not have')
})

test('the numbers the document states are the numbers in the code', () => {
  const text = docText()
  const defaults = defaultsOfProgram()
  // the lock span: the default, and the floor that the selftest and the dump precheck enforce
  const data = read('infra/host/lib/cd/data.sh')
  const num = (name) => Number((new RegExp(`^${name}=(\\d+)`, 'm').exec(data) ?? [])[1])
  const secs = Number(defaults.get('CD_MODULE_UPGRADE_TIMEOUT_S')) +
    num('_CD_DATA_LEAF_SERVICES') * Number(defaults.get('CD_LEAF_MIGRATE_TIMEOUT_S')) +
    num('_CD_DATA_ONESHOTS') * num('_CD_DATA_ONESHOT_TIMEOUT_S') +
    (1 + num('_CD_DATA_LEAF_SERVICES') + num('_CD_DATA_ONESHOTS')) * num('_CD_DATA_KILL_CONFIRM_S')
  const floor = Math.ceil(secs / 60) + Number(defaults.get('CD_WATCH_MINUTES')) + Number(defaults.get('CD_PAUSE_MAX_MIN')) +
    Number(defaults.get('CD_COMMIT_MAX_MIN')) + num('_CD_DATA_ALLOWANCE_MIN')
  assert.ok(floor > 100 && floor < Number(defaults.get('CD_LOCK_SPAN_MAX_MIN')), `the floor ${floor} is not below the default span`)
  assert.ok(text.includes(`floor of ${floor} minutes`), `the document does not state "floor of ${floor} minutes" for the lock span`)
  // the leaf entry: how long one customer waits for the advisory lock, and the margin of the statement timeout
  const leafPhrases = new Set()
  for (const leaf of ['calendar', 'content', 'publishing']) {
    const src = read(`modules/${leaf}/src/migrate-only.ts`)
    const lock = (/DEFAULT_LOCK_TIMEOUT_MS = ([\d_]+)/.exec(src) ?? [])[1]
    const margin = (/STATEMENT_TIMEOUT_MARGIN_MS = ([\d_]+)/.exec(src) ?? [])[1]
    assert.equal(lock, '60_000', `${leaf}: the lock wait is no longer 60 seconds`)
    assert.equal(margin, '5_000', `${leaf}: the statement margin is no longer 5 seconds`)
    leafPhrases.add(`a lock timeout of ${Number(lock.replaceAll('_', '')) / 1000} seconds and a statement timeout ${Number(margin.replaceAll('_', '')) / 1000} seconds larger`)
  }
  // the whole sentence, not two numbers: 'every 15 seconds' elsewhere must not satisfy this
  assert.equal(leafPhrases.size, 1, 'the three leaves no longer share one lock wait and margin')
  assert.ok(flat(section(text, 'Leaf step')).includes([...leafPhrases][0]), 'the leaf step does not state its lock timeout and the statement margin')

  // the access-record sentence that the reconcile verb writes
  const reason = (/CD_RECONCILE_REASON_FMT='([^']*)'/.exec(read('infra/host/lib/cd/reconcile.sh')) ?? [])[1]
  assert.ok(reason, 'reconcile.sh has no reason format')
  assert.ok(text.includes(reason.replace('%s', '<tag>')), 'the document does not quote the access-record sentence of the reconcile stage')
  // the mail caps and the hourly reminders
  const notify = read('infra/host/lib/cd/notify.sh')
  const hourly = (/CD_NOTIFY_HOURLY_CAP=(\d+)/.exec(notify) ?? [])[1]
  const daily = (/CD_NOTIFY_DAILY_CAP=(\d+)/.exec(notify) ?? [])[1]
  assert.ok(text.includes(`${hourly} mails an hour`) && text.includes(`${daily} a day`), 'the document does not state the mail caps of the notifier')
  assert.ok(/every=3600/.test(read('infra/host/lib/cd/driver.sh')) && /every=3600/.test(read('infra/host/lib/cd/commit.sh')), 'the kill-switch reminders are no longer hourly')
  assert.ok(/every=604800/.test(read('infra/host/lib/cd/watchdog.sh')), 'the watchdog reminder is no longer weekly')
  const killswitch = flat(section(text, 'Kill switch'))
  assert.ok(killswitch.includes('it repeats every hour for as long as the release stays parked'), 'the kill switch section does not state the hourly reminder of a parked release')
  assert.ok(killswitch.includes('The watchdog reminds once a week while the file exists'), 'the kill switch section does not state the weekly reminder')
  const mailRow = tableRows(subsection(section(text, 'Mail and dead-man'), 'Mail kinds')).find((r) => bare(r[0]) === 'killswitch')
  assert.ok(mailRow && flat(mailRow.join(' ')).includes('once when idle, every hour while a release is parked, and weekly from the watchdog'), 'the mail table does not state when the killswitch mail repeats')
  // what the kill switch silences: the digest and the poll and red alarms, not the mails as such
  const driver = read('infra/host/lib/cd/driver.sh')
  assert.match(driver, /if cd_killswitch_active; then\s*\n\s*_cd_drv_mail killswitch phase=idle/, 'an idle tick no longer queues the killswitch mail')
  assert.match(driver, /if ! cd_killswitch_active; then\s*\n\s*cd_notify_digest/, 'the digest is no longer the thing the kill switch turns off')
  const hand = flat(section(text, 'Hand procedures'))
  assert.ok(!hand.includes('silences the mails'), 'the hand procedure says the kill switch silences the mails')
  assert.ok(hand.includes('it is not quiet') && hand.includes('the daily digest'), 'the hand procedure does not say what the kill switch really turns off')
})

test('the rows and procedures that describe a path through the program say what the program does', () => {
  const text = docText()
  const holds = subsection(section(text, 'Holds'), 'Hold kinds')
  const rules = subsection(section(text, 'Holds'), 'Rollback rules that write no block')
  const row = (table, name) => flat((tableRows(table).find((r) => bare(r[0]) === name) ?? []).join(' '))
  const driver = read('infra/host/lib/cd/driver.sh')
  // every caller of the rollback under the rule commit_stuck is a path the row must name: a new caller
  // fails this count and sends its author to the document
  assert.equal((driver.match(/_cd_drv_rollback_auto commit_stuck/g) ?? []).length, 7, 'the driver has another caller of the commit_stuck rollback: say it in the row of the rule')
  const stuck = row(rules, 'commit_stuck')
  const causes = [
    ['steps 1 to 5 of the commit point did not finish within `CD_COMMIT_MAX_MIN`', /cd_commit_promote[^]*?rc=\$\?/],
    ['the watch loop itself failed', /cd_stage_fail watch host watch_loop[^]*?_cd_drv_rollback_auto commit_stuck watch/],
    ['the commit stage failed before step 5 or ended without a commit point', /_cd_drv_rollback_auto commit_stuck commit/],
    ['a stage reached its third attempt after the switch began', /elif \[\[ "\$R_SWITCH" == true \]\]; then\s*\n\s*_cd_drv_rollback_auto commit_stuck "\$stage"/],
    ['a restart found the switch, commit or reconcile stage unfinished before the commit point', /resume_crash stage="\$R_STAGE"[^]*?_cd_drv_rollback_auto commit_stuck "\$R_STAGE"/],
    ['a pre-switch end was asked for after the switch began', /a pre-switch end was asked for after switch_started; rolling back instead/],
  ]
  for (const [phrase, code] of causes) {
    assert.ok(stuck.includes(phrase), `the commit_stuck row does not say: ${phrase}`)
    assert.match(driver, code, `the driver no longer has the path that the commit_stuck row describes: ${phrase}`)
  }
  const stage = row(holds, 'stuck_stage')
  assert.ok(stage.includes('after the switch began and before the commit point it is a `commit_stuck` rollback instead') && stage.includes('after the commit point the release stays committed and only the hold is set'), 'the stuck_stage row does not say what a stuck stage becomes after the switch')
  assert.match(driver, /elif \[\[ "\$R_SWITCH" == true \]\]; then\s*\n\s*_cd_drv_rollback_auto commit_stuck "\$stage"\s*\n\s*else\s*\n\s*_cd_drv_abort stuck/, 'the stuck-stage branches changed: the stuck_stage row describes them')
  // the platform migration hand procedure: the hand dump is retired BEFORE resume, because resume refuses a live dump set
  const platform = flat(subsection(section(text, 'Hand procedures'), 'A release that carries a platform migration'))
  const retire = platform.indexOf('gremion-migration-dump switched --release pilot-<sha12>')
  const resume = platform.indexOf('gremion-cd resume')
  assert.ok(retire > 0 && resume > 0 && retire < resume, 'the platform migration procedure must retire the hand dump before it runs gremion-cd resume')
  assert.ok(platform.includes('resume refuses while that dump is live'), 'the platform migration procedure does not say why the dump is retired first')
  assert.match(read('infra/host/lib/cd/cmd-state.sh'), /resume refused: a dump set is live after a failed release[^]*?--discard-dump/, 'resume no longer refuses a live dump set')
  // the host upgrade procedure of the runbook does not fit the release trees CD adopts: say why, in both places
  const why = 'the runbook upgrade (`gremion-deploy`) takes a `dist-v` tag and makes `releases/<tag>`, while adopt reads a `pilot-<sha12>` tag and `releases/<sha12>`'
  assert.ok(flat(section(text, 'Adoption')).includes(why), 'the adoption steps do not say why the runbook upgrade does not fit')
  assert.ok(platform.includes('for the same reason as in adoption step 2'), 'the platform migration procedure does not point at the adoption step for the upgrade procedure')
  assert.match(read('infra/host/bin/gremion-deploy'), /\^dist-v\[0-9\]\+/, 'gremion-deploy no longer takes only dist-v tags')
  assert.match(read('infra/host/lib/cd/adopt.sh'), /\^pilot-\[0-9a-f\]\{12\}\$/, 'adopt no longer reads only pilot-<sha12> tags')
  // the order of the board series is the plan's, and the document says so
  const board = flat(subsection(section(text, 'Hand procedures'), 'The board declaration release'))
  for (const phrase of ['The order of the series', 'merges last', 'ships earlier as ordinary releases', 'no code in this repository checks that order', 'chain_class_changed']) {
    assert.ok(board.includes(phrase), `the board section does not say: ${phrase}`)
  }
  // the README row for the template says which values are placeholders and which ship empty
  const tmpl = read(TEMPLATE)
  const placeholders = [...tmpl.matchAll(/^(CD_[A-Z0-9_]+)=CHANGE_ME_OPERATOR_/gm)].map((m) => m[1])
  const empties = [...tmpl.matchAll(/^(CD_[A-Z0-9_]+)=$/gm)].map((m) => m[1])
  assert.ok(placeholders.length >= 4 && empties.length >= 3, 'the template changed shape: the README row must follow')
  const readmeRow = read('infra/host/README.md').split('\n').find((l) => l.includes('templates/env/cd.env.tmpl')) ?? ''
  assert.ok(!/every operator value/.test(readmeRow), 'the README row says every operator value is a placeholder: some ship empty')
  for (const key of [...placeholders, ...empties]) assert.ok(readmeRow.includes(key), `the README row of the template does not name ${key}`)
})

test('the document names no address, no date, and keeps the two placeholders of the adoption steps', () => {
  const text = docText()
  assert.deepEqual(foreignAddresses(text), [], 'an address outside example.org, example.com, .invalid and .test is in the document')
  assert.deepEqual(text.match(ISO_DATE) ?? [], [], 'a calendar date is in the document (write <agreement date>)')
  const adoption = section(text, 'Adoption')
  assert.ok(adoption.includes('<operator address>'), 'the adoption steps lack the placeholder <operator address>')
  assert.ok(adoption.includes('<agreement date>'), 'the adoption steps lack the placeholder <agreement date>')
  assert.ok(!/https?:\/\/(?!example\.(org|com)\b)/i.test(text), 'a URL of a real host is in the document')
})

test('every source path the document cites exists and defines its function, and the prose claims about code still hold', () => {
  const text = docText()
  const cited = [...new Set([...text.matchAll(/`((?:modules|packages|gremion-ui|scripts|infra|docs|test)\/[A-Za-z0-9_./@-]+\.[a-z]+)`/g)].map((m) => m[1]))]
  assert.ok(cited.length >= 12, `only ${cited.length} source paths are cited`)
  for (const rel of cited) assert.ok(existsSync(path.join(ROOT, rel)), `the document cites ${rel}, which does not exist`)
  // The Q-and-A about duplicate dispatch cites functions with line numbers; the line numbers may drift,
  // the function and the file may not.
  const functions = [
    ['claimNewsletterForSending', 'modules/publishing/src/store/newsletters.ts'],
    ['claimRecipient', 'modules/publishing/src/store/deliveries.ts'],
    ['claimPostForPublish', 'modules/content/src/store/posts.ts'],
    ['listDueScheduledChannels', 'modules/content/src/store/posts.ts'],
    ['dispatchDueChannels', 'modules/content/src/scheduler.ts'],
    ['claimDelivery', 'modules/content/src/store/deliveries.ts'],
    ['drainPublishOps', 'modules/content/src/store/publish-ops.ts'],
    ['listPendingCaldavSync', 'modules/calendar/src/store/caldav-queue.ts'],
    ['recordCaldavSyncFailure', 'modules/calendar/src/store/caldav-queue.ts'],
  ]
  for (const [name, rel] of functions) {
    assert.match(text, new RegExp(`\\b${name}\\b`), `the document no longer names ${name} (a longer name does not count)`)
    assert.ok(text.includes(rel), `the document no longer cites ${rel}`)
    assert.match(read(rel), new RegExp(`function ${name}\\b`), `${rel} does not define ${name}`)
  }
  // What the document says about the code it cannot cite by a table: each claim is pinned to the
  // code it was read from, so a change of that code fails here instead of leaving a stale sentence.
  const leaf = flat(section(text, 'Leaf step'))
  const publish = read('modules/content/src/publish-channel.ts')
  assert.match(publish, /if \(delivered === 0\) \{\s*await flagChannelFailed\(sql, postId\)/, 'the all-failed branch of publishChannel changed: the leaf step describes it')
  assert.match(publish, /detail: 'all sends failed'/, 'the result text of the all-failed branch changed')
  assert.match(publish, /event: 'channel\.email\.sent'/, 'the success branch no longer finishes with channel.email.sent')
  assert.match(publish, /if \(outcome\.finish\) \{[^]*?enqueueOutbox\(txSql, finish\.event/, 'the caller no longer co-commits the finish event')
  for (const phrase of [
    'flagChannelFailed` writes the channel status `failed`',
    'queues a second `channel.email.sent` event',
    'a consumer of that event can see it twice for one post',
    'The pass that loses the newsletter claim returns at once, with no status written and no event queued',
  ]) {
    assert.ok(leaf.includes(phrase), `the leaf step does not say: ${phrase}`)
  }
  assert.match(read('modules/publishing/src/dispatch.ts'), /if \(!claimed\) \{\s*console\.info\([^]*?\bspan\.end\(\)\s*return\s*\}/, 'the lost newsletter claim no longer returns without a write')
  const platform = flat(subsection(section(text, 'Hand procedures'), 'A release that carries a platform migration'))
  assert.ok(platform.includes('Between steps 3 and 4 the new release serves traffic on a platform schema that does not yet carry its migration'), 'the platform migration procedure does not warn about the interval between steps 3 and 4')
  assert.match(read('infra/host/lib/cd/adopt.sh'), /the platform step runs from the image of the active colour/, 'the adopt guard no longer refuses a platform migration for the active-colour reason')
  const board = flat(subsection(section(text, 'Hand procedures'), 'The board declaration release'))
  assert.ok(board.includes('names no procedure and no runbook for moving existing boards') && board.includes('depends on the board plan'), 'the board section does not name the missing move procedure as a gap')
  assert.match(read('modules/board/README.md'), /nothing in this release writes it/, 'the board README no longer says the move step is reserved: the gap in the document may be closed')
  assert.ok(!/\bboard\b/i.test(read('gremion-ui/scripts/tenant-provision.ts')), 'tenant-provision.ts has a board verb now: replace the gap in the document by the procedure')
})

test('the pointers lead to the document and the old "in progress" row is gone', () => {
  const tooling = read('docs/ops/host-tooling.md')
  const row = tooling.split('\n').find((l) => l.startsWith('| `gremion-cd'))
  assert.ok(row, 'host-tooling.md has no gremion-cd row')
  assert.ok(row.includes('continuous-deployment.md'), 'the gremion-cd row of host-tooling.md does not point at the document')
  assert.ok(!/in progress|Installed so far|Nothing schedules/.test(row), 'the gremion-cd row of host-tooling.md still describes stage 1 as unfinished')
  for (const verb of verbsOfProgram()) {
    assert.ok(row.includes(verb), `the gremion-cd row of host-tooling.md does not list the verb ${verb}`)
  }
  assert.ok(read('infra/host/README.md').includes('docs/ops/continuous-deployment.md'), 'infra/host/README.md does not point at the document')
  assert.ok(read('docs/INDEX.md').includes('ops/continuous-deployment.md'), 'docs/INDEX.md does not link the document')
  assert.ok(read('infra/host/bootstrap.sh').includes('docs/ops/continuous-deployment.md'), 'the cd stage of bootstrap.sh names the document and the document must exist')
})

test('this file is collected by unit:node (a count assertion over the same glob the suite uses)', () => {
  const self = 'scripts/cd/cd-docs-drift.test.mjs'
  const collected = globSync('scripts/**/*.test.mjs', { cwd: ROOT })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => !f.split('/').includes('__fixtures__'))
  assert.ok(collected.includes(self), 'unit:node would not run this file')
  assert.ok(collected.includes('scripts/cd/cd-guards.test.mjs'), 'the sibling guard file is no longer collected')
  assert.ok(collected.length >= 20, `only ${collected.length} node test files collected: the glob emptied`)
  const declared = (readFileSync(path.join(ROOT, self), 'utf8').match(/^[ \t]*test(?:\.(?:skip|only|todo))?\(/gm) ?? []).length
  assert.equal(declared, 18, `this file declares ${declared} tests, not the 18 that the count in this assertion knows`)
})
