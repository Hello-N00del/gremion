// Guard: a host program the cd stage installs must source nothing the stage does not install.
//
// WHY. `bootstrap.sh cd` copies bin/*, lib/common.sh and lib/cd/*.sh to <root>. A program of bin/
// that sources `$SCRIPT_DIR/../lib/customer-ops.sh` finds that file in a source checkout and finds
// NOTHING on a host, because the install never copied it. The gates stage of a release ran the
// installed gremion-isolation, so on a host every release failed the isolation gate on a missing
// file, and no test of the repository could see it: every test of those programs runs them from the
// tree. This file walks the sourced files the way the host sees them.
//
// THE RULE it pins. A program the stage installs resolves every `.` / `source` of a path built from
// SCRIPT_DIR or a lib directory, transitively, to a file the same stage installs. A program that
// needs the release's own libraries (customer-ops.sh and what that pulls in) is NOT installed: it
// is listed in CD_TREE_RUN_PROGRAMS of bootstrap.sh and runs from the release tree, where program,
// libraries and the code under test are one commit. The programs of lib/cd name installed programs
// only through the install root (`<root>/bin/<name>`); one that names a tree-run program that way
// would call a file the stage does not put there.
//
// A source expression the walker cannot resolve FAILS, it is never skipped: a scan that reaches
// nothing reports clean. The canary tests prove the walker still fires.
//
// Collection. unit:node counts the declared tests of a file by the lines that start with the word
// `test` and an opening bracket: every test below is a plain call at the start of a line.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOST = 'infra/host'
const BOOTSTRAP = `${HOST}/bootstrap.sh`

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

function filesOf(glob) {
  return globSync(glob, { cwd: ROOT })
    .map((f) => f.split(path.sep).join('/'))
    .toSorted((a, b) => a.localeCompare(b))
}

// The programs bootstrap.sh does not install: CD_TREE_RUN_PROGRAMS=( ... ). Absent array = none.
export function treeRunPrograms(bootstrapText) {
  const m = /^CD_TREE_RUN_PROGRAMS=\(([^)]*)\)/m.exec(bootstrapText)
  if (m === null) return []
  return m[1]
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .join(' ')
    .split(/\s+/)
    .filter((w) => w !== '')
}

// What stage_cd installs, as repo paths: every file of bin/ but the tree-run programs,
// lib/common.sh, every lib/cd/*.sh. The stage text is pinned below, so this model cannot drift.
export function installedSet(bootstrapText) {
  const skip = new Set(treeRunPrograms(bootstrapText))
  const set = new Set()
  for (const f of filesOf(`${HOST}/bin/*`)) {
    if (!skip.has(f.slice(`${HOST}/bin/`.length))) set.add(f)
  }
  set.add(`${HOST}/lib/common.sh`)
  for (const f of filesOf(`${HOST}/lib/cd/*.sh`)) set.add(f)
  return set
}

