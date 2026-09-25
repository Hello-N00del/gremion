#!/usr/bin/env node
// node --test suite for the toolchain guard (TASK-017). Same idiom as
// check-postgres-major.test.mjs: assert POST-CONDITIONS on real file content
// and synthetic broken state, never an exit code. Every RED case here is one
// this guard must be seen failing on before it is trusted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import {
  NODE_MAJOR,
  NODE_ENGINE_RANGE,
  ALLOWED_BUILD_DEPS,
  ALLOWED_FIRST_PARTY_LIFECYCLE,
  checkNodeMajorDockerfiles,
  checkNodeVersionFiles,
  checkEnginesNode,
  checkEngineStrictOn,
  checkStrictDepBuildsOn,
  checkAllowList,
  checkPackageJsonPnpmBuildControl,
  checkFirstPartyLifecycle,
  checkStrictTsconfigs,
  checkNoSuppressionDirectives,
  parseYamlList,
  resolvePackageDirs,
  gatherRepoState,
  runAllChecks,
} from './check-toolchain.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 1. node-major ─────────────────────────────────────────────────────────

test('node-major: the pin is 26', () => {
  assert.equal(NODE_MAJOR, 26)
  assert.equal(NODE_ENGINE_RANGE, '>=26 <27')
})

test('node-major: RED — a fixture Dockerfile on node:22-alpine is flagged', () => {
  const problems = checkNodeMajorDockerfiles([
    { path: 'fixture/Dockerfile', text: 'FROM node:22-alpine AS builder\nRUN echo hi\n' },
  ])
  assert.match(problems.join('\n'), /FROM node:22 \(expected node:26\)/)
})

test('node-major: GREEN — a fixture Dockerfile on node:26-alpine passes', () => {
  const problems = checkNodeMajorDockerfiles([
    { path: 'fixture/Dockerfile', text: 'FROM node:26-alpine AS builder\nFROM node:26-alpine AS runner\n' },
  ])
  assert.deepEqual(problems, [])
})

test('node-major: an empty Dockerfile set is refused, not a vacuous pass', () => {
  assert.match(checkNodeMajorDockerfiles([]).join('\n'), /pass vacuously/)
})

test('node-major: RED — .nvmrc pinning 24 is flagged', () => {
  const problems = checkNodeVersionFiles([{ path: '.nvmrc', text: '24\n' }])
  assert.match(problems.join('\n'), /pins "24" \(expected "26"\)/)
})

test('node-major: GREEN — .node-version and .nvmrc both pin 26 in the real tree', () => {
  const files = ['.node-version', '.nvmrc'].map((f) => ({ path: f, text: readFileSync(join(ROOT, f), 'utf8') }))
  assert.deepEqual(checkNodeVersionFiles(files), [])
})

test('node-major: RED — engines.node ">=22" is flagged', () => {
  const problems = checkEnginesNode({ engines: { node: '>=22' } })
  assert.match(problems.join('\n'), /engines\.node is ">=22" \(expected ">=26 <27"\)/)
})

test('node-major: GREEN — engines.node ">=26 <27" passes', () => {
  assert.deepEqual(checkEnginesNode({ engines: { node: '>=26 <27' } }), [])
})

test('node-major: engineStrict must be on at the workspace root', () => {
  assert.match(checkEngineStrictOn('packages:\n  - a\n').join('\n'), /engineStrict/)
  assert.deepEqual(checkEngineStrictOn('engineStrict: true\npackages:\n  - a\n'), [])
})

// ── verifier HIGH finding 1: package.json `pnpm` build-control priority ───
// pnpm 10.33 gives a root package.json `pnpm` field PRIORITY over
// pnpm-workspace.yaml for build-script control. Watched empirically: with
// msw removed from the yaml list and `"pnpm":{"onlyBuiltDependencies":
// ["msw"]}` in package.json, `pnpm install --frozen-lockfile --offline`
// still failed loudly (ERR_PNPM_IGNORED_BUILDS naming esbuild) because the
// yaml list was consulted for esbuild — but with ALL four fixture deps
// listed under package.json's `pnpm` field, the install exits 0 and the old
// guard printed OK: an unreasoned, unguarded second allow-list surface.

