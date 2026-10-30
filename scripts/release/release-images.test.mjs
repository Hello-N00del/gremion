#!/usr/bin/env node
// node --test suite: the release-images.yml build matrix agrees with what the
// rest of the repository says a release is.
//
// Three sources of truth must name the same images, and a drift between any two
// of them ships a short or a mis-built release:
//   1. emit-pins.mjs / check-pins.mjs derive the SERVICE sets a release must
//      pin (every service with `build:` in the state and app COMPOSE_FILE
//      files, derivedServices). A matrix leg missing for one of them leaves
//      emit-pins refusing at the end of a run that already pushed images.
//   2. the compose `build:` blocks say HOW each of those is built (context,
//      dockerfile, target) and what the image is called. A matrix that builds
//      a different thing from what the compose file would build pins a digest
//      nothing in the stack was ever tested against.
//   3. ci.yml's docker-build matrix says what every pull request proves
//      builds. A release leg whose Dockerfile+context no pull request ever
//      built would be the first build of that image on release day. The one
//      such leg that exists today is listed in NOT_IN_DOCKER_BUILD, and that
//      list is asserted to be exactly the legs docker-build lacks, so it
//      cannot rot into a standing excuse.
//
// Run: node --test scripts/release/release-images.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

import { derivedServices } from './check-pins.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel) => readFileSync(`${ROOT}/${rel}`, 'utf8')

// The compose files of the two release projects, in COMPOSE_FILE order (the
// pins slots excluded: they reset `build`, they never define one).
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.app.yml']

// Release legs that ci.yml's docker-build does not build on a pull request.
// vector is built nowhere else: a change to docker/vector first meets a
// compiler on release day. Remove the entry the day docker-build grows it.
const NOT_IN_DOCKER_BUILD = ['vector']

const norm = (p) => {
  const n = posix.normalize(String(p).replace(/\\/g, '/'))
  return n === './' ? '.' : n.replace(/\/$/, '')
}

/** The Dockerfile path as `docker build -f` would be given it, from a compose build block. */
function composeBuild(composeTexts, service) {
  for (const text of composeTexts) {
    const svc = parse(text, { merge: true })?.services?.[service]
    if (!svc?.build) continue
    const b = typeof svc.build === 'string' ? { context: svc.build } : svc.build
    const context = norm(b.context ?? '.')
    return {
      image: String(svc.image ?? '').replace(/:[^/@]*$/, ''),
      context,
      dockerfile: norm(posix.join(context, b.dockerfile ?? 'Dockerfile')),
      target: b.target ?? '',
    }
  }
  return undefined
}

/**
 * Every disagreement between the release matrix and the repository, as
 * strings (empty = agreement). Inputs are texts so the tests can plant a
 * violation in a copy.
 */
