// TASK-041 (L3-08): the edge host-model guard — RED fixtures, the pinned rule
// table, vacuity, and the real tree.
//
//   node --test --test-reporter=tap scripts/check-edge-host-model.test.mjs
//
// `make lint-edge-host` asserts that node collects exactly the number of
// top-level `test(` calls declared here, so every case stays top-level.
//
// The real-tree case is the one that matters: it was RED on the pre-deletion
// tree (the four compose HostRegexp legs, the wildcard env key, the apex host
// injection and the leftmost-label resolver) and is GREEN only once all of
// them are gone. Every other case proves the guard can see what it claims to.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import {
  RULES,
  REPO_ROOT,
  FIXTURE_GLOB,
  GUARD_OWN_FILES,
  scan,
  isClean,
  formatReport,
  listDirFiles,
  listTrackedFiles,
  globToRegExp,
} from './check-edge-host-model.mjs'

const FIXTURES = path.join(REPO_ROOT, 'test', 'host', 'fixtures', 'edge-host-model')
const rule = (id) => RULES.filter((r) => r.id === id)

/** Scan one fixture tree with the REAL rules named. */
function scanFixture(dir, ids) {
  const root = path.join(FIXTURES, dir)
  return scan({ root, files: listDirFiles(root), rules: ids.flatMap(rule) })
}
const findingsOf = (res, id) => res.findings.filter((f) => f.rule === id)

test('the rule table is pinned by value: scopes, exemptions and the two internaltest routers', () => {
  const shape = RULES.map((r) => ({
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    exempt: r.exempt.map((e) => e.glob),
    routerExempt: (r.routerExempt ?? []).map(({ file, router, entryPoints, rule: value }) => ({
      file,
      router,
      entryPoints,
      rule: value,
    })),
  }))
  const compose = ['**/docker-compose*.yml', '**/docker-compose*.yaml']
  assert.deepEqual(shape, [
    {
      id: 'R1',
      kind: 'router',
      scope: [...compose, 'docker/traefik/**', 'infra/host/templates/edge/**'],
      exempt: ['test/host/fixtures/edge-host-model/**'],
      routerExempt: [
        {
          file: 'infra/host/templates/edge/active.yml.tmpl',
          router: 'test-app',
          entryPoints: ['internaltest'],
          rule: 'HostRegexp(`.+`)',
        },
        {
          file: 'infra/host/templates/edge/active.yml.tmpl',
          router: 'test-public',
          entryPoints: ['internaltest'],
          rule: 'HostRegexp(`.+`) && PathPrefix(`/portal`)',
        },
      ],
    },
    {
      id: 'R2a',
      kind: 'text',
      scope: ['**'],
      exempt: [
        'k8s/**',
        'docs/superpowers/**',
        '**/migrations*/**',
        'scripts/check-edge-host-model.mjs',
        'scripts/check-edge-host-model.test.mjs',
        'test/host/fixtures/edge-host-model/**',
      ],
      routerExempt: [],
    },
    {
      id: 'R2b',
      kind: 'text',
      scope: ['**/.env*', ...compose, 'docker/traefik/**', 'infra/host/templates/**', 'KNOWN_ISSUES.md', 'docs/**'],
      exempt: ['docs/superpowers/**', 'test/host/fixtures/edge-host-model/**'],
      routerExempt: [],
    },
    {
      id: 'R3',
      kind: 'text',
      scope: [...compose, 'docker/traefik/**', 'infra/host/templates/edge/**', '**/.env*'],
      exempt: ['test/host/fixtures/edge-host-model/**'],
      routerExempt: [],
    },
    {
      id: 'R4',
      kind: 'text',
      scope: [
        'gremion-ui/src/**',
        'gremion-public/src/**',
        'packages/**',
        'scripts/**',
        '.github/**',
        'gremion-ui/playwright.config.ts',
        ...compose,
        'docs/**',
      ],
      exempt: [
        'docs/superpowers/**',
        '**/migrations*/**',
        'k8s/**',
        'scripts/check-edge-host-model.mjs',
        'scripts/check-edge-host-model.test.mjs',
      ],
      routerExempt: [],
    },
  ])
  // Every carve-out says why, and no R1 router exemption reaches a public entrypoint.
  for (const r of RULES) {
    for (const e of [...r.exempt, ...(r.routerExempt ?? [])]) {
      assert.ok(typeof e.reason === 'string' && e.reason.length > 20, `${r.id} exemption without a reason`)
    }
    for (const e of r.routerExempt ?? []) assert.deepEqual(e.entryPoints, ['internaltest'])
  }
  assert.equal(FIXTURE_GLOB, 'test/host/fixtures/edge-host-model/**')
  assert.deepEqual(GUARD_OWN_FILES, ['scripts/check-edge-host-model.mjs', 'scripts/check-edge-host-model.test.mjs'])
})

