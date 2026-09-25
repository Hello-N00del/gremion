// Tests for ops/scripts/helios-submodule-check.sh (TASK-005, TRD-268).
//
// Run:  node --test ops/scripts/helios-submodule-check.test.mjs
//
// Every case builds a throwaway superproject with a real gitlink (mode 160000)
// pointing at a commit of a throwaway "helios" repository, then asserts the
// script's POST-CONDITION: its exit status AND the line it prints. An exit code
// alone is not evidence -- a script that exits 1 because it crashed would pass
// every negative case below.
//
// The fixture root defaults to os.tmpdir(). Set HELIOS_CHECK_TEST_TMP to put
// it somewhere else (the maintainer's Windows box needs this; tool calls that
// write under the user temp directory there are unreliable).
//
// The bash binary defaults to `bash` on PATH; set BASH_BIN to override (on
// Windows, make sure it is Git Bash and not the WSL launcher).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'helios-submodule-check.sh')
const BASH = process.env.BASH_BIN || 'bash'
const TMP_ROOT = process.env.HELIOS_CHECK_TEST_TMP || tmpdir()

const APACHE = `
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.
   (abridged fixture)
   END OF TERMS AND CONDITIONS
`
const MIT = `MIT License

Copyright (c) fixture

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software")...
`
const AGPL_TAIL = `
                    GNU AFFERO GENERAL PUBLIC LICENSE
                       Version 3, 19 November 2007
`

