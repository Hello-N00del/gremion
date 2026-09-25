#!/usr/bin/env node
// Toolchain re-init guard — TASK-017 (L2-01), TRD-400/401/402.
//
// Pattern copied from scripts/check-postgres-major.mjs / check-cve-floors.mjs:
// pure functions over file text (so the test suite can plant RED cases without
// touching the working tree), a CLI entrypoint that scans the real repo, and a
// refusal to pass vacuously on an empty discovery set.
//
// Four independent post-conditions, each with its own EMPTY-SET guard:
//   1. node-major   — every Node version surface (.node-version/.nvmrc,
//                      engines.node, every first-party Dockerfile FROM) names
//                      the one pinned major.
//   2. allow-list    — pnpm-workspace.yaml's onlyBuiltDependencies is EXACTLY
//                      the set this file's own {name: reason} table names —
//                      no allowance without a reason, no reason without an
//                      allowance — and every allowed name is actually resolved
//                      in the lockfile (a stale allowance is a finding).
//   3. lifecycle     — no first-party package.json carries an unlisted
//                      preinstall/install/postinstall/prepare script. pnpm's
//                      own allow-list (#2) covers DEPENDENCIES only; this is
//                      the first-party half.
//   4. strict-ts     — every first-party tsconfig*.json sets strict: true,
//                      none sets strict:false / noImplicitAny:false, and no
//                      first-party source carries @ts-nocheck or a bare
//                      @ts-ignore (@ts-expect-error is allowed only in
//                      *.test.ts, per Q2).
//
// Run:  node scripts/check-toolchain.mjs
// Test: node --test scripts/check-toolchain.test.mjs

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── the pin ──────────────────────────────────────────────────────────────
// TRD-401 [D R19-D34]: Node 26 everywhere; another major fails `verify`.
export const NODE_MAJOR = 26
export const NODE_ENGINE_RANGE = `>=${NODE_MAJOR} <${NODE_MAJOR + 1}`
export const NODE_VERSION_FILES = ['.node-version', '.nvmrc']

// ── TRD-402 [D R19-D1]: the allow-list, Q3's machine-checked table ────────
// Every entry here is a DEPENDENCY build script pnpm would otherwise skip
// under strictDepBuilds. Each reason is why running it is safe — read it
// before adding a third entry.
export const ALLOWED_BUILD_DEPS = {
  esbuild: 'native binary downloader (install.js) fetches the platform-matched ' +
    'esbuild executable; dev/build-only, esbuild is never a runtime dependency ' +
    'of either shipped image',
  msw: 'postinstall registers the browser Service Worker script used by mock ' +
    'network interception in tests only; no native code, dev-only dependency',
}

// The keys pnpm's own lifecycle covers for a DEPENDENCY. First-party packages
// are checked separately below — pnpm's onlyBuiltDependencies allow-list does
// not reach them at all (it gates postinstall on packages under node_modules
// with a "hasInstallScript" flag from their own manifest, never the workspace
// member's own package.json).
export const LIFECYCLE_KEYS = ['preinstall', 'install', 'postinstall', 'prepare']

// First-party lifecycle scripts explicitly allowed, name -> reason. Empty
// today: no first-party package.json needs one. A future addition must be
// listed here with a reason, exactly like the dependency table above.
export const ALLOWED_FIRST_PARTY_LIFECYCLE = {}

// pnpm 10.33 keys that control which dependency build scripts run. A root
// package.json `pnpm` field carrying any of these takes PRIORITY over
// pnpm-workspace.yaml's onlyBuiltDependencies for install purposes — watched
// empirically: with msw removed from the yaml list and
// `"pnpm":{"onlyBuiltDependencies":["msw"]}` in package.json, the yaml list
// was ignored and the install failed naming esbuild instead; with all four
// deps allowed under package.json's `pnpm` field, the install and the old
// guard both stayed green with zero recorded reasons (verifier HIGH
// finding 1). This is a second, unreasoned allow-list surface the guard
// must close.
const PNPM_BUILD_CONTROL_KEY_RE = /Built/

