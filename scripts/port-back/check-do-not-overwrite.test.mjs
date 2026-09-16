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
