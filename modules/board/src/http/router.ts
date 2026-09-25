// services/board/src/http/router.ts
// Tiny regex route table — NO web framework. A path pattern like
// `/api/v1/boards/:id` compiles to a single-segment-capturing regex. match()
// distinguishes matched / method-not-allowed / not-found so the server answers
// 200/404/405 consistently.

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

/** Compile `/api/v1/boards/:id/deck` → /^\/api\/v1\/boards\/([^/]+)\/deck$/
 *  with paramNames = ['id']. `:param` captures exactly ONE path segment. */
function compile(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1))
        return '([^/]+)'
      }
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