/** @param rootPackageJson the parsed root package.json */
export function checkPackageJsonPnpmBuildControl(rootPackageJson) {
  const pnpmField = rootPackageJson?.pnpm
  if (!pnpmField || typeof pnpmField !== 'object') return []
  const problems = []
  for (const key of Object.keys(pnpmField)) {
    if (PNPM_BUILD_CONTROL_KEY_RE.test(key) || key === 'dangerouslyAllowAllBuilds') {
      problems.push(
        `root package.json sets "pnpm.${key}" — pnpm 10.33 gives this priority over ` +
        'pnpm-workspace.yaml\'s onlyBuiltDependencies allow-list (Q3), so it can silently ' +
        'bypass the reasoned allow-list this guard enforces there; remove it, or move the ' +
        'allowance into pnpm-workspace.yaml\'s onlyBuiltDependencies with a reason in ' +
        'ALLOWED_BUILD_DEPS',
      )
    }
  }
  return problems
}

// ── node-major ──────────────────────────────────────────────────────────

const FROM_NODE_RE = /^FROM\s+node:(\d+)(?:[.\w-]*)?\b/gm

/** @param files [{path, text}] tracked Dockerfiles (first-party only) */
export function checkNodeMajorDockerfiles(files) {
  if (files.length === 0) {
    return ['found zero first-party Dockerfiles with a node: base — the node-major check would pass vacuously']
  }
  const problems = []
  for (const f of files) {
    let any = false
    for (const m of f.text.matchAll(FROM_NODE_RE)) {
      any = true
      if (Number(m[1]) !== NODE_MAJOR) {
        problems.push(`${f.path}: FROM node:${m[1]} (expected node:${NODE_MAJOR})`)
      }
    }
    if (!any) problems.push(`${f.path}: no "FROM node:<major>" line found — cannot verify its Node major`)
  }
  return problems
}

export function checkNodeVersionFiles(files) {
  // files: [{path, text}] for .node-version and .nvmrc
  if (files.length === 0) {
    return [`found neither ${NODE_VERSION_FILES.join(' nor ')} — the node-version check would pass vacuously`]
  }
  const problems = []
  for (const f of files) {
    const v = f.text.trim()
    if (v !== String(NODE_MAJOR)) {
      problems.push(`${f.path}: pins "${v}" (expected "${NODE_MAJOR}")`)
    }
  }
  return problems
}

/** @param rootPackageJson the parsed root package.json */
export function checkEnginesNode(rootPackageJson) {
  const range = rootPackageJson?.engines?.node
  if (!range) return ['root package.json declares no engines.node — engine strictness has nothing to enforce']
  if (range !== NODE_ENGINE_RANGE) {
    return [`root package.json engines.node is "${range}" (expected "${NODE_ENGINE_RANGE}")`]
  }
  return []
}

/** @param workspaceYamlText the raw pnpm-workspace.yaml text */
export function checkEngineStrictOn(workspaceYamlText) {
  const problems = []
  if (!/^engineStrict:\s*true\s*$/m.test(workspaceYamlText)) {
    problems.push('pnpm-workspace.yaml does not set "engineStrict: true" at the workspace root — ' +
      'without it a mismatched engines.node is a warning, not a failed install')
  }
  return problems
}

// ── allow-list ──────────────────────────────────────────────────────────

/**
 * Parse a top-level YAML list block, e.g.:
 *   onlyBuiltDependencies:
 *     - esbuild
 *     - msw
 * Same idiom as check-cve-floors.mjs's parseOverrides: comments and blank
 * lines are skipped, the block ends at the first line not indented under it.
 */
export function parseYamlList(yamlText, key) {
  const lines = String(yamlText).split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l))
  if (start === -1) return null
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\s*#/.test(line)) continue
    const m = line.match(/^\s{2}-\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(?:#.*)?$/)
    if (!m) break
    out.push(m[1] ?? m[2] ?? m[3])
  }
  return out
}

/**
 * Set equality between pnpm-workspace.yaml's onlyBuiltDependencies and this
 * file's own reason table — the allowance and the reason must never drift
 * apart in either direction — plus a staleness check against the lockfile:
 * an allowance for a dependency that resolves NOWHERE in the tree is dead
 * weight the guard must reject (this is what catches better-sqlite3).
 *
 * @param workspaceYamlText raw pnpm-workspace.yaml text
 * @param lockText raw pnpm-lock.yaml text
 * @param table {name: reason} — defaults to ALLOWED_BUILD_DEPS
 */
