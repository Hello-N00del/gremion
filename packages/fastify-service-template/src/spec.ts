// Reading an OpenAPI 3.1 document as a route source. The spec is the source
// of truth [D R19-D3]: nothing here emits or rewrites a spec, it only reads
// one, inlines its local $refs, and lists its operations.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SpecLoadError } from './errors.ts'

/** OpenAPI 3.1 operation keys of a Path Item Object. */
export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export type JsonObject = Record<string, unknown>

export interface OpenApiDocument {
  openapi: string
  paths?: Record<string, JsonObject>
  components?: JsonObject
  [key: string]: unknown
}

export type SpecSource = OpenApiDocument | string | URL

export interface SpecOperation {
  /** Upper-case HTTP method, e.g. `GET`. */
  method: string
  /** The path template exactly as the spec writes it, e.g. `/widgets/{widgetId}`. */
  path: string
  operationId: string | undefined
  /** The Operation Object with every local $ref inlined. */
  operation: JsonObject
  /** Path-level parameters merged under operation-level ones (by `in`+`name`). */
  parameters: JsonObject[]
}

/** `METHOD /path` — the key routes:check and the route table compare on. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

/** Read (if given a path) and structurally check an OpenAPI 3.1 document. */
export function loadSpec(source: SpecSource): OpenApiDocument {
  let doc: unknown = source
  if (typeof source === 'string' || source instanceof URL) {
    const file = source instanceof URL ? fileURLToPath(source) : source
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      throw new SpecLoadError([`cannot read spec file ${file}: ${(e as Error).message}`])
    }
    try {
      doc = JSON.parse(text)
    } catch (e) {
      throw new SpecLoadError([`spec file ${file} is not valid JSON: ${(e as Error).message}`])
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new SpecLoadError(['spec is not a JSON object'])
  }
  const version = (doc as JsonObject).openapi
  if (typeof version !== 'string' || !/^3\.1\.\d+$/.test(version)) {
    throw new SpecLoadError([`spec must be OpenAPI 3.1.x (JSON Schema 2020-12); "openapi" is ${JSON.stringify(version)}`])
  }
  const paths = (doc as JsonObject).paths
  if (paths !== undefined && (typeof paths !== 'object' || paths === null || Array.isArray(paths))) {
    throw new SpecLoadError(['spec "paths" is not an object'])
  }
  const basePaths = serversWithBasePath(doc as OpenApiDocument)
  if (basePaths.length) throw new SpecLoadError(basePaths)
  return doc as OpenApiDocument
}

/** The path part of a Server Object url: `https://{host}/api/` -> `/api/`, `/v1` -> `/v1`. */
function serverUrlPath(url: string): string {
  const withoutOrigin = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '')
  return withoutOrigin.split(/[?#]/)[0]
}

/**
 * Routes are served at the paths exactly as the spec writes them. A `servers`
 * entry (root, path item or operation) whose url carries a base path would
 * make the spec's real URLs `<base><path>`, which the template does not
 * apply: refused, named, rather than silently served at the wrong prefix.
 */
function serversWithBasePath(doc: OpenApiDocument): string[] {
  const problems: string[] = []
  const inspect = (servers: unknown, where: string) => {
    if (!Array.isArray(servers)) return
    servers.forEach((server, i) => {
      const url = (server as JsonObject | null)?.url
      if (typeof url !== 'string') return
      const path = serverUrlPath(url)
      if (path !== '' && path !== '/') {
        problems.push(
          `${where}servers[${i}].url ${JSON.stringify(url)} has a base path ${JSON.stringify(path)}; the template serves ` +
            'paths exactly as written, so write the full path in "paths" and keep servers to origins',
        )
      }
    })
  }
  inspect(doc.servers, '')
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item || typeof item !== 'object') continue
    inspect(item.servers, `paths[${JSON.stringify(path)}].`)
    for (const method of HTTP_METHODS) {
      const op = item[method] as JsonObject | undefined
      if (op && typeof op === 'object') inspect(op.servers, `paths[${JSON.stringify(path)}].${method}.`)
    }
  }
  return problems
}

/**
 * Deep-copy `doc` with every local `$ref` ("#/...") replaced by what it points
 * at. Remote refs, dangling refs and ref cycles are refused, named: a route
 * schema that silently lost part of its $ref graph would validate less than
 * the spec says.
 */
export function inlineRefs(doc: OpenApiDocument): OpenApiDocument {
  const problems: string[] = []
  const resolving: string[] = []

  const lookup = (ref: string): unknown => {
    let node: unknown = doc
    for (const raw of ref.slice(2).split('/')) {
      const token = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
      if (node === null || typeof node !== 'object' || !(token in (node as JsonObject))) return undefined
      node = (node as JsonObject)[token]
    }
    return node
  }

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return node
    const obj = node as JsonObject
    if (typeof obj.$ref === 'string') {
      const ref = obj.$ref
      if (!ref.startsWith('#/')) {
        problems.push(`$ref ${JSON.stringify(ref)} is not a local reference ("#/..."); only local refs are supported`)
        return {}
      }
      if (resolving.includes(ref)) {
        problems.push(`$ref cycle through ${JSON.stringify(ref)} (${[...resolving, ref].join(' -> ')}); recursive schemas are not supported`)
        return {}
      }
      const target = lookup(ref)
      if (target === undefined) {
        problems.push(`$ref ${JSON.stringify(ref)} points at nothing`)
        return {}
      }
      resolving.push(ref)
      const resolved = walk(target)
      resolving.pop()
      const { $ref: _ref, ...siblings } = obj
      const keys = Object.keys(siblings)
      if (keys.length === 0) return resolved
      const walkedSiblings = walk(siblings) as JsonObject
      // Annotation-only siblings (3.1 allows them next to $ref) override in place;
      // anything that constrains is kept with 2020-12 $ref semantics (both apply).
      if (keys.every((k) => k === 'description' || k === 'summary' || k === 'title')) {
        return { ...(resolved as JsonObject), ...walkedSiblings }
      }
      return { ...walkedSiblings, allOf: [resolved] }
    }
    const out: JsonObject = {}
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v)
    return out
  }

  // Only what the routes reach is inlined: an unused component is not a
  // route source, so a cycle in one does not stop the service.
  const paths = walk(doc.paths ?? {}) as Record<string, JsonObject>
  if (problems.length) throw new SpecLoadError([...new Set(problems)])
  return { ...doc, paths }
}

/** Every operation of `doc` (which should already be $ref-inlined), in spec order. */
export function listOperations(doc: OpenApiDocument): SpecOperation[] {
  const ops: SpecOperation[] = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const pathParams = Array.isArray(item.parameters) ? (item.parameters as JsonObject[]) : []
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!operation || typeof operation !== 'object') continue
      const op = operation as JsonObject
      const own = Array.isArray(op.parameters) ? (op.parameters as JsonObject[]) : []
      const overridden = new Set(own.map((p) => `${String(p.in)}:${String(p.name)}`))
      const parameters = [...pathParams.filter((p) => !overridden.has(`${String(p.in)}:${String(p.name)}`)), ...own]
      ops.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof op.operationId === 'string' && op.operationId !== '' ? op.operationId : undefined,
        operation: op,
        parameters,
      })
    }
  }
  return ops
}

/** The spec's `(METHOD, path)` set as route keys. Works on a raw (un-inlined) document. */
export function specRouteKeys(doc: OpenApiDocument): string[] {
  return listOperations(doc).map((op) => routeKey(op.method, op.path))
}
