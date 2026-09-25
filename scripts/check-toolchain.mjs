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

// First-party `@ts-nocheck` files explicitly allowed, path -> reason. These
// five scripts under gremion-ui/scripts/ are cross-owned by TASK-032 (app
// source, out of this task's file ownership — see brief §3), so their
// @ts-nocheck cannot be removed here; each is recorded with the reason
// already carried in the file's own header. install-git-hooks.mjs is the one
// that matters most: its own header says it is pulled into the svelte-check
// program by a unit-test import, so its @ts-nocheck is a real escape inside a
// typechecked program, not dead code — recorded as a residual for TASK-032,
// not silently unguarded (verifier MEDIUM finding 5).
export const ALLOWED_FIRST_PARTY_TS_NOCHECK = {
  'gremion-ui/scripts/check-app-port-binding.mjs': 'standalone node build script (CLI-invoked, not TS-typed); owned by TASK-032 (gremion-ui/**) — residual recorded by TASK-017, not fixed here',
  'gremion-ui/scripts/check-domain-regex.mjs': 'standalone node build script (CLI-invoked, not TS-typed); owned by TASK-032 (gremion-ui/**) — residual recorded by TASK-017, not fixed here',
  'gremion-ui/scripts/check-tenant-env-guard.mjs': 'standalone node build script (invoked via the CLI, not TS-typed); owned by TASK-032 (gremion-ui/**) — residual recorded by TASK-017, not fixed here',
  'gremion-ui/scripts/check-tenant-secrets-dir.mjs': 'standalone node build script (CLI-invoked, not TS-typed); owned by TASK-032 (gremion-ui/**) — residual recorded by TASK-017, not fixed here',
  'gremion-ui/scripts/install-git-hooks.mjs': 'standalone node build script imported by a unit test, which pulls it into the svelte-check (checkJs+strict) program — a real escape, not dead code; owned by TASK-032 (gremion-ui/**) — residual recorded by TASK-017, not fixed here',
}

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

// Matches a Dockerfile FROM line naming a node base image: an optional
// --platform=... flag, an optional registry/namespace prefix (docker.io/,
// docker.io/library/, ghcr.io/org/, ...), then "node:<tag>". The tag is
// captured whole so the caller can tell a literal major ("26", "26-alpine")
// from a non-literal one (a build ARG like "${NODE_MAJOR}-alpine") — the
// latter must be flagged, not silently skipped (verifier LOW finding 6).
const FROM_NODE_RE = /^FROM\s+(?:--platform=\S+\s+)?(?:[\w.-]+\/)*node:(\S+)/gm

/** True when the Dockerfile text has at least one node: FROM line (any stage). */
export function hasNodeFromLine(text) {
  return [...text.matchAll(FROM_NODE_RE)].length > 0
}

