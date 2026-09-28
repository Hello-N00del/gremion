// services/calendar/src/http/router.ts
// Tiny regex route table — NO web framework (D-P1-1). A path pattern like
// `/api/v1/events/:id` compiles to a single-segment-capturing regex.
// match() distinguishes three outcomes so the server can answer 200/404/405
// consistently:
//   - matched            → a handler + extracted params
//   - method-not-allowed → the path matched a registered pattern but no method
//                          did; `allowed` is the Allow-header set (→ HTTP 405)
//   - not-found          → no registered pattern matched the path (→ HTTP 404)

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RouteHandler = (ctx: RouteContext) => Promise<void>

/** Per-request context handed to a matched handler (filled in by the server). */
export interface RouteContext {
  params: Record<string, string>
}

export interface Route {
  method: HttpMethod
  path: string
  handler: RouteHandler
}

export type MatchResult =
  | { type: 'matched'; handler: RouteHandler; params: Record<string, string> }
  | { type: 'method-not-allowed'; allowed: Set<HttpMethod> }
  | { type: 'not-found' }

export interface Router {
  match(method: string, path: string): MatchResult
}

interface CompiledRoute {
  method: HttpMethod
  regex: RegExp
  paramNames: string[]
  handler: RouteHandler
}

/** Compile `/api/v1/events/:id/send` → /^\/api\/v1\/events\/([^/]+)\/send$/
 *  with paramNames = ['id']. `:param` captures exactly ONE path segment (no '/'). */
function compile(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1))
        return '([^/]+)'
      }
      // Escape regex metacharacters in literal segments.
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { regex: new RegExp(`^${source}$`), paramNames }
}

export function createRouter(routes: Route[]): Router {
  const compiled: CompiledRoute[] = routes.map((r) => {
    const { regex, paramNames } = compile(r.path)
    return { method: r.method, regex, paramNames, handler: r.handler }
  })

  return {
    match(method: string, path: string): MatchResult {
      const allowed = new Set<HttpMethod>()
      for (const route of compiled) {
        const m = route.regex.exec(path)
        if (!m) continue
        // The path matches this pattern; record its method for a possible 405.
        allowed.add(route.method)
        if (route.method === method) {
          const params: Record<string, string> = {}
          route.paramNames.forEach((name, i) => {
            params[name] = decodeURIComponent(m[i + 1]!)
          })
          return { type: 'matched', handler: route.handler, params }
        }
      }
      if (allowed.size > 0) return { type: 'method-not-allowed', allowed }
      return { type: 'not-found' }
    },
  }
}