test('package.json pnpm field: RED — onlyBuiltDependencies in package.json is flagged', () => {
  const problems = checkPackageJsonPnpmBuildControl({ pnpm: { onlyBuiltDependencies: ['better-sqlite3'] } })
  assert.match(problems.join('\n'), /pnpm\.onlyBuiltDependencies/)
})

test('package.json pnpm field: RED — every build-control key variant is flagged', () => {
  const keys = ['onlyBuiltDependencies', 'onlyBuiltDependenciesFile', 'neverBuiltDependencies', 'ignoredBuiltDependencies', 'dangerouslyAllowAllBuilds']
  for (const key of keys) {
    const problems = checkPackageJsonPnpmBuildControl({ pnpm: { [key]: true } })
    assert.match(problems.join('\n'), new RegExp(`pnpm\\.${key}`), `expected a finding for pnpm.${key}`)
  }
})

test('package.json pnpm field: GREEN — no pnpm field, or a pnpm field with unrelated keys, passes', () => {
  assert.deepEqual(checkPackageJsonPnpmBuildControl({}), [])
  assert.deepEqual(checkPackageJsonPnpmBuildControl({ pnpm: { overrides: {} } }), [])
})

test('package.json pnpm field: the real root package.json carries no build-control pnpm field', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(checkPackageJsonPnpmBuildControl(root), [])
})

// ── verifier MEDIUM finding 3: strictDepBuilds has no guard of its own ────

test('strictDepBuilds: RED — a workspace yaml without strictDepBuilds: true is flagged', () => {
  assert.match(checkStrictDepBuildsOn('packages:\n  - a\n').join('\n'), /strictDepBuilds/)
})

test('strictDepBuilds: GREEN — strictDepBuilds: true passes', () => {
  assert.deepEqual(checkStrictDepBuildsOn('strictDepBuilds: true\npackages:\n  - a\n'), [])
})

test('strictDepBuilds: the real pnpm-workspace.yaml sets it', () => {
  const ws = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
  assert.deepEqual(checkStrictDepBuildsOn(ws), [])
})

// ── 2. allow-list ─────────────────────────────────────────────────────────

const LOCK_FIXTURE = `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      esbuild:\n        version: 0.28.2\n  gremion-ui:\n    dependencies: {}\n\npackages:\n\n  esbuild@0.28.2:\n    resolution: {integrity: sha512-x}\n\n  msw@2.15.0:\n    resolution: {integrity: sha512-y}\n`

test('allow-list: the real pnpm-workspace.yaml + pnpm-lock.yaml carry no violations', () => {
  const ws = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  assert.deepEqual(checkAllowList(ws, lock), [])
})

test('allow-list: RED — an allowance with no reason is flagged', () => {
  const ws = 'onlyBuiltDependencies:\n  - esbuild\n  - msw\n  - left-pad\n'
  const problems = checkAllowList(ws, LOCK_FIXTURE, ALLOWED_BUILD_DEPS)
  assert.match(problems.join('\n'), /"left-pad" is allowed in pnpm-workspace\.yaml but has no reason/)
})

test('allow-list: RED — a reason with no allowance is flagged', () => {
  const ws = 'onlyBuiltDependencies:\n  - esbuild\n'
  const table = { ...ALLOWED_BUILD_DEPS, msw: 'reason' }
  const problems = checkAllowList(ws, LOCK_FIXTURE, table)
  assert.match(problems.join('\n'), /"msw" has a reason in the allow-list table but is not allowed/)
})

test('allow-list: RED — the stale better-sqlite3 allowance (not in the lockfile) is flagged', () => {
  const ws = 'onlyBuiltDependencies:\n  - better-sqlite3\n'
  const table = { 'better-sqlite3': 'was allowed once, never actually depended on' }
  const problems = checkAllowList(ws, LOCK_FIXTURE, table)
  assert.match(problems.join('\n'), /"better-sqlite3".*stale allowance/)
})

test('allow-list: RED — an empty-string reason is flagged', () => {
  const ws = 'onlyBuiltDependencies:\n  - esbuild\n  - msw\n'
  const problems = checkAllowList(ws, LOCK_FIXTURE, { esbuild: '', msw: 'ok' })
  assert.match(problems.join('\n'), /"esbuild" has an empty reason/)
})

test('allow-list: a missing onlyBuiltDependencies block is refused, not a vacuous pass', () => {
  assert.match(checkAllowList('packages:\n  - a\n', LOCK_FIXTURE, {}).join('\n'), /declares no onlyBuiltDependencies block/)
})

