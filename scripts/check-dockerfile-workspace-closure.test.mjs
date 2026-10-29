#!/usr/bin/env node
// node --test suite for the Dockerfile workspace-closure guard.
//
// Fixture trees reproduce the 2026-10-29 defect: a leaf image COPYs a package whose
// manifest gained a `workspace:*` dependency on a package the Dockerfile never COPYs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { checkWorkspaceClosure, relation, findDockerfiles, KERNEL_ROOT } from './check-dockerfile-workspace-closure.mjs'

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'df-closure-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Run `fn` over a fixture tree and always remove it. */
function withTree(files, fn) {
  const t = tree(files)
  try {
    return fn(t.root)
  } finally {
    t.cleanup()
  }
}

const pkg = (name, deps = {}, field = 'dependencies') => JSON.stringify({ name, [field]: deps })
const WS = "packages:\n  - 'packages/*'\n  - 'services/*'\n  - 'gremion-ui'\n\noverrides:\n  x: y\n"
const W = { 'pnpm-workspace.yaml': WS, 'package.json': '{}' }
const dep = { '@gremion/b': 'workspace:*' }

/** a depends on b depends on c, so a Dockerfile building `a` needs all three. */
function chain(dockerfile, extra = {}) {
  return {
    ...W,
    'packages/a/package.json': pkg('@gremion/a', dep),
    'packages/b/package.json': pkg('@gremion/b', { '@gremion/c': 'workspace:^' }),
    'packages/c/package.json': pkg('@gremion/c'),
    'services/svc/Dockerfile': dockerfile,
    ...extra,
  }
}

const FROM = 'FROM node:26-alpine\nCOPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\n'
const MANIFESTS_AB = 'COPY packages/a/package.json ./packages/a/\nCOPY packages/b/package.json ./packages/b/\n'
const MANIFESTS_ABC = MANIFESTS_AB + 'COPY packages/c/package.json ./packages/c/\n'

test('the 2026-10-29 defect: a transitive workspace dependency never COPYed fails, naming Dockerfile, package and chain', () => {
  const df = FROM + MANIFESTS_AB + 'RUN pnpm install\nCOPY packages/a ./packages/a/\nCOPY packages/b ./packages/b/\n'
  withTree(chain(df), (root) => {
    const r = checkWorkspaceClosure(root)
    assert.equal(r.problems.length, 2)
    assert.match(
      r.problems[0],
      /^services\/svc\/Dockerfile: @gremion\/c \(packages\/c\) .*\(@gremion\/b -> @gremion\/c\) but its manifest is never COPYed/,
    )
    assert.match(r.problems[1], /^services\/svc\/Dockerfile: @gremion\/c .* but its source is never COPYed/)
  })
})

test('the manifest and the source are checked independently', () => {
  const df = FROM + MANIFESTS_ABC + 'RUN pnpm install\nCOPY packages/a ./packages/a/\nCOPY packages/b ./packages/b/\n'
  withTree(chain(df), (root) => {
    const r = checkWorkspaceClosure(root)
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0], /@gremion\/c .* but its source is never COPYed/)
  })
})

test('passes a complete closure; a seed whose own source is never COPYed is flagged too', () => {
  const full = FROM + MANIFESTS_ABC + 'RUN pnpm install\nCOPY packages/a packages/b packages/c ./packages/\n'
  withTree(chain(full), (root) => {
    const r = checkWorkspaceClosure(root)
    assert.deepEqual(r.problems, [])
    assert.equal(r.workspaceDockerfiles, 1)
    assert.equal(r.packages, 3)
  })
  const noASource = FROM + MANIFESTS_ABC + 'RUN pnpm install\nCOPY packages/b packages/c ./packages/\n'
  withTree(chain(noASource), (root) => {
    const r = checkWorkspaceClosure(root)
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0], /^services\/svc\/Dockerfile: @gremion\/a \(packages\/a\) .*\(@gremion\/a\) but its source is never COPYed/)
  })
})

test('a COPY of a parent directory or a glob covers the packages beneath it', () => {
  withTree(chain(FROM + 'COPY packages/*/package.json ./packages/\nRUN pnpm install\nCOPY packages ./packages/\n'), (root) =>
    assert.deepEqual(checkWorkspaceClosure(root).problems, []),
  )
  withTree(chain(FROM + MANIFESTS_ABC + 'COPY packages/* ./packages/\n'), (root) =>
    assert.deepEqual(checkWorkspaceClosure(root).problems, []),
  )
})