// The source statements of a shell file: [{ line, arg }], comments and here-doc free enough for
// these programs (a statement is a line that starts with `.` or `source` and a space).
export function sourceStatements(text) {
  const out = []
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*(?:\.|source)\s+(\S.*?)\s*(?:#.*)?$/.exec(raw)
    if (m === null || raw.trim().startsWith('#')) return
    out.push({ line: i + 1, arg: m[1].replace(/^["']|["']$/g, '') })
  })
  return out
}

// Resolve one source argument written in `file` to repo paths, or null when it is not a form the
// walker knows. The known forms are the ones the host programs use; a new form must be added here
// on purpose, with its meaning, or the guard fails.
//   kind 'file'   the files that must exist where the program runs
//   kind 'glob'   a library name found by a glob of lib/cd (the stage installs the whole glob)
//   kind 'test'   the test hook of gremion-cd, read only with GREMION_CD_TESTING=1
//   kind 'release' a path under the release tree the program is given at run time
export function resolveSource(arg, file) {
  let m
  if ((m = /^\$\{?SCRIPT_DIR\}?\/\.\.\/lib\/(.+)$/.exec(arg))) {
    return { kind: 'file', targets: [`${HOST}/lib/${m[1]}`] }
  }
  if ((m = /^\$\{?SCRIPT_DIR\}?\/([^/$]+)$/.exec(arg))) {
    return { kind: 'file', targets: [`${HOST}/bin/${m[1]}`] }
  }
  if (file === `${HOST}/bin/gremion-cd`) {
    if ((m = /^\$CD_LIB_DIR\/([a-z-]+\.sh)$/.exec(arg))) return { kind: 'file', targets: [`${HOST}/lib/cd/${m[1]}`] }
    if (arg === '$CD_LIB_DIR/${cd_lib_name}.sh') return { kind: 'glob', targets: [] }
    if (arg === '${GREMION_CD_STUBS_DIR}/cd-stubs.sh') return { kind: 'test', targets: [] }
  }
  if (file === `${HOST}/bin/gremion-executor` && (m = /^\$\{lib\}\/(.+)$/.exec(arg))) {
    return { kind: 'release', targets: [`${HOST}/lib/${m[1]}`] }
  }
  if (file === `${HOST}/lib/executor/registry.sh` && (m = /^\$\{EXECUTOR_LIB_DIR\}\/(.+)$/.exec(arg))) {
    return { kind: 'release', targets: [`${HOST}/lib/executor/${m[1]}`] }
  }
  return null
}

// Walk the installed set. Returns the list of problems, each one naming the file.
//   readFile(rel) -> text or null; exists(rel) -> bool; installed -> Set of repo paths
export function walk({ installed, readFile, exists }) {
  const problems = []
  let seen = 0
  const releaseQueue = []
  for (const file of [...installed].toSorted((a, b) => a.localeCompare(b))) {
    const text = readFile(file)
    if (text === null) {
      problems.push(`${file}: installed but not readable`)
      continue
    }
    for (const { line, arg } of sourceStatements(text)) {
      seen += 1
      const r = resolveSource(arg, file)
      if (r === null) {
        problems.push(`${file}:${line}: cannot resolve the source expression ${arg} (add the form to the walker on purpose)`)
        continue
      }
      if (r.kind === 'file') {
        for (const t of r.targets) {
          if (!installed.has(t)) {
            problems.push(`${file}:${line}: sources ${t.slice(`${HOST}/`.length)}, which the cd stage does not install`)
          }
        }
      }
      if (r.kind === 'release') {
        for (const t of r.targets) {
          if (!exists(t)) problems.push(`${file}:${line}: the release does not carry ${t}`)
          else releaseQueue.push(t)
        }
      }
    }
  }
  // the release-sourced closure is read from the tree: its own sources must resolve and exist there
  const done = new Set()
  while (releaseQueue.length > 0) {
    const file = releaseQueue.shift()
    if (done.has(file)) continue
    done.add(file)
    const text = readFile(file)
    if (text === null) continue
    for (const { line, arg } of sourceStatements(text)) {
      seen += 1
      const r = resolveSource(arg, file)
      if (r === null) {
        problems.push(`${file}:${line}: cannot resolve the source expression ${arg} (add the form to the walker on purpose)`)
        continue
      }
      for (const t of r.targets) {
        if (!exists(t)) problems.push(`${file}:${line}: ${t} is not in the release tree`)
        else releaseQueue.push(t)
      }
    }
  }
  return { problems, seen }
}

const realFs = {
  readFile: (rel) => (existsSync(path.join(ROOT, rel)) ? read(rel) : null),
  exists: (rel) => existsSync(path.join(ROOT, rel)),
}

test('every library an installed host program sources is installed by the same stage', () => {
  const installed = installedSet(read(BOOTSTRAP))
  const { problems, seen } = walk({ installed, ...realFs })
  assert.ok(seen >= 20, `the walker saw only ${seen} source statements: it is not reaching the programs`)
  assert.deepEqual(problems, [])
})

test('the programs of lib/cd name an installed program through the install root, never a tree-run one', () => {
  const treeRun = new Set(treeRunPrograms(read(BOOTSTRAP)))
  const bad = []
  let named = 0
  for (const file of filesOf(`${HOST}/lib/cd/*.sh`)) {
    read(file)
      .split('\n')
      .forEach((l, i) => {
        if (l.trim().startsWith('#')) return
        for (const m of l.matchAll(/(?<!infra\/host)\/bin\/(gremion-[a-z-]+)/g)) {
          named += 1
          const prog = m[1]
          if (treeRun.has(prog) || !existsSync(path.join(ROOT, HOST, 'bin', prog))) {
            bad.push(`${file}:${i + 1}: names <root>/bin/${prog}, which the cd stage does not install`)
          }
        }
      })
  }
  assert.ok(named >= 5, `only ${named} installed-program names found in lib/cd: the scan is not reaching them`)
  assert.deepEqual(bad, [])
})

test('the units run installed programs only: every ExecStart under the install root is a program the stage installs', () => {
  const installed = installedSet(read(BOOTSTRAP))
  const bad = []
  let n = 0
  for (const file of filesOf(`${HOST}/templates/systemd/*.service`)) {
    for (const m of read(file).matchAll(/^ExecStart=\$\{GREMION_ROOT\}\/bin\/(gremion-[a-z-]+)/gm)) {
      n += 1
      if (!installed.has(`${HOST}/bin/${m[1]}`)) bad.push(`${file}: runs <root>/bin/${m[1]}, which the cd stage does not install`)
    }
  }
  assert.ok(n >= 5, `only ${n} ExecStart lines found: the scan is not reaching the units`)
  assert.deepEqual(bad, [])
})

test('CD_TREE_RUN_PROGRAMS names real programs, each one really sources a library the stage does not install', () => {
  const text = read(BOOTSTRAP)
  const listed = treeRunPrograms(text)
  // an exemption nobody needs is a hole: a listed program must be one the walker would have refused
  const everything = installedSet(text.replace(/^CD_TREE_RUN_PROGRAMS=\([^)]*\)/m, 'CD_TREE_RUN_PROGRAMS=()'))
  const { problems } = walk({ installed: everything, ...realFs })
  const stale = []
  for (const prog of listed) {
    const file = `${HOST}/bin/${prog}`
    if (!existsSync(path.join(ROOT, file))) stale.push(`${prog}: no such program in infra/host/bin`)
    else if (!problems.some((p) => p.startsWith(`${file}:`))) stale.push(`${prog}: sources nothing the stage leaves out, so it needs no exemption`)
  }
  assert.deepEqual(stale, [])
})

test('canary: the walker refuses a program that sources a library nobody installs', () => {
  const files = new Map([
    [`${HOST}/bin/gremion-x`, '#!/usr/bin/env bash\nSCRIPT_DIR=x\n. "$SCRIPT_DIR/../lib/common.sh"\n. "$SCRIPT_DIR/../lib/customer-ops.sh"\n'],
    [`${HOST}/lib/common.sh`, '# no sources\n'],
  ])
  const installed = new Set([`${HOST}/bin/gremion-x`, `${HOST}/lib/common.sh`])
  const { problems } = walk({ installed, readFile: (r) => files.get(r) ?? null, exists: () => true })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /gremion-x:4: sources lib\/customer-ops\.sh, which the cd stage does not install/)
})

test('canary: an expression the walker does not know fails, it is not skipped', () => {
  const files = new Map([[`${HOST}/bin/gremion-x`, '. "${SOMEWHERE}/lib/other.sh"\nsource "$(dirname "$0")/y.sh"\n']])
  const installed = new Set([`${HOST}/bin/gremion-x`])
  const { problems } = walk({ installed, readFile: (r) => files.get(r) ?? null, exists: () => true })
  assert.equal(problems.length, 2)
  assert.match(problems[0], /cannot resolve the source expression/)
})

test('canary: a comment that mentions a source line is no statement, a sibling program resolves to bin/', () => {
  const text = '# . "$SCRIPT_DIR/../lib/customer-ops.sh"\n    . "${SCRIPT_DIR}/gremion-vendor-mail"\n'
  assert.deepEqual(sourceStatements(text), [{ line: 2, arg: '${SCRIPT_DIR}/gremion-vendor-mail' }])
  assert.deepEqual(resolveSource('${SCRIPT_DIR}/gremion-vendor-mail', `${HOST}/bin/gremion-mail`).targets, [`${HOST}/bin/gremion-vendor-mail`])
})

test('canary: the model of the stage is the stage - bootstrap.sh installs exactly bin/*, lib/common.sh and lib/cd/*.sh', () => {
  const text = read(BOOTSTRAP)
  const start = text.indexOf('stage_cd() {')
  const stage = text.slice(start, text.indexOf('stage_harden_ssh() {', start))
  assert.match(stage, /for f in "\$sbin"\/\*; do/)
  assert.match(stage, /install_cd_file 0644 "\$dep" "\$slib\/common\.sh" "\$\{root\}\/lib\/common\.sh"/)
  assert.match(stage, /for f in "\$slib"\/cd\/\*\.sh; do/)
  const installs = [...stage.matchAll(/install_cd_file \S+ \S+ "[^"]+" "\$\{root\}\/([^"]+)"/g)].map((m) => m[1])
  // the only destinations: bin/<file>, lib/common.sh, lib/cd/<file>, etc/cd.env
  for (const dest of installs) assert.match(dest, /^(bin\/|lib\/common\.sh$|lib\/cd\/|etc\/cd\.env$)/, `unmodelled install destination ${dest}`)
})