// ── 3. first-party lifecycle ───────────────────────────────────────────────

test('first-party lifecycle: RED — an unlisted postinstall is flagged', () => {
  const problems = checkFirstPartyLifecycle([
    { path: 'fixture/package.json', json: { scripts: { postinstall: 'node x.js' } } },
  ], {})
  assert.match(problems.join('\n'), /fixture\/package\.json has an unlisted "postinstall" lifecycle script/)
})

test('first-party lifecycle: GREEN — a listed name + reason passes', () => {
  const problems = checkFirstPartyLifecycle([
    { path: 'fixture/package.json', json: { scripts: { postinstall: 'node x.js' } } },
  ], { 'fixture/package.json:postinstall': 'seeds a local dev cert, dev-only' })
  assert.deepEqual(problems, [])
})

test('first-party lifecycle: the real first-party packages carry no unlisted lifecycle script', () => {
  const problems = checkFirstPartyLifecycle([
    { path: 'package.json', json: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) },
    { path: 'gremion-ui/package.json', json: JSON.parse(readFileSync(join(ROOT, 'gremion-ui/package.json'), 'utf8')) },
    { path: 'gremion-public/package.json', json: JSON.parse(readFileSync(join(ROOT, 'gremion-public/package.json'), 'utf8')) },
    { path: 'packages/db/package.json', json: JSON.parse(readFileSync(join(ROOT, 'packages/db/package.json'), 'utf8')) },
    { path: 'packages/ports/package.json', json: JSON.parse(readFileSync(join(ROOT, 'packages/ports/package.json'), 'utf8')) },
  ], ALLOWED_FIRST_PARTY_LIFECYCLE)
  assert.deepEqual(problems, [])
})

test('first-party lifecycle: an empty package set is refused, not a vacuous pass', () => {
  assert.match(checkFirstPartyLifecycle([]).join('\n'), /pass vacuously/)
})

// ── 4. strict TS ────────────────────────────────────────────────────────────

test('strict-ts: RED — strict:false is flagged', () => {
  const problems = checkStrictTsconfigs([
    { path: 'fixture/tsconfig.json', text: '{"compilerOptions": {"strict": false}}' },
  ])
  assert.match(problems.join('\n'), /sets "strict": false/)
})

test('strict-ts: RED — noImplicitAny:false is flagged', () => {
  const problems = checkStrictTsconfigs([
    { path: 'fixture/tsconfig.json', text: '{"compilerOptions": {"strict": true, "noImplicitAny": false}}' },
  ])
  assert.match(problems.join('\n'), /sets "noImplicitAny": false/)
})

test('strict-ts: GREEN — strict:true passes', () => {
  assert.deepEqual(checkStrictTsconfigs([{ path: 'fixture/tsconfig.json', text: '{"compilerOptions": {"strict": true}}' }]), [])
})

test('strict-ts: a tsconfig that only "extends" (e.g. the generated .svelte-kit one) is not flagged for missing strict', () => {
  const problems = checkStrictTsconfigs([
    { path: 'gremion-ui/tsconfig.json', text: '{"extends": "./.svelte-kit/tsconfig.json", "compilerOptions": {"strict": true}}' },
  ])
  assert.deepEqual(problems, [])
})

// ── verifier HIGH finding 2: `extends` alone must never satisfy strict ────
// checkStrictTsconfigs used to accept ANY `extends` key as proof of strict,
// including a generated .svelte-kit/tsconfig.json that itself sets no
// strict — watched empirically: removing "strict": true from
// gremion-ui/tsconfig.json in a scratch worktree left the guard printing OK.

test('strict-ts: RED — extends a generated (.svelte-kit) config with no strict of its own is flagged, not accepted', () => {
  const problems = checkStrictTsconfigs([
    { path: 'gremion-ui/tsconfig.json', text: '{"extends": "./.svelte-kit/tsconfig.json", "compilerOptions": {}}' },
  ])
  assert.match(problems.join('\n'), /does not set "strict": true/)
})

