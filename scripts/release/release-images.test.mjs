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