function makeEnv(root) {
  const cfg = join(root, 'gitconfig')
  writeFileSync(
    cfg,
    '[user]\n\tname = fixture\n\temail = fixture@example.invalid\n' +
      '[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n' +
      '[init]\n\tdefaultBranch = main\n',
  )
  return { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' }
}

function git(env, cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`)
  return r.stdout.trim()
}

// Build a superproject whose `helios-src` gitlink pins a commit carrying the
// given .python-version / LICENSE content (null = file absent). Returns the
// paths, the env, and a helper that commits another revision in the submodule.
function fixture({ python = '3.13\n', license = APACHE, licenseName = 'LICENSE' } = {}) {
  const root = mkdtempSync(join(TMP_ROOT, 'helios-check-'))
  const env = makeEnv(root)
  const superDir = join(root, 'super')
  const sub = join(superDir, 'helios-src')
  mkdirSync(sub, { recursive: true })
  git(env, superDir, 'init', '-q')
  git(env, sub, 'init', '-q')

  const commitSub = (py, lic, name = 'LICENSE') => {
    for (const f of ['.python-version', 'LICENSE', 'LICENSE.txt']) {
      rmSync(join(sub, f), { force: true })
    }
    if (py !== null) writeFileSync(join(sub, '.python-version'), py)
    if (lic !== null) writeFileSync(join(sub, name), lic)
    writeFileSync(join(sub, 'marker'), String(Math.random()))
    git(env, sub, 'add', '-A')
    git(env, sub, 'commit', '-q', '-m', 'fixture')
    return git(env, sub, 'rev-parse', 'HEAD')
  }
  const pin = (sha) => git(env, superDir, 'update-index', '--add', '--cacheinfo', `160000,${sha},helios-src`)

  const sha = commitSub(python, license, licenseName)
  pin(sha)
  writeFileSync(join(superDir, 'README'), 'fixture superproject\n')
  git(env, superDir, 'add', 'README')
  git(env, superDir, 'commit', '-q', '-m', 'pin helios')
  return { root, env, superDir, sub, sha, commitSub, pin }
}

function run(fx, ...args) {
  const r = spawnSync(BASH, [SCRIPT, '--repo', fx.superDir, ...args], { env: fx.env, encoding: 'utf8' })
  if (r.error) throw r.error
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}

function cleanup(fx) {
  rmSync(fx.root, { recursive: true, force: true })
}

test('passes a pin with Python 3.13 and an Apache-2.0 LICENSE, and records the commit', () => {
  const fx = fixture()
  try {
    const r = run(fx)
    assert.equal(r.status, 0, r.all)
    assert.match(r.out, new RegExp(`PASS commit=${fx.sha} python=3\\.13 licence=Apache-2\\.0`))
  } finally {
    cleanup(fx)
  }
})

test('accepts a later 3.x patch version (3.14.1) and a CRLF file', () => {
  const fx = fixture({ python: '3.14.1\r\n' })
  try {
    const r = run(fx)
    assert.equal(r.status, 0, r.all)
    assert.match(r.out, /python=3\.14\.1 /)
  } finally {
    cleanup(fx)
  }
})

test('fails a pin whose .python-version is below 3.13', () => {
  const fx = fixture({ python: '3.12\n' })
  try {
    const r = run(fx)
    assert.equal(r.status, 1, r.all)
    assert.match(r.err, /FAIL .*python.*3\.12.*below 3\.13/i)
  } finally {
    cleanup(fx)
  }
})

test('fails a pin with no .python-version', () => {
  const fx = fixture({ python: null })
  try {
    const r = run(fx)
    assert.equal(r.status, 1, r.all)
    assert.match(r.err, /FAIL .*\.python-version.*missing/i)
  } finally {
    cleanup(fx)
  }
})

test('fails a .python-version it cannot parse (fail closed)', () => {
  const fx = fixture({ python: 'system\n' })
  try {
    const r = run(fx)
    assert.equal(r.status, 1, r.all)
    assert.match(r.err, /FAIL .*unrecognised/i)
  } finally {
    cleanup(fx)
  }
})

test('fails a pin whose LICENSE is not Apache-2.0', () => {
  const fx = fixture({ license: MIT })
  try {
    const r = run(fx)
    assert.equal(r.status, 1, r.all)
    assert.match(r.err, /FAIL .*LICENSE.*not Apache-2\.0/i)
  } finally {
    cleanup(fx)
  }
})

test('fails a LICENSE that adds other terms to the Apache text', () => {
  const fx = fixture({ license: APACHE + AGPL_TAIL })
  try {
    const r = run(fx)
    assert.equal(r.status, 1, r.all)
    assert.match(r.err, /FAIL .*LICENSE.*GNU AFFERO/i)
  } finally {
    cleanup(fx)
  }
})

test('fails a pin with no LICENSE file at all', () => {
  const fx = fixture({ license: null })
  try {
    const r = run(fx)
    assert.equal(r.status, 1, r.all)
    assert.match(r.err, /FAIL .*LICENSE.*missing/i)
  } finally {
    cleanup(fx)
  }
})

test('reads the PINNED commit, not the submodule working tree', () => {
  // Pin a good commit, then move the submodule checkout to a bad one.
  const fx = fixture()
  try {
    fx.commitSub('3.11\n', MIT)
    const r = run(fx)
    assert.equal(r.status, 0, r.all)
    assert.match(r.out, new RegExp(`commit=${fx.sha}`))
  } finally {
    cleanup(fx)
  }
})

test('a staged bump to a bad commit fails by default; --rev HEAD still checks the committed pin', () => {
  const fx = fixture()
  try {
    const bad = fx.commitSub('3.12\n', APACHE)
    fx.pin(bad)
    const staged = run(fx)
    assert.equal(staged.status, 1, staged.all)
    assert.match(staged.err, new RegExp(`commit=${bad}`))
    const head = run(fx, '--rev', 'HEAD')
    assert.equal(head.status, 0, head.all)
    assert.match(head.out, new RegExp(`commit=${fx.sha}`))
  } finally {
    cleanup(fx)
  }
})

test('fails when the pinned commit is not present in the submodule (not fetched)', () => {
  const fx = fixture()
  try {
    fx.pin('0123456789abcdef0123456789abcdef01234567')
    const r = run(fx)
    assert.equal(r.status, 2, r.all)
    assert.match(r.err, /ERROR .*0123456789abcdef0123456789abcdef01234567.*not present/i)
  } finally {
    cleanup(fx)
  }
})

test('fails when the submodule is not initialised', () => {
  const fx = fixture()
  try {
    rmSync(fx.sub, { recursive: true, force: true })
    const r = run(fx)
    assert.equal(r.status, 2, r.all)
    assert.match(r.err, /ERROR .*not initialised/i)
  } finally {
    cleanup(fx)
  }
})

test('fails when the path is not a submodule gitlink', () => {
  const fx = fixture()
  try {
    const r = run(fx, '--path', 'README')
    assert.equal(r.status, 2, r.all)
    assert.match(r.err, /ERROR .*README.*not a submodule gitlink/i)
  } finally {
    cleanup(fx)
  }
})

test('rejects an unknown argument with a usage error', () => {
  const fx = fixture()
  try {
    const r = run(fx, '--bogus')
    assert.equal(r.status, 2, r.all)
    assert.match(r.err, /usage/i)
  } finally {
    cleanup(fx)
  }
})