test('strict-ts: RED — extends a first-party config that is NOT itself strict is flagged', () => {
  const problems = checkStrictTsconfigs([
    { path: 'packages/x/tsconfig.json', text: '{"compilerOptions": {"strict": false}}' },
    { path: 'packages/x/tsconfig.build.json', text: '{"extends": "./tsconfig.json", "compilerOptions": {}}' },
  ])
  assert.match(problems.join('\n'), /packages\/x\/tsconfig\.json: sets "strict": false/)
  assert.match(problems.join('\n'), /packages\/x\/tsconfig\.build\.json.*not.*strict/)
})

test('strict-ts: GREEN — extends a first-party sibling tsconfig that IS strict:true is accepted (packages/*/tsconfig.build.json case)', () => {
  const problems = checkStrictTsconfigs([
    { path: 'packages/db/tsconfig.json', text: '{"compilerOptions": {"strict": true}}' },
    { path: 'packages/db/tsconfig.build.json', text: '{"extends": "./tsconfig.json", "compilerOptions": {"outDir": "dist"}}' },
  ])
  assert.deepEqual(problems, [])
})

test('strict-ts: every real first-party tsconfig*.json is strict:true', () => {
  const files = [
    'gremion-ui/tsconfig.json', 'gremion-public/tsconfig.json',
    'packages/db/tsconfig.json', 'packages/db/tsconfig.build.json',
    'packages/ports/tsconfig.json', 'packages/ports/tsconfig.build.json',
  ].map((p) => ({ path: p, text: readFileSync(join(ROOT, p), 'utf8') }))
  assert.deepEqual(checkStrictTsconfigs(files), [])
})

test('strict-ts: an empty tsconfig set is refused, not a vacuous pass', () => {
  assert.match(checkStrictTsconfigs([]).join('\n'), /pass vacuously/)
})

test('suppression directives: RED — @ts-ignore in a non-test source is flagged', () => {
  const problems = checkNoSuppressionDirectives([{ path: 'fixture/src/x.ts', text: 'const a: number = 1\n// @ts-ignore\nconst b: string = a\n' }])
  assert.match(problems.join('\n'), /banned suppression directive/)
})

test('suppression directives: RED — @ts-nocheck is flagged', () => {
  const problems = checkNoSuppressionDirectives([{ path: 'fixture/src/x.ts', text: '// @ts-nocheck\nconst a = 1\n' }])
  assert.match(problems.join('\n'), /banned suppression directive/)
})

test('suppression directives: RED — @ts-expect-error outside a test file is flagged (Q2)', () => {
  const problems = checkNoSuppressionDirectives([{ path: 'fixture/src/x.ts', text: '// @ts-expect-error\nconst a: string = 1\n' }])
  assert.match(problems.join('\n'), /outside a \*\.test\.ts file/)
})

test('suppression directives: GREEN — @ts-expect-error inside a *.test.ts file is allowed', () => {
  const problems = checkNoSuppressionDirectives([{ path: 'fixture/src/x.test.ts', text: '// @ts-expect-error\nconst a: string = 1\n' }])
  assert.deepEqual(problems, [])
})

test('suppression directives: an empty source set is refused, not a vacuous pass', () => {
  assert.match(checkNoSuppressionDirectives([]).join('\n'), /pass vacuously/)
})

// ── package discovery ───────────────────────────────────────────────────────

test('parseYamlList: reads a real block and returns null for a missing one', () => {
  assert.deepEqual(parseYamlList('onlyBuiltDependencies:\n  - a\n  - b\n', 'onlyBuiltDependencies'), ['a', 'b'])
  assert.equal(parseYamlList('packages:\n  - a\n', 'onlyBuiltDependencies'), null)
})

test('resolvePackageDirs: expands packages/* against a real directory and includes literal entries', () => {
  const ws = "packages:\n  - 'gremion-ui'\n  - 'gremion-public'\n  - 'packages/*'\n"
  const dirs = resolvePackageDirs(ROOT, ws)
  assert.ok(dirs.includes('gremion-ui'))
  assert.ok(dirs.includes('gremion-public'))
  assert.ok(dirs.includes('packages/db'))
  assert.ok(dirs.includes('packages/ports'))
})

test('resolvePackageDirs: a glob against a nonexistent prefix resolves to nothing, not a throw', () => {
  assert.deepEqual(resolvePackageDirs(ROOT, "packages:\n  - 'services/*'\n"), [])
})

// ── the real tree, end to end ────────────────────────────────────────────