test('a path strictly inside a package counts as its source, a lone package.json does not', () => {
  withTree(chain(FROM + MANIFESTS_ABC + 'COPY packages/a packages/b ./packages/\nCOPY packages/c/bin ./packages/c/bin/\n'), (root) =>
    assert.deepEqual(checkWorkspaceClosure(root).problems, []),
  )
  withTree(chain(FROM + MANIFESTS_ABC + 'COPY packages/a packages/b ./packages/\n'), (root) => {
    const r = checkWorkspaceClosure(root)
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0], /@gremion\/c .* source is never COPYed/)
  })
})

test('devDependencies, optionalDependencies and peerDependencies are part of the closure', () => {
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
    withTree(
      {
        ...W,
        'packages/a/package.json': pkg('@gremion/a', dep, field),
        'packages/b/package.json': pkg('@gremion/b'),
        'services/svc/Dockerfile': FROM + 'COPY packages/a/package.json ./packages/a/\nCOPY packages/a ./packages/a/\n',
      },
      (root) => {
        const r = checkWorkspaceClosure(root)
        assert.equal(r.problems.length, 2, field)
        assert.match(r.problems[0], /@gremion\/b .* manifest is never COPYed/, field)
      },
    )
  }
})

test('a non-workspace spec and a $VAR source are not closure members', () => {
  withTree(
    {
      ...W,
      'packages/a/package.json': pkg('@gremion/a', { '@gremion/b': '^1.0.0' }),
      'packages/b/package.json': pkg('@gremion/b'),
      'services/svc/Dockerfile': FROM + 'COPY packages/a/package.json ./packages/a/\nCOPY packages/a ./packages/a/\nCOPY ${X} ./x/\n',
    },
    (root) => assert.deepEqual(checkWorkspaceClosure(root).problems, []),
  )
})

test('a workspace: spec that names no workspace package is a problem, not skipped', () => {
  const df = FROM + 'COPY packages/a/package.json ./packages/a/\nCOPY packages/a ./packages/a/\n'
  withTree(
    {
      ...W,
      'packages/a/package.json': pkg('@gremion/a', { 'left-pad': 'workspace:*' }),
      'services/svc/Dockerfile': df,
    },
    (root) => {
      const r = checkWorkspaceClosure(root)
      assert.equal(r.problems.length, 1)
      assert.match(r.problems[0], /^packages\/a\/package\.json: @gremion\/a depends on "left-pad" via "workspace:\*" but no workspace package is named left-pad/)
    },
  )
  // The alias form `workspace:<name>@<range>` and the path form `workspace:../c` resolve to real packages.
  withTree(
    {
      ...W,
      'packages/a/package.json': pkg('@gremion/a', { alias: 'workspace:@gremion/b@*', other: 'workspace:../c' }),
      'packages/b/package.json': pkg('@gremion/b'),
      'packages/c/package.json': pkg('@gremion/c'),
      'services/svc/Dockerfile': FROM + MANIFESTS_ABC + 'COPY packages/a packages/b packages/c ./packages/\n',
    },
    (root) => assert.deepEqual(checkWorkspaceClosure(root).problems, []),
  )
})

