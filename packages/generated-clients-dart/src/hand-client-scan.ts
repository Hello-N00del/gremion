// packages/generated-clients-dart/src/hand-client-scan.ts
//
// TRD-405 "no hand-written client of a specified surface shall be merged",
// the part the drift check cannot see: Dart code OUTSIDE the generated
// surface packages (apps/mobile/** once it exists, a stray tool/, a Dart file
// hidden elsewhere under packages/). Any such *.dart file that contains a
// path from a registered OpenAPI spec's `paths` keys is named. Path
// parameters match whatever a hand-written client interpolates there
// ('{id}', '$id', '${x.id}', a literal '42').
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDartSurfaces } from './registry.ts'
import { gitListFiles, isGitWorkTree } from './tree-files.ts'

const WALK_SKIP = new Set(['.git', 'node_modules', '.dart_tool', '.gen-work'])

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const PARAM = String.raw`(?:\$\{[^}]*\}|[^/'"\s?#]+)`

function keyBody(segments: string[]): string {
  return segments.map((seg) => seg.split(/\{[^}]*\}/).map(escapeRe).join(PARAM)).join('/')
}

function isParam(seg: string): boolean {
  return /^\{[^}]*\}$/.test(seg)
}

/** A spec path key as a pattern: each `{param}` becomes one path segment of
 *  anything (`{id}`, `$id`, `${x['id']}`, `42`). The leading slash may be
 *  missing directly after a quote ('api/x'). The match must end where the
 *  path ends, so '/api/widgets' does not match inside '/api/widgetsX' or
 *  '/api/widgets/1/parts'. */
export function pathKeyPattern(key: string): RegExp {
  const segs = key.split('/').slice(1)
  return new RegExp(`(?:/|(?<=['"]))${keyBody(segs)}(?![\\w-]|/[\\w\${])`)
}

/** Suffixes of a key that a client with the prefix in its base URL would
 *  write (baseUrl '…/api' + '/governance/committees/$id'): every tail of at
 *  least two segments that starts with a literal segment. */
export function suffixPatterns(key: string): RegExp[] {
  const segs = key.split('/').slice(1)
  const out: RegExp[] = []
  for (let i = 1; i <= segs.length - 2; i++) {
    const tail = segs.slice(i)
    if (isParam(tail[0])) continue
    out.push(new RegExp(`(?:/|(?<=['"]))${keyBody(tail)}(?![\\w-]|/[\\w\${])`))
  }
  return out
}

const EXPR = String.raw`[A-Za-z_$][\w$.]*(?:\([^()'"\n]*\))?(?:\[[^\]'"\n]*\])?`
const LIST_ITEM = String.raw`(?:'[^'\n]*'|"[^"\n]*"|[A-Za-z_$][\w$.]*)`
const LIST = new RegExp(String.raw`\[\s*((?:${LIST_ITEM}\s*,\s*)+${LIST_ITEM})\s*,?\s*\]`, 'g')

/** The same source with the common ways of assembling a path undone, so the
 *  path patterns can see it: string consts inlined into `$name`/`${name}`,
 *  `'a' + expr + 'b'` / `'a' + expr` / `'a' + 'b'` / `'a' 'b'` joined (an
 *  expression becomes one segment), and segment lists (`pathSegments: [...]`,
 *  `[...].join('/')`) rendered as a path. Heuristic by design: it widens
 *  what the scan catches and can only add matches, never remove one (the
 *  original text is scanned too). */