export function matrixProblems({ releaseYml, ciYml, composeTexts, wanted }) {
  const problems = []
  const legs = parse(releaseYml)?.jobs?.['build-and-push']?.strategy?.matrix?.include
  if (!Array.isArray(legs) || legs.length === 0) return ['release-images.yml: build-and-push has no matrix.include']

  // 1. the service sets
  const matrixServices = legs.flatMap((l) => String(l.services).split(/\s+/).filter(Boolean))
  const dup = matrixServices.filter((s, i) => matrixServices.indexOf(s) !== i)
  if (dup.length) problems.push(`a service is built by two legs: ${[...new Set(dup)].join(', ')}`)
  for (const s of wanted) if (!matrixServices.includes(s)) problems.push(`no matrix leg builds ${s}, which emit-pins derives`)
  for (const s of matrixServices) if (!wanted.includes(s)) problems.push(`matrix service ${s} is in no emit-pins project`)

  // 2. what each leg builds equals what compose builds for each of its services
  for (const leg of legs) {
    for (const service of String(leg.services).split(/\s+/).filter(Boolean)) {
      const want = composeBuild(composeTexts, service)
      if (!want) {
        problems.push(`${leg.name}: no compose file defines a build: for ${service}`)
        continue
      }
      if (leg.image !== want.image) problems.push(`${leg.name}: image ${leg.image} but compose names ${want.image} for ${service}`)
      if (norm(leg.context) !== want.context) problems.push(`${leg.name}: context ${leg.context} but compose builds ${want.context} for ${service}`)
      if (norm(leg.dockerfile) !== want.dockerfile) problems.push(`${leg.name}: dockerfile ${leg.dockerfile} but compose builds ${want.dockerfile} for ${service}`)
      if ((leg.target ?? '') !== want.target) problems.push(`${leg.name}: target '${leg.target ?? ''}' but compose builds target '${want.target}' for ${service}`)
    }
  }

  // 3. ci.yml's docker-build proves the same Dockerfile+context on a pull request
  const ci = parse(ciYml)?.jobs?.['docker-build']?.strategy?.matrix?.include
  if (!Array.isArray(ci) || ci.length === 0) return [...problems, 'ci.yml: docker-build has no matrix.include (the agreement below would be vacuous)']
  const built = new Set(ci.map((e) => `${norm(e.dockerfile)}@${norm(e.context)}`))
  const absent = legs.filter((l) => !built.has(`${norm(l.dockerfile)}@${norm(l.context)}`)).map((l) => l.name)
  for (const name of absent) if (!NOT_IN_DOCKER_BUILD.includes(name)) problems.push(`${name}: no docker-build leg builds ${legs.find((l) => l.name === name).dockerfile} on a pull request`)
  for (const name of NOT_IN_DOCKER_BUILD) if (!absent.includes(name)) problems.push(`NOT_IN_DOCKER_BUILD lists ${name}, but docker-build now builds it (or the leg is gone): drop the entry`)
  return problems
}

/**
 * Every way the release can end up built from more than one commit, or its
 * shared build cache written from an unprotected one, as strings (empty =
 * sound). `release_ref` may be a branch and a branch moves: it is resolved to a
 * sha ONCE, by resolve-ref, and every other job builds that sha.
 */
export function refProblems(releaseYml) {
  const problems = []
  const wf = parse(releaseYml)
  const jobs = wf?.jobs ?? {}
  const resolve = jobs['resolve-ref']
  if (!resolve) return ['release-images.yml: no resolve-ref job']
  const SHA = '${{ needs.resolve-ref.outputs.sha }}'
  if (resolve.outputs?.sha !== '${{ steps.resolve.outputs.sha }}') problems.push('resolve-ref does not output the resolved sha')
  if (resolve.outputs?.cache_write !== '${{ steps.resolve.outputs.cache_write }}') problems.push('resolve-ref does not output cache_write')
  const checkoutsOf = (job) => (job.steps ?? []).filter((st) => String(st.uses ?? '').startsWith('actions/checkout@'))
  if (checkoutsOf(resolve).length !== 1) problems.push('resolve-ref must check out exactly once, to read the ref')
  for (const [name, job] of Object.entries(jobs)) {
    if (name === 'resolve-ref') continue
    const needs = [job.needs ?? []].flat()
    if (!needs.includes('resolve-ref')) problems.push(`${name}: does not need resolve-ref`)
    const checkouts = checkoutsOf(job)
    if (checkouts.length === 0) problems.push(`${name}: no checkout step (the agreement below would be vacuous)`)
    for (const st of checkouts) if (st.with?.ref !== SHA) problems.push(`${name}: checks out '${st.with?.ref}', not the resolved sha`)
    // the ref input is read by resolve-ref alone
    if (JSON.stringify(job).includes('release_ref')) problems.push(`${name}: reads release_ref itself instead of the resolved sha`)
  }

  // the shared build cache: every build reads it, and only CACHE_WRITE=true exports to it
  const build = jobs['build-and-push']
  const buildStep = (build?.steps ?? []).find((st) => /docker buildx build/.test(st.run ?? ''))
  if (!buildStep) return [...problems, 'build-and-push: no docker buildx build step']
  if (buildStep.env?.CACHE_WRITE !== '${{ needs.resolve-ref.outputs.cache_write }}') problems.push('the build step does not bind CACHE_WRITE to resolve-ref.outputs.cache_write')
  const lines = buildStep.run.split('\n')
  const exports = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('--cache-to'))
  if (exports.length === 0) problems.push('the build step never exports the build cache')
  for (const [, i] of exports) {
    if (!/^\s*if \[ "\$CACHE_WRITE" = true \]; then$/.test(lines[i - 1] ?? '')) problems.push(`--cache-to is not directly under 'if [ "$CACHE_WRITE" = true ]' (line ${i + 1} of the build step)`)
  }
  if (!buildStep.run.includes('--cache-from')) problems.push('the build step does not read the build cache')
  return problems
}