export function checkAllowList(workspaceYamlText, lockText, table = ALLOWED_BUILD_DEPS) {
  const listed = parseYamlList(workspaceYamlText, 'onlyBuiltDependencies')
  if (listed === null) {
    return ['pnpm-workspace.yaml declares no onlyBuiltDependencies block']
  }
  const problems = []
  const listedSet = new Set(listed)
  const tableNames = Object.keys(table)
  const tableSet = new Set(tableNames)

  for (const name of listed) {
    if (!tableSet.has(name)) problems.push(`"${name}" is allowed in pnpm-workspace.yaml but has no reason in the allow-list table`)
  }
  for (const name of tableNames) {
    const reason = table[name]
    if (!reason || !String(reason).trim()) {
      problems.push(`"${name}" has an empty reason in the allow-list table`)
      continue
    }
    if (!listedSet.has(name)) problems.push(`"${name}" has a reason in the allow-list table but is not allowed in pnpm-workspace.yaml`)
  }
  for (const name of listed) {
    // A name is "resolved" if it appears as a top-level lockfile entry
    // (`  name@version:`), same shape check-cve-floors.mjs's resolvedVersions
    // uses for override absorption.
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^ {2}'?${esc}@`, 'm')
    if (!re.test(lockText)) {
      problems.push(`"${name}" is allowed in pnpm-workspace.yaml but does not resolve in pnpm-lock.yaml — stale allowance`)
    }
  }
  return problems
}

// ── first-party lifecycle scripts ──────────────────────────────────────

/**
 * @param packages [{path, json}] first-party package.json files (path is the
 *   package.json's own repo-relative path, used as the allow-list key)
 * @param allowlist {"path:script": reason}
 */
export function checkFirstPartyLifecycle(packages, allowlist = ALLOWED_FIRST_PARTY_LIFECYCLE) {
  if (packages.length === 0) {
    return ['found zero first-party package.json files — the lifecycle-script check would pass vacuously']
  }
  const problems = []
  for (const { path, json } of packages) {
    const scripts = json?.scripts ?? {}
    for (const key of LIFECYCLE_KEYS) {
      if (!(key in scripts)) continue
      const allowKey = `${path}:${key}`
      const reason = allowlist[allowKey]
      if (!reason || !String(reason).trim()) {
        problems.push(`${path} has an unlisted "${key}" lifecycle script: ${JSON.stringify(scripts[key])}`)
      }
    }
  }
  return problems
}

// ── strict TS ──────────────────────────────────────────────────────────

const BANNED_DIRECTIVE_RE = /@ts-nocheck\b|@ts-ignore\b/
const TS_EXPECT_ERROR_RE = /@ts-expect-error\b/

/** @param tsconfigs [{path, text}] */
export function checkStrictTsconfigs(tsconfigs) {
  if (tsconfigs.length === 0) {
    return ['found zero first-party tsconfig*.json files — the strict-TS check would pass vacuously']
  }
  const problems = []
  for (const { path, text } of tsconfigs) {
    let json
    try {
      // tsconfig.json commonly carries // comments; strip them for JSON.parse
      // the same way tsc's own JSONC reader tolerates them, without pulling in
      // a JSONC dependency for one field read.
      const stripped = text.replace(/^\s*\/\/.*$/gm, '')
      json = JSON.parse(stripped)
    } catch (e) {
      problems.push(`${path}: not parseable as JSON(C): ${e.message}`)
      continue
    }
    const co = json.compilerOptions ?? {}
    if (co.strict === false) problems.push(`${path}: sets "strict": false`)
    if (co.noImplicitAny === false) problems.push(`${path}: sets "noImplicitAny": false`)
    if (co.strict !== true && !('extends' in json)) {
      problems.push(`${path}: does not set "strict": true and extends nothing that could set it`)
    }
  }
  return problems
}

/** @param files [{path, text}] first-party .ts/.svelte source files */
export function checkNoSuppressionDirectives(files) {
  if (files.length === 0) {
    return ['found zero first-party TS/Svelte source files — the suppression-directive check would pass vacuously']
  }
  const problems = []
  for (const { path, text } of files) {
    const isTest = /\.test\.ts$/.test(path)
    text.split('\n').forEach((line, i) => {
      if (BANNED_DIRECTIVE_RE.test(line)) {
        problems.push(`${path}:${i + 1}: banned suppression directive (@ts-nocheck/@ts-ignore) — use a real type or, in a test only, @ts-expect-error`)
      }
      if (!isTest && TS_EXPECT_ERROR_RE.test(line)) {
        problems.push(`${path}:${i + 1}: @ts-expect-error outside a *.test.ts file (Q2: allowed only in tests)`)
      }
    })
  }
  return problems
}

// ── package discovery (pnpm-workspace.yaml globs) ─────────────────────

