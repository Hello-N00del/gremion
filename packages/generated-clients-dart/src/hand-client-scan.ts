// packages/generated-clients-dart/src/hand-client-scan.ts
//
// TRD-405 "no hand-written client of a specified surface shall be merged",
// the part the drift check cannot see: Dart code OUTSIDE the generated
// surface packages (apps/mobile/** once it exists, a stray tool/, a Dart file
// hidden elsewhere under packages/). Any such *.dart file that contains a
// path from a registered OpenAPI spec's `paths` keys is named. Path
// parameters match whatever a hand-written client interpolates there
// ('{id}', '$id', '${x.id}', a literal '42').
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDartSurfaces } from './registry.ts'

const WALK_SKIP = new Set(['.git', 'node_modules', '.dart_tool', '.gen-work'])

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A spec path key as a pattern: each `{param}` becomes one path segment of
 *  anything, and the match must end where the path ends — '/api/widgets'
 *  does not match inside '/api/widgetsX' or '/api/widgets/1/parts'. */
export function pathKeyPattern(key: string): RegExp {
  const body = key.split(/\{[^}]*\}/).map(escapeRe).join(`[^/'"\\s?#]+`)
  return new RegExp(`${body}(?![\\w-]|/[\\w\${])`)
}

/** Every *.dart file in the tree, repo-relative. In a git work tree this is
 *  tracked + untracked-but-not-ignored (what a commit could carry); in a
 *  plain directory (unit fixtures) a filesystem walk. A git failure throws —
 *  an empty list would read as "nothing hand-written". */
export function listDartFiles(repoRoot: string): string[] {
  if (existsSync(join(repoRoot, '.git'))) {
    const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.dart'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (r.error || r.status !== 0) throw new Error(`git ls-files failed (${r.error?.message ?? `exit ${r.status}`}): ${r.stderr}`)
    return [...new Set(r.stdout.split('\0').filter((f) => f.length > 0))].filter((f) => existsSync(join(repoRoot, f))).sort()
  }
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      if (WALK_SKIP.has(name)) continue
      const childAbs = join(abs, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (lstatSync(childAbs).isDirectory()) walk(childAbs, childRel)
      else if (name.endsWith('.dart')) out.push(childRel)
    }
  }
  walk(repoRoot, '')
  return out.sort()
}

export function scanForHandWrittenClients(repoRoot: string, dartFiles: string[] = listDartFiles(repoRoot)): string[] {
  const { surfaces, allOpenApi } = loadDartSurfaces(repoRoot)
  const exempt = surfaces.map((s) => `${s.packageDir}/`)
  const keys: { key: string; spec: string; re: RegExp }[] = []
  for (const s of allOpenApi) {
    const doc = JSON.parse(readFileSync(join(repoRoot, s.specFile), 'utf8')) as { paths?: Record<string, unknown> }
    for (const key of Object.keys(doc.paths ?? {})) {
      // A bare '/' would match every Dart file with a slash; the spec's
      // other paths still police that surface.
      if (key === '/') continue
      keys.push({ key, spec: s.specFile, re: pathKeyPattern(key) })
    }
  }
  const problems: string[] = []
  for (const rel of dartFiles) {
    if (exempt.some((p) => rel.startsWith(p))) continue
    const text = readFileSync(join(repoRoot, rel), 'utf8')
    const hits = keys.filter((k) => k.re.test(text))
    if (hits.length > 0) {
      problems.push(
        `${rel}: hand-written client of a specified surface — contains ${hits.map((h) => `"${h.key}" (${h.spec})`).join(', ')}. `
        + 'Use the generated package under packages/generated-clients-dart/ instead (TRD-405).',
      )
    }
  }
  return problems
}
