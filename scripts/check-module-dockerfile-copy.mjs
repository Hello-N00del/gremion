#!/usr/bin/env node
// Guard: every COPY/ADD source in a Dockerfile under modules/ must exist in this
// repository. The nine module leaf Dockerfiles were copied byte-equal from the
// StuRa tree and kept COPYing `services/<svc>` and `upstream/gremion/packages/ports`,
// neither of which exists in the kernel, so no leaf image could be built from a
// kernel-only checkout and nothing noticed (no compose file or workflow builds them).
//
// A source passes when it resolves, relative to the repository root (the leaf
// Dockerfiles' build context) or relative to the Dockerfile's own directory (a
// sidecar such as modules/messaging/synapse builds from its own directory), to a
// path that exists. Glob sources pass when their literal directory prefix exists.
// `COPY --from=<stage>`, URLs and heredocs are not paths on disk and are skipped
// (extractDockerCopySources). The guard refuses to pass over zero Dockerfiles.
//
// Run:  node scripts/check-module-dockerfile-copy.mjs
// Test: node --test scripts/check-module-dockerfile-copy.test.mjs

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractDockerCopySources } from './check-module-source-scan.mjs'

export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const DOCKERFILE_RE = /(^|\/)(([^/]*\.)?Dockerfile(\.[^/]+)?|Containerfile(\.[^/]+)?)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'coverage', '.git'])

/** Every Dockerfile / Containerfile under <root>/modules, as repo-relative posix paths. */
export function findModuleDockerfiles(root) {
  const out = []
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = posix.join(rel, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p)
      } else if (DOCKERFILE_RE.test(p)) out.push(p)
    }
  }
  if (existsSync(join(root, 'modules'))) walk('modules')
  return out.sort()
}

function sourceExists(root, dockerfile, source) {
  // A glob is reduced to its literal directory prefix; a literal source needs the exact path.
  const segs = source.split('/')
  const firstGlob = segs.findIndex((s) => /[*?[]/.test(s))
  const rel = (firstGlob === -1 ? segs : segs.slice(0, firstGlob)).join('/') || '.'
  return [root, join(root, posix.dirname(dockerfile))].some((base) => existsSync(join(base, rel)))
}

/** @returns {{problems: string[], dockerfiles: number, sources: number}} */
export function checkModuleDockerfiles(root = KERNEL_ROOT) {
  const problems = []
  const files = findModuleDockerfiles(root)
  let sources = 0
  if (files.length === 0) problems.push('no Dockerfile found under modules/ — the guard has gone blind')
  for (const f of files) {
    for (const c of extractDockerCopySources(readFileSync(join(root, f), 'utf8'))) {
      sources++
      if (!sourceExists(root, f, c.source))
        problems.push(`${f}:${c.line} COPY source '${c.source}' does not exist in the repository (neither at the repo root nor beside the Dockerfile)`)
    }
  }
  return { problems, dockerfiles: files.length, sources }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = checkModuleDockerfiles()
  if (r.problems.length) {
    console.error(`[module-dockerfile-copy] ${r.problems.length} problem(s):`)
    for (const p of r.problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[module-dockerfile-copy] ${r.dockerfiles} Dockerfile(s), ${r.sources} COPY/ADD source(s): all exist`)
}
