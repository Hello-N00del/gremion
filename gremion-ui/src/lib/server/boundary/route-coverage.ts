// gremion-ui/src/lib/server/boundary/route-coverage.ts
// P0.4: kernel route inventory <-> OpenAPI spec equivalence. Pure node module.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Kernel surface enumeration — design §1.3 kernel = governance + finance.
 *  Keep in sync with contracts/README.md §Scope. */
export const KERNEL_PREFIXES = ['api/governance', 'api/groups', 'api/users', 'api/health', 'api/finance']
export const KERNEL_EXTRA_ROUTES = ['api/committees/[id]/child-term']

const METHOD_RE = /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g

export function toSpecPath(routeDir: string): string {
  return '/' + routeDir
    .split('/')
    .map((seg) => seg.replace(/^\[\.\.\.(.+)\]$/, '{$1}').replace(/^\[(.+)\]$/, '{$1}'))
    .join('/')
}

export function parseExportedMethods(source: string): string[] {
  const out: string[] = []
  METHOD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = METHOD_RE.exec(source)) !== null) out.push(m[1])
  return out
}

export function isKernelRoute(routeDir: string): boolean {
  if (KERNEL_EXTRA_ROUTES.includes(routeDir)) return true
  return KERNEL_PREFIXES.some((p) => routeDir === p || routeDir.startsWith(p + '/'))
}

export interface RouteInventoryEntry { specPath: string; methods: string[] }

/** Walk src/routes for kernel +server.ts files. routesDir = absolute path. */
export function listKernelRoutes(routesDir: string): RouteInventoryEntry[] {
  const entries: RouteInventoryEntry[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name === '+server.ts') {
        const routeDir = relative(routesDir, dir).split('\\').join('/')
        if (!isKernelRoute(routeDir)) continue
        const methods = parseExportedMethods(readFileSync(p, 'utf8'))
        if (methods.length > 0) entries.push({ specPath: toSpecPath(routeDir), methods })
      }
    }
  }
  walk(routesDir)
  return entries.sort((a, b) => a.specPath.localeCompare(b.specPath))
}

/** specOps: Set of '<method-lowercase> <specPath>' built from the spec docs. */
export function compareCoverage(
  routes: RouteInventoryEntry[],
  specOps: Set<string>,
): { missingInSpec: string[]; extraInSpec: string[] } {
  const routeOps = new Set<string>()
  for (const r of routes) for (const m of r.methods) routeOps.add(`${m.toLowerCase()} ${r.specPath}`)
  return {
    missingInSpec: [...routeOps].filter((o) => !specOps.has(o)).sort(),
    extraInSpec: [...specOps].filter((o) => !routeOps.has(o)).sort(),
  }
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

/** Build the specOps set from parsed OpenAPI docs (paths only — $refs not needed). */
export function specOpsFromDocs(docs: Array<{ paths: Record<string, Record<string, unknown>> }>): Set<string> {
  const ops = new Set<string>()
  for (const doc of docs) {
    for (const [p, item] of Object.entries(doc.paths)) {
      for (const k of Object.keys(item)) if (HTTP_METHODS.includes(k)) ops.add(`${k} ${p}`)
    }
  }
  return ops
}
