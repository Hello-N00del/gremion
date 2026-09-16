// Unit B3 (spec B §A.1). The do-not-overwrite set is the frozen list the
// kernel-wins direction rests on: 43 paths the kernel holds and the StuRa tree
// does not, plus 2 kernel-ahead theme files whose StuRa-tree bytes must never
// land here. Measured from `verify-manifest --json` at kernel f7ac8260 and
// StuRaOS f276af59.
//
//   node --test scripts/port-back/check-do-not-overwrite.test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { describe } from 'node:test'

const SET_FILE = path.join(import.meta.dirname, 'do-not-overwrite.json')
const set = JSON.parse(readFileSync(SET_FILE, 'utf8'))

describe('do-not-overwrite.json — shape', () => {
  test('declares its own entry count and carries exactly that many', () => {
    assert.equal(set.expectedEntries, 45)
    assert.equal(set.doNotDelete.length + set.kernelAhead.length, set.expectedEntries)
  })

  test('doNotDelete carries the 43 measured paths, sorted and unique', () => {
    assert.equal(set.doNotDelete.length, 43)
    assert.deepEqual(set.doNotDelete, [...new Set(set.doNotDelete)].sort())
  })

  test('every named kernel-ahead surface of spec B §A.1 is in the set', () => {
    const has = (p) => set.doNotDelete.includes(p)
    assert.equal(
      set.doNotDelete.filter((p) => p.startsWith('gremion-ui/src/lib/components/dashboard/')).length,
      11,
    )
    assert.ok(has('gremion-ui/src/lib/components/committee/CommitteeCard.svelte'))
    assert.ok(has('gremion-ui/src/lib/source-offer.ts'))
    assert.ok(has('gremion-ui/src/lib/source-offer.test.ts'))
    assert.ok(has('gremion-ui/src/lib/source-offer.wiring.test.ts'))
    assert.ok(has('gremion-ui/src/lib/components/layout/ThemeToggle.svelte'))
    assert.ok(has('gremion-ui/scripts/check-domain-regex.mjs'))
    assert.ok(has('docker/traefik/dynamic/tls.yml'))
    // 12, not the 13 the plan's prose says: the measured set at f7ac8260 carries
    // k8s/base/keycloak/pdb.yaml plus 5 dev and 6 production ingressroute patches.
    // The plan's own frozen JSON lists the same 12; only its prose miscounted.
    assert.equal(set.doNotDelete.filter((p) => p.startsWith('k8s/')).length, 12)
    assert.equal(
      set.doNotDelete.filter((p) => /^scripts\/(check-|kernel-hygiene)/.test(p)).length,
      5,
    )
  })

  test('kernelAhead names the theme engine and pins the forbidden StuRa blob', () => {
    assert.deepEqual(set.kernelAhead.map((e) => e.path).sort(), [
      'gremion-ui/src/lib/theme/instance-theme.test.ts',
      'gremion-ui/src/lib/theme/instance-theme.ts',
    ])
    for (const e of set.kernelAhead) assert.match(e.forbiddenProductBlob, /^[0-9a-f]{40}$/)
  })

  test('records the two SHAs it was frozen at', () => {
    assert.equal(set.frozenAt.kernel, 'f7ac82609eb4b6dedd415d2ef6d7f8d1736ae543')
    assert.equal(set.frozenAt.stura, 'f276af5925abacdcfd05f6613fc11afff2d804c5')
  })
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { after, before } from 'node:test'

import { check, indexBlobs } from './check-do-not-overwrite.mjs'

// A throwaway kernel-shaped repo, never the real tree. Comparison is by git
// index blob, so this has to be a real repo with a real commit — the same code
// path production takes, EOL normalisation included.
let FIX

function write(rel, body) {
  const abs = path.join(FIX, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

function stage() {
  execFileSync('git', ['-C', FIX, 'add', '-A'], { stdio: 'pipe' })
}

describe('check-do-not-overwrite — behaviour', () => {
  const SMALL = {
    schemaVersion: 1,
    expectedEntries: 3,
    doNotDelete: ['a/keep-one.ts', 'a/keep-two.ts'],
    kernelAhead: [{ path: 'b/ahead.ts', forbiddenProductBlob: null }],
  }

  before(() => {
    FIX = mkdtempSync(path.join(tmpdir(), 'b3-dno-'))
    const g = (...a) => execFileSync('git', ['-C', FIX, ...a], { stdio: 'pipe' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'b3@fixture.invalid')
    g('config', 'user.name', 'b3 fixture')
    g('config', 'commit.gpgsign', 'false')
    write('a/keep-one.ts', 'export const one = 1\n')
    write('a/keep-two.ts', 'export const two = 2\n')
    write('b/ahead.ts', 'export const kernelVersion = true\n')
    stage()
    g('commit', '-qm', 'fixture')
    // The blob the StuRa tree would bring for b/ahead.ts.
    SMALL.kernelAhead[0].forbiddenProductBlob = execFileSync(
      'git', ['-C', FIX, 'hash-object', '--stdin'],
      { input: 'export const staleProductVersion = true\n', encoding: 'utf8' },
    ).trim()
  })

  after(() => rmSync(FIX, { recursive: true, force: true }))

  test('a clean tree produces no failures', () => {
    assert.deepEqual(check(SMALL, indexBlobs(FIX)), [])
  })

  test('a deleted do-not-delete path is refused by name', () => {
    rmSync(path.join(FIX, 'a/keep-two.ts'))
    stage()
    const out = check(SMALL, indexBlobs(FIX))
    assert.equal(out.length, 1)
    assert.equal(
      out[0],
      'PORT-BACK REFUSED: a/keep-two.ts is in the do-not-overwrite set and is no longer tracked in the kernel',
    )
    write('a/keep-two.ts', 'export const two = 2\n')
    stage()
    assert.deepEqual(check(SMALL, indexBlobs(FIX)), [])
  })

  test('a kernel-ahead path overwritten with the StuRa-tree bytes is refused', () => {
    write('b/ahead.ts', 'export const staleProductVersion = true\n')
    stage()
    const out = check(SMALL, indexBlobs(FIX))
    assert.equal(out.length, 1)
    assert.match(out[0], /^PORT-BACK REFUSED: b\/ahead\.ts now carries the StuRa-tree blob [0-9a-f]{40}; kernel wins on this path \(spec B §2\.1\)$/)
    write('b/ahead.ts', 'export const kernelVersion = true\n')
    stage()
    assert.deepEqual(check(SMALL, indexBlobs(FIX)), [])
  })

  test('an ordinary kernel edit to a protected path is allowed', () => {
    write('a/keep-one.ts', 'export const one = 1\nexport const added = true\n')
    stage()
    assert.deepEqual(check(SMALL, indexBlobs(FIX)), [])
  })

  test('a short set is refused rather than passing vacuously', () => {
    const out = check({ ...SMALL, doNotDelete: [], kernelAhead: [] }, indexBlobs(FIX))
    assert.deepEqual(out, [
      'PORT-BACK REFUSED: the do-not-overwrite set declares 3 entries but carries 0',
    ])
  })

  test('the real set loads against the real kernel with no failures', () => {
    assert.deepEqual(check(set, indexBlobs(path.join(import.meta.dirname, '..', '..'))), [])
  })
})