/**
 * Resolve the `packages:` glob list in pnpm-workspace.yaml into real,
 * existing directories, so a future services/* or modules/* addition is
 * covered without touching this file. Only a single trailing "/*" segment is
 * supported — that is the only shape the kernel's own workspace file uses.
 */
export function resolvePackageDirs(root, workspaceYamlText) {
  const list = parseYamlList(workspaceYamlText, 'packages') ?? []
  const dirs = new Set()
  for (const pattern of list) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2)
      const abs = join(root, prefix)
      if (!existsSync(abs)) continue
      for (const name of readdirSync(abs)) {
        if (statSync(join(abs, name)).isDirectory()) dirs.add(`${prefix}/${name}`)
      }
    } else {
      dirs.add(pattern)
    }
  }
  return [...dirs].filter((d) => existsSync(join(root, d, 'package.json')))
}

// ── CLI plumbing ────────────────────────────────────────────────────────

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

function trackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

/**
 * Build every input the checks above need from a real tree. Kept separate
 * from the check functions themselves so the test suite can call the checks
 * on synthetic fixtures without touching disk.
 */
export function gatherRepoState(root) {
  const tracked = new Set(trackedFiles(root))
  const workspaceYamlText = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const lockText = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  const rootPackageJson = readJson(join(root, 'package.json'))
  const packageDirs = resolvePackageDirs(root, workspaceYamlText)
  const allDirs = ['.', ...packageDirs]

  // First-party image Dockerfiles named by the acceptance, plus the host test
  // runner's — not every Dockerfile in the tree (docker/legal, docker/vector
  // are third-party base images this unit does not own).
  const FIRST_PARTY_DOCKERFILES = ['gremion-ui/Dockerfile', 'gremion-public/Dockerfile', 'test/host/runner/Dockerfile']
  const dockerfiles = FIRST_PARTY_DOCKERFILES
    .filter((p) => tracked.has(p))
    .map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') }))

  const nodeVersionFiles = NODE_VERSION_FILES
    .filter((f) => existsSync(join(root, f)))
    .map((f) => ({ path: f, text: readFileSync(join(root, f), 'utf8') }))

  const packageJsons = allDirs
    .map((d) => join(d, 'package.json'))
    .filter((p) => tracked.has(p.split(sep).join('/')) || existsSync(join(root, p)))
    .map((p) => ({ path: p.split(sep).join('/'), json: readJson(join(root, p)) }))

  const tsconfigs = []
  for (const d of packageDirs) {
    for (const name of ['tsconfig.json', 'tsconfig.build.json']) {
      const rel = (d === '.' ? name : `${d}/${name}`)
      const abs = join(root, rel)
      if (existsSync(abs)) tsconfigs.push({ path: rel, text: readFileSync(abs, 'utf8') })
    }
  }

  const srcFiles = [...tracked]
    .filter((p) => allDirs.some((d) => d !== '.' && (p === `${d}` || p.startsWith(`${d}/`))))
    .filter((p) => /\.(ts|svelte)$/.test(p))
    .filter((p) => !p.includes('/.svelte-kit/'))
    .map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') }))

  return {
    root, tracked, workspaceYamlText, lockText, rootPackageJson,
    packageDirs, dockerfiles, nodeVersionFiles, packageJsons, tsconfigs, srcFiles,
  }
}

export function runAllChecks(state) {
  return [
    ...checkNodeMajorDockerfiles(state.dockerfiles),
    ...checkNodeVersionFiles(state.nodeVersionFiles),
    ...checkEnginesNode(state.rootPackageJson),
    ...checkEngineStrictOn(state.workspaceYamlText),
    ...checkAllowList(state.workspaceYamlText, state.lockText),
    ...checkPackageJsonPnpmBuildControl(state.rootPackageJson),
    ...checkFirstPartyLifecycle(state.packageJsons),
    ...checkStrictTsconfigs(state.tsconfigs),
    ...checkNoSuppressionDirectives(state.srcFiles),
  ]
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const state = gatherRepoState(ROOT)
  const problems = runAllChecks(state)
  if (problems.length > 0) {
    console.error(`[toolchain] ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(
    `[toolchain] OK — Node ${NODE_MAJOR} pinned in ${state.nodeVersionFiles.length} version file(s) + ` +
    `${state.dockerfiles.length} Dockerfile(s) + engines.node; ${state.packageDirs.length} package(s) ` +
    `scanned for lifecycle scripts and strict TS across ${state.tsconfigs.length} tsconfig(s) and ` +
    `${state.srcFiles.length} source file(s).`,
  )
}
