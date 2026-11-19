// Cross-cutting repo guards of the continuous-deployment program (gremion-cd).
//
// WHY HERE. These are facts about the SHAPE of the repository, not about one function:
// which files may name an address, which unit may run as root, what the shipped config
// template defaults to. They are read straight from the files, with no bash, so the
// node suite (unit:node, scripts/**/*.test.mjs) collects them on every platform.
//
// Every guard here was watched RED before the file it guards was written or mutated; the
// canary tests prove the scanners still fire, because a scan that reaches nothing reports clean.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATES = 'infra/host/templates'

const UNITS = [
  'gremion-cd.service',
  'gremion-cd.timer',
  'gremion-cd-watchdog.service',
  'gremion-cd-watchdog.timer',
  'gremion-cd-resume.service',
  'gremion-cd-apply@.service',
]
const TICK_SIDE_SERVICES = ['gremion-cd.service', 'gremion-cd-watchdog.service', 'gremion-cd-resume.service']
// The ONE unit that runs as root. An allow-list of one, with the reason in the failure message.
const ROOT_UNIT_ALLOW_LIST = ['gremion-cd-apply@.service']

// The explicit path list of the address guard. A glob that matches nothing (a unit that has
// not landed yet) is skipped; the count assertion below pins that the list matched files.
const ADDRESS_SCAN_GLOBS = [
  'infra/host/lib/cd/**',
  'infra/host/bin/gremion-cd',
  'infra/host/templates/env/cd.env.tmpl',
  ...UNITS.map((u) => `${TEMPLATES}/systemd/${u}`),
  'scripts/cd/**',
  'scripts/cd-proof/**',
  'test/host/cd-*.bats',
  'test/host/fixtures/cd/**',
  'docs/ops/continuous-deployment.md',
]

function filesOf(glob) {
  if (!glob.includes('*')) return existsSync(path.join(ROOT, glob)) ? [glob] : []
  return globSync(glob, { cwd: ROOT })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => statSync(path.join(ROOT, f)).isFile())
}

function scannedFiles() {
  return [...new Set(ADDRESS_SCAN_GLOBS.flatMap(filesOf))].toSorted((a, b) => a.localeCompare(b))
}

// An address: local part, '@', a dotted domain ending in letters. A domain is allowed when it
// is example.org, example.com or a name ending in .invalid or .test. One more name shape is
// not an address at all: a systemd unit INSTANCE (gremion-cd-apply@0123456789ab.service,
// unit@instance.service), which the pattern cannot tell from one.
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

// The effective lines of a unit or env template: comments and blanks dropped.
function effective(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith(';'))
}
function readUnit(name) {
  return effective(readFileSync(path.join(ROOT, TEMPLATES, 'systemd', name), 'utf8'))
}
function unitHas(lines, key) {
  return lines.some((l) => l.startsWith(`${key}=`))
}
function unitValues(lines, key) {
  return lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1))
}

test('the address guard list matches real files (a scan that reaches nothing reports clean)', () => {
  const files = scannedFiles()
  assert.ok(files.length >= 25, `the scan list matched only ${files.length} files`)
  for (const must of [
    'infra/host/bin/gremion-cd',
    'infra/host/lib/cd/core.sh',
    'infra/host/lib/cd/apply-root.sh',
    'infra/host/templates/env/cd.env.tmpl',
    ...UNITS.map((u) => `${TEMPLATES}/systemd/${u}`),
    'test/host/cd-bootstrap.bats',
    'test/host/cd-apply-root.bats',
    'scripts/cd/cd-guards.test.mjs',
  ]) {
    assert.ok(files.includes(must), `${must} is not on the scanned path list`)
  }
})

test('the address pattern fires on a foreign address and passes the allowed names (canary)', () => {
  // Built at run time: this file is itself on the scanned list and holds no address.
  const at = '@'
  const foreign = ['ops', 'real-org.de'].join(at)
  assert.deepEqual(foreignAddresses(`mail ${foreign} now`), [foreign])
  const allowed = [['ops', 'example.org'], ['a.b+c', 'example.com'], ['x', 'mail.invalid'], ['x', 'relay.host.test']]
  for (const parts of allowed) {
    const ok = parts.join(at)
    assert.deepEqual(foreignAddresses(ok), [], ok)
  }
  assert.deepEqual(foreignAddresses(['gremion-cd-apply', '0123456789ab.service'].join(at)), [], 'a unit instance is not an address')
  const trick = ['ops', 'example.org.evil.de'].join(at)
  assert.deepEqual(foreignAddresses(`mail ${trick}`), [trick], 'a suffix trick is not example.org')
})

test('no file of the continuous-deployment tree names an e-mail address outside example.org, example.com, .invalid and .test', () => {
  const offenders = []
  for (const f of scannedFiles()) {
    const text = readFileSync(path.join(ROOT, f), 'utf8')
    for (const a of foreignAddresses(text)) offenders.push(`${f}: ${a}`)
  }
  assert.deepEqual(offenders, [], 'the one operator address (CD_MAIL_TO) lives on the host only; the repository ships CHANGE_ME_OPERATOR_MAIL')
})

