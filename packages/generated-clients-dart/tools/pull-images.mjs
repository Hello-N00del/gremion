#!/usr/bin/env node
// packages/generated-clients-dart/tools/pull-images.mjs
//
// `pnpm --filter @gremion/generated-clients-dart images:pull`: pre-pulls the
// digest-pinned images, in their own step, for whichever tool is not
// available locally at the pinned version. The generate/check runs use
// `docker run --pull never`, so this is the only step that touches a
// registry. Exits non-zero if a needed pull fails or Docker is unusable.
import { spawnSync } from 'node:child_process'
import { DART_IMAGE, dockerDaemonAvailable, GENERATOR_IMAGE, localDart, localGenerator } from '../src/tools.ts'

/** @param {string} m */
const log = (m) => console.log(`[images:pull] ${m}`)
const needed = []
try {
  if (!localGenerator({ log })) needed.push(GENERATOR_IMAGE)
  if (!localDart({ log })) needed.push(DART_IMAGE)
} catch (e) {
  console.error(`[images:pull] ${/** @type {Error} */ (e).message}`)
  process.exit(1)
}
if (needed.length === 0) {
  log('generator and Dart SDK found locally at the pinned versions; nothing to pull')
  process.exit(0)
}
if (!dockerDaemonAvailable()) {
  console.error(`[images:pull] need ${needed.join(' and ')} but docker is not installed or its daemon does not answer. Failing closed.`)
  process.exit(1)
}
for (const image of needed) {
  const present = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' })
  if (present.status === 0) {
    log(`${image}: present`)
    continue
  }
  log(`pulling ${image}`)
  const r = spawnSync('docker', ['pull', image], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[images:pull] docker pull ${image} failed (exit ${r.status}). Failing closed.`)
    process.exit(1)
  }
}