test('the globs anchor at the repository root and ** spans directories', () => {
  assert.ok(globToRegExp('**/docker-compose*.yml').test('docker-compose.prod.yml'))
  assert.ok(globToRegExp('**/docker-compose*.yml').test('infra/host/ops/docker-compose.yml'))
  assert.ok(!globToRegExp('**/docker-compose*.yml').test('docker-compose.yml.bak'))
  assert.ok(globToRegExp('**/migrations*/**').test('gremion-ui/migrations-control/004_tenant_domain.sql'))
  assert.ok(globToRegExp('**/.env*').test('.env.example'))
  assert.ok(!globToRegExp('docs/**').test('gremion-ui/docs/x.md'))
  assert.ok(!globToRegExp('gremion-ui/src/**').test('test/gremion-ui/src/x.ts'))
})

test('R1 RED: a HostRegexp leg on a websecure compose router', () => {
  const got = findingsOf(scanFixture('r1-websecure', ['R1']), 'R1')
  assert.equal(got.length, 1)
  assert.match(got[0].detail, /router 'gremion-ui' on \[websecure\]/)
})

test('R1 RED: a HostRegexp leg in a file-provider rule', () => {
  const got = findingsOf(scanFixture('r1-file-provider', ['R1']), 'R1')
  assert.equal(got.length, 1)
  assert.match(got[0].detail, /router 'wild'/)
})

test('R1 RED: an internaltest router nobody pinned', () => {
  const got = findingsOf(scanFixture('r1-unlisted-internaltest', ['R1']), 'R1')
  assert.deepEqual(
    got.map((f) => f.detail.match(/router '([^']+)'/)[1]),
    ['test-extra'],
  )
})

test('R1 RED: a pinned router widened onto websecure loses its exemption', () => {
  const res = scanFixture('r1-widened', ['R1'])
  const got = findingsOf(res, 'R1')
  assert.equal(got.length, 1)
  assert.match(got[0].detail, /router 'test-app' on \[internaltest,websecure\]/)
  assert.ok(res.stale.some((s) => s.exemption === 'infra/host/templates/edge/active.yml.tmpl#test-app'))
})

test('R1 GREEN: exactly the two pinned internaltest routers', () => {
  const res = scanFixture('r1-pinned', ['R1'])
  assert.deepEqual(findingsOf(res, 'R1'), [])
  assert.equal(res.stats.R1.parsed, 2)
  // Both router pins were USED; only the fixture-directory glob is absent here.
  assert.deepEqual(
    res.stale.map((s) => s.exemption),
    ['test/host/fixtures/edge-host-model/**'],
  )
})

test('R1 RED: a file in scope that cannot be parsed is never a pass', () => {
  const got = findingsOf(scanFixture('r1-unparseable', ['R1']), 'R1')
  assert.equal(got.length, 1)
  assert.match(got[0].detail, /could not look/)
})

test('R2a RED: the wildcard env key assigned', () => {
  const got = findingsOf(scanFixture('r2a', ['R2a']), 'R2a')
  assert.deepEqual(got.map((f) => `${f.file}:${f.line}`), ['.env.example:2'])
})

test('R2b RED: the wildcard env key named in operator docs', () => {
  const got = findingsOf(scanFixture('r2b', ['R2b']), 'R2b')
  assert.deepEqual(got.map((f) => `${f.file}:${f.line}`), ['docs/guide.md:3'])
})

test('R3 RED: the apex host-injection middleware', () => {
  const got = findingsOf(scanFixture('r3', ['R3']), 'R3')
  assert.deepEqual(got.map((f) => f.line), [5, 6])
})

test('R4 RED: the leftmost-label resolver named in docs', () => {
  const got = findingsOf(scanFixture('r4', ['R4']), 'R4')
  assert.deepEqual(got.map((f) => `${f.file}:${f.line}`), ['docs/resolver.md:3'])
})

test('a stale exemption (matching no tracked file) is RED', () => {
  const root = path.join(FIXTURES, 'r2b')
  const stale = { ...RULES.find((r) => r.id === 'R2b'), exempt: [{ glob: 'nowhere/**', reason: 'a carve-out for a path that does not exist' }] }
  const res = scan({ root, files: listDirFiles(root), rules: [stale] })
  assert.deepEqual(res.stale, [{ rule: 'R2b', exemption: 'nowhere/**' }])
  assert.equal(isClean(res), false)
})

