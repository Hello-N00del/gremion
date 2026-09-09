// P0.4 boundary-lint (design §7): "no cross-service imports". Pure node module.
import path from 'node:path'

export interface ImportRule {
  id: string
  description: string
  /** POSIX path prefixes (relative to gremion-ui/) the rule applies to. */
  sourceDirs: string[]
  /** Prefixes/exact paths whose files are exempt (service-own dirs, composition roots). */
  sourceExempt: string[]
  /** Normalized target prefixes that must not be imported. */
  forbiddenTargets: string[]
  /** Exact source files sanctioned as pre-existing debt. NO new entries without design sign-off. */
  allow: string[]
}

export interface ImportViolation {
  file: string
  line: number
  specifier: string
  target: string
  rule: string
}

/** segment-safe prefix test: 'a/b' matches 'a/b' and 'a/b/c', never 'a/bc' */
export function underPrefix(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
}

export function normalizeSpecifier(spec: string, importerRelPath: string): string | null {
  if (spec.startsWith('$lib/')) return 'src/lib/' + spec.slice('$lib/'.length)
  if (spec === '$lib') return 'src/lib'
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const dir = path.posix.dirname(importerRelPath.split(path.sep).join('/'))
    return path.posix.normalize(path.posix.join(dir, spec))
  }
  return null // bare package / node builtin / $app etc. — out of scope
}

// from '…'  |  import('…')  |  import '…'
const SPEC_RES = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
]

export function scanImports(
  file: string,
  content: string,
  rules: ImportRule[],
): ImportViolation[] {
  const relevant = rules.filter(
    (r) =>
      r.sourceDirs.some((d) => underPrefix(file, d)) &&
      !r.sourceExempt.some((d) => underPrefix(file, d)) &&
      !r.allow.includes(file),
  )
  if (relevant.length === 0) return []
  const out: ImportViolation[] = []
  const seen = new Set<string>() // dedupe same specifier matched by two regexes
  for (const re of SPEC_RES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const key = `${m.index}:${m[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      const target = normalizeSpecifier(m[1], file)
      if (!target) continue
      for (const r of relevant) {
        if (r.forbiddenTargets.some((t) => underPrefix(target, t))) {
          out.push({
            file,
            line: content.slice(0, m.index).split('\n').length,
            specifier: m[1],
            target,
            rule: r.id,
          })
        }
      }
    }
  }
  return out
}