/** @param files [{path, text}] tracked Dockerfiles with at least one node: FROM line */
export function checkNodeMajorDockerfiles(files) {
  if (files.length === 0) {
    return ['found zero first-party Dockerfiles with a node: base — the node-major check would pass vacuously']
  }
  const problems = []
  for (const f of files) {
    let any = false
    for (const m of f.text.matchAll(FROM_NODE_RE)) {
      any = true
      const tag = m[1]
      const majorMatch = /^(\d+)/.exec(tag)
      if (!majorMatch) {
        problems.push(`${f.path}: FROM node:${tag} — non-literal or unparseable tag, cannot verify it names major ${NODE_MAJOR}`)
      } else if (Number(majorMatch[1]) !== NODE_MAJOR) {
        problems.push(`${f.path}: FROM node:${majorMatch[1]} (expected node:${NODE_MAJOR})`)
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

/**
 * strictDepBuilds is engineStrict's sibling for the OTHER install-time
 * safety net: without it, an unlisted dependency build script is only a
 * warning box ("Ignored build scripts: ...") and `pnpm install` exits 0 — the
 * exact silent skip TRD-402 forbids. Watched empirically: removing this key
 * from pnpm-workspace.yaml with msw unlisted leaves a fresh
 * `pnpm install --frozen-lockfile` at exit 0 (verifier MEDIUM finding 3).
 * @param workspaceYamlText the raw pnpm-workspace.yaml text
 */
export function checkStrictDepBuildsOn(workspaceYamlText) {
  const problems = []
  if (!/^strictDepBuilds:\s*true\s*$/m.test(workspaceYamlText)) {
    problems.push('pnpm-workspace.yaml does not set "strictDepBuilds: true" at the workspace root — ' +
      'without it an unlisted dependency build script only warns and the install exits 0')
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

const TS_NOCHECK_RE = /@ts-nocheck\b/
const TS_IGNORE_RE = /@ts-ignore\b/
const TS_EXPECT_ERROR_RE = /@ts-expect-error\b/

/**
 * Resolve a tsconfig's relative `extends` value against its own repo-relative
 * path, POSIX-style (repo paths always use "/"). Returns null for a
 * non-relative extends (a package name, e.g. "@tsconfig/svelte") — those are
 * never first-party and are never trusted for strict, same as a generated
 * .svelte-kit/tsconfig.json that happens not to be in the scanned set.
 */
export function resolveExtendsPath(fromPath, extendsValue) {
  if (!extendsValue || !(extendsValue.startsWith('./') || extendsValue.startsWith('../'))) return null
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '.'
  const parts = (fromDir === '.' ? [] : fromDir.split('/')).concat(extendsValue.split('/'))
  const stack = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/**
 * @param tsconfigs [{path, text}] first-party tsconfig*.json files
 *
 * `extends` alone is never proof of strict: a tsconfig that sets no
 * "strict": true itself is accepted ONLY when its `extends` resolves to
 * another tsconfig IN THIS SAME SCANNED SET that is itself (transitively)
 * strict:true — e.g. packages/db/tsconfig.build.json extending its sibling
 * tsconfig.json. A generated file (.svelte-kit/tsconfig.json — absent in a
 * clean clone, never tracked) or a third-party package extend is never in
 * the scanned set, so it can never satisfy this — closing the escape where
 * gremion-ui/tsconfig.json could drop "strict": true and rely solely on
 * extending .svelte-kit/tsconfig.json, which sets no strict of its own
 * (verifier HIGH finding 2).
 */
export function checkStrictTsconfigs(tsconfigs) {
  if (tsconfigs.length === 0) {
    return ['found zero first-party tsconfig*.json files — the strict-TS check would pass vacuously']
  }
  const problems = []
  const parsed = new Map()
  for (const { path, text } of tsconfigs) {
    try {
      // tsconfig.json commonly carries // comments; strip them for JSON.parse
      // the same way tsc's own JSONC reader tolerates them, without pulling in
      // a JSONC dependency for one field read.
      const stripped = text.replace(/^\s*\/\/.*$/gm, '')
      parsed.set(path, JSON.parse(stripped))
    } catch (e) {
      problems.push(`${path}: not parseable as JSON(C): ${e.message}`)
    }
  }

  function isEffectivelyStrict(path, seen) {
    if (seen.has(path)) return false // extends cycle: never trust it
    seen.add(path)
    const json = parsed.get(path)
    if (!json) return false
    const co = json.compilerOptions ?? {}
    if (co.strict === true) return true
    if (co.strict === false) return false
    if (typeof json.extends === 'string') {
      const resolved = resolveExtendsPath(path, json.extends)
      if (resolved && parsed.has(resolved)) return isEffectivelyStrict(resolved, seen)
    }
    return false
  }

  for (const [path, json] of parsed) {
    const co = json.compilerOptions ?? {}
    if (co.strict === false) {
      problems.push(`${path}: sets "strict": false`)
      continue
    }
    if (co.noImplicitAny === false) problems.push(`${path}: sets "noImplicitAny": false`)
    if (co.strict === true) continue
    if (typeof json.extends === 'string') {
      const resolved = resolveExtendsPath(path, json.extends)
      if (resolved && parsed.has(resolved) && isEffectivelyStrict(resolved, new Set())) continue
      problems.push(
        `${path}: does not set "strict": true, and its "extends" (${json.extends}) is not a ` +
        'first-party strict tsconfig in the scanned set — a generated (e.g. .svelte-kit) or ' +
        'third-party base is never trusted for strict',
      )
      continue
    }
    problems.push(`${path}: does not set "strict": true and extends nothing that could set it`)
  }
  return problems
}

/**
 * @param files [{path, text}] first-party TS/Svelte/JS source files — .js,
 *   .mjs, .cjs, .mts and .cts are scanned alongside .ts/.svelte/.tsx because
 *   a first-party build script can be pulled into a typechecked program
 *   (checkJs) by a plain import, same as a .ts file (verifier MEDIUM
 *   finding 5)
 * @param allowlist {path: reason} — a first-party file whose @ts-nocheck is
 *   recorded here with a non-empty reason is not flagged for it (still
 *   flagged for @ts-ignore/@ts-expect-error on any other line); defaults to
 *   ALLOWED_FIRST_PARTY_TS_NOCHECK
 */
export function checkNoSuppressionDirectives(files, allowlist = ALLOWED_FIRST_PARTY_TS_NOCHECK) {
  if (files.length === 0) {
    return ['found zero first-party TS/Svelte/JS source files — the suppression-directive check would pass vacuously']
  }
  const problems = []
  for (const { path, text } of files) {
    const isTest = /\.test\.ts$/.test(path)
    const nocheckReason = allowlist[path]
    const nocheckAllowed = typeof nocheckReason === 'string' && nocheckReason.trim() !== ''
    text.split('\n').forEach((line, i) => {
      if (TS_IGNORE_RE.test(line)) {
        problems.push(`${path}:${i + 1}: banned suppression directive (@ts-ignore) — use a real type or, in a test only, @ts-expect-error`)
      }
      if (TS_NOCHECK_RE.test(line) && !nocheckAllowed) {
        problems.push(`${path}:${i + 1}: banned suppression directive (@ts-nocheck) — use a real type, or add a non-empty reason to ALLOWED_FIRST_PARTY_TS_NOCHECK`)
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

  // Every tracked Dockerfile (any "Dockerfile" or "*.Dockerfile" basename),
  // kept only when it actually names a node: base image — docker/legal,
  // docker/vector and docker/fallback are third-party base images (nginx,
  // vector, debian) this unit does not own and that never match FROM_NODE_RE,
  // so they fall out on their own. This also covers a future first-party
  // Dockerfile under services/* or modules/* without a hardcoded path list
  // (verifier LOW finding 6).
  const DOCKERFILE_NAME_RE = /(^|\/)([^/]*\.)?Dockerfile$/
  const dockerfiles = [...tracked]
    .filter((p) => DOCKERFILE_NAME_RE.test(p))
    .map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') }))
    .filter((f) => hasNodeFromLine(f.text))

  const nodeVersionFiles = NODE_VERSION_FILES
    .filter((f) => existsSync(join(root, f)))
    .map((f) => ({ path: f, text: readFileSync(join(root, f), 'utf8') }))

  const packageJsons = allDirs
    .map((d) => join(d, 'package.json'))
    .filter((p) => tracked.has(p.split(sep).join('/')) || existsSync(join(root, p)))
    .map((p) => ({ path: p.split(sep).join('/'), json: readJson(join(root, p)) }))

  // tsconfig*.json, not just the two names in use today, so a future
  // tsconfig.test.json etc. is covered without touching this file (verifier
  // LOW finding 7). Only the package's own top-level tsconfig*.json — not
  // nested ones (e.g. inside src/) — matching resolvePackageDirs' own scope.
  const tsconfigs = []
  for (const d of packageDirs) {
    const dirAbs = join(root, d === '.' ? '' : d)
    if (!existsSync(dirAbs)) continue
    for (const name of readdirSync(dirAbs)) {
      if (!/^tsconfig.*\.json$/.test(name)) continue
      const abs = join(dirAbs, name)
      if (!statSync(abs).isFile()) continue
      const rel = (d === '.' ? name : `${d}/${name}`)
      tsconfigs.push({ path: rel, text: readFileSync(abs, 'utf8') })
    }
  }

  const srcFiles = [...tracked]
    .filter((p) => allDirs.some((d) => d !== '.' && (p === `${d}` || p.startsWith(`${d}/`))))
    .filter((p) => /\.(ts|tsx|svelte|js|mjs|cjs|mts|cts)$/.test(p))
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
    ...checkStrictDepBuildsOn(state.workspaceYamlText),
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