test('a pnpm-workspace.yaml glob that is neither a literal dir nor <dir>/* is a problem; ! negations are ignored', () => {
  const base = {
    'packages/a/package.json': pkg('@gremion/a'),
    'services/svc/Dockerfile': FROM + 'COPY packages/a/package.json ./packages/a/\nCOPY packages/a ./packages/a/\n',
    'package.json': '{}',
  }
  for (const glob of ['packages/**', 'packages/a*', 'pack*/a', 'packages/{a,b}', 'packages/*/sub', '**'])
    withTree({ ...base, 'pnpm-workspace.yaml': `packages:\n  - 'packages/*'\n  - '${glob}'\n` }, (root) => {
      const r = checkWorkspaceClosure(root)
      assert.equal(r.problems.length, 1, glob)
      assert.ok(r.problems[0].startsWith(`pnpm-workspace.yaml: unsupported packages glob '${glob}'`), glob)
    })
  withTree({ ...base, 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!**/test/**'\n  - \"!packages/zzz\"\n" }, (root) =>
    assert.deepEqual(checkWorkspaceClosure(root).problems, []),
  )
})

test('a wholesale COPY of a parent directory (kernel-api COPY modules) makes no package a seed', () => {
  // b's manifest rides along with `COPY packages`, but nothing builds b: only a is a seed and a has no workspace deps.
  withTree(
    {
      ...W,
      'packages/a/package.json': pkg('@gremion/a'),
      'packages/b/package.json': pkg('@gremion/b', { '@gremion/c': 'workspace:*' }),
      'packages/c/package.json': pkg('@gremion/c'),
      'services/svc/Dockerfile': FROM + 'COPY packages/a/package.json ./packages/a/\nCOPY packages/a ./packages/a/\nCOPY packages ./m/\n',
    },
    (root) => assert.deepEqual(checkWorkspaceClosure(root).problems, []),
  )
})

test('COPY --from stage copies neither seed nor cover anything', () => {
  const df =
    'FROM node:26-alpine AS b\n' + MANIFESTS_ABC + 'COPY packages/a packages/b packages/c ./packages/\n' +
    'FROM node:26-alpine\nCOPY --from=b /repo/packages/zzz/package.json ./\n'
  withTree(chain(df), (root) => assert.deepEqual(checkWorkspaceClosure(root).problems, []))
  const onlyFrom = 'FROM node:26-alpine AS b\nFROM node:26-alpine\nCOPY --from=b /repo/packages/a/package.json ./\n'
  withTree(chain(onlyFrom), (root) => assert.match(checkWorkspaceClosure(root).problems[0], /no Dockerfile COPYs a workspace package manifest/))
})

test('a Dockerfile that COPYs no workspace manifest is left alone, whatever else is wrong', () => {
  const df = FROM + 'COPY packages/a/package.json ./packages/a/\nCOPY packages/b ./packages/b/\n'
  withTree(chain(df, { 'docker/legal/Dockerfile': 'FROM alpine\nCOPY entrypoint.sh /e.sh\n' }), (root) => {
    const r = checkWorkspaceClosure(root)
    assert.ok(r.problems.length > 0)
    assert.ok(r.problems.every((p) => p.startsWith('services/svc/Dockerfile:')))
    assert.equal(r.workspaceDockerfiles, 1)
    assert.equal(r.dockerfiles, 2)
  })
})

test('every Dockerfile is checked wherever it lives and each is reported by its own path', () => {
  const bad = FROM + 'COPY packages/a/package.json ./packages/a/\nCOPY packages/a ./packages/a/\n'
  const complete = FROM + 'COPY packages/b/package.json packages/c/package.json ./\nCOPY packages/b packages/c ./packages/\n'
  withTree(chain(bad, { 'gremion-ui/Dockerfile': bad, 'packages/b/Dockerfile.dev': complete }), (root) => {
    const hit = new Set(checkWorkspaceClosure(root).problems.map((p) => p.split(': ')[0]))
    assert.deepEqual([...hit].sort(), ['gremion-ui/Dockerfile', 'services/svc/Dockerfile'])
    assert.deepEqual(findDockerfiles(root), ['gremion-ui/Dockerfile', 'packages/b/Dockerfile.dev', 'services/svc/Dockerfile'])
  })
})

test('relation(): equal, ancestor, glob and inside', () => {
  assert.equal(relation('packages/a', 'packages/a/package.json'), 'covers')
  assert.equal(relation('packages/a/', 'packages/a'), 'covers')
  assert.equal(relation('./packages', 'packages/a/package.json'), 'covers')
  assert.equal(relation('.', 'packages/a'), 'covers')
  assert.equal(relation('packages/*/package.json', 'packages/a/package.json'), 'covers')
  assert.equal(relation('packages/**', 'packages/a/x/y'), 'covers')
  assert.equal(relation('packages/a/bin', 'packages/a'), 'inside')
  assert.equal(relation('packages/ab', 'packages/a'), null)
  assert.equal(relation('packages/a', 'packages/ab/package.json'), null)
  assert.equal(relation('modules/board/module.json', 'packages/a'), null)
})

test('refuses to pass over zero workspace packages, zero Dockerfiles, or no workspace Dockerfile', () => {
  withTree({ 'package.json': '{}', 'x/Dockerfile': 'FROM alpine\n' }, (root) =>
    assert.match(checkWorkspaceClosure(root).problems[0], /no workspace package .*gone blind/),
  )
  withTree({ ...W, 'packages/a/package.json': pkg('@gremion/a') }, (root) =>
    assert.match(checkWorkspaceClosure(root).problems[0], /no Dockerfile found .*gone blind/),
  )
  withTree({ ...W, 'packages/a/package.json': pkg('@gremion/a'), 'docker/Dockerfile': 'FROM alpine\nCOPY e.sh /e\n' }, (root) =>
    assert.match(checkWorkspaceClosure(root).problems[0], /no Dockerfile COPYs a workspace package manifest .*gone blind/),
  )
})

test('the real kernel tree: every workspace Dockerfile COPYs its whole @gremion/* closure', () => {
  const r = checkWorkspaceClosure(KERNEL_ROOT)
  assert.deepEqual(r.problems, [])
  // The three images the 2026-10-29 defect (and its sibling) touched must be among the ones examined.
  assert.ok(r.workspaceDockerfiles >= 3, `only ${r.workspaceDockerfiles} workspace Dockerfile(s) examined`)
  const files = findDockerfiles(KERNEL_ROOT)
  for (const f of ['services/kernel-api/Dockerfile', 'modules/board/Dockerfile', 'gremion-ui/Dockerfile']) assert.ok(files.includes(f), f)
})