test('vacuity RED: a rule whose scope matches no file', () => {
  const root = path.join(FIXTURES, 'r2b')
  const res = scan({ root, files: listDirFiles(root), rules: rule('R1') })
  assert.ok(res.vacuous.includes('R1: no file in scope'), formatReport(res))
  assert.equal(isClean(res), false)
})

test('vacuity RED: files in R1 scope but no router rule parsed', () => {
  const res = scanFixture('r1-no-rules', ['R1'])
  assert.deepEqual(findingsOf(res, 'R1'), [])
  assert.ok(res.vacuous.includes('R1: no router rule parsed'), formatReport(res))
})

test('vacuity RED: an empty scan root', () => {
  const res = scan({ root: REPO_ROOT, files: [], rules: RULES })
  assert.ok(res.vacuous.includes('the scan root lists no files'))
  assert.equal(isClean(res), false)
})

test('vacuity RED: an empty rule table', () => {
  const res = scan({ root: REPO_ROOT, files: listTrackedFiles(), rules: [] })
  assert.ok(res.vacuous.includes('the rule table is empty: nothing would be checked'))
  assert.equal(isClean(res), false)
})

// TASK-040 moved gremion-ui and gremion-public out of docker-compose.yml into
// the per-colour app file (and its dev layer). A guard whose scope silently
// stopped at the state files would lose the two services that carried every
// wildcard leg and the apex injection, so the app files are pinned in scope
// and a re-break of the REAL app file (its own text, one label added) is RED.
const APP_FILES = ['docker-compose.app.yml', 'docker-compose.app.dev.yml']

test('TASK-040 app tier: both app compose files are tracked and in R1, R2b, R3 and R4 scope', () => {
  const tracked = listTrackedFiles()
  for (const f of APP_FILES) {
    assert.ok(tracked.includes(f), `${f} is not tracked`)
    for (const id of ['R1', 'R2b', 'R3', 'R4']) {
      const r = RULES.find((x) => x.id === id)
      const inScope = r.scope.some((g) => globToRegExp(g).test(f)) && !r.exempt.some((e) => globToRegExp(e.glob).test(f))
      assert.ok(inScope, `${id} does not scan ${f}`)
    }
  }
})

test('TASK-040 app tier RED: a HostRegexp router or the apex injection added to the real app file', () => {
  const rel = 'docker-compose.app.yml'
  const real = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
  const anchor = '      traefik.enable: "false"\n'
  assert.ok(real.includes(anchor), `${rel} lost the map-form traefik.enable label this test anchors on`)
  const withLeg = real.replace(
    anchor,
    `${anchor}      traefik.http.routers.wild.rule: "HostRegexp(\`^[a-z0-9-]+\\\\.example$$\`)"\n      traefik.http.routers.wild.entrypoints: websecure\n`,
  )
  const withApex = real.replace(anchor, `${anchor}      traefik.http.routers.apex.middlewares: gremion-ui-apex${'host'}\n`)
  const scanText = (text, ids) => scan({ root: REPO_ROOT, files: [rel], rules: ids.flatMap(rule), read: () => text })
  // The unmodified file is clean, and R1 parsed it (a guard that could not
  // read the app file would pass the re-breaks below vacuously).
  const clean = scanText(real, ['R1', 'R3'])
  assert.deepEqual(clean.findings, [])
  assert.ok(clean.stats.R1.files === 1, formatReport(clean))
  const r1 = findingsOf(scanText(withLeg, ['R1']), 'R1')
  assert.equal(r1.length, 1)
  assert.match(r1[0].detail, /router 'wild' on \[websecure\] has a HostRegexp leg/)
  const r3 = findingsOf(scanText(withApex, ['R3']), 'R3')
  assert.equal(r3.length, 1)
  assert.equal(r3[0].file, rel)
})

test('the real tree is GREEN: no wildcard leg, no wildcard key, no apex injection, no leftmost label', () => {
  const files = listTrackedFiles()
  const res = scan({ root: REPO_ROOT, files, rules: RULES })
  assert.ok(files.length > 100, `git ls-files listed only ${files.length} files`)
  for (const r of RULES) {
    assert.ok(res.stats[r.id].files > 0, `${r.id} scanned no file`)
    assert.ok(res.stats[r.id].parsed > 0, `${r.id} parsed nothing`)
  }
  assert.ok(isClean(res), `edge host-model violations on the real tree:\n${formatReport(res)}`)
})