const real = () => ({
  releaseYml: read('.github/workflows/release-images.yml'),
  ciYml: read('.github/workflows/ci.yml'),
  composeTexts: COMPOSE_FILES.map(read),
  wanted: [...derivedServices('app'), ...derivedServices('state')],
})

test('release-images.yml: the matrix, emit-pins, the compose build blocks and docker-build agree', () => {
  const input = real()
  assert.ok(input.wanted.length >= 11, `vacuity floor: expected the full derived service set, got ${input.wanted.join(', ')}`)
  assert.deepEqual(matrixProblems(input), [])
})

test('release-images.yml: the matrix has one leg per distinct image, and shared images share one build', () => {
  const legs = parse(real().releaseYml).jobs['build-and-push'].strategy.matrix.include
  const images = legs.map((l) => l.image)
  assert.equal(new Set(images).size, images.length, 'two legs push the same image')
  // migrate/tenant-create and kernel-api/kernel-api-migrate each share one image: one build, one digest, two pin lines
  assert.deepEqual(legs.find((l) => l.name === 'migrate').services.split(' ').sort(), ['migrate', 'tenant-create'])
  assert.deepEqual(legs.find((l) => l.name === 'kernel-api').services.split(' ').sort(), ['kernel-api', 'kernel-api-migrate'])
  for (const l of legs) assert.match(l.image, /^ghcr\.io\/hello-n00del\/gremion-[a-z-]+$/, `${l.name}: image must be lowercase first-party`)
})