test('cd.env.tmpl ships proof mode 0 and only placeholders, no address and no real URL', () => {
  const lines = effective(readFileSync(path.join(ROOT, 'infra/host/templates/env/cd.env.tmpl'), 'utf8'))
  const kv = new Map()
  for (const l of lines) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l)
    assert.ok(m, `not KEY=VALUE: ${l}`)
    assert.ok(!kv.has(m[1]), `${m[1]} is set twice`)
    kv.set(m[1], m[2].replace(/^"(.*)"$/, '$1'))
  }
  assert.equal(kv.get('CD_PROOF_MODE'), '0', 'proof mode must default to 0')
  assert.equal(kv.get('CD_POLICY_ACK'), '', 'the agreement date is an operator value; the template stays empty')
  assert.equal(kv.get('CD_PING_URL'), '', 'the dead-man URL is an operator value; the template stays empty')
  assert.equal(kv.get('CD_MAIL_TO'), 'CHANGE_ME_OPERATOR_MAIL')
  assert.match(kv.get('CD_REPO_URL') ?? '', /^CHANGE_ME_OPERATOR_/)
  assert.match(kv.get('CD_PROBE_HOST') ?? '', /^CHANGE_ME_OPERATOR_/)
  assert.equal(kv.get('CD_LEAF_MIGRATE_TIMEOUT_S'), '600')
  for (const [k, v] of kv) {
    assert.ok(!/https?:\/\//i.test(v), `${k} carries a URL`)
    assert.deepEqual(foreignAddresses(v), [], `${k} carries an address`)
  }
})

test('every continuous-deployment unit template exists, and none runs as root except the apply unit', () => {
  for (const u of UNITS) assert.ok(existsSync(path.join(ROOT, TEMPLATES, 'systemd', u)), `${u} is missing`)
  for (const u of UNITS.filter((n) => n.endsWith('.service'))) {
    const lines = readUnit(u)
    const users = unitValues(lines, 'User')
    if (ROOT_UNIT_ALLOW_LIST.includes(u)) {
      assert.deepEqual(users, [], `${u} is the one root unit and names no User`)
      continue
    }
    assert.deepEqual(users, ['${DEPLOY_USER}'], `${u} must run as the deploy user: only ${ROOT_UNIT_ALLOW_LIST.join(', ')} may run as root (it installs host programs and writes /etc)`)
    assert.deepEqual(unitValues(lines, 'Group'), ['${DEPLOY_USER}'], `${u} must run in the deploy user's group`)
  }
})

test('the apply unit runs exactly one script, is never enabled and sets no sandbox that would block the install', () => {
  const lines = readUnit('gremion-cd-apply@.service')
  assert.deepEqual(unitValues(lines, 'ExecStart'), ['${GREMION_ROOT}/lib/cd/apply-root.sh %i'])
  for (const k of ['ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload', 'ExecCondition']) {
    assert.ok(!unitHas(lines, k), `the apply unit must not set ${k}`)
  }
  assert.ok(!lines.includes('[Install]') && !unitHas(lines, 'WantedBy') && !unitHas(lines, 'RequiredBy'), 'the apply unit is started by systemctl start only')
  // ProtectSystem=full would make /etc read-only even for root (render_unit writes /etc/systemd/system)
  for (const k of ['ProtectSystem', 'ProtectHome', 'ReadOnlyPaths', 'InaccessiblePaths', 'User', 'Group', 'DynamicUser']) {
    assert.ok(!unitHas(lines, k), `the apply unit must not set ${k}`)
  }
  assert.ok(lines.includes('Type=oneshot'))
})

test('the three tick-side units pin no NoNewPrivileges (the sudo -n calls need it)', () => {
  for (const u of TICK_SIDE_SERVICES) {
    const lines = readUnit(u)
    assert.ok(
      !unitHas(lines, 'NoNewPrivileges'),
      `${u} must not set NoNewPrivileges: the program restarts the executor and starts the apply unit through "sudo -n systemctl", and a unit with NoNewPrivileges makes sudo refuse (the pilot's setuid facts, F15)`,
    )
  }
})

test('the unit templates use only the three render variables and hard-code no install root', () => {
  for (const u of UNITS) {
    const text = readFileSync(path.join(ROOT, TEMPLATES, 'systemd', u), 'utf8')
    for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      assert.ok(['GREMION_ROOT', 'DEPLOY_USER', 'BACKUP_ONCALENDAR'].includes(m[1]), `${u}: \${${m[1]}} is not a variable render_unit substitutes`)
    }
    assert.ok(!text.includes('/opt/gremion'), `${u} hard-codes the install root`)
  }
})

test('this file is collected by unit:node (a count assertion over the same glob the suite uses)', () => {
  const self = 'scripts/cd/cd-guards.test.mjs'
  const collected = globSync('scripts/**/*.test.mjs', { cwd: ROOT })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => !f.split('/').includes('__fixtures__'))
  assert.ok(collected.includes(self), 'unit:node would not run this file')
  assert.ok(collected.length >= 20, `only ${collected.length} node test files collected: the glob emptied`)
  const declared = (readFileSync(path.join(ROOT, self), 'utf8').match(/^test\(/gm) ?? []).length
  assert.ok(declared >= 9, `this file declares ${declared} tests`)
})
