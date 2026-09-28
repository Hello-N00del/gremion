// TASK-029 TDD 10: after the pad-4 renumber no pad-3 name of a kernel-data
// legacy file survives outside the committed allow-list, and the allow-list
// carries no stale row. The slugs are read from the register, so the check
// follows it instead of a second hand-written list.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { globToRegExp, HERE, REPO_ROOT } from './register.mjs'

const register = JSON.parse(readFileSync(join(HERE, 'ranges.json'), 'utf8'))
const allow = JSON.parse(readFileSync(join(HERE, 'pad3-references.allow.json'), 'utf8')).allow.map((a) => ({ ...a, re: globToRegExp(a.glob) }))
const kernel = register.chains.find((c) => c.id === 'kernel-data')
const slugs = kernel.legacy.map((f) => f.replace(/^\d+_/, '').replace(/\.sql$/, ''))

function pad3Hits() {
  // -I: binary files (fonts, images) are not references; the working tree is
  // searched, so an uncommitted reference is seen too
  const r = spawnSync('git', ['grep', '-I', '-nE', `\\b0[0-5][0-9]_(${slugs.join('|')})`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  // git grep exits 1 on no match, which is a valid (empty) answer
  assert.ok(r.status === 0 || r.status === 1, `git grep failed: ${r.stderr}`)
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l)
      assert.ok(m, `unparseable git grep line: ${l.slice(0, 120)}`)
      return { path: m[1], line: Number(m[2]), text: m[3] }
    })
}

const COMMENT = /^\s*(\/\/|\*|\/\*|#|--)/

test('the kernel-data legacy set is the 31 renumbered names', () => {
  assert.equal(slugs.length, 31)
  assert.ok(kernel.legacy.every((f) => /^\d{4}_/.test(f)))
})

test('no pad-3 kernel-data name survives outside the allow-list; commentOnly paths hit only comment lines', () => {
  const hits = pad3Hits()
  assert.ok(hits.length > 0, 'the grep found nothing at all -- the allow-list below would be all stale; check the pattern')
  const bad = []
  for (const h of hits) {
    const a = allow.find((x) => x.re.test(h.path))
    if (!a) bad.push(`${h.path}:${h.line} is not allow-listed: ${h.text.trim().slice(0, 120)}`)
    else if (a.commentOnly && !COMMENT.test(h.text)) bad.push(`${h.path}:${h.line} is allow-listed comment-only but is code: ${h.text.trim().slice(0, 120)}`)
  }
  assert.deepEqual(bad, [])
})

test('every allow-list row still matches a hit (no stale row)', () => {
  const hits = pad3Hits()
  const stale = allow.filter((a) => !hits.some((h) => a.re.test(h.path))).map((a) => a.glob)
  assert.deepEqual(stale, [])
})

test('the allow-list refuses a planted pad-3 reference in code (RED case, in memory)', () => {
  const planted = { path: 'gremion-ui/src/lib/server/x.ts', text: "const f = '058_public_reader_grants.sql'" }
  assert.equal(allow.some((x) => x.re.test(planted.path)), false)
  const commentOnly = allow.find((x) => x.commentOnly)
  assert.ok(commentOnly)
  assert.equal(COMMENT.test("  load('003_calendar_schema.sql')"), false)
})