export function normalizeDartSource(text: string): string {
  let t = text
  const consts = new Map<string, string>()
  for (const m of t.matchAll(/\b(?:const|final|var|String)\s+(?:String\s+)?([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\n]*)\2/g)) consts.set(m[1], m[3])
  for (const [name, value] of consts) {
    t = t.replace(new RegExp(String.raw`\$\{${escapeRe(name)}\}|\$${escapeRe(name)}(?![\w$])`, 'g'), () => value)
  }
  const lists: string[] = []
  for (const m of t.matchAll(LIST)) {
    const items = [...m[1].matchAll(new RegExp(LIST_ITEM, 'g'))].map((i) => (/^['"]/.test(i[0]) ? i[0].slice(1, -1) : 'P')).filter((x) => x.length > 0)
    lists.push(`'/${items.join('/')}'`)
  }
  t = t.replace(new RegExp(String.raw`(['"])\s*\+\s*${EXPR}\s*\+\s*(['"])`, 'g'), 'P')
  t = t.replace(new RegExp(String.raw`(['"])\s*\+\s*${EXPR}`, 'g'), 'P$1')
  t = t.replace(/(['"])\s*\+?\s*(['"])/g, '')
  return `${t}\n${lists.join('\n')}\n`
}

/** Every *.dart file in the tree, repo-relative. In a git work tree this is
 *  tracked + untracked-but-not-ignored (what a commit could carry); in a
 *  plain directory (unit fixtures) a filesystem walk. A git failure throws —
 *  an empty list would read as "nothing hand-written". */
export function listDartFiles(repoRoot: string): string[] {
  if (isGitWorkTree(repoRoot)) return gitListFiles(repoRoot, ['*.dart'])
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

export interface ScanResult {
  problems: string[]
  /** Dart files looked at (outside the surface packages) */
  filesScanned: number
  /** spec path keys searched for */
  keys: number
}

/** `requireEvidence` (the real-tree mode) fails a scan that could not have
 *  seen anything: zero path keys while OpenAPI specs are registered, or a
 *  file listing that does not even contain the generated packages' own
 *  entry libraries (a listing of the wrong tree, e.g. under a stray GIT_DIR). */
export function scanForHandWrittenClients(repoRoot: string, opts: { dartFiles?: string[]; requireEvidence?: boolean } = {}): ScanResult {
  const dartFiles = opts.dartFiles ?? listDartFiles(repoRoot)
  const { surfaces, allOpenApi } = loadDartSurfaces(repoRoot)
  const exempt = surfaces.map((s) => `${s.packageDir}/`)
  const keys: { key: string; spec: string; res: RegExp[] }[] = []
  for (const s of allOpenApi) {
    const doc = JSON.parse(readFileSync(join(repoRoot, s.specFile), 'utf8')) as { paths?: Record<string, unknown> }
    for (const key of Object.keys(doc.paths ?? {})) {
      // A bare '/' would match every Dart file with a slash; the spec's
      // other paths still police that surface.
      if (key === '/') continue
      keys.push({ key, spec: s.specFile, res: [pathKeyPattern(key), ...suffixPatterns(key)] })
    }
  }
  const problems: string[] = []
  if (opts.requireEvidence) {
    if (allOpenApi.length > 0 && keys.length === 0) problems.push(`hand-client scan: ${allOpenApi.length} OpenAPI spec(s) registered but 0 path keys to search for — the scan would look for nothing`)
    const listed = new Set(dartFiles)
    for (const s of surfaces) {
      const entry = `${s.packageDir}/lib/${s.pubName}.dart`
      if (!listed.has(entry)) problems.push(`hand-client scan: the Dart file listing does not contain ${entry} — it is not listing this tree`)
    }
  }
  let filesScanned = 0
  for (const rel of dartFiles) {
    if (exempt.some((p) => rel.startsWith(p))) continue
    filesScanned++
    const raw = readFileSync(join(repoRoot, rel), 'utf8')
    const texts = [raw, normalizeDartSource(raw)]
    const hits = keys.filter((k) => k.res.some((re) => texts.some((t) => re.test(t))))
    if (hits.length > 0) {
      problems.push(
        `${rel}: hand-written client of a specified surface — contains ${hits.map((h) => `"${h.key}" (${h.spec})`).join(', ')}. `
        + 'Use the generated package under packages/generated-clients-dart/ instead (TRD-405).',
      )
    }
  }
  return { problems, filesScanned, keys: keys.length }
}