test('the real tree passes every check with zero violations', () => {
  const state = gatherRepoState(ROOT)
  assert.ok(state.dockerfiles.length >= 3, 'fixture precondition: all three first-party Dockerfiles are tracked')
  assert.ok(state.tsconfigs.length >= 6, 'fixture precondition: all six tsconfigs are discovered')
  assert.ok(state.packageJsons.length >= 5, 'fixture precondition: root + 4 workspace package.json are discovered')
  assert.deepEqual(runAllChecks(state), [])
})

// ── item 5: seeded install fixture (offline, real pnpm) ────────────────────
// Slow (spawns a real pnpm install) — run with a generous but bounded timeout
// so it cannot hang the suite. See scripts/fixtures/toolchain/seeded-install/
// for the fixture layout and README for how the tarball was built.

test('seeded install: with strictDepBuilds + no allowance, the fixture postinstall does not run and install fails loudly', { timeout: 60_000 }, () => {
  const fixtureRoot = join(ROOT, 'scripts/fixtures/toolchain/seeded-install')
  const work = mkdtempSync(join(tmpdir(), 'toolchain-seeded-'))
  try {
    // Copy the fixture into a scratch dir so the marker file / node_modules a
    // run leaves behind never touch the tracked fixture.
    execCopy(fixtureRoot, work)
    const out = runInstall(work, { expectFailure: true })
    assert.match(out.combined, /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/)
    assert.ok(!markerExists(work), 'the seeded postinstall must NOT have run — its marker file must be absent')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('seeded install: allow-listing the fixture dependency makes the install succeed, its postinstall actually runs, and the frozen lockfile still catches a stale range', { timeout: 60_000 }, () => {
  // Verifier MEDIUM finding 4: pnpm's side-effects cache can restore an
  // already-built package without re-running its postinstall, so "marker
  // absent" alone (in the BLOCKED test above) proves nothing without a
  // positive control here. --config.side-effects-cache=false forces a real
  // postinstall run, so the marker's presence here is that positive control.
  const fixtureRoot = join(ROOT, 'scripts/fixtures/toolchain/seeded-install-allowed')
  const work = mkdtempSync(join(tmpdir(), 'toolchain-seeded-allowed-'))
  try {
    execCopy(fixtureRoot, work)
    const out = runInstall(work, { expectFailure: false })
    assert.equal(out.status, 0, out.combined)
    assert.ok(markerExists(work), 'the allowed postinstall must have run — its marker file must be present (positive control for the blocked test\'s marker check)')
    // Edit the dependency range without relocking, then --frozen-lockfile
    // must refuse.
    editRange(work)
    const out2 = runInstall(work, { expectFailure: true })
    assert.match(out2.combined, /ERR_PNPM_OUTDATED_LOCKFILE/)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

// ── item 6: the suite's own test count is asserted at the Makefile layer ──
// (make lint-toolchain — see the Makefile target; mirrors lint-extraction-source)

function execCopy(src, dest) {
  cpSync(src, dest, { recursive: true })
}

function markerExists(work) {
  return existsSync(join(work, 'node_modules', '.toolchain-fixture-marker'))
}

function runInstall(work, { expectFailure }) {
  // shell:true is required on Windows to resolve the `pnpm` shim
  // (pnpm.cmd/pnpm.ps1 are not directly executable); it is not a shell-
  // injection risk here because every argument is a fixed literal, never
  // caller- or fixture-controlled input. Passed as ONE command string (not an
  // args array) so Node 26 does not emit DEP0190 ("Passing args to a child
  // process with shell option true") — verifier LOW finding 10.
  // --config.side-effects-cache=false forces a real postinstall run instead
  // of a cache-restore that would skip it (verifier MEDIUM finding 4).
  const cmd = 'pnpm install --frozen-lockfile --offline --config.side-effects-cache=false'
  const res = spawnSync(cmd, { cwd: work, encoding: 'utf8', shell: true })
  const combined = `${res.stdout || ''}\n${res.stderr || ''}`
  if (expectFailure) {
    assert.notEqual(res.status, 0, `expected the install to fail; got status ${res.status}\n${combined}`)
  }
  return { status: res.status, combined }
}

function editRange(work) {
  const pkgPath = join(work, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const dep = Object.keys(pkg.dependencies ?? {})[0]
  pkg.dependencies[dep] = '9.9.9'
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}