test('release-images.yml: a service dropped from the matrix is caught', () => {
  const input = real()
  const mutated = input.releaseYml.replace(/ *- \{ name: fallback,[^\n]*\n/, '')
  assert.notEqual(mutated, input.releaseYml, 'the mutation must change the file')
  assert.match(matrixProblems({ ...input, releaseYml: mutated }).join('\n'), /no matrix leg builds fallback/)
})

test('release-images.yml: a leg building a different Dockerfile, target or image than compose is caught', () => {
  const input = real()
  const wrongFile = input.releaseYml.replace('dockerfile: services/kernel-api/Dockerfile', 'dockerfile: services/kernel-api/Dockerfile.dev')
  assert.match(matrixProblems({ ...input, releaseYml: wrongFile }).join('\n'), /kernel-api: dockerfile services\/kernel-api\/Dockerfile\.dev/)
  const noTarget = input.releaseYml.replace('target: builder', "target: ''")
  assert.match(matrixProblems({ ...input, releaseYml: noTarget }).join('\n'), /migrate: target '' but compose builds target 'builder'/)
  const wrongImage = input.releaseYml.replace('gremion-control-panel', 'gremion-controlpanel')
  assert.match(matrixProblems({ ...input, releaseYml: wrongImage }).join('\n'), /control-panel: image ghcr\.io\/hello-n00del\/gremion-controlpanel/)
})

test('release-images.yml: a leg docker-build never builds is caught, and so is a stale exclusion', () => {
  const input = real()
  const dropFallback = input.ciYml.replace(/ *- \{ name: fallback,[^\n]*\n/, '')
  assert.notEqual(dropFallback, input.ciYml, 'the mutation must change the file')
  assert.match(matrixProblems({ ...input, ciYml: dropFallback }).join('\n'), /fallback: no docker-build leg builds docker\/fallback\/Dockerfile/)
  const grewVector = input.ciYml.replace(/(- \{ name: fallback,)/, '- { name: vector, dockerfile: docker/vector/Dockerfile, context: docker/vector/ }\n          $1')
  assert.notEqual(grewVector, input.ciYml, 'the mutation must change the file')
  assert.match(matrixProblems({ ...input, ciYml: grewVector }).join('\n'), /NOT_IN_DOCKER_BUILD lists vector/)
})

test('release-images.yml: an empty matrix or an empty docker-build matrix is a failure, never a pass', () => {
  const input = real()
  assert.match(matrixProblems({ ...input, releaseYml: 'jobs: {}\n' }).join('\n'), /has no matrix\.include/)
  assert.match(matrixProblems({ ...input, ciYml: 'jobs: {}\n' }).join('\n'), /docker-build has no matrix\.include/)
})


test('release-images.yml: one job resolves the ref and every other job builds that sha; the shared cache is written from protected commits only', () => {
  assert.deepEqual(refProblems(real().releaseYml), [])
})

test('release-images.yml: a job that reads release_ref itself, or a cache export outside CACHE_WRITE, is caught', () => {
  const { releaseYml } = real()
  const resolved = '${{ needs.resolve-ref.outputs.sha }}'
  assert.ok(releaseYml.includes(resolved), 'the sound file names the resolved sha')
  // a build leg that re-resolves the (movable) ref
  const reref = releaseYml.replace(`ref: ${resolved}`, 'ref: ${{ inputs.release_ref || github.sha }}')
  assert.notEqual(reref, releaseYml, 'the mutation must change the file')
  const found = refProblems(reref).join('\n')
  assert.match(found, /build-and-push: checks out '\$\{\{ inputs\.release_ref \|\| github\.sha \}\}', not the resolved sha/)
  assert.match(found, /build-and-push: reads release_ref itself/)
  // the pins job drops its dependency on resolve-ref
  const noNeed = releaseYml.replace('needs: [resolve-ref, build-and-push]', 'needs: build-and-push')
  assert.notEqual(noNeed, releaseYml, 'the mutation must change the file')
  assert.match(refProblems(noNeed).join('\n'), /emit-release-pins: does not need resolve-ref/)
  // the cache export loses its guard
  const unguarded = releaseYml.replace('if [ "$CACHE_WRITE" = true ]; then\n            cache+=', 'if true; then\n            cache+=')
  assert.notEqual(unguarded, releaseYml, 'the mutation must change the file')
  assert.match(refProblems(unguarded).join('\n'), /--cache-to is not directly under/)
  // no resolve-ref job at all
  assert.match(refProblems('jobs: {}\n').join('\n'), /no resolve-ref job/)
})

// The key password has ONE supported source: COSIGN_PASSWORD_FILE (cut-dist-tag.sh
// refuses to start without it, sign-release.sh refuses COSIGN_PASSWORD unset).
// There is no cosign prompt: the signing step captures cosign's stderr, so a
// prompt would hang unseen. A header or a doc that offers "typed at cosign's
// prompt" sends the operator into exactly that hang (kernel #62 follow-up).
const PROMPT_CLAIM = /(?:typed|entered|supplied|given)\s+(?:at|in|into|to)\s+cosign(?:'s)?\s+prompt/i

/** Lines of `text` that offer a typed-at-the-prompt password source. */
function promptClaims(text) {
  return text.split('\n').flatMap((line, i) => (PROMPT_CLAIM.test(line) ? [`${i + 1}: ${line.trim()}`] : []))
}

test('release-images.yml and the release docs offer COSIGN_PASSWORD_FILE only, never a typed cosign prompt', () => {
  const files = [
    '.github/workflows/release-images.yml',
    'scripts/release/README.md',
    'scripts/release/cut-dist-tag.sh',
    'scripts/release/sign-release.sh',
    'docs/ops/release-signing.md',
    'docs/ops/release-cadence.md',
    'docs/ops/runbook/upgrade.md',
    'docs/ops/runbook/install.md',
  ]
  const found = files.flatMap((f) => promptClaims(read(f)).map((l) => `${f}:${l}`))
  assert.deepEqual(found, [], 'a doc offers a cosign password prompt that the scripts do not support')
  const yml = read('.github/workflows/release-images.yml')
  assert.match(yml, /COSIGN_PASSWORD_FILE=<file>/, 'the workflow header names the supported password source')
})

test('the prompt-claim guard catches the stale line that kernel #62 left in the workflow header', () => {
  const stale = "#      COSIGN_PASSWORD_FILE=<file> (or typed at cosign's prompt), never as"
  assert.equal(promptClaims(stale).length, 1)
  assert.equal(promptClaims('there is no prompt fallback, because sign-release.sh captures stderr').length, 0)
})
