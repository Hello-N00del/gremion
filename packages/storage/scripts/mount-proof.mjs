#!/usr/bin/env node
// Live proof, run INSIDE a container against the BUILT package (dist/), by
// scripts/mount-proof.sh. Not shipped (outside `files`).
//
//   1. constructs the local backend on $STORAGE_ROOT — exits 2 with the
//      refusal message when the root is not a mount point;
//   2. TRD-067: two concurrent puts from tenants A and B to the SAME relPath,
//      then reads both back and checks the handles are distinct, tenant-
//      prefixed and independently readable (and that B cannot read A's).
import { createHash } from 'node:crypto'
import { configureStorage, getStorageFor } from '../dist/index.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const REL = 'news/drafts/concurrent.odt'
const sha = (b) => createHash('sha256').update(b).digest('hex')

configureStorage({ backend: 'local', root: process.env.STORAGE_ROOT })
let a, b
try {
  a = getStorageFor(A)
  b = getStorageFor(B)
} catch (err) {
  console.error(`REFUSED: ${err.message}`)
  process.exit(2)
}
const bytesA = new TextEncoder().encode(`draft of tenant A ${Date.now()}`)
const bytesB = new TextEncoder().encode(`draft of tenant B ${Date.now()}`)
const settled = await Promise.allSettled([a.put(REL, bytesA), b.put(REL, bytesB)])
if (settled.some((s) => s.status !== 'fulfilled')) {
  console.error('FAIL: a concurrent put rejected', settled)
  process.exit(1)
}
const [hA, hB] = settled.map((s) => s.value)
const [rA, rB] = await Promise.all([a.read(hA), b.read(hB)])
const crossRefused = await b.read(hA).then(() => false, (e) => /handle escapes tenant root/.test(e.message))
const ok =
  hA !== hB && hA === `${A}/${REL}` && hB === `${B}/${REL}` &&
  sha(rA) === sha(bytesA) && sha(rB) === sha(bytesB) && crossRefused
console.log(JSON.stringify({ mountCheck: a.mountCheck, hA, hB, shaA: sha(rA), shaB: sha(rB), crossRefused, listA: await a.list(), listB: await b.list() }))
if (!ok) {
  console.error('FAIL: concurrency post-conditions not met')
  process.exit(1)
}
console.log('OK: mounted root accepted; concurrent A/B writes resolved to distinct, readable, tenant-prefixed keys')
