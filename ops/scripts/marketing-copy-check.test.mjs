// Tests for marketing-copy-check.mjs (TASK-005). Each case builds a scratch
// tree holding the REAL records (licence register, elections scope) plus the
// required scope entries, plants copy, and runs the script as CI does -- as a
// child process, asserting its exit status and output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SCRIPT = join(HERE, 'marketing-copy-check.mjs')
const REGISTER = 'docs/compliance/licence-register.md'
const ELECTIONS = 'docs/compliance/elections-scope.md'

function tree(files = {}) {
  const root = mkdtempSync(join(process.env.MARKETING_CHECK_TEST_TMP || tmpdir(), 'mcc-'))
  mkdirSync(join(root, 'docs/compliance'), { recursive: true })
  cpSync(join(REPO, REGISTER), join(root, REGISTER))
  cpSync(join(REPO, ELECTIONS), join(root, ELECTIONS))
  const base = {
    'README.md': '# Gremion\n\nA platform for councils.\n',
    'docs/about-gremion.md': 'About.\n',
    'gremion-public/src/routes/+page.svelte': '<h1>Protokolle</h1>\n',
    'gremion-ui/src/lib/i18n/en.ts': "export default { 'login.keycloak': 'Sign in with Keycloak' }\n",
    'gremion-ui/src/lib/i18n/de.ts': "export default { 'login.keycloak': 'Mit Keycloak anmelden' }\n",
    ...files,
  }
  for (const [p, body] of Object.entries(base)) {
    if (body === null) continue
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
  return root
}

function run(root) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
  rmSync(root, { recursive: true, force: true })
  return { status: r.status, out: r.stdout + r.stderr }
}

test('clean copy passes and reports what it scanned', () => {
  const r = run(tree())
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /OK 5 file\(s\) scanned against 8 register rows/)
})

test('a divergent licence string for a register system fails (README)', () => {
  const r = run(tree({ 'README.md': 'Keycloak is licensed under the MIT License.\n' }))
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /README\.md:1: states "MIT License" for Keycloak/)
})

test('"or later" added to an -only licence fails (Vaultwarden)', () => {
  const r = run(tree({ 'docs/about-gremion.md': 'Vaultwarden (GNU AGPL v3 or later) stores passwords.\n' }))
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /for Vaultwarden/)
})

test('"only" for an or-later licence fails (Nextcloud, German copy)', () => {
  const r = run(tree({ 'gremion-ui/src/lib/i18n/de.ts': "export default { a: 'Nextcloud steht unter AGPL-3.0-only.' }\n" }))
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /states "AGPL-3\.0-only" for Nextcloud/)
})

test('Helios named as AGPL fails; register values for two systems in one sentence pass', () => {
  const bad = run(tree({ 'docs/about-gremion.md': 'Public, AGPL-3.0-only: elections (Helios), files.\n' }))
  assert.equal(bad.status, 1, bad.out)
  assert.match(bad.out, /for Helios/)
  const good = run(tree({ 'docs/about-gremion.md': 'Nextcloud (AGPL-3.0-or-later) and Keycloak (Apache License 2.0) are bundled.\n' }))
  assert.equal(good.status, 0, good.out)
})

test('a swapped licence between two systems in one sentence fails', () => {
  const r = run(tree({ 'docs/about-gremion.md': 'Nextcloud (Apache-2.0) and Keycloak (AGPL-3.0-or-later) are bundled.\n' }))
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /for Nextcloud/)
  assert.match(r.out, /for Keycloak/)
})

test('a lawful-statutory-elections claim fails (English and German)', () => {
  const en = run(tree({ 'README.md': 'Online student-body elections through Gremion are lawful in every Land and fit for statutory use.\n' }))
  assert.equal(en.status, 1, en.out)
  assert.match(en.out, /lawfulness or statutory fitness|forbidden elections phrasing/)
  const de = run(tree({ 'gremion-public/src/routes/+page.svelte': '<p>Die Online-Wahl ist rechtssicher und in allen Bundesländern zulässig.</p>\n' }))
  assert.equal(de.status, 1, de.out)
  assert.match(de.out, /in allen bundesländern zulässig/)
})

test('a forbidden phrasing read from the elections-scope table fails', () => {
  const r = run(tree({ 'docs/sales/offer.md': 'Gremion ersetzt die Hochschulwahl.\n' }))
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /docs\/sales\/offer\.md:1: uses a forbidden elections phrasing \("ersetzt die hochschulwahl"\)/)
})

test('the sanctioned honest-scope notice passes', () => {
  const r = run(tree({
    'docs/about-gremion.md': "This module does not run the university's statutory elections. It is optional and switched off by default.\n",
    'gremion-ui/src/lib/i18n/de.ts': "export default { n: 'Dieses Modul führt keine satzungsgemäßen Wahlen der Hochschule durch.' }\n",
  }))
  assert.equal(r.status, 0, r.out)
})

test('test files inside scope are not copy', () => {
  const r = run(tree({ 'gremion-public/src/lib/test/x.test.ts': "const s = 'Keycloak is MIT'\n" }))
  assert.equal(r.status, 0, r.out)
})

test('a missing required scope entry fails closed (exit 2), not "nothing found"', () => {
  const r = run(tree({ 'gremion-ui/src/lib/i18n/en.ts': null, 'gremion-ui/src/lib/i18n/de.ts': null }))
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /required scope entry gremion-ui\/src\/lib\/i18n does not exist/)
})

test('a register missing one of the seven systems fails closed (exit 2)', () => {
  const root = tree()
  const p = join(root, REGISTER)
  writeFileSync(p, readFileSync(p, 'utf8').split('\n').filter((l) => !l.startsWith('| LiveKit')).join('\n'))
  const r = run(root)
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /no register row for LiveKit/)
})

test('an elections-scope file without its forbidden table fails closed (exit 2)', () => {
  const root = tree()
  writeFileSync(join(root, ELECTIONS), '# Elections\n\nNothing here.\n')
  const r = run(root)
  assert.equal(r.status, 2, r.out)
  assert.match(r.out, /forbidden-phrasings table yielded 0/)
})

test('the real repository passes', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: REPO })
  assert.match(out, /^marketing-copy-check: OK \d+ file\(s\) scanned/)
})
