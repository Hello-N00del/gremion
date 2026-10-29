// TASK-015 TDD item 10: the upstream-image guard (TRD-253).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { EXCLUSIONS, licenceViolations, main, parseGitGrep, scopedViolations, stalwartRefs, treeViolations } from './check-upstream-image.mjs'
import { REPO_ROOT } from './lib/env.mjs'

const read = (p) => readFileSync(path.join(REPO_ROOT, p), 'utf8')
const mailTmpl = read('infra/host/templates/env/mail.env.tmpl')
const compose = read('infra/host/mail/docker-compose.yml')
const DIGEST = /STALWART_IMAGE=docker\.io\/stalwartlabs\/stalwart@(sha256:[0-9a-f]{64})/.exec(mailTmpl)[1]
const quiet = { log() {}, error() {} }

test('the real tree passes (verify mode: scoped files, licence, tree scan)', () => {
  assert.equal(main({ log: quiet }), 0)
  assert.deepEqual(scopedViolations({ mailTmpl, compose }).out, [])
})

test('host mode checks the scoped files only and still passes', () => {
  assert.equal(main({ host: true, log: quiet }), 0)
})

test('a build: in the mail compose file is RED', () => {
  const c = compose.replace('    image: ${STALWART_IMAGE:?STALWART_IMAGE required}', '    build: ./stalwart\n    image: ${STALWART_IMAGE:?STALWART_IMAGE required}')
  assert.match(scopedViolations({ mailTmpl, compose: c }).out.join('\n'), /builds an image \(build:\)/)
})

test('another repository or a tag in STALWART_IMAGE is RED', () => {
  const other = mailTmpl.replace(/^STALWART_IMAGE=.*$/m, `STALWART_IMAGE=docker.io/someone/stalwart@${DIGEST}`)
  assert.match(scopedViolations({ mailTmpl: other, compose }).out.join('\n'), /STALWART_IMAGE is docker\.io\/someone\/stalwart@/)
  const tag = mailTmpl.replace(/^STALWART_IMAGE=.*$/m, 'STALWART_IMAGE=docker.io/stalwartlabs/stalwart:v0.15.5-alpine')
  assert.match(scopedViolations({ mailTmpl: tag, compose }).out.join('\n'), /by digest/)
})

test('a node image by tag is RED', () => {
  const t = mailTmpl.replace(/^VENDOR_MAIL_NODE_IMAGE=.*$/m, 'VENDOR_MAIL_NODE_IMAGE=docker.io/library/node:26-alpine')
  assert.match(scopedViolations({ mailTmpl: t, compose }).out.join('\n'), /VENDOR_MAIL_NODE_IMAGE is docker\.io\/library\/node:26-alpine/)
})

test('a compose image other than ${STALWART_IMAGE:?...} is RED', () => {
  const c = compose.replace('image: ${STALWART_IMAGE:?STALWART_IMAGE required}', 'image: docker.io/stalwartlabs/stalwart:latest')
  assert.match(scopedViolations({ mailTmpl, compose: c }).out.join('\n'), /the only image line must be/)
})

test('an image bump without a licence re-read is RED', () => {
  const reg = read('docs/compliance/licence-register.md')
  const st = read('docs/compliance/vendor-mail-licence.md')
  assert.deepEqual(licenceViolations({ digest: DIGEST, register: reg, statement: st }), [])
  const bumped = `sha256:${'a'.repeat(64)}`
  assert.equal(licenceViolations({ digest: bumped, register: reg, statement: st }).length, 2)
  assert.match(licenceViolations({ digest: DIGEST, register: reg, statement: st.replace('`unmodified`', '`modified`') }).join('\n'), /licensed_edition `unmodified`/)
})

// A line an exclusion covers: its own line, or (whole-file) a seeded tag.
const SEEDED = "'STALWART_IMAGE=docker.io/stalwartlabs/stalwart:v0.15',"
const exLine = (e) => e.line ?? SEEDED

test('a tag reference elsewhere in the tree is RED; the named exclusions pass while present', () => {
  const hits = [
    { file: 'docker-compose.extra.yml', line: 3, text: '    image: docker.io/stalwartlabs/stalwart:v0.15.5-alpine' },
    ...EXCLUSIONS.map((e, i) => ({ file: e.file, line: i + 1, text: exLine(e) })),
  ]
  const files = Object.fromEntries(EXCLUSIONS.map((e) => [e.file, `x\n${exLine(e)}\n`]))
  assert.deepEqual(treeViolations(hits, files), ['docker-compose.extra.yml:3 references the Stalwart image as docker.io/stalwartlabs/stalwart:v0.15.5-alpine, not by digest'])
})

test('a stale exclusion (its line gone) is RED', () => {
  const files = Object.fromEntries(EXCLUSIONS.map((e) => [e.file, `x\n${exLine(e)}\n`]))
  // the first line-scoped exclusion (not a whole-file one), whichever that is today
  const e = EXCLUSIONS.find((x) => x.line !== null)
  assert.ok(e, 'no line-scoped exclusion left to prove the stale path on')
  files[e.file] = 'STALWART_IMAGE=stalwartlabs/stalwart:v0.16.22\n'
  const escaped = e.file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  assert.match(treeViolations([], files).join('\n'), new RegExp(`stale exclusion: ${escaped} no longer carries`))
})

test("TASK-048's digest-lint tests are one whole-file exclusion: any seeded ref there passes, and it is stale once the file has none (fix round 2)", () => {
  const f = 'scripts/release/check-image-digests.test.mjs'
  const e = EXCLUSIONS.find((x) => x.file === f)
  assert.ok(e && e.line === null, `${f} is not a whole-file exclusion`)
  const files = Object.fromEntries(EXCLUSIONS.map((x) => [x.file, `x\n${exLine(x)}\n`]))
  const hits = [
    { file: f, line: 156, text: SEEDED },
    { file: f, line: 311, text: "const mail = { 'x': `STALWART_IMAGE=docker.io/stalwartlabs/stalwart@sha256:${D('b')}\\n` }" },
  ]
  assert.deepEqual(treeViolations(hits, files), [])
  // ...but only in that file
  assert.equal(treeViolations([{ file: 'scripts/release/other.test.mjs', line: 1, text: SEEDED }], files).length, 1)
  files[f] = 'no image here\n'
  assert.match(treeViolations([], files).join('\n'), /stale exclusion: scripts\/release\/check-image-digests\.test\.mjs no longer references/)
})

test('git grep output parses with CRLF line ends; a line it cannot split is a named error, not a TypeError (fix round 2)', () => {
  assert.deepEqual(parseGitGrep('a/b.yml:3:  image: x\r\nc d.sh:10:Y=z:1\r\n'), [
    { file: 'a/b.yml', line: 3, text: '  image: x' },
    { file: 'c d.sh', line: 10, text: 'Y=z:1' },
  ])
  assert.throws(() => parseGitGrep('no-line-number-here\n'), /unparseable git grep line/)
})

test('links are not image references; bare and registry-qualified refs are', () => {
  assert.deepEqual(stalwartRefs('see https://github.com/stalwartlabs/stalwart/blob/x/LICENSE'), [])
  assert.deepEqual(stalwartRefs('FROM stalwartlabs/stalwart:v0.15 AS s'), ['stalwartlabs/stalwart:v0.15'])
  assert.deepEqual(stalwartRefs(`X=docker.io/stalwartlabs/stalwart@${DIGEST}`), [`docker.io/stalwartlabs/stalwart@${DIGEST}`])
})
