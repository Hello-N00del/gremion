#!/usr/bin/env node
// Every path a workspace package's manifest NAMES must still be there once the
// package has been packed.
//
// WHY THIS EXISTS. `files` in a package.json is usually read as "what npm
// publish sends". It is not only that: pnpm applies the same allowlist when it
// PACKS A WORKSPACE DEPENDENCY, which is what `pnpm deploy` does — and
// `pnpm deploy --prod --legacy` is how both runtime Dockerfiles assemble
// /app/node_modules. So narrowing `files` to `["dist", …]` for publishing also
// narrows what lands in the shipped image, and `dist/` is gitignored and never
// built during a Docker build (`prepack` does not run for `deploy`). The
// workspace packages went into the image as three files — LICENSE, README.md,
// package.json — with an `exports` map still pointing at `./src/index.ts`.
//
// Nothing noticed. It is not a boot break TODAY only because both vite configs
// list @gremion/db and @gremion/ports in `ssr.noExternal`, so every import is
// inlined into build/ and the package is never resolved at runtime. Drop that
// setting, or add one dynamic import, and it is ERR_MODULE_NOT_FOUND on boot.
//
// TWO MODES, ONE RULE — the rule lives here, not in the workflows:
//
//   --static            Cheap. Reads packages/<pkg>/package.json and asserts
//                       every path its `exports`/`main`/`types` name (a) exists
//                       in the tree and (b) survives that package's own `files`
//                       allowlist. Runs on every CI run, no install needed.
//
//   --deploy <dir>      The real post-condition. Takes the output of a
//                       `pnpm --filter <app> deploy` and asserts every path the
//                       DEPLOYED manifest names is present on disk in the
//                       payload — the same question, asked of the artifact
//                       instead of of a model of it.
//
// Both modes fail on an empty collection: zero packages, or a package with zero
// declared entry points, means the check is not looking at anything.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const GLOB_CHARS = /[*?[\]{}]/

/** Collect every relative path a manifest names as an entry point. */
function declaredPaths(manifest) {
  const out = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      if (node.startsWith('./')) out.add(node.slice(2))
      return
    }
    if (Array.isArray(node)) return node.forEach(walk)
    if (node && typeof node === 'object') return Object.values(node).forEach(walk)
  }
  walk(manifest.exports)
  for (const field of ['main', 'module', 'types', 'typings', 'browser', 'bin']) {
    walk(manifest[field])
  }
  return [...out]
}

/**
 * Minimal npm-`files` glob to RegExp. Deliberately narrow: it understands `*`,
 * `**` and `?`, and THROWS on anything else rather than guessing. Quietly
 * treating a pattern it cannot parse as "no match" would report clean on
 * exactly the case it is unable to judge.
 */
function patternToRegExp(pattern) {
  if (/[[\]{}]/.test(pattern)) {
    throw new Error(
      `pattern ${JSON.stringify(pattern)} uses character classes or braces, ` +
        'which this guard does not implement — extend patternToRegExp() rather ' +
        'than assuming the pattern matches nothing'
    )
  }
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans zero or more directories; a trailing `**` spans the rest.
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^$()|\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** Would `files` ship `target`? Mirrors npm's include/negate ordering. */
function isShipped(files, target) {
  if (!files) return true // no allowlist: the whole directory ships
  let shipped = false
  for (const raw of files) {
    const negated = raw.startsWith('!')
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\.\//, '').replace(/\/$/, '')
    let hit
    if (GLOB_CHARS.test(pattern)) {
      hit = patternToRegExp(pattern).test(target)
    } else {
      // A bare entry names a file or a whole directory.
      hit = target === pattern || target.startsWith(`${pattern}/`)
    }
    if (hit) shipped = !negated
  }
  return shipped
}

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function checkStatic(repoRoot) {
  const packagesDir = join(repoRoot, 'packages')
  if (!existsSync(packagesDir)) {
    return [`${packagesDir} does not exist — run this from the repository root`]
  }
  const dirs = readdirSync(packagesDir)
    .map((name) => join(packagesDir, name))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'package.json')))
  if (dirs.length === 0) {
    return [`no packages found under ${packagesDir} — this check is looking at nothing`]
  }
  const problems = []
  let checked = 0
  for (const dir of dirs) {
    const manifest = readManifest(dir)
    const paths = declaredPaths(manifest)
    if (paths.length === 0) {
      problems.push(`${manifest.name}: manifest declares no entry point at all`)
      continue
    }
    for (const p of paths) {
      checked++
      // dist/ is a build product, absent until `pnpm build`. release-npm.yml
      // asserts it was emitted ("Assert the build emitted JS and
      // declarations"); this mode judges the ALLOWLIST, not the build.
      if (!p.startsWith('dist/') && !existsSync(join(dir, p))) {
        problems.push(`${manifest.name}: exports name ./${p}, which is not in the tree`)
        continue
      }
      if (!isShipped(manifest.files, p)) {
        problems.push(
          `${manifest.name}: exports name ./${p}, but "files" ` +
            `${JSON.stringify(manifest.files)} does not ship it — ` +
            'the packed package (npm publish AND pnpm deploy) would omit it'
        )
      }
    }
    console.log(`  ${manifest.name}: ${paths.length} declared path(s) — ${paths.join(', ')}`)
  }
  if (checked === 0) problems.push('collected zero declared paths across all packages')
  return problems
}

function checkDeploy(deployDir) {
  const scope = join(deployDir, 'node_modules', '@gremion')
  if (!existsSync(scope)) {
    return [`${scope} does not exist — the deploy produced no @gremion packages`]
  }
  const names = readdirSync(scope)
  if (names.length === 0) return [`${scope} is empty — nothing to check`]
  const problems = []
  let checked = 0
  for (const name of names) {
    const dir = join(scope, name) // a symlink into .pnpm/; fs follows it
    const manifest = readManifest(dir)
    const paths = declaredPaths(manifest)
    if (paths.length === 0) {
      problems.push(`@gremion/${name}: deployed manifest declares no entry point`)
      continue
    }
    let missing = 0
    for (const p of paths) {
      checked++
      if (!existsSync(join(dir, p))) {
        missing++
        problems.push(
          `@gremion/${name}: the deployed manifest exports ./${p}, but that file is ` +
            'NOT in the payload — resolving it at runtime is ERR_MODULE_NOT_FOUND'
        )
      }
    }
    console.log(
      missing === 0
        ? `  @gremion/${name}: all ${paths.length} declared path(s) present`
        : `  @gremion/${name}: ${missing} of ${paths.length} declared path(s) MISSING`
    )
  }
  if (checked === 0) problems.push('collected zero declared paths across the deployed packages')
  return problems
}

const args = process.argv.slice(2)
const mode = args[0] ?? '--static'
let problems
if (mode === '--static') {
  console.log('Checking workspace package `files` allowlists against their own exports:')
  problems = checkStatic(resolve(args[1] ?? '.'))
} else if (mode === '--deploy') {
  if (!args[1]) {
    console.error('usage: check-shipped-package-files.mjs --deploy <deploy-dir>')
    process.exit(2)
  }
  console.log(`Checking the deploy payload at ${args[1]}:`)
  problems = checkDeploy(resolve(args[1]))
} else {
  console.error(`unknown mode ${mode} (expected --static or --deploy <dir>)`)
  process.exit(2)
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log('OK — every declared entry point survives packing.')
